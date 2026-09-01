import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, LogLevel } from 'react-native-ble-plx';
import Config from 'react-native-config';

import {
  parseMiBeaconHeader,
  parseObjects,
  objectsToReading,
  MiBeaconParseError,
} from './mibeacon';
import { decryptMiBeaconPayload, MiBeaconDecryptError } from './decrypt';
import { SensorReading } from '../types/mibeacon';

// 16-bit MiBeacon service UUID (0xFE95), expanded to the full 128-bit
// form using the Bluetooth SIG base UUID. react-native-ble-plx scan
// filters expect fully-qualified UUID strings.
const MIBEACON_SERVICE_UUID = '0000fe95-0000-1000-8000-00805f9b34fb';

export interface SensorUpdate {
  reading: SensorReading;
  mac: string;
  rssi: number | null;
  timestamp: number;
}

export type SensorUpdateListener = (update: SensorUpdate) => void;
export type ScanErrorListener = (error: Error) => void;

export class MijiaScannerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MijiaScannerConfigError';
  }
}

/**
 * Passive BLE scanner for a single Xiaomi Mijia-family sensor. Never
 * calls .connect() — reads and decrypts service-data advertisements
 * only, per project spec (the Mijia 3 drops active GATT sessions
 * quickly, and passive scanning is what needs to survive indefinitely
 * in the foreground service).
 */
export class MijiaScanner {
  private readonly manager: BleManager;
  private readonly targetMac: string;
  private readonly bindkeyHex: string;
  private readonly updateListeners = new Set<SensorUpdateListener>();
  private readonly errorListeners = new Set<ScanErrorListener>();
  private scanning = false;

  constructor() {
    const mac = Config.MIJIA_MAC;
    const bindkey = Config.MIJIA_BINDKEY;

    if (!mac || !bindkey) {
      throw new MijiaScannerConfigError(
        'MIJIA_MAC and MIJIA_BINDKEY must be set in .env (see react-native-config setup). ' +
          'Never hardcode these values in source.',
      );
    }

    this.targetMac = mac.toUpperCase();
    this.bindkeyHex = bindkey;
    this.manager = new BleManager();
    this.manager.setLogLevel(LogLevel.Warning);
  }

  /**
   * Requests the runtime permissions needed for BLE scanning. Permission
   * requirements differ across Android versions — call this before
   * start() and handle a false return by surfacing a clear message to
   * the user rather than silently failing to find devices.
   *
   * NOTE: whether BLUETOOTH_SCAN can be requested with the
   * neverForLocation flag (skipping the location permission entirely on
   * API 31+) depends on your manifest declaration — that's still an
   * open decision in this project. This function currently requests
   * location as well to be safe on all API levels; revisit once that's
   * decided and reflected in AndroidManifest.xml.
   */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      return false;
    }

    if (Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      return (
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
          PermissionsAndroid.RESULTS.GRANTED &&
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
          PermissionsAndroid.RESULTS.GRANTED
      );
    }

    // API < 31: BLE scanning requires (fine) location permission.
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }

  /** Subscribe to successfully decoded sensor readings. Returns an unsubscribe function. */
  onUpdate(listener: SensorUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /** Subscribe to scan/parse/decrypt errors. Returns an unsubscribe function. */
  onError(listener: ScanErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  start(): void {
    if (this.scanning) {
      return;
    }
    this.scanning = true;

    // TEMPORARY DIAGNOSTIC: scanning with no service UUID filter (null)
    // instead of [MIBEACON_SERVICE_UUID], to rule out a native scan-filter
    // issue. This will pick up every BLE device in range, not just the
    // Mijia sensor — expect a lot of "Saw device" log noise. Revert to
    // the filtered array once we've confirmed devices show up at all.
    this.manager.startDeviceScan(
      null,
      { allowDuplicates: true },
      (error, device) => {
        if (error) {
          this.emitError(new Error(`BLE scan error: ${error.message}`));
          return;
        }
        if (device) {
          this.handleDevice(device);
        }
      },
    );
  }

  stop(): void {
    if (!this.scanning) {
      return;
    }
    this.manager.stopDeviceScan();
    this.scanning = false;
  }

  /** Call when the app/service is fully shutting down, not on routine stop/start cycles. */
  destroy(): void {
    this.stop();
    this.manager.destroy();
  }

  private handleDevice(device: Device): void {
    const mac = device.id.toUpperCase();
    if (mac !== this.targetMac) {
      return; // Ignore other MiBeacon-broadcasting devices in range — filtered
      // client-side here rather than via startDeviceScan's serviceUUIDs
      // filter, which proved unreliable on this hardware (see project notes).
    }

    console.log(
      'Saw target sensor:',
      device.id,
      device.name,
      Object.keys(device.serviceData ?? {}),
    );

    const serviceDataBase64 = device.serviceData?.[MIBEACON_SERVICE_UUID];
    if (!serviceDataBase64) {
      return; // Advertisement didn't include service data on this cycle.
    }

    try {
      const raw = new Uint8Array(Buffer.from(serviceDataBase64, 'base64'));
      const frame = parseMiBeaconHeader(raw, device.id);

      console.log(
        'Frame:',
        'encrypted=' + frame.isEncrypted,
        'frameControl=0x' + frame.frameControl.toString(16).padStart(4, '0'),
        'rawPayloadLen=' + frame.rawPayload.length,
        'rawPayloadHex=' + Buffer.from(frame.rawPayload).toString('hex'),
      );

      const objectPayload = frame.isEncrypted
        ? decryptMiBeaconPayload(frame, this.bindkeyHex)
        : frame.rawPayload;

      console.log(
        'Decrypted payload hex:',
        Buffer.from(objectPayload).toString('hex'),
        'len=' + objectPayload.length,
      );

      const objects = parseObjects(objectPayload);

      console.log(
        'Decrypted objects:',
        objects.map(o => ({
          id: '0x' + o.id.toString(16).padStart(4, '0'),
          length: o.data.length,
          hex: Buffer.from(o.data).toString('hex'),
        })),
      );

      const reading = objectsToReading(objects);

      if (
        reading.temperatureC === undefined &&
        reading.humidityPercent === undefined &&
        reading.batteryPercent === undefined
      ) {
        return; // This advertisement cycle carried no sensor objects (e.g. a connectable-flag-only frame).
      }

      this.emitUpdate({
        reading,
        mac: frame.mac,
        rssi: device.rssi ?? null,
        timestamp: Date.now(),
      });
    } catch (error) {
      if (
        error instanceof MiBeaconParseError ||
        error instanceof MiBeaconDecryptError
      ) {
        this.emitError(error);
      } else {
        this.emitError(
          new Error(
            `Unexpected error handling advertisement from ${mac}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }
  }

  private emitUpdate(update: SensorUpdate): void {
    for (const listener of this.updateListeners) {
      listener(update);
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  async getBluetoothState(): Promise<string> {
    return this.manager.state();
  }
}

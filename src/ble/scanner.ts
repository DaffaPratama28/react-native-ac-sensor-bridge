import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import Config from 'react-native-config';

import {
  parseMiBeaconHeader,
  parseObjects,
  objectsToReading,
  MiBeaconParseError,
} from './mibeacon';
import { decryptMiBeaconPayload, MiBeaconDecryptError } from './decrypt';
import { SensorReading } from '../types/mibeacon';

export interface SensorUpdate {
  /** Merged with last-known values — use this for live display. */
  reading: SensorReading;
  /** ONLY what this specific advertisement cycle reported (may have some fields undefined) — use this for storage/history so 'EMPTY' means what it says. */
  rawReading: SensorReading;
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

/** Hard cap on a single scan session — auto-stops even if the user never taps Stop. */
export const MAX_SCAN_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

export type AutoStopListener = () => void;

interface BleScannerNativeModule {
  startScan(macAddress: string): Promise<void>;
  stopScan(): Promise<void>;
}

interface NativeScanResultEvent {
  mac: string;
  name: string | null;
  serviceDataBase64: string;
  rssi: number;
  timestamp: number;
}

interface NativeScanRestartEvent {
  restartCount: number;
  reason: string;
  timestamp: number;
}

export interface ScanRestartInfo {
  restartCount: number;
  reason: string;
  timestamp: number;
}

export type ScanRestartListener = (info: ScanRestartInfo) => void;

const EVENT_SCAN_RESULT = 'BleScannerModule:scanResult';
const EVENT_SCAN_ERROR = 'BleScannerModule:scanError';
const EVENT_SCAN_RESTART = 'BleScannerModule:scanRestart';

const LINKING_ERROR =
  `BleScannerModule native module is not linked. Make sure:\n` +
  `  - You have rebuilt the app after adding BleScannerPackage (JS-only reload is not enough)\n` +
  `  - BleScannerPackage is registered in MainApplication\n` +
  `  - You are running on Android (this module has no iOS implementation)\n`;

function getNativeModule(): BleScannerNativeModule {
  const nativeModule = NativeModules.BleScannerModule as
    | BleScannerNativeModule
    | undefined;
  if (!nativeModule) {
    throw new Error(LINKING_ERROR);
  }
  return nativeModule;
}

/**
 * Passive BLE scanner for a single Xiaomi Mijia-family sensor. Never
 * calls .connect() — reads and decrypts service-data advertisements
 * only, per project spec.
 *
 * Scanning itself is delegated to the native BleScannerModule (a
 * hardware-level device-address ScanFilter via Android's
 * BluetoothLeScanner), NOT react-native-ble-plx. This project found
 * that unfiltered scans (and this hardware's service-UUID filter) both
 * stop receiving results ~30s after screen-off — documented Android
 * behavior independent of Doze/battery-optimization. A native MAC
 * ScanFilter is the fix; see BleScannerModule.java for details. This
 * class's public API is unchanged so callers (App.tsx) don't need to
 * change anything.
 */
export class MijiaScanner {
  private readonly targetMac: string;
  private readonly targetMacWireOrder: Uint8Array;
  private readonly bindkeyHex: string;
  private readonly updateListeners = new Set<SensorUpdateListener>();
  private readonly errorListeners = new Set<ScanErrorListener>();
  private readonly eventEmitter: NativeEventEmitter;
  private scanResultSubscription: { remove: () => void } | null = null;
  private scanErrorSubscription: { remove: () => void } | null = null;
  private scanning = false;

  private readonly restartListeners = new Set<ScanRestartListener>();
  private scanRestartSubscription: { remove: () => void } | null = null;

  private readonly autoStopListeners = new Set<AutoStopListener>();
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private _scanStartedAt: number | null = null;

  /** Wall-clock time start() last began scanning, or null if not currently scanning. */
  get scanStartedAt(): number | null {
    return this._scanStartedAt;
  }

  /**
   * This sensor fragments its broadcasts — a given advertisement carries
   * only whichever attribute(s) crossed a threshold, not a full bundle.
   * Merge each new partial reading into the last known state so
   * consumers of onUpdate always see the most complete picture available,
   * rather than a reading that's missing fields simply because THIS
   * particular cycle didn't happen to include them.
   */
  private lastKnownReading: SensorReading = {};

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
    this.targetMacWireOrder = Uint8Array.from(
      this.targetMac
        .split(':')
        .map(h => parseInt(h, 16))
        .reverse(),
    );
    this.bindkeyHex = bindkey;

    // NativeModules.BleScannerModule is required here (not optional) —
    // NativeEventEmitter needs the module reference for iOS-style
    // addListener/removeListeners methods; Android ignores those but the
    // constructor still expects a non-null module.
    this.eventEmitter = new NativeEventEmitter(NativeModules.BleScannerModule);
  }

  /**
   * Requests the runtime permissions needed for BLE scanning. Permission
   * requirements differ across Android versions — call this before
   * start() and handle a false return by surfacing a clear message to
   * the user rather than silently failing to find devices.
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

  /** Fires when the 6-hour cap auto-stops the scan (not on a manual stop()). */
  onAutoStop(listener: AutoStopListener): () => void {
    this.autoStopListeners.add(listener);
    return () => this.autoStopListeners.delete(listener);
  }

  /**
   * Subscribe to native proactive scan-restart events — fires each time
   * the native module tears down and recreates the scan session to dodge
   * the HyperOS screen-off long-scan throttle (see BleScannerModule.java).
   * Purely diagnostic; the automation/BLE pipeline doesn't need to react
   * to this, it's for verifying the countermeasure is actually running.
   * Returns an unsubscribe function.
   */
  onRestart(listener: ScanRestartListener): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;

    this._scanStartedAt = Date.now();
    this.maxDurationTimer = setTimeout(() => {
      this.stop().then(() => {
        for (const listener of this.autoStopListeners) listener();
      });
    }, MAX_SCAN_DURATION_MS);

    this.scanResultSubscription = this.eventEmitter.addListener(
      EVENT_SCAN_RESULT,
      (event: NativeScanResultEvent) => this.handleScanResult(event),
    );
    this.scanErrorSubscription = this.eventEmitter.addListener(
      EVENT_SCAN_ERROR,
      (event: { errorCode: number }) => {
        this.emitError(
          new Error(`Native BLE scan error, code ${event.errorCode}`),
        );
      },
    );

    this.scanRestartSubscription = this.eventEmitter.addListener(
      EVENT_SCAN_RESTART,
      (event: NativeScanRestartEvent) => {
        for (const listener of this.restartListeners) {
          listener(event);
        }
      },
    );

    try {
      await getNativeModule().startScan(this.targetMac);
    } catch (error) {
      this.scanning = false;
      this.scanResultSubscription?.remove();
      this.scanErrorSubscription?.remove();

      this.scanRestartSubscription?.remove();
      this.scanRestartSubscription = null;
      this.emitError(
        new Error(
          `Failed to start native BLE scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.scanning) {
      return;
    }
    this.scanning = false;

    this._scanStartedAt = null;
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.scanResultSubscription?.remove();
    this.scanErrorSubscription?.remove();
    this.scanResultSubscription = null;
    this.scanErrorSubscription = null;

    try {
      await getNativeModule().stopScan();
    } catch (error) {
      this.emitError(
        new Error(
          `Failed to stop native BLE scan: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /** Kept for API compatibility with earlier callers — native module has no persistent handle to tear down, so this is equivalent to stop(). */
  async destroy(): Promise<void> {
    await this.stop();
  }

  private handleScanResult(event: NativeScanResultEvent): void {
    // Native module already filters by MAC via hardware ScanFilter, but
    // double-check defensively — cheap, and guards against any future
    // change to the native side forgetting the filter.
    const mac = event.mac.toUpperCase();
    if (mac !== this.targetMac) {
      return;
    }

    try {
      const raw = new Uint8Array(
        Buffer.from(event.serviceDataBase64, 'base64'),
      );

      console.log(
        'Raw serviceData hex (pre-parse):',
        Buffer.from(raw).toString('hex'),
        'len=' + raw.length,
      );

      const frame = parseMiBeaconHeader(raw, this.targetMacWireOrder);

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

      const rawReading = objectsToReading(objects);

      if (
        rawReading.temperatureC === undefined &&
        rawReading.humidityPercent === undefined &&
        rawReading.batteryPercent === undefined
      ) {
        return; // This advertisement cycle carried no sensor objects (e.g. a connectable-flag-only frame).
      }

      // Merge into last known state — see field comment on lastKnownReading.
      this.lastKnownReading = {
        ...this.lastKnownReading,
        ...rawReading,
      };

      this.emitUpdate({
        reading: this.lastKnownReading,
        rawReading,
        mac: frame.mac,
        rssi: event.rssi ?? null,
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
}

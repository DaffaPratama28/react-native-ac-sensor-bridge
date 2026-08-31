import {
  MiBeaconFrame,
  MiBeaconObject,
  MiBeaconObjectId,
  SensorReading,
} from '../types/mibeacon';

// Frame control bit masks (MiBeacon v5). Documented by the community
// reverse-engineering of the protocol (e.g. the ble_monitor / xiaomi_ble
// projects) — not an official Xiaomi spec. Validate against a real
// captured advertisement from your MJWSD05MMC before trusting these bit
// positions; if isEncrypted ever resolves incorrectly you'll get a hard
// decrypt failure (auth tag mismatch) rather than silently wrong data,
// which at least fails loud.
const FRAME_CONTROL_IS_ENCRYPTED = 0x0008;
const FRAME_CONTROL_HAS_MAC_ADDRESS = 0x0010;
const FRAME_CONTROL_HAS_CAPABILITIES = 0x0020;

const HEADER_MIN_LENGTH = 5; // frameControl(2) + productId(2) + frameCounter(1)
const MAC_LENGTH = 6;
const CAPABILITY_LENGTH = 2;

export class MiBeaconParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiBeaconParseError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToMac(macBytesReversedOrder: Uint8Array): string {
  // Wire order is reverse of conventional display order.
  const display = Array.from(macBytesReversedOrder).reverse();
  return display
    .map(b => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/**
 * Parses the header of a raw MiBeacon service-data payload (the bytes
 * that followed the 0xFE95 UUID in the advertisement, exactly as your
 * BLE scan callback / scanner.ts should hand them off).
 *
 * Does NOT decrypt — if isEncrypted is true, frame.rawPayload is still
 * ciphertext (+ extCnt + MIC tail); pass it to decrypt.ts next.
 */
export function parseMiBeaconHeader(serviceData: Uint8Array): MiBeaconFrame {
  if (serviceData.length < HEADER_MIN_LENGTH) {
    throw new MiBeaconParseError(
      `Service data too short to contain a MiBeacon header: ${serviceData.length} bytes.`,
    );
  }

  const view = new DataView(
    serviceData.buffer,
    serviceData.byteOffset,
    serviceData.byteLength,
  );

  const frameControl = view.getUint16(0, true);
  const productId = view.getUint16(2, true);
  const frameCounter = view.getUint8(4);

  let offset = HEADER_MIN_LENGTH;

  const hasMacAddress = (frameControl & FRAME_CONTROL_HAS_MAC_ADDRESS) !== 0;
  if (!hasMacAddress) {
    // Every MJWSD05MMC advertisement we've seen documented includes the
    // MAC, but guard anyway rather than reading garbage bytes as a MAC.
    throw new MiBeaconParseError(
      'Frame control indicates no MAC address present; cannot parse this frame variant.',
    );
  }
  if (serviceData.length < offset + MAC_LENGTH) {
    throw new MiBeaconParseError(
      'Service data too short to contain a MAC address.',
    );
  }
  const macBytes = serviceData.subarray(offset, offset + MAC_LENGTH);
  const mac = bytesToMac(macBytes);
  offset += MAC_LENGTH;

  const hasCapabilities = (frameControl & FRAME_CONTROL_HAS_CAPABILITIES) !== 0;
  if (hasCapabilities) {
    if (serviceData.length < offset + CAPABILITY_LENGTH) {
      throw new MiBeaconParseError(
        'Service data too short to contain capability bytes.',
      );
    }
    // Capability byte content isn't needed downstream; skip over it.
    offset += CAPABILITY_LENGTH;
  }

  const rawPayload = serviceData.subarray(offset);
  const isEncrypted = (frameControl & FRAME_CONTROL_IS_ENCRYPTED) !== 0;

  return {
    frameControl,
    productId,
    frameCounter,
    mac,
    isEncrypted,
    rawPayload,
    productIdBytes: serviceData.subarray(2, 4),
    macBytesWireOrder: macBytes,
  };
}

/**
 * Decodes a plaintext MiBeacon object payload (post-decryption, or the
 * original rawPayload for a device that isn't using encryption) into a
 * list of [id, data] TLV records.
 *
 * TLV layout per object: id(2 LE) + length(1) + data(length).
 */
export function parseObjects(payload: Uint8Array): MiBeaconObject[] {
  const objects: MiBeaconObject[] = [];
  let offset = 0;

  while (offset < payload.length) {
    if (offset + 3 > payload.length) {
      throw new MiBeaconParseError(
        `Truncated object TLV at offset ${offset}: not enough bytes for id+length header.`,
      );
    }

    const view = new DataView(payload.buffer, payload.byteOffset + offset, 3);
    const id = view.getUint16(0, true);
    const length = view.getUint8(2);

    const dataStart = offset + 3;
    const dataEnd = dataStart + length;
    if (dataEnd > payload.length) {
      throw new MiBeaconParseError(
        `Truncated object TLV at offset ${offset}: declared length ${length} exceeds remaining payload.`,
      );
    }

    objects.push({ id, data: payload.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }

  return objects;
}

/**
 * Interprets known object IDs (temperature, humidity, battery) into a
 * SensorReading. Unknown object IDs are silently ignored — the MJWSD05MMC
 * may broadcast additional object types (e.g. connectable flag) on some
 * cycles that aren't sensor data.
 */
export function objectsToReading(objects: MiBeaconObject[]): SensorReading {
  const reading: SensorReading = {};

  for (const obj of objects) {
    const view = new DataView(
      obj.data.buffer,
      obj.data.byteOffset,
      obj.data.byteLength,
    );

    switch (obj.id) {
      case MiBeaconObjectId.Temperature:
        if (obj.data.length >= 2) {
          reading.temperatureC = view.getInt16(0, true) / 10;
        }
        break;

      case MiBeaconObjectId.Humidity:
        if (obj.data.length >= 2) {
          reading.humidityPercent = view.getUint16(0, true) / 10;
        }
        break;

      case MiBeaconObjectId.TemperatureHumidity:
        if (obj.data.length >= 4) {
          reading.temperatureC = view.getInt16(0, true) / 10;
          reading.humidityPercent = view.getUint16(2, true) / 10;
        }
        break;

      case MiBeaconObjectId.Battery:
        if (obj.data.length >= 1) {
          reading.batteryPercent = view.getUint8(0);
        }
        break;

      case MiBeaconObjectId.HumidityV2:
        // Primary humidity candidate — see enum comment. Unscaled single
        // byte, direct % (0-100), do NOT apply the classic /10 scaling.
        if (obj.data.length >= 1) {
          reading.humidityPercent = view.getUint8(0);
        }
        break;

      case MiBeaconObjectId.HumidityV2Alt:
        // Secondary/fallback humidity candidate — see enum comment.
        if (obj.data.length >= 1) {
          reading.humidityPercent = view.getUint8(0);
        }
        break;

      case MiBeaconObjectId.BatteryV2:
        // See enum comment — confirmed once (value 100 on a fresh
        // device), not yet cross-validated against a second reading.
        if (obj.data.length >= 1) {
          reading.batteryPercent = view.getUint8(0);
        }
        break;

      default:
        // Unrecognized object id. Logged (not thrown) so the temperature
        // ID for this mibeacon2-style device can be identified empirically
        // — still unconfirmed as of this writing.
        console.log(
          `Unrecognized MiBeacon object id: 0x${obj.id
            .toString(16)
            .padStart(4, '0')}, ` +
            `length=${obj.data.length}, data=0x${bytesToHex(obj.data)}`,
        );
        break;
    }
  }

  return reading;
}

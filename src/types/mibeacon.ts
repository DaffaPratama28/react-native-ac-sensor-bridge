/**
 * MiBeacon v5 frame, as broadcast in the service data of a BLE
 * advertisement on service UUID 0xFE95.
 *
 * Field layout (all multi-byte integers little-endian unless noted):
 *   [0-1]   frameControl   uint16 bitfield
 *   [2-3]   productId      uint16
 *   [4]     frameCounter   uint8, increments per advertisement
 *   [5-10]  mac            6 bytes, transmitted in reverse byte order —
 *                           ONLY present if frameControl bit 0x0010 is set.
 *   [...]   payload        plaintext object TLVs, or if isEncrypted:
 *                           ciphertext + extCnt(3) + mic(4)
 *
 * Confirmed on this project's own MJWSD05MMC: when a threshold-triggered
 * advertisement would otherwise exceed the 31-byte BLE advertisement
 * limit (e.g. a float32-encoded temperature object), the sensor omits
 * its own MAC from the frame and clears the 0x0010 bit to signal this.
 * The MAC is still required to construct the AES-CCM nonce, so callers
 * must supply a fallback MAC (from the BLE scan result itself) in that
 * case — see parseMiBeaconHeader()'s fallbackMacWireOrder parameter.
 */
export interface MiBeaconFrame {
  frameControl: number;
  productId: number;
  frameCounter: number;
  /** MAC in normal display order (already reversed from wire order), e.g. "A4:C1:38:B7:58:9A" */
  mac: string;
  isEncrypted: boolean;
  /** Raw product id bytes as transmitted (little-endian), needed verbatim for nonce/AAD construction in decrypt.ts. */
  productIdBytes: Uint8Array;
  /**
   * Raw MAC bytes in wire order (not reversed), needed verbatim for
   * nonce/AAD construction in decrypt.ts. Sourced from the frame itself
   * when present, or from the caller-supplied fallback when the frame
   * omits it (see MiBeaconFrame doc comment above).
   */
  macBytesWireOrder: Uint8Array;
  /** True if macBytesWireOrder came from the fallback parameter rather than the frame itself. */
  macWasFallback: boolean;
  /** Raw bytes after the header, before any decryption. */
  rawPayload: Uint8Array;
}

/**
 * A single decoded object TLV from a decrypted (or, for unencrypted
 * devices, plaintext) MiBeacon payload.
 */
export interface MiBeaconObject {
  id: number;
  data: Uint8Array;
}

export interface SensorReading {
  /** Degrees Celsius, one decimal place of real precision. */
  temperatureC?: number;
  /** Relative humidity percentage, one decimal place of real precision. */
  humidityPercent?: number;
  batteryPercent?: number;
}

/** Known MiBeacon object IDs relevant to the Mijia temp/humidity line. */
export enum MiBeaconObjectId {
  // Classic MiBeacon v5 catalog (LYWSD03MMC-era devices).
  Temperature = 0x1004,
  Humidity = 0x1006,
  Battery = 0x100a,
  TemperatureHumidity = 0x100d,

  // Newer "mibeacon2" event-ID scheme used by the MJWSD05MMC (TH Sensor 3,
  // pdid 10290) and similar recent models — NOT the same ID space as the
  // classic catalog above, encoded as unscaled single bytes rather than
  // /10 int16.

  // TEMPERATURE, confirmed by this project's own captures: decrypted
  // (using a fallback MAC — see MiBeaconFrame doc comment) from a
  // no-MAC frame captured while the sensor sat in a laptop fan's
  // exhaust. Decoded as float32LE = 33.8, a sane reading for that
  // situation. Unlike every other object on this device, this one is a
  // 4-byte IEEE-754 float, not an unscaled/scaled integer byte.
  TemperatureV2 = 0x4801,

  // PRIMARY humidity candidate, confirmed by this project's own captures:
  // value 0x39 (57) at rest, then 0x4b (75) immediately after breathing on
  // the sensor — no button pressed, no app connected. Directionally
  // matches humidity, event-driven (broadcasts on meaningful change, not
  // a fixed timer). Earlier guessed to be a button-press marker; that was
  // wrong — corrected after this second data point.
  HumidityV2 = 0x4802,

  // SECONDARY humidity candidate, sourced from external research (a
  // GitHub issue on a similar device), never actually observed from this
  // unit. Possibly a different firmware/hardware revision's id, or wrong
  // for this device entirely. Kept mapped (lower confidence than
  // HumidityV2) in case it does show up in a future capture — but treat
  // 0x4802 above as the trustworthy one until proven otherwise.
  HumidityV2Alt = 0x4c02,

  // Battery candidate — confirmed once (single byte, value 0x64/100, a
  // plausible reading for a fresh battery), captured during the brief
  // connectable window after adding this sensor in Mi Home. Not yet
  // cross-validated against a second independent reading.
  BatteryV2 = 0x4c03,
}

import { createDecipheriv } from 'react-native-quick-crypto';
import { MiBeaconFrame } from '../types/mibeacon';

/**
 * Decrypts an encrypted MiBeacon payload (AES-128-CCM) using the sensor's
 * bindkey.
 *
 * This mirrors the widely-used community reverse-engineering of the
 * MiBeacon v5 encryption scheme (as implemented by projects like
 * ble_monitor / Home Assistant's xiaomi_ble integration) — it is NOT
 * derived from an official Xiaomi spec. Per project convention, treat
 * this as reference logic that needs validation against your own
 * hardware: decrypt a handful of live advertisements and sanity-check
 * the resulting temperature/humidity against a known-good reading
 * (e.g. compare to the Mi Home app) before wiring this into automation/.
 *
 * Wire format expected in frame.rawPayload when frame.isEncrypted:
 *   [0 .. n-8)   ciphertext
 *   [n-7 .. n-4) extCnt      3 bytes, appended to the nonce
 *   [n-4 .. n)   mic         4 bytes, AES-CCM authentication tag
 *
 * Nonce (12 bytes) = macBytesWireOrder(6) + productIdBytes(2) + frameCounter(1) + extCnt(3)
 * AAD              = fixed single byte 0x11 (per the reverse-engineered
 *                     MiBeacon v4/v5 protocol used by the community —
 *                     confirmed against ble_monitor's implementation;
 *                     this is NOT derived from the frame header, despite
 *                     what an earlier version of this file assumed)
 */

const MIC_LENGTH = 4;
const EXT_CNT_LENGTH = 3;
const TAIL_LENGTH = MIC_LENGTH + EXT_CNT_LENGTH;
const BINDKEY_HEX_LENGTH = 32; // 16 bytes

export class MiBeaconDecryptError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MiBeaconDecryptError';
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new MiBeaconDecryptError(`Invalid hex string: "${hex}"`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Fixed AAD used by the MiBeacon v4/v5 encryption scheme — not derived
// from the frame header. Confirmed against the ble_monitor reference
// implementation.
const MIBEACON_AAD = new Uint8Array([0x11]);

/**
 * @param frame       parsed header from parseMiBeaconHeader(); must have
 *                     frame.isEncrypted === true and frame.rawPayload
 *                     holding ciphertext + extCnt + MIC.
 * @param bindkeyHex   32-character hex bindkey, sourced from .env — never
 *                     hardcode this.
 * @returns            decrypted plaintext object payload, ready to pass
 *                      into parseObjects() from mibeacon.ts.
 */
export function decryptMiBeaconPayload(frame: MiBeaconFrame, bindkeyHex: string): Uint8Array {
  if (!frame.isEncrypted) {
    throw new MiBeaconDecryptError('decryptMiBeaconPayload() called on a non-encrypted frame.');
  }

  if (bindkeyHex.length !== BINDKEY_HEX_LENGTH) {
    throw new MiBeaconDecryptError(
      `Bindkey must be ${BINDKEY_HEX_LENGTH} hex characters (16 bytes). Got length: ${bindkeyHex.length}`,
    );
  }

  const payload = frame.rawPayload;
  if (payload.length < TAIL_LENGTH) {
    throw new MiBeaconDecryptError(
      `Encrypted payload too short: ${payload.length} bytes, need at least ${TAIL_LENGTH} for extCnt+MIC.`,
    );
  }

  const ciphertext = payload.subarray(0, payload.length - TAIL_LENGTH);
  const extCnt = payload.subarray(payload.length - TAIL_LENGTH, payload.length - MIC_LENGTH);
  const mic = payload.subarray(payload.length - MIC_LENGTH);

  const key = hexToBytes(bindkeyHex);

  const nonce = concatBytes(
    frame.macBytesWireOrder,
    frame.productIdBytes,
    new Uint8Array([frame.frameCounter]),
    extCnt,
  );

  const aad = MIBEACON_AAD;

  try {
    const decipher = createDecipheriv('aes-128-ccm', Buffer.from(key), Buffer.from(nonce), {
      authTagLength: MIC_LENGTH,
    });
    decipher.setAuthTag(Buffer.from(mic));
    decipher.setAAD(Buffer.from(aad), { plaintextLength: ciphertext.length });

    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
    return new Uint8Array(plaintext);
  } catch (error) {
    // Almost always means one of: wrong bindkey, wrong nonce/AAD
    // construction for this frame variant, or a corrupted/truncated
    // advertisement capture. CCM auth failures throw rather than
    // returning garbage, which is why this is safe to trust as a
    // pass/fail signal while validating against real hardware.
    throw new MiBeaconDecryptError(
      `AES-CCM decryption/authentication failed for MAC ${frame.mac}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

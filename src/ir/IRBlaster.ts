import { NativeModules, Platform } from 'react-native';

/**
 * Shape of the native module as exposed by IRBlasterModule.java.
 * Kept private to this file — external code should only ever use the
 * typed transmit() / hasIrEmitter() exports below.
 */
interface IRBlasterNativeModule {
  transmit(frequency: number, patternArray: number[]): Promise<void>;
  hasIrEmitter(): Promise<boolean>;
}

const LINKING_ERROR =
  `IRBlasterModule native module is not linked. Make sure:\n` +
  `  - You have rebuilt the app after adding IRBlasterPackage (JS-only reload is not enough)\n` +
  `  - IRBlasterPackage is registered in MainApplication\n` +
  `  - You are running on Android (this module has no iOS implementation)\n`;

function getNativeModule(): IRBlasterNativeModule {
  const nativeModule = NativeModules.IRBlasterModule as
    | IRBlasterNativeModule
    | undefined;

  if (!nativeModule) {
    throw new Error(LINKING_ERROR);
  }

  return nativeModule;
}

export class IRBlasterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'IRBlasterError';
  }
}

/**
 * Validates a raw IR pulse pattern before it crosses the JS/Native
 * boundary. Mirrors the checks IRBlasterModule.java performs natively —
 * duplicated intentionally so callers get a fast, descriptive failure
 * without waiting on a bridge round-trip.
 */
function validatePattern(frequency: number, patternArray: readonly number[]): void {
  if (!Number.isInteger(frequency) || frequency <= 0) {
    throw new IRBlasterError(
      `frequency must be a positive integer (Hz). Received: ${frequency}`,
      'ERR_INVALID_FREQUENCY',
    );
  }

  if (!Array.isArray(patternArray) || patternArray.length === 0) {
    throw new IRBlasterError('patternArray must be a non-empty array.', 'ERR_INVALID_PATTERN');
  }

  if (patternArray.length % 2 !== 0) {
    throw new IRBlasterError(
      `patternArray must have an even number of elements (alternating on/off durations). Received length: ${patternArray.length}`,
      'ERR_INVALID_PATTERN',
    );
  }

  for (let i = 0; i < patternArray.length; i++) {
    const value = patternArray[i];
    if (!Number.isInteger(value) || value <= 0) {
      throw new IRBlasterError(
        `patternArray values must be positive integers (microsecond durations). Invalid value at index ${i}: ${value}`,
        'ERR_INVALID_PATTERN',
      );
    }
  }
}

/**
 * Returns whether this device exposes a physical IR emitter.
 * Always check this before relying on transmit() in automation logic —
 * e.g. to disable the automation loop gracefully if run on hardware
 * without a blaster.
 */
export async function hasIrEmitter(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  try {
    return await getNativeModule().hasIrEmitter();
  } catch {
    return false;
  }
}

/**
 * Transmits a raw IR pulse pattern at the given carrier frequency via
 * the device's ConsumerIrManager.
 *
 * @param frequency    carrier frequency in Hz (e.g. 38000).
 * @param patternArray alternating on/off durations in microseconds,
 *                     starting with an "on" duration.
 *
 * @throws IRBlasterError on validation failure, missing hardware, or a
 *         native transmit failure. Callers in the automation layer
 *         should catch this explicitly rather than letting it propagate
 *         unhandled, since a failed transmit should not silently break
 *         the hysteresis/cooldown state machine.
 */
export async function transmit(frequency: number, patternArray: readonly number[]): Promise<void> {
  if (Platform.OS !== 'android') {
    throw new IRBlasterError('IR transmission is only supported on Android.', 'ERR_UNSUPPORTED_PLATFORM');
  }

  validatePattern(frequency, patternArray);

  try {
    await getNativeModule().transmit(frequency, Array.from(patternArray));
  } catch (error) {
    if (error instanceof IRBlasterError) {
      throw error;
    }

    // Native promise rejections arrive as { code, message } on Android.
    const code = (error as { code?: string })?.code ?? 'ERR_TRANSMIT_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    throw new IRBlasterError(message, code);
  }
}

export default {
  transmit,
  hasIrEmitter,
};

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HaierYrw02State,
  createDefaultState,
} from '../ir/protocols/acProtocol';

const STORAGE_KEY = 'irhomebridge:ac_state';

export type AcStateSource = 'manual' | 'automation' | 'timer_mirror';

export interface StoredAcState extends HaierYrw02State {
  lastUpdated: number;
  lastSource: AcStateSource;
}

export class AcStateStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AcStateStoreError';
  }
}

/**
 * Persists the AC's current (virtual-remote-mirrored) state. Called after
 * every transmit — manual button press, automation-triggered change, or a
 * timer-mirror update (see automation/timerMirror.ts) — so this file is
 * always the single source of truth for "what the AC is actually set to
 * right now", independent of whether the app is currently open.
 */
export async function saveAcState(
  state: HaierYrw02State,
  source: AcStateSource,
): Promise<void> {
  try {
    const entry: StoredAcState = {
      ...state,
      lastUpdated: Date.now(),
      lastSource: source,
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch (error) {
    throw new AcStateStoreError(
      `Failed to save AC state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/** Returns the stored AC state, or a fresh default state (not yet persisted) if nothing's stored. */
export async function loadAcState(): Promise<StoredAcState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...createDefaultState(), lastUpdated: 0, lastSource: 'manual' };
    }
    return JSON.parse(raw) as StoredAcState;
  } catch (error) {
    throw new AcStateStoreError(
      `Failed to read stored AC state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

export async function clearAcState(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    throw new AcStateStoreError(
      `Failed to clear stored AC state: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

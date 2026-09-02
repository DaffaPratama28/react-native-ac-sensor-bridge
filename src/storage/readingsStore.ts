import AsyncStorage from '@react-native-async-storage/async-storage';
import { SensorReading } from '../types/mibeacon';

const STORAGE_KEY = 'irhomebridge:readings_history';

// Hard cap on stored entries. AsyncStorage does a full read-modify-write
// of the whole array on every append, so this isn't a good fit for
// unbounded, high-frequency, long-term logging (a real SQLite DB would
// be the right call for that) — but for an overnight run of
// threshold-triggered readings (roughly one event per minute-ish, per
// earlier observation) this comfortably covers many days before
// trimming kicks in. Oldest entries are dropped once this cap is hit.
const MAX_STORED_ENTRIES = 20000;

/** A stored value is either the real reading, or the literal string
 * 'EMPTY' when that specific advertisement cycle didn't report this
 * attribute (this sensor only broadcasts whichever value crossed a
 * threshold, not a full bundle every time — see scanner.ts). Storing
 * 'EMPTY' explicitly, rather than omitting the field, keeps the history
 * an honest record of what was actually broadcast at that timestamp. */
export type StoredValue = number | 'EMPTY';

export interface StoredReading {
  timestamp: number;
  mac: string;
  temperatureC: StoredValue;
  humidityPercent: StoredValue;
  batteryPercent: StoredValue;
}

export class ReadingsStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ReadingsStoreError';
  }
}

function toStoredValue(value: number | undefined): StoredValue {
  return value === undefined ? 'EMPTY' : value;
}

/**
 * Appends one reading to the stored history, trimming the oldest entries
 * if over the cap.
 *
 * @param reading Pass the RAW per-cycle reading (e.g. SensorUpdate.rawReading
 *   from scanner.ts), not the merged/last-known one — this function fills
 *   in 'EMPTY' for whichever fields this specific cycle didn't report, so
 *   passing an already-merged reading would defeat the point and record
 *   values that weren't actually broadcast at this timestamp.
 */
export async function appendReading(params: {
  timestamp: number;
  mac: string;
  reading: SensorReading;
}): Promise<void> {
  try {
    const entry: StoredReading = {
      timestamp: params.timestamp,
      mac: params.mac,
      temperatureC: toStoredValue(params.reading.temperatureC),
      humidityPercent: toStoredValue(params.reading.humidityPercent),
      batteryPercent: toStoredValue(params.reading.batteryPercent),
    };

    const existing = await getAllReadings();
    const updated = [...existing, entry];

    const trimmed =
      updated.length > MAX_STORED_ENTRIES
        ? updated.slice(updated.length - MAX_STORED_ENTRIES)
        : updated;

    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    throw new ReadingsStoreError(
      `Failed to append reading: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/** Returns all stored readings, oldest first. Empty array if nothing stored yet. */
export async function getAllReadings(): Promise<StoredReading[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new ReadingsStoreError(
      `Failed to read stored readings: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/** Deletes all stored readings history. Used by the "clear data" button. */
export async function clearAllReadings(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    throw new ReadingsStoreError(
      `Failed to clear stored readings: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/** Number of readings currently stored. */
export async function getStoredReadingsCount(): Promise<number> {
  return (await getAllReadings()).length;
}

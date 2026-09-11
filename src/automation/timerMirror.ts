import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadAcState, saveAcState } from '../storage/acStateStore';

const ON_KEY = 'irhomebridge:timer_mirror_on';
const OFF_KEY = 'irhomebridge:timer_mirror_off';

interface MirrorRecord {
  targetTimestamp: number;
}

async function armMirror(key: string, minutesFromNow: number): Promise<void> {
  const record: MirrorRecord = {
    targetTimestamp: Date.now() + minutesFromNow * 60_000,
  };
  await AsyncStorage.setItem(key, JSON.stringify(record));
}

async function disarmMirror(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

async function getMirror(key: string): Promise<MirrorRecord | null> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as MirrorRecord) : null;
}

/** Call whenever the user arms the AC's real ON timer via the UI. */
export async function armOnTimerMirror(minutesFromNow: number): Promise<void> {
  await armMirror(ON_KEY, minutesFromNow);
}

/** Call whenever the user arms the AC's real OFF timer via the UI. */
export async function armOffTimerMirror(minutesFromNow: number): Promise<void> {
  await armMirror(OFF_KEY, minutesFromNow);
}

export async function disarmOnTimerMirror(): Promise<void> {
  await disarmMirror(ON_KEY);
}

export async function disarmOffTimerMirror(): Promise<void> {
  await disarmMirror(OFF_KEY);
}

export async function getArmedTimerMirrors(): Promise<{
  on: MirrorRecord | null;
  off: MirrorRecord | null;
}> {
  return { on: await getMirror(ON_KEY), off: await getMirror(OFF_KEY) };
}

/**
 * Call periodically (e.g. every 30s from RemoteControlScreen's tick). If
 * an armed native timer's target time has passed, updates ONLY the
 * persisted AC state file to reflect what the AC will have done on its
 * own via its hardware timer — does NOT transmit IR, since the AC
 * already acted on its own. Safe to call even with nothing armed.
 */
export async function checkAndApplyTimerMirrors(): Promise<void> {
  const now = Date.now();
  const { on, off } = await getArmedTimerMirrors();

  if (on && now >= on.targetTimestamp) {
    const current = await loadAcState();
    await saveAcState({ ...current, power: true }, 'timer_mirror');
    await disarmOnTimerMirror();
  }

  if (off && now >= off.targetTimestamp) {
    const current = await loadAcState();
    await saveAcState({ ...current, power: false }, 'timer_mirror');
    await disarmOffTimerMirror();
  }
}

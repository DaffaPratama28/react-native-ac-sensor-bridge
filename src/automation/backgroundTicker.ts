import { checkAndApplyTimerMirrors } from './timerMirror';

const TICK_INTERVAL_MS = 30_000;
let started = false;

/** Starts the shared 30s background tick that applies timer-mirror updates. Call once from App.tsx at startup. Idempotent. */
export function startBackgroundTicker(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    checkAndApplyTimerMirrors().catch(() => {
      // Best-effort — a missed tick just means the mirrored state updates ~30s late on the next one.
    });
  }, TICK_INTERVAL_MS);
}

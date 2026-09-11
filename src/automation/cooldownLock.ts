/**
 * Generic reusable interlock — enforces a minimum dwell time between
 * automation-triggered transitions. Originally scoped in the project spec
 * for protecting a non-inverter compressor from rapid Power OFF -> ON
 * cycling (10-15 min); kept generic so HysteresisAutomation can also use
 * it to prevent oscillation right at a threshold boundary.
 */
export class CooldownLock {
  private lastTransitionAt = 0;

  constructor(private minIntervalMs: number) {}

  setMinIntervalMs(ms: number): void {
    this.minIntervalMs = ms;
  }

  canTransition(now: number = Date.now()): boolean {
    return now - this.lastTransitionAt >= this.minIntervalMs;
  }

  recordTransition(now: number = Date.now()): void {
    this.lastTransitionAt = now;
  }

  /** ms remaining before canTransition() would return true. 0 if already allowed. */
  msUntilTransitionAllowed(now: number = Date.now()): number {
    const elapsed = now - this.lastTransitionAt;
    return Math.max(0, this.minIntervalMs - elapsed);
  }

  reset(): void {
    this.lastTransitionAt = 0;
  }
}

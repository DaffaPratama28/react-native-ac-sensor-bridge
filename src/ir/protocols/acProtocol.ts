/**
 * Haier YR-W02 remote / HSU-09HMC203 A/C protocol — 14-byte full-state
 * frame. Reference: IRremoteESP8266's ir_Haier.h / ir_Haier.cpp
 * (HAIER_AC_YRW02), reverse-engineered upstream by non7top
 * (https://github.com/crankyoldgit/IRremoteESP8266/issues/404).
 *
 * Every button on the real remote sends the ENTIRE current state, not a
 * toggle — callers must load/keep a HaierYrw02State (see acStateStore.ts)
 * and mutate+re-encode it on every command, exactly like the remote's own
 * firmware would.
 */

export type HaierMode = 'auto' | 'cool' | 'dry' | 'heat' | 'fan';
export type HaierFan = 'auto' | 'low' | 'med' | 'high';
export type HaierSwingV = 'off' | 'top' | 'middle' | 'bottom' | 'down' | 'auto';
export type HaierSwingH =
  | 'middle'
  | 'leftMax'
  | 'left'
  | 'right'
  | 'rightMax'
  | 'auto';
export type HaierTurboQuiet = 'off' | 'turbo' | 'quiet';

export interface HaierYrw02State {
  model: number;
  power: boolean;
  mode: HaierMode;
  tempC: number; // 16-30
  fan: HaierFan;
  swingV: HaierSwingV;
  swingH: HaierSwingH;
  turboQuiet: HaierTurboQuiet;
  health: boolean; // no dedicated UI button — kept at its stateReset() default
  sleep: boolean; // no dedicated UI button — kept at its stateReset() default
  lock: boolean;
  /** Minutes from now the AC's OWN hardware timer will turn it ON. 0 = disabled. */
  onTimerMinutes: number;
  /** Minutes from now the AC's OWN hardware timer will turn it OFF. 0 = disabled. */
  offTimerMinutes: number;
  button: number; // last-pressed button code — cosmetic (some units beep/flash based on it)
}

const MIN_TEMP_C = 16;
const MAX_TEMP_C = 30;
const MAX_TIMER_MINUTES = 24 * 60;

export const MODEL_A = 0xa6; // upstream default
export const MODEL_B = 0x59; // fallback if MODEL_A ever stops responding on a different unit

const MODE_VALUES: Record<HaierMode, number> = {
  auto: 0b000,
  cool: 0b001,
  dry: 0b010,
  heat: 0b100,
  fan: 0b110,
};
const MODE_CYCLE_ORDER: HaierMode[] = ['auto', 'cool', 'dry', 'heat', 'fan'];

const FAN_VALUES: Record<HaierFan, number> = {
  high: 0b001,
  med: 0b010,
  low: 0b011,
  auto: 0b101,
};

const SWING_V_VALUES: Record<HaierSwingV, number> = {
  off: 0x0,
  top: 0x1,
  middle: 0x2, // not honored in heat mode on the real unit
  bottom: 0x3, // heat mode only on the real unit
  down: 0xa,
  auto: 0xc,
};

const SWING_H_VALUES: Record<HaierSwingH, number> = {
  middle: 0x0,
  leftMax: 0x3,
  left: 0x4,
  right: 0x5,
  rightMax: 0x6,
  auto: 0x7,
};

const BUTTON = {
  tempUp: 0b00000,
  tempDown: 0b00001,
  swingV: 0b00010,
  swingH: 0b00011,
  fan: 0b00100,
  power: 0b00101,
  mode: 0b00110,
  health: 0b00111,
  turbo: 0b01000,
  sleep: 0b01011,
  timer: 0b10000,
  lock: 0b10100,
} as const;

// TimerMode field values (3 bits, byte 3 bits 5-7)
const TIMER_MODE = {
  none: 0b000,
  offOnly: 0b001,
  onOnly: 0b010,
  onThenOff: 0b100, // on-timer fires before off-timer
  offThenOn: 0b101, // off-timer fires before on-timer
} as const;

/** Matches IRHaierAC176::stateReset() defaults for the fields YR-W02 actually uses. */
export function createDefaultState(): HaierYrw02State {
  return {
    model: MODEL_A,
    power: true,
    mode: 'auto',
    tempC: 25,
    fan: 'auto',
    swingV: 'off',
    swingH: 'middle',
    turboQuiet: 'off',
    health: true,
    sleep: false,
    lock: false,
    onTimerMinutes: 0,
    offTimerMinutes: 0,
    button: BUTTON.power,
  };
}

function clampTemp(tempC: number): number {
  return Math.max(MIN_TEMP_C, Math.min(MAX_TEMP_C, tempC));
}

function clampTimerMinutes(minutes: number): number {
  return Math.max(0, Math.min(MAX_TIMER_MINUTES, Math.round(minutes)));
}

function deriveTimerMode(onMinutes: number, offMinutes: number): number {
  const onSet = onMinutes > 0;
  const offSet = offMinutes > 0;
  if (!onSet && !offSet) return TIMER_MODE.none;
  if (onSet && !offSet) return TIMER_MODE.onOnly;
  if (!onSet && offSet) return TIMER_MODE.offOnly;
  return onMinutes <= offMinutes ? TIMER_MODE.onThenOff : TIMER_MODE.offThenOn;
}

/**
 * Your remote's own stepping: 0.5h increments from 0.5h to 12h, then 1h
 * increments from 13h to 24h. Index 0 = 30min ... last index = 1440min
 * (24h). Use with stepTimerMinutes() rather than raw +/-30 arithmetic so
 * UI +/- buttons match the real remote's granularity at every point.
 */
export const TIMER_STEP_MINUTES: number[] = [
  ...Array.from({ length: 24 }, (_, i) => (i + 1) * 30), // 30..720 (0.5h..12h)
  ...Array.from({ length: 12 }, (_, i) => 780 + i * 60), // 780..1440 (13h..24h)
];

/** Moves to the next/previous step in TIMER_STEP_MINUTES. currentMinutes=0 (disabled) steps to/from the nearest end. */
export function stepTimerMinutes(
  currentMinutes: number,
  direction: 1 | -1,
): number {
  if (currentMinutes <= 0) {
    return direction === 1 ? TIMER_STEP_MINUTES[0] : 0;
  }
  const idx = TIMER_STEP_MINUTES.findIndex(m => m >= currentMinutes);
  const safeIdx = idx === -1 ? TIMER_STEP_MINUTES.length - 1 : idx;
  const nextIdx = safeIdx + direction;
  if (nextIdx < 0) return 0; // stepping below the first entry disables the timer
  if (nextIdx >= TIMER_STEP_MINUTES.length)
    return TIMER_STEP_MINUTES[TIMER_STEP_MINUTES.length - 1];
  return TIMER_STEP_MINUTES[nextIdx];
}

/** Encodes a HaierYrw02State into the 14-byte raw frame (bitfields packed LSB-first). */
export function encodeState(state: HaierYrw02State): Uint8Array {
  const bytes = new Uint8Array(14);

  bytes[0] = state.model & 0xff;

  const tempField = clampTemp(state.tempC) - MIN_TEMP_C; // 0-14
  bytes[1] = (SWING_V_VALUES[state.swingV] & 0x0f) | ((tempField & 0x0f) << 4);

  bytes[2] = (SWING_H_VALUES[state.swingH] & 0x07) << 5;

  const timerMode = deriveTimerMode(
    state.onTimerMinutes,
    state.offTimerMinutes,
  );
  bytes[3] = ((state.health ? 1 : 0) << 1) | ((timerMode & 0x07) << 5);

  bytes[4] = (state.power ? 1 : 0) << 6;

  const offMinutes = clampTimerMinutes(state.offTimerMinutes);
  const offHrs = Math.floor(offMinutes / 60);
  const offMins = offMinutes % 60;
  bytes[5] = (offHrs & 0x1f) | ((FAN_VALUES[state.fan] & 0x07) << 5);
  bytes[6] =
    (offMins & 0x3f) |
    ((state.turboQuiet === 'turbo' ? 1 : 0) << 6) |
    ((state.turboQuiet === 'quiet' ? 1 : 0) << 7);

  const onMinutes = clampTimerMinutes(state.onTimerMinutes);
  const onHrs = Math.floor(onMinutes / 60);
  const onMins = onMinutes % 60;
  bytes[7] = (onHrs & 0x1f) | ((MODE_VALUES[state.mode] & 0x07) << 5);
  bytes[8] = (onMins & 0x3f) | ((state.sleep ? 1 : 0) << 7);

  bytes[9] = 0;
  bytes[10] = 0; // Celsius only, no ExtraDegreeF
  bytes[11] = 0;
  bytes[12] = (state.button & 0x1f) | ((state.lock ? 1 : 0) << 5);

  let sum = 0;
  for (let i = 0; i < 13; i++) sum = (sum + bytes[i]) & 0xff;
  bytes[13] = sum;

  return bytes;
}

// --- Raw IR timing (unchanged from prior validated version) ---
const CARRIER_FREQUENCY_HZ = 38000;
const HDR_MARK = 3000;
const HDR_SPACE = 4300;
const BIT_MARK = 520;
const ONE_SPACE = 1650;
const ZERO_SPACE = 650;
const TRAILING_GAP = 150000;

export function stateToPulsePattern(bytes: Uint8Array): number[] {
  const pattern: number[] = [];
  pattern.push(HDR_MARK, HDR_MARK);
  pattern.push(HDR_MARK, HDR_SPACE);
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const isOne = ((byte >> bit) & 1) === 1;
      pattern.push(BIT_MARK, isOne ? ONE_SPACE : ZERO_SPACE);
    }
  }
  pattern.push(BIT_MARK, TRAILING_GAP);
  return pattern;
}

export function stateToCommand(state: HaierYrw02State): {
  frequency: number;
  pattern: number[];
} {
  return {
    frequency: CARRIER_FREQUENCY_HZ,
    pattern: stateToPulsePattern(encodeState(state)),
  };
}

export function nextMode(current: HaierMode): HaierMode {
  const idx = MODE_CYCLE_ORDER.indexOf(current);
  return MODE_CYCLE_ORDER[(idx + 1) % MODE_CYCLE_ORDER.length];
}

/** Turbo/Quiet only take effect in cool/heat mode on the real unit — use to grey out the UI group. */
export function isTurboQuietAvailable(mode: HaierMode): boolean {
  return mode === 'cool' || mode === 'heat';
}

export function formatTimerMinutes(minutes: number): string {
  if (minutes <= 0) return 'Off';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

export const BUTTON_CODES = BUTTON;

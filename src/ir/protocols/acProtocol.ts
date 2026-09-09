/**
 * Haier YR-W02 remote / HSU-09HMC203 A/C protocol — 14-byte full-state
 * frame. Reference: IRremoteESP8266's ir_Haier.h / ir_Haier.cpp
 * (HAIER_AC_YRW02), reverse-engineered upstream by non7top
 * (https://github.com/crankyoldgit/IRremoteESP8266/issues/404).
 *
 * NOT VALIDATED AGAINST THE REAL AC YET. Two likely failure points if
 * nothing happens on first test:
 *  - MODEL byte (below) may need to be MODEL_B (0x59) instead of
 *    MODEL_A (0xA6) depending on the exact unit.
 *  - The 150ms trailing gap is upstream's own "completely made up value"
 *    (their comment, not ours) — safe to shorten if needed, unlikely to
 *    be the actual cause of a non-response though.
 *
 * Every button on the real remote sends the ENTIRE current state, not a
 * toggle — so this module keeps a small in-memory "virtual remote"
 * state and mutates+re-encodes it on every command, exactly like the
 * real remote's own firmware would.
 */

export type HaierMode = 'auto' | 'cool' | 'dry' | 'heat' | 'fan';
export type HaierFan = 'auto' | 'low' | 'med' | 'high';

export interface HaierYrw02State {
  model: number;
  power: boolean;
  mode: HaierMode;
  tempC: number; // 16-30
  fan: HaierFan;
  swingV: number; // raw 0-0xF, 0 = off/middle default
  swingH: number; // raw 0-7, 0 = middle default
  health: boolean;
  turbo: boolean;
  quiet: boolean;
  sleep: boolean;
  lock: boolean;
  button: number; // last-pressed button code, purely cosmetic (some units beep/flash based on it)
}

const MIN_TEMP_C = 16;
const MAX_TEMP_C = 30;

// Model byte values (byte 0) — see file header note above.
export const MODEL_A = 0xa6; // upstream default
export const MODEL_B = 0x59; // try this if MODEL_A doesn't respond

// Mode field values (3 bits)
const MODE_VALUES: Record<HaierMode, number> = {
  auto: 0b000,
  cool: 0b001,
  dry: 0b010,
  heat: 0b100,
  fan: 0b110,
};
const MODE_CYCLE_ORDER: HaierMode[] = ['auto', 'cool', 'dry', 'heat', 'fan'];

// Fan field values (3 bits)
const FAN_VALUES: Record<HaierFan, number> = {
  high: 0b001,
  med: 0b010,
  low: 0b011,
  auto: 0b101,
};

// Button field values (5 bits) — cosmetic, mirrors "which physical button was pressed"
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
} as const;

/** Matches IRHaierAC176::stateReset() defaults for the fields YR-W02 actually uses. */
export function createDefaultState(): HaierYrw02State {
  return {
    model: MODEL_A,
    power: true,
    mode: 'auto',
    tempC: 25,
    fan: 'auto',
    swingV: 0,
    swingH: 0,
    health: true,
    turbo: false,
    quiet: false,
    sleep: false,
    lock: false,
    button: BUTTON.power,
  };
}

function clampTemp(tempC: number): number {
  return Math.max(MIN_TEMP_C, Math.min(MAX_TEMP_C, tempC));
}

/**
 * Encodes a HaierYrw02State into the 14-byte raw frame, matching
 * HaierAc176Protocol's bit layout (bitfields packed LSB-first, matching
 * the reference implementation's target compiler convention).
 */
export function encodeState(state: HaierYrw02State): Uint8Array {
  const bytes = new Uint8Array(14);

  bytes[0] = state.model & 0xff;

  const tempField = clampTemp(state.tempC) - MIN_TEMP_C; // 0-14
  bytes[1] = (state.swingV & 0x0f) | ((tempField & 0x0f) << 4);

  bytes[2] = (state.swingH & 0x07) << 5;

  bytes[3] = ((state.health ? 1 : 0) << 1) | (0 << 5); // TimerMode always 0 (no timers in this quick test)

  bytes[4] = (state.power ? 1 : 0) << 6;

  bytes[5] = (0 & 0x1f) | ((FAN_VALUES[state.fan] & 0x07) << 5); // OffTimerHrs always 0

  bytes[6] =
    (0 & 0x3f) | ((state.turbo ? 1 : 0) << 6) | ((state.quiet ? 1 : 0) << 7); // OffTimerMins always 0

  bytes[7] = (0 & 0x1f) | ((MODE_VALUES[state.mode] & 0x07) << 5); // OnTimerHrs always 0

  bytes[8] = (0 & 0x3f) | ((state.sleep ? 1 : 0) << 7); // OnTimerMins always 0

  bytes[9] = 0;

  bytes[10] = 0; // UseFahrenheit=false, ExtraDegreeF=0 — Celsius only for this quick test

  bytes[11] = 0;

  bytes[12] = (state.button & 0x1f) | ((state.lock ? 1 : 0) << 5);

  let sum = 0;
  for (let i = 0; i < 13; i++) sum = (sum + bytes[i]) & 0xff;
  bytes[13] = sum;

  return bytes;
}

// --- Raw IR timing, from IRremoteESP8266's ir_Haier.cpp constants ---
const CARRIER_FREQUENCY_HZ = 38000;
const HDR_MARK = 3000; // kHaierAcHdr — used twice: once as a leading mark+space pair, once as sendGeneric's own header mark
const HDR_SPACE = 4300; // kHaierAcHdrGap
const BIT_MARK = 520; // kHaierAcBitMark
const ONE_SPACE = 1650; // kHaierAcOneSpace
const ZERO_SPACE = 650; // kHaierAcZeroSpace
const TRAILING_GAP = 150000; // kHaierAcMinGap — upstream's own comment: "Completely made up value."

/**
 * Converts a raw state frame into a ConsumerIrManager-compatible pulse
 * pattern (alternating on/off µs durations, starting with "on") at
 * CARRIER_FREQUENCY_HZ. Mirrors IRsend::sendHaierAC()'s exact sequence:
 * a leading mark+space pair, then sendGeneric's own header, then each
 * byte MSB-first, then a footer mark + trailing gap.
 */
export function stateToPulsePattern(bytes: Uint8Array): number[] {
  const pattern: number[] = [];

  pattern.push(HDR_MARK, HDR_MARK); // leading mark(3000) + space(3000) — yes, both use the same constant; matches upstream exactly
  pattern.push(HDR_MARK, HDR_SPACE); // sendGeneric's own header mark(3000) + space(4300)

  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const isOne = ((byte >> bit) & 1) === 1;
      pattern.push(BIT_MARK, isOne ? ONE_SPACE : ZERO_SPACE);
    }
  }

  pattern.push(BIT_MARK, TRAILING_GAP); // footer mark + trailing gap

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

/** Advances mode to the next in the real remote's own cycle order (Auto→Cool→Dry→Heat→Fan→Auto…). */
export function nextMode(current: HaierMode): HaierMode {
  const idx = MODE_CYCLE_ORDER.indexOf(current);
  return MODE_CYCLE_ORDER[(idx + 1) % MODE_CYCLE_ORDER.length];
}

import { HaierYrw02State } from '../ir/protocols/acProtocol';
import { CooldownLock } from './cooldownLock';

export type SensorCombineMode = 'temperature' | 'humidity' | 'and' | 'or';
export type Zone = 'low' | 'high' | 'unset';

export interface ThresholdPair {
  low: number;
  high: number;
}

export interface AutomationConfig {
  combineMode: SensorCombineMode;
  temperature?: ThresholdPair; // required when combineMode uses temperature
  humidity?: ThresholdPair; // required when combineMode uses humidity
  /** Applied once when entering the "low" zone (e.g. { mode: 'dry' }). */
  lowAction: Partial<HaierYrw02State>;
  /** Applied once when entering the "high" zone (e.g. { mode: 'cool' }). */
  highAction: Partial<HaierYrw02State>;
  /** Minimum time between automation-triggered transitions. Default 3 min. */
  minTransitionIntervalMs?: number;
}

export interface SensorSnapshot {
  temperatureC?: number;
  humidityPercent?: number;
}

/**
 * Classic Schmitt-trigger hysteresis: crossing DOWN through the low
 * threshold applies lowAction and stays there regardless of further
 * readings in between; crossing UP through the high threshold applies
 * highAction and stays there — matches "hits 27°C -> dry until it hits
 * 28°C -> back to cool" exactly.
 *
 * IMPORTANT: pass the MERGED reading (update.reading from scanner.ts's
 * onUpdate), not rawReading — this sensor fragments broadcasts across
 * cycles, and 'and'/'or' combine modes need both fields available at
 * once, which only the merged reading guarantees after the first cycle.
 */
export class HysteresisAutomation {
  private zone: Zone = 'unset';
  private readonly lock: CooldownLock;

  constructor(private config: AutomationConfig) {
    this.lock = new CooldownLock(config.minTransitionIntervalMs ?? 3 * 60_000);
  }

  updateConfig(config: AutomationConfig): void {
    this.config = config;
    this.lock.setMinIntervalMs(config.minTransitionIntervalMs ?? 3 * 60_000);
    this.zone = 'unset'; // re-evaluate fresh against the new thresholds
  }

  getZone(): Zone {
    return this.zone;
  }

  /** Feed a new reading. Returns the action to apply, or null if nothing should change. */
  evaluate(
    reading: SensorSnapshot,
    now: number = Date.now(),
  ): Partial<HaierYrw02State> | null {
    const { combineMode, temperature, humidity } = this.config;

    const tempLow =
      temperature !== undefined && reading.temperatureC !== undefined
        ? reading.temperatureC <= temperature.low
        : undefined;
    const tempHigh =
      temperature !== undefined && reading.temperatureC !== undefined
        ? reading.temperatureC >= temperature.high
        : undefined;
    const humLow =
      humidity !== undefined && reading.humidityPercent !== undefined
        ? reading.humidityPercent <= humidity.low
        : undefined;
    const humHigh =
      humidity !== undefined && reading.humidityPercent !== undefined
        ? reading.humidityPercent >= humidity.high
        : undefined;

    let enterLow: boolean;
    let enterHigh: boolean;
    switch (combineMode) {
      case 'temperature':
        enterLow = !!tempLow;
        enterHigh = !!tempHigh;
        break;
      case 'humidity':
        enterLow = !!humLow;
        enterHigh = !!humHigh;
        break;
      case 'and':
        enterLow = !!tempLow && !!humLow;
        enterHigh = !!tempHigh && !!humHigh;
        break;
      case 'or':
        enterLow = !!tempLow || !!humLow;
        enterHigh = !!tempHigh || !!humHigh;
        break;
    }

    if (enterLow && this.zone !== 'low') {
      if (!this.lock.canTransition(now)) return null;
      this.zone = 'low';
      this.lock.recordTransition(now);
      return this.config.lowAction;
    }
    if (enterHigh && this.zone !== 'high') {
      if (!this.lock.canTransition(now)) return null;
      this.zone = 'high';
      this.lock.recordTransition(now);
      return this.config.highAction;
    }
    return null;
  }
}

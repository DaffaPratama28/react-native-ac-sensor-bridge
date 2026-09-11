import AsyncStorage from '@react-native-async-storage/async-storage';

import { scanner } from '../ble/sharedScanner';
import { transmit } from '../ir/IRBlaster';
import { HaierYrw02State, stateToCommand } from '../ir/protocols/acProtocol';
import { loadAcState, saveAcState } from '../storage/acStateStore';
import {
  AutomationConfig,
  HysteresisAutomation,
  SensorSnapshot,
  Zone,
} from './hysteresis';

const CONFIG_KEY = 'irhomebridge:automation_config';
const ENABLED_KEY = 'irhomebridge:automation_enabled';

export type AutomationEvent =
  | { type: 'applied'; action: Partial<HaierYrw02State>; zone: Zone }
  | { type: 'error'; message: string };

export type AutomationEventListener = (event: AutomationEvent) => void;

/**
 * Module-level singleton (like sharedScanner.ts's `scanner`) — keeps
 * running for as long as the JS engine is alive, independent of which
 * screen is currently mounted. RemoteControlScreen only reads/writes its
 * config; it doesn't own its subscription lifecycle.
 */
class AutomationController {
  private config: AutomationConfig | null = null;
  private engine: HysteresisAutomation | null = null;
  private enabled = false;
  private scannerUnsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<AutomationEventListener>();

  /** Call once at app startup — restores config/enabled flag and resumes automation if it was on. */
  async loadPersisted(): Promise<{
    config: AutomationConfig | null;
    enabled: boolean;
  }> {
    const [rawConfig, rawEnabled] = await Promise.all([
      AsyncStorage.getItem(CONFIG_KEY),
      AsyncStorage.getItem(ENABLED_KEY),
    ]);

    this.config = rawConfig
      ? (JSON.parse(rawConfig) as AutomationConfig)
      : null;
    this.enabled = rawEnabled === 'true';
    this.engine = this.config ? new HysteresisAutomation(this.config) : null;

    if (this.enabled && this.engine) {
      this.subscribeToScanner();
    }

    return { config: this.config, enabled: this.enabled };
  }

  async setConfig(config: AutomationConfig): Promise<void> {
    this.config = config;
    this.engine = new HysteresisAutomation(config);
    await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    if (this.enabled) {
      this.subscribeToScanner(); // fresh engine instance — resubscribe cleanly rather than reuse a stale closure
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await AsyncStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
    if (enabled && this.engine) {
      this.subscribeToScanner();
    } else {
      this.unsubscribeFromScanner();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getConfig(): AutomationConfig | null {
    return this.config;
  }

  getZone(): Zone {
    return this.engine?.getZone() ?? 'unset';
  }

  onEvent(listener: AutomationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private subscribeToScanner(): void {
    this.unsubscribeFromScanner();
    if (!this.engine) return;

    this.scannerUnsubscribe = scanner.onUpdate(async update => {
      if (!this.engine) return;

      const snapshot: SensorSnapshot = {
        temperatureC: update.reading.temperatureC,
        humidityPercent: update.reading.humidityPercent,
      };
      const action = this.engine.evaluate(snapshot);
      if (!action) return;

      try {
        const current = await loadAcState();
        const next: HaierYrw02State = { ...current, ...action };
        const { frequency, pattern } = stateToCommand(next);
        await transmit(frequency, pattern);
        await saveAcState(next, 'automation');
        this.emit({ type: 'applied', action, zone: this.engine.getZone() });
      } catch (error) {
        this.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private unsubscribeFromScanner(): void {
    this.scannerUnsubscribe?.();
    this.scannerUnsubscribe = null;
  }

  private emit(event: AutomationEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export const automationController = new AutomationController();

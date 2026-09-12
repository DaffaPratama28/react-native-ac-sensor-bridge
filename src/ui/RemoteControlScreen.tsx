import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { scanner } from '../ble/sharedScanner';
import { MAX_SCAN_DURATION_MS } from '../ble/scanner';
import { transmit, IRBlasterError } from '../ir/IRBlaster';
import {
  createDefaultState,
  encodeState,
  stateToCommand,
  isTurboQuietAvailable,
  stepTimerMinutes,
  formatTimerMinutes,
  BUTTON_CODES,
  HaierYrw02State,
  HaierMode,
  HaierFan,
  HaierSwingV,
  HaierSwingH,
  HaierTurboQuiet,
} from '../ir/protocols/acProtocol';
import { loadAcState, saveAcState } from '../storage/acStateStore';
import { automationController } from '../automation/automationController';
import { PowerIcon } from './PowerIcon';
import {
  AutomationConfig,
  SensorCombineMode,
  Zone,
} from '../automation/hysteresis';
import {
  armOnTimerMirror,
  armOffTimerMirror,
  disarmOnTimerMirror,
  disarmOffTimerMirror,
} from '../automation/timerMirror';

interface Props {
  onClose: () => void;
}

const AC_ACCENT = '#3d6bff';
const AUTO_ACCENT = '#18c990';

const MODE_OPTIONS: { value: HaierMode; label: string }[] = [
  { value: 'cool', label: 'Cool' },
  { value: 'dry', label: 'Dry' },
  { value: 'fan', label: 'Fan' },
];
const FAN_OPTIONS: { value: HaierFan; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'med', label: 'Med' },
  { value: 'high', label: 'High' },
];
// Simplified from all 6 raw protocol positions down to the 2 that matter
// day-to-day (sweeping vs fixed), same trim already applied to Mode
// (Cool/Dry/Fan only, not all 5). The other Swing H positions still exist
// in the protocol/state, just not wired to a button here.
const SWING_H_OPTIONS: { value: HaierSwingH; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'middle', label: 'Middle' },
];
const SWING_V_OPTIONS: { value: HaierSwingV; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];
const TURBO_QUIET_OPTIONS: { value: HaierTurboQuiet; label: string }[] = [
  { value: 'turbo', label: 'Turbo' },
  { value: 'off', label: 'Auto' },
  { value: 'quiet', label: 'Quiet' },
];
const TRIGGER_OPTIONS: { value: SensorCombineMode; label: string }[] = [
  { value: 'temperature', label: 'Temp' },
  { value: 'humidity', label: 'Hum' },
  { value: 'and', label: 'AND' },
  { value: 'or', label: 'OR' },
];

function formatHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// --- Small reusable pieces -------------------------------------------------

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accentColor,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  accentColor: string;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.segmentTrack, disabled && styles.dimmed]}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[
              styles.segmentItem,
              active && { backgroundColor: accentColor },
            ]}
            onPress={() => !disabled && onChange(opt.value)}
            disabled={disabled}
          >
            <Text
              style={[styles.segmentText, active && styles.segmentTextActive]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CircleButton({
  glyph,
  icon,
  onPress,
  active,
  accentColor,
  size = 40,
  disabled,
}: {
  glyph?: string;
  icon?: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  accentColor: string;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.circleButton,
        { width: size, height: size, borderRadius: size / 2 },
        active && { backgroundColor: accentColor, borderColor: accentColor },
        disabled && styles.dimmed,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {icon ?? <Text style={styles.circleButtonText}>{glyph}</Text>}
    </Pressable>
  );
}

function Stepper({
  label,
  displayValue,
  onDecrement,
  onIncrement,
  accentColor,
  disabled,
}: {
  label: string;
  displayValue: string;
  onDecrement: () => void;
  onIncrement: () => void;
  accentColor: string;
  disabled?: boolean;
}) {
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <CircleButton
          glyph="−"
          onPress={onDecrement}
          accentColor={accentColor}
          size={32}
          disabled={disabled}
        />
        <Text style={styles.stepperValue}>{displayValue}</Text>
        <CircleButton
          glyph="+"
          onPress={onIncrement}
          accentColor={accentColor}
          size={32}
          disabled={disabled}
        />
      </View>
    </View>
  );
}

// --- Screen -----------------------------------------------------------------

export function RemoteControlScreen({ onClose }: Props) {
  const [acState, setAcState] = useState<HaierYrw02State>(createDefaultState());
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState('No command sent yet.');

  const [isScanning, setIsScanning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [liveTemp, setLiveTemp] = useState<number | undefined>(undefined);
  const [liveHumidity, setLiveHumidity] = useState<number | undefined>(
    undefined,
  );

  const [pendingOnMinutes, setPendingOnMinutes] = useState(0);
  const [pendingOffMinutes, setPendingOffMinutes] = useState(0);
  const [onTimerArmed, setOnTimerArmed] = useState(false);
  const [offTimerArmed, setOffTimerArmed] = useState(false);

  const [combineMode, setCombineMode] =
    useState<SensorCombineMode>('temperature');
  const [tempLow, setTempLow] = useState(27);
  const [tempHigh, setTempHigh] = useState(28);
  const [humidityLow, setHumidityLow] = useState(50);
  const [humidityHigh, setHumidityHigh] = useState(60);
  const [lowActionMode, setLowActionMode] = useState<HaierMode>('dry');
  const [highActionMode, setHighActionMode] = useState<HaierMode>('cool');
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [automationZone, setAutomationZone] = useState<Zone>('unset');
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const [automationEvent, setAutomationEvent] = useState('Automation is off.');

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didMountAutomationEffect = useRef(false);

  useEffect(() => {
    loadAcState().then(stored => {
      const { lastUpdated, lastSource, ...state } = stored;
      setAcState(state);
      setOnTimerArmed(state.onTimerMinutes > 0);
      setOffTimerArmed(state.offTimerMinutes > 0);
      if (state.onTimerMinutes > 0) setPendingOnMinutes(state.onTimerMinutes);
      if (state.offTimerMinutes > 0)
        setPendingOffMinutes(state.offTimerMinutes);
    });

    const existingConfig = automationController.getConfig();
    if (existingConfig) {
      setCombineMode(existingConfig.combineMode);
      if (existingConfig.temperature) {
        setTempLow(existingConfig.temperature.low);
        setTempHigh(existingConfig.temperature.high);
      }
      if (existingConfig.humidity) {
        setHumidityLow(existingConfig.humidity.low);
        setHumidityHigh(existingConfig.humidity.high);
      }
      if (existingConfig.lowAction.mode)
        setLowActionMode(existingConfig.lowAction.mode);
      if (existingConfig.highAction.mode)
        setHighActionMode(existingConfig.highAction.mode);
    }
    setAutomationEnabled(automationController.isEnabled());
    setAutomationZone(automationController.getZone());

    const unsubUpdate = scanner.onUpdate(u => {
      setLiveTemp(u.reading.temperatureC);
      setLiveHumidity(u.reading.humidityPercent);
    });

    const unsubAutomation = automationController.onEvent(event => {
      setAutomationZone(automationController.getZone());
      if (event.type === 'applied') {
        setAutomationEvent(
          `Applied ${JSON.stringify(event.action)} (zone: ${
            event.zone
          }) at ${new Date().toLocaleTimeString()}`,
        );
        loadAcState().then(stored => {
          const { lastUpdated, lastSource, ...state } = stored;
          setAcState(state);
        });
      } else if (event.type === 'blocked') {
        setAutomationEvent(
          `Blocked by cooldown — would switch to "${
            event.wouldEnterZone
          }", ${Math.ceil(event.remainingMs / 1000)}s left.`,
        );
      } else {
        setAutomationEvent(`Error: ${event.message}`);
      }
    });

    tickRef.current = setInterval(() => {
      const startedAt = scanner.scanStartedAt;
      setIsScanning(startedAt !== null);
      if (startedAt !== null) {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(elapsed);
        setRemainingSeconds(
          Math.max(0, Math.floor(MAX_SCAN_DURATION_MS / 1000) - elapsed),
        );
      }
      setCooldownRemainingMs(automationController.getCooldownRemainingMs());
    }, 1000);

    return () => {
      unsubUpdate();
      unsubAutomation();
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    if (!didMountAutomationEffect.current) {
      didMountAutomationEffect.current = true;
      return;
    }
    if (!automationEnabled) return;
    buildAutomationConfig().then(config =>
      automationController.setConfig(config),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    combineMode,
    tempLow,
    tempHigh,
    humidityLow,
    humidityHigh,
    lowActionMode,
    highActionMode,
  ]);

  const send = async (patch: Partial<HaierYrw02State>, label: string) => {
    const next: HaierYrw02State = { ...acState, ...patch };
    setAcState(next);
    setSending(true);
    try {
      const { frequency, pattern } = stateToCommand(next);
      await transmit(frequency, pattern);
      await saveAcState(next, 'manual');
      const frameHex = Array.from(encodeState(next))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      setLastResult(`Sent: ${label}\nFrame: ${frameHex}`);
    } catch (e) {
      const message =
        e instanceof IRBlasterError ? `${e.code}: ${e.message}` : String(e);
      setLastResult(`FAILED (${label}): ${message}`);
    } finally {
      setSending(false);
    }
  };

  const togglePower = () =>
    send(
      { power: !acState.power, button: BUTTON_CODES.power },
      acState.power ? 'Power OFF' : 'Power ON',
    );
  const selectMode = (mode: HaierMode) =>
    send({ mode, button: BUTTON_CODES.mode }, `Mode: ${mode}`);
  const selectFan = (fan: HaierFan) =>
    send({ fan, button: BUTTON_CODES.fan }, `Fan: ${fan}`);
  const selectSwingV = (swingV: HaierSwingV) =>
    send({ swingV, button: BUTTON_CODES.swingV }, `Swing V: ${swingV}`);
  const selectSwingH = (swingH: HaierSwingH) =>
    send({ swingH, button: BUTTON_CODES.swingH }, `Swing H: ${swingH}`);
  const selectTurboQuiet = (turboQuiet: HaierTurboQuiet) =>
    send(
      { turboQuiet, button: BUTTON_CODES.turbo },
      `Turbo/Quiet: ${turboQuiet}`,
    );

  const toggleOnTimer = async () => {
    if (onTimerArmed) {
      await send(
        { onTimerMinutes: 0, button: BUTTON_CODES.timer },
        'On timer cancelled',
      );
      await disarmOnTimerMirror();
      setOnTimerArmed(false);
    } else {
      await send(
        { onTimerMinutes: pendingOnMinutes, button: BUTTON_CODES.timer },
        `On timer armed (${formatTimerMinutes(pendingOnMinutes)})`,
      );
      if (pendingOnMinutes > 0) await armOnTimerMirror(pendingOnMinutes);
      setOnTimerArmed(true);
    }
  };

  const toggleOffTimer = async () => {
    if (offTimerArmed) {
      await send(
        { offTimerMinutes: 0, button: BUTTON_CODES.timer },
        'Off timer cancelled',
      );
      await disarmOffTimerMirror();
      setOffTimerArmed(false);
    } else {
      await send(
        { offTimerMinutes: pendingOffMinutes, button: BUTTON_CODES.timer },
        `Off timer armed (${formatTimerMinutes(pendingOffMinutes)})`,
      );
      if (pendingOffMinutes > 0) await armOffTimerMirror(pendingOffMinutes);
      setOffTimerArmed(true);
    }
  };

  const buildAutomationConfig = async (): Promise<AutomationConfig> => ({
    combineMode,
    temperature:
      combineMode === 'temperature' ||
      combineMode === 'and' ||
      combineMode === 'or'
        ? { low: tempLow, high: tempHigh }
        : undefined,
    humidity:
      combineMode === 'humidity' ||
      combineMode === 'and' ||
      combineMode === 'or'
        ? { low: humidityLow, high: humidityHigh }
        : undefined,
    lowAction: { mode: lowActionMode, button: BUTTON_CODES.mode },
    highAction: { mode: highActionMode, button: BUTTON_CODES.mode },
    minTransitionIntervalMs: 3 * 60_000,
  });

  const toggleAutomation = async (enable: boolean) => {
    const config = await buildAutomationConfig();
    await automationController.setConfig(config);
    await automationController.setEnabled(enable);
    setAutomationEnabled(enable);
    setAutomationEvent(enable ? 'Automation enabled.' : 'Automation disabled.');
  };

  const turboQuietEnabled = isTurboQuietAvailable(acState.mode);
  const showTemp =
    combineMode === 'temperature' ||
    combineMode === 'and' ||
    combineMode === 'or';
  const showHumidity =
    combineMode === 'humidity' || combineMode === 'and' || combineMode === 'or';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.header}>
          <Text style={styles.title}>AC Remote</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.closeLink}>Close</Text>
          </Pressable>
        </View>

        {/* Merged status card: scanner sub-row (secondary) + AC hero (primary) */}
        <View style={[styles.card, { borderColor: AC_ACCENT + '33' }]}>
          <View style={styles.scannerRow}>
            <View
              style={[styles.dot, isScanning ? styles.dotOn : styles.dotOff]}
            />
            <Text style={styles.scannerText}>
              {isScanning
                ? `Scanning ${formatHms(
                    elapsedSeconds,
                  )} · auto-stop in ${formatHms(remainingSeconds)}`
                : 'Scanner stopped'}
            </Text>
          </View>
          <Text style={styles.roomText}>
            Room {liveTemp !== undefined ? `${liveTemp}°C` : '—'} ·{' '}
            {liveHumidity !== undefined ? `${liveHumidity}%` : '—'} RH
          </Text>

          <View style={styles.heroDivider} />

          <View style={styles.heroRow}>
            <CircleButton
              glyph="−"
              onPress={() =>
                send(
                  {
                    tempC: Math.max(16, acState.tempC - 1),
                    button: BUTTON_CODES.tempDown,
                  },
                  'Temp down',
                )
              }
              accentColor={AC_ACCENT}
              size={44}
            />
            <View style={styles.heroCenter}>
              <Text style={styles.heroCaption}>SET TEMP</Text>
              <Text style={styles.heroTemp}>{acState.tempC}°</Text>
            </View>
            <CircleButton
              glyph="+"
              onPress={() =>
                send(
                  {
                    tempC: Math.min(30, acState.tempC + 1),
                    button: BUTTON_CODES.tempUp,
                  },
                  'Temp up',
                )
              }
              accentColor={AC_ACCENT}
              size={44}
            />
          </View>

          <View style={styles.heroFooterRow}>
            <Text style={styles.heroSummary}>
              {acState.mode.toUpperCase()} · Fan {acState.fan} · Swing{' '}
              {acState.swingV === 'auto' || acState.swingH === 'auto'
                ? 'Auto'
                : 'Off'}
              {acState.turboQuiet !== 'off' ? ` · ${acState.turboQuiet}` : ''}
            </Text>
            <CircleButton
              icon={<PowerIcon size={17} />}
              onPress={togglePower}
              active={acState.power}
              accentColor={AC_ACCENT}
              size={38}
            />
          </View>
        </View>

        {/* AC controls card — Xiaomi-style segmented controls, distinct blue accent */}
        <View style={[styles.card, { borderColor: AC_ACCENT + '33' }]}>
          <Text style={[styles.cardHeading, { color: AC_ACCENT }]}>
            Controls
          </Text>

          <Text style={styles.controlLabel}>Mode</Text>
          <SegmentedControl
            options={MODE_OPTIONS}
            value={acState.mode as HaierMode}
            onChange={selectMode}
            accentColor={AC_ACCENT}
          />

          <Text style={styles.controlLabel}>Fan Speed</Text>
          <SegmentedControl
            options={FAN_OPTIONS}
            value={acState.fan}
            onChange={selectFan}
            accentColor={AC_ACCENT}
          />

          <View style={styles.splitRow}>
            <View style={styles.splitCol}>
              <Text style={styles.controlLabel}>Swing V</Text>
              <SegmentedControl
                options={SWING_V_OPTIONS}
                value={acState.swingV}
                onChange={selectSwingV}
                accentColor={AC_ACCENT}
              />
            </View>
            <View style={styles.splitCol}>
              <Text style={styles.controlLabel}>Swing H</Text>
              <SegmentedControl
                options={SWING_H_OPTIONS}
                value={acState.swingH}
                onChange={selectSwingH}
                accentColor={AC_ACCENT}
              />
            </View>
          </View>

          <Text style={styles.controlLabel}>
            {turboQuietEnabled
              ? 'Turbo / Quiet'
              : 'Turbo / Quiet (cool mode only)'}
          </Text>
          <SegmentedControl
            options={TURBO_QUIET_OPTIONS}
            value={acState.turboQuiet}
            onChange={selectTurboQuiet}
            accentColor={AC_ACCENT}
            disabled={!turboQuietEnabled}
          />

          <Text style={styles.controlLabel}>On Timer</Text>
          <Stepper
            label=""
            displayValue={
              onTimerArmed
                ? formatTimerMinutes(acState.onTimerMinutes)
                : formatTimerMinutes(pendingOnMinutes)
            }
            onDecrement={() =>
              setPendingOnMinutes(m => stepTimerMinutes(m, -1))
            }
            onIncrement={() => setPendingOnMinutes(m => stepTimerMinutes(m, 1))}
            accentColor={AC_ACCENT}
            disabled={onTimerArmed}
          />
          <View style={styles.confirmRow}>
            <CircleButton
              glyph="✓"
              onPress={toggleOnTimer}
              active={onTimerArmed}
              accentColor={AC_ACCENT}
              size={34}
            />
          </View>

          <Text style={styles.controlLabel}>Off Timer</Text>
          <Stepper
            label=""
            displayValue={
              offTimerArmed
                ? formatTimerMinutes(acState.offTimerMinutes)
                : formatTimerMinutes(pendingOffMinutes)
            }
            onDecrement={() =>
              setPendingOffMinutes(m => stepTimerMinutes(m, -1))
            }
            onIncrement={() =>
              setPendingOffMinutes(m => stepTimerMinutes(m, 1))
            }
            accentColor={AC_ACCENT}
            disabled={offTimerArmed}
          />
          <View style={styles.confirmRow}>
            <CircleButton
              glyph="✓"
              onPress={toggleOffTimer}
              active={offTimerArmed}
              accentColor={AC_ACCENT}
              size={34}
            />
          </View>
        </View>

        {/* Automation card — distinct teal accent, native Switch, compact rows */}
        <View style={[styles.card, { borderColor: AUTO_ACCENT + '33' }]}>
          <View style={styles.automationHeaderRow}>
            <Text
              style={[
                styles.cardHeading,
                { color: AUTO_ACCENT, marginBottom: 0 },
              ]}
            >
              Automation
            </Text>
            <Switch
              value={automationEnabled}
              onValueChange={toggleAutomation}
              trackColor={{ false: '#2a2f38', true: AUTO_ACCENT + '88' }}
              thumbColor={automationEnabled ? AUTO_ACCENT : '#7d8494'}
            />
          </View>

          <Text style={styles.controlLabel}>Trigger Sensor</Text>
          <SegmentedControl
            options={TRIGGER_OPTIONS}
            value={combineMode}
            onChange={setCombineMode}
            accentColor={AUTO_ACCENT}
          />

          {showTemp && (
            <>
              <Stepper
                label="Temp Low"
                displayValue={`${tempLow}°C`}
                onDecrement={() => setTempLow(v => v - 0.5)}
                onIncrement={() => setTempLow(v => v + 0.5)}
                accentColor={AUTO_ACCENT}
              />
              <Stepper
                label="Temp High"
                displayValue={`${tempHigh}°C`}
                onDecrement={() => setTempHigh(v => v - 0.5)}
                onIncrement={() => setTempHigh(v => v + 0.5)}
                accentColor={AUTO_ACCENT}
              />
            </>
          )}
          {showHumidity && (
            <>
              <Stepper
                label="Hum Low"
                displayValue={`${humidityLow}%`}
                onDecrement={() => setHumidityLow(v => v - 1)}
                onIncrement={() => setHumidityLow(v => v + 1)}
                accentColor={AUTO_ACCENT}
              />
              <Stepper
                label="Hum High"
                displayValue={`${humidityHigh}%`}
                onDecrement={() => setHumidityHigh(v => v - 1)}
                onIncrement={() => setHumidityHigh(v => v + 1)}
                accentColor={AUTO_ACCENT}
              />
            </>
          )}

          <Text style={styles.controlLabel}>Below Low → </Text>
          <SegmentedControl
            options={MODE_OPTIONS}
            value={lowActionMode}
            onChange={setLowActionMode}
            accentColor={AUTO_ACCENT}
          />
          <Text style={styles.controlLabel}>Above High → </Text>
          <SegmentedControl
            options={MODE_OPTIONS}
            value={highActionMode}
            onChange={setHighActionMode}
            accentColor={AUTO_ACCENT}
          />

          <View style={styles.heroDivider} />
          <Text style={styles.statusText}>
            {!automationEnabled
              ? 'Automation is off.'
              : cooldownRemainingMs > 0
              ? `Cooling down — next possible change in ${Math.ceil(
                  cooldownRemainingMs / 1000,
                )}s`
              : `Active — zone: ${automationZone}`}
          </Text>
          <Text style={styles.statusTextMuted}>{automationEvent}</Text>
        </View>

        <Text style={styles.resultLabel}>Last transmit result</Text>
        <View style={styles.resultBox}>
          <Text style={styles.resultText}>{lastResult}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0d11', paddingHorizontal: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  title: { color: '#f2f4f7', fontSize: 20, fontWeight: '700' },
  closeLink: { color: '#8ab4ff', fontSize: 14 },

  card: {
    backgroundColor: '#12151a',
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
  },
  cardHeading: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },

  scannerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOn: { backgroundColor: '#4caf6f' },
  dotOff: { backgroundColor: '#4d5361' },
  scannerText: { color: '#8a92a3', fontSize: 12 },
  roomText: { color: '#8a92a3', fontSize: 12, marginLeft: 16 },

  heroDivider: { height: 1, backgroundColor: '#262b33', marginVertical: 14 },

  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  heroCenter: { alignItems: 'center', minWidth: 90 },
  heroCaption: {
    color: '#8a92a3',
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 2,
  },
  heroTemp: {
    color: '#f2f4f7',
    fontSize: 56,
    fontWeight: '700',
    lineHeight: 60,
  },

  heroFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  heroSummary: { color: '#8a92a3', fontSize: 12, flex: 1, marginRight: 10 },

  controlLabel: {
    color: '#8a92a3',
    fontSize: 12,
    marginTop: 10,
    marginBottom: 6,
  },

  segmentTrack: {
    flexDirection: 'row',
    backgroundColor: '#1c212b',
    borderRadius: 12,
    padding: 3,
    gap: 3,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: 'center',
  },
  segmentText: { color: '#8a92a3', fontSize: 13, fontWeight: '600' },
  segmentTextActive: { color: '#ffffff' },
  dimmed: { opacity: 0.4 },

  splitRow: { flexDirection: 'row', gap: 14 },
  splitCol: { flex: 1 },

  circleButton: {
    borderWidth: 1,
    borderColor: '#2a2f38',
    backgroundColor: '#1c212b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleButtonText: { color: '#f2f4f7', fontSize: 16, fontWeight: '700' },

  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  stepperLabel: { color: '#f2f4f7', fontSize: 13 },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperValue: {
    color: '#f2f4f7',
    fontSize: 14,
    fontWeight: '600',
    minWidth: 56,
    textAlign: 'center',
  },

  confirmRow: { alignItems: 'flex-end', marginBottom: 4 },

  automationHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },

  statusText: { color: '#f2f4f7', fontSize: 13, marginBottom: 4 },
  statusTextMuted: { color: '#8a92a3', fontSize: 12 },

  resultLabel: {
    color: '#8a92a3',
    fontSize: 12,
    textTransform: 'uppercase',
    marginTop: 4,
    marginBottom: 6,
  },
  resultBox: {
    backgroundColor: '#12151a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262b33',
    padding: 10,
  },
  resultText: { color: '#7d8494', fontSize: 12, fontFamily: 'monospace' },
});

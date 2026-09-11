import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { scanner } from '../ble/sharedScanner';
import { MAX_SCAN_DURATION_MS } from '../ble/scanner';
import { transmit, IRBlasterError } from '../ir/IRBlaster';
import {
  createDefaultState,
  encodeState,
  stateToCommand,
  nextMode,
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

const FAN_CYCLE: HaierFan[] = ['auto', 'low', 'med', 'high'];
const SWING_V_CYCLE: HaierSwingV[] = [
  'off',
  'top',
  'middle',
  'bottom',
  'down',
  'auto',
];
const SWING_H_CYCLE: HaierSwingH[] = [
  'middle',
  'leftMax',
  'left',
  'right',
  'rightMax',
  'auto',
];
const MODE_PICK_CYCLE: HaierMode[] = ['auto', 'cool', 'dry', 'heat', 'fan'];

function nextInCycle<T>(cycle: T[], current: T): T {
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

function formatHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

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
  const [automationEvent, setAutomationEvent] = useState('Automation is off.');

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadAcState().then(stored => {
      const { lastUpdated, lastSource, ...state } = stored;
      setAcState(state);
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
          `Automation applied: ${JSON.stringify(event.action)} (zone: ${
            event.zone
          }) at ${new Date().toLocaleTimeString()}`,
        );
        // Reflect the automation's own change in this screen's displayed state too.
        loadAcState().then(stored => {
          const { lastUpdated, lastSource, ...state } = stored;
          setAcState(state);
        });
      } else {
        setAutomationEvent(`Automation error: ${event.message}`);
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
    }, 1000);

    return () => {
      unsubUpdate();
      unsubAutomation();
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

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

  const armOnTimer = async () => {
    await send(
      { onTimerMinutes: pendingOnMinutes, button: BUTTON_CODES.timer },
      `On timer -> ${formatTimerMinutes(pendingOnMinutes)}`,
    );
    if (pendingOnMinutes > 0) await armOnTimerMirror(pendingOnMinutes);
    else await disarmOnTimerMirror();
  };

  const armOffTimer = async () => {
    await send(
      { offTimerMinutes: pendingOffMinutes, button: BUTTON_CODES.timer },
      `Off timer -> ${formatTimerMinutes(pendingOffMinutes)}`,
    );
    if (pendingOffMinutes > 0) await armOffTimerMirror(pendingOffMinutes);
    else await disarmOffTimerMirror();
  };

  const saveAutomation = async (enable: boolean) => {
    const config: AutomationConfig = {
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
    };
    await automationController.setConfig(config);
    await automationController.setEnabled(enable);
    setAutomationEnabled(enable);
    setAutomationEvent(enable ? 'Automation enabled.' : 'Automation disabled.');
  };

  const Btn = ({
    label,
    onPress,
    active,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    active?: boolean;
    disabled?: boolean;
  }) => (
    <Pressable
      style={[
        styles.button,
        active && styles.buttonActive,
        (sending || disabled) && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={sending || disabled}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  const turboQuietEnabled = isTurboQuietAvailable(acState.mode);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={styles.header}>
          <Text style={styles.title}>AC Remote (Haier YR-W02)</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.closeLink}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardHeading}>Scanner</Text>
          <Text style={styles.statusText}>
            Status: {isScanning ? 'Running' : 'Stopped'}
          </Text>
          {isScanning && (
            <>
              <Text style={styles.statusText}>
                Elapsed: {formatHms(elapsedSeconds)}
              </Text>
              <Text style={styles.statusText}>
                Auto-stops in: {formatHms(remainingSeconds)} (6h max)
              </Text>
            </>
          )}
          <Text style={styles.statusText}>
            Temp: {liveTemp !== undefined ? `${liveTemp}°C` : '—'} Humidity:{' '}
            {liveHumidity !== undefined ? `${liveHumidity}%` : '—'}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardHeading}>Current AC state</Text>
          <Text style={styles.statusText}>
            Power: {acState.power ? 'ON' : 'OFF'} Mode:{' '}
            {acState.mode.toUpperCase()} Temp: {acState.tempC}°C
          </Text>
          <Text style={styles.statusText}>
            Fan: {acState.fan} Swing V: {acState.swingV} Swing H:{' '}
            {acState.swingH}
          </Text>
          <Text style={styles.statusText}>
            Turbo/Quiet: {acState.turboQuiet}
          </Text>
          <Text style={styles.statusText}>
            On timer: {formatTimerMinutes(acState.onTimerMinutes)} Off timer:{' '}
            {formatTimerMinutes(acState.offTimerMinutes)}
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Power / Mode</Text>
        <View style={styles.row}>
          <Btn
            label="Power ON"
            onPress={() =>
              send({ power: true, button: BUTTON_CODES.power }, 'Power ON')
            }
          />
          <Btn
            label="Power OFF"
            onPress={() =>
              send({ power: false, button: BUTTON_CODES.power }, 'Power OFF')
            }
          />
        </View>
        <View style={styles.row}>
          <Btn
            label={`Mode ▸ (${nextMode(acState.mode)})`}
            onPress={() =>
              send(
                { mode: nextMode(acState.mode), button: BUTTON_CODES.mode },
                'Mode cycle',
              )
            }
          />
        </View>
        <View style={styles.row}>
          <Btn
            label="Cool"
            onPress={() =>
              send({ mode: 'cool', button: BUTTON_CODES.mode }, 'Cool')
            }
          />
          <Btn
            label="Dry"
            onPress={() =>
              send({ mode: 'dry', button: BUTTON_CODES.mode }, 'Dry')
            }
          />
        </View>

        <Text style={styles.sectionLabel}>Temperature</Text>
        <View style={styles.row}>
          <Btn
            label="Temp −"
            onPress={() =>
              send(
                {
                  tempC: Math.max(16, acState.tempC - 1),
                  button: BUTTON_CODES.tempDown,
                },
                'Temp down',
              )
            }
          />
          <Btn
            label="Temp +"
            onPress={() =>
              send(
                {
                  tempC: Math.min(30, acState.tempC + 1),
                  button: BUTTON_CODES.tempUp,
                },
                'Temp up',
              )
            }
          />
        </View>

        <Text style={styles.sectionLabel}>Fan / Swing</Text>
        <View style={styles.row}>
          <Btn
            label={`Fan ▸ (${nextInCycle(FAN_CYCLE, acState.fan)})`}
            onPress={() =>
              send(
                {
                  fan: nextInCycle(FAN_CYCLE, acState.fan),
                  button: BUTTON_CODES.fan,
                },
                'Fan cycle',
              )
            }
          />
        </View>
        <View style={styles.row}>
          <Btn
            label={`Swing V ▸ (${nextInCycle(SWING_V_CYCLE, acState.swingV)})`}
            onPress={() =>
              send(
                {
                  swingV: nextInCycle(SWING_V_CYCLE, acState.swingV),
                  button: BUTTON_CODES.swingV,
                },
                'Swing V cycle',
              )
            }
          />
        </View>
        <View style={styles.row}>
          <Btn
            label={`Swing H ▸ (${nextInCycle(SWING_H_CYCLE, acState.swingH)})`}
            onPress={() =>
              send(
                {
                  swingH: nextInCycle(SWING_H_CYCLE, acState.swingH),
                  button: BUTTON_CODES.swingH,
                },
                'Swing H cycle',
              )
            }
          />
        </View>

        <Text style={styles.sectionLabel}>
          Turbo / Quiet {!turboQuietEnabled && '(cool/heat mode only)'}
        </Text>
        <View style={styles.row}>
          <Btn
            label="Turbo"
            active={acState.turboQuiet === 'turbo'}
            disabled={!turboQuietEnabled}
            onPress={() =>
              send({ turboQuiet: 'turbo', button: BUTTON_CODES.turbo }, 'Turbo')
            }
          />
          <Btn
            label="Quiet"
            active={acState.turboQuiet === 'quiet'}
            disabled={!turboQuietEnabled}
            onPress={() =>
              send({ turboQuiet: 'quiet', button: BUTTON_CODES.turbo }, 'Quiet')
            }
          />
          <Btn
            label="Auto"
            active={acState.turboQuiet === 'off'}
            disabled={!turboQuietEnabled}
            onPress={() =>
              send(
                { turboQuiet: 'off', button: BUTTON_CODES.turbo },
                'Turbo/Quiet off',
              )
            }
          />
        </View>

        <Text style={styles.sectionLabel}>
          Native On/Off Timer (AC's own hardware timer)
        </Text>
        <View style={styles.row}>
          <Text style={styles.timerLabel}>
            On in: {formatTimerMinutes(pendingOnMinutes)}
          </Text>
        </View>
        <View style={styles.row}>
          <Btn
            label="−"
            onPress={() => setPendingOnMinutes(m => stepTimerMinutes(m, -1))}
          />
          <Btn
            label="+"
            onPress={() => setPendingOnMinutes(m => stepTimerMinutes(m, 1))}
          />
          <Btn label="Arm" onPress={armOnTimer} />
        </View>
        <View style={styles.row}>
          <Text style={styles.timerLabel}>
            Off in: {formatTimerMinutes(pendingOffMinutes)}
          </Text>
        </View>
        <View style={styles.row}>
          <Btn
            label="−"
            onPress={() => setPendingOffMinutes(m => stepTimerMinutes(m, -1))}
          />
          <Btn
            label="+"
            onPress={() => setPendingOffMinutes(m => stepTimerMinutes(m, 1))}
          />
          <Btn label="Arm" onPress={armOffTimer} />
        </View>

        <Text style={styles.sectionLabel}>Automation</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Btn
              label={`Trigger on ▸ ${combineMode}`}
              onPress={() =>
                setCombineMode(
                  nextInCycle(
                    ['temperature', 'humidity', 'and', 'or'],
                    combineMode,
                  ),
                )
              }
            />
          </View>

          {(combineMode === 'temperature' ||
            combineMode === 'and' ||
            combineMode === 'or') && (
            <>
              <Text style={styles.timerLabel}>
                Temp low: {tempLow}°C / high: {tempHigh}°C
              </Text>
              <View style={styles.row}>
                <Btn label="Low −" onPress={() => setTempLow(v => v - 0.5)} />
                <Btn label="Low +" onPress={() => setTempLow(v => v + 0.5)} />
                <Btn label="High −" onPress={() => setTempHigh(v => v - 0.5)} />
                <Btn label="High +" onPress={() => setTempHigh(v => v + 0.5)} />
              </View>
            </>
          )}

          {(combineMode === 'humidity' ||
            combineMode === 'and' ||
            combineMode === 'or') && (
            <>
              <Text style={styles.timerLabel}>
                Humidity low: {humidityLow}% / high: {humidityHigh}%
              </Text>
              <View style={styles.row}>
                <Btn label="Low −" onPress={() => setHumidityLow(v => v - 1)} />
                <Btn label="Low +" onPress={() => setHumidityLow(v => v + 1)} />
                <Btn
                  label="High −"
                  onPress={() => setHumidityHigh(v => v - 1)}
                />
                <Btn
                  label="High +"
                  onPress={() => setHumidityHigh(v => v + 1)}
                />
              </View>
            </>
          )}

          <Text style={styles.timerLabel}>
            Low zone action: {lowActionMode} High zone action: {highActionMode}
          </Text>
          <View style={styles.row}>
            <Btn
              label="Low action ▸"
              onPress={() =>
                setLowActionMode(nextInCycle(MODE_PICK_CYCLE, lowActionMode))
              }
            />
            <Btn
              label="High action ▸"
              onPress={() =>
                setHighActionMode(nextInCycle(MODE_PICK_CYCLE, highActionMode))
              }
            />
          </View>

          <View style={styles.row}>
            <Btn
              label={
                automationEnabled
                  ? 'Disable automation'
                  : 'Save & Enable automation'
              }
              onPress={() => saveAutomation(!automationEnabled)}
            />
          </View>
          <Text style={styles.statusText}>Zone: {automationZone}</Text>
          <Text style={styles.statusText}>{automationEvent}</Text>
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
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#262b33',
    padding: 14,
    marginBottom: 14,
  },
  cardHeading: {
    color: '#8a92a3',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  statusText: { color: '#f2f4f7', fontSize: 13, marginBottom: 4 },
  sectionLabel: {
    color: '#8a92a3',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 8,
  },
  timerLabel: { color: '#f2f4f7', fontSize: 13, marginBottom: 6 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  button: {
    flex: 1,
    backgroundColor: '#2a2f38',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonActive: { backgroundColor: '#3d6bff' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 13 },
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

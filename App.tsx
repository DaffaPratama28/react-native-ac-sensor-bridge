import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  startForegroundMonitoring,
  stopForegroundMonitoring,
} from './src/service/foregroundService';
import { appendReading } from './src/storage/readingsStore';
import { LogView } from './src/ui/LogView';
import { ReadingsHistoryModal } from './src/ui/ReadingsHistoryModal';

import { RemoteControlScreen } from './src/ui/RemoteControlScreen';

import { scanner } from './src/ble/sharedScanner';

import { automationController } from './src/automation/automationController';
import { startBackgroundTicker } from './src/automation/backgroundTicker';
import { Zone } from './src/automation/hysteresis';

automationController.loadPersisted().catch(() => {});
startBackgroundTicker();

const MAX_LOG_LINES = 200;

const TEMP_ACCENT = '#ff9d5c';
const HUMIDITY_ACCENT = '#5ac8ff';
const AUTOMATION_ACCENT = '#18c990';

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function zoneLabel(zone: Zone): string {
  if (zone === 'low') return 'Low zone';
  if (zone === 'high') return 'High zone';
  return 'Not yet triggered';
}

function AppContent() {
  const [scanning, setScanning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastTemp, setLastTemp] = useState<number | undefined>(undefined);
  const [lastHumidity, setLastHumidity] = useState<number | undefined>(
    undefined,
  );
  const [logLines, setLogLines] = useState<string[]>([]);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [showRemote, setShowRemote] = useState(false);

  const [automationEnabled, setAutomationEnabled] = useState(
    automationController.isEnabled(),
  );
  const [automationZone, setAutomationZone] = useState<Zone>(
    automationController.getZone(),
  );

  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const scanStartRef = useRef<number>(0);

  const pushLog = (line: string) => {
    setLogLines(prev => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES
        ? next.slice(next.length - MAX_LOG_LINES)
        : next;
    });
  };

  useEffect(() => {
    const unsubUpdate = scanner.onUpdate(u => {
      setLastTemp(u.reading.temperatureC);
      setLastHumidity(u.reading.humidityPercent);
      setAutomationZone(automationController.getZone());

      pushLog(
        `${new Date(u.timestamp).toLocaleTimeString()} temp=${
          u.reading.temperatureC ?? '-'
        } ` +
          `hum=${u.reading.humidityPercent ?? '-'} batt=${
            u.reading.batteryPercent ?? '-'
          }`,
      );

      // Store the RAW per-cycle reading (not the merged one) so history
      // honestly reflects what this specific advertisement broadcast —
      // see readingsStore.ts / scanner.ts SensorUpdate doc comments.
      appendReading({
        timestamp: u.timestamp,
        mac: u.mac,
        reading: u.rawReading,
      }).catch(e => pushLog(`Couldn't save reading: ${e.message}`));
    });

    const unsubError = scanner.onError(e => {
      pushLog(`Sensor error: ${e.message}`);
    });

    const unsubAutomation = automationController.onEvent(event => {
      if (event.type === 'applied') {
        setAutomationZone(event.zone);
        pushLog(`Automation applied ${event.zone} zone settings.`);
      } else if (event.type === 'error') {
        pushLog(`Automation error: ${event.message}`);
      }
    });

    return () => {
      unsubUpdate();
      unsubError();
      unsubAutomation();
      scanner.stop(); // stop(), not destroy() — see earlier note on why destroy() is reserved for true app shutdown.
    };
  }, []);

  const handleToggleScan = async () => {
    if (scanning) {
      await scanner.stop();
      await stopForegroundMonitoring(); // Also removes the persistent notification — see MijiaForegroundService.onDestroy().

      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }

      setScanning(false);
      pushLog('Monitoring stopped.');
      return;
    }

    const granted = await scanner.requestPermissions();
    if (!granted) {
      pushLog("Couldn't start — Bluetooth permission not granted.");
      return;
    }

    await scanner.start();
    await startForegroundMonitoring();

    scanStartRef.current = Date.now();
    setElapsedSeconds(0);
    elapsedIntervalRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - scanStartRef.current) / 1000));
    }, 1000);

    setScanning(true);
    setAutomationEnabled(automationController.isEnabled());
    pushLog('Monitoring started.');
  };

  if (showRemote) {
    return (
      <RemoteControlScreen
        onClose={() => {
          setShowRemote(false);
          setAutomationEnabled(automationController.isEnabled());
          setAutomationZone(automationController.getZone());
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>IR Home Bridge</Text>
          <View style={styles.subtitleRow}>
            <View
              style={[
                styles.statusDot,
                scanning ? styles.statusDotOn : styles.statusDotOff,
              ]}
            />
            <Text style={styles.subtitle}>
              {scanning ? 'Monitoring' : 'Idle'}
              {automationEnabled
                ? ` · Automation on · ${zoneLabel(automationZone)}`
                : ''}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.readingCard}>
        <View style={styles.readingItem}>
          <Text style={styles.readingLabel}>Temperature</Text>
          <Text style={[styles.readingValue, { color: TEMP_ACCENT }]}>
            {lastTemp !== undefined ? `${lastTemp}°` : '—'}
          </Text>
        </View>
        <View style={styles.readingDivider} />
        <View style={styles.readingItem}>
          <Text style={styles.readingLabel}>Humidity</Text>
          <Text style={[styles.readingValue, { color: HUMIDITY_ACCENT }]}>
            {lastHumidity !== undefined ? `${lastHumidity}%` : '—'}
          </Text>
        </View>
      </View>

      <Pressable
        style={[
          styles.scanToggle,
          scanning ? styles.scanToggleActive : styles.scanToggleIdle,
        ]}
        onPress={handleToggleScan}
      >
        <Text style={styles.scanToggleText}>
          {scanning ? 'Stop monitoring' : 'Start monitoring'}
        </Text>
        {scanning && (
          <Text style={styles.scanToggleSubtext}>
            {formatElapsed(elapsedSeconds)}
          </Text>
        )}
      </Pressable>

      <View style={styles.actionRow}>
        <Pressable
          style={styles.actionChip}
          onPress={() => setHistoryVisible(true)}
        >
          <Text style={styles.actionChipText}>Readings history</Text>
        </Pressable>
        <Pressable
          style={styles.actionChip}
          onPress={() => setShowRemote(true)}
        >
          <Text style={styles.actionChipText}>AC remote</Text>
        </Pressable>
      </View>

      <Text style={styles.feedHeading}>Sensor feed</Text>
      <LogView lines={logLines} />

      <ReadingsHistoryModal
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      {/* Explicit, non-translucent StatusBar config — the earlier "system
          UI bar" overlap was RN's default SafeAreaView (iOS-oriented, a
          no-op on Android) not accounting for the status bar / cutouts.
          react-native-safe-area-context's SafeAreaView (used above) reads
          real device insets; this StatusBar config keeps its own
          background solid and non-translucent so it doesn't ambiguously
          overlay content underneath it. */}
      <StatusBar
        backgroundColor="#0b0d11"
        barStyle="light-content"
        translucent={false}
      />
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0d11',
    paddingHorizontal: 20,
  },
  header: {
    marginTop: 8,
    marginBottom: 20,
  },
  title: {
    color: '#f2f4f7',
    fontSize: 24,
    fontWeight: '700',
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusDotOn: {
    backgroundColor: AUTOMATION_ACCENT,
  },
  statusDotOff: {
    backgroundColor: '#4d5361',
  },
  subtitle: {
    color: '#8a92a3',
    fontSize: 13,
  },
  readingCard: {
    flexDirection: 'row',
    backgroundColor: '#12151a',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#262b33',
    paddingVertical: 22,
    marginBottom: 16,
  },
  readingItem: {
    flex: 1,
    alignItems: 'center',
  },
  readingDivider: {
    width: 1,
    backgroundColor: '#262b33',
  },
  readingLabel: {
    color: '#8a92a3',
    fontSize: 13,
    marginBottom: 8,
  },
  readingValue: {
    fontSize: 34,
    fontWeight: '700',
  },
  scanToggle: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  scanToggleIdle: {
    backgroundColor: '#3d6bff',
  },
  scanToggleActive: {
    backgroundColor: '#1c2129',
    borderWidth: 1,
    borderColor: '#333a46',
  },
  scanToggleText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
  },
  scanToggleSubtext: {
    color: '#8a92a3',
    fontSize: 12,
    marginTop: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 24,
  },
  actionChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#12151a',
    borderWidth: 1,
    borderColor: '#262b33',
  },
  actionChipText: {
    color: '#c7cdd8',
    fontSize: 13,
    fontWeight: '500',
  },
  feedHeading: {
    color: '#8a92a3',
    fontSize: 13,
    marginBottom: 8,
  },
});

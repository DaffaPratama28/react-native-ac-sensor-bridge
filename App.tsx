import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { MijiaScanner } from './src/ble/scanner';
import {
  startForegroundMonitoring,
  stopForegroundMonitoring,
} from './src/service/foregroundService';
import { appendReading } from './src/storage/readingsStore';
import { LogView } from './src/ui/LogView';
import { ReadingsHistoryModal } from './src/ui/ReadingsHistoryModal';

const scanner = new MijiaScanner();
const MAX_LOG_LINES = 200;

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
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
      }).catch(e => pushLog(`ERROR: failed to store reading: ${e.message}`));
    });

    const unsubError = scanner.onError(e => {
      pushLog(`ERROR: ${e.message}`);
    });

    return () => {
      unsubUpdate();
      unsubError();
      scanner.stop(); // stop(), not destroy() — see earlier note on why destroy() is reserved for true app shutdown.
    };
  }, []);

  const handleStart = async () => {
    const granted = await scanner.requestPermissions();
    if (!granted) {
      pushLog('ERROR: BLE permissions not granted');
      return;
    }

    scanner.start();
    await startForegroundMonitoring();

    scanStartRef.current = Date.now();
    setElapsedSeconds(0);
    elapsedIntervalRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - scanStartRef.current) / 1000));
    }, 1000);

    setScanning(true);
    pushLog('Scan started.');
  };

  const handleStop = async () => {
    scanner.stop();
    await stopForegroundMonitoring(); // Also removes the persistent notification — see MijiaForegroundService.onDestroy().

    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }

    setScanning(false);
    pushLog('Scan stopped.');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>IR Home Bridge</Text>
        <View
          style={[
            styles.statusDot,
            scanning ? styles.statusDotOn : styles.statusDotOff,
          ]}
        />
      </View>

      <View style={styles.readingCard}>
        <View style={styles.readingItem}>
          <Text style={styles.readingLabel}>Temperature</Text>
          <Text style={styles.readingValue}>
            {lastTemp !== undefined ? `${lastTemp}°C` : '—'}
          </Text>
        </View>
        <View style={styles.readingDivider} />
        <View style={styles.readingItem}>
          <Text style={styles.readingLabel}>Humidity</Text>
          <Text style={styles.readingValue}>
            {lastHumidity !== undefined ? `${lastHumidity}%` : '—'}
          </Text>
        </View>
      </View>

      {scanning && (
        <Text style={styles.elapsed}>
          Running for {formatElapsed(elapsedSeconds)}
        </Text>
      )}

      <View style={styles.buttonRow}>
        <Pressable
          style={[
            styles.button,
            styles.buttonPrimary,
            scanning && styles.buttonDisabled,
          ]}
          onPress={handleStart}
          disabled={scanning}
        >
          <Text style={styles.buttonText}>Start Scan</Text>
        </Pressable>
        <Pressable
          style={[
            styles.button,
            styles.buttonSecondary,
            !scanning && styles.buttonDisabled,
          ]}
          onPress={handleStop}
          disabled={!scanning}
        >
          <Text style={styles.buttonText}>Stop Scan</Text>
        </Pressable>
      </View>

      <Pressable
        style={styles.historyLink}
        onPress={() => setHistoryVisible(true)}
      >
        <Text style={styles.historyLinkText}>View stored readings history</Text>
      </Pressable>

      <Text style={styles.logHeading}>Debug log</Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  title: {
    color: '#f2f4f7',
    fontSize: 22,
    fontWeight: '700',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: 10,
  },
  statusDotOn: {
    backgroundColor: '#4caf6f',
  },
  statusDotOff: {
    backgroundColor: '#4d5361',
  },
  readingCard: {
    flexDirection: 'row',
    backgroundColor: '#12151a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#262b33',
    paddingVertical: 18,
    marginBottom: 10,
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
    fontSize: 12,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  readingValue: {
    color: '#f2f4f7',
    fontSize: 28,
    fontWeight: '700',
  },
  elapsed: {
    color: '#7d8494',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#3d6bff',
  },
  buttonSecondary: {
    backgroundColor: '#2a2f38',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  historyLink: {
    marginBottom: 16,
  },
  historyLinkText: {
    color: '#8ab4ff',
    fontSize: 13,
    textAlign: 'center',
  },
  logHeading: {
    color: '#8a92a3',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
});

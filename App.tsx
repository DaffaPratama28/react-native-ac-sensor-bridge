import React, { useEffect, useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { MijiaScanner } from './src/ble/scanner';

const scanner = new MijiaScanner();

function AppContent() {
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    scanner.onUpdate(u =>
      setLog(prev =>
        [
          `${new Date(u.timestamp).toLocaleTimeString()} ${
            u.reading.temperatureC
          }°C ${u.reading.humidityPercent}%`,
          ...prev,
        ].slice(0, 20),
      ),
    );
    scanner.onError(e =>
      setLog(prev => [`ERROR: ${e.message}`, ...prev].slice(0, 20)),
    );
    return () => scanner.stop();
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Button
        title="Start Scan"
        onPress={async () => {
          const granted = await scanner.requestPermissions();
          console.log('Permissions granted:', granted);
          setLog(prev => [`Permissions granted: ${granted}`, ...prev]);

          const state = await scanner.getBluetoothState(); // see note below
          console.log('Bluetooth state:', state);
          setLog(prev => [`Bluetooth state: ${state}`, ...prev]);

          if (granted) scanner.start();
        }}
      />
      <Button title="Stop Scan" onPress={() => scanner.stop()} />
      <View style={styles.logBox}>
        {log.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  logBox: { marginTop: 12 },
});

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';

import { transmit, IRBlasterError } from '../ir/IRBlaster';
import {
  createDefaultState,
  encodeState,
  stateToCommand,
  nextMode,
  HaierYrw02State,
} from '../ir/protocols/acProtocol';

interface Props {
  onClose: () => void;
}

export function RemoteControlScreen({ onClose }: Props) {
  const [state, setState] = useState<HaierYrw02State>(createDefaultState());
  const [lastResult, setLastResult] = useState<string>('No command sent yet.');
  const [sending, setSending] = useState(false);

  const send = async (next: HaierYrw02State, label: string) => {
    setState(next);
    setSending(true);
    try {
      const { frequency, pattern } = stateToCommand(next);
      await transmit(frequency, pattern);
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

  const Btn = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <Pressable
      style={[styles.button, sending && styles.buttonDisabled]}
      onPress={onPress}
      disabled={sending}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>AC Remote Test (Haier YR-W02)</Text>
        <Pressable onPress={onClose}>
          <Text style={styles.closeLink}>Close</Text>
        </Pressable>
      </View>

      <View style={styles.statusCard}>
        <Text style={styles.statusText}>
          Power: {state.power ? 'ON' : 'OFF'}
        </Text>
        <Text style={styles.statusText}>Mode: {state.mode.toUpperCase()}</Text>
        <Text style={styles.statusText}>Temp: {state.tempC}°C</Text>
      </View>

      <View style={styles.row}>
        <Btn
          label="Power ON"
          onPress={() => send({ ...state, power: true }, 'Power ON')}
        />
        <Btn
          label="Power OFF"
          onPress={() => send({ ...state, power: false }, 'Power OFF')}
        />
      </View>

      <View style={styles.row}>
        <Btn
          label={`Mode ▸ (${nextMode(state.mode)})`}
          onPress={() =>
            send({ ...state, mode: nextMode(state.mode) }, 'Mode cycle')
          }
        />
      </View>
      <View style={styles.row}>
        <Btn
          label="Cool"
          onPress={() => send({ ...state, mode: 'cool' }, 'Cool')}
        />
        <Btn
          label="Dry"
          onPress={() => send({ ...state, mode: 'dry' }, 'Dry')}
        />
      </View>

      <View style={styles.row}>
        <Btn
          label="Temp −"
          onPress={() =>
            send(
              { ...state, tempC: Math.max(16, state.tempC - 1) },
              'Temp down',
            )
          }
        />
        <Btn
          label="Temp +"
          onPress={() =>
            send({ ...state, tempC: Math.min(30, state.tempC + 1) }, 'Temp up')
          }
        />
      </View>

      <Text style={styles.resultLabel}>Last transmit result</Text>
      <ScrollView style={styles.resultBox}>
        <Text style={styles.resultText}>{lastResult}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0d11',
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: { color: '#f2f4f7', fontSize: 18, fontWeight: '700' },
  closeLink: { color: '#8ab4ff', fontSize: 14 },
  statusCard: {
    backgroundColor: '#12151a',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#262b33',
    padding: 14,
    marginBottom: 16,
  },
  statusText: { color: '#f2f4f7', fontSize: 14, marginBottom: 4 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  button: {
    flex: 1,
    backgroundColor: '#2a2f38',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
  resultLabel: {
    color: '#8a92a3',
    fontSize: 12,
    textTransform: 'uppercase',
    marginTop: 10,
    marginBottom: 6,
  },
  resultBox: {
    backgroundColor: '#12151a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262b33',
    padding: 10,
    maxHeight: 100,
  },
  resultText: { color: '#7d8494', fontSize: 12, fontFamily: 'monospace' },
});

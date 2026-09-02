import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getAllReadings,
  clearAllReadings,
  StoredReading,
  StoredValue,
} from '../storage/readingsStore';

interface ReadingsHistoryModalProps {
  visible: boolean;
  onClose: () => void;
}

function formatValue(value: StoredValue, unit: string): string {
  return value === 'EMPTY' ? 'EMPTY' : `${value}${unit}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/**
 * Answers "where is the stored data and how do I check it" — pulls
 * directly from readingsStore.ts (AsyncStorage) rather than duplicating
 * that state anywhere else, so it always reflects what's actually
 * persisted, independent of the live debug log.
 */
export function ReadingsHistoryModal({ visible, onClose }: ReadingsHistoryModalProps) {
  const [readings, setReadings] = useState<StoredReading[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllReadings();
      // Newest first for browsing.
      setReadings([...all].reverse());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      load();
    }
  }, [visible, load]);

  const handleClear = () => {
    Alert.alert(
      'Clear stored data?',
      `This will permanently delete all ${readings.length} stored readings. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearAllReadings();
            await load();
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>Stored Readings</Text>
          <Text style={styles.subtitle}>{readings.length} entries</Text>
        </View>

        <View style={styles.actions}>
          <Pressable style={styles.button} onPress={load}>
            <Text style={styles.buttonText}>Refresh</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonDanger]}
            onPress={handleClear}
            disabled={readings.length === 0}
          >
            <Text style={styles.buttonText}>Clear All</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonClose]} onPress={onClose}>
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator style={styles.loading} color="#8ab4ff" />
        ) : (
          <FlatList
            data={readings}
            keyExtractor={(item, i) => `${item.timestamp}-${i}`}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.rowTimestamp}>{formatTimestamp(item.timestamp)}</Text>
                <View style={styles.rowValues}>
                  <Text style={[styles.rowValue, item.temperatureC === 'EMPTY' && styles.rowValueEmpty]}>
                    {formatValue(item.temperatureC, '°C')}
                  </Text>
                  <Text style={[styles.rowValue, item.humidityPercent === 'EMPTY' && styles.rowValueEmpty]}>
                    {formatValue(item.humidityPercent, '%')}
                  </Text>
                  <Text style={[styles.rowValue, item.batteryPercent === 'EMPTY' && styles.rowValueEmpty]}>
                    batt {formatValue(item.batteryPercent, '%')}
                  </Text>
                </View>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.empty}>No readings stored yet.</Text>}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0d11',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  title: {
    color: '#f2f4f7',
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: '#8a92a3',
    fontSize: 13,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: '#1c2129',
  },
  buttonDanger: {
    backgroundColor: '#3a1c1c',
  },
  buttonClose: {
    marginLeft: 'auto',
    backgroundColor: '#20242c',
  },
  buttonText: {
    color: '#e7eaf0',
    fontSize: 13,
    fontWeight: '600',
  },
  loading: {
    marginTop: 40,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomColor: '#1c2029',
    paddingVertical: 10,
  },
  rowTimestamp: {
    color: '#7d8494',
    fontSize: 12,
    marginBottom: 4,
  },
  rowValues: {
    flexDirection: 'row',
    gap: 16,
  },
  rowValue: {
    color: '#e7eaf0',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  rowValueEmpty: {
    color: '#4d5361',
  },
  empty: {
    color: '#5b6270',
    textAlign: 'center',
    marginTop: 40,
    fontStyle: 'italic',
  },
});

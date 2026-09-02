import React, { useRef } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

interface LogViewProps {
  lines: string[];
  maxHeight?: number;
}

/**
 * Replaces the original "stack of <Text> elements" debug output with a
 * proper scrollable panel: dark card, monospace font, auto-scrolls to
 * the newest line, and visually flags error lines. Purely a display
 * component — doesn't own log state, pass lines in newest-last order.
 */
export function LogView({ lines, maxHeight = 260 }: LogViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  return (
    <View style={[styles.container, { maxHeight }]}>
      <ScrollView
        ref={scrollRef}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={styles.content}
      >
        {lines.length === 0 ? (
          <Text style={styles.placeholder}>No log entries yet.</Text>
        ) : (
          lines.map((line, i) => (
            <Text
              key={i}
              style={[styles.line, line.startsWith('ERROR') && styles.lineError]}
              numberOfLines={4}
            >
              {line}
            </Text>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#12151a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262b33',
    overflow: 'hidden',
  },
  content: {
    padding: 10,
  },
  placeholder: {
    color: '#5b6270',
    fontStyle: 'italic',
    fontSize: 13,
  },
  line: {
    color: '#d7dce3',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 2,
  },
  lineError: {
    color: '#ff6b6b',
  },
});

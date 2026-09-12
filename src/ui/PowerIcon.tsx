import React from 'react';
import { View, StyleSheet } from 'react-native';

interface Props {
  color?: string;
  size?: number;
}

/**
 * Vector-style power symbol drawn with Views only (ring with a gap at
 * the top + vertical bar). The "⏻" text glyph is missing from Android's
 * default Roboto font, so it renders as tofu — this has zero font
 * dependency and always renders.
 */
export function PowerIcon({ color = '#f2f4f7', size = 18 }: Props) {
  const ringSize = size;
  const stroke = Math.max(2, Math.round(size * 0.16));
  const barWidth = Math.max(2, Math.round(size * 0.14));
  const barHeight = Math.round(size * 0.52);

  return (
    <View
      style={[styles.container, { width: ringSize, height: ringSize }]}
      accessibilityLabel="Power"
    >
      <View
        style={[
          styles.ring,
          {
            width: ringSize,
            height: ringSize,
            borderRadius: ringSize / 2,
            borderWidth: stroke,
            borderColor: color,
          },
        ]}
      />
      <View
        style={[
          styles.bar,
          {
            backgroundColor: color,
            width: barWidth,
            height: barHeight,
            borderRadius: barWidth / 2,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    borderTopColor: 'transparent',
  },
  bar: {
    position: 'absolute',
    top: -1,
  },
});

export default PowerIcon;

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font, radius, spacing } from '../theme';
import { surfaceColors, surfaceLabel } from '../theme';
import type { Surface } from '../types';

export function SurfaceBadge({ surface, small }: { surface: Surface; small?: boolean }) {
  const color = surfaceColors[surface];
  return (
    <View style={[styles.wrap, { backgroundColor: `${color}22`, borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color, fontSize: small ? font.tiny : font.small }]}>
        {surfaceLabel[surface]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontWeight: '700' },
});

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, fonts, radius, spacing } from '../theme';

export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <View style={styles.row}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.controls}>
        <Pressable
          onPress={() => set(value - step)}
          style={styles.btn}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={label ? `Decrease ${label}` : 'Decrease'}
        >
          <Text style={styles.btnText}>−</Text>
        </Pressable>
        <Text style={styles.value} accessibilityLabel={label ? `${label}: ${value}` : String(value)}>
          {value}
        </Text>
        <Pressable
          onPress={() => set(value + step)}
          style={styles.btn}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={label ? `Increase ${label}` : 'Increase'}
        >
          <Text style={styles.btnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  label: { color: colors.textDim, fontSize: font.small, flexShrink: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  btn: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnText: { color: colors.primary, fontSize: 20, fontFamily: fonts.display, lineHeight: 22 },
  value: { color: colors.text, fontSize: font.h3, fontFamily: fonts.heading, minWidth: 28, textAlign: 'center' },
});

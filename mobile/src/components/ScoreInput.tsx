import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../theme';
import type { ScoreArray, SetScore } from '../types';

/**
 * Editable tennis scoreline. Each set has a "you" and "opponent" game count
 * with steppers; sets can be added (up to 5) or removed (min 1).
 */
export function ScoreInput({ value, onChange }: { value: ScoreArray; onChange: (v: ScoreArray) => void }) {
  const updateSet = (idx: number, side: 0 | 1, delta: number) => {
    const next = value.map((s, i) => {
      if (i !== idx) return s;
      const pair: SetScore = [s[0], s[1]];
      pair[side] = Math.max(0, Math.min(20, pair[side] + delta));
      return pair;
    });
    onChange(next);
  };

  const addSet = () => {
    if (value.length >= 5) return;
    onChange([...value, [0, 0]]);
  };
  const removeSet = (idx: number) => {
    if (value.length <= 1) return;
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.legend}>
        <Text style={styles.legendText}>Set</Text>
        <View style={styles.legendSides}>
          <Text style={styles.legendText}>You</Text>
          <Text style={styles.legendText}>Opp</Text>
        </View>
      </View>

      {value.map((set, idx) => (
        <View key={idx} style={styles.setRow}>
          <Text style={styles.setIndex}>{idx + 1}</Text>
          <View style={styles.sides}>
            <Counter value={set[0]} onMinus={() => updateSet(idx, 0, -1)} onPlus={() => updateSet(idx, 0, 1)} win={set[0] > set[1]} />
            <Text style={styles.dash}>–</Text>
            <Counter value={set[1]} onMinus={() => updateSet(idx, 1, -1)} onPlus={() => updateSet(idx, 1, 1)} win={set[1] > set[0]} />
          </View>
          <Pressable onPress={() => removeSet(idx)} disabled={value.length <= 1} hitSlop={6}>
            <Text style={[styles.remove, value.length <= 1 && { opacity: 0.25 }]}>✕</Text>
          </Pressable>
        </View>
      ))}

      {value.length < 5 ? (
        <Pressable onPress={addSet} style={styles.addBtn}>
          <Text style={styles.addText}>+ Add set</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Counter({
  value,
  onMinus,
  onPlus,
  win,
}: {
  value: number;
  onMinus: () => void;
  onPlus: () => void;
  win: boolean;
}) {
  return (
    <View style={styles.counter}>
      <Pressable onPress={onMinus} style={styles.counterBtn} hitSlop={4}>
        <Text style={styles.counterBtnText}>−</Text>
      </Pressable>
      <Text style={[styles.counterValue, win && { color: colors.primary }]}>{value}</Text>
      <Pressable onPress={onPlus} style={styles.counterBtn} hitSlop={4}>
        <Text style={styles.counterBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.sm },
  legendSides: { flexDirection: 'row', gap: spacing.xl, marginRight: 40 },
  legendText: { color: colors.textFaint, fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  setIndex: { color: colors.textDim, fontWeight: '800', width: 20, textAlign: 'center' },
  sides: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dash: { color: colors.textFaint, fontSize: font.h3 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  counterBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counterBtnText: { color: colors.primary, fontSize: 18, fontWeight: '800' },
  counterValue: { color: colors.text, fontSize: font.h3, fontWeight: '800', minWidth: 24, textAlign: 'center' },
  remove: { color: colors.loss, fontSize: font.body, fontWeight: '800', paddingHorizontal: spacing.xs },
  addBtn: { alignItems: 'center', paddingVertical: spacing.sm },
  addText: { color: colors.primary, fontWeight: '700' },
});

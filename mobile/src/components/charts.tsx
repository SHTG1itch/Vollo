import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, fonts, radius, spacing } from '../theme';

/** A single horizontal progress bar with a label and value. */
export function ProgressBar({
  label,
  pct,
  caption,
  color = colors.primary,
}: {
  label: string;
  pct: number;
  caption?: string;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.caption}>{caption ?? `${clamped.toFixed(0)}%`}</Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${clamped}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

/** A winners-vs-errors split bar for a stroke type. */
export function SplitBar({
  label,
  positive,
  negative,
}: {
  label: string;
  positive: number;
  negative: number;
}) {
  const total = positive + negative || 1;
  const posPct = (positive / total) * 100;
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.caption}>
          <Text style={{ color: colors.win }}>{positive}W</Text>
          {' · '}
          <Text style={{ color: colors.loss }}>{negative}E</Text>
        </Text>
      </View>
      <View style={[styles.track, { flexDirection: 'row' }]}>
        <View style={{ width: `${posPct}%`, backgroundColor: colors.win }} />
        <View style={{ width: `${100 - posPct}%`, backgroundColor: colors.loss }} />
      </View>
    </View>
  );
}

/** Recent form as a row of W/L dots. */
export function FormDots({ form }: { form: ('W' | 'L')[] }) {
  if (form.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {form.map((r, i) => (
        <View
          key={i}
          style={[styles.formDot, { backgroundColor: r === 'W' ? colors.win : colors.loss }]}
        >
          <Text style={styles.formDotText}>{r}</Text>
        </View>
      ))}
    </View>
  );
}

/** Rally length distribution (short / medium / long). */
export function RallyDistribution({
  short,
  medium,
  long,
}: {
  short: number;
  medium: number;
  long: number;
}) {
  const total = short + medium + long || 1;
  // Skip an empty bucket entirely (label included) so we never show a lone label
  // hanging under no bar.
  const seg = (n: number, color: string, label: string, textColor: string) =>
    n > 0 ? (
      <View style={{ flex: n / total, minWidth: 28 }}>
        <View style={[styles.rallySeg, { backgroundColor: color }]}>
          <Text style={[styles.rallySegText, { color: textColor }]}>{Math.round((n / total) * 100)}%</Text>
        </View>
        <Text style={styles.rallyLabel}>{label}</Text>
      </View>
    ) : null;
  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {seg(short, colors.primary, 'Short 1-4', colors.onPrimary)}
        {seg(medium, colors.accent, 'Med 5-8', colors.onAccent)}
        {seg(long, colors.warning, 'Long 9+', colors.onAccent)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold },
  caption: { color: colors.text, fontSize: font.small, fontFamily: fonts.bold },
  track: { height: 9, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
  formDot: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  formDotText: { color: colors.white, fontFamily: fonts.bold, fontSize: font.tiny },
  rallySeg: {
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  rallySegText: { fontFamily: fonts.bold, fontSize: font.tiny },
  rallyLabel: { color: colors.textFaint, fontSize: font.tiny, textAlign: 'center' },
});

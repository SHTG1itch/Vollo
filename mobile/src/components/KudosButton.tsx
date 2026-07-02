import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from 'react-native-reanimated';
import { colors, font, fonts, radius, spacing } from '../theme';
import { formatCount } from '../utils/format';

/**
 * The tennis-ball "Kudos" button. A tap fires the bounce animation immediately
 * — the optimistic count update is driven by the feed store, so the UI never
 * waits on the network.
 */
export function KudosButton({
  active,
  count,
  onPress,
}: {
  active: boolean;
  count: number;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handle = () => {
    scale.value = withSequence(withSpring(1.5, { damping: 4, stiffness: 220 }), withSpring(1));
    onPress();
  };

  return (
    <Pressable onPress={handle} style={[styles.btn, active && styles.btnActive]} hitSlop={8}>
      <Animated.Text style={[styles.ball, animStyle, !active && styles.ballInactive]}>🎾</Animated.Text>
      <Text style={[styles.count, active && styles.countActive]}>{formatCount(count)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  btnActive: { backgroundColor: colors.primarySoft },
  ball: { fontSize: 18 },
  ballInactive: { opacity: 0.55 },
  count: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
  countActive: { color: colors.primary },
});

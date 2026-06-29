// Shimmer skeleton placeholders (echoes 21st.dev "Skeleton" / "Shine Border").
// A soft highlight band sweeps left→right across grey blocks while real content
// loads, so the feed has shape before data arrives. Built on reanimated +
// plain Views (no expo-linear-gradient needed).
import React, { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, radius, spacing } from '../theme';

export function SkeletonBlock({ style }: { style?: ViewStyle }) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    x.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
  }, [x, reduced]);

  const band = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(x.value, [0, 1], [-width, width]) }],
  }));

  return (
    <View style={[styles.block, style]}>
      <Animated.View style={[styles.band, band]} />
    </View>
  );
}

/** A skeleton matching the MatchCard silhouette (avatar + author, score, meta). */
export function MatchCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <SkeletonBlock style={{ width: 38, height: 38, borderRadius: 19 }} />
        <View style={{ gap: 6 }}>
          <SkeletonBlock style={{ width: 130, height: 13 }} />
          <SkeletonBlock style={{ width: 90, height: 10 }} />
        </View>
      </View>
      <SkeletonBlock style={{ width: '55%', height: 18, marginTop: spacing.sm }} />
      <SkeletonBlock style={{ width: '40%', height: 12 }} />
      <View style={[styles.row, { marginTop: spacing.sm }]}>
        <SkeletonBlock style={{ width: 60, height: 12 }} />
        <SkeletonBlock style={{ width: 70, height: 12 }} />
      </View>
    </View>
  );
}

/** A stack of feed skeletons for the first-load state. */
export function FeedSkeleton({ count = 4 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }, (_, i) => (
        <MatchCardSkeleton key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, overflow: 'hidden' },
  band: { position: 'absolute', top: 0, bottom: 0, width: 110, backgroundColor: 'rgba(255,255,255,0.55)' },
  list: { padding: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Card, EmptyState, ErrorState, Loading, SectionHeader, Stat } from '../components/ui';
import { CountUp } from '../components/CountUp';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { YearInReview } from '../types';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
// Vollo launched in 2024 — no recap exists for earlier years.
const MIN_YEAR = 2024;

export function YearInReviewScreen({
  route,
}: NativeStackScreenProps<RootStackParamList, 'YearInReview'>) {
  const { username } = route.params;
  const thisYear = useMemo(() => new Date().getFullYear(), []);
  const [year, setYear] = useState(route.params.year ?? thisYear);
  const [review, setReview] = useState<YearInReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Adjust state during render when the fetch key changes, so the fetch effect
  // below never calls setState synchronously. Only a year/user change clears
  // the recap — a pull-to-refresh keeps it on screen while it reloads.
  const [prevFetch, setPrevFetch] = useState({ username, year, reloadKey });
  if (prevFetch.username !== username || prevFetch.year !== year || prevFetch.reloadKey !== reloadKey) {
    const yearChanged = prevFetch.username !== username || prevFetch.year !== year;
    setPrevFetch({ username, year, reloadKey });
    setError(null);
    if (yearChanged) setReview(null);
  }

  useEffect(() => {
    let active = true;
    void api
      .getYearInReview(username, year)
      .then((r) => active && setReview(r.review))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : 'Failed to load the recap'))
      .finally(() => active && setRefreshing(false));
    return () => {
      active = false;
    };
  }, [username, year, reloadKey]);

  const onRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  const shiftYear = (delta: number) => {
    tapLight();
    setYear((y) => Math.max(MIN_YEAR, Math.min(thisYear, y + delta)));
  };

  if (error) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;

  const atMinYear = year <= MIN_YEAR;
  const header = (
    <View style={styles.yearRow}>
      <Pressable
        onPress={() => shiftYear(-1)}
        hitSlop={10}
        disabled={atMinYear}
        accessibilityRole="button"
        accessibilityLabel="Previous year"
      >
        <Text style={[styles.chev, atMinYear && { opacity: 0.25 }]}>‹</Text>
      </Pressable>
      <Text style={styles.yearTitle}>{year} on the court</Text>
      <Pressable
        onPress={() => shiftYear(1)}
        hitSlop={10}
        disabled={year >= thisYear}
        accessibilityRole="button"
        accessibilityLabel="Next year"
      >
        <Text style={[styles.chev, year >= thisYear && { opacity: 0.25 }]}>›</Text>
      </Pressable>
    </View>
  );

  if (!review) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={{ padding: spacing.lg }}>{header}</View>
        <Loading />
      </View>
    );
  }

  const t = review.totals;
  const hours = Math.round((t.minutes / 60) * 10) / 10;
  const winRate = t.matches > 0 ? Math.round((100 * t.wins) / t.matches) : 0;
  const maxMonth = Math.max(1, ...review.monthly.map((m) => m.matches));

  if (t.matches === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View style={{ padding: spacing.lg }}>{header}</View>
        <EmptyState icon="🎾" title={`No matches in ${year}`} subtitle="Pick another year, or go play one." />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {header}

      {/* The headline number */}
      <Card style={{ alignItems: 'center', gap: 2, paddingVertical: spacing.xl }}>
        <CountUp value={t.matches} style={styles.hero} />
        <Text style={styles.heroLabel}>MATCHES PLAYED</Text>
        <Text style={styles.heroSub}>
          {t.wins}W – {t.losses}L · {winRate}% win rate
        </Text>
      </Card>

      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <Card style={{ flex: 1 }}>
          <Stat label="Hours" value={hours > 0 ? String(hours) : '—'} />
        </Card>
        <Card style={{ flex: 1 }}>
          <Stat label="Games won" value={t.games_won} color={colors.primary} />
        </Card>
        <Card style={{ flex: 1 }}>
          <Stat label="Aces" value={t.aces} color={colors.accent} />
        </Card>
      </View>

      {/* Month by month */}
      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="Month by month" />
        <View style={styles.chart}>
          {review.monthly.map((m) => (
            <View key={m.month} style={styles.chartCol}>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.bar,
                    {
                      height: `${Math.round((m.matches / maxMonth) * 100)}%`,
                      backgroundColor: m.matches > 0 ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  {/* wins portion overlays the bottom of the bar */}
                  {m.matches > 0 && m.wins > 0 ? (
                    <View
                      style={[
                        styles.winBar,
                        { height: `${Math.round((m.wins / m.matches) * 100)}%` },
                      ]}
                    />
                  ) : null}
                </View>
              </View>
              <Text style={styles.chartLabel}>{MONTHS[m.month - 1]}</Text>
            </View>
          ))}
        </View>
        <View style={styles.legend}>
          <View style={[styles.legendDot, { backgroundColor: colors.win }]} />
          <Text style={styles.legendText}>wins</Text>
          <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={styles.legendText}>matches</Text>
        </View>
      </Card>

      {/* Highlights */}
      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="Highlights" />
        {review.longest_win_streak > 1 ? (
          <HighlightRow icon="🔥" title="Longest win streak" value={`${review.longest_win_streak} in a row`} />
        ) : null}
        {review.top_opponent ? (
          <HighlightRow
            icon="⚔️"
            title="Top rival"
            value={review.top_opponent.name}
            sub={`${review.top_opponent.matches} matches · you lead ${review.top_opponent.wins}-${review.top_opponent.losses}`}
          />
        ) : null}
        {review.favorite_court ? (
          <HighlightRow
            icon="📍"
            title="Home turf"
            value={review.favorite_court.name}
            sub={`${review.favorite_court.matches} matches there`}
          />
        ) : null}
        {review.favorite_surface ? (
          <View style={styles.hlRow}>
            <Text style={styles.hlIcon}>🏟️</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.hlTitle}>Favourite surface</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 }}>
                <SurfaceBadge surface={review.favorite_surface.surface} small />
                <Text style={styles.hlSub}>
                  {review.favorite_surface.matches} matches · {review.favorite_surface.win_rate}% wins
                </Text>
              </View>
            </View>
          </View>
        ) : null}
        {t.kudos_received > 0 ? (
          <HighlightRow icon="👏" title="Kudos received" value={String(t.kudos_received)} />
        ) : null}
      </Card>

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

function HighlightRow({ icon, title, value, sub }: { icon: string; title: string; value: string; sub?: string }) {
  return (
    <View style={styles.hlRow}>
      <Text style={styles.hlIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.hlTitle}>{title}</Text>
        {sub ? <Text style={styles.hlSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.hlValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  yearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chev: { color: colors.primary, fontSize: 30, fontFamily: fonts.display, paddingHorizontal: spacing.sm },
  yearTitle: { color: colors.text, fontSize: font.h2, fontFamily: fonts.display },
  hero: { color: colors.primary, fontSize: 64, fontFamily: fonts.display },
  heroLabel: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, letterSpacing: 1 },
  heroSub: { color: colors.textDim, fontSize: font.body, fontFamily: fonts.bold, marginTop: spacing.xs },
  chart: { flexDirection: 'row', height: 110, alignItems: 'flex-end' },
  chartCol: { flex: 1, alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' },
  barTrack: { flex: 1, width: 12, justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: radius.pill, overflow: 'hidden', justifyContent: 'flex-end', minHeight: 2 },
  winBar: { width: '100%', backgroundColor: colors.win },
  chartLabel: { color: colors.textFaint, fontSize: 9, fontFamily: fonts.bold },
  legend: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, justifyContent: 'flex-end' },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginLeft: spacing.sm },
  legendText: { color: colors.textFaint, fontSize: font.tiny },
  hlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  hlIcon: { fontSize: 20, width: 28 },
  hlTitle: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold },
  hlSub: { color: colors.textFaint, fontSize: font.tiny, marginTop: 1 },
  hlValue: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body, maxWidth: 150, textAlign: 'right' },
});

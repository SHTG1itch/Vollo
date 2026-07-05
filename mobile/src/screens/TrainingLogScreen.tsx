import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Card, ErrorState, Loading, Muted, Stat } from '../components/ui';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, spacing } from '../theme';
import type { CalendarDay, CalendarMonth } from '../types';
import { formatScoreLine } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// Vollo launched in 2024 — nothing to see in earlier months.
const MIN_YEAR = 2024;

/** Build the Monday-start grid for a month: leading nulls, then day numbers. */
function monthGrid(year: number, month: number): (number | null)[] {
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // JS Sunday=0 → Monday-start offset
  const cells: (number | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function TrainingLogScreen({ route }: NativeStackScreenProps<RootStackParamList, 'TrainingLog'>) {
  const navigation = useNavigation<Nav>();
  const { username } = route.params;
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-based
  const [data, setData] = useState<CalendarMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Adjust state during render when the fetch key changes, so the fetch effect
  // below never calls setState synchronously. Only a month/user change clears
  // the grid — a pull-to-refresh keeps it on screen while it reloads.
  const [prevFetch, setPrevFetch] = useState({ username, year, month, reloadKey });
  if (
    prevFetch.username !== username ||
    prevFetch.year !== year ||
    prevFetch.month !== month ||
    prevFetch.reloadKey !== reloadKey
  ) {
    const monthChanged =
      prevFetch.username !== username || prevFetch.year !== year || prevFetch.month !== month;
    setPrevFetch({ username, year, month, reloadKey });
    setError(null);
    if (monthChanged) {
      setData(null);
      setSelected(null);
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .getCalendar(username, year, month)
      .then((r) => active && setData(r))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : 'Failed to load the training log'))
      .finally(() => active && setRefreshing(false));
    return () => {
      active = false;
    };
  }, [username, year, month, reloadKey]);

  const onRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  const shiftMonth = (delta: number) => {
    tapLight();
    const d = new Date(year, month - 1 + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth() + 1);
  };

  // Never navigate past the current month — there's nothing to show there.
  const atCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;
  // …and never before launch, so you can't page back to year 1900.
  const atMinMonth = year < MIN_YEAR || (year === MIN_YEAR && month === 1);

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data]);

  const cells = useMemo(() => monthGrid(year, month), [year, month]);
  const monthTitle = new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const selectedDay = selected ? byDate.get(selected) : null;

  if (error) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card style={{ gap: spacing.md }}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => shiftMonth(-1)}
            hitSlop={10}
            disabled={atMinMonth}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
          >
            <Text style={[styles.chev, atMinMonth && { opacity: 0.25 }]}>‹</Text>
          </Pressable>
          <Text style={styles.monthTitle}>{monthTitle}</Text>
          <Pressable
            onPress={() => shiftMonth(1)}
            hitSlop={10}
            disabled={atCurrentMonth}
            accessibilityRole="button"
            accessibilityLabel="Next month"
          >
            <Text style={[styles.chev, atCurrentMonth && { opacity: 0.25 }]}>›</Text>
          </Pressable>
        </View>

        {!data ? (
          <Loading />
        ) : (
          <>
            <View style={styles.weekRow}>
              {WEEKDAYS.map((w, i) => (
                <Text key={i} style={styles.weekday}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={styles.grid}>
              {cells.map((day, i) => {
                if (day === null) return <View key={i} style={styles.cell} />;
                const date = `${year}-${pad2(month)}-${pad2(day)}`;
                const info = byDate.get(date);
                const isSelected = selected === date;
                const played = !!info;
                // Colour tells the day's story at a glance: green = all wins,
                // red = all losses, primary = mixed.
                const fill = !info
                  ? 'transparent'
                  : info.wins === info.matches
                    ? colors.win
                    : info.wins === 0
                      ? colors.loss
                      : colors.primary;
                return (
                  <Pressable
                    key={i}
                    style={styles.cell}
                    onPress={() => {
                      if (played) {
                        tapLight();
                        setSelected(isSelected ? null : date);
                      }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      info ? `${date}: ${info.matches} matches, ${info.wins} wins` : date
                    }
                  >
                    <View
                      style={[
                        styles.dayDot,
                        played && { backgroundColor: fill },
                        isSelected && styles.daySelected,
                      ]}
                    >
                      <Text style={[styles.dayText, played && { color: colors.white, fontFamily: fonts.bold }]}>
                        {day}
                      </Text>
                    </View>
                    {info && info.matches > 1 ? <Text style={styles.multi}>×{info.matches}</Text> : null}
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.statsRow}>
              <Stat label="Matches" value={data.totals.matches} />
              <Stat label="Wins" value={data.totals.wins} color={colors.win} />
              <Stat
                label="Hours"
                value={data.totals.minutes > 0 ? `${Math.round((data.totals.minutes / 60) * 10) / 10}` : '—'}
              />
            </View>
          </>
        )}
      </Card>

      {selectedDay ? (
        <Card style={{ gap: spacing.sm }}>
          <Text style={styles.selectedTitle}>
            {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </Text>
          {selectedDay.items.map((m) => (
            <Pressable
              key={m.id}
              style={styles.matchRow}
              onPress={() => navigation.navigate('MatchDetail', { matchId: m.id })}
              accessibilityRole="button"
            >
              <Text style={[styles.matchResult, { color: m.result === 'win' ? colors.win : colors.loss }]}>
                {m.result === 'win' ? 'W' : 'L'}
              </Text>
              <Text style={styles.matchScore}>{formatScoreLine(m.score_array)}</Text>
              <Text style={styles.matchGo}>View →</Text>
            </Pressable>
          ))}
        </Card>
      ) : data && data.totals.matches === 0 ? (
        <Muted>No matches this month.</Muted>
      ) : null}

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chev: { color: colors.primary, fontSize: 30, fontFamily: fonts.display, paddingHorizontal: spacing.sm },
  monthTitle: { color: colors.text, fontSize: font.h3, fontFamily: fonts.heading },
  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    color: colors.textFaint,
    fontSize: font.tiny,
    fontFamily: fonts.bold,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 5 },
  dayDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  daySelected: { borderWidth: 2, borderColor: colors.text },
  dayText: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.body },
  multi: { position: 'absolute', right: 6, top: 2, color: colors.textFaint, fontSize: 8, fontFamily: fonts.bold },
  statsRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  selectedTitle: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small, textTransform: 'uppercase', letterSpacing: 0.5 },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  matchResult: { fontFamily: fonts.bold, width: 18 },
  matchScore: { color: colors.text, fontFamily: fonts.bold, flex: 1 },
  matchGo: { color: colors.primary, fontSize: font.tiny, fontFamily: fonts.bold },
});

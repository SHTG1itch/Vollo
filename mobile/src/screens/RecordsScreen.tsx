import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Card, EmptyState, ErrorState, Loading } from '../components/ui';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { PersonalRecords } from '../types';
import { formatScoreLine } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, (m ?? 1) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RecordsScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Records'>) {
  const navigation = useNavigation<Nav>();
  const { username } = route.params;
  const [records, setRecords] = useState<PersonalRecords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void api
      .getRecords(username)
      .then((r) => active && setRecords(r.records))
      .catch((e) => active && setError(e instanceof ApiError ? e.message : 'Failed to load records'));
    return () => {
      active = false;
    };
  }, [username, reloadKey]);

  if (error) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!records) return <Loading />;
  if (records.total_matches === 0) {
    return (
      <EmptyState
        icon="🏆"
        title="No records yet"
        subtitle="Records appear here once matches are logged and verified."
      />
    );
  }

  const rows: {
    icon: string;
    title: string;
    value: string;
    sub?: string;
    matchId?: string;
  }[] = [];

  if (records.longest_win_streak && records.longest_win_streak.count > 1) {
    rows.push({
      icon: '🔥',
      title: 'Longest win streak',
      value: `${records.longest_win_streak.count} wins`,
      sub: `${dateLabel(records.longest_win_streak.started_at)} – ${dateLabel(records.longest_win_streak.ended_at)}`,
    });
  }
  if (records.peak_rating) {
    rows.push({
      icon: '📈',
      title: 'Peak rating',
      value: String(records.peak_rating.rating),
      sub: `on ${records.peak_rating.surface}`,
    });
  }
  if (records.biggest_win) {
    rows.push({
      icon: '💪',
      title: 'Biggest win',
      value: formatScoreLine(records.biggest_win.score_array),
      sub: `+${records.biggest_win.margin} games · ${dateLabel(records.biggest_win.played_at)}`,
      matchId: records.biggest_win.match_id,
    });
  }
  if (records.most_aces) {
    rows.push({
      icon: '🚀',
      title: 'Most aces in a match',
      value: `${records.most_aces.aces} aces`,
      sub: dateLabel(records.most_aces.played_at),
      matchId: records.most_aces.match_id,
    });
  }
  if (records.longest_match) {
    const mins = records.longest_match.duration_minutes;
    rows.push({
      icon: '⏱️',
      title: 'Longest match',
      value: mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
      sub: dateLabel(records.longest_match.played_at),
      matchId: records.longest_match.match_id,
    });
  }
  if (records.busiest_month) {
    rows.push({
      icon: '📅',
      title: 'Busiest month',
      value: `${records.busiest_month.matches} matches`,
      sub: monthLabel(records.busiest_month.month),
    });
  }
  if (records.comeback_wins > 0) {
    rows.push({
      icon: '🔄',
      title: 'Comeback wins',
      value: String(records.comeback_wins),
      sub: 'won after dropping the first set',
    });
  }
  if (records.first_match_at) {
    rows.push({
      icon: '🎾',
      title: 'On Vollo since',
      value: dateLabel(records.first_match_at),
      sub: `${records.total_matches} matches logged`,
    });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.md }}>
        {rows.map((r) => {
          const inner = (
            <View style={styles.row}>
              <View style={styles.iconWrap}>
                <Text style={{ fontSize: 22 }}>{r.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{r.title}</Text>
                {r.sub ? <Text style={styles.rowSub}>{r.sub}</Text> : null}
              </View>
              <Text style={styles.rowValue}>{r.value}</Text>
            </View>
          );
          return r.matchId ? (
            <Pressable
              key={r.title}
              onPress={() => navigation.navigate('MatchDetail', { matchId: r.matchId! })}
              accessibilityRole="button"
              accessibilityLabel={`${r.title}: ${r.value}. View match.`}
            >
              {inner}
            </Pressable>
          ) : (
            <View key={r.title}>{inner}</View>
          );
        })}
      </Card>
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  rowSub: { color: colors.textFaint, fontSize: font.tiny, marginTop: 1 },
  rowValue: { color: colors.primary, fontFamily: fonts.display, fontSize: font.h3 },
});

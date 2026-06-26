import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { Avatar, Button, Card, ErrorState, Loading, Muted } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, shadow, spacing } from '../theme';
import type { Court, LeaderboardEntry } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Court'>;

export function CourtDetailScreen({ route, navigation }: Props) {
  const { courtId } = route.params;
  const [court, setCourt] = useState<Court | null>(null);
  const [controller, setController] = useState<{ display_name: string; username: string; score: number } | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [{ court: c, controller: ctrl }, { leaderboard }] = await Promise.all([
          api.getCourt(courtId),
          api.getCourtLeaderboard(courtId),
        ]);
        if (!active) return;
        setCourt(c);
        setController(ctrl);
        setBoard(leaderboard);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load court');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [courtId, reloadKey]);

  if (loading) return <Loading />;
  if (error && !court) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!court) return <Muted style={{ padding: spacing.xl }}>Court not found.</Muted>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{court.name}</Text>
          <SurfaceBadge surface={court.surface} />
        </View>
        {court.city ? <Muted>{court.city}</Muted> : null}
        {court.address ? <Muted>{court.address}</Muted> : null}

        <View style={styles.controllerBox}>
          <Text style={styles.crown}>👑</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.controllerLabel}>Court Controller</Text>
            {controller ? (
              <Text style={styles.controllerName}>
                {controller.display_name} · {controller.score} pts
              </Text>
            ) : (
              <Text style={styles.controllerName}>Up for grabs — log a win!</Text>
            )}
          </View>
        </View>
      </Card>

      <View style={styles.boardHeader}>
        <Text style={styles.boardTitle}>Leaderboard · 30 days</Text>
        {board.length > 5 ? (
          <Button
            label="See all"
            variant="ghost"
            onPress={() => navigation.navigate('Leaderboard', { courtId, courtName: court.name })}
            style={{ height: 32 }}
          />
        ) : null}
      </View>

      {board.length === 0 ? (
        <Muted>No matches logged here in the last 30 days.</Muted>
      ) : (
        board.slice(0, 5).map((e) => (
          <Pressable key={e.user_id} style={styles.row} onPress={() => navigation.navigate('UserProfile', { username: e.username })}>
            <Text style={[styles.rank, e.rank === 1 && { color: colors.primary }]}>#{e.rank}</Text>
            <Avatar name={e.display_name} uri={e.avatar_url} size={32} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowName}>{e.display_name}</Text>
              <Text style={styles.rowSub}>{e.wins}W · {e.losses}L</Text>
            </View>
            <Text style={styles.rowScore}>{e.score} pts</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  name: { color: colors.text, fontSize: font.h2, fontWeight: '800', flex: 1 },
  controllerBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.accentSoft,
    borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm,
  },
  crown: { fontSize: 24 },
  controllerLabel: { color: colors.textDim, fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  controllerName: { color: colors.text, fontWeight: '800', fontSize: font.body },
  boardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  boardTitle: { color: colors.text, fontWeight: '800', fontSize: font.h3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  rank: { color: colors.textDim, fontWeight: '800', width: 30, fontSize: font.body },
  rowName: { color: colors.text, fontWeight: '700' },
  rowSub: { color: colors.textFaint, fontSize: font.tiny },
  rowScore: { color: colors.primary, fontWeight: '800' },
});

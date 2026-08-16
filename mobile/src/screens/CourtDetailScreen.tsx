import React, { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, ErrorState, Loading, Muted } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import type { Court, LeaderboardEntry } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Court'>;

export function CourtDetailScreen({ route, navigation }: Props) {
  const { courtId } = route.params;
  const user = useAuth((s) => s.user);
  const [court, setCourt] = useState<Court | null>(null);
  const [reportable, setReportable] = useState(false);
  const [controller, setController] = useState<{ display_name: string; username: string; score: number } | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Adjust state during render when the fetch key changes, so the fetch effect
  // below never calls setState synchronously.
  const [prevFetch, setPrevFetch] = useState({ courtId, reloadKey });
  if (prevFetch.courtId !== courtId || prevFetch.reloadKey !== reloadKey) {
    const differentCourt = prevFetch.courtId !== courtId;
    setPrevFetch({ courtId, reloadKey });
    setError(null);
    setBoardError(false);
    if (differentCourt) {
      // A route-param update may reuse this instance. Clear every court-keyed
      // section before rendering so no old venue/controller data can flash.
      setCourt(null);
      setReportable(false);
      setController(null);
      setBoard([]);
      setRefreshing(false);
      setLoading(true);
    } else if (!court) {
      setLoading(true); // a pull-to-refresh keeps the screen, not a full loader
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      // Attach both handlers immediately so a quick leaderboard rejection is
      // contained while the primary court request is still in flight.
      const leaderboardTask = api.getCourtLeaderboard(courtId).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
      try {
        const { court: c, controller: ctrl, reportable: canReport } = await api.getCourt(courtId);
        if (!active) return;
        setCourt(c);
        setController(ctrl);
        setReportable(canReport);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load court');
      } finally {
        if (active) {
          setLoading(false);
        }
      }

      const leaderboardResult = await leaderboardTask;
      if (!active) return;
      if (leaderboardResult.ok) {
        setBoard(leaderboardResult.value.leaderboard);
        setBoardError(false);
      } else {
        // The court itself remains fully usable when this optional section is
        // offline or the leaderboard endpoint is degraded.
        setBoardError(true);
      }
      setRefreshing(false);
    })();
    return () => {
      active = false;
    };
  }, [courtId, reloadKey]);

  const onRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  if (loading) return <Loading />;
  if (error && !court) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!court) return <Muted style={{ padding: spacing.xl }}>Court not found.</Muted>;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card style={{ gap: spacing.sm }}>
        <View style={styles.titleRow}>
          <Text style={styles.name}>{court.name}</Text>
          <SurfaceBadge surface={court.surface} />
        </View>
        {court.city ? <Muted>{court.city}</Muted> : null}
        {court.address ? <Muted>{court.address}</Muted> : null}

        {court.court_count > 1 ? (
          <View style={styles.sectorPill}>
            <Text style={styles.sectorText}>
              🎾 {court.court_count} courts · one domination sector
            </Text>
          </View>
        ) : null}

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
        {reportable ? (
          <Button
            label="Report court"
            variant="ghost"
            onPress={() => navigation.navigate('Report', { subjectType: 'court', subjectId: court.id, subjectLabel: court.name })}
            style={{ height: 38 }}
          />
        ) : null}
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

      {boardError ? <Muted>Couldn’t refresh the leaderboard. Pull down to try again.</Muted> : null}
      {board.length === 0 && !boardError ? (
        <Muted>No matches logged here in the last 30 days.</Muted>
      ) : board.length > 0 ? (
        board.slice(0, 5).map((e) => {
          const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : null;
          const isYou = e.user_id === user?.id;
          return (
            <Pressable
              key={e.user_id}
              style={[styles.row, isYou && styles.rowYou]}
              onPress={() => navigation.navigate('UserProfile', { username: e.username })}
              accessibilityRole="button"
              accessibilityLabel={`Rank ${e.rank}, ${e.display_name}, ${e.score} points`}
              accessibilityHint="Opens player profile"
            >
              <Text style={[styles.rank, e.rank === 1 && { color: colors.primary }]}>{medal ?? `#${e.rank}`}</Text>
              <Avatar name={e.display_name} uri={e.avatar_url} size={32} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>
                  {e.display_name}
                  {isYou ? <Text style={styles.youTag}>  You</Text> : null}
                </Text>
                <Text style={styles.rowSub}>{e.wins}W · {e.losses}L</Text>
              </View>
              <Text style={styles.rowScore}>{e.score} pts</Text>
            </Pressable>
          );
        })
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  name: { color: colors.text, fontSize: font.h2, fontFamily: fonts.heading, flex: 1 },
  controllerBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.accentSoft,
    borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm,
  },
  sectorPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginTop: 2,
  },
  sectorText: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.small },
  crown: { fontSize: 24 },
  controllerLabel: { color: colors.textDim, fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  controllerName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  boardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  boardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  rowYou: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  youTag: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.tiny },
  rank: { color: colors.textDim, fontFamily: fonts.bold, width: 30, fontSize: font.body },
  rowName: { color: colors.text, fontFamily: fonts.bold },
  rowSub: { color: colors.textFaint, fontSize: font.tiny },
  rowScore: { color: colors.primary, fontFamily: fonts.bold },
});

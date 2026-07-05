import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, EmptyState, ErrorState, Loading } from '../components/ui';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import type { LeaderboardEntry } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Leaderboard'>;

export function LeaderboardScreen({ route, navigation }: Props) {
  const { courtId } = route.params;
  const user = useAuth((s) => s.user);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Adjust state during render when the fetch key changes, so the fetch effect
  // below never calls setState synchronously.
  const [prevFetch, setPrevFetch] = useState({ courtId, reloadKey });
  if (prevFetch.courtId !== courtId || prevFetch.reloadKey !== reloadKey) {
    setPrevFetch({ courtId, reloadKey });
    setError(null);
    if (!refreshing) setLoading(true); // a pull-to-refresh keeps the list, not a full loader
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { leaderboard } = await api.getCourtLeaderboard(courtId);
        if (active) setBoard(leaderboard);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load leaderboard');
      } finally {
        if (active) {
          setLoading(false);
          setRefreshing(false);
        }
      }
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
  if (error) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      data={board}
      keyExtractor={(e) => e.user_id}
      ListHeaderComponent={<Text style={styles.title}>Court leaderboard · last 30 days</Text>}
      renderItem={({ item }) => {
        const medal = item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : null;
        const isYou = item.user_id === user?.id;
        return (
          <Pressable style={[styles.row, item.rank <= 2 && styles.rowControlled, isYou && styles.rowYou]} onPress={() => navigation.navigate('UserProfile', { username: item.username })}>
            <Text style={styles.rank}>{medal ?? `#${item.rank}`}</Text>
            <Avatar name={item.display_name} uri={item.avatar_url} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {item.display_name}
                {isYou ? <Text style={styles.youTag}>  You</Text> : null}
              </Text>
              <Text style={styles.sub}>
                {item.matches_played} matches · {item.wins}W {item.losses}L · {item.games_won}-{item.games_lost} games
              </Text>
            </View>
            <Text style={[styles.score, item.rank === 1 && styles.scoreLeader]}>{item.score}</Text>
          </Pressable>
        );
      }}
      ListEmptyComponent={<EmptyState title="No ranked players" subtitle="Be the first to log a match here." />}
    />
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  rowControlled: { borderColor: colors.primary },
  rowYou: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  youTag: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.tiny },
  rank: { color: colors.textDim, fontFamily: fonts.bold, width: 34, fontSize: font.body, textAlign: 'center' },
  name: { color: colors.text, fontFamily: fonts.bold },
  sub: { color: colors.textFaint, fontSize: font.tiny, marginTop: 2 },
  score: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.body },
  scoreLeader: { color: colors.onAccent, backgroundColor: colors.accent, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
});

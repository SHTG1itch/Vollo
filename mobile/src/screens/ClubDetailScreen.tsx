import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, ErrorState, Loading, Muted, SectionHeader } from '../components/ui';
import { MatchCard } from '../components/MatchCard';
import { showToast } from '../components/Toast';
import { tapMedium } from '../lib/haptics';
import { colors, font, fonts, spacing } from '../theme';
import type { Club, ClubLeaderboardEntry, ClubMember, MatchCard as MatchCardType } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function ClubDetailScreen({ route }: NativeStackScreenProps<RootStackParamList, 'Club'>) {
  const navigation = useNavigation<Nav>();
  const { clubId } = route.params;
  const user = useAuth((s) => s.user);

  const [club, setClub] = useState<Club | null>(null);
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [leaderboard, setLeaderboard] = useState<ClubLeaderboardEntry[]>([]);
  const [matches, setMatches] = useState<MatchCardType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Adjust state during render when the fetch key changes, so the fetch effect
  // below never calls setState synchronously.
  const [prevFetch, setPrevFetch] = useState({ clubId, reloadKey });
  if (prevFetch.clubId !== clubId || prevFetch.reloadKey !== reloadKey) {
    setPrevFetch({ clubId, reloadKey });
    setError(null);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const detail = await api.getClub(clubId);
        if (!active) return;
        setClub(detail.club);
        setMembers(detail.members);
        const [lb, feed] = await Promise.allSettled([
          api.getClubLeaderboard(clubId),
          api.getClubFeed(clubId, { limit: 10 }),
        ]);
        if (!active) return;
        if (lb.status === 'fulfilled') setLeaderboard(lb.value.leaderboard);
        if (feed.status === 'fulfilled') setMatches(feed.value.matches);
      } catch (e) {
        if (active) setError(e instanceof ApiError ? e.message : 'Failed to load the club');
      } finally {
        if (active) setRefreshing(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [clubId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const join = async () => {
    if (!club || busy) return;
    tapMedium();
    setBusy(true);
    try {
      await api.joinClub(clubId);
      showToast(`Welcome to ${club.name}! 🏟️`, 'success');
      reload();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not join — please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmLeave = () => {
    if (!club) return;
    const lastMember = club.member_count <= 1;
    Alert.alert(
      `Leave ${club.name}?`,
      lastMember
        ? 'You are the last member — leaving will delete the club.'
        : 'You can rejoin any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: lastMember ? 'Leave & delete' : 'Leave',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await api.leaveClub(clubId);
              if (lastMember) {
                navigation.goBack();
              } else {
                reload();
              }
            } catch (e) {
              showToast(e instanceof ApiError ? e.message : 'Could not leave — please try again.', 'error');
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  // In-flight guard (per match): rapid double-taps must not race add/remove
  // calls; the count is reconciled from the server response.
  const kudosInFlight = useRef<Set<string>>(new Set());
  const toggleKudos = async (matchId: string) => {
    const m = matches.find((x) => x.id === matchId);
    if (!m || kudosInFlight.current.has(matchId)) return;
    kudosInFlight.current.add(matchId);
    const had = !!m.viewer_has_kudos;
    setMatches((list) =>
      list.map((x) =>
        x.id === matchId
          ? { ...x, viewer_has_kudos: !had, kudos_count: x.kudos_count + (had ? -1 : 1) }
          : x,
      ),
    );
    try {
      const res = had ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      setMatches((list) =>
        list.map((x) =>
          x.id === matchId
            ? { ...x, viewer_has_kudos: res.viewer_has_kudos, kudos_count: res.kudos_count }
            : x,
        ),
      );
    } catch {
      setMatches((list) =>
        list.map((x) =>
          x.id === matchId
            ? { ...x, viewer_has_kudos: had, kudos_count: Math.max(0, x.kudos_count + (had ? 1 : -1)) }
            : x,
        ),
      );
    } finally {
      kudosInFlight.current.delete(matchId);
    }
  };

  if (error && !club) return <ErrorState message={error} onRetry={reload} />;
  if (!club) return <Loading />;

  const goToPlayer = (username: string) =>
    username === user?.username
      ? navigation.navigate('Tabs', { screen: 'Me' })
      : navigation.navigate('UserProfile', { username });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            reload();
          }}
          tintColor={colors.primary}
        />
      }
    >
      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.name}>{club.name}</Text>
        <Text style={styles.meta}>
          {club.member_count} {club.member_count === 1 ? 'member' : 'members'}
          {club.city ? ` · ${club.city}` : ''}
        </Text>
        {club.description ? <Text style={styles.desc}>{club.description}</Text> : null}
        {club.viewer_is_member ? (
          <Button label="Leave club" variant="ghost" onPress={confirmLeave} loading={busy} style={{ height: 42 }} />
        ) : (
          <Button label="Join club" onPress={join} loading={busy} style={{ height: 42 }} />
        )}
      </Card>

      {leaderboard.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionHeader title="This month's leaderboard" />
          {leaderboard.slice(0, 10).map((e) => (
            <Pressable key={e.user_id} style={styles.lbRow} onPress={() => goToPlayer(e.username)} accessibilityRole="button">
              <Text style={styles.lbRank}>{e.rank}</Text>
              <Avatar name={e.display_name} uri={e.avatar_url} size={30} />
              <View style={{ flex: 1 }}>
                <Text style={styles.lbName} numberOfLines={1}>
                  {e.display_name}
                </Text>
                <Text style={styles.lbSub}>
                  {e.matches_played} {e.matches_played === 1 ? 'match' : 'matches'} · {e.wins}W
                </Text>
              </View>
              <Text style={styles.lbScore}>{Math.round(e.score)}</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {members.length > 0 ? (
        <Card style={{ gap: spacing.sm }}>
          <SectionHeader title="Members" />
          {members.slice(0, 12).map((m) => (
            <Pressable key={m.id} style={styles.memberRow} onPress={() => goToPlayer(m.username)} accessibilityRole="button">
              <Avatar name={m.display_name} uri={m.avatar_url} size={30} />
              <View style={{ flex: 1 }}>
                <Text style={styles.lbName}>{m.display_name}</Text>
                <Text style={styles.lbSub}>@{m.username}</Text>
              </View>
              {m.role === 'admin' ? <Text style={styles.adminTag}>ADMIN</Text> : null}
            </Pressable>
          ))}
          {club.member_count > 12 ? <Muted>+{club.member_count - 12} more</Muted> : null}
        </Card>
      ) : null}

      <SectionHeader title="Recent club matches" />
      {matches.length === 0 ? (
        <Muted>No matches from club members yet.</Muted>
      ) : (
        matches.map((m) => (
          <MatchCard
            key={m.id}
            match={m}
            onPress={() => navigation.navigate('MatchDetail', { matchId: m.id })}
            onKudos={() => toggleKudos(m.id)}
            onPressAuthor={() => goToPlayer(m.author_username)}
          />
        ))
      )}

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  name: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display },
  meta: { color: colors.textFaint, fontSize: font.small },
  desc: { color: colors.textDim, fontSize: font.body },
  lbRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lbRank: { color: colors.textFaint, fontFamily: fonts.display, fontSize: font.body, width: 22, textAlign: 'center' },
  lbName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  lbSub: { color: colors.textFaint, fontSize: font.tiny },
  lbScore: { color: colors.primary, fontFamily: fonts.display, fontSize: font.h3 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  adminTag: { color: colors.accent, fontFamily: fonts.bold, fontSize: 9, letterSpacing: 0.5 },
});

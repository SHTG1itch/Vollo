import React, { useEffect, useRef, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import type { CommentItem } from '../api/client';
import { useAuth } from '../store/auth';
import { useFeed } from '../store/feed';
import { Avatar, Button, Card, ErrorState, Field, Loading, Muted } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { ProgressBar, RallyDistribution, SplitBar } from '../components/charts';
import { KudosButton } from '../components/KudosButton';
import { ConfettiBurst } from '../components/ConfettiBurst';
import { ShareStorySheet } from '../components/ShareStorySheet';
import { showToast } from '../components/Toast';
import { tapMedium } from '../lib/haptics';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { MatchCard, MatchStats } from '../types';
import { formatScoreLine, timeAgo } from '../utils/format';

type Props = NativeStackScreenProps<RootStackParamList, 'MatchDetail'>;
type Comment = CommentItem;

export function MatchDetailScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const user = useAuth((s) => s.user);
  const [match, setMatch] = useState<MatchCard | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentsError, setCommentsError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Celebrate your own win once when the match opens (not on every refresh).
  // The ref stores the matchId already celebrated, so a pull-to-refresh of the
  // SAME match won't re-fire the confetti but a different match will.
  const [celebrate, setCelebrate] = useState(false);
  const celebratedRef = useRef<string | null>(null);
  // Strava-style "share to story" overlay.
  const [shareOpen, setShareOpen] = useState(false);

  // Adjust state during render when the fetch key changes (React's sanctioned
  // pattern), so the fetch effect below never calls setState synchronously.
  const [prevFetch, setPrevFetch] = useState({ matchId, reloadKey });
  if (prevFetch.matchId !== matchId || prevFetch.reloadKey !== reloadKey) {
    const differentMatch = prevFetch.matchId !== matchId;
    setPrevFetch({ matchId, reloadKey });
    setError(null);
    setCommentsError(false);
    if (differentMatch) {
      // Screen reused for another match (deep link / match-to-match nav):
      // drop the stale content and show the loader.
      setMatch(null);
      setComments([]);
      setDraft('');
      setCelebrate(false);
      setShareOpen(false);
      setLoading(true);
    } else if (!match) {
      // Retrying a failed load shows the loader again, not "Match not found".
      setLoading(true);
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      // Comments are an optional section. Handle their rejection from the
      // moment the request starts so it can never suppress a valid match.
      const commentsTask = api.getComments(matchId).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      );
      try {
        const { match: m } = await api.getMatch(matchId);
        if (!active) return;
        setMatch(m);
        if (celebratedRef.current !== matchId && m.result === 'win' && m.user_id === user?.id) {
          celebratedRef.current = matchId;
          setCelebrate(true);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load match');
      } finally {
        if (active) {
          setLoading(false);
        }
      }

      const commentsResult = await commentsTask;
      if (!active) return;
      if (commentsResult.ok) {
        setComments(commentsResult.value.comments);
        setCommentsError(false);
      } else {
        setCommentsError(true);
      }
      setRefreshing(false);
    })();
    return () => {
      active = false;
    };
  }, [matchId, reloadKey, user?.id]);

  const onRefresh = () => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  };

  const goToUser = (username: string | null | undefined) => {
    if (!username) return;
    if (username === user?.username) navigation.navigate('Tabs', { screen: 'Me' });
    else navigation.navigate('UserProfile', { username });
  };

  // In-flight guard: rapid double-taps must not race add/remove calls (the
  // feed store has the same guard); the result is mirrored back into any feed
  // card already on screen so the list isn't stale after navigating back.
  const kudosInFlight = useRef(false);
  const commentInFlight = useRef(false);
  const syncFeedKudos = (kudosCount: number, viewerHas: boolean) => {
    useFeed.setState((s) => ({
      matches: s.matches.map((m) => (m.id === matchId ? { ...m, kudos_count: kudosCount, viewer_has_kudos: viewerHas } : m)),
    }));
  };

  const toggleKudos = async () => {
    if (!match || kudosInFlight.current) return;
    kudosInFlight.current = true;
    const was = match.viewer_has_kudos ?? false;
    setMatch({ ...match, viewer_has_kudos: !was, kudos_count: match.kudos_count + (was ? -1 : 1) });
    try {
      const res = was ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      setMatch((cur) => (cur ? { ...cur, kudos_count: res.kudos_count, viewer_has_kudos: res.viewer_has_kudos } : cur));
      syncFeedKudos(res.kudos_count, res.viewer_has_kudos);
    } catch {
      setMatch((cur) => (cur ? { ...cur, viewer_has_kudos: was, kudos_count: Math.max(0, cur.kudos_count + (was ? 1 : -1)) } : cur));
    } finally {
      kudosInFlight.current = false;
    }
  };

  const postComment = async () => {
    if (!draft.trim() || !user || commentInFlight.current) return;
    commentInFlight.current = true;
    setPosting(true);
    try {
      const { comment } = await api.addComment(matchId, draft.trim());
      // Use the server's authoritative comment (real id/timestamp), not a stub.
      setComments((c) => [...c, comment]);
      setCommentsError(false);
      setDraft('');
      setMatch((cur) => (cur ? { ...cur, comment_count: cur.comment_count + 1 } : cur));
      // Keep the feed card authoritative when navigating back from the detail.
      useFeed.setState((state) => ({
        matches: state.matches.map((item) =>
          item.id === matchId ? { ...item, comment_count: item.comment_count + 1 } : item,
        ),
      }));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not post your comment — try again.', 'error');
    } finally {
      commentInFlight.current = false;
      setPosting(false);
    }
  };

  const verify = async (action: 'confirm' | 'reject') => {
    if (!match || verifying) return;
    setVerifying(true);
    tapMedium();
    try {
      const { match: updated } = await api.verifyMatch(matchId, action);
      setMatch(updated);
      // Reflect the new status in any feed card already on screen.
      useFeed.setState((s) => ({ matches: s.matches.map((m) => (m.id === matchId ? updated : m)) }));
      showToast(action === 'confirm' ? 'Match confirmed — it now counts.' : 'Match disputed — it won’t count.', 'success');
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not update the match — try again.', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const remove = () => {
    Alert.alert('Delete match', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteMatch(matchId);
            useFeed.setState((s) => ({ matches: s.matches.filter((m) => m.id !== matchId) }));
            navigation.goBack();
          } catch (e) {
            showToast(e instanceof ApiError ? e.message : 'Could not delete the match — try again.', 'error');
          }
        },
      },
    ]);
  };

  if (loading) return <Loading />;
  if (error && !match) return <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!match) return <Muted style={{ padding: spacing.xl }}>Match not found.</Muted>;

  const win = match.result === 'win';
  const opponent = match.opponent_display_name ?? match.opponent_name ?? 'an unrecorded opponent';
  const isOwner = match.user_id === user?.id;
  const isOpponent = !!match.opponent_id && match.opponent_id === user?.id;
  const pending = match.verification_status === 'pending';
  const rejected = match.verification_status === 'rejected';

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <Card style={{ gap: spacing.sm }}>
          <View style={styles.headerRow}>
            <Pressable
              style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 }, pressed && { opacity: 0.7 }]}
              onPress={() => goToUser(match.author_username)}
            >
              <Avatar name={match.author_display_name} uri={match.author_avatar_url} size={42} />
              <View>
                <Text style={styles.author}>{match.author_display_name}</Text>
                <Text style={styles.sub}>@{match.author_username} · {timeAgo(match.played_at)}</Text>
              </View>
            </Pressable>
            <SurfaceBadge surface={match.surface} />
          </View>

          {match.title ? <Text style={styles.title}>{match.title}</Text> : null}

          <View style={styles.resultRow}>
            <Text style={[styles.result, { color: win ? colors.win : colors.loss }]}>{win ? 'WIN' : 'LOSS'}</Text>
            <Text style={styles.score}>{formatScoreLine(match.score_array)}</Text>
            <Text style={styles.setsTag}>Sets {match.sets_won}–{match.sets_lost}</Text>
          </View>
          {match.opponent_username ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={styles.vs}>vs </Text>
              <Pressable
                onPress={() => goToUser(match.opponent_username)}
                accessibilityRole="button"
                accessibilityLabel={`View ${opponent}'s profile`}
                hitSlop={8}
              >
                <Text style={styles.vsLink}>{opponent}</Text>
              </Pressable>
            </View>
          ) : (
            <Muted>vs {opponent}</Muted>
          )}

          <View style={styles.metaRow}>
            {match.court_name ? (
              match.court_id ? (
                <Pressable
                  onPress={() => navigation.navigate('Court', { courtId: match.court_id! })}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${match.court_name}`}
                  hitSlop={8}
                >
                  <Text style={[styles.meta, styles.metaLink]}>📍 {match.court_name}</Text>
                </Pressable>
              ) : (
                <Text style={styles.meta}>📍 {match.court_name}</Text>
              )
            ) : null}
            {match.rpe_index ? <Text style={styles.meta}>🔥 RPE {match.rpe_index}</Text> : null}
            {match.duration_minutes ? <Text style={styles.meta}>⏱ {match.duration_minutes}m</Text> : null}
            <Text style={styles.metaScore}>⚡ {match.match_score > 0 ? '+' : ''}{match.match_score} pts</Text>
          </View>
          {match.notes ? <Text style={styles.notes}>“{match.notes}”</Text> : null}

          {match.photo_url ? (
            <Image source={{ uri: match.photo_url }} style={styles.photo} resizeMode="cover" />
          ) : null}

          <View style={styles.actions}>
            <KudosButton active={match.viewer_has_kudos ?? false} count={match.kudos_count} onPress={toggleKudos} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Button
                label={rejected ? 'Disputed' : 'Share'}
                variant="secondary"
                onPress={() => {
                  if (!rejected) setShareOpen(true);
                }}
                disabled={rejected}
                style={{ height: 38, paddingHorizontal: spacing.md }}
              />
              {isOwner ? <Button label="Delete" variant="danger" onPress={remove} style={{ height: 38, paddingHorizontal: spacing.md }} /> : null}
            </View>
          </View>
        </Card>

        {/* Verification — competitive integrity gate */}
        {pending && isOpponent ? (
          <Card style={{ gap: spacing.sm, borderColor: colors.warning }}>
            <Text style={styles.verifyTitle}>🎾 Verify this match</Text>
            <Text style={styles.verifyBody}>
              @{match.author_username} logged this against you. Confirm it so it counts toward their rating and
              territory — or dispute it if it’s wrong.
            </Text>
            <View style={styles.verifyActions}>
              <Button label="Dispute" variant="danger" onPress={() => verify('reject')} loading={verifying} disabled={verifying} style={{ flex: 1, height: 42 }} />
              <Button label="Confirm" onPress={() => verify('confirm')} loading={verifying} disabled={verifying} style={{ flex: 1, height: 42 }} />
            </View>
          </Card>
        ) : pending ? (
          <Card style={{ borderColor: colors.warning }}>
            <Text style={styles.verifyBody}>
              ⏳ Awaiting {opponent}’s verification — this match won’t count until they confirm it.
            </Text>
          </Card>
        ) : rejected ? (
          <Card style={{ borderColor: colors.loss }}>
            <Text style={styles.verifyBody}>🚫 This match was disputed, so it doesn’t count.</Text>
          </Card>
        ) : null}

        {match.stats ? <StatsCard stats={match.stats} /> : null}

        <Text style={styles.commentsTitle}>Comments ({comments.length})</Text>
        {commentsError ? <Muted>Couldn’t refresh comments. Pull down to try again.</Muted> : null}
        {comments.length === 0 && !commentsError ? <Muted>Be the first to comment.</Muted> : null}
        {comments.map((c) => (
          <View key={c.id} style={styles.comment}>
            <Pressable
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              onPress={() => goToUser(c.username)}
              accessibilityRole="button"
              accessibilityLabel={`View ${c.display_name}'s profile`}
              hitSlop={8}
            >
              <Avatar name={c.display_name} uri={c.avatar_url} size={32} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Pressable
                style={({ pressed }) => [{ alignSelf: 'flex-start' }, pressed && { opacity: 0.7 }]}
                onPress={() => goToUser(c.username)}
                accessibilityRole="button"
                accessibilityLabel={`View ${c.display_name}'s profile`}
                hitSlop={8}
              >
                <Text style={styles.commentAuthor}>{c.display_name} <Text style={styles.sub}>· {timeAgo(c.created_at)}</Text></Text>
              </Pressable>
              <Text style={styles.commentBody}>{c.body}</Text>
            </View>
          </View>
        ))}

        {user ? (
          <View style={styles.commentInput}>
            <Field value={draft} onChangeText={setDraft} placeholder="Add a comment…" maxLength={500} style={{ flex: 1 }} />
            <Button label="Post" onPress={postComment} loading={posting} disabled={!draft.trim()} style={{ paddingHorizontal: spacing.lg }} />
          </View>
        ) : null}
        <View style={{ height: spacing.xxl }} />
      </ScrollView>
      <ConfettiBurst play={celebrate} onDone={() => setCelebrate(false)} />
      <ShareStorySheet match={match} visible={shareOpen && !rejected} onClose={() => setShareOpen(false)} />
    </KeyboardAvoidingView>
  );
}

function StatsCard({ stats }: { stats: MatchStats }) {
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  return (
    <Card style={{ gap: spacing.lg }}>
      <Text style={styles.cardTitle}>Match stats</Text>
      <View style={{ gap: spacing.md }}>
        <ProgressBar label="1st serve in" pct={pct(stats.first_serve_in, stats.first_serve_total)} />
        <ProgressBar label="2nd serve in" pct={pct(stats.second_serve_in, stats.second_serve_total)} color={colors.accent} />
        <View style={styles.serveRow}>
          <Text style={styles.serveStat}>🎯 {stats.aces} aces</Text>
          <Text style={styles.serveStat}>💥 {stats.double_faults} DF</Text>
          <Text style={styles.serveStat}>🔓 {stats.break_points_won}/{stats.break_points_total} BP</Text>
        </View>
      </View>
      <View style={{ gap: spacing.md }}>
        <SplitBar label="Forehand" positive={stats.forehand_winners} negative={stats.forehand_errors} />
        <SplitBar label="Backhand" positive={stats.backhand_winners} negative={stats.backhand_errors} />
        <SplitBar label="Volley" positive={stats.volley_winners} negative={stats.volley_errors} />
      </View>
      {stats.rally_short + stats.rally_medium + stats.rally_long > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.subhead}>Rally distribution</Text>
          <RallyDistribution short={stats.rally_short} medium={stats.rally_medium} long={stats.rally_long} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  author: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  sub: { color: colors.textFaint, fontSize: font.tiny },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h2, letterSpacing: 0.2, marginTop: spacing.xs },
  result: { fontSize: font.h2, fontFamily: fonts.display, letterSpacing: 1 },
  score: { color: colors.text, fontSize: font.h2, fontFamily: fonts.display, letterSpacing: 1 },
  photo: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, marginTop: spacing.sm },
  setsTag: { color: colors.textFaint, fontSize: font.small, fontFamily: fonts.bold },
  vs: { color: colors.textDim, fontSize: font.body },
  vsLink: { color: colors.primary, fontFamily: fonts.bold },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs },
  meta: { color: colors.textDim, fontSize: font.small },
  metaLink: { color: colors.primary, fontFamily: fonts.bold },
  metaScore: { color: colors.primary, fontSize: font.small, fontFamily: fonts.bold },
  notes: { color: colors.textDim, fontStyle: 'italic', marginTop: spacing.xs },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  subhead: { color: colors.textFaint, fontFamily: fonts.bold, fontSize: font.tiny, letterSpacing: 0.5, textTransform: 'uppercase' },
  serveRow: { flexDirection: 'row', justifyContent: 'space-between' },
  serveStat: { color: colors.text, fontSize: font.small, fontFamily: fonts.bold },
  verifyTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  verifyBody: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
  verifyActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  commentsTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  comment: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  commentAuthor: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  commentBody: { color: colors.textDim, fontSize: font.body, marginTop: 2 },
  commentInput: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
});

import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { useFeed } from '../store/feed';
import { Avatar, Button, Card, Field, Loading, Muted } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { ProgressBar, RallyDistribution, SplitBar } from '../components/charts';
import { KudosButton } from '../components/KudosButton';
import { colors, font, spacing } from '../theme';
import type { MatchCard, MatchStats } from '../types';
import { formatScoreLine, timeAgo } from '../utils/format';

type Props = NativeStackScreenProps<RootStackParamList, 'MatchDetail'>;
type Comment = { id: string; body: string; created_at: string; user_id: string; username: string; display_name: string; avatar_url: string | null };

export function MatchDetailScreen({ route, navigation }: Props) {
  const { matchId } = route.params;
  const user = useAuth((s) => s.user);
  const [match, setMatch] = useState<MatchCard | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [{ match: m }, { comments: c }] = await Promise.all([api.getMatch(matchId), api.getComments(matchId)]);
        setMatch(m);
        setComments(c);
      } catch {
        /* handled by empty state */
      } finally {
        setLoading(false);
      }
    })();
  }, [matchId]);

  const toggleKudos = async () => {
    if (!match) return;
    const was = match.viewer_has_kudos ?? false;
    setMatch({ ...match, viewer_has_kudos: !was, kudos_count: match.kudos_count + (was ? -1 : 1) });
    try {
      const res = was ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      setMatch((cur) => (cur ? { ...cur, kudos_count: res.kudos_count, viewer_has_kudos: res.viewer_has_kudos } : cur));
    } catch {
      setMatch((cur) => (cur ? { ...cur, viewer_has_kudos: was, kudos_count: cur.kudos_count + (was ? 1 : -1) } : cur));
    }
  };

  const postComment = async () => {
    if (!draft.trim() || !user) return;
    setPosting(true);
    try {
      await api.addComment(matchId, draft.trim());
      setComments((c) => [
        ...c,
        {
          id: `temp-${Date.now()}`,
          body: draft.trim(),
          created_at: new Date().toISOString(),
          user_id: user.id,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        },
      ]);
      setDraft('');
      setMatch((cur) => (cur ? { ...cur, comment_count: cur.comment_count + 1 } : cur));
    } catch (e) {
      Alert.alert('Comment failed', e instanceof ApiError ? e.message : 'Try again');
    } finally {
      setPosting(false);
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
            Alert.alert('Delete failed', e instanceof ApiError ? e.message : 'Try again');
          }
        },
      },
    ]);
  };

  if (loading) return <Loading />;
  if (!match) return <Muted style={{ padding: spacing.xl }}>Match not found.</Muted>;

  const win = match.result === 'win';
  const opponent = match.opponent_display_name ?? match.opponent_name ?? 'an unrecorded opponent';
  const isOwner = match.user_id === user?.id;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={{ gap: spacing.sm }}>
          <View style={styles.headerRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Avatar name={match.author_display_name} uri={match.author_avatar_url} size={42} />
              <View>
                <Text style={styles.author}>{match.author_display_name}</Text>
                <Text style={styles.sub}>@{match.author_username} · {timeAgo(match.played_at)}</Text>
              </View>
            </View>
            <SurfaceBadge surface={match.surface} />
          </View>

          <View style={styles.resultRow}>
            <Text style={[styles.result, { color: win ? colors.win : colors.loss }]}>{win ? 'WIN' : 'LOSS'}</Text>
            <Text style={styles.score}>{formatScoreLine(match.score_array)}</Text>
          </View>
          <Muted>vs {opponent}</Muted>

          <View style={styles.metaRow}>
            {match.court_name ? <Text style={styles.meta}>📍 {match.court_name}</Text> : null}
            {match.rpe_index ? <Text style={styles.meta}>🔥 RPE {match.rpe_index}</Text> : null}
            {match.duration_minutes ? <Text style={styles.meta}>⏱ {match.duration_minutes}m</Text> : null}
            <Text style={styles.metaScore}>⚡ {match.match_score > 0 ? '+' : ''}{match.match_score} pts</Text>
          </View>
          {match.notes ? <Text style={styles.notes}>“{match.notes}”</Text> : null}

          <View style={styles.actions}>
            <KudosButton active={match.viewer_has_kudos ?? false} count={match.kudos_count} onPress={toggleKudos} />
            {isOwner ? <Button label="Delete" variant="danger" onPress={remove} style={{ height: 38, paddingHorizontal: spacing.lg }} /> : null}
          </View>
        </Card>

        {match.stats ? <StatsCard stats={match.stats} /> : null}

        <Text style={styles.commentsTitle}>Comments ({comments.length})</Text>
        {comments.length === 0 ? <Muted>Be the first to comment.</Muted> : null}
        {comments.map((c) => (
          <View key={c.id} style={styles.comment}>
            <Avatar name={c.display_name} uri={c.avatar_url} size={32} />
            <View style={{ flex: 1 }}>
              <Text style={styles.commentAuthor}>{c.display_name} <Text style={styles.sub}>· {timeAgo(c.created_at)}</Text></Text>
              <Text style={styles.commentBody}>{c.body}</Text>
            </View>
          </View>
        ))}

        {user ? (
          <View style={styles.commentInput}>
            <Field value={draft} onChangeText={setDraft} placeholder="Add a comment…" style={{ flex: 1 }} />
            <Button label="Post" onPress={postComment} loading={posting} disabled={!draft.trim()} style={{ paddingHorizontal: spacing.lg }} />
          </View>
        ) : null}
        <View style={{ height: spacing.xxl }} />
      </ScrollView>
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
  author: { color: colors.text, fontWeight: '700', fontSize: font.body },
  sub: { color: colors.textFaint, fontSize: font.tiny },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  result: { fontSize: font.h2, fontWeight: '900', letterSpacing: 1 },
  score: { color: colors.text, fontSize: font.h2, fontWeight: '800', letterSpacing: 1 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs },
  meta: { color: colors.textDim, fontSize: font.small },
  metaScore: { color: colors.primary, fontSize: font.small, fontWeight: '700' },
  notes: { color: colors.textDim, fontStyle: 'italic', marginTop: spacing.xs },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  cardTitle: { color: colors.text, fontWeight: '800', fontSize: font.h3 },
  subhead: { color: colors.textFaint, fontWeight: '700', fontSize: font.tiny, letterSpacing: 0.5, textTransform: 'uppercase' },
  serveRow: { flexDirection: 'row', justifyContent: 'space-between' },
  serveStat: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  commentsTitle: { color: colors.text, fontWeight: '800', fontSize: font.h3 },
  comment: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  commentAuthor: { color: colors.text, fontWeight: '700', fontSize: font.small },
  commentBody: { color: colors.textDim, fontSize: font.body, marginTop: 2 },
  commentInput: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
});

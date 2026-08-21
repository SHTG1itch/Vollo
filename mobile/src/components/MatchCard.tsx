import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import type { MatchCard as MatchCardType } from '../types';
import { formatCount, formatScoreLine, matchOpponentLabel, matchPartnerLabel, timeAgo } from '../utils/format';
import { Avatar } from './ui';
import { KudosButton } from './KudosButton';
import { SurfaceBadge } from './SurfaceBadge';

export function MatchCard({
  match,
  onPress,
  onKudos,
  onPressAuthor,
}: {
  match: MatchCardType;
  onPress: () => void;
  onKudos: () => void;
  onPressAuthor?: () => void;
}) {
  const win = match.result === 'win';
  const opponent = matchOpponentLabel(match);
  const partner = matchPartnerLabel(match);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
      accessibilityRole="button"
      accessibilityLabel={`${win ? 'Win' : 'Loss'}${partner ? ` with ${partner}` : ''} against ${opponent}. ${formatScoreLine(match.score_array)}`}
      accessibilityHint="Opens match details"
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          style={styles.authorRow}
          onPress={onPressAuthor}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`View ${match.author_display_name}'s profile`}
        >
          <Avatar name={match.author_display_name} uri={match.author_avatar_url} size={38} />
          <View>
            <Text style={styles.author}>{match.author_display_name}</Text>
            <Text style={styles.sub}>
              @{match.author_username} · {timeAgo(match.played_at)}
            </Text>
          </View>
        </Pressable>
        <SurfaceBadge surface={match.surface} small />
      </View>

      {/* Headline */}
      {match.title ? <Text style={styles.title}>{match.title}</Text> : null}

      {/* Result + score */}
      <View style={styles.scoreRow}>
        <View style={[styles.resultTag, { backgroundColor: win ? colors.primarySoft : colors.lossSoft }]}>
          <Text style={[styles.resultText, { color: win ? colors.win : colors.loss }]}>
            {win ? 'WIN' : 'LOSS'}
          </Text>
        </View>
        <Text style={styles.score}>{formatScoreLine(match.score_array)}</Text>
        {match.is_tiebreak ? <Text style={styles.tb}>TB</Text> : null}
        {match.verification_status === 'pending' ? <Text style={styles.pending}>⏳ PENDING</Text> : null}
        {match.verification_status === 'rejected' ? <Text style={styles.disputed}>🚫 DISPUTED</Text> : null}
      </View>

      <Text style={styles.vs}>
        {partner ? <>with <Text style={styles.vsName}>{partner}</Text> · </> : null}
        vs <Text style={styles.vsName}>{opponent}</Text>
      </Text>

      {/* Meta row */}
      <View style={styles.metaRow}>
        {match.court_name ? (
          <Text style={styles.meta}>📍 {match.court_name}</Text>
        ) : null}
        {match.rpe_index ? <Text style={styles.meta}>🔥 RPE {match.rpe_index}</Text> : null}
        {match.match_score !== 0 ? (
          <Text style={styles.meta}>
            ⚡ {match.match_score > 0 ? '+' : ''}
            {match.match_score}
          </Text>
        ) : null}
      </View>

      {match.notes ? <Text style={styles.notes}>{match.notes}</Text> : null}

      {/* Proof-of-play photo */}
      {match.photo_url ? (
        <Image source={{ uri: match.photo_url }} style={styles.photo} resizeMode="cover" />
      ) : null}

      {/* Footer */}
      <View style={styles.footer}>
        <KudosButton active={match.viewer_has_kudos ?? false} count={match.kudos_count} onPress={onKudos} />
        <View style={styles.comments}>
          <Text style={styles.commentIcon}>💬</Text>
          <Text style={styles.commentCount}>{formatCount(match.comment_count)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    ...shadow.card,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  author: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  sub: { color: colors.textFaint, fontSize: font.tiny },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: 2 },
  resultTag: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.sm },
  resultText: { fontFamily: fonts.bold, fontSize: font.tiny, letterSpacing: 1 },
  score: { color: colors.text, fontSize: font.h3, fontFamily: fonts.heading, letterSpacing: 1 },
  tb: { color: colors.warning, fontSize: font.tiny, fontFamily: fonts.bold },
  pending: { color: colors.warning, fontSize: font.tiny, fontFamily: fonts.bold, letterSpacing: 0.5 },
  disputed: { color: colors.loss, fontSize: font.tiny, fontFamily: fonts.bold, letterSpacing: 0.5 },
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3, letterSpacing: 0.2 },
  vs: { color: colors.textDim, fontSize: font.small },
  vsName: { color: colors.text, fontFamily: fonts.bold },
  photo: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, marginTop: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: 2 },
  meta: { color: colors.textDim, fontSize: font.small },
  notes: { color: colors.textDim, fontSize: font.small, fontStyle: 'italic' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  comments: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  commentIcon: { fontSize: 15, opacity: 0.7 },
  commentCount: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
});

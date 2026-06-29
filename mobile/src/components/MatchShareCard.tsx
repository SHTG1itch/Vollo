// ── Vollo share card ────────────────────────────────────────────────────────
// A Strava-style "stats sticker": a 9:16 social card that renders a match's
// metrics over the match photo (or a branded court gradient), ready to be
// rasterised by react-native-view-shot and dropped onto an Instagram/Snapchat
// story. A third "sticker" mode renders on a transparent canvas so the metrics
// float as a self-contained panel over the user's own story background.
//
// Every dimension is derived from the `width` prop, so the SAME component renders
// both the on-screen preview and the full-resolution capture with one layout.
import React, { useId } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { TennisBall, VolloWordmark } from './VolloLogo';
import { colors, fonts, surfaceLabel } from '../theme';
import type { MatchCard } from '../types';
import { formatScoreLine } from '../utils/format';

/** Aspect ratio of an Instagram/Snapchat story frame. */
export const SHARE_ASPECT = 16 / 9;

export type ShareVariant = 'photo' | 'court' | 'sticker';

type StatItem = { label: string; value: string };

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatPlayedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The supporting stat blocks (the score is rendered separately as the hero). */
function buildStats(match: MatchCard): StatItem[] {
  const items: StatItem[] = [
    { label: 'Sets', value: `${match.sets_won}–${match.sets_lost}` },
    { label: 'Surface', value: surfaceLabel[match.surface] },
  ];
  if (match.duration_minutes) items.push({ label: 'Duration', value: formatDuration(match.duration_minutes) });
  if (match.rpe_index) items.push({ label: 'Intensity', value: `RPE ${match.rpe_index}` });
  items.push({ label: 'Vollo pts', value: `${match.match_score > 0 ? '+' : ''}${match.match_score}` });
  return items;
}

/**
 * @param width  Card width in px. Height is `width * 16/9`. Drive this from the
 *               preview size for display, or a large value for a crisp capture.
 * @param variant 'photo' (match photo bg), 'court' (branded gradient) or
 *               'sticker' (transparent canvas with a floating panel).
 */
export function MatchShareCard({
  match,
  width,
  variant = 'photo',
  onPhotoLoad,
}: {
  match: MatchCard;
  width: number;
  variant?: ShareVariant;
  /** Fired when the background photo finishes (or fails) loading — used to gate
   *  the capture so we never rasterise a half-loaded photo. */
  onPhotoLoad?: () => void;
}) {
  const uid = useId().replace(/:/g, '');
  const height = Math.round(width * SHARE_ASPECT);
  const win = match.result === 'win';
  const opponent = match.opponent_display_name ?? match.opponent_name ?? null;
  // 'photo' silently falls back to the court gradient when there's no photo.
  const usePhoto = variant === 'photo' && !!match.photo_url;
  const sticker = variant === 'sticker';
  const stats = buildStats(match);

  // Type scale — all proportional to width so preview and capture match exactly.
  const pad = width * 0.07;
  const s = {
    wordmark: width * 0.082,
    pill: width * 0.04,
    title: width * 0.078,
    vs: width * 0.044,
    heroLabel: width * 0.032,
    heroValue: width * 0.115,
    label: width * 0.03,
    value: width * 0.06,
    footer: width * 0.034,
    ball: width * 0.05,
    gap: width * 0.045,
  };
  const resultColor = win ? colors.primary : colors.loss;
  const shadow = sticker
    ? undefined
    : { textShadowColor: 'rgba(0,0,0,0.45)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: width * 0.02 };

  const headline =
    match.title?.trim() ||
    (opponent ? `${win ? 'Win' : 'Loss'} vs ${opponent}` : win ? 'Match win' : 'Match');

  // Header (brand + result) and content (the stats) are composed differently per
  // variant — bottom-anchored in the full-bleed card, stacked in the sticker.
  const header = (
    <View style={styles.topBar}>
      <VolloWordmark size={s.wordmark} color={colors.white} />
      <View
        style={[
          styles.pill,
          {
            backgroundColor: resultColor,
            borderRadius: width,
            paddingHorizontal: width * 0.04,
            paddingVertical: width * 0.014,
          },
        ]}
      >
        <Text allowFontScaling={false} style={[styles.pillText, { fontSize: s.pill, fontFamily: fonts.display }]}>
          {win ? 'WIN' : 'LOSS'}
        </Text>
      </View>
    </View>
  );

  const content = (
    <View style={{ gap: s.gap }}>
      <View style={{ gap: width * 0.012 }}>
        <Text allowFontScaling={false} style={[styles.title, { fontSize: s.title, fontFamily: fonts.display }, shadow]} numberOfLines={2}>
          {headline}
        </Text>
        {opponent && match.title ? (
          <Text allowFontScaling={false} style={[styles.vs, { fontSize: s.vs, fontFamily: fonts.medium }, shadow]} numberOfLines={1}>
            vs {opponent}
          </Text>
        ) : null}
      </View>

      {/* Hero: the score line */}
      <View>
        <Text allowFontScaling={false} style={[styles.label, { fontSize: s.heroLabel }]}>SCORE</Text>
        <Text
          allowFontScaling={false}
          style={[styles.heroValue, { fontSize: s.heroValue, fontFamily: fonts.display }, shadow]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
        >
          {formatScoreLine(match.score_array)}
        </Text>
      </View>

      {/* Supporting stats, two per row */}
      <View style={[styles.grid, { columnGap: s.gap, rowGap: s.gap * 0.8 }]}>
        {stats.map((st) => (
          <View key={st.label} style={styles.statBlock}>
            <Text allowFontScaling={false} style={[styles.label, { fontSize: s.label }]}>{st.label.toUpperCase()}</Text>
            <Text
              allowFontScaling={false}
              style={[styles.value, { fontSize: s.value, fontFamily: fonts.display }, shadow]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {st.value}
            </Text>
          </View>
        ))}
      </View>

      {match.stats && match.stats.rally_short + match.stats.rally_medium + match.stats.rally_long > 0 ? (
        <RallyBar
          short={match.stats.rally_short}
          medium={match.stats.rally_medium}
          long={match.stats.rally_long}
          width={width}
        />
      ) : null}

      <View style={[styles.footer, { gap: width * 0.02, marginTop: width * 0.01 }]}>
        <TennisBall size={s.ball} />
        <Text allowFontScaling={false} style={[styles.footerText, { fontSize: s.footer }]} numberOfLines={1}>
          {match.court_name ? `${match.court_name} · ` : ''}
          {formatPlayedAt(match.played_at)}
        </Text>
        <View style={{ flex: 1, minWidth: width * 0.02 }} />
        <Text allowFontScaling={false} style={[styles.footerBrand, { fontSize: s.footer }]} numberOfLines={1}>
          tracked on Vollo
        </Text>
      </View>
    </View>
  );

  if (sticker) {
    // Transparent canvas: the content lives in a rounded translucent panel so it
    // stays legible dropped onto any story background.
    return (
      <View style={{ width, height, justifyContent: 'center', backgroundColor: 'transparent' }}>
        <View style={[styles.stickerPanel, { padding: pad, borderRadius: width * 0.08, gap: s.gap }]}>
          {header}
          {content}
        </View>
      </View>
    );
  }

  return (
    <View style={{ width, height, backgroundColor: colors.black, overflow: 'hidden' }}>
      {usePhoto ? (
        <Image source={{ uri: match.photo_url! }} style={StyleSheet.absoluteFill} resizeMode="cover" onLoadEnd={onPhotoLoad} />
      ) : (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={`court${uid}`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={colors.primary} />
              <Stop offset="0.55" stopColor={colors.primaryDim} />
              <Stop offset="1" stopColor="#06351A" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={width} height={height} fill={`url(#court${uid})`} />
        </Svg>
      )}

      {/* Scrim so text stays legible over any photo — darken the bottom (stats)
          and, over a real photo, the top (wordmark) too. */}
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id={`scrim${uid}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={usePhoto ? 0.45 : 0} />
            <Stop offset="0.2" stopColor="#000000" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={usePhoto ? 0.9 : 0.7} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill={`url(#scrim${uid})`} />
      </Svg>

      <View style={{ flex: 1, padding: pad }}>
        {header}
        <View style={{ flex: 1 }} />
        {content}
      </View>
    </View>
  );
}

/** A slim three-segment rally-length distribution bar for the card. */
function RallyBar({
  short,
  medium,
  long,
  width,
}: {
  short: number;
  medium: number;
  long: number;
  width: number;
}) {
  const total = short + medium + long || 1;
  const h = width * 0.022;
  const seg = (n: number, color: string) =>
    n > 0 ? <View key={color} style={{ flex: n / total, backgroundColor: color }} /> : null;
  return (
    <View style={{ gap: width * 0.012 }}>
      <Text allowFontScaling={false} style={[styles.label, { fontSize: width * 0.03 }]}>RALLY LENGTH</Text>
      <View style={{ flexDirection: 'row', height: h, borderRadius: h, overflow: 'hidden' }}>
        {seg(short, colors.primary)}
        {seg(medium, colors.accent)}
        {seg(long, colors.warning)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { alignItems: 'center', justifyContent: 'center' },
  pillText: { color: colors.white, letterSpacing: 1 },
  title: { color: colors.white, letterSpacing: 0.2 },
  vs: { color: 'rgba(255,255,255,0.82)' },
  label: { color: 'rgba(255,255,255,0.62)', fontFamily: fonts.bold, letterSpacing: 1 },
  heroValue: { color: colors.white, letterSpacing: 0.5 },
  value: { color: colors.white },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  statBlock: { width: '46%' },
  footer: { flexDirection: 'row', alignItems: 'center' },
  footerText: { color: 'rgba(255,255,255,0.8)', fontFamily: fonts.medium, flexShrink: 1 },
  footerBrand: { color: colors.accent, fontFamily: fonts.bold },
  stickerPanel: {
    backgroundColor: 'rgba(11,19,13,0.86)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'rgba(255,255,255,0.12)',
  },
});

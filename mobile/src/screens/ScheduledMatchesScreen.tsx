import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Avatar, Button, Card, EmptyState, ErrorState } from '../components/ui';
import { showToast } from '../components/Toast';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { ScheduledMatchCard } from '../types';
import { formatSchedule, formatScoreLine } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const STATUS_META: Record<ScheduledMatchCard['status'], { label: string; color: string }> = {
  proposed: { label: 'Proposed', color: colors.warning },
  accepted: { label: 'Accepted', color: colors.primary },
  completed: { label: 'Played', color: colors.textDim },
  declined: { label: 'Declined', color: colors.loss },
  cancelled: { label: 'Cancelled', color: colors.textFaint },
};

/** The player on the other side of a scheduled match, from the viewer's seat. */
function otherSide(s: ScheduledMatchCard): { id: string | null; name: string; username: string | null } {
  if (s.viewer_role === 'creator') {
    return {
      id: s.opponent_id,
      name: s.opponent_display_name ?? s.opponent_name ?? 'Opponent',
      username: s.opponent_username,
    };
  }
  return { id: s.creator_id, name: s.creator_display_name, username: s.creator_username };
}

export function ScheduledMatchesScreen() {
  const navigation = useNavigation<Nav>();
  const [items, setItems] = useState<ScheduledMatchCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const { scheduled_matches } = await api.getScheduledMatches();
      setItems(scheduled_matches);
      setLoadError(false);
    } catch {
      // Keep whatever we have, but surface the failure when there's nothing to show.
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const respond = async (s: ScheduledMatchCard, action: 'accept' | 'decline' | 'cancel') => {
    setBusyId(s.id);
    try {
      const { scheduled_match } = await api.respondToScheduledMatch(s.id, action);
      setItems((prev) => prev.map((x) => (x.id === s.id ? scheduled_match : x)));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not update — try again', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const logResult = (s: ScheduledMatchCard) => {
    const other = otherSide(s);
    navigation.navigate('Tabs', {
      screen: 'Log',
      params: {
        ...(other.id ? { prefillOpponentId: other.id } : { prefillOpponentName: other.name }),
        ...(s.court_id ? { prefillCourtId: s.court_id } : {}),
        ...(s.surface ? { prefillSurface: s.surface } : {}),
        scheduledMatchId: s.id,
      },
    });
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (items.length === 0 && loadError) {
    return (
      <ErrorState
        message="Couldn't load your matches."
        onRetry={() => {
          setLoading(true);
          void load();
        }}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="⚔️"
        title="No matches yet"
        subtitle="Open a player's profile and tap “Challenge” to line one up."
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
          tintColor={colors.primary}
        />
      }
    >
      {items.map((s) => {
        const other = otherSide(s);
        const meta = STATUS_META[s.status];
        const canRespond = s.status === 'proposed' && s.viewer_role === 'opponent';
        const awaiting = s.status === 'proposed' && s.viewer_role === 'creator';
        const busy = busyId === s.id;
        return (
          <Card key={s.id} style={{ gap: spacing.md }}>
            <View style={styles.row}>
              <Avatar name={other.name} uri={s.viewer_role === 'creator' ? s.opponent_avatar_url : s.creator_avatar_url} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{s.is_challenge ? '⚔️ ' : ''}{other.name}</Text>
                <Text style={styles.when}>{formatSchedule(s.scheduled_at)}</Text>
                <View style={styles.metaRow}>
                  {s.is_challenge ? <Text style={styles.challengeTag}>CHALLENGE</Text> : null}
                  {s.surface ? <SurfaceBadge surface={s.surface} small /> : null}
                  {s.court_name ? <Text style={styles.court}>📍 {s.court_name}</Text> : null}
                </View>
              </View>
              <View style={[styles.statusPill, { borderColor: meta.color }]}>
                <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
              </View>
            </View>

            {s.note ? <Text style={styles.note}>“{s.note}”</Text> : null}

            {s.status === 'completed' && s.result_score ? (
              <View style={styles.scoreBox}>
                <Text style={styles.scoreLabel}>Final score</Text>
                <Text style={styles.score}>{formatScoreLine(s.result_score)}</Text>
              </View>
            ) : null}

            {canRespond ? (
              <View style={styles.actions}>
                <Button label="Decline" variant="secondary" onPress={() => respond(s, 'decline')} loading={busy} style={{ flex: 1, height: 42 }} />
                <Button label="Accept" onPress={() => respond(s, 'accept')} loading={busy} style={{ flex: 1, height: 42 }} />
              </View>
            ) : null}

            {awaiting ? <Text style={styles.awaiting}>Waiting for {other.name} to respond…</Text> : null}

            {s.status === 'accepted' ? (
              <View style={styles.actions}>
                <Button label="Cancel" variant="ghost" onPress={() => respond(s, 'cancel')} loading={busy} style={{ flex: 1, height: 42 }} />
                <Button label="Log result" onPress={() => logResult(s)} style={{ flex: 1, height: 42 }} />
              </View>
            ) : null}

            {awaiting ? (
              <Pressable onPress={() => respond(s, 'cancel')} disabled={busy} style={{ alignSelf: 'flex-start' }}>
                <Text style={styles.cancelLink}>Cancel proposal</Text>
              </Pressable>
            ) : null}
          </Card>
        );
      })}
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  when: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.small, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4 },
  court: { color: colors.textDim, fontSize: font.tiny },
  challengeTag: { color: colors.loss, fontSize: font.tiny, fontFamily: fonts.bold, letterSpacing: 0.5 },
  statusPill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  statusText: { fontSize: font.tiny, fontFamily: fonts.bold },
  note: { color: colors.textDim, fontSize: font.small, fontStyle: 'italic' },
  scoreBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, gap: 2 },
  scoreLabel: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
  score: { color: colors.text, fontFamily: fonts.display, fontSize: font.h3 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  awaiting: { color: colors.textDim, fontSize: font.small },
  cancelLink: { color: colors.loss, fontSize: font.small, fontFamily: fonts.bold },
});

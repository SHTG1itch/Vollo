import React, { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { navigateFromPush } from '../navigation/ref';
import { api } from '../api/client';
import { useNotifications } from '../store/notifications';
import { Avatar, Button, EmptyState, ErrorState, Loading, Muted } from '../components/ui';
import { showToast } from '../components/Toast';
import { tapMedium } from '../lib/haptics';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import { timeAgo } from '../utils/format';
import type { FollowRequest } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Incoming follow requests (private accounts) pinned above the activity list. */
function FollowRequestsCard({
  requests,
  loading,
  error,
  onRetry,
  onResolved,
}: {
  requests: FollowRequest[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onResolved: (requestId: string) => void;
}) {
  const navigation = useNavigation<Nav>();
  // Track which request AND which button is in flight, so Accept and Decline
  // each get their own loading spinner.
  const [busy, setBusy] = useState<{ id: string; action: 'accept' | 'decline' } | null>(null);
  const responseActive = React.useRef(false);

  if (requests.length === 0 && !loading && !error) return null;

  const respond = async (r: FollowRequest, action: 'accept' | 'decline') => {
    if (responseActive.current || busy) return;
    responseActive.current = true;
    tapMedium();
    setBusy({ id: r.id, action });
    try {
      await api.respondFollowRequest(r.id, action);
      onResolved(r.id);
      if (action === 'accept') showToast(`@${r.username} can now see your matches.`, 'success');
    } catch {
      showToast('Could not update the request — please try again.', 'error');
    } finally {
      responseActive.current = false;
      setBusy(null);
    }
  };

  return (
    <View style={styles.requestsCard}>
      <Text style={styles.requestsTitle}>FOLLOW REQUESTS</Text>
      {loading ? <Muted style={{ textAlign: 'left' }}>Loading follow requests…</Muted> : null}
      {error ? (
        <View style={styles.requestLoadError} accessibilityLiveRegion="assertive">
          <Muted style={{ textAlign: 'left' }}>{error}</Muted>
          <Button label="Try again" variant="secondary" onPress={onRetry} />
        </View>
      ) : null}
      {requests.map((r) => (
        <View key={r.id} style={styles.requestRow}>
          <Pressable
            style={styles.requestUser}
            onPress={() => navigation.navigate('UserProfile', { username: r.username })}
            accessibilityRole="button"
          >
            <Avatar name={r.display_name} uri={r.avatar_url} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={styles.requestName} numberOfLines={1}>{r.display_name}</Text>
              <Text style={styles.requestMeta}>@{r.username} · {timeAgo(r.requested_at)}</Text>
            </View>
          </Pressable>
          <Button
            label="Accept"
            onPress={() => respond(r, 'accept')}
            loading={busy?.id === r.id && busy.action === 'accept'}
            disabled={busy !== null}
            style={styles.requestBtn}
          />
          <Button
            label="Decline"
            variant="ghost"
            onPress={() => respond(r, 'decline')}
            loading={busy?.id === r.id && busy.action === 'decline'}
            disabled={busy !== null}
            style={styles.requestBtn}
          />
        </View>
      ))}
    </View>
  );
}

export function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { items, loading, refreshing, error, fetch, markAllRead } = useNotifications();
  const [requests, setRequests] = useState<FollowRequest[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const requestSequence = React.useRef(0);

  const loadFollowRequests = React.useCallback(async () => {
    const sequence = ++requestSequence.current;
    setRequestsLoading(true);
    setRequestsError(null);
    try {
      const response = await api.getFollowRequests();
      if (sequence === requestSequence.current) setRequests(response.requests);
    } catch {
      if (sequence === requestSequence.current) setRequestsError('Could not load follow requests.');
    } finally {
      if (sequence === requestSequence.current) setRequestsLoading(false);
    }
  }, []);

  // Refetch every time the tab gains focus so the badge/list reflect reality,
  // then mark everything read shortly after. The mark-read timer starts only
  // once the fetch has resolved — running them concurrently let a slow fetch
  // land after the optimistic mark-read and resurrect the unread badge.
  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      let t: ReturnType<typeof setTimeout> | undefined;
      void fetch().then(() => {
        if (!cancelled) t = setTimeout(() => void markAllRead(), 1200);
      });
      // Pending follow requests ride along with each focus refresh.
      void loadFollowRequests();
      return () => {
        cancelled = true;
        requestSequence.current += 1;
        if (t) clearTimeout(t);
      };
    }, [fetch, loadFollowRequests, markAllRead]),
  );

  // Route a tapped notification to the relevant screen using its data payload.
  const openTarget = (data: Record<string, unknown> | null | undefined) => {
    navigateFromPush(data);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Text style={styles.title}>Activity</Text>
      {error && items.length === 0 ? (
        <ErrorState message={error} onRetry={() => fetch()} />
      ) : loading && items.length === 0 ? (
        <Loading label="Loading activity…" />
      ) : (
        <FlashList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          ListHeaderComponent={
            <FollowRequestsCard
              requests={requests}
              loading={requestsLoading}
              error={requestsError}
              onRetry={() => void loadFollowRequests()}
              onResolved={(requestId) => setRequests((list) => list.filter((r) => r.id !== requestId))}
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void fetch(true);
                void loadFollowRequests();
              }}
              tintColor={colors.primary}
            />
          }
          renderItem={({ item }) => {
            const data = item.data as Record<string, unknown> | null | undefined;
            const tappable =
              typeof data?.matchId === 'string' ||
              typeof data?.courtId === 'string' ||
              typeof data?.scheduledMatchId === 'string' ||
              typeof data?.username === 'string';
            return (
              <Pressable
                disabled={!tappable}
                onPress={() => openTarget(data)}
                style={({ pressed }) => [styles.row, !item.read && styles.unread, pressed && tappable && { opacity: 0.85 }]}
                accessibilityRole={tappable ? 'button' : undefined}
                accessibilityLabel={tappable ? `${item.title}. ${item.body}` : undefined}
                accessibilityHint={tappable ? 'Opens related activity' : undefined}
              >
                {!item.read ? <View style={styles.dot} /> : <View style={styles.dotPlaceholder} />}
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{item.title}</Text>
                  <Text style={styles.rowBody}>{item.body}</Text>
                  <Text style={styles.rowTime}>{timeAgo(item.created_at)}</Text>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={<EmptyState icon="🔔" title="No activity yet" subtitle="Kudos, comments and territory battles will show up here." />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display, padding: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  unread: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginTop: 6 },
  dotPlaceholder: { width: 8 },
  rowTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  rowBody: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  rowTime: { color: colors.textFaint, fontSize: font.tiny, marginTop: 4 },
  requestsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    gap: spacing.md,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  requestsTitle: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.tiny, letterSpacing: 0.5 },
  requestLoadError: { gap: spacing.sm, alignItems: 'flex-start' },
  requestRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  requestUser: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  requestName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  requestMeta: { color: colors.textFaint, fontSize: font.tiny },
  requestBtn: { height: 34, paddingHorizontal: spacing.md },
});

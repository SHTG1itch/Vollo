import React from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useNotifications } from '../store/notifications';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { colors, font, radius, shadow, spacing } from '../theme';
import { timeAgo } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function NotificationsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { items, loading, error, fetch, markAllRead } = useNotifications();

  // Refetch every time the tab gains focus so the badge/list reflect reality,
  // then mark everything read shortly after.
  useFocusEffect(
    React.useCallback(() => {
      void fetch();
      const t = setTimeout(() => void markAllRead(), 1200);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Route a tapped notification to the relevant screen using its data payload.
  const openTarget = (data: Record<string, unknown> | null | undefined) => {
    const matchId = typeof data?.matchId === 'string' ? data.matchId : null;
    const courtId = typeof data?.courtId === 'string' ? data.courtId : null;
    if (matchId) navigation.navigate('MatchDetail', { matchId });
    else if (courtId) navigation.navigate('Court', { courtId });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Text style={styles.title}>Activity</Text>
      {error && items.length === 0 ? (
        <ErrorState message={error} onRetry={() => fetch()} />
      ) : loading && items.length === 0 ? (
        <Loading label="Loading activity…" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, gap: spacing.sm }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => fetch()} tintColor={colors.primary} />}
          renderItem={({ item }) => {
            const data = item.data as Record<string, unknown> | null | undefined;
            const tappable = typeof data?.matchId === 'string' || typeof data?.courtId === 'string';
            return (
              <Pressable
                disabled={!tappable}
                onPress={() => openTarget(data)}
                style={({ pressed }) => [styles.row, !item.read && styles.unread, pressed && tappable && { opacity: 0.85 }]}
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
  title: { color: colors.text, fontSize: font.h1, fontWeight: '800', padding: spacing.lg },
  row: { flexDirection: 'row', gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  unread: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginTop: 6 },
  dotPlaceholder: { width: 8 },
  rowTitle: { color: colors.text, fontWeight: '700', fontSize: font.body },
  rowBody: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  rowTime: { color: colors.textFaint, fontSize: font.tiny, marginTop: 4 },
});

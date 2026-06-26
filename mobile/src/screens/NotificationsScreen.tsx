import React, { useEffect } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useNotifications } from '../store/notifications';
import { EmptyState } from '../components/ui';
import { colors, font, radius, shadow, spacing } from '../theme';
import { timeAgo } from '../utils/format';

export function NotificationsScreen() {
  const { items, loading, fetch, markAllRead } = useNotifications();

  useEffect(() => {
    void fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mark everything read shortly after the screen gains focus.
  useFocusEffect(
    React.useCallback(() => {
      const t = setTimeout(() => void markAllRead(), 1200);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Text style={styles.title}>Activity</Text>
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, gap: spacing.sm }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => fetch()} tintColor={colors.primary} />}
        renderItem={({ item }) => (
          <View style={[styles.row, !item.read && styles.unread]}>
            {!item.read ? <View style={styles.dot} /> : <View style={styles.dotPlaceholder} />}
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.title}</Text>
              <Text style={styles.rowBody}>{item.body}</Text>
              <Text style={styles.rowTime}>{timeAgo(item.created_at)}</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="🔔" title="No activity yet" subtitle="Kudos, comments and territory battles will show up here." />}
      />
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

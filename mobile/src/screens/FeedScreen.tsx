import React, { useEffect } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useFeed } from '../store/feed';
import { useAuth } from '../store/auth';
import { MatchCard } from '../components/MatchCard';
import { EmptyState, ErrorState, SegmentedControl } from '../components/ui';
import { FeedSkeleton } from '../components/Skeleton';
import { VolloWordmark } from '../components/VolloLogo';
import { colors, radius, spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function FeedScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { matches, scope, loading, refreshing, loadingMore, error, fetch, loadMore, setScope, toggleKudos } = useFeed();
  const user = useAuth((s) => s.user);

  useEffect(() => {
    // Always load on first mount — guarding on matches.length meant a single
    // locally-prepended match could permanently hide the global feed.
    void fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <VolloWordmark size={28} />
          <Pressable
            onPress={() => navigation.navigate('UserSearch')}
            hitSlop={8}
            style={styles.searchBtn}
            accessibilityRole="button"
            accessibilityLabel="Find players"
          >
            <Text style={styles.searchIcon}>🔍</Text>
          </Pressable>
        </View>
        <SegmentedControl
          options={[
            { label: 'Global', value: 'global' },
            { label: 'Following', value: 'following' },
          ]}
          value={scope}
          onChange={(v) => setScope(v)}
        />
      </View>

      {loading && matches.length === 0 ? (
        <FeedSkeleton />
      ) : error && matches.length === 0 ? (
        <ErrorState message={error} onRetry={() => fetch()} />
      ) : (
        <FlashList
          data={matches}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetch(true)} tintColor={colors.primary} />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => loadMore()}
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: spacing.lg }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <MatchCard
              match={item}
              onPress={() => navigation.navigate('MatchDetail', { matchId: item.id })}
              onKudos={() => toggleKudos(item.id)}
              onPressAuthor={() =>
                item.author_username === user?.username
                  ? navigation.navigate('Tabs', { screen: 'Me' })
                  : navigation.navigate('UserProfile', { username: item.author_username })
              }
            />
          )}
          ListEmptyComponent={
            <EmptyState
              title={scope === 'following' ? 'No matches from people you follow yet' : 'No matches yet'}
              subtitle={scope === 'following' ? 'Follow players to see their matches here.' : 'Log your first match to get started.'}
              action={
                scope === 'following'
                  ? { label: 'Find players', onPress: () => navigation.navigate('UserSearch') }
                  : { label: 'Log a match', onPress: () => navigation.navigate('Tabs', { screen: 'Log' }) }
              }
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  searchBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchIcon: { fontSize: 16 },
  list: { padding: spacing.lg, paddingTop: 0 },
});

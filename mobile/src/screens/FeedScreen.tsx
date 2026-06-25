import React, { useEffect } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useFeed } from '../store/feed';
import { useAuth } from '../store/auth';
import { MatchCard } from '../components/MatchCard';
import { EmptyState, Loading, SegmentedControl } from '../components/ui';
import { colors, font, spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function FeedScreen() {
  const navigation = useNavigation<Nav>();
  const { matches, scope, loading, refreshing, fetch, loadMore, setScope, toggleKudos } = useFeed();
  const user = useAuth((s) => s.user);

  useEffect(() => {
    if (matches.length === 0) void fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Feed</Text>
        <View style={{ width: 200 }}>
          <SegmentedControl
            options={[
              { label: 'Global', value: 'global' },
              { label: 'Following', value: 'following' },
            ]}
            value={scope}
            onChange={(v) => setScope(v)}
          />
        </View>
      </View>

      {loading && matches.length === 0 ? (
        <Loading label="Loading matches…" />
      ) : (
        <FlashList
          data={matches}
          keyExtractor={(m) => m.id}
          estimatedItemSize={220}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetch(true)} tintColor={colors.primary} />
          }
          onEndReachedThreshold={0.5}
          onEndReached={() => loadMore()}
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
    paddingBottom: spacing.md,
    gap: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: colors.text, fontSize: font.h1, fontWeight: '800' },
  list: { padding: spacing.lg, paddingTop: 0 },
});

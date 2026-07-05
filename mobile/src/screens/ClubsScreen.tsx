import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { Button, Card, EmptyState, ErrorState, Field, Loading, SegmentedControl } from '../components/ui';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { Club } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Scope = 'mine' | 'discover';

function ClubRow({ club, onPress }: { club: Club; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Card style={styles.clubRow}>
        <View style={styles.clubBadge}>
          <Text style={{ fontSize: 20 }}>🏟️</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.clubName}>{club.name}</Text>
          <Text style={styles.clubMeta}>
            {club.member_count} {club.member_count === 1 ? 'member' : 'members'}
            {club.city ? ` · ${club.city}` : ''}
          </Text>
          {club.description ? (
            <Text style={styles.clubDesc} numberOfLines={2}>
              {club.description}
            </Text>
          ) : null}
        </View>
        {club.viewer_is_member ? <Text style={styles.memberTag}>Joined</Text> : null}
      </Card>
    </Pressable>
  );
}

export function ClubsScreen() {
  const navigation = useNavigation<Nav>();
  const [scope, setScope] = useState<Scope>('mine');
  const [mine, setMine] = useState<Club[] | null>(null);
  const [found, setFound] = useState<Club[] | null>(null);
  const [q, setQ] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A failed fetch with nothing loaded shows an error state, not a false
  // "no clubs" empty state; with data already on screen it keeps the stale list.
  const [mineError, setMineError] = useState(false);
  const [foundError, setFoundError] = useState(false);

  const loadMine = useCallback(() => {
    void api
      .getMyClubs()
      .then((r) => {
        setMine(r.clubs);
        setMineError(false);
      })
      .catch(() => setMineError(true));
  }, []);

  const search = useCallback((term: string) => {
    void api
      .getClubs(term || undefined)
      .then((r) => {
        setFound(r.clubs);
        setFoundError(false);
      })
      .catch(() => setFoundError(true));
  }, []);

  // Refresh on focus so joins/leaves/creations made deeper in the stack show up.
  useFocusEffect(
    useCallback(() => {
      loadMine();
      if (scope === 'discover') search(q.trim());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadMine, scope]),
  );

  useEffect(() => {
    if (scope !== 'discover') return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => search(q.trim()), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, scope, search]);

  const data = scope === 'mine' ? mine : found;
  const loadFailed = scope === 'mine' ? mineError : foundError;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <SegmentedControl
          options={[
            { label: 'My clubs', value: 'mine' as Scope },
            { label: 'Discover', value: 'discover' as Scope },
          ]}
          value={scope}
          onChange={setScope}
        />
        {scope === 'discover' ? (
          <Field
            placeholder="Search clubs by name or city"
            value={q}
            onChangeText={setQ}
            autoCapitalize="none"
            returnKeyType="search"
          />
        ) : null}
      </View>

      {data === null && loadFailed ? (
        <ErrorState
          message="Couldn't load clubs — check your connection."
          onRetry={() => (scope === 'mine' ? loadMine() : search(q.trim()))}
        />
      ) : data === null ? (
        <Loading />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          renderItem={({ item }) => (
            <ClubRow club={item} onPress={() => navigation.navigate('Club', { clubId: item.id })} />
          )}
          ListEmptyComponent={
            scope === 'mine' ? (
              <EmptyState
                icon="🏟️"
                title="No clubs yet"
                subtitle="Join a club to compete with friends, or start your own."
                action={{ label: 'Discover clubs', onPress: () => setScope('discover') }}
              />
            ) : (
              <EmptyState
                icon="🏟️"
                title={q ? 'No clubs found' : 'No clubs yet'}
                subtitle={q ? 'Try a different name or city.' : 'Be the first to start one.'}
              />
            )
          }
        />
      )}

      <View style={styles.footer}>
        <Button label="Start a club" onPress={() => navigation.navigate('CreateClub')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  list: { padding: spacing.lg, paddingBottom: 90 },
  footer: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
  },
  clubRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  clubBadge: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clubName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  clubMeta: { color: colors.textFaint, fontSize: font.tiny, marginTop: 1 },
  clubDesc: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  memberTag: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.tiny },
});

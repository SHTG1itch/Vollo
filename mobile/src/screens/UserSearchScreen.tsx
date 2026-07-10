import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, type UserSearchResult } from '../api/client';
import { Avatar, Button, EmptyState, ErrorState, Field, Screen } from '../components/ui';
import { Icon } from '../components/icons';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Find players by name/username to follow — Vollo's athlete-discovery flow. */
export function UserSearchScreen() {
  const navigation = useNavigation<Nav>();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState(false);
  const token = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = async (term: string) => {
    const t = ++token.current; // ignore out-of-order responses
    const query = term.trim();
    if (!query) {
      setResults([]);
      setSearched(false);
      setError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const { users } = await api.searchUsers(query);
      if (t === token.current) {
        setResults(users);
        setSearched(true);
      }
    } catch {
      // A failed request is NOT "no such player" — mark it as an error so the
      // user can retry rather than wrongly concluding the account doesn't exist.
      if (t === token.current) {
        setResults([]);
        setSearched(true);
        setError(true);
      }
    } finally {
      if (t === token.current) setLoading(false);
    }
  };

  // Debounce keystrokes so we don't fire a request per character.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void run(q), 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  const patchResult = (id: string, patch: Partial<UserSearchResult>) =>
    setResults((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // Per-row in-flight guard so a double-tap can't race follow/unfollow calls.
  const [followBusy, setFollowBusy] = useState<Record<string, boolean>>({});

  const toggleFollow = async (u: UserSearchResult) => {
    if (followBusy[u.id]) return;
    setFollowBusy((b) => ({ ...b, [u.id]: true }));
    const was = { viewer_is_following: u.viewer_is_following, viewer_has_requested: u.viewer_has_requested };
    try {
      if (u.viewer_is_following || u.viewer_has_requested) {
        // Unfollow, or withdraw a pending request — same DELETE.
        patchResult(u.id, { viewer_is_following: false, viewer_has_requested: false });
        await api.unfollow(u.username);
      } else {
        const res = await api.follow(u.username);
        patchResult(u.id, {
          viewer_is_following: res.status === 'following',
          viewer_has_requested: res.status === 'requested',
        });
      }
    } catch {
      patchResult(u.id, was);
    } finally {
      setFollowBusy((b) => {
        const { [u.id]: _done, ...rest } = b;
        return rest;
      });
    }
  };

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <Icon name="chevron-left" size={26} color={colors.primary} strokeWidth={2.4} />
        </Pressable>
        <Field
          value={q}
          onChangeText={setQ}
          placeholder="Search players by name or @username"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          style={{ flex: 1 }}
        />
      </View>

      <FlatList
        data={results}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, gap: spacing.sm }}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.9 }]}
            onPress={() => navigation.navigate('UserProfile', { username: item.username })}
          >
            <Avatar name={item.display_name} uri={item.avatar_url} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.display_name}</Text>
              <Text style={styles.handle}>@{item.username}</Text>
            </View>
            <Button
              label={item.viewer_is_following ? 'Following' : item.viewer_has_requested ? 'Requested' : 'Follow'}
              variant={item.viewer_is_following || item.viewer_has_requested ? 'secondary' : 'primary'}
              onPress={() => toggleFollow(item)}
              loading={!!followBusy[item.id]}
              disabled={!!followBusy[item.id]}
              style={{ height: 36, paddingHorizontal: spacing.md }}
            />
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: spacing.xxl }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : error ? (
            <View style={{ paddingTop: spacing.xxl }}>
              <ErrorState
                title="Search failed"
                message="Check your connection and try again."
                onRetry={() => void run(q)}
              />
            </View>
          ) : searched ? (
            <EmptyState icon="🔍" title="No players found" subtitle="Try a different name or username." />
          ) : (
            <EmptyState icon="🔍" title="Find players" subtitle="Search by name or @username to follow rivals." />
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.lg, paddingBottom: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  handle: { color: colors.textFaint, fontSize: font.small, marginTop: 2 },
});

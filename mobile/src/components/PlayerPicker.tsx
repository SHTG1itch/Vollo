import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api, type UserSearchResult } from '../api/client';
import { colors, font, fonts, spacing } from '../theme';
import { Avatar, Button, Field, Muted } from './ui';

export type PlayerSelection = {
  id: string | null;
  name: string;
  username?: string;
  avatarUrl?: string | null;
};

export function PlayerPicker({
  value,
  onChange,
  placeholder,
  excludedIds = [],
}: {
  value: PlayerSelection;
  onChange: (value: PlayerSelection) => void;
  placeholder: string;
  excludedIds?: string[];
}) {
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searchError, setSearchError] = useState(false);
  const token = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
    token.current += 1;
  }, []);

  useEffect(() => {
    if (!value.id) return;
    if (debounce.current) clearTimeout(debounce.current);
    token.current += 1;
    setResults([]);
    setSearchError(false);
  }, [value.id]);

  const search = (term: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    const current = ++token.current;
    const query = term.trim();
    setSearchError(false);
    if (query.length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const response = await api.searchUsers(query, 8);
        if (current === token.current) {
          setResults(response.users.filter((user) => !excludedIds.includes(user.id)).slice(0, 6));
          setSearchError(false);
        }
      } catch {
        if (current === token.current) {
          setResults([]);
          setSearchError(true);
        }
      }
    }, 300);
  };

  if (value.id) {
    return (
      <View style={styles.chip}>
        <Avatar name={value.name} uri={value.avatarUrl} size={28} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{value.name}</Text>
          {value.username ? <Text style={styles.handle}>@{value.username}</Text> : null}
        </View>
        <Pressable
          onPress={() => {
            setResults([]);
            setSearchError(false);
            onChange({ id: null, name: '' });
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${value.name}`}
        >
          <Text style={styles.remove}>×</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <Field
        value={value.name}
        onChangeText={(name) => {
          onChange({ id: null, name });
          search(name);
        }}
        placeholder={placeholder}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={60}
      />
      {value.name.trim().length >= 2 ? results.filter((user) => !excludedIds.includes(user.id)).map((user) => (
        <Pressable
          key={user.id}
          onPress={() => {
            token.current += 1;
            setResults([]);
            setSearchError(false);
            onChange({
              id: user.id,
              name: user.display_name,
              username: user.username,
              avatarUrl: user.avatar_url,
            });
          }}
          style={styles.result}
          accessibilityRole="button"
          accessibilityLabel={`Select ${user.display_name}, @${user.username}`}
        >
          <Avatar name={user.display_name} uri={user.avatar_url} size={28} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{user.display_name}</Text>
            <Text style={styles.handle}>@{user.username}</Text>
          </View>
        </Pressable>
      )) : null}
      {searchError && value.name.trim().length >= 2 ? (
        <View style={{ gap: spacing.sm }} accessibilityLiveRegion="assertive">
          <Muted style={{ textAlign: 'left' }}>
            Player search is unavailable. Retry before continuing if this player uses Vollo.
          </Muted>
          <Button label="Retry player search" variant="secondary" onPress={() => search(value.name)} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  handle: { color: colors.textFaint, fontSize: font.tiny },
  remove: { color: colors.textDim, fontSize: 18, paddingHorizontal: spacing.xs },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});

import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, Field, Muted } from '../components/ui';
import { colors, font, radius, spacing } from '../theme';
import type { GeocodeResult } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'EditProfile'>;

export function EditProfileScreen({ navigation }: Props) {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);

  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url ?? '');
  const [hand, setHand] = useState<'right' | 'left'>(user?.dominant_hand ?? 'right');
  const [homeQuery, setHomeQuery] = useState(user?.home_label ?? '');
  const [home, setHome] = useState<GeocodeResult | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [saving, setSaving] = useState(false);

  const findHome = async () => {
    if (!homeQuery.trim()) return;
    try {
      const { results: r } = await api.geocode(homeQuery.trim());
      setResults(r);
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { display_name: displayName.trim(), bio: bio.trim(), dominant_hand: hand };
      const trimmedAvatar = avatarUrl.trim();
      if (trimmedAvatar) body.avatar_url = trimmedAvatar;
      if (home) body.home = { lat: home.lat, lng: home.lng, label: home.label };
      const { user: updated } = await api.updateProfile(body);
      setUser(updated);
      navigation.goBack();
    } catch (e) {
      Alert.alert('Save failed', e instanceof ApiError ? e.message : 'Try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.md }}>
        <View style={styles.avatarRow}>
          <Avatar name={displayName || user?.username || '🎾'} uri={avatarUrl.trim() || null} size={64} />
          <View style={{ flex: 1 }}>
            <Field label="Avatar image URL" value={avatarUrl} onChangeText={setAvatarUrl} placeholder="https://…/photo.jpg" autoCapitalize="none" autoCorrect={false} />
          </View>
        </View>
        <Field label="Display name" value={displayName} onChangeText={setDisplayName} />
        <Field label="Bio" value={bio} onChangeText={setBio} placeholder="Tell players about your game" multiline style={{ height: 80, paddingTop: spacing.sm }} />
        <View style={{ gap: spacing.xs }}>
          <Text style={styles.label}>Dominant hand</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {(['right', 'left'] as const).map((h) => (
              <Pressable key={h} onPress={() => setHand(h)} style={[styles.handChip, hand === h && styles.handChipActive]}>
                <Text style={[styles.handText, hand === h && styles.handTextActive]}>{h === 'right' ? 'Right' : 'Left'}-handed</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={{ gap: spacing.xs }}>
          <Field
            label="Home base"
            value={homeQuery}
            onChangeText={(t) => {
              setHomeQuery(t);
              // Clear a previously-picked location so edited-but-unconfirmed text
              // can't be saved with stale coordinates.
              setHome(null);
            }}
            placeholder="Your city"
            onSubmitEditing={findHome}
          />
          <Button label="Find" variant="secondary" onPress={findHome} style={{ height: 40 }} />
          {results.map((r, i) => (
            <Pressable key={i} onPress={() => { setHome(r); setHomeQuery(r.label); setResults([]); }} style={styles.result}>
              <Text style={styles.resultText} numberOfLines={2}>{r.label}</Text>
            </Pressable>
          ))}
          {home ? <Muted>Home set to {home.city ?? home.label}</Muted> : null}
        </View>
      </Card>
      <Button label="Save" onPress={save} loading={saving} disabled={!displayName.trim()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  label: { color: colors.textDim, fontSize: font.small, fontWeight: '600', marginLeft: 2 },
  handChip: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  handChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  handText: { color: colors.textDim, fontWeight: '700' },
  handTextActive: { color: colors.onPrimary, fontWeight: '800' },
  result: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  resultText: { color: colors.textDim, fontSize: font.small },
});

import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, Field, Muted } from '../components/ui';
import { pickAndUploadProfileImage } from '../lib/uploadImage';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { GeocodeResult } from '../types';

// Curated signature-colour palette. A player's territories render in a 40%
// wash of their pick, so rivals can tell zones apart at a glance. `null` = unset
// (the map falls back to a deterministic hue), shown as a "Default" chip.
const COLOR_OPTIONS: (string | null)[] = [
  null,
  '#0F7A3D', '#E0432B', '#2477C9', '#7E6CC4', '#E8990C',
  '#C05B22', '#1F9E8A', '#D81B8C', '#5B7CFA', '#15241B',
];

type Props = NativeStackScreenProps<RootStackParamList, 'EditProfile'>;

// Curated quick-picks so players can tap their gear instead of typing it. Free
// text is still allowed for anything not listed.
const RACQUET_OPTIONS = [
  'Babolat Pure Aero', 'Babolat Pure Drive', 'Wilson Pro Staff 97', 'Wilson Blade 98',
  'Head Speed Pro', 'Head Radical', 'Yonex EZONE 98', 'Yonex VCORE 100', 'Tecnifibre TF40',
];
const STRING_OPTIONS = [
  'Luxilon ALU Power', 'Babolat RPM Blast', 'Solinco Hyperion', 'Wilson NXT',
  'Head Lynx', 'Tecnifibre X-One Biphase', 'Natural Gut',
];
const SHOE_OPTIONS = [
  'Nike Vapor Pro', 'Nike GP Challenge', 'Adidas Barricade', 'Asics Gel-Resolution',
  'Asics Court FF', 'New Balance Coco CG',
];

function GearPicks({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pickRow}>
      {options.map((o) => {
        const active = value.trim().toLowerCase() === o.toLowerCase();
        return (
          <Pressable key={o} onPress={() => onPick(active ? '' : o)} style={[styles.pick, active && styles.pickActive]}>
            <Text style={[styles.pickText, active && styles.pickTextActive]}>{o}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function EditProfileScreen({ navigation }: Props) {
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);

  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url ?? '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [coverUrl, setCoverUrl] = useState(user?.cover_url ?? '');
  const [uploadingCover, setUploadingCover] = useState(false);
  const [hand, setHand] = useState<'right' | 'left'>(user?.dominant_hand ?? 'right');
  const [color, setColor] = useState<string | null>(user?.color ?? null);
  const [homeQuery, setHomeQuery] = useState(user?.home_label ?? '');
  const [home, setHome] = useState<GeocodeResult | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [saving, setSaving] = useState(false);

  const eq = user?.equipment ?? {};
  const [racquet, setRacquet] = useState(eq.racquet ?? '');
  const [strings, setStrings] = useState(eq.strings ?? '');
  const [tension, setTension] = useState(eq.string_tension ?? '');
  const [shoes, setShoes] = useState(eq.shoes ?? '');

  const onPickAvatar = async () => {
    if (uploadingAvatar) return;
    setUploadingAvatar(true);
    try {
      const url = await pickAndUploadProfileImage('avatar');
      if (url) setAvatarUrl(url); // save() persists it via api.updateProfile
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const onPickCover = async () => {
    if (uploadingCover) return;
    setUploadingCover(true);
    try {
      const url = await pickAndUploadProfileImage('cover');
      if (url) setCoverUrl(url);
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setUploadingCover(false);
    }
  };

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
      // Send '' to clear back to the default hashed hue; a hex sets the signature.
      body.color = color ?? '';
      const trimmedAvatar = avatarUrl.trim();
      if (trimmedAvatar) body.avatar_url = trimmedAvatar;
      const trimmedCover = coverUrl.trim();
      if (trimmedCover) body.cover_url = trimmedCover;
      if (home) body.home = { lat: home.lat, lng: home.lng, label: home.label };
      // Public gear loadout — send the full object so clearing a field persists.
      body.equipment = {
        ...(racquet.trim() ? { racquet: racquet.trim() } : {}),
        ...(strings.trim() ? { strings: strings.trim() } : {}),
        ...(tension.trim() ? { string_tension: tension.trim() } : {}),
        ...(shoes.trim() ? { shoes: shoes.trim() } : {}),
      };
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
        <Pressable
          onPress={onPickCover}
          disabled={uploadingCover}
          style={[styles.cover, { backgroundColor: color ?? colors.primarySoft }]}
          accessibilityRole="button"
          accessibilityLabel="Change cover photo"
        >
          {coverUrl.trim() ? (
            <Image source={{ uri: coverUrl.trim() }} style={styles.coverImg} resizeMode="cover" />
          ) : null}
          <View style={styles.coverPill}>
            {uploadingCover ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.coverPillText}>{coverUrl.trim() ? '📷 Change cover' : '📷 Add cover photo'}</Text>
            )}
          </View>
        </Pressable>

        <View style={styles.avatarRow}>
          <Pressable
            onPress={onPickAvatar}
            disabled={uploadingAvatar}
            style={styles.avatarPick}
            accessibilityRole="button"
            accessibilityLabel="Change profile photo"
          >
            <Avatar name={displayName || user?.username || '🎾'} uri={avatarUrl.trim() || null} size={76} />
            <View style={styles.avatarBadge}>
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.avatarBadgeIcon}>📷</Text>
              )}
            </View>
          </Pressable>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text style={styles.photoTitle}>Profile photo</Text>
            <Muted>Tap your photo to upload a new one from your library.</Muted>
            <Button
              label={uploadingAvatar ? 'Uploading…' : avatarUrl.trim() ? 'Change photo' : 'Add photo'}
              variant="secondary"
              loading={uploadingAvatar}
              onPress={onPickAvatar}
              style={{ height: 40, alignSelf: 'flex-start', paddingHorizontal: spacing.lg, marginTop: spacing.xs }}
            />
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
          <Text style={styles.label}>Signature colour</Text>
          <Muted>Your domination zones show in a 40% wash of this colour on the map.</Muted>
          <View style={styles.swatchRow}>
            {COLOR_OPTIONS.map((opt) => {
              const active = (color ?? null) === opt;
              return (
                <Pressable
                  key={opt ?? 'default'}
                  onPress={() => setColor(opt)}
                  style={[
                    styles.swatch,
                    opt ? { backgroundColor: opt } : styles.swatchDefault,
                    active && styles.swatchActive,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={opt ? `Colour ${opt}` : 'Default colour'}
                >
                  {opt == null ? <Text style={styles.swatchDefaultText}>—</Text> : null}
                  {active && opt != null ? <Text style={styles.swatchCheck}>✓</Text> : null}
                </Pressable>
              );
            })}
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

      <Card style={{ gap: spacing.md }}>
        <View>
          <Text style={styles.cardTitle}>Equipment</Text>
          <Muted>Public — other players can see what you play with.</Muted>
        </View>

        <View style={{ gap: spacing.xs }}>
          <Field label="Racquet" value={racquet} onChangeText={setRacquet} placeholder="e.g. Babolat Pure Aero" />
          <GearPicks options={RACQUET_OPTIONS} value={racquet} onPick={setRacquet} />
        </View>

        <View style={{ gap: spacing.xs }}>
          <Field label="Strings" value={strings} onChangeText={setStrings} placeholder="e.g. Luxilon ALU Power" />
          <GearPicks options={STRING_OPTIONS} value={strings} onPick={setStrings} />
        </View>

        <Field label="String tension" value={tension} onChangeText={setTension} placeholder="e.g. 52 lbs" />

        <View style={{ gap: spacing.xs }}>
          <Field label="Shoes" value={shoes} onChangeText={setShoes} placeholder="e.g. Nike Vapor Pro" />
          <GearPicks options={SHOE_OPTIONS} value={shoes} onPick={setShoes} />
        </View>
      </Card>

      <Button label="Save" onPress={save} loading={saving} disabled={!displayName.trim()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  cover: {
    height: 120,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverImg: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  coverPill: {
    backgroundColor: 'rgba(11,19,13,0.55)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  coverPillText: { color: colors.white, fontFamily: fonts.bold, fontSize: font.small },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarPick: { position: 'relative' },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarBadgeIcon: { fontSize: 13 },
  photoTitle: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  label: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, marginLeft: 2 },
  handChip: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  handChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  handText: { color: colors.textDim, fontFamily: fonts.bold },
  handTextActive: { color: colors.onPrimary, fontFamily: fonts.bold },
  result: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  resultText: { color: colors.textDim, fontSize: font.small },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  swatch: {
    width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'transparent',
  },
  swatchDefault: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  swatchDefaultText: { color: colors.textFaint, fontFamily: fonts.bold },
  swatchActive: { borderColor: colors.text },
  swatchCheck: { position: 'absolute', color: colors.white, fontFamily: fonts.bold, fontSize: 16 },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  pickRow: { gap: spacing.sm, paddingVertical: 2 },
  pick: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  pickActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pickText: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold },
  pickTextActive: { color: colors.onPrimary, fontFamily: fonts.bold },
});

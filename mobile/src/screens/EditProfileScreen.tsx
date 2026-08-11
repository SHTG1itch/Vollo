import React, { useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError, getAuthGeneration, isAuthGenerationCurrent } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, Field, Muted } from '../components/ui';
import {
  getProfileMediaOwnerId,
  pickProfileImage,
  discardProfileImageDraft,
  removeProfileImageUrl,
  uploadProfileImage,
  type UploadedProfileImage,
} from '../lib/uploadImage';
import { showToast } from '../components/Toast';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, radius, spacing } from '../theme';
import type { GeocodeResult } from '../types';
import { hasPersistedHome, mediaPatchValue } from '../utils/profileDraft';

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
          <Pressable
            key={o}
            onPress={() => onPick(active ? '' : o)}
            style={[styles.pick, active && styles.pickActive]}
            accessibilityRole="button"
            accessibilityLabel={`${active ? 'Clear' : 'Choose'} ${o}`}
            accessibilityState={{ selected: active }}
          >
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
  const [avatarDraft, setAvatarDraft] = useState<ImagePickerAsset | null>(null);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [coverUrl, setCoverUrl] = useState(user?.cover_url ?? '');
  const [coverDraft, setCoverDraft] = useState<ImagePickerAsset | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [hand, setHand] = useState<'right' | 'left'>(user?.dominant_hand ?? 'right');
  const [color, setColor] = useState<string | null>(user?.color ?? null);
  const [homeQuery, setHomeQuery] = useState(user?.home_label ?? '');
  const [home, setHome] = useState<GeocodeResult | null>(null);
  const [homeCleared, setHomeCleared] = useState(false);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searchingHome, setSearchingHome] = useState(false);
  const homeSearchGeneration = useRef(0);
  const [saving, setSaving] = useState(false);

  const eq = user?.equipment ?? {};
  const [racquet, setRacquet] = useState(eq.racquet ?? '');
  const [strings, setStrings] = useState(eq.strings ?? '');
  const [tension, setTension] = useState(eq.string_tension ?? '');
  const [shoes, setShoes] = useState(eq.shoes ?? '');

  const avatarPreview = avatarDraft?.uri ?? avatarUrl.trim();
  const coverPreview = coverDraft?.uri ?? coverUrl.trim();

  const onPickAvatar = async () => {
    if (pickingAvatar || saving) return;
    setPickingAvatar(true);
    try {
      const asset = await pickProfileImage('avatar');
      if (asset) setAvatarDraft(asset);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not open that photo — please try again.', 'error');
    } finally {
      setPickingAvatar(false);
    }
  };

  const onPickCover = async () => {
    if (pickingCover || saving) return;
    setPickingCover(true);
    try {
      const asset = await pickProfileImage('cover');
      if (asset) setCoverDraft(asset);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not open that photo — please try again.', 'error');
    } finally {
      setPickingCover(false);
    }
  };

  const findHome = async () => {
    if (!homeQuery.trim() || searchingHome || saving) return;
    const requestGeneration = ++homeSearchGeneration.current;
    setSearchingHome(true);
    try {
      const { results: r } = await api.geocode(homeQuery.trim());
      if (requestGeneration !== homeSearchGeneration.current) return;
      setResults(r);
      if (!r.length) showToast('No matching location found — try a nearby city.', 'error');
    } catch {
      if (requestGeneration === homeSearchGeneration.current) {
        showToast('Location search failed — please try again.', 'error');
      }
    } finally {
      if (requestGeneration === homeSearchGeneration.current) setSearchingHome(false);
    }
  };

  const save = async () => {
    if (saving || pickingAvatar || pickingCover || searchingHome) return;
    const sessionGeneration = getAuthGeneration();
    const stagedMedia: UploadedProfileImage[] = [];
    let profilePatchStarted = false;
    setSaving(true);
    try {
      // Resolve a typed-but-unconfirmed home base: if the query doesn't match a
      // picked result (and isn't just the untouched saved label), geocode it now
      // so the text isn't silently discarded.
      let resolvedHome = home;
      const homeText = homeQuery.trim();
      const homeUntouched = !home && homeText === (user?.home_label ?? '').trim();
      if (homeText && !homeUntouched && (!home || home.label !== homeText)) {
        try {
          const { results: r } = await api.geocode(homeText);
          resolvedHome = r[0] ?? null;
        } catch {
          resolvedHome = null;
        }
        if (!resolvedHome) {
          showToast('Could not find that location — tap Find and pick a result', 'error');
          return;
        }
      }

      // The picker only created local previews. Upload after all validation has
      // passed and only because the user explicitly committed the form.
      if (!isAuthGenerationCurrent(sessionGeneration)) throw new Error('Your sign-in changed while saving.');
      const mediaOwnerId = await getProfileMediaOwnerId();
      if (!isAuthGenerationCurrent(sessionGeneration)) throw new Error('Your sign-in changed while saving.');
      const [avatarUpload, coverUpload] = await Promise.allSettled([
        avatarDraft
          ? uploadProfileImage('avatar', avatarDraft, mediaOwnerId)
          : Promise.resolve(undefined),
        coverDraft
          ? uploadProfileImage('cover', coverDraft, mediaOwnerId)
          : Promise.resolve(undefined),
      ]);
      if (avatarUpload.status === 'fulfilled' && avatarUpload.value) stagedMedia.push(avatarUpload.value);
      if (coverUpload.status === 'fulfilled' && coverUpload.value) stagedMedia.push(coverUpload.value);
      const failedUpload = [avatarUpload, coverUpload].find((result) => result.status === 'rejected');
      if (failedUpload?.status === 'rejected') throw failedUpload.reason;
      const uploadedAvatar = avatarUpload.status === 'fulfilled' ? avatarUpload.value : undefined;
      const uploadedCover = coverUpload.status === 'fulfilled' ? coverUpload.value : undefined;
      if (!isAuthGenerationCurrent(sessionGeneration)) throw new Error('Your sign-in changed while saving.');

      const body: Record<string, unknown> = { display_name: displayName.trim(), bio: bio.trim(), dominant_hand: hand };
      // Send '' to clear back to the default hashed hue; a hex sets the signature.
      body.color = color ?? '';
      const avatarPatch = mediaPatchValue(user?.avatar_url, avatarUrl, uploadedAvatar?.url);
      const coverPatch = mediaPatchValue(user?.cover_url, coverUrl, uploadedCover?.url);
      if (avatarPatch !== undefined) body.avatar_url = avatarPatch;
      if (coverPatch !== undefined) body.cover_url = coverPatch;
      if (resolvedHome) {
        body.home = {
          lat: resolvedHome.lat,
          lng: resolvedHome.lng,
          label: resolvedHome.label.slice(0, 160),
        };
      } else if (homeCleared && hasPersistedHome(user)) {
        body.home = null;
      }
      // Public gear loadout — send the full object so clearing a field persists.
      body.equipment = {
        ...(racquet.trim() ? { racquet: racquet.trim() } : {}),
        ...(strings.trim() ? { strings: strings.trim() } : {}),
        ...(tension.trim() ? { string_tension: tension.trim() } : {}),
        ...(shoes.trim() ? { shoes: shoes.trim() } : {}),
      };
      profilePatchStarted = true;
      const { user: updated } = await api.updateProfile(body);
      // A successful response proves the staged URLs are committed. Clear this
      // before checking session state so rapid account churn cannot delete media
      // that the previous account's profile now references.
      stagedMedia.length = 0;
      if (!isAuthGenerationCurrent(sessionGeneration)) throw new Error('Your sign-in changed while saving.');
      setUser(updated);
      // Clear storage only after the profile no longer points at the object.
      // Deletion failure is surfaced, but does not undo the successful profile
      // update or strand the UI on this screen.
      const removals = await Promise.allSettled([
        ...(avatarPatch !== undefined ? [removeProfileImageUrl(user?.avatar_url, mediaOwnerId, 'avatar')] : []),
        ...(coverPatch !== undefined ? [removeProfileImageUrl(user?.cover_url, mediaOwnerId, 'cover')] : []),
      ]);
      const cleanupFailed = removals.some((result) => result.status === 'rejected');
      showToast(cleanupFailed ? 'Profile saved; old photo cleanup will need another try.' : 'Profile saved', cleanupFailed ? 'error' : 'success');
      navigation.goBack();
    } catch (e) {
      // A network/timeout failure after dispatch is ambiguous: the server may
      // have committed before the response was lost, so retaining a possible
      // orphan is safer than deleting an object the profile could reference.
      const cleanupIsSafe = !profilePatchStarted
        || (e instanceof ApiError && e.status >= 400 && e.status < 500);
      if (cleanupIsSafe) {
        await Promise.allSettled(
          stagedMedia.map((uploaded) => discardProfileImageDraft(uploaded)),
        );
      }
      showToast(e instanceof ApiError ? e.message : 'Save failed — try again', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: spacing.md }}>
        <Pressable
          onPress={onPickCover}
          disabled={pickingCover || saving}
          style={[styles.cover, { backgroundColor: color ?? colors.primarySoft }]}
          accessibilityRole="button"
          accessibilityLabel={coverPreview ? 'Change cover photo' : 'Add cover photo'}
          accessibilityState={{ disabled: pickingCover || saving, busy: pickingCover }}
        >
          {coverPreview ? (
            <Image source={{ uri: coverPreview }} style={styles.coverImg} resizeMode="cover" />
          ) : null}
          <View style={styles.coverPill}>
            {pickingCover ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.coverPillText}>{coverPreview ? '📷 Change cover' : '📷 Add cover photo'}</Text>
            )}
          </View>
        </Pressable>
        {coverPreview ? (
          <Button
            label="Remove cover photo"
            variant="ghost"
            disabled={saving}
            onPress={() => {
              setCoverDraft(null);
              setCoverUrl('');
            }}
          />
        ) : null}

        <View style={styles.avatarRow}>
          <Pressable
            onPress={onPickAvatar}
            disabled={pickingAvatar || saving}
            style={styles.avatarPick}
            accessibilityRole="button"
            accessibilityLabel={avatarPreview ? 'Change profile photo' : 'Add profile photo'}
            accessibilityState={{ disabled: pickingAvatar || saving, busy: pickingAvatar }}
          >
            <Avatar name={displayName || user?.username || '🎾'} uri={avatarPreview || null} size={76} />
            <View style={styles.avatarBadge}>
              {pickingAvatar ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.avatarBadgeIcon}>📷</Text>
              )}
            </View>
          </Pressable>
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text style={styles.photoTitle}>Profile photo</Text>
            <Muted>Choose a preview now; it uploads only when you save.</Muted>
            <Button
              label={pickingAvatar ? 'Opening photos…' : avatarPreview ? 'Change photo' : 'Add photo'}
              variant="secondary"
              loading={pickingAvatar}
              disabled={saving}
              onPress={onPickAvatar}
              style={{ height: 44, alignSelf: 'flex-start', paddingHorizontal: spacing.lg, marginTop: spacing.xs }}
            />
            {avatarPreview ? (
              <Button
                label="Remove photo"
                variant="ghost"
                disabled={saving}
                onPress={() => {
                  setAvatarDraft(null);
                  setAvatarUrl('');
                }}
                style={{ height: 44, alignSelf: 'flex-start' }}
              />
            ) : null}
          </View>
        </View>
        <Field label="Display name" value={displayName} onChangeText={setDisplayName} maxLength={60} autoComplete="name" />
        <Field label="Bio" value={bio} onChangeText={setBio} placeholder="Tell players about your game" multiline maxLength={280} style={{ height: 80, paddingTop: spacing.sm }} />
        <View style={{ gap: spacing.xs }}>
          <Text style={styles.label}>Dominant hand</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {(['right', 'left'] as const).map((h) => (
              <Pressable
                key={h}
                onPress={() => {
                  if (hand !== h) tapLight();
                  setHand(h);
                }}
                style={[styles.handChip, hand === h && styles.handChipActive]}
                accessibilityRole="radio"
                accessibilityState={{ checked: hand === h }}
                accessibilityLabel={`${h === 'right' ? 'Right' : 'Left'}-handed`}
              >
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
                  accessibilityState={{ selected: active }}
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
              homeSearchGeneration.current += 1;
              setSearchingHome(false);
              setHomeQuery(t);
              setHomeCleared(!t.trim() && hasPersistedHome(user));
              // Clear a previously-picked location so edited-but-unconfirmed text
              // can't be saved with stale coordinates.
              setHome(null);
              setResults([]);
            }}
            placeholder="Your city"
            onSubmitEditing={findHome}
            maxLength={200}
          />
          <Button
            label="Find home base"
            variant="secondary"
            onPress={findHome}
            loading={searchingHome}
            disabled={!homeQuery.trim() || saving}
            style={{ height: 44 }}
          />
          {results.map((r, i) => (
            <Pressable
              key={`${r.lat}:${r.lng}:${i}`}
              onPress={() => {
                setHome(r);
                setHomeQuery(r.label);
                setHomeCleared(false);
                setResults([]);
              }}
              style={styles.result}
              accessibilityRole="button"
              accessibilityLabel={`Set home base to ${r.label}`}
            >
              <Text style={styles.resultText} numberOfLines={2}>{r.label}</Text>
            </Pressable>
          ))}
          {home ? <Muted>Home set to {home.city ?? home.label}</Muted> : null}
          {homeQuery.trim() || hasPersistedHome(user) ? (
            <Button
              label="Clear home base"
              variant="ghost"
              disabled={saving}
              onPress={() => {
                homeSearchGeneration.current += 1;
                setSearchingHome(false);
                setHomeQuery('');
                setHome(null);
                setHomeCleared(true);
                setResults([]);
              }}
            />
          ) : null}
          <Pressable
            onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright')
              .catch(() => showToast('Could not open the OpenStreetMap attribution.', 'error'))}
            accessibilityRole="link"
            accessibilityLabel="Search data © OpenStreetMap contributors"
            hitSlop={8}
            style={styles.osmAttribution}
          >
            <Text style={styles.osmAttributionText}>Search data © OpenStreetMap contributors</Text>
          </Pressable>
        </View>
      </Card>

      <Card style={{ gap: spacing.md }}>
        <View>
          <Text style={styles.cardTitle}>Equipment</Text>
          <Muted>Public — other players can see what you play with.</Muted>
        </View>

        <View style={{ gap: spacing.xs }}>
          <Field label="Racquet" value={racquet} onChangeText={setRacquet} placeholder="e.g. Babolat Pure Aero" maxLength={80} />
          <GearPicks options={RACQUET_OPTIONS} value={racquet} onPick={setRacquet} />
        </View>

        <View style={{ gap: spacing.xs }}>
          <Field label="Strings" value={strings} onChangeText={setStrings} placeholder="e.g. Luxilon ALU Power" maxLength={80} />
          <GearPicks options={STRING_OPTIONS} value={strings} onPick={setStrings} />
        </View>

        <Field label="String tension" value={tension} onChangeText={setTension} placeholder="e.g. 52 lbs" maxLength={40} />

        <View style={{ gap: spacing.xs }}>
          <Field label="Shoes" value={shoes} onChangeText={setShoes} placeholder="e.g. Nike Vapor Pro" maxLength={80} />
          <GearPicks options={SHOE_OPTIONS} value={shoes} onPick={setShoes} />
        </View>
      </Card>

      <Button
        label="Save profile"
        onPress={save}
        loading={saving}
        disabled={!displayName.trim() || pickingAvatar || pickingCover || searchingHome}
      />
    </ScrollView>
    </KeyboardAvoidingView>
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
  osmAttribution: { minHeight: 44, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  osmAttributionText: { color: '#245D8A', fontSize: font.tiny, textDecorationLine: 'underline', textAlign: 'center' },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  swatch: {
    width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'transparent',
  },
  swatchDefault: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  swatchDefaultText: { color: colors.textFaint, fontFamily: fonts.bold },
  swatchActive: { borderColor: colors.text },
  swatchCheck: { position: 'absolute', color: colors.white, fontFamily: fonts.bold, fontSize: 16 },
  cardTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  pickRow: { gap: spacing.sm, paddingVertical: 2 },
  pick: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  pickActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pickText: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold },
  pickTextActive: { color: colors.onPrimary, fontFamily: fonts.bold },
});

import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Avatar, Button, Card, Field, Muted, SectionHeader } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { showToast } from '../components/Toast';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, radius, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Surface } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'ScheduleMatch'>;

const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];
// Hourly slots a typical player might book a court (7am–9pm).
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Calendar day math (setDate), not ms offsets — a DST change makes a day ≠ 24h. */
function addDays(base: Date, offset: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d;
}

function dayLabel(offset: number, base: Date): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return addDays(base, offset).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

function hourLabel(h: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${period}`;
}

export function ScheduleMatchScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const presetOpponentId = route.params?.opponentId;
  const presetOpponentName = route.params?.opponentName ?? '';
  const presetUsername = route.params?.opponentUsername;
  // Challenge replaced plain scheduling — this screen is only ever reached to
  // challenge a registered player, so any preset opponent is a challenge.
  const isChallenge = !!presetOpponentId;

  const [opponentName, setOpponentName] = useState(presetOpponentName);
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState(18);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const base = useMemo(() => startOfToday(), []);
  // A minute tick keeps "which slots are still ahead of now" fresh while the
  // screen stays open, without calling Date.now() during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // For "today" only offer hours still ahead of now.
  const availableHours = useMemo(
    () => (dayOffset === 0 ? HOURS.filter((h) => base.getTime() + h * 3_600_000 > now) : HOURS),
    [dayOffset, base, now],
  );

  const scheduledAt = useMemo(() => {
    const d = addDays(base, dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  }, [base, dayOffset, hour]);

  const inPast = scheduledAt.getTime() < now;
  const hasOpponent = !!presetOpponentId || opponentName.trim().length > 0;

  const submit = async () => {
    if (!hasOpponent) {
      showToast('Choose who you want to play.', 'error');
      return;
    }
    // Validate against a fresh clock — the render-time tick can be a minute stale.
    if (scheduledAt.getTime() < Date.now()) {
      showToast('That slot is already in the past — pick a future time.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.createScheduledMatch({
        ...(presetOpponentId ? { opponent_id: presetOpponentId } : { opponent_name: opponentName.trim() }),
        ...(surface ? { surface } : {}),
        scheduled_at: scheduledAt.toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(isChallenge ? { is_challenge: true } : {}),
      });
      showToast(
        isChallenge
          ? 'Challenge sent ⚔️ They’ll get a notification to accept.'
          : presetOpponentId
            ? 'Match proposed — they’ll get a notification to accept or decline.'
            : 'Match added to your scheduled matches.',
        'success',
      );
      navigation.goBack();
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not schedule — try again', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>{isChallenge ? `Challenge ${presetUsername ? `@${presetUsername}` : presetOpponentName}` : 'Schedule a match'}</Text>

      {/* Opponent */}
      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Opponent" />
        {presetOpponentId ? (
          <View style={styles.oppChip}>
            <Avatar name={presetOpponentName} size={32} />
            <View style={{ flex: 1 }}>
              <Text style={styles.oppName}>{presetOpponentName}</Text>
              {presetUsername ? <Text style={styles.oppHandle}>@{presetUsername}</Text> : null}
            </View>
          </View>
        ) : (
          <Field
            value={opponentName}
            onChangeText={setOpponentName}
            placeholder="Who are you playing?"
            autoCapitalize="words"
          />
        )}
      </Card>

      {/* When */}
      <Card style={{ gap: spacing.md }}>
        <SectionHeader title="When" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {Array.from({ length: 14 }, (_, d) => d).map((d) => (
            <Pressable
              key={d}
              onPress={() => {
                if (dayOffset !== d) tapLight();
                setDayOffset(d);
                if (d === 0 && base.getTime() + hour * 3_600_000 <= now) {
                  const next = HOURS.find((h) => base.getTime() + h * 3_600_000 > now);
                  if (next) setHour(next);
                }
              }}
              style={[styles.chip, dayOffset === d && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: dayOffset === d }}
            >
              <Text style={[styles.chipText, dayOffset === d && styles.chipTextActive]}>{dayLabel(d, base)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {availableHours.map((h) => (
            <Pressable
              key={h}
              onPress={() => {
                if (hour !== h) tapLight();
                setHour(h);
              }}
              style={[styles.chip, hour === h && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: hour === h }}
            >
              <Text style={[styles.chipText, hour === h && styles.chipTextActive]}>{hourLabel(h)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {availableHours.length === 0 ? <Muted>No slots left today — pick another day.</Muted> : null}
      </Card>

      {/* Surface (optional) */}
      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Surface (optional)" />
        <View style={styles.surfaceRow}>
          {SURFACES.map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                if (surface !== s) tapLight();
                setSurface(surface === s ? null : s);
              }}
              style={[styles.surfaceChip, surface === s && { borderColor: surfaceColors[s], backgroundColor: surfaceColorsSoft[s] }]}
              accessibilityRole="button"
              accessibilityState={{ selected: surface === s }}
              accessibilityLabel={`${s} surface`}
            >
              <SurfaceBadge surface={s} small />
            </Pressable>
          ))}
        </View>
      </Card>

      {/* Note */}
      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Note (optional)" />
        <Field value={note} onChangeText={setNote} placeholder="e.g. Best of 3, bring new balls" multiline maxLength={280} style={{ height: 70, paddingTop: spacing.sm }} />
      </Card>

      <Button label={`${isChallenge ? '⚔️ Send challenge' : 'Propose'} · ${dayLabel(dayOffset, base)} ${hourLabel(hour)}`} onPress={submit} loading={saving} disabled={!hasOpponent || inPast} />
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display, letterSpacing: 0.3 },
  oppChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  oppName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  oppHandle: { color: colors.textFaint, fontSize: font.small },
  chipRow: { gap: spacing.sm, paddingVertical: 2 },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
  chipTextActive: { color: colors.onPrimary },
  surfaceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  surfaceChip: { padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});

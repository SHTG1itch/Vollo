import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Avatar, Button, Card, Field, Muted } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Surface } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'ScheduleMatch'>;

const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];
// Hourly slots a typical player might book a court (7am–9pm).
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
const DAY_MS = 86_400_000;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayLabel(offset: number, base: Date): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const d = new Date(base.getTime() + offset * DAY_MS);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
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

  const [opponentName, setOpponentName] = useState(presetOpponentName);
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState(18);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const base = useMemo(() => startOfToday(), []);
  const now = Date.now();

  // For "today" only offer hours still ahead of now.
  const availableHours = useMemo(
    () => (dayOffset === 0 ? HOURS.filter((h) => base.getTime() + h * 3_600_000 > now) : HOURS),
    [dayOffset, base, now],
  );

  const scheduledAt = useMemo(() => {
    const d = new Date(base.getTime() + dayOffset * DAY_MS);
    d.setHours(hour, 0, 0, 0);
    return d;
  }, [base, dayOffset, hour]);

  const inPast = scheduledAt.getTime() < now;
  const hasOpponent = !!presetOpponentId || opponentName.trim().length > 0;

  const submit = async () => {
    if (!hasOpponent) {
      Alert.alert('Add an opponent', 'Choose who you want to play.');
      return;
    }
    if (inPast) {
      Alert.alert('Pick a future time', 'That slot is already in the past.');
      return;
    }
    setSaving(true);
    try {
      await api.createScheduledMatch({
        ...(presetOpponentId ? { opponent_id: presetOpponentId } : { opponent_name: opponentName.trim() }),
        ...(surface ? { surface } : {}),
        scheduled_at: scheduledAt.toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      Alert.alert(
        'Match proposed',
        presetOpponentId ? 'They’ll get a notification to accept or decline.' : 'Added to your scheduled matches.',
        [{ text: 'OK', onPress: () => navigation.goBack() }],
      );
    } catch (e) {
      Alert.alert('Could not schedule', e instanceof ApiError ? e.message : 'Try again');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Schedule a match</Text>

      {/* Opponent */}
      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Opponent</Text>
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
        <Text style={styles.section}>When</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {Array.from({ length: 14 }, (_, d) => d).map((d) => (
            <Pressable
              key={d}
              onPress={() => {
                setDayOffset(d);
                if (d === 0 && base.getTime() + hour * 3_600_000 <= now) {
                  const next = HOURS.find((h) => base.getTime() + h * 3_600_000 > now);
                  if (next) setHour(next);
                }
              }}
              style={[styles.chip, dayOffset === d && styles.chipActive]}
            >
              <Text style={[styles.chipText, dayOffset === d && styles.chipTextActive]}>{dayLabel(d, base)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {availableHours.map((h) => (
            <Pressable key={h} onPress={() => setHour(h)} style={[styles.chip, hour === h && styles.chipActive]}>
              <Text style={[styles.chipText, hour === h && styles.chipTextActive]}>{hourLabel(h)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {availableHours.length === 0 ? <Muted>No slots left today — pick another day.</Muted> : null}
      </Card>

      {/* Surface (optional) */}
      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Surface (optional)</Text>
        <View style={styles.surfaceRow}>
          {SURFACES.map((s) => (
            <Pressable
              key={s}
              onPress={() => setSurface(surface === s ? null : s)}
              style={[styles.surfaceChip, surface === s && { borderColor: surfaceColors[s], backgroundColor: surfaceColorsSoft[s] }]}
            >
              <SurfaceBadge surface={s} small />
            </Pressable>
          ))}
        </View>
      </Card>

      {/* Note */}
      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Note (optional)</Text>
        <Field value={note} onChangeText={setNote} placeholder="e.g. Best of 3, bring new balls" multiline style={{ height: 70, paddingTop: spacing.sm }} />
      </Card>

      <Button label={`Propose · ${dayLabel(dayOffset, base)} ${hourLabel(hour)}`} onPress={submit} loading={saving} disabled={!hasOpponent || inPast} />
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: font.h1, fontFamily: fonts.display, letterSpacing: 0.3 },
  section: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
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

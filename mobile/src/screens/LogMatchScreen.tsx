import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError, type CreateMatchPayload } from '../api/client';
import { useFeed } from '../store/feed';
import { Button, Card, Field, H2, Muted } from '../components/ui';
import { ScoreInput } from '../components/ScoreInput';
import { Stepper } from '../components/Stepper';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, spacing, surfaceColors } from '../theme';
import type { Court, MatchStats, ScoreArray, Surface } from '../types';
import { setsSummary } from '../utils/format';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];

const emptyStats = (): MatchStats => ({
  first_serve_in: 0, first_serve_total: 0, second_serve_in: 0, second_serve_total: 0,
  aces: 0, double_faults: 0, forehand_winners: 0, forehand_errors: 0,
  backhand_winners: 0, backhand_errors: 0, volley_winners: 0, volley_errors: 0,
  rally_short: 0, rally_medium: 0, rally_long: 0, break_points_won: 0, break_points_total: 0,
});

export function LogMatchScreen() {
  const navigation = useNavigation<Nav>();
  const prepend = useFeed((s) => s.prepend);

  const [surface, setSurface] = useState<Surface>('hard');
  const [courtId, setCourtId] = useState<string | null>(null);
  const [opponentName, setOpponentName] = useState('');
  const [score, setScore] = useState<ScoreArray>([[6, 4]]);
  const [rpe, setRpe] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [notes, setNotes] = useState('');
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<MatchStats>(emptyStats);
  const [courts, setCourts] = useState<Court[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          const { courts: nearby } = await api.getCourts({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            radius_km: 50,
            limit: 30,
          });
          setCourts(nearby);
          return;
        }
      } catch {
        /* fall through to all-courts */
      }
      try {
        const { courts: all } = await api.getCourts({ limit: 30 });
        setCourts(all);
      } catch {
        /* offline / no courts */
      }
    })();
  }, []);

  const summary = useMemo(() => setsSummary(score), [score]);
  const result = summary.won > summary.lost ? 'win' : summary.won < summary.lost ? 'loss' : 'tie';
  const scoreValid = score.every(([a, b]) => a !== b) && summary.won !== summary.lost;

  const setStat = (k: keyof MatchStats, v: number) => setStats((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    if (!scoreValid) {
      Alert.alert('Check the score', 'Each set needs a winner and the match cannot end in a tie.');
      return;
    }
    setSubmitting(true);
    try {
      const payload: CreateMatchPayload = {
        surface,
        score_array: score,
        ...(courtId ? { court_id: courtId } : {}),
        ...(opponentName.trim() ? { opponent_name: opponentName.trim() } : {}),
        ...(rpe ? { rpe_index: rpe } : {}),
        ...(duration > 0 ? { duration_minutes: duration } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(showStats ? { stats } : {}),
      };
      const { match } = await api.createMatch(payload);
      prepend(match);
      navigation.navigate('Tabs', { screen: 'Feed' });
      // Reset for next time.
      setScore([[6, 4]]);
      setOpponentName('');
      setRpe(null);
      setDuration(0);
      setNotes('');
      setShowStats(false);
      setStats(emptyStats());
    } catch (e) {
      Alert.alert('Could not log match', e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <H2>Log a match</H2>

      {/* Result preview */}
      <Card style={styles.preview}>
        <Text
          style={[
            styles.previewResult,
            { color: result === 'win' ? colors.win : result === 'loss' ? colors.loss : colors.textDim },
          ]}
        >
          {result === 'win' ? 'WIN' : result === 'loss' ? 'LOSS' : '—'}
        </Text>
        <Text style={styles.previewSets}>
          {summary.won} – {summary.lost} sets
        </Text>
      </Card>

      {/* Surface */}
      <Section title="Surface">
        <View style={styles.surfaceRow}>
          {SURFACES.map((s) => (
            <Pressable
              key={s}
              onPress={() => setSurface(s)}
              style={[
                styles.surfaceChip,
                surface === s && { borderColor: surfaceColors[s], backgroundColor: `${surfaceColors[s]}22` },
              ]}
            >
              <SurfaceBadge surface={s} small />
            </Pressable>
          ))}
        </View>
      </Section>

      {/* Score */}
      <Section title="Score (your games first)">
        <ScoreInput value={score} onChange={setScore} />
      </Section>

      {/* Opponent */}
      <Section title="Opponent">
        <Field value={opponentName} onChangeText={setOpponentName} placeholder="Opponent name (optional)" />
      </Section>

      {/* Court */}
      <Section title="Court">
        {courts.length === 0 ? (
          <Muted>No courts loaded — log without one, or add courts from the Map tab.</Muted>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
            <CourtChip label="No court" active={courtId === null} onPress={() => setCourtId(null)} />
            {courts.map((c) => (
              <CourtChip
                key={c.id}
                label={c.name}
                sub={c.distance_km != null ? `${c.distance_km.toFixed(1)} km` : (c.city ?? undefined)}
                active={courtId === c.id}
                onPress={() => {
                  setCourtId(c.id);
                  setSurface(c.surface);
                }}
              />
            ))}
          </ScrollView>
        )}
      </Section>

      {/* RPE */}
      <Section title="Exertion (RPE)">
        <View style={styles.rpeRow}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <Pressable
              key={n}
              onPress={() => setRpe(rpe === n ? null : n)}
              style={[styles.rpePill, rpe === n && styles.rpePillActive]}
            >
              <Text style={[styles.rpeText, rpe === n && styles.rpeTextActive]}>{n}</Text>
            </Pressable>
          ))}
        </View>
      </Section>

      {/* Duration */}
      <Section title="Duration">
        <Stepper label="Minutes" value={duration} onChange={setDuration} step={5} max={600} />
      </Section>

      {/* Notes */}
      <Section title="Notes">
        <Field value={notes} onChangeText={setNotes} placeholder="How did it go?" multiline style={{ height: 80, paddingTop: spacing.sm }} />
      </Section>

      {/* Detailed stats */}
      <Pressable onPress={() => setShowStats((v) => !v)} style={styles.statsToggle}>
        <Text style={styles.statsToggleText}>{showStats ? '▾' : '▸'} Detailed stats (optional)</Text>
      </Pressable>
      {showStats ? (
        <Card style={{ gap: spacing.lg }}>
          <StatGroup title="Serve">
            <Stepper label="1st serves in" value={stats.first_serve_in} onChange={(v) => setStat('first_serve_in', v)} />
            <Stepper label="1st serves total" value={stats.first_serve_total} onChange={(v) => setStat('first_serve_total', v)} />
            <Stepper label="2nd serves in" value={stats.second_serve_in} onChange={(v) => setStat('second_serve_in', v)} />
            <Stepper label="2nd serves total" value={stats.second_serve_total} onChange={(v) => setStat('second_serve_total', v)} />
            <Stepper label="Aces" value={stats.aces} onChange={(v) => setStat('aces', v)} />
            <Stepper label="Double faults" value={stats.double_faults} onChange={(v) => setStat('double_faults', v)} />
          </StatGroup>
          <StatGroup title="Winners / Errors">
            <Stepper label="Forehand winners" value={stats.forehand_winners} onChange={(v) => setStat('forehand_winners', v)} />
            <Stepper label="Forehand errors" value={stats.forehand_errors} onChange={(v) => setStat('forehand_errors', v)} />
            <Stepper label="Backhand winners" value={stats.backhand_winners} onChange={(v) => setStat('backhand_winners', v)} />
            <Stepper label="Backhand errors" value={stats.backhand_errors} onChange={(v) => setStat('backhand_errors', v)} />
            <Stepper label="Volley winners" value={stats.volley_winners} onChange={(v) => setStat('volley_winners', v)} />
            <Stepper label="Volley errors" value={stats.volley_errors} onChange={(v) => setStat('volley_errors', v)} />
          </StatGroup>
          <StatGroup title="Rallies & break points">
            <Stepper label="Short rallies (1-4)" value={stats.rally_short} onChange={(v) => setStat('rally_short', v)} />
            <Stepper label="Medium rallies (5-8)" value={stats.rally_medium} onChange={(v) => setStat('rally_medium', v)} />
            <Stepper label="Long rallies (9+)" value={stats.rally_long} onChange={(v) => setStat('rally_long', v)} />
            <Stepper label="Break points won" value={stats.break_points_won} onChange={(v) => setStat('break_points_won', v)} />
            <Stepper label="Break points total" value={stats.break_points_total} onChange={(v) => setStat('break_points_total', v)} />
          </StatGroup>
        </Card>
      ) : null}

      <Button label="Log match" onPress={submit} loading={submitting} disabled={!scoreValid} style={{ marginTop: spacing.md }} />
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function StatGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.md }}>
      <Text style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  );
}

function CourtChip({ label, sub, active, onPress }: { label: string; sub?: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.courtChip, active && styles.courtChipActive]}>
      <Text style={[styles.courtChipText, active && { color: colors.onPrimary }]} numberOfLines={1}>
        {label}
      </Text>
      {sub ? <Text style={[styles.courtChipSub, active && { color: colors.onPrimary }]}>{sub}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  preview: { alignItems: 'center', gap: 2 },
  previewResult: { fontSize: font.h1, fontWeight: '900', letterSpacing: 2 },
  previewSets: { color: colors.textDim, fontSize: font.small, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionTitle: { color: colors.textDim, fontSize: font.small, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  groupTitle: { color: colors.primary, fontSize: font.small, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  surfaceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  surfaceChip: { padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  rpeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rpePill: {
    width: 38, height: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },
  rpePillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  rpeText: { color: colors.textDim, fontWeight: '700' },
  rpeTextActive: { color: colors.onPrimary, fontWeight: '800' },
  statsToggle: { paddingVertical: spacing.sm },
  statsToggleText: { color: colors.primary, fontWeight: '700', fontSize: font.body },
  courtChip: {
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, maxWidth: 180,
  },
  courtChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  courtChipText: { color: colors.text, fontWeight: '700', fontSize: font.small },
  courtChipSub: { color: colors.textFaint, fontSize: font.tiny },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { api, ApiError, type CreateMatchPayload, type UserSearchResult } from '../api/client';
import { useFeed } from '../store/feed';
import {
  pickMatchPhotoDraft,
  matchPhotoObjectPath,
  removeMatchPhotoObject,
  uploadMatchPhoto,
  type MatchPhotoDraft,
  type UploadedMatchPhoto,
} from '../lib/uploadImage';
import { showToast } from '../components/Toast';
import { tapLight } from '../lib/haptics';
import { Avatar, Button, Card, Field, H2, Muted, SectionHeader } from '../components/ui';
import { ScoreInput } from '../components/ScoreInput';
import { Stepper } from '../components/Stepper';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Court, MatchStats, ScoreArray, Surface } from '../types';
import { analyzeLocal, scoreValidationError } from '../utils/format';
import {
  applyOpponentPrefill,
  canSubmitLogMatch,
  logMatchPrefillKey,
  PhotoUploadGuard,
} from '../utils/logMatchState';
import { newClientKey } from '../utils/idempotency';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];

async function discardStagedMatchPhoto(uploaded: UploadedMatchPhoto): Promise<void> {
  await removeMatchPhotoObject(uploaded);
  // If this request fails, the durable draft registration remains and the
  // maintenance worker harmlessly removes the already-missing object later.
  await api.discardMatchPhotoDraft(uploaded.path);
}

const emptyStats = (): MatchStats => ({
  first_serve_in: 0, first_serve_total: 0, second_serve_in: 0, second_serve_total: 0,
  aces: 0, double_faults: 0, forehand_winners: 0, forehand_errors: 0,
  backhand_winners: 0, backhand_errors: 0, volley_winners: 0, volley_errors: 0,
  rally_short: 0, rally_medium: 0, rally_long: 0, break_points_won: 0, break_points_total: 0,
});

export function LogMatchScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<TabParamList, 'Log'>>();
  const insets = useSafeAreaInsets();
  const prepend = useFeed((s) => s.prepend);
  const coords = useRef<{ lat: number; lng: number } | null>(null);

  const [surface, setSurface] = useState<Surface>('hard');
  const [surfaceTouched, setSurfaceTouched] = useState(false);
  const [courtId, setCourtId] = useState<string | null>(null);
  // Set when this log fulfils a scheduled match, so we link the result on submit.
  const [scheduledMatchId, setScheduledMatchId] = useState<string | null>(null);
  const lastPrefillKey = useRef<string | null>(null);
  const [opponentName, setOpponentName] = useState('');
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [oppResults, setOppResults] = useState<UserSearchResult[]>([]);
  const oppToken = useRef(0);
  const oppDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [score, setScore] = useState<ScoreArray>([[6, 4]]);
  const [tiebreakFinal, setTiebreakFinal] = useState(false);
  const [daysAgo, setDaysAgo] = useState(0);
  const [rpe, setRpe] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [photoDraft, setPhotoDraft] = useState<MatchPhotoDraft | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoUploadGuard = useRef(new PhotoUploadGuard());
  const stagedPhoto = useRef<UploadedMatchPhoto | null>(null);
  const mounted = useRef(true);
  const submitActive = useRef(false);
  const submissionInFlight = useRef(false);
  // Once a request leaves the device, a transport/5xx failure cannot prove the
  // server did not commit it. Preserve the object for an idempotent retry.
  const photoMayBeCommitted = useRef(false);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<MatchStats>(emptyStats);
  const [courts, setCourts] = useState<Court[]>([]);
  // Distinguish "the court list failed to load" from "no courts nearby" so the
  // picker can offer a retry instead of implying the area is genuinely empty.
  const [courtsError, setCourtsError] = useState(false);
  // Bumped on every court (re)load and when a freshly-added court is injected, so
  // a slow background discovery refresh can't clobber a newer list/selection.
  const courtsToken = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  // Idempotency key for the in-flight/retried submission (see submit()).
  const clientKeyRef = useRef<string | null>(null);

  // Debounced player search for tagging a registered opponent. Typing in the
  // field clears any previously-picked id so a stale opponent_id can't be
  // submitted with a different typed name.
  const searchOpponents = (term: string) => {
    if (oppDebounce.current) clearTimeout(oppDebounce.current);
    // Bump the token synchronously on every keystroke so any already-in-flight
    // request resolves stale and can't clobber the latest query's results.
    const t = ++oppToken.current;
    const query = term.trim();
    if (query.length < 2 || opponentId) {
      setOppResults([]);
      return;
    }
    oppDebounce.current = setTimeout(async () => {
      try {
        const { users } = await api.searchUsers(query, 6);
        if (t === oppToken.current) setOppResults(users);
      } catch {
        if (t === oppToken.current) setOppResults([]);
      }
    }, 300);
  };

  useEffect(() => {
    const uploadGuard = photoUploadGuard.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (oppDebounce.current) clearTimeout(oppDebounce.current);
      uploadGuard.invalidate();
      const staged = stagedPhoto.current;
      if (staged && !submissionInFlight.current && !photoMayBeCommitted.current) {
        stagedPhoto.current = null;
        void discardStagedMatchPhoto(staged).catch(() => {});
      }
    };
  }, []);

  // Load courts to tie a match to. Discovers real-world OSM courts near the
  // player first (so the picker isn't empty), then lists them distance-sorted.
  const loadCourts = useCallback(async () => {
    const here = coords.current;
    const t = ++courtsToken.current;
    if (t === courtsToken.current) setCourtsError(false);
    try {
      if (here) {
        // Show the nearby DB courts immediately (no Overpass wait)…
        const { courts: nearby } = await api.getCourts({ lat: here.lat, lng: here.lng, radius_km: 50, limit: 30 });
        if (t === courtsToken.current) setCourts(nearby);
        // …then pull any new real-world courts in the background and refresh
        // (guarded so it can't clobber a newer load or an injected new court).
        const d = 0.15;
        void api
          .discoverCourts({ min_lng: here.lng - d, min_lat: here.lat - d, max_lng: here.lng + d, max_lat: here.lat + d }, { discover: true })
          .then(() => api.getCourts({ lat: here.lat, lng: here.lng, radius_km: 50, limit: 30 }))
          .then(({ courts }) => { if (t === courtsToken.current) setCourts(courts); })
          .catch(() => undefined);
        return;
      }
    } catch {
      /* fall through to all-courts */
    }
    try {
      const { courts: all } = await api.getCourts({ limit: 30 });
      if (t === courtsToken.current) setCourts(all);
    } catch {
      // Both the location-scoped and the fallback fetch failed — the list is
      // unknown, not confirmed empty. Flag it so the picker says so.
      if (t === courtsToken.current) setCourtsError(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          coords.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      } catch {
        /* no location */
      }
      void loadCourts();
    })();
  }, [loadCourts]);

  // When a court is added via the Log flow it's handed back as a route param —
  // pull it into the list and auto-select it, then clear the param.
  useEffect(() => {
    const newId = route.params?.newCourtId;
    if (!newId) return;
    void (async () => {
      try {
        const { court } = await api.getCourt(newId);
        // Invalidate any in-flight discovery refresh so it can't drop this court.
        courtsToken.current++;
        setCourts((prev) => (prev.some((c) => c.id === court.id) ? prev : [court, ...prev]));
        // Only select once the court is in the list, so the selection always has
        // a visible chip (don't ship a court_id with nothing shown as picked).
        setCourtId(newId);
      } catch {
        /* couldn't load the new court — leave the selection unchanged */
      }
      // Clear the param so re-focusing the tab doesn't re-select it.
      (navigation.setParams as (p: { newCourtId?: string }) => void)({ newCourtId: undefined });
    })();
  }, [route.params?.newCourtId, navigation]);

  // Prefill from "Log result" on a scheduled match: seed opponent/court/surface
  // and remember the schedule id so the result links back. The synchronous
  // state seeding happens as a render-phase adjustment keyed on the prefill
  // (React's sanctioned pattern), never inside an effect.
  const prefillKey = logMatchPrefillKey(route.params);
  const [appliedPrefillKey, setAppliedPrefillKey] = useState<string | null>(null);
  if (!prefillKey && appliedPrefillKey !== null) {
    // Params are cleared after each application. Resetting this key lets a
    // later navigation apply the same prefill again as a fresh action.
    setAppliedPrefillKey(null);
  } else if (prefillKey && appliedPrefillKey !== prefillKey) {
    setAppliedPrefillKey(prefillKey);
    const p = route.params!;
    if (p.prefillOpponentId || p.prefillOpponentName) {
      const nextOpponent = applyOpponentPrefill(p, { opponentId, opponentName });
      setOpponentId(nextOpponent.opponentId);
      setOpponentName(nextOpponent.opponentName);
      setOppResults([]);
    }
    if (p.prefillSurface) {
      setSurface(p.prefillSurface);
      setSurfaceTouched(true);
    }
    if (p.scheduledMatchId) setScheduledMatchId(p.scheduledMatchId);
    if (p.prefillCourtId) setCourtId(p.prefillCourtId);
  }

  // Side effects of the prefill (fetch the court into the picker, clear the
  // params so a re-focus doesn't re-apply) stay in an effect.
  useEffect(() => {
    const p = route.params;
    const key = logMatchPrefillKey(p);
    if (!key) {
      lastPrefillKey.current = null;
      return;
    }
    if (lastPrefillKey.current === key) return;
    lastPrefillKey.current = key;

    // A navigation prefill replaces the opponent field. Invalidate any search
    // that was started for the previous text before its response can arrive.
    if (oppDebounce.current) clearTimeout(oppDebounce.current);
    oppToken.current += 1;

    if (p?.prefillCourtId) {
      const cid = p.prefillCourtId;
      void (async () => {
        try {
          const { court } = await api.getCourt(cid);
          courtsToken.current++;
          setCourts((prev) => (prev.some((c) => c.id === court.id) ? prev : [court, ...prev]));
        } catch {
          /* leave selection as-is */
        }
      })();
    }
    (navigation.setParams as (params: Partial<Record<string, undefined>>) => void)({
      prefillOpponentId: undefined,
      prefillOpponentName: undefined,
      prefillCourtId: undefined,
      prefillSurface: undefined,
      scheduledMatchId: undefined,
    });
  }, [route.params, navigation]);

  const preview = useMemo(() => analyzeLocal(score, tiebreakFinal), [score, tiebreakFinal]);
  const result = preview.result;
  const scoreError = scoreValidationError(score, tiebreakFinal);
  const scoreValid = scoreError === null;

  const openAddCourt = useCallback(() => {
    navigation.navigate('AddCourt', {
      origin: 'log',
      ...(coords.current ? { lat: coords.current.lat, lng: coords.current.lng } : {}),
    });
  }, [navigation]);

  const setStat = (k: keyof MatchStats, v: number) => setStats((s) => ({ ...s, [k]: v }));
  const statsTouched = showStats && Object.values(stats).some((v) => v > 0);

  const onAddPhoto = async () => {
    const uploadToken = photoUploadGuard.current.begin();
    if (uploadToken === null) return;
    setUploadingPhoto(true);
    try {
      const draft = await pickMatchPhotoDraft();
      if (draft && photoUploadGuard.current.accepts(uploadToken)) setPhotoDraft(draft);
    } catch (e) {
      if (photoUploadGuard.current.accepts(uploadToken)) {
        showToast(e instanceof Error ? e.message : 'Upload failed — please try again.', 'error');
      }
    } finally {
      if (photoUploadGuard.current.finish(uploadToken)) setUploadingPhoto(false);
    }
  };

  const removePhoto = () => {
    if (photoMayBeCommitted.current) {
      showToast('Retry logging first so Vollo can confirm whether this photo is already attached.', 'error');
      return;
    }
    setPhotoDraft(null);
    const staged = stagedPhoto.current;
    stagedPhoto.current = null;
    if (staged) {
      void discardStagedMatchPhoto(staged).catch(() => {
        showToast('The photo was removed from this match, but cloud cleanup could not be confirmed.', 'error');
      });
    }
  };

  const submit = async () => {
    if (submitActive.current || submitting) return;
    if (photoUploadGuard.current.active) {
      showToast('Wait for the photo upload to finish before logging.', 'error');
      return;
    }
    if (!scoreValid) {
      showToast(scoreError ?? 'Enter a valid completed tennis score.', 'error');
      return;
    }
    // One idempotency key per logical match: stable across retries of this
    // submission (a timed-out create the user retries maps to the same server
    // row instead of double-logging), regenerated after a successful log.
    const clientKey = clientKeyRef.current ?? newClientKey();
    clientKeyRef.current = clientKey;
    submitActive.current = true;
    setSubmitting(true);
    let requestWasSent = false;
    try {
      let uploaded = stagedPhoto.current;
      if (photoDraft && !uploaded) {
        setUploadingPhoto(true);
        try {
          await api.registerMatchPhotoDraft(matchPhotoObjectPath(photoDraft, clientKey));
          uploaded = await uploadMatchPhoto(photoDraft, clientKey);
        } finally {
          if (mounted.current) setUploadingPhoto(false);
        }
        if (!mounted.current) {
          await discardStagedMatchPhoto(uploaded).catch(() => {});
          return;
        }
        stagedPhoto.current = uploaded;
      }
      const payload: CreateMatchPayload = {
        surface,
        score_array: score,
        is_tiebreak: tiebreakFinal,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(photoDraft && uploaded ? { photo_url: uploaded.url } : {}),
        ...(courtId ? { court_id: courtId } : {}),
        ...(scheduledMatchId ? { scheduled_match_id: scheduledMatchId } : {}),
        // A tagged registered player takes precedence over a free-text name.
        ...(opponentId
          ? { opponent_id: opponentId }
          : opponentName.trim()
            ? { opponent_name: opponentName.trim() }
            : {}),
        ...(rpe ? { rpe_index: rpe } : {}),
        ...(duration > 0 ? { duration_minutes: duration } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        // Calendar day math (setDate), not ms offsets — a DST change makes a day ≠ 24h.
        ...(daysAgo > 0 ? { played_at: playedAt(daysAgo).toISOString() } : {}),
        // Don't ship an all-zero stat row just because the section was expanded.
        ...(statsTouched ? { stats } : {}),
        client_key: clientKey,
      };
      submissionInFlight.current = true;
      photoMayBeCommitted.current = Boolean(uploaded);
      requestWasSent = true;
      const { match } = await api.createMatch(payload);
      submissionInFlight.current = false;
      photoMayBeCommitted.current = false;
      // The DB row owns this object now; unmount cleanup must leave it intact.
      stagedPhoto.current = null;
      clientKeyRef.current = null; // next log is a new match, not a retry
      prepend(match);
      showToast('Match logged 🎾', 'success');
      navigation.navigate('Tabs', { screen: 'Feed' });
      // Reset the match-specific fields for the next log; deliberately keep
      // surface + court as session context for back-to-back logging.
      setScore([[6, 4]]);
      setTiebreakFinal(false);
      setDaysAgo(0);
      setOpponentName('');
      setOpponentId(null);
      setOppResults([]);
      setScheduledMatchId(null);
      setRpe(null);
      setDuration(0);
      setTitle('');
      setNotes('');
      photoUploadGuard.current.invalidate();
      setUploadingPhoto(false);
      setPhotoDraft(null);
      setShowStats(false);
      setStats(emptyStats());
    } catch (e) {
      submissionInFlight.current = false;
      // A received 4xx proves the request was rejected before commit; transport
      // and 5xx failures remain ambiguous and must reuse this staged object.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        photoMayBeCommitted.current = false;
      }
      if (!mounted.current && !photoMayBeCommitted.current) {
        const staged = stagedPhoto.current;
        stagedPhoto.current = null;
        if (staged) await discardStagedMatchPhoto(staged).catch(() => {});
      }
      showToast(
        e instanceof ApiError
          ? e.message
          : !requestWasSent && e instanceof Error
            ? e.message
            : 'Could not confirm the match. Check your connection, then tap Log match again.',
        'error',
      );
    } finally {
      submitActive.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
      keyboardShouldPersistTaps="handled"
    >
      <H2>Log a match</H2>
      {scheduledMatchId ? (
        <Muted>📅 Logging your scheduled match — the result shows on both players’ cards.</Muted>
      ) : null}

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
          {preview.setsWon} – {preview.setsLost} sets
        </Text>
      </Card>

      {/* Surface */}
      <Section title="Surface">
        <View style={styles.surfaceRow}>
          {SURFACES.map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                if (surface !== s) tapLight();
                setSurface(s);
                setSurfaceTouched(true);
              }}
              style={[
                styles.surfaceChip,
                surface === s && { borderColor: surfaceColors[s], backgroundColor: surfaceColorsSoft[s] },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: surface === s }}
              accessibilityLabel={`${s} surface`}
            >
              <SurfaceBadge surface={s} small />
            </Pressable>
          ))}
        </View>
      </Section>

      {/* Score */}
      <Section title="Score (your games first)">
        <ScoreInput value={score} onChange={setScore} />
        <Pressable
          onPress={() => setTiebreakFinal((v) => !v)}
          style={styles.tbToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: tiebreakFinal }}
        >
          <View style={[styles.checkbox, tiebreakFinal && styles.checkboxOn]}>
            {tiebreakFinal ? <Text style={styles.checkboxMark}>✓</Text> : null}
          </View>
          <Text style={styles.tbToggleText}>Final set was a match tie-break (first to 10)</Text>
        </Pressable>
      </Section>

      {/* Opponent */}
      <Section title="Opponent">
        {opponentId ? (
          <View style={styles.oppChip}>
            <Avatar name={opponentName} size={28} />
            <Text style={styles.oppChipName} numberOfLines={1}>{opponentName}</Text>
            <Pressable
              onPress={() => {
                setOpponentId(null);
                setOpponentName('');
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remove tagged opponent"
            >
              <Text style={styles.oppRemove}>✕</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Field
              value={opponentName}
              onChangeText={(t) => {
                setOpponentName(t);
                setOpponentId(null);
                searchOpponents(t);
              }}
              placeholder="Search a Vollo player, or type any name"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {oppResults.map((u) => (
              <Pressable
                key={u.id}
                onPress={() => {
                  setOpponentId(u.id);
                  setOpponentName(u.display_name);
                  setOppResults([]);
                }}
                style={styles.oppResult}
              >
                <Avatar name={u.display_name} uri={u.avatar_url} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.oppResultName}>{u.display_name}</Text>
                  <Text style={styles.oppResultHandle}>@{u.username}</Text>
                </View>
              </Pressable>
            ))}
          </>
        )}
        {opponentId ? (
          <Muted>⏳ {opponentName || 'They'}’ll need to verify this match before it counts toward your rating & territory.</Muted>
        ) : null}
      </Section>

      {/* When */}
      <Section title="When">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
            <Pressable
              key={d}
              onPress={() => {
                if (daysAgo !== d) tapLight();
                setDaysAgo(d);
              }}
              style={[styles.dayChip, daysAgo === d && styles.dayChipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: daysAgo === d }}
            >
              <Text style={[styles.dayChipText, daysAgo === d && { color: colors.onPrimary }]}>
                {d === 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d}d ago`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </Section>

      {/* Court — tie the match to a location so the domination engine counts it */}
      <Section title="Court">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          <CourtChip
            label="No court"
            active={courtId === null}
            onPress={() => {
              if (courtId !== null) tapLight();
              setCourtId(null);
            }}
          />
          <Pressable onPress={openAddCourt} style={[styles.courtChip, styles.addCourtChip]}>
            <Text style={styles.addCourtChipText}>＋ Add court</Text>
          </Pressable>
          {courts.map((c) => (
            <CourtChip
              key={c.id}
              label={c.name}
              sub={c.distance_km != null ? `${c.distance_km.toFixed(1)} km` : (c.city ?? undefined)}
              active={courtId === c.id}
              onPress={() => {
                if (courtId !== c.id) tapLight();
                setCourtId(c.id);
                // Adopt the court's surface only if the user hasn't picked one
                // themselves, so selecting a court can't silently override it.
                if (!surfaceTouched) setSurface(c.surface);
              }}
            />
          ))}
        </ScrollView>
        {courts.length === 0 ? (
          courtsError ? (
            <Pressable onPress={() => void loadCourts()} accessibilityRole="button" accessibilityLabel="Retry loading courts">
              <Muted>Couldn&apos;t load nearby courts — tap to retry, or ＋ Add court to drop one on the map.</Muted>
            </Pressable>
          ) : (
            <Muted>No nearby courts yet — tap ＋ Add court to drop one on the map.</Muted>
          )
        ) : null}
      </Section>

      {/* RPE */}
      <Section title="Exertion (RPE)">
        <View style={styles.rpeRow}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <Pressable
              key={n}
              onPress={() => {
                if (rpe !== n) tapLight();
                setRpe(rpe === n ? null : n);
              }}
              style={[styles.rpePill, rpe === n && styles.rpePillActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: rpe === n }}
              accessibilityLabel={`RPE ${n}`}
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

      {/* Headline */}
      <Section title="Headline (optional)">
        <Field value={title} onChangeText={setTitle} placeholder="e.g. Sunday clay battle" maxLength={80} />
      </Section>

      {/* Notes */}
      <Section title="Notes">
        <Field value={notes} onChangeText={setNotes} placeholder="How did it go?" multiline maxLength={500} style={{ height: 80, paddingTop: spacing.sm }} />
      </Section>

      {/* Photo — a proof-of-play shot shown on the feed card */}
      <Section title="Photo (optional)">
        {photoDraft ? (
          <View style={styles.photoWrap}>
            <Image source={{ uri: photoDraft.asset.uri }} style={styles.photo} resizeMode="cover" />
            <Pressable
              onPress={removePhoto}
              style={styles.photoRemove}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remove photo"
            >
              <Text style={styles.photoRemoveText}>✕</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={onAddPhoto}
            disabled={uploadingPhoto}
            style={styles.addPhoto}
            accessibilityRole="button"
            accessibilityLabel="Add a match photo"
          >
            {uploadingPhoto ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={styles.addPhotoText}>📷  Add a photo</Text>
            )}
          </Pressable>
        )}
      </Section>

      {/* Detailed stats */}
      <Pressable
        onPress={() => setShowStats((v) => !v)}
        style={styles.statsToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: showStats }}
      >
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

      <Button
        label={uploadingPhoto ? 'Uploading photo…' : 'Log match'}
        onPress={submit}
        loading={submitting}
        disabled={
          !canSubmitLogMatch({
            scoreValid,
            submitting,
            photoUploadActive: uploadingPhoto,
          })
        }
        style={{ marginTop: spacing.md }}
      />
      <View style={{ height: spacing.xxl }} />
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function playedAt(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHeader title={title} />
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
  previewResult: { fontSize: font.h1, fontFamily: fonts.display, letterSpacing: 2 },
  previewSets: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
  groupTitle: { color: colors.primary, fontSize: font.small, fontFamily: fonts.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
  surfaceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  surfaceChip: { padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  rpeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rpePill: {
    width: 38, height: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },
  rpePillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  rpeText: { color: colors.textDim, fontFamily: fonts.bold },
  rpeTextActive: { color: colors.onPrimary, fontFamily: fonts.bold },
  statsToggle: { paddingVertical: spacing.sm },
  statsToggleText: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.body },
  addPhoto: {
    height: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPhotoText: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.body },
  photoWrap: { position: 'relative' },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
  photoRemove: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(11,19,13,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoRemoveText: { color: colors.white, fontFamily: fonts.bold, fontSize: 14 },
  courtChip: {
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, maxWidth: 180,
  },
  courtChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  courtChipText: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  courtChipSub: { color: colors.textFaint, fontSize: font.tiny },
  addCourtChip: { borderColor: colors.primary, borderStyle: 'dashed', justifyContent: 'center' },
  addCourtChipText: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.small },
  tbToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  checkbox: {
    width: 22, height: 22, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxMark: { color: colors.onPrimary, fontFamily: fonts.bold, fontSize: 13 },
  tbToggleText: { color: colors.textDim, fontSize: font.small, flexShrink: 1 },
  oppChip: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft, borderRadius: radius.pill, paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm, maxWidth: '100%',
  },
  oppChipName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small, flexShrink: 1 },
  oppRemove: { color: colors.textDim, fontFamily: fonts.bold, paddingHorizontal: spacing.xs },
  oppResult: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.border,
  },
  oppResultName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  oppResultHandle: { color: colors.textFaint, fontSize: font.tiny },
  dayChip: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },
  dayChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayChipText: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
});

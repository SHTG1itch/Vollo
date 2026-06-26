import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, Card, ErrorState, Field, H2, Loading, Muted, Screen } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, shadow, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Court, GeocodeResult, Surface } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];

export function CourtsScreen() {
  const navigation = useNavigation<Nav>();
  const [query, setQuery] = useState('');
  const [courts, setCourts] = useState<Court[]>([]);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const coords = useRef<{ lat: number; lng: number } | null>(null);
  const token = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  const search = async (q: string) => {
    const t = ++token.current; // ignore out-of-order responses
    setLoading(true);
    setError(null);
    try {
      const term = q.trim();
      // Distance-sorted nearby list by default; the q path searches by name/city.
      const params = term
        ? { q: term, limit: 50 }
        : coords.current
          ? { ...coords.current, radius_km: 50, limit: 50 }
          : { limit: 50 };
      const { courts: c } = await api.getCourts(params);
      if (t === token.current) setCourts(c);
    } catch (e) {
      if (t === token.current) setError(e instanceof ApiError ? e.message : 'Failed to load courts');
    } finally {
      if (t === token.current) setLoading(false);
    }
  };

  // On mount: try for the user's location (for distance sort), then load.
  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          coords.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      } catch {
        /* no location — fall back to the unsorted list */
      }
      void search('');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce typing so the list filters as you type (the Go button still works).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <Screen>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <H2>Courts</H2>
        </View>
        <Button label={adding ? 'Cancel' : '＋ Add'} variant="ghost" onPress={() => setAdding((v) => !v)} style={{ height: 38 }} />
      </View>

      {adding ? <AddCourt onCreated={(c) => { setAdding(false); setCourts((prev) => [c, ...prev]); }} /> : null}

      <View style={styles.searchRow}>
        <Field value={query} onChangeText={setQuery} placeholder="Search by name or city" onSubmitEditing={() => search(query)} style={{ flex: 1 }} />
        {loading ? (
          <View style={styles.searchSpinner}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <Button label="Go" onPress={() => search(query)} style={{ paddingHorizontal: spacing.lg }} />
        )}
      </View>

      {loading && courts.length === 0 ? (
        <Loading label="Finding courts…" />
      ) : error && courts.length === 0 ? (
        <ErrorState message={error} onRetry={() => search(query)} />
      ) : (
        <FlatList
          data={courts}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, gap: spacing.sm }}
          renderItem={({ item }) => (
            <Pressable style={styles.courtRow} onPress={() => navigation.navigate('Court', { courtId: item.id })}>
              <View style={{ flex: 1 }}>
                <Text style={styles.courtName}>{item.name}</Text>
                <Text style={styles.courtSub}>
                  {item.city ?? 'Unknown city'}
                  {item.distance_km != null ? ` · ${item.distance_km.toFixed(1)} km` : ''}
                </Text>
              </View>
              <SurfaceBadge surface={item.surface} small />
            </Pressable>
          )}
          ListEmptyComponent={<Muted style={{ padding: spacing.lg }}>No courts found.</Muted>}
        />
      )}
    </Screen>
  );
}

function AddCourt({ onCreated }: { onCreated: (c: Court) => void }) {
  const [name, setName] = useState('');
  const [surface, setSurface] = useState<Surface>('hard');
  const [address, setAddress] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [picked, setPicked] = useState<GeocodeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const geocode = async () => {
    if (!address.trim()) return;
    setBusy(true);
    try {
      const { results: r } = await api.geocode(address.trim());
      setResults(r);
    } catch (e) {
      Alert.alert('Geocode failed', e instanceof ApiError ? e.message : 'Try a different address');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!name.trim() || !picked) return;
    setBusy(true);
    try {
      const { court } = await api.createCourt({
        name: name.trim(),
        surface,
        lat: picked.lat,
        lng: picked.lng,
        city: picked.city ?? undefined,
        address: picked.label,
      });
      onCreated(court);
    } catch (e) {
      Alert.alert('Could not add court', e instanceof ApiError ? e.message : 'Try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.addCard}>
      <Field label="Court name" value={name} onChangeText={setName} placeholder="Central Park Tennis Center" />
      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        {SURFACES.map((s) => (
          <Pressable
            key={s}
            onPress={() => setSurface(s)}
            style={[styles.surfaceChip, surface === s && { borderColor: surfaceColors[s], backgroundColor: surfaceColorsSoft[s] }]}
          >
            <SurfaceBadge surface={s} small />
          </Pressable>
        ))}
      </View>
      <View style={styles.searchRow}>
        <Field label="Address / place" value={address} onChangeText={setAddress} placeholder="123 Tennis Ave, City" style={{ flex: 1 }} />
      </View>
      <Button label="Find location" variant="secondary" onPress={geocode} loading={busy} disabled={!address.trim()} />
      {results.map((r, i) => (
        <Pressable key={i} onPress={() => setPicked(r)} style={[styles.result, picked === r && styles.resultActive]}>
          <Text style={styles.resultText} numberOfLines={2}>{r.label}</Text>
        </Pressable>
      ))}
      {picked ? <Button label="Add court" onPress={create} loading={busy} disabled={!name.trim()} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, paddingBottom: spacing.sm },
  back: { color: colors.primary, fontSize: 34, fontWeight: '700', marginTop: -4 },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end', paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  searchSpinner: { width: 56, height: 48, alignItems: 'center', justifyContent: 'center' },
  courtRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  courtName: { color: colors.text, fontWeight: '700', fontSize: font.body },
  courtSub: { color: colors.textFaint, fontSize: font.small, marginTop: 2 },
  addCard: { margin: spacing.lg, marginTop: 0, gap: spacing.md },
  surfaceChip: { padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  result: { backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border },
  resultActive: { borderColor: colors.primary },
  resultText: { color: colors.textDim, fontSize: font.small },
});

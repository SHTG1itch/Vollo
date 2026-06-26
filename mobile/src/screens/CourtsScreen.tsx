import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, Card, Field, H2, Muted, Screen } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, shadow, spacing, surfaceColors } from '../theme';
import type { Court, GeocodeResult, Surface } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];

export function CourtsScreen() {
  const navigation = useNavigation<Nav>();
  const [query, setQuery] = useState('');
  const [courts, setCourts] = useState<Court[]>([]);
  const [adding, setAdding] = useState(false);

  const search = async (q: string) => {
    try {
      const { courts: c } = await api.getCourts(q.trim() ? { q: q.trim(), limit: 50 } : { limit: 50 });
      setCourts(c);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void search('');
  }, []);

  return (
    <Screen>
      <View style={styles.header}>
        <H2>Courts</H2>
        <Button label={adding ? 'Cancel' : '＋ Add'} variant="ghost" onPress={() => setAdding((v) => !v)} style={{ height: 38 }} />
      </View>

      {adding ? <AddCourt onCreated={(c) => { setAdding(false); setCourts((prev) => [c, ...prev]); }} /> : null}

      <View style={styles.searchRow}>
        <Field value={query} onChangeText={setQuery} placeholder="Search by name or city" onSubmitEditing={() => search(query)} style={{ flex: 1 }} />
        <Button label="Go" onPress={() => search(query)} style={{ paddingHorizontal: spacing.lg }} />
      </View>

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
            style={[styles.surfaceChip, surface === s && { borderColor: surfaceColors[s], backgroundColor: `${surfaceColors[s]}22` }]}
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
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end', paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
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

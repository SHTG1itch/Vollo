import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, ErrorState, Field, H2, Loading, Muted, Screen } from '../components/ui';
import { Icon } from '../components/icons';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import type { Court } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function CourtsScreen() {
  const navigation = useNavigation<Nav>();
  const [query, setQuery] = useState('');
  const [courts, setCourts] = useState<Court[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const coords = useRef<{ lat: number; lng: number } | null>(null);
  const queryRef = useRef('');
  const token = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  const search = useCallback(async (q: string) => {
    const t = ++token.current; // ignore out-of-order responses
    setLoading(true);
    setError(null);
    try {
      const term = q.trim();
      if (term) {
        // Name/city search hits the DB directly.
        const { courts: c } = await api.getCourts({ q: term, limit: 50 });
        if (t === token.current) setCourts(c);
      } else if (coords.current) {
        const { lat, lng } = coords.current;
        // List straight from the DB (kept well-populated by the map) so the
        // screen is instant; never block on Overpass.
        const { courts: c } = await api.getCourts({ lat, lng, radius_km: 50, limit: 50 });
        if (t === token.current) setCourts(c);
        // Then pull any new real-world courts in the background and refresh once.
        const d = 0.15; // ~16 km half-span keeps the import fast
        void api
          .discoverCourts({ min_lng: lng - d, min_lat: lat - d, max_lng: lng + d, max_lat: lat + d }, { discover: true })
          .then(() => api.getCourts({ lat, lng, radius_km: 50, limit: 50 }))
          .then(({ courts: c2 }) => { if (t === token.current) setCourts(c2); })
          .catch(() => undefined);
      } else {
        const { courts: c } = await api.getCourts({ limit: 50 });
        if (t === token.current) setCourts(c);
      }
    } catch (e) {
      if (t === token.current) setError(e instanceof ApiError ? e.message : 'Failed to load courts');
    } finally {
      if (t === token.current) setLoading(false);
    }
  }, []);

  // On mount: try for the user's location (for distance sort + discovery), then load.
  useEffect(() => {
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ mayShowUserSettingsDialog: false });
          coords.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
      } catch {
        /* no location — fall back to the unsorted list */
      }
      void search('');
    })();
  }, [search]);

  // Debounce typing so the list filters as you type (the Go button still works).
  useEffect(() => {
    queryRef.current = query;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, search]);

  // Refresh when returning to the screen (e.g. after adding a court).
  const didFocus = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!didFocus.current) {
        didFocus.current = true;
        return;
      }
      void search(queryRef.current);
    }, [search]),
  );

  const openAdd = () =>
    navigation.navigate('AddCourt', {
      origin: 'courts',
      ...(coords.current ? { lat: coords.current.lat, lng: coords.current.lng } : {}),
    });

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
            <Icon name="chevron-left" size={26} color={colors.primary} strokeWidth={2.4} />
          </Pressable>
          <H2>Courts</H2>
        </View>
        <Button label="+ Add" onPress={openAdd} style={{ height: 38 }} />
      </View>

      <View style={styles.searchRow}>
        <Field value={query} onChangeText={setQuery} placeholder="Search by name or city" onSubmitEditing={() => search(query)} maxLength={120} style={{ flex: 1 }} />
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
            <Pressable
              style={styles.courtRow}
              onPress={() => navigation.navigate('Court', { courtId: item.id })}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.city ?? 'unknown city'}`}
              accessibilityHint="Opens court details"
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.courtName}>{item.name}</Text>
                <Text style={styles.courtSub}>
                  {item.city ?? 'Unknown city'}
                  {item.distance_km != null ? ` · ${item.distance_km.toFixed(1)} km` : ''}
                  {item.court_count > 1 ? ` · ${item.court_count} courts` : ''}
                </Text>
              </View>
              <SurfaceBadge surface={item.surface} small />
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={{ padding: spacing.lg, gap: spacing.md }}>
              <Muted>No courts here yet — be the first to add one.</Muted>
              <Button label="＋ Add a court" variant="secondary" onPress={openAdd} />
            </View>
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, paddingBottom: spacing.sm },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end', paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  searchSpinner: { width: 56, height: 48, alignItems: 'center', justifyContent: 'center' },
  courtRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border,
    ...shadow.card,
  },
  courtName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  courtSub: { color: colors.textFaint, fontSize: font.small, marginTop: 2 },
});

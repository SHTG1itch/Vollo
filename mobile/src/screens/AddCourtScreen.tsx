import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import MapView, { UrlTile, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, Card, Field } from '../components/ui';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { colors, font, radius, shadow, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Surface } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddCourt'>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const DEFAULT_REGION: Region = {
  latitude: 40.78,
  longitude: -73.96,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

export function AddCourtScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const origin = route.params?.origin ?? 'courts';
  const mapRef = useRef<MapView>(null);
  // The court's coordinates are wherever the centre pin sits — tracked off-render
  // so panning the map never re-renders the form.
  const center = useRef<{ lat: number; lng: number }>({
    lat: route.params?.lat ?? DEFAULT_REGION.latitude,
    lng: route.params?.lng ?? DEFAULT_REGION.longitude,
  });

  const [name, setName] = useState('');
  const [surface, setSurface] = useState<Surface>('hard');
  const [addressQuery, setAddressQuery] = useState('');
  // Independent flags: the address "Find" and the "Add court" submit are separate
  // async actions, so one finishing must not re-enable the other mid-flight.
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [locating, setLocating] = useState(false);

  // Render the map at the seeded coordinate immediately (initialRegion is only
  // honored on first mount), so the centre pin marks the right place even if the
  // post-mount animateToRegion is dropped (a known Android no-op-on-mount).
  const seeded = route.params?.lat != null && route.params?.lng != null;
  const initialRegion: Region = seeded
    ? { ...DEFAULT_REGION, latitude: route.params!.lat!, longitude: route.params!.lng! }
    : DEFAULT_REGION;

  // Seed the pin: use a passed coordinate, else the user's GPS, else default.
  useEffect(() => {
    void (async () => {
      if (route.params?.lat != null && route.params?.lng != null) {
        const r = { ...DEFAULT_REGION, latitude: route.params.lat, longitude: route.params.lng };
        center.current = { lat: r.latitude, lng: r.longitude };
        mapRef.current?.animateToRegion(r, 350);
        return;
      }
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({});
        const r = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        center.current = { lat: r.latitude, lng: r.longitude };
        mapRef.current?.animateToRegion(r, 350);
      } catch {
        /* keep default region */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recenter = async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location off', 'Enable location to centre on where you are.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const r = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      center.current = { lat: r.latitude, lng: r.longitude };
      mapRef.current?.animateToRegion(r, 350);
    } catch {
      /* ignore */
    } finally {
      setLocating(false);
    }
  };

  // Optional: jump the map to a typed address so you don't have to pan far.
  const findAddress = async () => {
    const q = addressQuery.trim();
    if (!q || submitting) return;
    setSearching(true);
    try {
      const { results } = await api.geocode(q, 1);
      const hit = results[0];
      if (!hit) {
        Alert.alert('Not found', 'Try a different address, or just pan the map.');
        return;
      }
      const r = { ...DEFAULT_REGION, latitude: hit.lat, longitude: hit.lng };
      center.current = { lat: r.latitude, lng: r.longitude };
      mapRef.current?.animateToRegion(r, 450);
    } catch {
      Alert.alert('Search unavailable', 'Address search is busy — just pan the map to the court.');
    } finally {
      setSearching(false);
    }
  };

  const onRegionChangeComplete = (r: Region) => {
    center.current = { lat: r.latitude, lng: r.longitude };
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) {
      if (!trimmed) Alert.alert('Name the court', 'Give the court a name so other players can find it.');
      return;
    }
    setSubmitting(true);
    try {
      // Best-effort reverse geocode for a city/address label — never blocks the add.
      let city: string | undefined;
      let address: string | undefined;
      try {
        const { result } = await api.reverseGeocode(center.current.lat, center.current.lng);
        if (result) {
          city = result.city ?? undefined;
          address = result.label ?? undefined;
        }
      } catch {
        /* no label — the court still saves with its coordinates */
      }

      const { court } = await api.createCourt({
        name: trimmed,
        surface,
        lat: center.current.lat,
        lng: center.current.lng,
        ...(city ? { city } : {}),
        ...(address ? { address } : {}),
      });

      if (origin === 'log') {
        navigation.navigate('Tabs', { screen: 'Log', params: { newCourtId: court.id } });
      } else {
        // Show the freshly-created court (and its leaderboard) as confirmation.
        navigation.replace('Court', { courtId: court.id });
      }
    } catch (e) {
      Alert.alert('Could not add court', e instanceof ApiError ? e.message : 'Try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={initialRegion}
          onRegionChangeComplete={onRegionChangeComplete}
          mapType="none"
          showsUserLocation
          rotateEnabled={false}
        >
          <UrlTile urlTemplate={OSM_TILE_URL} maximumZ={19} flipY={false} zIndex={-1} />
        </MapView>

        {/* Fixed centre pin — the court goes wherever this sits. */}
        <View pointerEvents="none" style={styles.pinWrap}>
          <Text style={styles.pin}>🎾</Text>
          <View style={styles.pinDot} />
        </View>

        <View style={[styles.hint, { top: insets.top + spacing.sm }]} pointerEvents="none">
          <Text style={styles.hintText}>Drag the map so 🎾 sits on the court</Text>
        </View>

        <Pressable
          style={styles.recenter}
          onPress={recenter}
          accessibilityRole="button"
          accessibilityLabel="Centre on my location"
        >
          {locating ? <ActivityIndicator color={colors.primary} /> : <Text style={styles.recenterIcon}>◎</Text>}
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Card style={styles.form}>
          <Field label="Court name" value={name} onChangeText={setName} placeholder="Central Park Tennis Center" />

          <View style={styles.surfaceRow}>
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
            <Field
              value={addressQuery}
              onChangeText={setAddressQuery}
              placeholder="Jump to an address (optional)"
              style={{ flex: 1 }}
              onSubmitEditing={findAddress}
              autoCapitalize="none"
            />
            <Button label="Find" variant="secondary" onPress={findAddress} loading={searching} disabled={submitting} style={{ paddingHorizontal: spacing.lg }} />
          </View>

          <Button label="Add court here" onPress={submit} loading={submitting} disabled={!name.trim() || searching} />
        </Card>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  mapWrap: { flex: 1, overflow: 'hidden' },
  pinWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Nudge the emoji up so its tip points at the exact centre dot.
  pin: { fontSize: 36, marginBottom: 18 },
  pinDot: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  hint: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  hintText: { color: colors.text, fontWeight: '700', fontSize: font.small },
  recenter: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  recenterIcon: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  form: { margin: spacing.lg, gap: spacing.md },
  surfaceRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  surfaceChip: { padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' },
});

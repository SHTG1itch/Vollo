import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, Card, Field } from '../components/ui';
import { Icon } from '../components/icons';
import { SurfaceBadge } from '../components/SurfaceBadge';
import { OsmMap, type LatLng, type OsmMapHandle } from '../components/OsmMap';
import { showToast } from '../components/Toast';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, radius, shadow, spacing, surfaceColors, surfaceColorsSoft } from '../theme';
import type { Surface } from '../types';
import { newClientKey } from '../utils/idempotency';

type Props = NativeStackScreenProps<RootStackParamList, 'AddCourt'>;
const SURFACES: Surface[] = ['hard', 'clay', 'grass', 'indoor'];
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Android can't run react-native-maps without a Google Maps API key (it crashes),
// so there the map is a keyless Leaflet WebView. iOS uses the native Apple base;
// it must not fetch the public OSM tile service through UrlTile because native
// tile requests cannot provide Vollo's identifying user agent/cache behavior.
const USE_WEB_MAP = Platform.OS === 'android';
const OSM_ATTRIBUTION = USE_WEB_MAP
  ? 'Map/search data © OpenStreetMap contributors'
  : 'Search data © OpenStreetMap contributors';

const DEFAULT_REGION: Region = {
  latitude: 40.78,
  longitude: -73.96,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

export function AddCourtScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const origin = route.params?.origin ?? 'courts';
  // Shared handle type so one ref drives both the native MapView (iOS) and the
  // WebView map (Android).
  const mapRef = useRef<OsmMapHandle>(null);
  // The court's coordinates are wherever the centre pin sits — tracked off-render
  // so panning the map never re-renders the form.
  const center = useRef<{ lat: number; lng: number }>({
    lat: route.params?.lat ?? DEFAULT_REGION.latitude,
    lng: route.params?.lng ?? DEFAULT_REGION.longitude,
  });

  const [name, setName] = useState('');
  const [surface, setSurface] = useState<Surface>('hard');
  const [courtCount, setCourtCount] = useState('1');
  const [addressQuery, setAddressQuery] = useState('');
  // Independent flags: the address "Find" and the "Add court" submit are separate
  // async actions, so one finishing must not re-enable the other mid-flight.
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitActive = useRef(false);
  const clientKey = useRef<string | null>(null);
  const [locating, setLocating] = useState(false);
  // Last known position for the Android WebView map's location dot (iOS uses
  // react-native-maps' built-in showsUserLocation).
  const [userLoc, setUserLoc] = useState<LatLng | null>(null);

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
        setUserLoc({ latitude: r.latitude, longitude: r.longitude });
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
        showToast('Enable location to centre on where you are.', 'error');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({});
      const r = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      center.current = { lat: r.latitude, lng: r.longitude };
      setUserLoc({ latitude: r.latitude, longitude: r.longitude });
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
        showToast('Address not found — try a different one, or just pan the map.', 'error');
        return;
      }
      const r = { ...DEFAULT_REGION, latitude: hit.lat, longitude: hit.lng };
      center.current = { lat: r.latitude, lng: r.longitude };
      mapRef.current?.animateToRegion(r, 450);
    } catch {
      showToast('Address search is busy — just pan the map to the court.', 'error');
    } finally {
      setSearching(false);
    }
  };

  const onRegionChangeComplete = (r: Region) => {
    center.current = { lat: r.latitude, lng: r.longitude };
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitActive.current || submitting) {
      if (!trimmed) showToast('Give the court a name so other players can find it.', 'error');
      return;
    }
    submitActive.current = true;
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

      // Clamp to a sane facility size; courts at one venue form a single sector.
      const count = Math.min(60, Math.max(1, parseInt(courtCount, 10) || 1));
      const requestKey = clientKey.current ?? newClientKey();
      clientKey.current = requestKey;
      const { court } = await api.createCourt({
        client_key: requestKey,
        name: trimmed,
        surface,
        lat: center.current.lat,
        lng: center.current.lng,
        court_count: count,
        ...(city ? { city } : {}),
        ...(address ? { address } : {}),
      });
      clientKey.current = null;

      showToast('Court added 🎾', 'success');
      if (origin === 'log') {
        navigation.navigate('Tabs', { screen: 'Log', params: { newCourtId: court.id } });
      } else {
        // Show the freshly-created court (and its leaderboard) as confirmation.
        navigation.replace('Court', { courtId: court.id });
      }
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not add court — try again', 'error');
    } finally {
      submitActive.current = false;
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        {USE_WEB_MAP ? (
          // Android: keyless OSM map (Leaflet in a WebView). The fixed centre pin
          // below is a plain RN overlay, so the court still goes wherever the map
          // is centred — onRegionChangeComplete tracks that centre identically.
          <OsmMap
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={initialRegion}
            tileUrl={OSM_TILE_URL}
            userLocation={userLoc}
            onRegionChangeComplete={onRegionChangeComplete}
          />
        ) : (
          <MapView
            ref={mapRef as unknown as React.RefObject<MapView>}
            style={StyleSheet.absoluteFill}
            initialRegion={initialRegion}
            onRegionChangeComplete={onRegionChangeComplete}
            showsUserLocation
            rotateEnabled={false}
          />
        )}

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
          {locating ? <ActivityIndicator color={colors.primary} /> : <Icon name="locate" size={22} color={colors.primary} />}
        </Pressable>

        <Pressable
          style={styles.attribution}
          onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright')}
          accessibilityRole="link"
          accessibilityLabel={OSM_ATTRIBUTION}
          hitSlop={6}
        >
          <Text style={styles.attributionText}>{OSM_ATTRIBUTION}</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Card style={styles.form}>
          <Field label="Court name" value={name} onChangeText={setName} placeholder="Central Park Tennis Center" maxLength={120} />

          <View style={styles.surfaceRow}>
            {SURFACES.map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  if (surface !== s) tapLight();
                  setSurface(s);
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

          <View style={styles.countRow}>
            <Field
              label="Courts here"
              value={courtCount}
              onChangeText={(v) => setCourtCount(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              style={{ width: 96 }}
            />
            <Text style={styles.countHint}>All courts at one venue count as a single domination sector.</Text>
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
  hintText: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
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
  attribution: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  attributionText: { color: '#245D8A', fontSize: 9, textDecorationLine: 'underline' },
  form: { margin: spacing.lg, gap: spacing.md },
  surfaceRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  countHint: { flex: 1, color: colors.textDim, fontSize: font.small },
  surfaceChip: { minHeight: 44, justifyContent: 'center', padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' },
});

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, UrlTile, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, font, radius, shadow, spacing, surfaceColors, TERRITORY_FILL, TERRITORY_STROKE } from '../theme';
import type { Court, Territory } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Free OpenStreetMap raster tiles — no vector/commercial map licensing required.
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const DEFAULT_REGION: Region = {
  latitude: 40.78,
  longitude: -73.96,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};

/** Deterministic colour per owner so rival territories are distinguishable. */
function ownerColor(userId: string, self: boolean): { fill: string; stroke: string } {
  if (self) return { fill: TERRITORY_FILL, stroke: TERRITORY_STROKE };
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) % 360;
  return { fill: `hsla(${hash}, 70%, 55%, 0.22)`, stroke: `hsl(${hash}, 70%, 60%)` };
}

function polygonCoords(t: Territory): { latitude: number; longitude: number }[] {
  const ring = t.geometry.coordinates[0] ?? [];
  return ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

export function MapScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  const mapRef = useRef<MapView>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [selected, setSelected] = useState<Territory | null>(null);
  const [locationOff, setLocationOff] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remember the last viewport so we can refresh courts when the screen regains
  // focus (e.g. returning after adding a court) and pass a centre to Add Court.
  const lastRegion = useRef<Region>(DEFAULT_REGION);
  // Drop out-of-order responses: a slow earlier load must not overwrite a newer
  // viewport's overlays (several callers can be in flight — pan, recenter, focus).
  const loadSeq = useRef(0);

  const load = useCallback(async (r: Region) => {
    lastRegion.current = r;
    const seq = ++loadSeq.current;
    const bbox = {
      min_lng: r.longitude - r.longitudeDelta,
      min_lat: r.latitude - r.latitudeDelta,
      max_lng: r.longitude + r.longitudeDelta,
      max_lat: r.latitude + r.latitudeDelta,
    };
    try {
      const [{ territories: terr }, courtRes] = await Promise.all([
        api.getTerritories(bbox),
        // Discover real-world OSM courts in view; fall back to the plain nearby
        // list if discovery is unavailable.
        api
          .discoverCourts(bbox)
          .catch(() => api.getCourts({ lat: r.latitude, lng: r.longitude, radius_km: 60, limit: 100 })),
      ]);
      if (seq !== loadSeq.current) return; // a newer load already won
      setTerritories(terr);
      setCourts(courtRes.courts);
    } catch {
      /* keep current overlays */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      let start = DEFAULT_REGION;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          start = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          // Programmatic move via the ref — don't drive the map from state.
          mapRef.current?.animateToRegion(start, 600);
        } else {
          setLocationOff(true);
        }
      } catch {
        setLocationOff(true);
      }
      void load(start);
    })();
  }, [load]);

  // Re-request location and recenter the map on the user.
  const recenter = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationOff(true);
        return;
      }
      setLocationOff(false);
      const pos = await Location.getCurrentPositionAsync({});
      const region = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      mapRef.current?.animateToRegion(region, 600);
      void load(region);
    } catch {
      /* keep current view */
    }
  }, [load]);

  // Clear any pending debounce when the screen unmounts.
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  // Refresh courts/territories when the screen regains focus (e.g. after adding
  // a court). Skip the very first focus — the mount effect already loaded.
  const didFocus = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!didFocus.current) {
        didFocus.current = true;
        return;
      }
      void load(lastRegion.current);
    }, [load]),
  );

  const onRegionChange = (r: Region) => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(r), 600);
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={DEFAULT_REGION}
        onRegionChangeComplete={onRegionChange}
        mapType="none"
        showsUserLocation
        rotateEnabled={false}
      >
        <UrlTile urlTemplate={OSM_TILE_URL} maximumZ={19} flipY={false} zIndex={-1} />

        {territories.map((t) => {
          const isSelf = t.user_id === user?.id;
          const c = ownerColor(t.user_id, isSelf);
          return (
            <Polygon
              key={t.id}
              coordinates={polygonCoords(t)}
              fillColor={c.fill}
              strokeColor={c.stroke}
              strokeWidth={2}
              tappable
              onPress={() => setSelected(t)}
            />
          );
        })}

        {courts.map((court) => (
          <Marker
            key={court.id}
            coordinate={{ latitude: court.lat, longitude: court.lng }}
            title={court.name}
            description={court.city ?? undefined}
            pinColor={surfaceColors[court.surface]}
            onCalloutPress={() => navigation.navigate('Court', { courtId: court.id })}
          />
        ))}
      </MapView>

      {/* Title + add-court control */}
      <View style={[styles.topBar, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
        <View style={styles.titlePill}>
          <Text style={styles.title}>🗺️ Domination Map</Text>
        </View>
        <Pressable
          style={styles.addBtn}
          onPress={() => navigation.navigate('Courts')}
          accessibilityRole="button"
          accessibilityLabel="Add or browse courts"
        >
          <Text style={styles.addBtnText}>＋ Courts</Text>
        </Pressable>
      </View>

      {/* Location-off hint */}
      {locationOff ? (
        <View style={[styles.banner, { top: insets.top + 52 }]} pointerEvents="box-none">
          <Text style={styles.bannerText}>📍 Location is off — showing a default area.</Text>
        </View>
      ) : null}

      {/* Add a court at the current map area */}
      <Pressable
        style={styles.addCourt}
        onPress={() =>
          navigation.navigate('AddCourt', {
            origin: 'map',
            lat: lastRegion.current.latitude,
            lng: lastRegion.current.longitude,
          })
        }
        accessibilityRole="button"
        accessibilityLabel="Add a court"
      >
        <Text style={styles.addCourtIcon}>＋</Text>
        <Text style={styles.addCourtText}>Court</Text>
      </Pressable>

      {/* Recenter on me */}
      <Pressable
        style={styles.recenter}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Recenter map on my location"
      >
        <Text style={styles.recenterIcon}>◎</Text>
      </Pressable>

      {/* Selected territory card */}
      {selected ? (
        <View style={styles.detailCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.detailDistrict}>{selected.district_name}</Text>
            <Text style={styles.detailOwner}>
              held by @{selected.owner_username ?? 'unknown'} · {selected.court_count} courts · {selected.area_sqkm.toFixed(1)} km²
            </Text>
          </View>
          <Pressable
            onPress={() =>
              selected.owner_username
                ? navigation.navigate('UserProfile', { username: selected.owner_username })
                : setSelected(null)
            }
            style={styles.detailBtn}
          >
            <Text style={styles.detailBtnText}>View</Text>
          </Pressable>
          <Pressable
            onPress={() => setSelected(null)}
            hitSlop={8}
            style={{ paddingHorizontal: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss territory details"
          >
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.legend}>
          <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={styles.legendText}>You</Text>
          {/* Each rival gets a distinct hashed hue, so show a few sample colours
              rather than one swatch the rendered polygons never actually use. */}
          <View style={styles.rivalDots}>
            <View style={[styles.legendDot, { backgroundColor: 'hsl(20, 70%, 60%)' }]} />
            <View style={[styles.legendDot, { backgroundColor: 'hsl(140, 70%, 60%)', marginLeft: -3 }]} />
            <View style={[styles.legendDot, { backgroundColor: 'hsl(260, 70%, 60%)', marginLeft: -3 }]} />
          </View>
          <Text style={styles.legendText}>Rivals</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    position: 'absolute',
    top: spacing.xxl,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titlePill: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  title: { color: colors.text, fontWeight: '800', fontSize: font.small },
  addBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, ...shadow.card },
  addBtnText: { color: colors.onPrimary, fontWeight: '800', fontSize: font.small },
  detailCard: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    ...shadow.card,
  },
  detailDistrict: { color: colors.text, fontWeight: '800', fontSize: font.h3 },
  detailOwner: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  detailBtn: { backgroundColor: colors.primarySoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md },
  detailBtnText: { color: colors.primary, fontWeight: '800' },
  close: { color: colors.textDim, fontSize: font.body },
  legend: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  rivalDots: { flexDirection: 'row', alignItems: 'center', marginLeft: spacing.md },
  legendText: { color: colors.textDim, fontSize: font.tiny },
  banner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    ...shadow.card,
  },
  bannerText: { color: colors.textDim, fontSize: font.small, fontWeight: '600' },
  recenter: {
    position: 'absolute',
    right: spacing.lg,
    bottom: 96,
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
  addCourt: {
    position: 'absolute',
    right: spacing.lg,
    bottom: 150,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    ...shadow.card,
  },
  addCourtIcon: { color: colors.onPrimary, fontSize: 20, fontWeight: '900' },
  addCourtText: { color: colors.onPrimary, fontSize: font.small, fontWeight: '800' },
});

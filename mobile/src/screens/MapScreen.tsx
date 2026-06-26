import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, UrlTile, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
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
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (r: Region) => {
    const bbox = {
      min_lng: r.longitude - r.longitudeDelta,
      min_lat: r.latitude - r.latitudeDelta,
      max_lng: r.longitude + r.longitudeDelta,
      max_lat: r.latitude + r.latitudeDelta,
    };
    try {
      const [{ territories: t }, { courts: c }] = await Promise.all([
        api.getTerritories(bbox),
        api.getCourts({ lat: r.latitude, lng: r.longitude, radius_km: 60, limit: 100 }),
      ]);
      setTerritories(t);
      setCourts(c);
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
        }
      } catch {
        /* default region */
      }
      void load(start);
    })();
  }, [load]);

  // Clear any pending debounce when the screen unmounts.
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

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
          <Text style={styles.legendText}>Your territory</Text>
          <View style={[styles.legendDot, { backgroundColor: colors.rival, marginLeft: spacing.md }]} />
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
  legendText: { color: colors.textDim, fontSize: font.tiny },
});

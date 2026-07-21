import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InteractionManager, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { OsmMap, type LatLng, type OsmMapHandle, type OsmMarker, type OsmPolygon } from '../components/OsmMap';
import { Icon } from '../components/icons';
import { showToast } from '../components/Toast';
import { colors, font, fonts, radius, shadow, spacing, surfaceColors, TERRITORY_STROKE } from '../theme';
import type { Court, Territory } from '../types';
import { regionToBbox } from '../utils/mapRegion';

// Android can't run react-native-maps without a Google Maps API key (it would
// crash), so there it renders the same OSM map via a keyless Leaflet WebView.
// iOS keeps using react-native-maps (Apple Maps engine, no key needed).
const USE_WEB_MAP = Platform.OS === 'android';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Free OpenStreetMap raster tiles — no vector/commercial map licensing required.
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const DEFAULT_REGION: Region = {
  latitude: 40.78,
  longitude: -73.96,
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};

// Past this zoom-out the map would have to draw hundreds of pins (every pin is a
// native view) — slow and a known crash vector. Above it we hide court pins and
// show a "zoom in" hint; territories still render.
const MAX_COURT_DELTA = 0.4;
// Hard caps on simultaneously-rendered native overlays. Courts arrive ordered by
// court_count (biggest facilities first) and territories by area, so the caps
// keep the most significant ones and a dense metro can't flood — and crash — the
// map with native views. Kept conservative: every marker/polygon is a native
// view, and fast pan/zoom churns them, so fewer = far less crash surface.
const MAX_MARKERS = 90;
const MAX_TERRITORIES = 40;
// A single polygon ring with hundreds of vertices is itself a native-render
// hazard on Android. Concave-hull territories can be detailed, so cap the
// vertices we hand the native layer and evenly downsample anything larger.
const MAX_POLY_VERTICES = 80;

// A fixed, map-legible palette for rivals who haven't picked a colour. Hex only:
// react-native-maps' native layer is unreliable with hsl()/hsla() colour strings
// (a known Android crash), so every polygon colour we emit is #RRGGBB / #RRGGBBAA.
const RIVAL_PALETTE = ['#E0432B', '#2477C9', '#7E6CC4', '#E8990C', '#C05B22', '#1F9E8A', '#D81B8C', '#5B7CFA'];
const HEX6 = /^#[0-9A-Fa-f]{6}$/;
// 0x66 / 255 ≈ 0.40 — the 40%-transparent wash the spec calls for.
const FILL_ALPHA = '66';

function hashIndex(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return h % mod;
}

/**
 * A player's signature colour as a solid stroke + a 40%-opacity fill, so rivals'
 * overlapping zones stay see-through and distinguishable. Falls back to brand
 * green for you and a deterministic palette hue for rivals with no colour set.
 */
function zoneColors(t: Territory, self: boolean): { fill: string; stroke: string } {
  const base =
    (t.owner_color && HEX6.test(t.owner_color) ? t.owner_color : null) ??
    (self ? TERRITORY_STROKE : RIVAL_PALETTE[hashIndex(t.user_id, RIVAL_PALETTE.length)]!);
  return { fill: `${base}${FILL_ALPHA}`, stroke: base };
}

function polygonCoords(t: Territory): { latitude: number; longitude: number }[] {
  const ring = t.geometry.coordinates[0] ?? [];
  const points = ring.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  if (points.length <= MAX_POLY_VERTICES) return points;
  // Evenly downsample an over-detailed ring, always keeping the closing vertex so
  // the polygon stays closed.
  const step = points.length / MAX_POLY_VERTICES;
  const out: { latitude: number; longitude: number }[] = [];
  for (let i = 0; i < MAX_POLY_VERTICES; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

/** True only when two overlay sets differ enough to be worth swapping into the
 *  native layer — i.e. the id list changed. Re-using the previous array keeps
 *  React from unmounting/remounting every native Marker/Polygon on a pan that
 *  returned the same features (the main fast-gesture crash/jank driver). */
function sameIds(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

/** Territories also need a refresh when their data changes even if the id set is
 *  identical. updated_at catches geometry/zone shifts, but owner colour/name/wins
 *  are JOINed from the users table (which doesn't bump territories.updated_at), so
 *  compare those explicitly or a profile colour edit would leave a stale polygon. */
function territoriesEqual(a: Territory[], b: Territory[]): boolean {
  if (!sameIds(a, b)) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.updated_at !== y.updated_at ||
      x.owner_color !== y.owner_color ||
      x.owner_username !== y.owner_username ||
      x.owner_display_name !== y.owner_display_name ||
      x.owner_zone_wins !== y.owner_zone_wins
    ) {
      return false;
    }
  }
  return true;
}

/** Courts have no updated_at, so sameIds alone would suppress a surface/name/count
 *  change on an already-loaded facility. Compare the display-relevant fields too. */
function courtsEqual(a: Court[], b: Court[]): boolean {
  if (!sameIds(a, b)) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.surface !== y.surface || x.court_count !== y.court_count || x.name !== y.name || x.city !== y.city) {
      return false;
    }
  }
  return true;
}

/** Skip reloading overlays for negligible viewport changes (micro-pans / no real
 *  zoom). This is what stops a flurry of fast gestures from each triggering a
 *  full overlay swap on the native map. */
function regionChangedEnough(prev: Region, next: Region): boolean {
  const latSpan = Math.max(prev.latitudeDelta, next.latitudeDelta, 1e-6);
  const lngSpan = Math.max(prev.longitudeDelta, next.longitudeDelta, 1e-6);
  const movedLat = Math.abs(prev.latitude - next.latitude) / latSpan;
  const movedLng = Math.abs(prev.longitude - next.longitude) / lngSpan;
  const zoomRatio = prev.latitudeDelta / Math.max(next.latitudeDelta, 1e-6);
  const zoomed = zoomRatio < 0.8 || zoomRatio > 1.25;
  return movedLat > 0.25 || movedLng > 0.25 || zoomed;
}

/**
 * A single court pin. Memoised + tracksViewChanges={false} so react-native-maps
 * stops continuously re-rendering every marker's native view — the single most
 * important fix for map jank/crashes with many markers.
 */
const CourtMarker = React.memo(function CourtMarker({
  court,
  onPress,
}: {
  court: Court;
  onPress: (id: string) => void;
}) {
  const desc =
    court.court_count > 1
      ? `${court.court_count} courts${court.city ? ` · ${court.city}` : ''}`
      : court.city ?? undefined;
  return (
    <Marker
      coordinate={{ latitude: court.lat, longitude: court.lng }}
      title={court.name}
      description={desc}
      pinColor={surfaceColors[court.surface]}
      tracksViewChanges={false}
      onCalloutPress={() => onPress(court.id)}
    />
  );
});

export function MapScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<TabParamList, 'Map'>>();
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  // Typed as the shared handle so the same ref drives the native MapView (iOS) and
  // the WebView map (Android) — both expose animateToRegion.
  const mapRef = useRef<OsmMapHandle>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [courts, setCourts] = useState<Court[]>([]);
  const [overlayLoadError, setOverlayLoadError] = useState(false);
  const [selected, setSelected] = useState<Territory | null>(null);
  const [locationOff, setLocationOff] = useState(false);
  // Last known position for the Android WebView map's "you are here" dot (iOS uses
  // react-native-maps' built-in showsUserLocation instead).
  const [userLoc, setUserLoc] = useState<LatLng | null>(null);
  // Drives the zoom gate: true only when zoomed in enough to render court pins.
  const [zoomedIn, setZoomedIn] = useState(true);
  // While the user is actively panning/zooming we unmount ALL native overlays
  // (markers + polygons) and re-mount them only once the gesture settles. A fast
  // zoom otherwise churns dozens of native views every frame — the dominant
  // Android crash vector. One unmount at gesture start + one remount at settle is
  // cheap; the per-frame churn it removes is what crashed the map.
  const [interacting, setInteracting] = useState(false);
  // Mirrors `interacting` so the per-frame onRegionChange handler can flip the
  // state exactly once per gesture instead of calling setState every frame.
  const interactingRef = useRef(false);
  // Whether a finger is currently on the map, so the settle safety-net never
  // fires mid-gesture during a stationary hold (it waits for touch-up).
  const touchingRef = useRef(false);
  // Latest region seen during a gesture, so the settle safety-net loads where the
  // user actually ended up (onRegionChange fires before any load updates refs).
  const liveRegion = useRef<Region>(DEFAULT_REGION);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remember the last viewport so we can refresh courts when the screen regains
  // focus (e.g. returning after adding a court) and pass a centre to Add Court.
  const lastRegion = useRef<Region>(DEFAULT_REGION);
  // The viewport a load actually fired for — the baseline the change-threshold is
  // measured against. Kept separate from lastRegion so a run of sub-threshold
  // pans (which keep advancing lastRegion) still accumulates and eventually
  // crosses the threshold instead of resetting the baseline every settle.
  const lastLoadedRegion = useRef<Region>(DEFAULT_REGION);
  // Drop out-of-order responses: a slow earlier load must not overwrite a newer
  // viewport's overlays (several callers can be in flight — pan, recenter, focus).
  const loadSeq = useRef(0);
  // A territory id we've been asked to highlight once its data lands (deep-link
  // from a profile's "view on map"); cleared as soon as we select it.
  const pendingFocusId = useRef<string | null>(null);

  // Commit overlay state on the next idle frame and only when the content
  // actually changed, so a swap never competes with an in-flight gesture and
  // unchanged features keep their existing native views (no remount churn).
  const commitTerritories = useCallback((seq: number, next: Territory[]) => {
    InteractionManager.runAfterInteractions(() => {
      if (seq !== loadSeq.current) return;
      setTerritories((prev) => (territoriesEqual(prev, next) ? prev : next));
    });
  }, []);
  const commitCourts = useCallback((seq: number, next: Court[]) => {
    InteractionManager.runAfterInteractions(() => {
      if (seq !== loadSeq.current) return;
      setCourts((prev) => (courtsEqual(prev, next) ? prev : next));
    });
  }, []);

  const load = useCallback(
    async (r: Region, opts: { force?: boolean } = {}) => {
      // Always track the live viewport (Add Court centre, focus refresh).
      lastRegion.current = r;
      // Coalesce negligible viewport changes vs the last viewport we actually
      // loaded — a fast flurry of pans/zooms would otherwise each swap the native
      // overlay set and can crash the map. Comparing against lastLoadedRegion (not
      // the live ref) means cumulative small pans still eventually reload.
      if (!opts.force && !regionChangedEnough(lastLoadedRegion.current, r)) return;
      lastLoadedRegion.current = r;
      const zoom = r.latitudeDelta <= MAX_COURT_DELTA;
      setZoomedIn(zoom);
      const seq = ++loadSeq.current;
      const bbox = regionToBbox(r);
      // 1) Instant paint: territories + courts straight from the DB (no Overpass),
      //    so overlays appear immediately and panning never waits on the network.
      const [territoryResult, courtResult] = await Promise.allSettled([
        api.getTerritories(bbox),
        api
          .discoverCourts(bbox, { discover: false })
          .catch(() => api.getCourts({ lat: r.latitude, lng: r.longitude, radius_km: 60, limit: MAX_MARKERS })),
      ]);
      if (seq !== loadSeq.current) return; // a newer load already won
      if (territoryResult.status === 'fulfilled') {
        commitTerritories(seq, territoryResult.value.territories);
      }
      if (courtResult.status === 'fulfilled') {
        commitCourts(seq, courtResult.value.courts);
      }
      setOverlayLoadError(territoryResult.status === 'rejected' || courtResult.status === 'rejected');

      // 2) Background: pull any new real-world courts from OpenStreetMap. This is
      //    the slow call (Overpass), so it runs AFTER paint and only when zoomed in
      //    enough to matter — the visible map is never blocked by it. The seq guard
      //    makes this the authoritative set for the current viewport.
      if (!zoom) return;
      void api
        .discoverCourts(bbox, { discover: true })
        .then((res) => commitCourts(seq, res.courts))
        .catch(() => {});
    },
    [commitTerritories, commitCourts],
  );

  useEffect(() => {
    // If we were opened to focus a specific zone (deep-link), let the focus
    // effect own the initial camera + load — otherwise this mount load races it
    // and, by incrementing loadSeq last, deterministically clobbers the focus.
    if (route.params?.focusLat != null && route.params?.focusLng != null) return;
    void (async () => {
      let start = DEFAULT_REGION;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({});
          start = { ...DEFAULT_REGION, latitude: pos.coords.latitude, longitude: pos.coords.longitude };
          setUserLoc({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
          // Programmatic move via the ref — don't drive the map from state.
          mapRef.current?.animateToRegion(start, 600);
        } else {
          setLocationOff(true);
        }
      } catch {
        setLocationOff(true);
      }
      void load(start, { force: true });
    })();
    // route.params is read once at mount to decide whether to defer; later focus
    // navigations arrive while mounted and are handled by the focus effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Deep-link focus: a profile asked us to fly to and highlight a zone. After
  // handling we clear the params, which both prevents a re-render loop and lets
  // a repeat tap (even of the same zone) re-fire a fresh focus.
  useEffect(() => {
    const p = route.params;
    if (p?.focusLat == null || p?.focusLng == null) return;
    const region: Region = {
      latitude: p.focusLat,
      longitude: p.focusLng,
      latitudeDelta: 0.08,
      longitudeDelta: 0.08,
    };
    pendingFocusId.current = p.focusTerritoryId ?? null;
    mapRef.current?.animateToRegion(region, 700);
    void load(region, { force: true });
    (navigation.setParams as (params: Record<string, undefined>) => void)({
      focusLat: undefined,
      focusLng: undefined,
      focusTerritoryId: undefined,
    });
  }, [route.params, load, navigation]);

  // Once territories for a focused viewport arrive, select the requested one so
  // its "who's dominating" card pops without another tap.
  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    const found = territories.find((t) => t.id === id);
    if (found) {
      setSelected(found);
      pendingFocusId.current = null;
    }
  }, [territories]);

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
      setUserLoc({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      mapRef.current?.animateToRegion(region, 600);
      void load(region, { force: true });
    } catch {
      showToast('Could not get your location. Check location services and try again.', 'error');
    }
  }, [load]);

  // Clear any pending timers when the screen unmounts.
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
    if (settleTimer.current) clearTimeout(settleTimer.current);
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
      void load(lastRegion.current, { force: true });
    }, [load]),
  );

  // Continuous: fires every frame during a gesture (and during programmatic
  // animations). Flip into "interacting" exactly once so the native overlays
  // unmount for the duration of the gesture — no per-frame view churn.
  const onRegionChange = useCallback(
    (r: Region) => {
      liveRegion.current = r;
      if (!interactingRef.current) {
        interactingRef.current = true;
        setInteracting(true);
      }
      // Safety net for when onRegionChangeComplete is dropped (Android can drop
      // it for a flung gesture). Re-armed every frame, so it fires only once
      // motion stops — and NOT while a finger is still down (a mid-drag pause),
      // which would otherwise flash overlays back mid-gesture. Short delay since
      // it only ever runs post-motion; the normal complete handler settles instantly.
      if (settleTimer.current) clearTimeout(settleTimer.current);
      const settle = () => {
        if (touchingRef.current) {
          settleTimer.current = setTimeout(settle, 350); // finger still down — keep waiting
          return;
        }
        interactingRef.current = false;
        setInteracting(false);
        setZoomedIn(liveRegion.current.latitudeDelta <= MAX_COURT_DELTA);
        void load(liveRegion.current);
      };
      settleTimer.current = setTimeout(settle, 350);
    },
    [load],
  );

  // Settled: the gesture finished. Remount overlays, update the zoom gate, and
  // debounce the data reload for the new viewport.
  const onRegionChangeComplete = useCallback(
    (r: Region) => {
      // Update immediately so "Add court" cannot use the old centre during the
      // network-load debounce window.
      liveRegion.current = r;
      lastRegion.current = r;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      interactingRef.current = false;
      setInteracting(false);
      setZoomedIn(r.latitudeDelta <= MAX_COURT_DELTA);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(r), 550);
    },
    [load],
  );

  const openCourt = useCallback((id: string) => navigation.navigate('Court', { courtId: id }), [navigation]);

  // Only render pins when zoomed in AND not mid-gesture, capped so a dense metro
  // can't flood the map with native views. Hiding them while interacting is the
  // key anti-crash move: the native marker set never churns during a zoom/pan.
  const visibleCourts = useMemo(
    () => (zoomedIn && !interacting ? courts.slice(0, MAX_MARKERS) : []),
    [courts, zoomedIn, interacting],
  );

  // Pre-build capped polygon descriptors once per territory/identity change, so
  // panning doesn't re-derive every ring's coordinates (and colour) each render.
  // A focused/selected zone is always included even if it sorts past the cap, so
  // the highlighted polygon the detail card refers to is actually drawn. Empty
  // while interacting so polygons don't churn during a gesture either.
  const polygons = useMemo(() => {
    // Drop the full overlay set during a gesture to avoid native-view churn, but
    // keep the one selected zone's polygon so its detail card always has a
    // matching highlight (a single static polygon doesn't churn).
    const shown = interacting ? [] : territories.slice(0, MAX_TERRITORIES);
    if (selected && !shown.some((t) => t.id === selected.id)) {
      const extra = territories.find((t) => t.id === selected.id);
      if (extra) shown.push(extra);
    }
    return shown.map((t) => {
      const isSelf = t.user_id === user?.id;
      return { t, coords: polygonCoords(t), ...zoneColors(t, isSelf) };
    });
  }, [territories, user?.id, selected, interacting]);

  const selectedColors = selected ? zoneColors(selected, selected.user_id === user?.id) : null;

  // Android (WebView) overlay sets. Unlike the native MapView these don't churn
  // native views, so they're NOT dropped during a gesture (the `interacting` gate)
  // — Leaflet redraws cheaply and the overlays stay put while panning. Still zoom-
  // gated + capped like iOS so a dense metro can't overload the page.
  const androidMarkers = useMemo<OsmMarker[]>(() => {
    if (!USE_WEB_MAP || !zoomedIn) return [];
    return courts.slice(0, MAX_MARKERS).map((c) => ({
      id: c.id,
      latitude: c.lat,
      longitude: c.lng,
      color: surfaceColors[c.surface],
      title: c.name,
      description:
        c.court_count > 1
          ? `${c.court_count} courts${c.city ? ` · ${c.city}` : ''}`
          : c.city ?? undefined,
    }));
  }, [courts, zoomedIn]);

  const androidPolygons = useMemo<OsmPolygon[]>(() => {
    if (!USE_WEB_MAP) return [];
    const shown = territories.slice(0, MAX_TERRITORIES);
    if (selected && !shown.some((t) => t.id === selected.id)) {
      const extra = territories.find((t) => t.id === selected.id);
      if (extra) shown.push(extra);
    }
    return shown.map((t) => {
      const { stroke } = zoneColors(t, t.user_id === user?.id);
      return {
        id: t.id,
        coordinates: polygonCoords(t),
        strokeColor: stroke,
        fillColor: stroke,
        fillOpacity: 0.4,
        strokeWidth: 2,
      };
    });
  }, [territories, selected, user?.id]);

  return (
    <View style={styles.container}>
      {USE_WEB_MAP ? (
        // Android: keyless OSM map (Leaflet in a WebView). Same overlays, no Google
        // Maps API key, no cost. The native-view-churn mitigations the iOS path
        // needs (interacting gate, tracksViewChanges) don't apply here.
        <OsmMap
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={DEFAULT_REGION}
          minZoom={3}
          maxZoom={19}
          tileUrl={OSM_TILE_URL}
          markers={androidMarkers}
          polygons={androidPolygons}
          userLocation={userLoc}
          onRegionChange={onRegionChange}
          onRegionChangeComplete={onRegionChangeComplete}
          onMarkerPress={openCourt}
          onPolygonPress={(id) => {
            const t = territories.find((x) => x.id === id);
            if (t) setSelected(t);
          }}
        />
      ) : (
        <MapView
          ref={mapRef as unknown as React.RefObject<MapView>}
          style={StyleSheet.absoluteFill}
          initialRegion={DEFAULT_REGION}
          onRegionChange={onRegionChange}
          onRegionChangeComplete={onRegionChangeComplete}
          onTouchStart={() => { touchingRef.current = true; }}
          onTouchEnd={() => { touchingRef.current = false; }}
          onTouchCancel={() => { touchingRef.current = false; }}
          // Use Apple's native base map on iOS. This avoids unidentified native
          // requests to the community OSM raster-tile service; OSM still powers
          // the court data and is attributed below.
          mapType="standard"
          showsUserLocation
          rotateEnabled={false}
          pitchEnabled={false}
          moveOnMarkerPress={false}
          toolbarEnabled={false}
          // Bound the zoom range: zooming far out would request a huge bbox (and a
          // world of raster tiles + every territory) — a memory/crash risk — and
          // the deep zoom past tile coverage just wastes work.
          minZoomLevel={3}
          maxZoomLevel={19}
          // Don't animate to the user dot on first fix; we drive the camera ourselves.
          followsUserLocation={false}
        >
          {polygons.map(({ t, coords, fill, stroke }) => (
            <Polygon
              key={t.id}
              coordinates={coords}
              fillColor={fill}
              strokeColor={stroke}
              strokeWidth={2}
              tappable
              onPress={() => setSelected(t)}
            />
          ))}

          {visibleCourts.map((court) => (
            // Key includes surface so a pin recolours on a surface change despite
            // tracksViewChanges={false} (which otherwise freezes the native pin).
            <CourtMarker key={`${court.id}:${court.surface}`} court={court} onPress={openCourt} />
          ))}
        </MapView>
      )}

      <Pressable
        style={styles.attribution}
        onPress={() => void Linking.openURL('https://www.openstreetmap.org/copyright')}
        accessibilityRole="link"
        accessibilityLabel="OpenStreetMap copyright and contributors"
      >
        <Text style={styles.attributionText}>© OpenStreetMap contributors</Text>
      </Pressable>

      {/* Zoomed too far out to show pins without choking the map */}
      {!zoomedIn && !locationOff ? (
        <View style={[styles.banner, { top: insets.top + 52 }]} pointerEvents="none">
          <Text style={styles.bannerText}>🔍 Zoom in to see courts</Text>
        </View>
      ) : null}

      {/* Title + search control */}
      <View style={[styles.topBar, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
        <View style={styles.titlePill}>
          <Text style={styles.title}>🗺️ Domination Map</Text>
        </View>
        {/* A search icon (distinct from the ＋ Court FAB) so it's clear this is
            for finding/browsing courts, not adding one. */}
        <Pressable
          style={styles.searchBtn}
          onPress={() => navigation.navigate('Courts')}
          accessibilityRole="button"
          accessibilityLabel="Search courts"
        >
          <Icon name="search" size={20} color={colors.text} />
        </Pressable>
      </View>

      {/* Location-off hint */}
      {locationOff ? (
        <View style={[styles.banner, { top: insets.top + 52 }]} pointerEvents="box-none">
          <Text style={styles.bannerText}>📍 Location is off — showing a default area.</Text>
        </View>
      ) : null}

      {overlayLoadError ? (
        <View
          style={[styles.dataErrorBanner, { top: insets.top + (!zoomedIn || locationOff ? 100 : 52) }]}
          accessibilityLiveRegion="assertive"
        >
          <Text style={styles.bannerText}>Some map data couldn’t load.</Text>
          <Pressable
            onPress={() => void load(lastRegion.current, { force: true })}
            style={styles.dataErrorRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry loading map data"
          >
            <Text style={styles.dataErrorRetryText}>Try again</Text>
          </Pressable>
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
        <Icon name="plus" size={18} color={colors.onPrimary} strokeWidth={2.6} />
        <Text style={styles.addCourtText}>Court</Text>
      </Pressable>

      {/* Recenter on me */}
      <Pressable
        style={styles.recenter}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Recenter map on my location"
      >
        <Icon name="locate" size={22} color={colors.primary} />
      </Pressable>

      {/* Selected territory card — who's dominating this zone, and what it takes
          to claim it */}
      {selected && selectedColors ? (
        <View style={[styles.detailCard, { borderColor: selectedColors.stroke }]}>
          <View style={styles.detailTop}>
            <View style={[styles.zoneSwatch, { backgroundColor: selectedColors.fill, borderColor: selectedColors.stroke }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.detailDistrict}>{selected.district_name}</Text>
              <Text style={styles.detailOwner}>👑 Dominated by @{selected.owner_username ?? 'unknown'}</Text>
            </View>
            <Pressable
              onPress={() => setSelected(null)}
              hitSlop={8}
              style={{ paddingHorizontal: spacing.xs }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss territory details"
            >
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.detailStats}>
            <Text style={styles.detailStat}>🎾 {selected.court_count} courts</Text>
            <Text style={styles.detailStat}>📐 {selected.area_sqkm.toFixed(1)} km²</Text>
            <Text style={styles.detailStat}>🏆 {selected.owner_zone_wins ?? 0} wins here</Text>
          </View>

          <Text style={styles.detailHint}>
            {selected.user_id === user?.id
              ? 'Your turf — keep winning here to hold it.'
              : `Beat ${selected.owner_zone_wins ?? 0} wins in this zone to claim it from @${selected.owner_username ?? 'them'}.`}
          </Text>

          <View style={styles.detailActions}>
            {selected.owner_username ? (
              <Pressable
                onPress={() => navigation.navigate('UserProfile', { username: selected.owner_username! })}
                style={[styles.detailBtn, { flex: 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`View @${selected.owner_username}'s profile`}
              >
                <Text style={styles.detailBtnText}>View player</Text>
              </Pressable>
            ) : null}
            {selected.owner_username && selected.user_id !== user?.id ? (
              <Pressable
                onPress={() =>
                  navigation.navigate('ScheduleMatch', {
                    opponentId: selected.user_id,
                    opponentName: selected.owner_display_name ?? selected.owner_username,
                    opponentUsername: selected.owner_username,
                    challenge: true,
                  })
                }
                style={[styles.detailBtn, styles.detailBtnPrimary, { flex: 1 }]}
                accessibilityRole="button"
                accessibilityLabel={`Challenge @${selected.owner_username}`}
              >
                <Text style={[styles.detailBtnText, styles.detailBtnTextPrimary]}>⚔️ Challenge</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : (
        <View style={styles.legend}>
          <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
          <Text style={styles.legendText}>You</Text>
          {/* Rivals each get their own colour (their pick, else a palette hue). */}
          <View style={styles.rivalDots}>
            <View style={[styles.legendDot, { backgroundColor: RIVAL_PALETTE[0] }]} />
            <View style={[styles.legendDot, { backgroundColor: RIVAL_PALETTE[1], marginLeft: -3 }]} />
            <View style={[styles.legendDot, { backgroundColor: RIVAL_PALETTE[2], marginLeft: -3 }]} />
          </View>
          <Text style={styles.legendText}>Rivals · tap a zone</Text>
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
  title: { color: colors.text, fontFamily: fonts.heading, fontSize: font.body },
  searchBtn: {
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
  detailCard: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    ...shadow.card,
  },
  detailTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  zoneSwatch: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 2 },
  detailDistrict: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  detailOwner: { color: colors.textDim, fontSize: font.small, marginTop: 2 },
  detailStats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  detailStat: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.medium },
  detailHint: { color: colors.textFaint, fontSize: font.tiny },
  detailActions: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  detailBtn: { backgroundColor: colors.primarySoft, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, alignItems: 'center' },
  detailBtnText: { color: colors.primary, fontFamily: fonts.bold },
  detailBtnPrimary: { backgroundColor: colors.primary },
  detailBtnTextPrimary: { color: colors.onPrimary },
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
  dataErrorBanner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    minHeight: 44,
    paddingLeft: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.loss,
    ...shadow.card,
  },
  dataErrorRetry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md },
  dataErrorRetryText: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.small },
  bannerText: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.medium },
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
  addCourtText: { color: colors.onPrimary, fontSize: font.small, fontFamily: fonts.bold },
  attribution: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(255,255,255,0.88)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
  },
  attributionText: { color: '#245D8A', fontSize: 9, textDecorationLine: 'underline' },
});

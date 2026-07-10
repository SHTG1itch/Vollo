import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Region } from 'react-native-maps';
import { colors, font, fonts, radius, spacing } from '../theme';

// A keyless OpenStreetMap map for Android, rendered with Leaflet inside a WebView.
//
// Why this exists: react-native-maps on Android can only host its overlays on the
// Google Maps engine, which hard-requires a `com.google.android.geo.API_KEY` in the
// manifest (and a billing-enabled Google Cloud account) — it crashes without one.
// iOS uses Apple Maps (no key) so it's unaffected and keeps using react-native-maps.
// This component gives Android the same OSM map with zero API key and zero cost,
// exposing the small slice of the react-native-maps API the app actually uses:
// `animateToRegion` (imperative), region tracking, tappable pins + polygons.

export type LatLng = { latitude: number; longitude: number };

export type OsmMarker = {
  id: string;
  latitude: number;
  longitude: number;
  color: string;
  title: string;
  description?: string;
};

export type OsmPolygon = {
  id: string;
  coordinates: LatLng[];
  strokeColor: string;
  fillColor: string;
  fillOpacity?: number;
  strokeWidth?: number;
};

/** The subset of the react-native-maps MapView ref the screens call. Both the
 *  native MapView (iOS) and this WebView map (Android) satisfy it, so a screen can
 *  keep a single `mapRef` regardless of platform. */
export type OsmMapHandle = { animateToRegion: (region: Region, duration?: number) => void };

type Props = {
  style?: StyleProp<ViewStyle>;
  initialRegion: Region;
  markers?: OsmMarker[];
  polygons?: OsmPolygon[];
  userLocation?: LatLng | null;
  minZoom?: number;
  maxZoom?: number;
  tileUrl?: string;
  onRegionChange?: (region: Region) => void;
  onRegionChangeComplete?: (region: Region) => void;
  onMarkerPress?: (id: string) => void;
  onPolygonPress?: (id: string) => void;
};

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

// Pinned Leaflet — loaded from a free CDN. The map already needs the network for
// OSM tiles, so a CDN script is no extra connectivity requirement, and unpkg is $0.
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

function buildHtml(region: Region, minZoom: number, maxZoom: number, tileUrl: string): string {
  const cfg = JSON.stringify({ region, minZoom, maxZoom, tileUrl });
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://unpkg.com; style-src 'unsafe-inline' https://unpkg.com; img-src data: https:; connect-src https:;" />
<link rel="stylesheet" href="${LEAFLET_CSS}" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="anonymous" />
<style>
  html, body, #map { height: 100%; width: 100%; margin: 0; padding: 0; background: #F4F6F3; }
  .leaflet-container { background: #F4F6F3; outline: none; -webkit-tap-highlight-color: transparent; font: 13px/1.4 -apple-system, Roboto, sans-serif; }
  .leaflet-popup-content { margin: 10px 12px; }
  .leaflet-popup-content b { color: #1A1F1C; }
  .leaflet-popup-content span { color: #5A615C; font-size: 12px; }
  .user-dot { border-radius: 50%; background: #2477C9; border: 2px solid #fff; box-shadow: 0 0 0 2px rgba(36,119,201,0.3); }
</style>
</head>
<body>
<div id="map"></div>
<script src="${LEAFLET_JS}" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="anonymous"></script>
<script>
(function () {
  var CONFIG = ${cfg};

  function post(o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  }

  // Leaflet failed to load (e.g. offline) — fail quietly to a blank map area
  // rather than throwing; tiles wouldn't load offline either.
  if (typeof L === 'undefined') { post({ type: 'error', message: 'leaflet-unavailable' }); return; }

  var map = L.map('map', {
    zoomControl: false,
    // The native screen renders one always-visible attribution link above this
    // WebView, shared with the iOS map path.
    attributionControl: false,
    minZoom: CONFIG.minZoom,
    maxZoom: CONFIG.maxZoom,
    zoomSnap: 0,
    fadeAnimation: false,
    rotate: false,
  });

  L.tileLayer(CONFIG.tileUrl, { maxZoom: 19, minZoom: 1, keepBuffer: 2, updateWhenZooming: false }).addTo(map);

  var markerLayer = L.layerGroup().addTo(map);
  var polyLayer = L.layerGroup().addTo(map);
  var userMarker = null;

  function boundsFor(r) {
    return [
      [r.latitude - r.latitudeDelta / 2, r.longitude - r.longitudeDelta / 2],
      [r.latitude + r.latitudeDelta / 2, r.longitude + r.longitudeDelta / 2],
    ];
  }

  // Report the viewport using react-native-maps' Region semantics: latitudeDelta /
  // longitudeDelta are the FULL visible span (north-south / east-west).
  function regionOf() {
    var c = map.getCenter();
    var b = map.getBounds();
    return {
      latitude: c.lat,
      longitude: c.lng,
      latitudeDelta: Math.abs(b.getNorth() - b.getSouth()),
      longitudeDelta: Math.abs(b.getEast() - b.getWest()),
    };
  }

  // Initial camera. fitBounds with zoomSnap:0 lands close to the requested span.
  try { map.fitBounds(boundsFor(CONFIG.region), { animate: false }); }
  catch (e) { map.setView([CONFIG.region.latitude, CONFIG.region.longitude], 13); }

  // Continuous region updates, throttled so a drag doesn't flood the bridge.
  var lastEmit = 0;
  map.on('move', function () {
    var now = Date.now();
    if (now - lastEmit < 90) return;
    lastEmit = now;
    post({ type: 'change', region: regionOf() });
  });
  // Settled — the gesture/animation finished.
  map.on('moveend', function () { post({ type: 'complete', region: regionOf() }); });

  function makePopup(m) {
    var div = document.createElement('div');
    var b = document.createElement('b');
    b.textContent = m.title || '';
    div.appendChild(b);
    if (m.description) {
      div.appendChild(document.createElement('br'));
      var s = document.createElement('span');
      s.textContent = m.description;
      div.appendChild(s);
    }
    div.appendChild(document.createElement('br'));
    var a = document.createElement('a');
    a.href = '#';
    a.textContent = 'View »';
    a.style.color = '#0F7A3D';
    a.style.fontWeight = '700';
    a.onclick = function (e) { e.preventDefault(); post({ type: 'marker', id: m.id }); };
    div.appendChild(a);
    return div;
  }

  window.__setMarkers = function (list) {
    markerLayer.clearLayers();
    (list || []).forEach(function (m) {
      var cm = L.circleMarker([m.latitude, m.longitude], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: m.color || '#0F7A3D',
        fillOpacity: 1,
      });
      cm.bindPopup(makePopup(m));
      markerLayer.addLayer(cm);
    });
  };

  window.__setPolygons = function (list) {
    polyLayer.clearLayers();
    (list || []).forEach(function (p) {
      var latlngs = (p.coordinates || []).map(function (c) { return [c.latitude, c.longitude]; });
      if (latlngs.length < 3) return;
      var poly = L.polygon(latlngs, {
        color: p.strokeColor,
        weight: p.strokeWidth || 2,
        fillColor: p.fillColor,
        fillOpacity: p.fillOpacity == null ? 0.4 : p.fillOpacity,
      });
      poly.on('click', function () { post({ type: 'polygon', id: p.id }); });
      polyLayer.addLayer(poly);
    });
  };

  window.__setUser = function (lat, lng) {
    if (lat == null || lng == null) { if (userMarker) { map.removeLayer(userMarker); userMarker = null; } return; }
    var icon = L.divIcon({ className: 'user-dot', iconSize: [16, 16] });
    if (userMarker) { userMarker.setLatLng([lat, lng]); }
    else { userMarker = L.marker([lat, lng], { icon: icon, interactive: false, keyboard: false }).addTo(map); }
  };

  window.__animate = function (r, ms) {
    var duration = Math.max(0.2, (ms || 350) / 1000);
    try { map.flyToBounds(boundsFor(r), { duration: duration }); }
    catch (e) { map.setView([r.latitude, r.longitude], map.getZoom()); }
  };

  // Container size can settle a frame after load; re-measure then hand off.
  setTimeout(function () { map.invalidateSize(); }, 0);
  window.addEventListener('resize', function () { map.invalidateSize(); });

  post({ type: 'ready' });
})();
true;
</script>
</body>
</html>`;
}

export const OsmMap = forwardRef<OsmMapHandle, Props>(function OsmMap(
  {
    style,
    initialRegion,
    markers,
    polygons,
    userLocation,
    minZoom = 1,
    maxZoom = 19,
    tileUrl = DEFAULT_TILE_URL,
    onRegionChange,
    onRegionChangeComplete,
    onMarkerPress,
    onPolygonPress,
  },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  // Leaflet couldn't load inside the page (offline / CDN unreachable) — the map
  // would otherwise just sit blank, so show a visible fallback with a retry.
  const [failed, setFailed] = useState(false);

  // Built once: the initial region only seeds the first camera (subsequent moves
  // come through `animateToRegion`), so rebuilding the HTML on every prop change
  // would needlessly reload the whole map.
  const html = useMemo(
    () => buildHtml(initialRegion, minZoom, maxZoom, tileUrl),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const inject = useCallback((js: string) => {
    webRef.current?.injectJavaScript(`${js};true;`);
  }, []);

  // A camera move requested before Leaflet has loaded would hit an undefined
  // window.__animate and be silently dropped (screens animate as soon as a GPS
  // fix arrives, often before the WebView is ready) — park it and flush on ready.
  const pendingAnimateRef = useRef<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      animateToRegion(region: Region, duration = 350) {
        const js = `window.__animate(${JSON.stringify(region)}, ${duration});`;
        if (readyRef.current) inject(js);
        else pendingAnimateRef.current = js;
      },
    }),
    [inject],
  );

  // Push overlay/location updates into the page whenever they change (once ready).
  useEffect(() => {
    if (readyRef.current) inject(`window.__setMarkers(${JSON.stringify(markers ?? [])});`);
  }, [markers, inject]);
  useEffect(() => {
    if (readyRef.current) inject(`window.__setPolygons(${JSON.stringify(polygons ?? [])});`);
  }, [polygons, inject]);
  useEffect(() => {
    if (!readyRef.current) return;
    if (userLocation) inject(`window.__setUser(${userLocation.latitude}, ${userLocation.longitude});`);
    else inject('window.__setUser(null, null);');
  }, [userLocation, inject]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: { type: string; region?: Region; id?: string };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          readyRef.current = true;
          // Flush current state into the freshly-loaded page.
          inject(`window.__setMarkers(${JSON.stringify(markers ?? [])});`);
          inject(`window.__setPolygons(${JSON.stringify(polygons ?? [])});`);
          if (userLocation) inject(`window.__setUser(${userLocation.latitude}, ${userLocation.longitude});`);
          if (pendingAnimateRef.current) {
            inject(pendingAnimateRef.current);
            pendingAnimateRef.current = null;
          }
          break;
        case 'change':
          if (msg.region) onRegionChange?.(msg.region);
          break;
        case 'complete':
          if (msg.region) onRegionChangeComplete?.(msg.region);
          break;
        case 'marker':
          if (msg.id) onMarkerPress?.(msg.id);
          break;
        case 'polygon':
          if (msg.id) onPolygonPress?.(msg.id);
          break;
        case 'error':
          setFailed(true);
          break;
        default:
          break;
      }
    },
    [inject, markers, polygons, userLocation, onRegionChange, onRegionChangeComplete, onMarkerPress, onPolygonPress],
  );

  const retry = useCallback(() => {
    readyRef.current = false;
    setFailed(false);
    webRef.current?.reload();
  }, []);

  return (
    <View style={style}>
      <WebView
        ref={webRef}
        style={StyleSheet.absoluteFill}
        source={{ html }}
        originWhitelist={['about:blank', 'data:*']}
        onMessage={onMessage}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        onContentProcessDidTerminate={() => setFailed(true)}
        applicationNameForUserAgent="Vollo/0.1.0"
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        overScrollMode="never"
        androidLayerType="hardware"
        setSupportMultipleWindows={false}
        // The map fills its container with a flat background; no scroll/zoom chrome.
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      />
      {failed ? (
        <View style={fallbackStyles.wrap}>
          <Text style={fallbackStyles.text}>Map failed to load — check your connection</Text>
          <Pressable onPress={retry} accessibilityRole="button" accessibilityLabel="Reload the map" hitSlop={8} style={fallbackStyles.retry}>
            <Text style={fallbackStyles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const fallbackStyles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.bg,
  },
  text: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, textAlign: 'center' },
  retry: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  retryText: { color: colors.primary, fontSize: font.small, fontFamily: fonts.bold },
});

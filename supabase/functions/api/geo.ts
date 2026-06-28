// Pure geospatial helpers used by the domination engine. PostGIS remains the
// source of truth for the stored convex-hull geometry and its area, but these
// functions let us cluster courts by real-world distance, name districts by
// compass direction, and reason about the geometry without a live database.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Great-circle distance between two points, in kilometres (haversine). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Cluster items by proximity: two items join the same cluster when they are
 * within `radiusKm` of each other (single-linkage / connected components via
 * union-find). Returns clusters as arrays of the original indices.
 */
export function clusterByRadius<T extends LatLng>(items: T[], radiusKm: number): number[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineKm(items[i]!, items[j]!) <= radiusKm) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(i);
    groups.set(root, g);
  }
  return [...groups.values()];
}

/** Arithmetic centroid of a set of points (good enough at city scale). */
export function centroid(points: LatLng[]): LatLng {
  if (points.length === 0) return { lat: 0, lng: 0 };
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** Initial compass bearing from `from` to `to`, in degrees [0, 360). */
export function bearing(from: LatLng, to: LatLng): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'] as const;

/** Map a bearing to one of eight compass-named districts. */
export function compassName(deg: number): string {
  const idx = Math.round(((deg % 360) / 45)) % 8;
  return COMPASS[idx]!;
}

/**
 * Name a district by where its centre sits relative to a reference point
 * (typically the player's home). e.g. North District. Falls back to
 * Central District when the cluster sits on top of the reference.
 */
export function districtName(clusterCenter: LatLng, reference: LatLng | null): string {
  if (!reference || haversineKm(clusterCenter, reference) < 1.5) return 'Central District';
  return `${compassName(bearing(reference, clusterCenter))} District`;
}

/**
 * Approximate polygon area in km² via an equirectangular projection around the
 * polygon's mean latitude + the shoelace formula. PostGIS computes the stored
 * value authoritatively; this is a fallback.
 */
export function polygonAreaSqKm(ring: LatLng[]): number {
  if (ring.length < 3) return 0;
  const meanLat = toRad(centroid(ring).lat);
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.32 * Math.cos(meanLat);
  const pts = ring.map((p) => ({ x: p.lng * kmPerDegLng, y: p.lat * kmPerDegLat }));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Andrew's monotone-chain convex hull. PostGIS ST_ConvexHull is authoritative
 * in production; this mirror documents exactly which points the hull retains.
 * Returns hull vertices in counter-clockwise order (not closed).
 */
export function convexHull(points: LatLng[]): LatLng[] {
  const pts = [...points]
    .map((p) => ({ x: p.lng, y: p.lat }))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 2) return pts.map((p) => ({ lat: p.y, lng: p.x }));

  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].map((p) => ({ lat: p.y, lng: p.x }));
}

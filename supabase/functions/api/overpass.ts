// ════════════════════════════════════════════════════════════════════════
// Real-world tennis court discovery via the OpenStreetMap Overpass API.
//
// Overpass is free and key-less — it queries the live OSM database. We pull
// tennis pitches AND the named features that contain them (schools, parks,
// clubs, sports centres) within a bounding box, then:
//
//   1. NAME each pitch from its enclosing feature — "North Creek High School"
//      becomes "North Creek High School Tennis Courts" instead of "Tennis
//      Court".
//   2. GROUP co-located pitches into a single facility ("sector"). A school
//      with 6 courts collapses to ONE court row (court_count = 6), so the
//      domination engine treats the whole facility as one court and the map
//      shows one marker instead of six overlapping pins.
//
// The caller upserts each sector into the `courts` table keyed on sector_key.
// All of this is $0 — Overpass and OSM data are free.
// ════════════════════════════════════════════════════════════════════════
import type { Surface } from './types.ts';
import { clusterByRadius } from './geo.ts';

/** A grouped tennis facility ready to upsert as a single court row. */
export interface OverpassSector {
  sector_key: string; // stable dedup/identity key, e.g. "osm:way/123" or "geo:47.83,-122.18"
  osm_id: string | null; // representative OSM id (container or single pitch) for reference
  name: string;
  lat: number; // facility centroid
  lng: number;
  surface: Surface; // majority surface across the grouped pitches
  city: string | null;
  court_count: number; // number of physical pitches folded into this facility
}

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

// Public mirrors of the Overpass endpoint. We try them in order so one being
// overloaded doesn't kill discovery.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TIMEOUT_MS = 20_000;
const MAX_PITCHES = 600; // a metro tile rarely holds more; guards payload size
// Unnamed, uncontained pitches within this distance fold into one facility
// (single-linkage). Most real multi-court venues sit well inside this.
const CLUSTER_KM = 0.14; // 140 m
// Courts mapped just outside a named park/school still adopt that name when its
// boundary is within this distance.
const NEAR_M = 90;
// Defensive cap on named container polygons parsed from one response, bounding
// the point-in-polygon / nearest-feature work for a large viewport.
const MAX_CONTAINERS = 2500;

interface OsmTags {
  name?: string;
  'name:en'?: string;
  sport?: string;
  surface?: string;
  indoor?: string;
  covered?: string;
  leisure?: string;
  amenity?: string;
  landuse?: string;
  club?: string;
  'addr:city'?: string;
}

interface OsmGeom {
  lat: number;
  lon: number;
}

interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role?: string;
  geometry?: OsmGeom[];
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: OsmGeom[];
  members?: OsmMember[];
  tags?: OsmTags;
}

interface Pitch {
  osm_id: string;
  lat: number;
  lng: number;
  tags: OsmTags;
}

interface Container {
  osm_id: string;
  name: string;
  ring: Array<[number, number]>; // [lng, lat]
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  area: number; // shoelace area in deg² — used to pick the most specific (smallest) container
}

/** Map an OSM `surface` tag (and indoor flags) onto our four surface types. */
function mapSurface(tags: OsmTags): Surface {
  if (tags.indoor === 'yes' || tags.covered === 'yes') return 'indoor';
  const s = (tags.surface ?? '').toLowerCase();
  if (s.includes('clay')) return 'clay';
  if (s.includes('grass')) return 'grass';
  // asphalt / concrete / acrylic / hard / sand / artificial → treat as hard.
  return 'hard';
}

function rawName(tags: OsmTags): string {
  return (tags.name ?? tags['name:en'] ?? '').trim();
}

/**
 * Normalise a name into a grouping key: strip a trailing court number so
 * "Smith Park Court #1" and "Smith Park Court 2" fold together, and reject
 * names that are *only* a number ("1", "2", "Court 3") which carry no facility
 * identity. Returns '' when the name can't anchor a group.
 */
function nameGroupKey(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(/[\s#]*(?:court|no\.?|#)?\s*\d+\s*$/i, '').trim();
  n = n.replace(/\s+(tennis\s+)?courts?$/i, '').trim();
  if (!n || /^\d+$/.test(n)) return '';
  return n;
}

/**
 * Format a human court name. Facility names that already mention tennis are kept
 * as-is ("Central Park Tennis Center"); everything else gets a "Tennis Court(s)"
 * suffix pluralised by how many pitches the facility holds, e.g.
 * "North Creek High School" + 6 → "North Creek High School Tennis Courts".
 */
function formatName(raw: string | null, count: number): string {
  const n = (raw ?? '').trim();
  if (!n) return count > 1 ? 'Tennis Courts' : 'Tennis Court';
  if (/tennis/i.test(n)) return n.slice(0, 118);
  const suffix = count > 1 ? 'Tennis Courts' : 'Tennis Court';
  return `${n} ${suffix}`.slice(0, 118);
}

/**
 * Build the Overpass QL for a bbox. Overpass bbox order is
 * (south, west, north, east) = (minLat, minLng, maxLat, maxLng).
 *   .p — tennis pitches + tennis sports-centres (the courts themselves)
 *   .c — NAMED features that may contain pitches (schools, parks, clubs …),
 *        returned with full geometry so we can do point-in-polygon naming.
 */
function buildQuery(b: Bbox): string {
  const bb = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  return (
    `[out:json][timeout:60];` +
    `(` +
    `nwr["leisure"="pitch"]["sport"~"tennis"]["sport"!~"table_tennis"](${bb});` +
    `nwr["leisure"="sports_centre"]["sport"~"tennis"]["sport"!~"table_tennis"](${bb});` +
    `)->.p;` +
    `(` +
    `way["amenity"~"^(school|college|university|kindergarten)$"]["name"](${bb});` +
    `way["leisure"~"^(park|sports_centre|recreation_ground|garden|stadium|golf_course)$"]["name"](${bb});` +
    `way["club"="sport"]["name"](${bb});` +
    `way["landuse"~"^(recreation_ground|village_green)$"]["name"](${bb});` +
    // Big parks/campuses are often multipolygon relations (e.g. Central Park,
    // Woodland Park) — include them so courts inside get named too.
    `relation["amenity"~"^(school|college|university)$"]["name"](${bb});` +
    `relation["leisure"~"^(park|recreation_ground|garden|stadium|golf_course)$"]["name"](${bb});` +
    `relation["landuse"~"^(recreation_ground|village_green)$"]["name"](${bb});` +
    `)->.c;` +
    `.p out center ${MAX_PITCHES} tags;` +
    `.c out geom tags;`
  );
}

async function fetchFrom(endpoint: string, ql: string): Promise<OsmElement[]> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Vollo/0.1 (tennis court discovery)',
      Accept: 'application/json',
    },
    body: 'data=' + encodeURIComponent(ql),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`overpass ${endpoint} responded ${res.status}`);
  const json = (await res.json()) as { elements?: OsmElement[] };
  return json.elements ?? [];
}

/** Ray-casting point-in-polygon over a [lng,lat] ring. */
function pointInRing(lng: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Build a Container (with bbox + shoelace area) from a [{lat,lon}] ring. */
function ringToContainer(osm_id: string, name: string, geom: OsmGeom[]): Container | null {
  if (!name || geom.length < 3) return null;
  const ring: Array<[number, number]> = geom.map((g) => [g.lon, g.lat]);
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i]!;
    if (x < minLng) minLng = x;
    if (y < minLat) minLat = y;
    if (x > maxLng) maxLng = x;
    if (y > maxLat) maxLat = y;
    const [xn, yn] = ring[(i + 1) % ring.length]!;
    area2 += x * yn - xn * y;
  }
  return { osm_id, name, ring, minLng, minLat, maxLng, maxLat, area: Math.abs(area2) / 2 };
}

/** Containers from one OSM element: a way is one ring; a relation contributes
 *  one container per `outer` member ring (holes are ignored — fine for naming). */
function containersFrom(el: OsmElement): Container[] {
  const name = rawName(el.tags ?? {});
  if (!name) return [];
  const osm_id = `${el.type}/${el.id}`;
  if (el.geometry && el.geometry.length >= 3) {
    const c = ringToContainer(osm_id, name, el.geometry);
    return c ? [c] : [];
  }
  if (el.members) {
    const out: Container[] = [];
    for (const m of el.members) {
      if ((m.role === 'outer' || !m.role) && m.geometry && m.geometry.length >= 3) {
        const c = ringToContainer(osm_id, name, m.geometry);
        if (c) out.push(c);
      }
    }
    return out;
  }
  return [];
}

/** Smallest (most specific) named container that encloses the point, if any. */
function findContainer(lng: number, lat: number, containers: Container[]): Container | null {
  let best: Container | null = null;
  for (const c of containers) {
    if (lng < c.minLng || lng > c.maxLng || lat < c.minLat || lat > c.maxLat) continue;
    if (!pointInRing(lng, lat, c.ring)) continue;
    if (!best || c.area < best.area) best = c;
  }
  return best;
}

/** Distance in metres from a point to a line segment (equirectangular approx). */
function pointToSegmentM(lng: number, lat: number, aLng: number, aLat: number, bLng: number, bLat: number): number {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110574;
  const px = lng * kx;
  const py = lat * ky;
  const ax = aLng * kx;
  const ay = aLat * ky;
  const bx = bLng * kx;
  const by = bLat * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Closest named container whose boundary is within `maxM` metres of the point —
 * a fallback for courts mapped just OUTSIDE their park/school polygon, so they
 * still get the facility's name instead of a bare "Tennis Court".
 */
function nearestContainer(lng: number, lat: number, containers: Container[], maxM: number): Container | null {
  const padLat = maxM / 110574;
  const padLng = maxM / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  let best: Container | null = null;
  let bestDist = maxM;
  for (const c of containers) {
    if (lng < c.minLng - padLng || lng > c.maxLng + padLng || lat < c.minLat - padLat || lat > c.maxLat + padLat) continue;
    let d = Infinity;
    for (let i = 0, j = c.ring.length - 1; i < c.ring.length; j = i++) {
      const [xj, yj] = c.ring[j]!;
      const [xi, yi] = c.ring[i]!;
      const seg = pointToSegmentM(lng, lat, xj, yj, xi, yi);
      if (seg < d) d = seg;
      if (d === 0) break;
    }
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

interface Group {
  pitches: Pitch[];
  name: string | null;
  osm_id: string | null; // container id when container-grouped
}

/** Most common surface across a group's pitches (ties → 'hard'). */
function majoritySurface(pitches: Pitch[]): Surface {
  const counts: Record<Surface, number> = { hard: 0, clay: 0, grass: 0, indoor: 0 };
  for (const p of pitches) counts[mapSurface(p.tags)]++;
  let best: Surface = 'hard';
  for (const s of ['clay', 'grass', 'indoor'] as Surface[]) if (counts[s] > counts[best]) best = s;
  return best;
}

/** Add a pitch to a keyed group, preferring any real name/osm_id seen. */
function addToGroup(groups: Map<string, Group>, key: string, p: Pitch, name: string | null, osmId: string | null): void {
  const g = groups.get(key);
  if (g) {
    g.pitches.push(p);
    if (!g.name && name) g.name = name;
    if (!g.osm_id && osmId) g.osm_id = osmId;
  } else {
    groups.set(key, { pitches: [p], name, osm_id: osmId });
  }
}

/** Group pitches into facilities and emit one sector per group. */
function groupIntoSectors(pitches: Pitch[], containers: Container[]): OverpassSector[] {
  const groups = new Map<string, Group>();
  const loose: Pitch[] = []; // unnamed + uncontained → clustered by proximity below

  for (const p of pitches) {
    // Inside a named feature, else adjacent to one (courts mapped just outside
    // their park/school boundary), else fall through to name/proximity grouping.
    const container = findContainer(p.lng, p.lat, containers) ?? nearestContainer(p.lng, p.lat, containers, NEAR_M);
    if (container) {
      addToGroup(groups, `osm:${container.osm_id}`, p, container.name, container.osm_id);
      continue;
    }
    const ownName = rawName(p.tags);
    const nk = nameGroupKey(ownName);
    if (nk) {
      // Same-named pitches within ~1km fold together (facilities OSM names
      // per-pitch but has no containing polygon for).
      const cell = `${Math.round(p.lat / 0.01)},${Math.round(p.lng / 0.01)}`;
      addToGroup(groups, `name:${nk}@${cell}`, p, ownName, p.osm_id);
      continue;
    }
    loose.push(p);
  }

  // Fold anonymous neighbouring courts into one facility by single-linkage
  // proximity, then key on the cluster's smallest member id. Distinct clusters
  // have disjoint members so their keys never collide (a coarse centroid snap
  // could merge two separate venues), and the key is deterministic across calls.
  for (const idx of clusterByRadius(loose, CLUSTER_KM)) {
    let minId = loose[idx[0]!]!.osm_id;
    for (const i of idx) if (loose[i]!.osm_id < minId) minId = loose[i]!.osm_id;
    const key = `geo:${minId}`;
    for (const i of idx) addToGroup(groups, key, loose[i]!, null, null);
  }

  const sectors: OverpassSector[] = [];
  for (const [sector_key, g] of groups) {
    let lat = 0;
    let lng = 0;
    let city: string | null = null;
    for (const p of g.pitches) {
      lat += p.lat;
      lng += p.lng;
      if (!city) city = (p.tags['addr:city'] ?? '').trim() || null;
    }
    const n = g.pitches.length;
    sectors.push({
      sector_key,
      osm_id: g.osm_id,
      name: formatName(g.name, n),
      lat: lat / n,
      lng: lng / n,
      surface: majoritySurface(g.pitches),
      city,
      court_count: n,
    });
  }
  return sectors;
}

/** Parse a raw Overpass element list into pitches + named containers. */
function parseElements(elements: OsmElement[]): { pitches: Pitch[]; containers: Container[] } {
  const pitchById = new Map<string, Pitch>();
  const containers: Container[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const isContainer =
      (tags.amenity || tags.leisure || tags.landuse || tags.club) &&
      ((el.geometry && el.geometry.length >= 3) || (el.type === 'relation' && el.members));
    if (isContainer) {
      // A container candidate (came back via `.c out geom`).
      if (containers.length < MAX_CONTAINERS) for (const c of containersFrom(el)) containers.push(c);
      continue;
    }
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const osm_id = `${el.type}/${el.id}`;
    if (pitchById.has(osm_id)) continue;
    pitchById.set(osm_id, { osm_id, lat, lng, tags });
  }
  return { pitches: [...pitchById.values()], containers };
}

/**
 * Fetch tennis facilities (grouped sectors) within a bbox from OpenStreetMap.
 * Best-effort: if every Overpass mirror fails or times out the promise rejects,
 * and the caller should fall back to whatever is already in the database.
 */
export async function fetchOverpassSectors(b: Bbox): Promise<OverpassSector[]> {
  const ql = buildQuery(b);
  let lastErr: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      const elements = await fetchFrom(endpoint, ql);
      const { pitches, containers } = parseElements(elements);
      return groupIntoSectors(pitches, containers);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('overpass: all endpoints failed');
}

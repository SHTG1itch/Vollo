// ════════════════════════════════════════════════════════════════════════
// Real-world tennis court discovery via the OpenStreetMap Overpass API.
//
// Overpass is free and key-less — it queries the live OSM database. We pull
// tennis courts (leisure=pitch + sport=tennis) and tennis-bearing sports
// centres within a map bounding box, normalise them into court candidates, and
// the caller upserts them into our `courts` table (deduped by osm_id). This is
// what populates the map with actual courts at $0 infra cost.
// ════════════════════════════════════════════════════════════════════════
import type { Surface } from './types.ts';

export interface OverpassCourt {
  osm_id: string; // stable "type/id", e.g. "way/123456789"
  name: string;
  lat: number;
  lng: number;
  surface: Surface;
  city: string | null;
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

const TIMEOUT_MS = 12_000;
const MAX_RESULTS = 200;

interface OsmTags {
  name?: string;
  'name:en'?: string;
  sport?: string;
  surface?: string;
  leisure?: string;
  indoor?: string;
  covered?: string;
  'addr:city'?: string;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
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

function courtName(tags: OsmTags): string {
  const n = (tags.name ?? tags['name:en'] ?? '').trim();
  if (n) return n.slice(0, 120);
  return tags.leisure === 'sports_centre' ? 'Tennis Centre' : 'Tennis Court';
}

/**
 * Build the Overpass QL for a bbox. Overpass bbox order is
 * (south, west, north, east) = (minLat, minLng, maxLat, maxLng).
 * The `["sport"!~"table_tennis"]` guard keeps ping-pong tables out.
 */
function buildQuery(b: Bbox): string {
  const bb = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  return (
    `[out:json][timeout:25];(` +
    `nwr["leisure"="pitch"]["sport"~"tennis"]["sport"!~"table_tennis"](${bb});` +
    `nwr["leisure"="sports_centre"]["sport"~"tennis"]["sport"!~"table_tennis"](${bb});` +
    `);out center ${MAX_RESULTS} tags;`
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

/**
 * Fetch tennis courts within a bbox from OpenStreetMap. Best-effort: if every
 * Overpass mirror fails or times out the promise rejects, and the caller should
 * fall back to whatever is already in the database.
 */
export async function fetchOverpassCourts(b: Bbox): Promise<OverpassCourt[]> {
  const ql = buildQuery(b);
  let lastErr: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      const elements = await fetchFrom(endpoint, ql);
      const byId = new Map<string, OverpassCourt>();
      for (const el of elements) {
        const tags = el.tags ?? {};
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) continue;
        const osm_id = `${el.type}/${el.id}`;
        if (byId.has(osm_id)) continue;
        byId.set(osm_id, {
          osm_id,
          name: courtName(tags),
          lat,
          lng,
          surface: mapSurface(tags),
          city: (tags['addr:city'] ?? '').trim() || null,
        });
      }
      return Array.from(byId.values());
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('overpass: all endpoints failed');
}

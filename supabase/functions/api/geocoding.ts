import { config } from './config.ts';
import { query, queryOne } from './db.ts';

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  city: string | null;
}

export interface ReverseGeocodeResult {
  label: string;
  city: string | null;
  /** Most specific named locality for naming courts that OSM left anonymous. */
  neighborhood: string | null;
}

/** Abort a geocoding request that hangs so it cannot tie up the function. */
const GEOCODE_TIMEOUT_MS = 8_000;
const FORWARD_CACHE_TTL_DAYS = 30;
const REVERSE_CACHE_TTL_DAYS = 180;

/** Raised when another Edge isolate already consumed the shared Nominatim slot. */
export class GeocoderBusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 2) {
    super('The shared geocoder is busy');
    this.name = 'GeocoderBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Public Nominatim permits end-user-triggered lookups, not systematic reverse
 * geocoding. Automated enrichment is therefore available only with the
 * separately configured commercial provider. */
export function allowsAutomatedGeocoding(): boolean {
  return config.geocoder.provider === 'geoapify' && config.geocoder.geoapifyApiKey.length > 0;
}

function normalizeQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function boundedText(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function validCoordinate(value: unknown, min: number, max: number): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

async function cacheFingerprint(value: string): Promise<string> {
  // Search text and coordinates are never stored as cache keys in plaintext.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(kind: 'forward' | 'reverse', value: string): Promise<string> {
  return await cacheFingerprint(`${config.geocoder.provider}:${kind}:${value}`);
}

async function readCache<T>(key: string): Promise<{ hit: boolean; value: T | null }> {
  const row = await queryOne<{ payload: unknown }>(
    'SELECT payload FROM geocode_cache WHERE cache_key = $1 AND expires_at > now()',
    [key],
  );
  if (!row || typeof row.payload !== 'object' || row.payload === null || !('value' in row.payload)) {
    return { hit: false, value: null };
  }
  return { hit: true, value: (row.payload as { value: T | null }).value };
}

async function writeCache<T>(
  key: string,
  kind: 'forward' | 'reverse',
  value: T | null,
  ttlDays: number,
): Promise<void> {
  await query(
    `INSERT INTO geocode_cache (cache_key, provider, kind, payload, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, now() + ($5::double precision * interval '1 day'))
     ON CONFLICT (cache_key) DO UPDATE SET
       payload = EXCLUDED.payload,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [key, config.geocoder.provider, kind, { value }, ttlDays],
  );
}

async function cached<T>(
  kind: 'forward' | 'reverse',
  input: string,
  ttlDays: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const key = await cacheKey(kind, input);
  const existing = await readCache<T>(key);
  if (existing.hit) return existing.value;

  const value = await load();
  await writeCache(key, kind, value, ttlDays);
  return value;
}

/**
 * Atomically reserve the next provider call across all Edge isolates. The
 * UPDATE predicate is evaluated while PostgreSQL holds the service row lock,
 * so concurrent cold starts cannot exceed Nominatim's application-wide limit.
 */
async function acquireNominatimLease(): Promise<void> {
  const rows = await query<{ service: string }>(
    `INSERT INTO outbound_service_limits (service, last_started_at)
     VALUES ('nominatim', clock_timestamp())
     ON CONFLICT (service) DO UPDATE SET last_started_at = EXCLUDED.last_started_at
       WHERE outbound_service_limits.last_started_at
             <= clock_timestamp() - ($1::double precision * interval '1 millisecond')
     RETURNING service`,
    [config.geocoder.nominatimMinIntervalMs],
  );
  if (rows.length === 0) {
    throw new GeocoderBusyError(Math.max(1, Math.ceil(config.geocoder.nominatimMinIntervalMs / 1_000)));
  }
}

/** Forward geocode a user-submitted address. Results are durably cached. */
export async function geocode(queryText: string, limit = 5): Promise<GeocodeResult[]> {
  const q = normalizeQuery(queryText);
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
  const input = `${q.toLocaleLowerCase('en-US')}|${safeLimit}`;
  const result = await cached<GeocodeResult[]>('forward', input, FORWARD_CACHE_TTL_DAYS, () =>
    config.geocoder.provider === 'geoapify'
      ? geocodeGeoapify(q, safeLimit)
      : geocodeNominatim(q, safeLimit));
  return result ?? [];
}

async function geocodeNominatim(q: string, limit: number): Promise<GeocodeResult[]> {
  await acquireNominatimLease();
  const url = new URL('/search', config.geocoder.nominatimBaseUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url, {
    headers: { 'User-Agent': config.geocoder.nominatimUserAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`nominatim responded ${res.status}`);
  const rows = (await res.json()) as Array<{
    display_name?: unknown;
    lat?: unknown;
    lon?: unknown;
    address?: { city?: unknown; town?: unknown; village?: unknown; municipality?: unknown };
  }>;

  return rows.flatMap((row) => {
    const label = boundedText(row.display_name);
    const lat = validCoordinate(row.lat, -90, 90);
    const lng = validCoordinate(row.lon, -180, 180);
    if (!label || lat === null || lng === null) return [];
    const city = boundedText(
      row.address?.city ?? row.address?.town ?? row.address?.village ?? row.address?.municipality,
      160,
    );
    return [{ label, lat, lng, city }];
  }).slice(0, limit);
}

/** Reverse geocode a user-selected coordinate, with provider-correct routing. */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  const safeLat = validCoordinate(lat, -90, 90);
  const safeLng = validCoordinate(lng, -180, 180);
  if (safeLat === null || safeLng === null) return null;
  // Roughly one-metre cells maximize useful cache hits without changing the
  // address a user selected.
  const input = `${safeLat.toFixed(5)},${safeLng.toFixed(5)}`;
  return await cached<ReverseGeocodeResult>('reverse', input, REVERSE_CACHE_TTL_DAYS, () =>
    config.geocoder.provider === 'geoapify'
      ? reverseGeocodeGeoapify(safeLat, safeLng)
      : reverseGeocodeNominatim(safeLat, safeLng));
}

async function reverseGeocodeNominatim(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  await acquireNominatimLease();
  const url = new URL('/reverse', config.geocoder.nominatimBaseUrl);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('zoom', '16');

  const res = await fetch(url, {
    headers: { 'User-Agent': config.geocoder.nominatimUserAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`nominatim reverse responded ${res.status}`);
  const row = (await res.json()) as {
    display_name?: unknown;
    address?: Record<string, unknown>;
  };
  return mapReverseResult(row.display_name, row.address ?? {});
}

async function geocodeGeoapify(q: string, limit: number): Promise<GeocodeResult[]> {
  if (!config.geocoder.geoapifyApiKey) throw new Error('GEOAPIFY_API_KEY not configured');
  const url = new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('apiKey', config.geocoder.geoapifyApiKey);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`geoapify responded ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ properties?: Record<string, unknown> }>;
  };
  return (json.features ?? []).flatMap((feature) => {
    const properties = feature.properties ?? {};
    const label = boundedText(properties.formatted);
    const lat = validCoordinate(properties.lat, -90, 90);
    const lng = validCoordinate(properties.lon, -180, 180);
    if (!label || lat === null || lng === null) return [];
    return [{ label, lat, lng, city: boundedText(properties.city, 160) }];
  }).slice(0, limit);
}

async function reverseGeocodeGeoapify(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  if (!config.geocoder.geoapifyApiKey) throw new Error('GEOAPIFY_API_KEY not configured');
  const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('limit', '1');
  url.searchParams.set('apiKey', config.geocoder.geoapifyApiKey);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`geoapify reverse responded ${res.status}`);
  const json = (await res.json()) as {
    features?: Array<{ properties?: Record<string, unknown> }>;
  };
  const properties = json.features?.[0]?.properties;
  return properties ? mapReverseResult(properties.formatted, properties) : null;
}

function mapReverseResult(labelValue: unknown, address: Record<string, unknown>): ReverseGeocodeResult | null {
  const label = boundedText(labelValue);
  if (!label) return null;
  return {
    label,
    city: boundedText(
      address.city ?? address.town ?? address.village ?? address.municipality ?? address.suburb,
      160,
    ),
    neighborhood: boundedText(
      address.neighbourhood ?? address.suburb ?? address.quarter ?? address.residential
        ?? address.city_district ?? address.district ?? address.hamlet ?? address.village,
      160,
    ),
  };
}

import { config } from './config.ts';

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  city: string | null;
}

/** Abort a geocoding request that hangs so it can't tie up the function. */
const GEOCODE_TIMEOUT_MS = 8000;

/**
 * Forward geocode a free-text address to coordinates using a free provider.
 * Nominatim (OpenStreetMap) is the default; Geoapify is used when configured.
 */
export async function geocode(queryText: string, limit = 5): Promise<GeocodeResult[]> {
  const q = queryText.trim();
  if (!q) return [];
  return config.geocoder.provider === 'geoapify' ? geocodeGeoapify(q, limit) : geocodeNominatim(q, limit);
}

async function geocodeNominatim(q: string, limit: number): Promise<GeocodeResult[]> {
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
    display_name: string;
    lat: string;
    lon: string;
    address?: { city?: string; town?: string; village?: string; municipality?: string };
  }>;

  return rows.map((r) => ({
    label: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    city: r.address?.city ?? r.address?.town ?? r.address?.village ?? r.address?.municipality ?? null,
  }));
}

export interface ReverseGeocodeResult {
  label: string;
  city: string | null;
}

/**
 * Reverse geocode coordinates to a human label + city using Nominatim. Used to
 * auto-fill a court's address/city when a user drops a pin on the map, so they
 * never have to type one. Best-effort — callers must tolerate a null result.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
  // Geoapify and Nominatim both expose /reverse; we use Nominatim (no key).
  const base = config.geocoder.nominatimBaseUrl;
  const url = new URL('/reverse', base);
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
  const r = (await res.json()) as {
    display_name?: string;
    address?: { city?: string; town?: string; village?: string; municipality?: string; suburb?: string };
  };
  if (!r.display_name) return null;
  const a = r.address ?? {};
  return {
    label: r.display_name,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb ?? null,
  };
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
    features: Array<{ properties: { formatted: string; lat: number; lon: number; city?: string } }>;
  };

  return json.features.map((f) => ({
    label: f.properties.formatted,
    lat: f.properties.lat,
    lng: f.properties.lon,
    city: f.properties.city ?? null,
  }));
}

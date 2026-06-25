import { config } from '../config.js';

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  city: string | null;
}

/**
 * Forward geocode a free-text address to coordinates using a free provider.
 * Nominatim (OpenStreetMap) is the default; Geoapify is used when configured.
 *
 * Nominatim's usage policy requires a descriptive User-Agent and a max of one
 * request per second — callers (the courts route) should debounce accordingly.
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

async function geocodeGeoapify(q: string, limit: number): Promise<GeocodeResult[]> {
  if (!config.geocoder.geoapifyApiKey) throw new Error('GEOAPIFY_API_KEY not configured');
  const url = new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('apiKey', config.geocoder.geoapifyApiKey);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
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

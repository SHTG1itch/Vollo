import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const geocoding = readFileSync(
  new URL('../../supabase/functions/api/geocoding.ts', import.meta.url),
  'utf8',
);
const config = readFileSync(
  new URL('../../supabase/functions/api/config.ts', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../supabase/migrations/20260710075732_032_geocoder_cache_and_rate_limit.sql', import.meta.url),
  'utf8',
);
const sweeps = readFileSync(
  new URL('../../supabase/functions/api/sweeps.ts', import.meta.url),
  'utf8',
);
const index = readFileSync(
  new URL('../../supabase/functions/api/index.ts', import.meta.url),
  'utf8',
);
const validation = readFileSync(
  new URL('../../supabase/functions/api/validation.ts', import.meta.url),
  'utf8',
);
const overpass = readFileSync(
  new URL('../../supabase/functions/api/overpass.ts', import.meta.url),
  'utf8',
);

test('Nominatim calls share a database-enforced application-wide lease', () => {
  assert.match(config, /nominatimMinIntervalMs: Math\.max\(1_000/);
  assert.match(geocoding, /INSERT INTO outbound_service_limits/);
  assert.match(geocoding, /ON CONFLICT \(service\) DO UPDATE/);
  assert.match(geocoding, /last_started_at[^]*clock_timestamp\(\) - \(\$1::double precision \* interval '1 millisecond'\)/);
  assert.match(geocoding, /RETURNING service/);
  assert.match(geocoding, /throw new GeocoderBusyError/);
  assert.ok(
    geocoding.indexOf('await acquireNominatimLease()') < geocoding.indexOf("new URL('/search'"),
    'forward provider fetch must lease before it starts',
  );
});

test('geocoder results are cached under hashed inputs and backend-only tables', () => {
  assert.match(geocoding, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(geocoding, /SELECT payload FROM geocode_cache[^]*expires_at > now\(\)/);
  assert.match(geocoding, /ON CONFLICT \(cache_key\) DO UPDATE/);
  assert.match(migration, /cache_key\s+TEXT PRIMARY KEY CHECK \(cache_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /ALTER TABLE public\.geocode_cache ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.geocode_cache FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /vollo-geocode-cache-cleanup/);
});

test('reverse geocoding follows the configured provider', () => {
  assert.match(
    geocoding,
    /config\.geocoder\.provider === 'geoapify'[^]*reverseGeocodeGeoapify\(safeLat, safeLng\)[^]*reverseGeocodeNominatim/,
  );
  assert.match(geocoding, /https:\/\/api\.geoapify\.com\/v1\/geocode\/reverse/);
  assert.match(geocoding, /nominatimUserAgent/);
});

test('automated reverse-geocoding is disabled for public Nominatim', () => {
  assert.match(
    geocoding,
    /allowsAutomatedGeocoding\(\)[^]*provider === 'geoapify'[^]*geoapifyApiKey\.length > 0/,
  );
  assert.match(sweeps, /if \(!allowsAutomatedGeocoding\(\)\)[^]*return 0/);
});

test('court discovery uses a hashed fleet-wide cache and provider lease', () => {
  assert.match(index, /crypto\.subtle\.digest\(\s*'SHA-256'/);
  assert.match(index, /INSERT INTO court_discovery_cells/);
  assert.match(index, /UPDATE court_discovery_cells[^]*locked_until = clock_timestamp\(\) \+ interval '3 minutes'/);
  assert.match(index, /INSERT INTO outbound_service_limits \(service, last_started_at\)[^]*'overpass'/);
  assert.match(index, /withTransaction\(async \(client\)/);
  assert.doesNotMatch(index, /discoveredCells|DISCOVER_TTL_MS/);
  assert.doesNotMatch(validation, /\bforce:/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.court_discovery_cells/);
  assert.match(migration, /cell_key\s+TEXT PRIMARY KEY CHECK \(cell_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /ALTER TABLE public\.court_discovery_cells ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.court_discovery_cells FROM PUBLIC, anon, authenticated/);
});

test('Overpass responses are bounded before JSON parsing', () => {
  assert.match(overpass, /MAX_RESPONSE_BYTES = 8 \* 1024 \* 1024/);
  assert.match(overpass, /res\.body\.getReader\(\)/);
  assert.match(overpass, /total > MAX_RESPONSE_BYTES/);
  assert.ok(
    overpass.indexOf('total > MAX_RESPONSE_BYTES') < overpass.indexOf('JSON.parse'),
    'decoded response size must be checked before JSON parsing',
  );
  assert.match(overpass, /elements\.length > MAX_ELEMENTS/);
});

test('geocoder responses are stream-bounded before JSON parsing', () => {
  assert.match(geocoding, /MAX_GEOCODER_RESPONSE_BYTES = 256 \* 1024/);
  assert.match(geocoding, /response\.body\?\.getReader\(\)/);
  assert.match(geocoding, /bytes > MAX_GEOCODER_RESPONSE_BYTES/);
  assert.equal((geocoding.match(/readGeocoderJson</g) ?? []).length, 5);
  assert.doesNotMatch(geocoding, /res\.json\(\)/);
});

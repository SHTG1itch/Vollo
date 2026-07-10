// Runtime configuration for the Vollo API running as a Supabase Edge Function
// (Deno). Mirrors the original Express `config` but reads from `Deno.env`.
// Authentication is handled by Supabase Auth (validated via the service-role
// client in supabaseAdmin.ts); the internal sweep token still lives in the
// private `app_secrets` table and is loaded lazily via db.ts/getSecret().
import { resolveDatabaseUrl } from './databaseUrl.ts';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

const env = Deno.env.get('NODE_ENV') ?? 'production';

export const config = {
  env,

  database: {
    // Prefer a complete transaction-pooler URL. Production can instead provide
    // only its non-secret shared-pooler host: the resolver reuses Supabase's
    // injected database credential without exposing it outside the isolate.
    // Local development remains zero-config through the injected direct URL.
    url: resolveDatabaseUrl({
      explicitPoolUrl: Deno.env.get('DATABASE_POOL_URL'),
      directUrl: Deno.env.get('SUPABASE_DB_URL'),
      poolHost: Deno.env.get('DATABASE_POOL_HOST'),
      supabaseUrl: Deno.env.get('SUPABASE_URL'),
    }),
  },

  geocoder: {
    provider: (Deno.env.get('GEOCODER') ?? 'nominatim') as 'nominatim' | 'geoapify',
    nominatimBaseUrl: Deno.env.get('NOMINATIM_BASE_URL') ?? 'https://nominatim.openstreetmap.org',
    nominatimUserAgent: Deno.env.get('NOMINATIM_USER_AGENT') ?? 'Vollo/1.0 (app.vollo.mobile)',
    // The public service has an application-wide absolute ceiling of one
    // request per second. The database-backed lease in geocoding.ts enforces
    // this across every Edge isolate; never allow configuration below 1s.
    nominatimMinIntervalMs: Math.max(1_000, num(Deno.env.get('NOMINATIM_MIN_INTERVAL_MS'), 1_100)),
    geoapifyApiKey: Deno.env.get('GEOAPIFY_API_KEY') ?? '',
  },

  territory: {
    radiusKm: num(Deno.env.get('TERRITORY_RADIUS_KM'), 10),
    minCourts: num(Deno.env.get('TERRITORY_MIN_COURTS'), 3),
    leaderboardWindowDays: num(Deno.env.get('LEADERBOARD_WINDOW_DAYS'), 30),
    // ST_ConcaveHull "target percent": 1.0 = convex hull, lower = hugs the
    // dominated courts more tightly so polygon vertices land on the courts the
    // player actually controls. Kept high enough to stay a clean, valid polygon.
    concaveTargetPercent: num(Deno.env.get('TERRITORY_CONCAVE_PCT'), 0.7),
    // A rival is "challenging" a controlled court once their 30-day court score
    // reaches this fraction of the controller's — triggers a Turf War alert.
    turfWarThreshold: num(Deno.env.get('TURF_WAR_THRESHOLD'), 0.7),
  },

  streak: {
    windowDays: num(Deno.env.get('STREAK_WINDOW_DAYS'), 7),
    modifierStep: num(Deno.env.get('STREAK_MODIFIER_STEP'), 0.1),
    modifierMax: num(Deno.env.get('STREAK_MODIFIER_MAX'), 2.0),
  },
} as const;

export type Config = typeof config;

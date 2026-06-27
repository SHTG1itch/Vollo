// Runtime configuration for the Vollo API running as a Supabase Edge Function
// (Deno). Mirrors the original Express `config` but reads from `Deno.env`. The
// JWT signing secret and internal sweep token are NOT here — they live in the
// private `app_secrets` table and are loaded lazily via db.ts/getSecret().

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
    // Auto-injected by Supabase into every Edge Function — the direct Postgres
    // connection string (service role), which bypasses RLS. All data access is
    // funnelled through this function, so the public REST API stays sealed.
    url: Deno.env.get('SUPABASE_DB_URL') ?? '',
  },

  auth: {
    jwtExpiresIn: Deno.env.get('JWT_EXPIRES_IN') ?? '30d',
    // bcryptjs is pure-JS (≈10× slower than native), so cost 12 would burn too
    // much CPU per login in the edge runtime. 10 keeps logins snappy and is still
    // a sound work factor. Override with BCRYPT_ROUNDS if desired.
    bcryptRounds: num(Deno.env.get('BCRYPT_ROUNDS'), 10),
  },

  geocoder: {
    provider: (Deno.env.get('GEOCODER') ?? 'nominatim') as 'nominatim' | 'geoapify',
    nominatimBaseUrl: Deno.env.get('NOMINATIM_BASE_URL') ?? 'https://nominatim.openstreetmap.org',
    nominatimUserAgent: Deno.env.get('NOMINATIM_USER_AGENT') ?? 'Vollo/0.1',
    geoapifyApiKey: Deno.env.get('GEOAPIFY_API_KEY') ?? '',
  },

  territory: {
    radiusKm: num(Deno.env.get('TERRITORY_RADIUS_KM'), 10),
    minCourts: num(Deno.env.get('TERRITORY_MIN_COURTS'), 3),
    leaderboardWindowDays: num(Deno.env.get('LEADERBOARD_WINDOW_DAYS'), 30),
  },

  streak: {
    windowDays: num(Deno.env.get('STREAK_WINDOW_DAYS'), 7),
    modifierStep: num(Deno.env.get('STREAK_MODIFIER_STEP'), 0.1),
    modifierMax: num(Deno.env.get('STREAK_MODIFIER_MAX'), 2.0),
  },
} as const;

export type Config = typeof config;

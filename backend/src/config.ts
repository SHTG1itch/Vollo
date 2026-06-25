import 'dotenv/config';

/** Parse a number from env with a fallback. */
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),

  database: {
    url: process.env.DATABASE_URL ?? 'postgres://vollo:vollo@localhost:5432/vollo',
    ssl: bool(process.env.DATABASE_SSL, false),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    bcryptRounds: num(process.env.BCRYPT_ROUNDS, 10),
  },

  geocoder: {
    provider: (process.env.GEOCODER ?? 'nominatim') as 'nominatim' | 'geoapify',
    nominatimBaseUrl: process.env.NOMINATIM_BASE_URL ?? 'https://nominatim.openstreetmap.org',
    nominatimUserAgent: process.env.NOMINATIM_USER_AGENT ?? 'Vollo/0.1',
    geoapifyApiKey: process.env.GEOAPIFY_API_KEY ?? '',
  },

  /** Geospatial domination engine tuning. */
  territory: {
    radiusKm: num(process.env.TERRITORY_RADIUS_KM, 10),
    minCourts: num(process.env.TERRITORY_MIN_COURTS, 3),
    leaderboardWindowDays: num(process.env.LEADERBOARD_WINDOW_DAYS, 30),
  },

  /** Temporal heat index (streak) tuning. */
  streak: {
    windowDays: num(process.env.STREAK_WINDOW_DAYS, 7),
    modifierStep: num(process.env.STREAK_MODIFIER_STEP, 0.1),
    modifierMax: num(process.env.STREAK_MODIFIER_MAX, 2.0),
  },

  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
} as const;

export type Config = typeof config;

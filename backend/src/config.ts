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

const env = process.env.NODE_ENV ?? 'development';
const isProduction = env === 'production';

const DEV_JWT_SECRET = 'dev-only-change-me';

/**
 * Resolve the JWT signing secret. In production we refuse to boot with a
 * missing/empty/weak secret: shipping the public dev default would let anyone
 * forge tokens for any user. In development we fall back to the dev secret.
 */
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (isProduction) {
      throw new Error('JWT_SECRET must be set (and ≥32 chars) in production.');
    }
    return DEV_JWT_SECRET;
  }
  if (isProduction && (secret === DEV_JWT_SECRET || secret.length < 32)) {
    throw new Error('JWT_SECRET must be a strong, non-default secret of ≥32 chars in production.');
  }
  return secret;
}

/**
 * Resolve the CORS allowlist. Vollo's only client is the native app (not subject
 * to CORS), so a wildcard isn't a credential-leak risk here — but a browser
 * dashboard could be added later, so in production we surface a loud warning
 * when the origin is left wide-open rather than silently shipping '*'.
 */
function resolveCorsOrigin(): string {
  const origin = process.env.CORS_ORIGIN;
  if (isProduction && (!origin || origin === '*')) {
    console.warn('[config] CORS_ORIGIN is unset/“*” in production — set an explicit allowlist if you add a browser client.');
    return '*';
  }
  return origin ?? '*';
}

export const config = {
  env,
  port: num(process.env.PORT, 4000),

  database: {
    url: process.env.DATABASE_URL ?? 'postgres://vollo:vollo@localhost:5432/vollo',
    ssl: bool(process.env.DATABASE_SSL, false),
    // Verify the server certificate. Default off to stay compatible with the
    // self-signed certs some free-tier providers use; set DATABASE_SSL_STRICT=true
    // (and provide a CA the host trusts) to harden against MITM in production.
    sslStrict: bool(process.env.DATABASE_SSL_STRICT, false),
  },

  auth: {
    jwtSecret: resolveJwtSecret(),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    bcryptRounds: num(process.env.BCRYPT_ROUNDS, 12),
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
    origin: resolveCorsOrigin(),
  },

  /** Run the cron sweeps inside the API process (single $0 web service). */
  startWorker: bool(process.env.START_WORKER, false),
} as const;

export type Config = typeof config;

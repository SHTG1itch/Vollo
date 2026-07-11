// ════════════════════════════════════════════════════════════════════════
// Vollo API — Supabase Edge Function (Deno + Hono).
//
// Auth is Supabase Auth: clients send a Supabase access token as the bearer,
// which this function validates (adminClient.auth.getUser) and resolves to the
// app profile (users.auth_id → users.id, kept as the claim subject so every FK
// and ownership check is unchanged). DB access goes through the direct Postgres
// connection (service role, bypassing RLS); all authorization is enforced here,
// so the public PostgREST API stays sealed by RLS.
// ════════════════════════════════════════════════════════════════════════
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';

import { query, queryOne, withTransaction, getSecret, type Queryable } from './db.ts';
import { adminClient, authClient } from './supabaseAdmin.ts';
import { ApiError } from './errors.ts';
import { mapCourt, mapMatchCard, mapPublicUser, mapScheduledMatch, mapUser, toIso } from './mappers.ts';
import {
  bboxQuerySchema, calendarQuerySchema, clubsQuerySchema, commentSchema, commentsQuerySchema,
  courtsQuerySchema, createClubSchema, createCourtSchema, createMatchSchema, createScheduledMatchSchema,
  discoverQuerySchema, feedQuerySchema, followRequestActionSchema,
  geocodeQuerySchema, loginSchema, matchMediaDraftSchema, notificationIdsSchema, profileMediaDraftSchema, pushTokenSchema,
  reverseGeocodeQuerySchema, setGoalSchema, updateProfileSchema, updateScheduledMatchSchema,
  userSearchQuerySchema, verifyMatchSchema, yearQuerySchema,
} from './validation.ts';
import type { CreateMatchInput } from './validation.ts';
import { analyzeScore, matchScore } from './scoring.ts';
import { recomputeUserStreak, getStreakState } from './streak.ts';
import { recomputeUserRatings, getRatings } from './rating.ts';
import { evaluateAchievements, getAchievements } from './achievements.ts';
import { getCourtController, recomputeAfterMatch, getUserTerritories, listTerritories } from './territory.ts';
import { notify } from './notifications.ts';
import {
  GeocoderBusyError,
  allowsAutomatedGeocoding,
  geocode,
  reverseGeocode,
} from './geocoding.ts';
import { fetchOverpassSectors, type OverpassSector } from './overpass.ts';
import { getProfileAnalytics, getHeadToHead } from './analytics.ts';
import { getPersonalRecords, getYearInReview } from './records.ts';
import { runStreakSweep, runTerritorySweep, runCourtNameSweep, runRatingSweep } from './sweeps.ts';
import { processMediaCleanupJobs } from './mediaCleanup.ts';
import { isGoogleAvatarUrl, isOwnedUserMediaUrl, ownedUserMediaPathFromUrl } from './mediaOwnership.ts';
import type { AuthClaims, LeaderboardEntry, MatchCard, MatchStats, Surface } from './types.ts';

type Env = { Variables: { user?: AuthClaims; requestId: string } };

const USER_SELECT = `
  id, username, email, display_name, avatar_url, cover_url, bio, dominant_hand, color,
  ST_Y(home_geom) AS home_lat, ST_X(home_geom) AS home_lng, home_label, equipment, is_private,
  show_competitive, created_at
`;

// ─── Helpers ────────────────────────────────────────────────────────────────
async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DAILY_MATCH_CAP = 100;
const DAILY_SCHEDULE_CAP = 100;
const DAILY_COMMENT_CAP = 500;
const PUSH_TOKEN_CAP = 20;

/** Reject malformed UUID path values at the HTTP boundary. Letting PostgreSQL
 * cast attacker-controlled text would turn a client 400 into a noisy 500. */
function uuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name);
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw ApiError.badRequest(`${name} must be a valid UUID`);
  }
  return value;
}

function uid(c: Context<Env>): string {
  const u = c.get('user');
  if (!u) throw ApiError.unauthorized();
  return u.sub;
}

function authUid(c: Context<Env>): string {
  const user = c.get('user');
  if (!user) throw ApiError.unauthorized();
  return user.auth_id;
}

interface AuthResult {
  claims: AuthClaims | null;
  hadToken: boolean;
  /** True when validation couldn't complete (GoTrue/DB blip) rather than the
   *  token being definitively invalid — so callers surface a retryable 503
   *  instead of a 401 that would force the client to sign out. */
  transient: boolean;
}

async function authFromHeader(c: Context): Promise<AuthResult> {
  const header = c.req.header('Authorization') ?? c.req.header('authorization');
  if (header === undefined) return { claims: null, hadToken: false, transient: false };
  // Once a caller supplies Authorization, malformed credentials must not be
  // silently downgraded to an anonymous request on optional-auth routes.
  const bearer = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!bearer) return { claims: null, hadToken: true, transient: false };
  const token = bearer[1]!;
  try {
    // Validate the Supabase Auth access token, then resolve it to our profile.
    // We keep claims.sub = users.id (NOT the auth id) so every existing FK
    // reference and ownership check stays intact.
    const { data, error } = await adminClient.auth.getUser(token);
    if (error) {
      // A 4xx (other than rate-limit) means the token is genuinely invalid;
      // anything else (network, 5xx, rate-limit) is a transient failure.
      const status = (error as { status?: number }).status ?? 0;
      const definitelyInvalid = status >= 400 && status < 500 && status !== 429;
      return { claims: null, hadToken: true, transient: !definitelyInvalid };
    }
    if (!data.user) return { claims: null, hadToken: true, transient: false };
    const row = await queryOne<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE auth_id = $1',
      [data.user.id],
    );
    if (!row) return { claims: null, hadToken: true, transient: false };
    return {
      claims: { sub: row.id, username: row.username, auth_id: data.user.id },
      hadToken: true,
      transient: false,
    };
  } catch {
    // Threw before we could decide (GoTrue network error, DB error) — transient.
    return { claims: null, hadToken: true, transient: true };
  }
}

function throwAuthFailure(hadToken: boolean, transient: boolean): never {
  if (transient) {
    throw new ApiError(503, 'auth_unavailable', 'Sign-in check is temporarily unavailable, please retry');
  }
  throw hadToken ? ApiError.unauthorized('Invalid or expired token') : ApiError.unauthorized();
}

const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const { claims, hadToken, transient } = await authFromHeader(c);
  if (!claims) throwAuthFailure(hadToken, transient);
  c.set('user', claims);
  await next();
};

const optionalAuth: MiddlewareHandler<Env> = async (c, next) => {
  const { claims, hadToken, transient } = await authFromHeader(c);
  // No header is genuinely anonymous. A supplied bad token is a 401, while an
  // auth-provider/DB blip is retryable and must not accidentally broaden access.
  if (!claims && (hadToken || transient)) throwAuthFailure(hadToken, transient);
  if (claims) c.set('user', claims);
  await next();
};

// Best-effort in-memory fixed-window rate limiter (per isolate). The mobile app
// is the only client, so this is just an abuse backstop, not a strict quota.
function makeLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const maxBuckets = 4_096;
  let calls = 0;
  return (key: string): boolean => {
    const now = Date.now();
    // Edge isolates are long-lived enough for a rotating-IP attack to grow an
    // otherwise unbounded Map. Periodically reap expired entries and cap the
    // remainder; eviction can only relax this best-effort local backstop, while
    // the durable login limiter remains authoritative across isolates.
    calls += 1;
    if (calls % 256 === 0) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (!b && buckets.size >= maxBuckets) {
        const oldestKey = buckets.keys().next().value as string | undefined;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= max;
  };
}
// Username-availability checks are an enumeration surface, so keep them lightly
// limited per IP. Sign-in is a credential-testing surface — limit it more tightly.
const usernameLimiter = makeLimiter(60_000, 30);
const loginLimiter = makeLimiter(60_000, 15);
const geocodeLimiterFn = makeLimiter(60_000, 30);
// Discovery fans out to the free Overpass API + writes courts, so it gets its
// own limiter (in addition to requiring auth) to protect the shared egress IP
// from getting Overpass-banned, which would break court discovery for everyone.
const discoverLimiterFn = makeLimiter(60_000, 40);
function clientIp(c: Context): string {
  // Take the LAST x-forwarded-for hop: it is the one appended by Supabase's own
  // gateway. The first entry is client-controlled — every proxy APPENDS the
  // address it received from, so an attacker who sends their own X-Forwarded-For
  // owns hops[0]. Keying anti-abuse throttles on that lets a spray rotate a fake
  // header for a fresh bucket per request (and churn the LRU maps, evicting
  // legitimate callers). The trusted rightmost hop cannot be forged this way.
  const hops = c.req.header('x-forwarded-for')?.split(',') ?? [];
  return hops.at(-1)?.trim().slice(0, 128) || 'unknown';
}

async function opaqueThrottleKey(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}:${hex}`;
}

/** Escape ILIKE wildcards in user-supplied search text so `%`/`_` match
 *  literally (backslash is Postgres's default ESCAPE character). Without this,
 *  q="%" lists everything and stacked wildcards force expensive scans. */
function escapeLike(q: string): string {
  return q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Constant-time string equality for shared-secret checks. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// Durable brute-force throttle for sign-in: failed attempts are counted in
// Postgres (per client IP and per target identifier) so the limit holds across
// the whole edge fleet — the in-memory limiter above is only per-isolate.
const LOGIN_FAILURE_WINDOW = "15 minutes";
const LOGIN_MAX_FAILURES = 10;

function rateLimitError(message: string, retryAfterSeconds: number): ApiError {
  const error = ApiError.tooManyRequests(message) as ApiError & { retryAfterSeconds: number };
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

async function assertLoginNotThrottled(keys: string[]): Promise<void> {
  // Per-key max, NOT a combined count — every failure inserts one row per key
  // (ip + identifier), so summing across keys would halve the effective limit.
  const row = await queryOne<{ c: string }>(
    `SELECT COALESCE(MAX(per_key), 0) AS c FROM (
       SELECT COUNT(*) AS per_key FROM login_attempts
        WHERE key = ANY($1) AND attempted_at > now() - $2::interval
        GROUP BY key
     ) t`,
    [keys, LOGIN_FAILURE_WINDOW],
  );
  if (Number(row?.c ?? 0) >= LOGIN_MAX_FAILURES) {
    throw rateLimitError('Too many sign-in attempts, please try again later', 15 * 60);
  }
}

async function recordLoginFailure(keys: string[]): Promise<void> {
  await query('INSERT INTO login_attempts (key) SELECT unnest($1::text[])', [keys]).catch(() => {});
  // Opportunistic prune so the table never grows unbounded — fire-and-forget:
  // never make the (attacker-controlled) failure path wait on housekeeping.
  if (Math.random() < 0.02) {
    void query(`DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 hour'`).catch(() => {});
  }
}

/** A successful sign-in proves ownership of the target account, but says
 *  nothing about other attempts from that IP. Clear only the canonical account
 *  bucket and await it so a following request cannot observe stale failures. */
async function clearLoginFailures(accountKey: string): Promise<void> {
  await query('DELETE FROM login_attempts WHERE key = $1', [accountKey]).catch(() => {});
}

// Opaque keyset cursor (last seen played_at + id). Content is ASCII (ISO + uuid).
interface Cursor { t: string; id: string }
function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeCursor(raw: string): Cursor {
  try {
    const b64 = raw.replaceAll('-', '+').replaceAll('_', '/');
    const parsed = JSON.parse(atob(b64));
    if (
      typeof parsed?.t === 'string' &&
      typeof parsed?.id === 'string' &&
      UUID_RE.test(parsed.id) &&
      !Number.isNaN(new Date(parsed.t).getTime())
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    /* fall through */
  }
  throw ApiError.badRequest('Invalid pagination cursor');
}
function nextCursor(rows: MatchCard[], hasMore: boolean): string | null {
  if (!hasMore || rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  return encodeCursor({ t: last.played_at, id: last.id });
}

const STAT_KEYS: (keyof MatchStats)[] = [
  'first_serve_in', 'first_serve_total', 'second_serve_in', 'second_serve_total',
  'aces', 'double_faults', 'forehand_winners', 'forehand_errors',
  'backhand_winners', 'backhand_errors', 'volley_winners', 'volley_errors',
  'rally_short', 'rally_medium', 'rally_long', 'break_points_won', 'break_points_total',
];
function fullStats(partial?: Partial<MatchStats>): MatchStats {
  const out = {} as MatchStats;
  for (const k of STAT_KEYS) out[k] = partial?.[k] ?? 0;
  return out;
}

async function fetchMatchCard(matchId: string, viewerId: string | null) {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT mf.*,
            ${visibleMatchSocialColumns('$2')},
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $2)
            END AS viewer_has_kudos
       FROM match_feed mf WHERE mf.id = $1`,
    [matchId, viewerId],
  );
  if (!row) return null;
  const card = mapMatchCard(row);
  const stats = await queryOne<MatchStats>('SELECT * FROM match_stats WHERE match_id = $1', [matchId]);
  card.stats = stats ?? null;
  return card;
}

async function resolveUserId(username: string): Promise<string> {
  const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  if (!row) throw ApiError.notFound('User not found');
  return row.id;
}

/**
 * Can `viewerId` see `targetId`'s content (matches, stats, analytics)?
 * - `blocked`: a block exists in either direction — the players are mutually
 *   invisible, so callers surface a 404 (never reveal the block).
 * - `restricted`: the target is private and the viewer isn't a follower — the
 *   profile shell stays visible but matches/stats do not.
 */
async function profileAccess(
  targetId: string,
  viewerId: string | null,
): Promise<{ blocked: boolean; restricted: boolean }> {
  if (viewerId === targetId) return { blocked: false, restricted: false };
  const row = await queryOne<{ is_private: boolean; blocked: boolean; follows: boolean }>(
    `SELECT u.is_private,
            EXISTS(SELECT 1 FROM blocks b
                    WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
                       OR (b.blocker_id = $2 AND b.blocked_id = u.id)) AS blocked,
            EXISTS(SELECT 1 FROM follows f
                    WHERE f.follower_id = $2 AND f.following_id = u.id) AS follows
       FROM users u WHERE u.id = $1`,
    [targetId, viewerId],
  );
  if (!row) throw ApiError.notFound('User not found');
  return { blocked: Boolean(row.blocked), restricted: row.is_private && !row.follows };
}

/** Guard for content routes: 404 when blocked (invisible), 403 when private. */
async function assertCanViewContent(targetId: string, viewerId: string | null): Promise<void> {
  const access = await profileAccess(targetId, viewerId);
  if (access.blocked) throw ApiError.notFound('User not found');
  if (access.restricted) throw new ApiError(403, 'private_profile', 'This profile is private');
}

/** SQL predicate implementing the symmetric block boundary for one visible
 * user row. A null viewer is anonymous and therefore has no block graph. */
function mutuallyVisibleCondition(viewerParam: string, userCol: string): string {
  return `(${userCol} = ${viewerParam} OR NOT EXISTS(
    SELECT 1 FROM blocks bv
     WHERE (bv.blocker_id = ${viewerParam} AND bv.blocked_id = ${userCol})
        OR (bv.blocker_id = ${userCol} AND bv.blocked_id = ${viewerParam})))`;
}

/** Viewer-specific social totals. The match_feed view intentionally stores raw
 * aggregate counts; blocked actors must be removed at the API boundary. */
function visibleMatchSocialColumns(viewerParam: string): string {
  return `
    (SELECT COUNT(*) FROM kudos vk
      WHERE vk.match_id = mf.id AND ${mutuallyVisibleCondition(viewerParam, 'vk.user_id')})
      AS visible_kudos_count,
    (SELECT COUNT(*) FROM comments vc
      WHERE vc.match_id = mf.id AND ${mutuallyVisibleCondition(viewerParam, 'vc.user_id')})
      AS visible_comment_count`;
}

/** Lock both profile rows in stable UUID order before changing their social
 * relationship. Follow, request, block, and unblock requests therefore cannot
 * pass stale pre-checks and commit contradictory states. */
async function lockSocialPair(client: Queryable, leftId: string, rightId: string): Promise<void> {
  // Match the database trigger/FK lock order: pair advisory first, profile rows
  // second. Re-acquiring the same xact advisory lock inside an INSERT trigger is
  // safe and avoids a direct-SQL write deadlocking an API relationship request.
  await client.query('SELECT public.lock_social_pair($1, $2)', [leftId, rightId]);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users
      WHERE id = $1 OR id = $2
      ORDER BY id
      FOR UPDATE`,
    [leftId, rightId],
  );
  if (rows.length !== 2) throw ApiError.notFound('User not found');
}

async function socialPairIsBlocked(
  client: Queryable,
  leftId: string,
  rightId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
     ) AS blocked`,
    [leftId, rightId],
  );
  return Boolean(rows[0]?.blocked);
}

/**
 * SQL fragments that hide matches the viewer may not see, matching
 * assertCanViewContent: no block in either direction, and private authors only
 * for their followers (or themselves). `viewerParam` is the placeholder holding
 * the (nullable) viewer id; `authorCol` the match author column. With a NULL
 * viewer the block EXISTS never matches and only public authors pass.
 */
function matchVisibilityConditions(viewerParam: string, authorCol: string): string[] {
  return [
    mutuallyVisibleCondition(viewerParam, authorCol),
    // A registered opponent's identity appears on the card too. Participants
    // retain their own record, while third parties must pass both block graphs.
    `(mf.opponent_id IS NULL OR mf.user_id = ${viewerParam} OR mf.opponent_id = ${viewerParam}
       OR ${mutuallyVisibleCondition(viewerParam, 'mf.opponent_id')})`,
    // A verified registered opponent is part of the activity, not merely free
    // text. Their private-account boundary must therefore protect the shared
    // match from third parties just as the author's boundary does.
    `(mf.opponent_id IS NULL OR mf.user_id = ${viewerParam} OR mf.opponent_id = ${viewerParam}
       OR NOT (SELECT ou.is_private FROM users ou WHERE ou.id = mf.opponent_id)
       OR EXISTS(SELECT 1 FROM follows ofl
                  WHERE ofl.follower_id = ${viewerParam} AND ofl.following_id = mf.opponent_id))`,
    `(${authorCol} = ${viewerParam}
       OR NOT (SELECT u.is_private FROM users u WHERE u.id = ${authorCol})
       OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ${viewerParam} AND f.following_id = ${authorCol}))`,
  ];
}

/**
 * Pending (unconfirmed) and rejected (disputed) matches are visible only to
 * their participants — a disputed "win" must never sit on public feeds. Only
 * valid against the `match_feed` alias `mf` (needs user_id + opponent_id).
 */
function matchStatusCondition(viewerParam: string): string {
  return `(mf.verification_status IN ('auto','verified')
            OR mf.user_id = ${viewerParam} OR mf.opponent_id = ${viewerParam})`;
}

/**
 * SQL fragments for the COMPETITIVE surfaces — territory polygons, court/club
 * leaderboards, the court-controller banner. These are governed by the owner's
 * own `show_competitive` toggle, NOT by private-account/follower rules: with it
 * on they're visible to everybody (the Turf War map is a public game board),
 * with it off they're hidden from everyone but the owner. Blocks still make
 * two players mutually invisible. `userCol` holds the owner's user id;
 * `viewerParam` the (nullable) viewer id param.
 */
function userVisibilityConditions(viewerParam: string, userCol: string): string[] {
  return [
    `(${userCol} = ${viewerParam} OR NOT EXISTS(
        SELECT 1 FROM blocks b
         WHERE (b.blocker_id = ${viewerParam} AND b.blocked_id = ${userCol})
            OR (b.blocker_id = ${userCol} AND b.blocked_id = ${viewerParam})))`,
    `(${userCol} = ${viewerParam}
       OR (SELECT u2.show_competitive FROM users u2 WHERE u2.id = ${userCol}))`,
  ];
}

/**
 * Apply a (now-counting) match's effects to the logger: recompute their streak,
 * persist the court MatchScore with the current streak modifier, and recompute
 * their Bayesian per-surface ratings from history. Used both for matches that
 * count immediately ('auto') and when an opponent verifies a pending one. Must
 * run inside the match's transaction so both recomputes see this match's status.
 */
async function applyMatchEffects(
  client: Queryable,
  args: {
    matchId: string;
    userId: string;
    gamesWon: number;
    gamesLost: number;
  },
): Promise<void> {
  const streak = await recomputeUserStreak(args.userId, client);
  const score = matchScore(args.gamesWon, args.gamesLost, streak.streakModifier);
  await client.query(
    'UPDATE matches SET streak_modifier = $1, match_score = $2 WHERE id = $3',
    [streak.streakModifier, score, args.matchId],
  );
  // Ratings are a pure function of history — recompute (replay) rather than
  // applying a delta, so deletion stays exact and the Bayesian update is sound.
  await recomputeUserRatings(client, args.userId);
}

// ════════════════════════════════════════════════════════════════════════
// App
// ════════════════════════════════════════════════════════════════════════
const app = new Hono<Env>();

app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type', 'X-Client-Info', 'apikey'],
  exposeHeaders: ['Retry-After', 'X-Request-Id'],
  maxAge: 600,
}));
app.use('*', secureHeaders());
app.use('*', async (c, next) => {
  // Generate this at the trust boundary rather than reflecting a caller value.
  // It ties a generic client 500 to one sanitized server log without exposing
  // tokens, request bodies, emails, or other private data.
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});
app.use('*', bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({
    error: { code: 'payload_too_large', message: 'Request body must not exceed 64 KiB' },
  }, 413),
}));

// Global request ceiling — a cheap abuse backstop.
const globalLimiter = makeLimiter(60_000, 200);
app.use('/api/*', async (c, next) => {
  if (!globalLimiter(clientIp(c))) throw ApiError.tooManyRequests();
  // Apply before dispatch so authentication failures and unexpected errors get
  // the same cache protection as successful viewer-specific responses.
  const suppliedAuth = c.req.header('Authorization') ?? c.req.header('authorization');
  if (suppliedAuth || c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/internal/')) {
    c.header('Cache-Control', 'no-store');
  }
  await next();
  // Tokens and viewer-specific payloads must never be stored by a browser,
  // shared proxy, or an over-eager intermediary cache.
  if (c.get('user')) {
    c.header('Cache-Control', 'no-store');
  }
});

app.get('/api', (c) => c.json({ name: 'Vollo API', status: 'ok', runtime: 'supabase-edge' }));
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// ─── Auth ────────────────────────────────────────────────────────────────
// Sign-up happens client-side against Supabase Auth (the mobile app calls
// supabase.auth.signUp directly — the user supplies their own email, so nothing
// is disclosed). Sign-in is proxied here so a username can be turned into a
// session without the client ever seeing anyone's email.

// Username availability for the sign-up form. Reveals only whether a handle is
// taken (unavoidable for "username already in use" UX) — never an email.
app.get('/api/auth/username-available', async (c) => {
  if (!usernameLimiter(clientIp(c))) throw ApiError.tooManyRequests('Too many lookups, please try again shortly');
  const username = (c.req.query('username') ?? '').trim();
  if (!username || username.length > 60) throw ApiError.badRequest('username is required');
  const row = await queryOne<{ taken: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1)) AS taken',
    [username],
  );
  return c.json({ available: !row?.taken });
});

// Server-side sign-in proxy. The client sends a username (or email) + password;
// we resolve the email internally and complete the password grant with the
// anon-key client, returning the session tokens. The email is never sent back,
// and "no such account" and "wrong password" fail identically so the endpoint
// can't be used to enumerate accounts.
app.post('/api/auth/login', async (c) => {
  if (!loginLimiter(clientIp(c))) {
    throw rateLimitError('Too many sign-in attempts, please try again shortly', 60);
  }
  const { identifier, password } = loginSchema.parse(await jsonBody(c));

  // Resolve both usernames and emails to the same durable account bucket. This
  // prevents alternating a user's username/email from doubling the guess quota.
  const normalizedIdentifier = identifier.toLowerCase();
  const isEmailIdentifier = identifier.includes('@');
  const account = await queryOne<{ id: string; email: string }>(
    isEmailIdentifier
      ? 'SELECT id, email FROM users WHERE email = $1'
      : 'SELECT id, email FROM users WHERE username = $1',
    [identifier],
  );
  // Unknown identifiers are attacker-controlled and may themselves be private
  // data. Keep only a stable hash in the durable throttle table.
  const accountKey = account
    ? `account:${account.id}`
    : await opaqueThrottleKey('id', normalizedIdentifier);
  // Throttle on both source IP and canonical target account, so neither a
  // single-IP spray nor a distributed attack on one account gets free tries.
  const throttleKeys = [`ip:${clientIp(c)}`, accountKey];
  await assertLoginNotThrottled(throttleKeys);

  const email: string | null = account?.email ?? (isEmailIdentifier ? identifier : null);
  const invalid = async () => {
    await recordLoginFailure(throttleKeys);
    return new ApiError(401, 'invalid_credentials', 'Invalid username or password');
  };
  if (!email) throw await invalid();

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) {
    // Unconfirmed email is a distinct, actionable state — surface it so the app
    // can tell the user to check their inbox (and don't count it as a guess).
    // Everything else collapses to the generic invalid-credentials message.
    const code = (error as { code?: string }).code;
    if (code === 'email_not_confirmed') {
      // Still counts toward the throttle: this branch confirms an account
      // exists, so unlimited probes would be an enumeration channel.
      await recordLoginFailure(throttleKeys);
      throw new ApiError(403, 'email_not_confirmed', 'Please confirm your email before signing in — check your inbox.');
    }
    throw await invalid();
  }
  if (!data.session) throw await invalid();

  // A valid login may forgive failures against this account, never the shared
  // IP bucket (otherwise one known credential resets an attacker's IP quota).
  await clearLoginFailures(accountKey);
  const s = data.session;
  return c.json({
    session: {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at,
      expires_in: s.expires_in,
      token_type: s.token_type,
    },
  });
});

app.get('/api/auth/me', requireAuth, async (c) => {
  const row = await queryOne<Record<string, unknown>>(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [uid(c)]);
  if (!row) throw ApiError.notFound('User not found');
  return c.json({ user: mapUser(row) });
});

// ─── Feed ──────────────────────────────────────────────────────────────────
app.get('/api/feed', optionalAuth, async (c) => {
  const { scope, limit, before } = feedQuerySchema.parse(c.req.query());
  const viewerId = c.get('user')?.sub ?? null;
  if (scope === 'following' && !viewerId) throw ApiError.unauthorized('Sign in to view your following feed');

  const conditions: string[] = [...matchVisibilityConditions('$1', 'mf.user_id'), matchStatusCondition('$1')];
  const params: unknown[] = [viewerId];
  let p = params.length;

  if (scope === 'following') {
    conditions.push(`(mf.user_id = $1 OR mf.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1))`);
  }
  if (before) {
    const cursor = decodeCursor(before);
    params.push(cursor.t, cursor.id);
    conditions.push(`(mf.played_at, mf.id) < ($${++p}::timestamptz, $${++p}::uuid)`);
  }
  params.push(limit + 1);
  const limitIdx = ++p;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.*,
            ${visibleMatchSocialColumns('$1')},
            CASE WHEN $1::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
            END AS viewer_has_kudos
       FROM match_feed mf
       ${where}
      ORDER BY mf.played_at DESC, mf.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  const hasMore = rows.length > limit;
  const matches = rows.slice(0, limit).map(mapMatchCard);
  return c.json({ matches, next_cursor: nextCursor(matches, hasMore) });
});

app.get('/api/feed/user/:userId', optionalAuth, async (c) => {
  const { limit, before } = feedQuerySchema.parse(c.req.query());
  const viewerId = c.get('user')?.sub ?? null;
  const targetId = uuidParam(c, 'userId');
  await assertCanViewContent(targetId, viewerId);
  const params: unknown[] = [viewerId, targetId];
  let p = params.length;
  let extra = '';
  if (before) {
    const cursor = decodeCursor(before);
    params.push(cursor.t, cursor.id);
    extra = `AND (mf.played_at, mf.id) < ($${++p}::timestamptz, $${++p}::uuid)`;
  }
  params.push(limit + 1);
  const limitIdx = ++p;
  // assertCanViewContent gates the profile *author* above, but a card also names
  // a verified registered opponent — so apply the same opponent block/privacy
  // fragments the global and club feeds use, or a private (or blocking) opponent
  // leaks onto a third party via this route while staying hidden everywhere else.
  const visibility = matchVisibilityConditions('$1', 'mf.user_id').join(' AND ');
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.*,
            ${visibleMatchSocialColumns('$1')},
            CASE WHEN $1::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
            END AS viewer_has_kudos
       FROM match_feed mf
      WHERE mf.user_id = $2 AND ${matchStatusCondition('$1')} AND ${visibility} ${extra}
      ORDER BY mf.played_at DESC, mf.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  const hasMore = rows.length > limit;
  const matches = rows.slice(0, limit).map(mapMatchCard);
  return c.json({ matches, next_cursor: nextCursor(matches, hasMore) });
});

// ─── Matches ─────────────────────────────────────────────────────────────
interface ScheduledMatchBinding {
  id: string;
  creator_id: string;
  opponent_id: string | null;
  opponent_name: string | null;
  court_id: string | null;
  surface: Surface | null;
  status: string;
  match_id: string | null;
}

/** Names on personal (off-app) schedules are identifiers, not display text.
 *  Normalize Unicode, case, and whitespace so harmless input differences do
 *  not prevent the real match from fulfilling its schedule. */
function normalizeOpponentName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Return the other registered participant, or null when the caller is not a
 *  participant. This lets either side log the result without permitting a
 *  third party or a different tagged opponent to consume the schedule. */
function scheduledCounterpartyId(
  creatorId: string,
  scheduledOpponentId: string,
  callerId: string,
): string | null {
  if (callerId === creatorId) return scheduledOpponentId;
  if (callerId === scheduledOpponentId) return creatorId;
  return null;
}

async function lockScheduledMatchForCreate(
  client: Queryable,
  scheduledMatchId: string,
  callerId: string,
  body: CreateMatchInput,
): Promise<ScheduledMatchBinding> {
  const { rows } = await client.query<ScheduledMatchBinding>(
    `SELECT id, creator_id, opponent_id, opponent_name, court_id, surface, status, match_id
       FROM scheduled_matches
      WHERE id = $1
      FOR UPDATE`,
    [scheduledMatchId],
  );
  const scheduled = rows[0];
  if (!scheduled) throw ApiError.notFound('Scheduled match not found');

  if (scheduled.opponent_id) {
    const expectedOpponentId = scheduledCounterpartyId(
      scheduled.creator_id,
      scheduled.opponent_id,
      callerId,
    );
    if (!expectedOpponentId) throw ApiError.forbidden('You are not a participant in this scheduled match');
    if (scheduled.status !== 'accepted') {
      throw ApiError.badRequest('The invited player must accept this scheduled match before a result can be logged');
    }
    if (body.opponent_id !== expectedOpponentId) {
      throw ApiError.badRequest('The tagged opponent does not match the scheduled opponent');
    }
  } else {
    if (scheduled.creator_id !== callerId) {
      throw ApiError.forbidden('You are not a participant in this scheduled match');
    }
    if (scheduled.status !== 'accepted') {
      throw ApiError.badRequest('This scheduled match is not available for logging');
    }
    if (
      body.opponent_id ||
      !body.opponent_name ||
      !scheduled.opponent_name ||
      normalizeOpponentName(body.opponent_name) !== normalizeOpponentName(scheduled.opponent_name)
    ) {
      throw ApiError.badRequest('The opponent name does not match the scheduled opponent');
    }
  }

  if (scheduled.match_id) throw ApiError.badRequest('A result has already been logged for this scheduled match');
  if (scheduled.court_id && scheduled.court_id !== (body.court_id ?? null)) {
    throw ApiError.badRequest('The court does not match the scheduled court');
  }
  if (scheduled.surface && scheduled.surface !== body.surface) {
    throw ApiError.badRequest('The surface does not match the scheduled surface');
  }
  return scheduled;
}

// Register media paths before their bytes are uploaded. If the app is killed
// before the owning write consumes one, the worker removes it after 24 hours.
async function registerMediaDraft(ownerAuthId: string, objectPath: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('vollo-media-draft:' || $1, 0))`,
      [ownerAuthId],
    );
    const { rows } = await client.query<{ already_registered: boolean; draft_count: string }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM media_object_cleanup_jobs
            WHERE object_path = $1 AND auth_id = $2 AND reason = 'draft'
         ) AS already_registered,
         (COUNT(*) FILTER (WHERE reason = 'draft'))::text AS draft_count
       FROM media_object_cleanup_jobs
       WHERE auth_id = $2`,
      [objectPath, ownerAuthId],
    );
    if (!rows[0]?.already_registered && Number(rows[0]?.draft_count ?? 0) >= 20) {
      throw ApiError.tooManyRequests('Too many unfinished photo drafts; try again after cleanup');
    }
    await client.query(
      `INSERT INTO media_object_cleanup_jobs
         (object_path, auth_id, reason, attempts, next_attempt_at, locked_until, last_error)
       VALUES ($1, $2, 'draft', 0, clock_timestamp() + interval '24 hours', NULL, NULL)
       ON CONFLICT (object_path) DO UPDATE SET
         auth_id = EXCLUDED.auth_id,
         reason = 'draft',
         attempts = 0,
         next_attempt_at = EXCLUDED.next_attempt_at,
         locked_until = NULL,
         last_error = NULL,
         updated_at = clock_timestamp()`,
      [objectPath, ownerAuthId],
    );
  });
}

async function discardMediaDraft(ownerAuthId: string, objectPath: string): Promise<void> {
  await query(
    `DELETE FROM media_object_cleanup_jobs
      WHERE object_path = $1 AND auth_id = $2 AND reason = 'draft'`,
    [objectPath, ownerAuthId],
  );
}

app.post('/api/media/match-drafts', requireAuth, async (c) => {
  const ownerAuthId = authUid(c);
  const { object_path: objectPath } = matchMediaDraftSchema.parse(await jsonBody(c));
  if (!objectPath.startsWith(`${ownerAuthId}/match/`)) {
    throw ApiError.badRequest('Match photo draft must belong to your media folder');
  }
  await registerMediaDraft(ownerAuthId, objectPath);
  return c.json({ ok: true }, 201);
});

app.delete('/api/media/match-drafts', requireAuth, async (c) => {
  const ownerAuthId = authUid(c);
  const { object_path: objectPath } = matchMediaDraftSchema.parse(await jsonBody(c));
  if (!objectPath.startsWith(`${ownerAuthId}/match/`)) {
    throw ApiError.badRequest('Match photo draft must belong to your media folder');
  }
  await discardMediaDraft(ownerAuthId, objectPath);
  return c.body(null, 204);
});

app.post('/api/media/profile-drafts', requireAuth, async (c) => {
  const ownerAuthId = authUid(c);
  const { object_path: objectPath } = profileMediaDraftSchema.parse(await jsonBody(c));
  if (!objectPath.startsWith(`${ownerAuthId}/profile/`)) {
    throw ApiError.badRequest('Profile photo draft must belong to your media folder');
  }
  await registerMediaDraft(ownerAuthId, objectPath);
  return c.json({ ok: true }, 201);
});

app.delete('/api/media/profile-drafts', requireAuth, async (c) => {
  const ownerAuthId = authUid(c);
  const { object_path: objectPath } = profileMediaDraftSchema.parse(await jsonBody(c));
  if (!objectPath.startsWith(`${ownerAuthId}/profile/`)) {
    throw ApiError.badRequest('Profile photo draft must belong to your media folder');
  }
  await discardMediaDraft(ownerAuthId, objectPath);
  return c.body(null, 204);
});

app.post('/api/matches', requireAuth, async (c) => {
  const userId = uid(c);
  const body = createMatchSchema.parse(await jsonBody(c)) as CreateMatchInput;
  const matchPhotoPath = body.photo_url
    ? ownedUserMediaPathFromUrl(body.photo_url, authUid(c), 'match')
    : null;
  if (body.photo_url && !matchPhotoPath) {
    throw ApiError.badRequest('Match photo must belong to your Vollo media folder');
  }

  let analysis;
  try {
    analysis = analyzeScore(body.score_array, { finalSetTiebreak: body.is_tiebreak });
  } catch (err) {
    throw ApiError.badRequest(err instanceof Error ? err.message : 'Invalid score');
  }

  if (body.opponent_id && body.opponent_id === userId) {
    throw ApiError.badRequest('You cannot log a match against yourself');
  }

  // Client-supplied idempotency key: a timed-out request the app retries must
  // not double-log (double Elo, double streak). The partial unique index on
  // (user_id, client_key) makes the second insert collide; we return the
  // original match instead.
  if (body.client_key) {
    const dupe = await queryOne<{ id: string; photo_url: string | null }>(
      'SELECT id, photo_url FROM matches WHERE user_id = $1 AND client_key = $2',
      [userId, body.client_key],
    );
    if (dupe) {
      const existingPhotoPath = dupe.photo_url
        ? ownedUserMediaPathFromUrl(dupe.photo_url, authUid(c), 'match')
        : null;
      if (matchPhotoPath && matchPhotoPath === existingPhotoPath) {
        await query(
          `DELETE FROM media_object_cleanup_jobs
            WHERE object_path = $1 AND auth_id = $2 AND reason = 'draft'`,
          [matchPhotoPath, authUid(c)],
        );
      }
      return c.json({ match: await fetchMatchCard(dupe.id, userId) }, 200);
    }
  }

  const playedAt = body.played_at ?? new Date().toISOString();
  const isTiebreak = analysis.isTiebreak;
  // A match against a registered Vollo player must be confirmed by that opponent
  // before it counts (ELO/streak/domination). Until then it's 'pending' and
  // contributes nothing. Matches with no registered opponent count immediately.
  const needsVerification = !!body.opponent_id;
  const verificationStatus = needsVerification ? 'pending' : 'auto';
  // Only meaningful when the match counts now — a pending match doesn't change
  // any court's controller, so there's no pre-state to capture.
  const previousControllerId =
    !needsVerification && body.court_id ? await getCourtController(body.court_id) : null;

  let matchId: string;
  try {
    matchId = await withTransaction(async (client) => {
    // A durable per-account ceiling protects rating replay and database growth.
    // Serialize count + insert so concurrent requests cannot all pass at 99.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('match-create:' || $1, 0))", [userId]);
    // The fast idempotency lookup above can race the first request's commit.
    // Recheck after the account lock and let the outer recovery path return it;
    // otherwise a retry arriving at the exact cap would incorrectly get 429.
    if (body.client_key) {
      const duplicate = await client.query<{ id: string }>(
        'SELECT id FROM matches WHERE user_id = $1 AND client_key = $2',
        [userId, body.client_key],
      );
      if (duplicate.rows.length > 0) throw new Error('idempotent match retry');
    }
    const recentMatches = await client.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM matches
        WHERE user_id = $1 AND created_at >= clock_timestamp() - interval '24 hours'`,
      [userId],
    );
    if (Number(recentMatches.rows[0]?.c ?? 0) >= DAILY_MATCH_CAP) {
      throw ApiError.tooManyRequests('Daily match logging limit reached; try again later');
    }
    if (body.opponent_id) {
      // Serialize the block check and pending-cap check with block/unblock and
      // every other tag for this pair. Concurrent requests cannot all observe
      // "two pending" and flood the opponent, and a block can never slip
      // between the check and INSERT.
      await lockSocialPair(client, userId, body.opponent_id);
      if (await socialPairIsBlocked(client, userId, body.opponent_id)) {
        throw ApiError.notFound('User not found');
      }
      const pending = await client.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM matches
          WHERE user_id = $1 AND opponent_id = $2 AND verification_status = 'pending'`,
        [userId, body.opponent_id],
      );
      if (Number(pending.rows[0]?.c ?? 0) >= 3) {
        throw ApiError.tooManyRequests('You already have matches awaiting this player’s confirmation');
      }
    }

    // Claim the schedule before inserting the result. The row lock serializes
    // logging against cancellation and another client attempting to bind a
    // second match to the same scheduled event.
    const scheduled = body.scheduled_match_id
      ? await lockScheduledMatchForCreate(client, body.scheduled_match_id, userId, body)
      : null;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO matches
         (user_id, opponent_id, opponent_name, court_id, surface, score_array, result,
          sets_won, sets_lost, games_won, games_lost, match_score, streak_modifier,
          rpe_index, duration_minutes, notes, is_tiebreak, played_at, verification_status,
          title, photo_url, client_key)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,0,1,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        userId,
        body.opponent_id ?? null,
        body.opponent_id ? null : body.opponent_name ?? null,
        body.court_id ?? null,
        body.surface,
        // Pass the raw array: postgres.js detects the jsonb param and serializes
        // it itself, so a manual JSON.stringify here would double-encode it.
        body.score_array,
        analysis.result,
        analysis.setsWon,
        analysis.setsLost,
        analysis.gamesWon,
        analysis.gamesLost,
        body.rpe_index ?? null,
        body.duration_minutes ?? null,
        body.notes ?? null,
        isTiebreak,
        playedAt,
        verificationStatus,
        body.title ?? null,
        body.photo_url ?? null,
        body.client_key ?? null,
      ],
    );
    const id = inserted.rows[0]!.id;

    if (matchPhotoPath) {
      await client.query(
        `DELETE FROM media_object_cleanup_jobs
          WHERE object_path = $1 AND auth_id = $2 AND reason = 'draft'`,
        [matchPhotoPath, authUid(c)],
      );
    }

    if (body.stats) {
      const s = fullStats(body.stats);
      await client.query(
        `INSERT INTO match_stats (match_id, ${STAT_KEYS.join(', ')})
         VALUES ($1, ${STAT_KEYS.map((_, i) => `$${i + 2}`).join(', ')})`,
        [id, ...STAT_KEYS.map((k) => s[k])],
      );
    }

    // Pending matches apply no effects yet — they kick in when the opponent
    // verifies. Auto matches (no registered opponent) count immediately.
    // A pending registered result reserves the accepted schedule until the
    // invited player verifies it. An off-app result counts automatically, so
    // its schedule can be completed in this same transaction.
    if (scheduled) {
      const linked = scheduled.opponent_id
        ? await client.query<{ id: string }>(
            `UPDATE scheduled_matches SET match_id = $1
              WHERE id = $2 AND status = 'accepted' AND match_id IS NULL
              RETURNING id`,
            [id, scheduled.id],
          )
        : await client.query<{ id: string }>(
            `UPDATE scheduled_matches SET status = 'completed', match_id = $1
              WHERE id = $2 AND status = 'accepted' AND match_id IS NULL
              RETURNING id`,
            [id, scheduled.id],
          );
      if (linked.rows.length !== 1) throw new Error('Scheduled match changed while its result was being logged');
    }

    if (!needsVerification) {
      await applyMatchEffects(client, {
        matchId: id,
        userId,
        gamesWon: analysis.gamesWon,
        gamesLost: analysis.gamesLost,
      });
    }
    return id;
    });
  } catch (err) {
    // Two identical retries can race past the pre-check. Usually the unique
    // client-key index catches the second insert; a scheduled retry instead
    // waits on the schedule lock and sees the first request's binding before it
    // reaches INSERT. In either case, return the durable first result.
    if (body.client_key) {
      const dupe = await queryOne<{ id: string }>(
        'SELECT id FROM matches WHERE user_id = $1 AND client_key = $2',
        [userId, body.client_key],
      );
      if (dupe) return c.json({ match: await fetchMatchCard(dupe.id, userId) }, 200);
    }
    throw err;
  }

  // Post-commit side effects must NOT fail the request (the match is durably
  // committed; a retry would double-log). Each is isolated; the 6-hourly sweep
  // backstops territory. A pending match skips all of these until verified.
  if (!needsVerification) {
    if (body.court_id) {
      try {
        await recomputeAfterMatch({ courtId: body.court_id, loggerUserId: userId, previousControllerId });
      } catch (err) {
        console.error('[matches] territory recompute failed', err instanceof Error ? err.message : err);
      }
    }
    try {
      await evaluateAchievements(userId);
    } catch (err) {
      console.error('[matches] achievement evaluation failed', err instanceof Error ? err.message : err);
    }
  }

  if (needsVerification && body.opponent_id !== userId) {
    // Ask the tagged opponent to confirm the result before it counts — push on,
    // because the logger's ELO/territory hinges on this response.
    await notify({
      userId: body.opponent_id!,
      type: 'match_verify_request',
      title: '🎾 Verify this match',
      body: `@${c.get('user')!.username} logged a match against you. Confirm it to make it count.`,
      data: { matchId },
    }).catch(() => {});
  }

  const card = await fetchMatchCard(matchId, userId);
  return c.json({ match: card }, 201);
});

// Matches awaiting MY confirmation (I'm the tagged opponent). Static path is
// declared before /matches/:id so "pending" isn't swallowed as an :id.
app.get('/api/matches/pending', requireAuth, async (c) => {
  const userId = uid(c);
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.*, ${visibleMatchSocialColumns('$1')} FROM match_feed mf
      WHERE mf.opponent_id = $1 AND mf.verification_status = 'pending'
      ORDER BY mf.created_at DESC LIMIT 50`,
    [userId],
  );
  return c.json({ matches: rows.map(mapMatchCard) });
});

// The tagged opponent confirms (it counts) or rejects (it never counts) a match.
app.post('/api/matches/:id/verify', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const { action } = verifyMatchSchema.parse(await jsonBody(c));
  const verifier = c.get('user')!.username;

  // Lock before reading status or effect inputs. A verification racing a delete
  // must finish first (so delete sees a counted match and reverses its effects),
  // or see no row after delete commits. It can never act on a stale pre-lock
  // snapshot. Concurrent confirm/reject requests serialize on the same row.
  const { match, previousControllerId } = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      user_id: string;
      opponent_id: string | null;
      court_id: string | null;
      games_won: number;
      games_lost: number;
      verification_status: string;
    }>(
      `SELECT user_id, opponent_id, court_id, games_won, games_lost, verification_status
         FROM matches
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Match not found');
    if (locked.opponent_id !== userId) throw ApiError.forbidden('Only the tagged opponent can verify this match');
    if (locked.verification_status !== 'pending') throw ApiError.badRequest('This match has already been resolved');

    if (action === 'reject') {
      await client.query(
        "UPDATE matches SET verification_status = 'rejected', verified_at = now() WHERE id = $1",
        [id],
      );
      // A disputed result does not consume the schedule; release the binding so
      // either participant can log a corrected result later.
      await client.query(
        `UPDATE scheduled_matches SET status = 'accepted', match_id = NULL
          WHERE match_id = $1 AND status IN ('accepted', 'completed')`,
        [id],
      );
      return { match: locked, previousControllerId: null };
    }

    const beforeController = locked.court_id ? await getCourtController(locked.court_id, client) : null;
    await client.query(
      "UPDATE matches SET verification_status = 'verified', verified_at = now() WHERE id = $1",
      [id],
    );
    await applyMatchEffects(client, {
      matchId: id,
      userId: locked.user_id,
      gamesWon: Number(locked.games_won),
      gamesLost: Number(locked.games_lost),
    });
    // Registered schedules become complete only after the pending match and all
    // of its rating/streak effects have committed successfully.
    await client.query(
      "UPDATE scheduled_matches SET status = 'completed' WHERE match_id = $1 AND status = 'accepted'",
      [id],
    );
    return { match: locked, previousControllerId: beforeController };
  });

  if (action === 'reject') {
    await notify({
      userId: match.user_id,
      type: 'match_rejected',
      title: '🚫 Match disputed',
      body: `@${verifier} disputed your logged match, so it won't count.`,
      data: { matchId: id },
    }).catch(() => {});
    return c.json({ match: await fetchMatchCard(id, userId) });
  }

  if (match.court_id) {
    try {
      await recomputeAfterMatch({ courtId: match.court_id, loggerUserId: match.user_id, previousControllerId });
    } catch (err) {
      console.error('[verify] territory recompute failed', err instanceof Error ? err.message : err);
    }
  }
  try {
    await evaluateAchievements(match.user_id);
  } catch (err) {
    console.error('[verify] achievement evaluation failed', err instanceof Error ? err.message : err);
  }

  await notify({
    userId: match.user_id,
    type: 'match_verified',
    title: '✅ Match verified',
    body: `@${verifier} confirmed your match — it now counts.`,
    data: { matchId: id },
  }).catch(() => {});

  return c.json({ match: await fetchMatchCard(id, userId) });
});

type ViewableMatch = Pick<MatchCard, 'user_id' | 'opponent_id' | 'verification_status'>;

/** The match's participants always see it. Everyone else may see only a
 *  counted match and remains subject to the author's privacy + blocks. Keep
 *  this as the single guard for match details and all interaction routes. */
async function assertCanViewMatch(
  match: ViewableMatch,
  viewerId: string | null,
): Promise<void> {
  if (viewerId && (viewerId === match.user_id || viewerId === match.opponent_id)) return;
  // Pending/rejected matches exist only for their participants. Return 404
  // before profile checks so neither direct links nor interactions disclose one.
  if (match.verification_status !== 'auto' && match.verification_status !== 'verified') {
    throw ApiError.notFound('Match not found');
  }
  await assertCanViewContent(match.user_id, viewerId);
  if (match.opponent_id) {
    const opponentAccess = await profileAccess(match.opponent_id, viewerId);
    if (opponentAccess.blocked || opponentAccess.restricted) {
      throw ApiError.notFound('Match not found');
    }
  }
}

/** Participants retain a direct read of their historical shared result, but a
 * tagged opponent may not create new social interaction after either player
 * blocks the other. The owner can still manage their own activity. */
async function assertCanInteractWithMatch(match: ViewableMatch, viewerId: string): Promise<void> {
  await assertCanViewMatch(match, viewerId);
  if (viewerId === match.opponent_id) {
    const access = await profileAccess(match.user_id, viewerId);
    if (access.blocked) throw ApiError.notFound('Match not found');
  }
}

app.get('/api/matches/:id', optionalAuth, async (c) => {
  const viewerId = c.get('user')?.sub ?? null;
  const card = await fetchMatchCard(uuidParam(c), viewerId);
  if (!card) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(card, viewerId);
  return c.json({ match: card });
});

app.delete('/api/matches/:id', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);

  // Lock first and derive `counted` from the locked row. If verification won the
  // race, deletion sees `verified` and recomputes ratings after removing it. If
  // deletion won, verification sees no row. Neither path can leave stale effects.
  const { counted, courtId, previousControllerId } = await withTransaction(async (client) => {
    const { rows } = await client.query<{
      user_id: string;
      court_id: string | null;
      verification_status: string;
    }>(
      `SELECT user_id, court_id, verification_status
         FROM matches
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Match not found');
    if (locked.user_id !== userId) throw ApiError.forbidden('You can only delete your own matches');

    const isCounted = locked.verification_status === 'auto' || locked.verification_status === 'verified';
    const beforeController = isCounted && locked.court_id ? await getCourtController(locked.court_id, client) : null;

    // Keep schedule lifecycle constraints and cards coherent. Removing the
    // result reopens a completed schedule, while a pending binding simply clears.
    await client.query(
      `UPDATE scheduled_matches
          SET status = CASE WHEN status = 'completed' THEN 'accepted'::schedule_status ELSE status END,
              match_id = NULL
        WHERE match_id = $1`,
      [id],
    );
    await client.query('DELETE FROM matches WHERE id = $1', [id]);
    // Ratings are recomputed from the remaining history (exact), not delta-reversed.
    if (isCounted) await recomputeUserRatings(client, userId);
    await recomputeUserStreak(userId, client);
    return { counted: isCounted, courtId: locked.court_id, previousControllerId: beforeController };
  });

  if (counted && courtId) {
    // Post-commit side effect: the row is already gone, so a recompute failure
    // must not turn a successful delete into a 500 (the 6-hourly sweep is the
    // backstop) — same isolation as create/verify.
    try {
      await recomputeAfterMatch({ courtId, loggerUserId: userId, previousControllerId });
    } catch (err) {
      console.error('post-delete territory recompute failed', err);
    }
  }
  return c.body(null, 204);
});

app.post('/api/matches/:id/kudos', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const match = await queryOne<ViewableMatch>(
    'SELECT user_id, opponent_id, verification_status FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');
  await assertCanInteractWithMatch(match, userId);

  const inserted = await queryOne<{ id: string }>(
    'INSERT INTO kudos (match_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
    [id, userId],
  );
  const countRow = await queryOne<{ c: string }>(
    `SELECT COUNT(*) AS c FROM kudos k
      WHERE k.match_id = $1 AND ${mutuallyVisibleCondition('$2', 'k.user_id')}`,
    [id, userId],
  );

  if (inserted && match.user_id !== userId) {
    await notify({
      userId: match.user_id,
      type: 'kudos',
      title: '🎾 New kudos',
      body: `${c.get('user')!.username} gave your match kudos.`,
      data: { matchId: id },
      push: false,
    }).catch(() => {});
  }
  return c.json({ kudos_count: Number(countRow?.c ?? 0), viewer_has_kudos: true });
});

app.delete('/api/matches/:id/kudos', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const match = await queryOne<ViewableMatch>(
    'SELECT user_id, opponent_id, verification_status FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(match, userId);
  await query('DELETE FROM kudos WHERE match_id = $1 AND user_id = $2', [id, userId]);
  const countRow = await queryOne<{ c: string }>(
    `SELECT COUNT(*) AS c FROM kudos k
      WHERE k.match_id = $1 AND ${mutuallyVisibleCondition('$2', 'k.user_id')}`,
    [id, userId],
  );
  return c.json({ kudos_count: Number(countRow?.c ?? 0), viewer_has_kudos: false });
});

app.get('/api/matches/:id/comments', optionalAuth, async (c) => {
  const id = uuidParam(c);
  const parent = await queryOne<ViewableMatch>(
    'SELECT user_id, opponent_id, verification_status FROM matches WHERE id = $1', [id]);
  if (!parent) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(parent, c.get('user')?.sub ?? null);
  const { limit, before } = commentsQuerySchema.parse(c.req.query());
  const viewerId = c.get('user')?.sub ?? null;
  const params: unknown[] = [id, viewerId];
  let extra = '';
  if (before) {
    // Composite "<ISO>~<uuid>" keyset cursor — a timestamp alone would
    // drop/duplicate rows on created_at ties. Both halves are validated here:
    // a malformed uuid must be a 400, not a Postgres 22P02 surfacing as a 500.
    const [ts, cid] = before.split('~');
    if (Number.isNaN(Date.parse(ts)) || !cid || !UUID_RE.test(cid)) {
      throw ApiError.badRequest('Invalid pagination cursor');
    }
    params.push(ts, cid);
    extra = `AND (c.created_at, c.id) < ($3::timestamptz, $4::uuid)`;
  }
  params.push(limit);
  const rows = await query<{ id: string; created_at: string }>(
    `SELECT c.id, c.body, c.created_at, c.user_id,
            u.username, u.display_name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.match_id = $1
        AND ${mutuallyVisibleCondition('$2', 'c.user_id')}
        ${extra}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  return c.json({
    comments: rows.slice().reverse(),
    next_cursor: last ? `${new Date(last.created_at).toISOString()}~${last.id}` : null,
  });
});

app.post('/api/matches/:id/comments', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const match = await queryOne<ViewableMatch>(
    'SELECT user_id, opponent_id, verification_status FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');
  await assertCanInteractWithMatch(match, userId);
  const { body } = commentSchema.parse(await jsonBody(c));

  const comment = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('comment-create:' || $1, 0))", [userId]);
    const recentComments = await client.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM comments
        WHERE user_id = $1 AND created_at >= clock_timestamp() - interval '24 hours'`,
      [userId],
    );
    if (Number(recentComments.rows[0]?.c ?? 0) >= DAILY_COMMENT_CAP) {
      throw ApiError.tooManyRequests('Daily comment limit reached; try again later');
    }
    const inserted = await client.query(
      `WITH inserted AS (
         INSERT INTO comments (match_id, user_id, body) VALUES ($1, $2, $3) RETURNING *
       )
       SELECT i.id, i.body, i.created_at, i.user_id, u.username, u.display_name, u.avatar_url
         FROM inserted i JOIN users u ON u.id = i.user_id`,
      [id, userId, body],
    );
    return inserted.rows[0] ?? null;
  });

  if (match.user_id !== userId) {
    await notify({
      userId: match.user_id,
      type: 'comment',
      title: '💬 New comment',
      body: `${c.get('user')!.username} commented on your match.`,
      data: { matchId: id },
      push: false,
    }).catch(() => {});
  }
  return c.json({ comment }, 201);
});

// ─── Scheduled matches ───────────────────────────────────────────────────
const SCHEDULED_SELECT = `
  SELECT s.id, s.creator_id, s.opponent_id, s.opponent_name, s.court_id, s.surface,
         s.scheduled_at, s.note, s.status, s.is_challenge, s.match_id, s.created_at,
         cu.username AS creator_username, cu.display_name AS creator_display_name, cu.avatar_url AS creator_avatar_url,
         ou.username AS opponent_username, ou.display_name AS opponent_display_name, ou.avatar_url AS opponent_avatar_url,
         c.name AS court_name,
         m.score_array AS result_score, m.user_id AS result_logged_by
    FROM scheduled_matches s
    JOIN users cu ON cu.id = s.creator_id
    LEFT JOIN users ou ON ou.id = s.opponent_id
    LEFT JOIN courts c ON c.id = s.court_id
    LEFT JOIN matches m ON m.id = s.match_id`;

async function fetchScheduledMatch(id: string, viewerId: string) {
  const row = await queryOne<Record<string, unknown>>(`${SCHEDULED_SELECT} WHERE s.id = $1`, [id]);
  return row ? mapScheduledMatch(row, viewerId) : null;
}

app.get('/api/scheduled-matches', requireAuth, async (c) => {
  const userId = uid(c);
  const rows = await query<Record<string, unknown>>(
    `${SCHEDULED_SELECT}
      WHERE (s.creator_id = $1 OR s.opponent_id = $1)
        AND ${mutuallyVisibleCondition(
          '$1',
          'CASE WHEN s.creator_id = $1 THEN s.opponent_id ELSE s.creator_id END',
        )}
      ORDER BY s.scheduled_at DESC LIMIT 100`,
    [userId],
  );
  return c.json({ scheduled_matches: rows.map((r) => mapScheduledMatch(r, userId)) });
});

app.post('/api/scheduled-matches', requireAuth, async (c) => {
  const userId = uid(c);
  const b = createScheduledMatchSchema.parse(await jsonBody(c));
  if (b.opponent_id === userId) throw ApiError.badRequest('You cannot schedule a match against yourself');

  if (b.client_key) {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM scheduled_matches WHERE creator_id = $1 AND client_key = $2',
      [userId, b.client_key],
    );
    if (existing) {
      return c.json({ scheduled_match: await fetchScheduledMatch(existing.id, userId) }, 200);
    }
  }

  // A proposal to a Vollo player needs their acceptance; an off-app opponent is
  // just a personal plan, so it starts accepted. A challenge only makes sense
  // against a registered player.
  const status = b.opponent_id ? 'proposed' : 'accepted';
  const isChallenge = !!b.is_challenge && !!b.opponent_id;
  let scheduledId: string;
  try {
    scheduledId = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('schedule-create:' || $1, 0))", [userId]);
    if (b.client_key) {
      const duplicate = await client.query<{ id: string }>(
        'SELECT id FROM scheduled_matches WHERE creator_id = $1 AND client_key = $2',
        [userId, b.client_key],
      );
      if (duplicate.rows.length > 0) throw new Error('idempotent schedule retry');
    }
    const recentSchedules = await client.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM scheduled_matches
        WHERE creator_id = $1 AND created_at >= clock_timestamp() - interval '24 hours'`,
      [userId],
    );
    if (Number(recentSchedules.rows[0]?.c ?? 0) >= DAILY_SCHEDULE_CAP) {
      throw ApiError.tooManyRequests('Daily scheduling limit reached; try again later');
    }
    if (b.opponent_id) {
      await lockSocialPair(client, userId, b.opponent_id);
      if (await socialPairIsBlocked(client, userId, b.opponent_id)) {
        throw ApiError.notFound('User not found');
      }
      const open = await client.query<{ c: string }>(
        `SELECT COUNT(*) AS c FROM scheduled_matches
          WHERE creator_id = $1 AND opponent_id = $2 AND status = 'proposed'`,
        [userId, b.opponent_id],
      );
      if (Number(open.rows[0]?.c ?? 0) >= 3) {
        throw ApiError.tooManyRequests('You already have open proposals with this player — wait for a response');
      }
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO scheduled_matches
         (creator_id, opponent_id, opponent_name, court_id, surface, scheduled_at, note, status, is_challenge, client_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [userId, b.opponent_id ?? null, b.opponent_id ? null : b.opponent_name ?? null, b.court_id ?? null, b.surface ?? null, b.scheduled_at, b.note ?? null, status, isChallenge, b.client_key ?? null],
    );
    return inserted.rows[0]!.id;
    });
  } catch (error) {
    // Two retries can race past the fast pre-check. The unique index chooses
    // one durable proposal; the loser returns it and sends no second push.
    if (b.client_key) {
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM scheduled_matches WHERE creator_id = $1 AND client_key = $2',
        [userId, b.client_key],
      );
      if (existing) {
        return c.json({ scheduled_match: await fetchScheduledMatch(existing.id, userId) }, 200);
      }
    }
    throw error;
  }
  const card = await fetchScheduledMatch(scheduledId, userId);

  if (b.opponent_id) {
    await notify({
      userId: b.opponent_id,
      type: isChallenge ? 'challenge' : 'match_scheduled',
      title: isChallenge ? '⚔️ You’ve been challenged' : '📅 Match proposed',
      body: isChallenge
        ? `${c.get('user')!.username} challenged you to a match. Accept to lock it in.`
        : `${c.get('user')!.username} wants to play you. Tap to respond.`,
      data: { scheduledMatchId: scheduledId },
      push: isChallenge,
    }).catch(() => {});
  }
  return c.json({ scheduled_match: card }, 201);
});

app.patch('/api/scheduled-matches/:id', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const { action } = updateScheduledMatchSchema.parse(await jsonBody(c));

  const row = await queryOne<{ creator_id: string; opponent_id: string | null; status: string; match_id: string | null }>(
    'SELECT creator_id, opponent_id, status, match_id FROM scheduled_matches WHERE id = $1',
    [id],
  );
  if (!row) throw ApiError.notFound('Scheduled match not found');

  let newStatus: string;
  let notifyUserId: string | null;
  let notifyType: 'schedule_accepted' | 'schedule_declined' | 'schedule_cancelled';
  let notifyBody: string;
  const actor = c.get('user')!.username;

  if (action === 'cancel') {
    if (row.creator_id !== userId && row.opponent_id !== userId) throw ApiError.forbidden('Not your match to cancel');
    if (row.status !== 'proposed' && row.status !== 'accepted') throw ApiError.badRequest('This match can no longer be cancelled');
    if (row.match_id) throw ApiError.badRequest('A result has already been logged for this scheduled match');
    newStatus = 'cancelled';
    notifyUserId = userId === row.creator_id ? row.opponent_id : row.creator_id;
    notifyType = 'schedule_cancelled';
    notifyBody = `${actor} cancelled your scheduled match.`;
  } else {
    // Only the invited player can accept or decline a proposal.
    if (row.opponent_id !== userId) throw ApiError.forbidden('Only the invited player can respond');
    if (row.status !== 'proposed') throw ApiError.badRequest('This proposal has already been answered');
    newStatus = action === 'accept' ? 'accepted' : 'declined';
    notifyUserId = row.creator_id;
    notifyType = action === 'accept' ? 'schedule_accepted' : 'schedule_declined';
    notifyBody = action === 'accept' ? `${actor} accepted your match. Game on!` : `${actor} declined your match.`;
  }

  // Status-guarded so concurrent responses (accept vs cancel double-tap) can't
  // both proceed — only the request that flips the status off its expected
  // value wins; the loser gets the same "already answered" error as a late tap.
  const expected = action === 'cancel' ? ['proposed', 'accepted'] : ['proposed'];
  const updated = await query<{ id: string }>(
    'UPDATE scheduled_matches SET status = $1 WHERE id = $2 AND status = ANY($3) AND match_id IS NULL RETURNING id',
    [newStatus, id, expected],
  );
  if (updated.length === 0) {
    throw ApiError.badRequest(
      action === 'cancel' ? 'This match can no longer be cancelled' : 'This proposal has already been answered',
    );
  }
  if (notifyUserId) {
    await notify({
      userId: notifyUserId,
      type: notifyType,
      title: action === 'cancel' ? '🗓️ Match cancelled' : action === 'accept' ? '✅ Match accepted' : '❌ Match declined',
      body: notifyBody,
      data: { scheduledMatchId: id },
      push: false,
    }).catch(() => {});
  }
  return c.json({ scheduled_match: await fetchScheduledMatch(id, userId) });
});

// ─── Clubs ───────────────────────────────────────────────────────────────
// Open groups with a shared feed and a 30-day member leaderboard. Joining is
// instant (no approval); the creator is the first admin.
const CLUB_SELECT = `
  SELECT c.id, c.name, c.description, c.city,
         CASE WHEN c.creator_id IS NULL OR ${mutuallyVisibleCondition('$1', 'c.creator_id')}
              THEN c.creator_id ELSE NULL END AS creator_id,
         c.created_at,
         (SELECT COUNT(*) FROM club_members m
           WHERE m.club_id = c.id AND ${mutuallyVisibleCondition('$1', 'm.user_id')}) AS member_count,
         CASE WHEN $1::uuid IS NULL THEN false
              ELSE EXISTS(SELECT 1 FROM club_members m WHERE m.club_id = c.id AND m.user_id = $1)
         END AS viewer_is_member
    FROM clubs c`;

function mapClub(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    creator_id: (r.creator_id as string | null) ?? null,
    member_count: Number(r.member_count ?? 0),
    viewer_is_member: Boolean(r.viewer_is_member),
    created_at: toIso(r.created_at),
  };
}

app.get('/api/clubs/mine', requireAuth, async (c) => {
  const userId = uid(c);
  const rows = await query<Record<string, unknown>>(
    `${CLUB_SELECT}
      JOIN club_members me ON me.club_id = c.id AND me.user_id = $1
     ORDER BY me.joined_at DESC LIMIT 100`,
    [userId],
  );
  return c.json({ clubs: rows.map(mapClub) });
});

app.get('/api/clubs', optionalAuth, async (c) => {
  const { q, limit } = clubsQuerySchema.parse(c.req.query());
  const viewerId = c.get('user')?.sub ?? null;
  const params: unknown[] = [viewerId];
  let where = '';
  if (q) {
    params.push(escapeLike(q));
    where = `WHERE c.name ILIKE '%' || $2 || '%' OR c.city ILIKE '%' || $2 || '%'`;
  }
  params.push(limit);
  const rows = await query<Record<string, unknown>>(
    `${CLUB_SELECT} ${where}
     ORDER BY member_count DESC, c.created_at ASC
     LIMIT $${params.length}`,
    params,
  );
  return c.json({ clubs: rows.map(mapClub) });
});

// Anti-abuse backstop for user-generated public entities (clubs, courts). Both
// rank in search / render on everyone's map, so one scripted account must not be
// able to flood them — the global IP limiter alone is not enough (an account can
// pace itself under it). Idempotent client_key replays are counted, so a retrying
// client never trips this; only genuinely distinct creations do.
async function assertUnderDailyCreationCap(
  table: 'clubs' | 'courts',
  creatorCol: 'creator_id' | 'created_by',
  userId: string,
  cap: number,
  message: string,
): Promise<void> {
  const recent = await queryOne<{ c: string }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE ${creatorCol} = $1 AND created_at > now() - interval '24 hours'`,
    [userId],
  );
  if (Number(recent?.c ?? 0) >= cap) throw ApiError.tooManyRequests(message);
}

app.post('/api/clubs', requireAuth, async (c) => {
  const userId = uid(c);
  const b = createClubSchema.parse(await jsonBody(c));
  const existing = b.client_key
    ? await queryOne<{ id: string }>(
        'SELECT id FROM clubs WHERE creator_id = $1 AND client_key = $2',
        [userId, b.client_key],
      )
    : null;
  if (existing) {
    const row = await queryOne<Record<string, unknown>>(`${CLUB_SELECT} WHERE c.id = $2`, [userId, existing.id]);
    return c.json({ club: mapClub(row!) });
  }
  await assertUnderDailyCreationCap('clubs', 'creator_id', userId, 20, 'You have created too many clubs today; try again tomorrow');

  let clubId: string;
  let created = true;
  try {
    clubId = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO clubs (name, description, city, creator_id, client_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [b.name, b.description ?? null, b.city ?? null, userId, b.client_key ?? null],
      );
      const id = inserted.rows[0]!.id;
      await client.query(
        "INSERT INTO club_members (club_id, user_id, role) VALUES ($1, $2, 'admin')",
        [id, userId],
      );
      return id;
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      const raced = b.client_key
        ? await queryOne<{ id: string }>(
            'SELECT id FROM clubs WHERE creator_id = $1 AND client_key = $2',
            [userId, b.client_key],
          )
        : null;
      if (!raced) throw new ApiError(409, 'conflict', 'A club with this name already exists');
      clubId = raced.id;
      created = false;
    } else {
      throw err;
    }
  }
  const row = await queryOne<Record<string, unknown>>(`${CLUB_SELECT} WHERE c.id = $2`, [userId, clubId]);
  return created ? c.json({ club: mapClub(row!) }, 201) : c.json({ club: mapClub(row!) });
});

app.get('/api/clubs/:id', optionalAuth, async (c) => {
  const viewerId = c.get('user')?.sub ?? null;
  const id = uuidParam(c);
  const row = await queryOne<Record<string, unknown>>(`${CLUB_SELECT} WHERE c.id = $2`, [viewerId, id]);
  if (!row) throw ApiError.notFound('Club not found');
  const members = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, m.role::text AS role, m.joined_at
       FROM club_members m JOIN users u ON u.id = m.user_id
      WHERE m.club_id = $1
        AND ${mutuallyVisibleCondition('$2', 'm.user_id')}
      ORDER BY m.role ASC, m.joined_at ASC
      LIMIT 50`,
    [id, viewerId],
  );
  return c.json({ club: mapClub(row), members });
});

app.post('/api/clubs/:id/join', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  const club = await queryOne<{ id: string }>('SELECT id FROM clubs WHERE id = $1', [id]);
  if (!club) throw ApiError.notFound('Club not found');
  await query(
    'INSERT INTO club_members (club_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [id, userId],
  );
  return c.json({ ok: true }, 201);
});

/**
 * Remove a member and keep the club consistent: promote the longest-standing
 * member if no admin remains, dissolve the club if nobody remains. The
 * `FOR UPDATE` lock on the club row serialises concurrent leaves — without it,
 * two admins leaving at once each see the other's uncommitted row and both
 * skip promotion, stranding the club admin-less.
 */
async function leaveClub(client: Queryable, clubId: string, userId: string): Promise<void> {
  await client.query('SELECT id FROM clubs WHERE id = $1 FOR UPDATE', [clubId]);
  const removed = await client.query<{ user_id: string }>(
    'DELETE FROM club_members WHERE club_id = $1 AND user_id = $2 RETURNING user_id',
    [clubId, userId],
  );
  if (removed.rows.length === 0) return; // wasn't a member — nothing to do
  const remaining = await client.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM club_members WHERE club_id = $1',
    [clubId],
  );
  if (Number(remaining.rows[0]!.n) === 0) {
    await client.query('DELETE FROM clubs WHERE id = $1', [clubId]);
    return;
  }
  const admins = await client.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM club_members WHERE club_id = $1 AND role = 'admin'",
    [clubId],
  );
  if (Number(admins.rows[0]!.n) === 0) {
    await client.query(
      `UPDATE club_members SET role = 'admin'
        WHERE club_id = $1 AND user_id = (
          SELECT user_id FROM club_members WHERE club_id = $1 ORDER BY joined_at ASC LIMIT 1
        )`,
      [clubId],
    );
  }
}

app.delete('/api/clubs/:id/join', requireAuth, async (c) => {
  const userId = uid(c);
  const id = uuidParam(c);
  await withTransaction((client) => leaveClub(client, id, userId));
  return c.body(null, 204);
});

// 30-day member leaderboard — same trailing window and counted-only rule as
// court leaderboards, ranked by summed MatchScore.
app.get('/api/clubs/:id/leaderboard', optionalAuth, async (c) => {
  const id = uuidParam(c);
  const viewerId = c.get('user')?.sub ?? null;
  const club = await queryOne<{ id: string }>('SELECT id FROM clubs WHERE id = $1', [id]);
  if (!club) throw ApiError.notFound('Club not found');
  // This competitive surface follows the explicit show_competitive setting;
  // blocks still remove entries from the viewer's board.
  const visibility = userVisibilityConditions('$2', 'cm.user_id').join(' AND ');
  const rows = await query<Record<string, unknown>>(
    `SELECT u.id AS user_id, u.username, u.display_name, u.avatar_url,
            COUNT(m.id) AS matches_played,
            COUNT(m.id) FILTER (WHERE m.result = 'win') AS wins,
            COALESCE(SUM(m.match_score), 0) AS score
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN matches m ON m.user_id = cm.user_id
        AND m.verification_status IN ('auto','verified')
        AND m.played_at > now() - interval '30 days'
      WHERE cm.club_id = $1 AND ${visibility}
      GROUP BY u.id, u.username, u.display_name, u.avatar_url
      ORDER BY score DESC, matches_played DESC, u.username ASC
      LIMIT 100`,
    [id, viewerId],
  );
  return c.json({
    leaderboard: rows.map((r, i) => ({
      user_id: r.user_id as string,
      username: r.username as string,
      display_name: r.display_name as string,
      avatar_url: (r.avatar_url as string | null) ?? null,
      matches_played: Number(r.matches_played),
      wins: Number(r.wins),
      score: Number(r.score),
      rank: i + 1,
    })),
  });
});

// The club's shared feed: members' matches, still subject to each author's
// privacy and the viewer's blocks (a private member stays private here).
app.get('/api/clubs/:id/feed', optionalAuth, async (c) => {
  const { limit, before } = feedQuerySchema.parse(c.req.query());
  const viewerId = c.get('user')?.sub ?? null;
  const id = uuidParam(c);
  const club = await queryOne<{ id: string }>('SELECT id FROM clubs WHERE id = $1', [id]);
  if (!club) throw ApiError.notFound('Club not found');

  const conditions = [
    `mf.user_id IN (SELECT user_id FROM club_members WHERE club_id = $2)`,
    ...matchVisibilityConditions('$1', 'mf.user_id'),
    matchStatusCondition('$1'),
  ];
  const params: unknown[] = [viewerId, id];
  let p = params.length;
  if (before) {
    const cursor = decodeCursor(before);
    params.push(cursor.t, cursor.id);
    conditions.push(`(mf.played_at, mf.id) < ($${++p}::timestamptz, $${++p}::uuid)`);
  }
  params.push(limit + 1);
  const limitIdx = ++p;
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.*,
            ${visibleMatchSocialColumns('$1')},
            CASE WHEN $1::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
            END AS viewer_has_kudos
       FROM match_feed mf
      WHERE ${conditions.join(' AND ')}
      ORDER BY mf.played_at DESC, mf.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  const hasMore = rows.length > limit;
  const matches = rows.slice(0, limit).map(mapMatchCard);
  return c.json({ matches, next_cursor: nextCursor(matches, hasMore) });
});

// ─── Courts ────────────────────────────────────────────────────────────────
const COURT_COLS = `id, name, description, surface, ST_Y(geom) AS lat, ST_X(geom) AS lng,
                    address, city, osm_id, source, sector_key, court_count, created_by, created_at`;

app.get('/api/courts/geocode', requireAuth, async (c) => {
  if (!geocodeLimiterFn(clientIp(c))) throw ApiError.tooManyRequests();
  const { q, limit } = geocodeQuerySchema.parse(c.req.query());
  try {
    const results = await geocode(q, limit);
    return c.json({ results });
  } catch (err) {
    if (err instanceof GeocoderBusyError) {
      throw rateLimitError('Address lookup is busy, please retry shortly', err.retryAfterSeconds);
    }
    console.warn('[geocode] provider error', err instanceof Error ? err.message : err);
    throw new ApiError(502, 'geocode_failed', 'Address lookup is temporarily unavailable');
  }
});

// ─── Court discovery: import real-world courts from OpenStreetMap ───────────
// Viewports snap to coarse cells before hashing. Freshness and in-flight work
// live in Postgres so every Edge isolate observes the same lease.
function discoverCellKey(b: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }): string {
  const snap = (x: number) => Math.round(x / 0.05) * 0.05;
  return [snap(b.min_lng), snap(b.min_lat), snap(b.max_lng), snap(b.max_lat)].map((n) => n.toFixed(2)).join(',');
}

async function discoverCellHash(
  b: { min_lng: number; min_lat: number; max_lng: number; max_lat: number },
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`overpass:${discoverCellKey(b)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Atomically claim one viewport and pace Overpass starts across the fleet. */
async function claimDiscoveryCell(cellKey: string): Promise<boolean> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO court_discovery_cells (cell_key)
       VALUES ($1)
       ON CONFLICT (cell_key) DO NOTHING`,
      [cellKey],
    );

    const { rows: claimed } = await client.query<{ cell_key: string }>(
      `UPDATE court_discovery_cells
          SET locked_until = clock_timestamp() + interval '3 minutes',
              updated_at = clock_timestamp()
        WHERE cell_key = $1
          AND next_refresh_at <= clock_timestamp()
          AND (locked_until IS NULL OR locked_until <= clock_timestamp())
       RETURNING cell_key`,
      [cellKey],
    );
    if (claimed.length === 0) return false;

    const { rows: providerLease } = await client.query<{ service: string }>(
      `INSERT INTO outbound_service_limits (service, last_started_at)
       VALUES ('overpass', clock_timestamp())
       ON CONFLICT (service) DO UPDATE
         SET last_started_at = EXCLUDED.last_started_at
       WHERE outbound_service_limits.last_started_at
               <= clock_timestamp() - interval '10 seconds'
       RETURNING service`,
    );
    if (providerLease.length > 0) return true;

    // Another viewport just started. Release this cell and apply a small retry
    // delay so a busy map does not turn provider pacing into a database spin.
    await client.query(
      `UPDATE court_discovery_cells
          SET next_refresh_at = GREATEST(next_refresh_at, clock_timestamp() + interval '10 seconds'),
              locked_until = NULL,
              updated_at = clock_timestamp()
        WHERE cell_key = $1`,
      [cellKey],
    );
    return false;
  });
}

async function finishDiscoveryCell(cellKey: string, succeeded: boolean): Promise<void> {
  await query(
    `UPDATE court_discovery_cells
        SET next_refresh_at = clock_timestamp()
              + CASE WHEN $2::boolean THEN interval '15 minutes' ELSE interval '2 minutes' END,
            locked_until = NULL,
            updated_at = clock_timestamp()
      WHERE cell_key = $1`,
    [cellKey, succeeded],
  );
}

// A name OSM gave us no facility for — formatName() fell back to a bare
// "Tennis Court(s)". These are the courts we try to name by neighbourhood.
const GENERIC_COURT_NAME = /^Tennis Courts?$/;

// Cap how many anonymous sectors we reverse-geocode per import so a dense
// viewport can't fan out dozens of Nominatim calls (its policy is ~1 req/s).
const NEIGHBORHOOD_ENRICH_MAX = 6;
const NOMINATIM_SPACING_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Give anonymous OSM courts a human name from their neighbourhood — e.g. a bare
 * "Tennis Courts" sitting in the Red Hawk neighbourhood becomes "Red Hawk
 * Courts". Mutates the sectors in place; best-effort and bounded so it never
 * blocks discovery for long. Runs BEFORE the upsert so the better name is what
 * gets stored (and what re-imports keep, via the upsert's generic-name guard).
 */
async function enrichSectorNames(sectors: OverpassSector[]): Promise<void> {
  // Public Nominatim permits user-triggered lookups, not systematic reverse
  // geocoding of imported OSM features. Automated naming requires Geoapify.
  if (!allowsAutomatedGeocoding()) return;
  const anon = sectors.filter((s) => GENERIC_COURT_NAME.test(s.name)).slice(0, NEIGHBORHOOD_ENRICH_MAX);
  for (let i = 0; i < anon.length; i++) {
    const s = anon[i]!;
    try {
      const rg = await reverseGeocode(s.lat, s.lng);
      const place = rg?.neighborhood ?? rg?.city ?? s.city;
      if (place) {
        const suffix = s.court_count > 1 ? 'Courts' : 'Court';
        s.name = `${place} ${suffix}`.slice(0, 118);
      }
    } catch {
      /* keep the generic name */
    }
    if (i < anon.length - 1) await sleep(NOMINATIM_SPACING_MS); // respect Nominatim's rate policy
  }
}

async function importOverpassCourts(b: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }): Promise<number> {
  const sectors = await fetchOverpassSectors({ minLng: b.min_lng, minLat: b.min_lat, maxLng: b.max_lng, maxLat: b.max_lat });
  if (sectors.length === 0) return 0;
  await enrichSectorNames(sectors);
  let imported = 0;
  const CHUNK = 50;
  for (let i = 0; i < sectors.length; i += CHUNK) {
    const chunk = sectors.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const s of chunk) {
      values.push(
        `($${++p}, $${++p}, ST_SetSRID(ST_MakePoint($${++p}, $${++p}), 4326), $${++p}, $${++p}, 'osm', $${++p}, $${++p})`,
      );
      params.push(s.name, s.surface, s.lng, s.lat, s.city, s.osm_id, s.sector_key, s.court_count);
    }
    // Upsert on sector_key (one row per facility). DO UPDATE so re-imports
    // self-heal names/counts as OSM improves — re-imports are otherwise free.
    const rows = await query<{ id: string }>(
      `INSERT INTO courts (name, surface, geom, city, osm_id, source, sector_key, court_count)
       VALUES ${values.join(', ')}
       ON CONFLICT (sector_key) WHERE sector_key IS NOT NULL DO UPDATE SET
         -- Never let a later import regress a real/neighbourhood-enriched name
         -- back to a bare "Tennis Court(s)" (Overpass/Nominatim can flap).
         name        = CASE WHEN EXCLUDED.name ~ '^Tennis Courts?$' THEN courts.name ELSE EXCLUDED.name END,
         surface     = EXCLUDED.surface,
         geom        = EXCLUDED.geom,
         city        = COALESCE(EXCLUDED.city, courts.city),
         osm_id      = COALESCE(EXCLUDED.osm_id, courts.osm_id),
         court_count = EXCLUDED.court_count
       RETURNING id`,
      params,
    );
    imported += rows.length;
  }
  return imported;
}

async function courtsInBbox(b: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }) {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${COURT_COLS} FROM courts
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ORDER BY court_count DESC, created_at DESC
      LIMIT 400`,
    [b.min_lng, b.min_lat, b.max_lng, b.max_lat],
  );
  return rows.map(mapCourt);
}

app.get('/api/courts/discover', requireAuth, async (c) => {
  if (!discoverLimiterFn(clientIp(c))) throw ApiError.tooManyRequests();
  const b = discoverQuerySchema.parse(c.req.query());
  if (b.min_lng >= b.max_lng || b.min_lat >= b.max_lat) throw ApiError.badRequest('min must be < max for both axes');

  // `import=0` is the client's instant first paint: return whatever courts are
  // already in the DB without touching the (slow) Overpass network. The client
  // then re-requests with import=1 in the background to pull in new courts, so
  // the map never blocks on discovery.
  if (b.import) {
    // Only reach out to Overpass when the viewport is reasonably zoomed in;
    // importing a whole region on every pan would be wasteful and the
    // container-geometry payload grows quickly. Wider viewports still return
    // whatever courts already live in the DB.
    const spanLng = b.max_lng - b.min_lng;
    const spanLat = b.max_lat - b.min_lat;
    if (spanLng <= 0.35 && spanLat <= 0.35) {
      const key = await discoverCellHash(b);
      if (await claimDiscoveryCell(key)) {
        let succeeded = false;
        try {
          await importOverpassCourts(b);
          succeeded = true;
        } catch (err) {
          console.warn('[discover] overpass import failed', err instanceof Error ? err.message : err);
        } finally {
          try {
            await finishDiscoveryCell(key, succeeded);
          } catch (err) {
            // The three-minute claim expires by itself if this best-effort
            // bookkeeping fails, so discovery cannot remain permanently stuck.
            console.warn('[discover] could not release cell lease', err instanceof Error ? err.message : err);
          }
        }
      }
    }
  }

  return c.json({ courts: await courtsInBbox(b) });
});

app.get('/api/courts/reverse-geocode', requireAuth, async (c) => {
  if (!geocodeLimiterFn(clientIp(c))) throw ApiError.tooManyRequests();
  const { lat, lng } = reverseGeocodeQuerySchema.parse(c.req.query());
  try {
    return c.json({ result: await reverseGeocode(lat, lng) });
  } catch (err) {
    if (err instanceof GeocoderBusyError) {
      throw rateLimitError('Address lookup is busy, please retry shortly', err.retryAfterSeconds);
    }
    console.warn('[reverse-geocode] provider error', err instanceof Error ? err.message : err);
    return c.json({ result: null });
  }
});

app.get('/api/courts', async (c) => {
  const { lat, lng, radius_km, q, limit } = courtsQuerySchema.parse(c.req.query());

  if (lat != null && lng != null) {
    const rows = await query<Record<string, unknown>>(
      `SELECT ${COURT_COLS},
              ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)/1000.0 AS distance_km
         FROM courts
        WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
        ORDER BY distance_km ASC
        LIMIT $4`,
      [lng, lat, radius_km * 1000, limit],
    );
    return c.json({ courts: rows.map((r) => ({ ...mapCourt(r), distance_km: Number(r.distance_km) })) });
  }

  if (q) {
    const rows = await query<Record<string, unknown>>(
      `SELECT ${COURT_COLS} FROM courts
        WHERE name ILIKE '%' || $1 || '%' OR city ILIKE '%' || $1 || '%'
        ORDER BY name ASC LIMIT $2`,
      [escapeLike(q), limit],
    );
    return c.json({ courts: rows.map(mapCourt) });
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT ${COURT_COLS} FROM courts ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return c.json({ courts: rows.map(mapCourt) });
});

app.post('/api/courts', requireAuth, async (c) => {
  const b = createCourtSchema.parse(await jsonBody(c));
  const userId = uid(c);
  if (b.client_key) {
    const existing = await queryOne<Record<string, unknown>>(
      `SELECT ${COURT_COLS} FROM courts WHERE created_by = $1 AND client_key = $2`,
      [userId, b.client_key],
    );
    if (existing) return c.json({ court: mapCourt(existing) }, 200);
  }
  await assertUnderDailyCreationCap('courts', 'created_by', userId, 50, 'You have added too many courts today; try again tomorrow');

  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO courts
         (name, description, surface, geom, address, city, osm_id, court_count, created_by, client_key)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8, $9, $10, $11)
       RETURNING ${COURT_COLS}`,
      [b.name, b.description ?? null, b.surface, b.lng, b.lat, b.address ?? null, b.city ?? null, b.osm_id ?? null, b.court_count ?? 1, userId, b.client_key ?? null],
    );
    return c.json({ court: mapCourt(row!) }, 201);
  } catch (error) {
    if (b.client_key) {
      const existing = await queryOne<Record<string, unknown>>(
        `SELECT ${COURT_COLS} FROM courts WHERE created_by = $1 AND client_key = $2`,
        [userId, b.client_key],
      );
      if (existing) return c.json({ court: mapCourt(existing) }, 200);
    }
    throw error;
  }
});

app.get('/api/courts/:id', optionalAuth, async (c) => {
  const id = uuidParam(c);
  const row = await queryOne<Record<string, unknown>>(`SELECT ${COURT_COLS} FROM courts WHERE id = $1`, [id]);
  if (!row) throw ApiError.notFound('Court not found');

  // The controller banner names a player and implies they play here often —
  // hide it from viewers who may not see that player's activity.
  const controllerVisibility = userVisibilityConditions('$2', 'cl.user_id').join(' AND ');
  const controller = await queryOne<{ user_id: string; username: string; display_name: string; score: string }>(
    `SELECT cl.user_id, u.username, u.display_name, cl.score
       FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
      WHERE cl.court_id = $1 AND cl.rank = 1 AND ${controllerVisibility}
      ORDER BY cl.score DESC LIMIT 1`,
    [id, c.get('user')?.sub ?? null],
  );

  return c.json({
    court: mapCourt(row),
    controller: controller
      ? {
          user_id: controller.user_id,
          username: controller.username,
          display_name: controller.display_name,
          score: Number(controller.score),
        }
      : null,
  });
});

app.get('/api/courts/:id/leaderboard', optionalAuth, async (c) => {
  // Rows carry competitive results, so apply the explicit show_competitive
  // setting and symmetric block boundary per entry.
  const visibility = userVisibilityConditions('$2', 'cl.user_id').join(' AND ');
  const rows = await query<Record<string, unknown>>(
    `SELECT cl.court_id, cl.user_id, cl.score, cl.matches_played, cl.wins, cl.losses,
            cl.games_won, cl.games_lost, cl.rank, cl.last_played_at,
            u.username, u.display_name, u.avatar_url
       FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
      WHERE cl.court_id = $1 AND ${visibility}
      ORDER BY cl.rank ASC, cl.score DESC
      LIMIT 100`,
    [uuidParam(c), c.get('user')?.sub ?? null],
  );
  const leaderboard: LeaderboardEntry[] = rows.map((r) => ({
    court_id: r.court_id as string,
    user_id: r.user_id as string,
    username: r.username as string,
    display_name: r.display_name as string,
    avatar_url: (r.avatar_url as string | null) ?? null,
    score: Number(r.score),
    matches_played: Number(r.matches_played),
    wins: Number(r.wins),
    losses: Number(r.losses),
    games_won: Number(r.games_won),
    games_lost: Number(r.games_lost),
    rank: Number(r.rank),
    last_played_at: toIso(r.last_played_at),
  }));
  return c.json({ leaderboard });
});

// ─── Territories ─────────────────────────────────────────────────────────
// A territory hull centred on someone's regular courts is a location proxy, so
// the separate show_competitive toggle controls it explicitly (see Settings).
app.get('/api/territories', optionalAuth, async (c) => {
  const b = bboxQuerySchema.parse(c.req.query());
  const hasBbox = b.min_lng != null && b.min_lat != null && b.max_lng != null && b.max_lat != null;
  const territories = await listTerritories(
    c.get('user')?.sub ?? null,
    hasBbox ? { minLng: b.min_lng!, minLat: b.min_lat!, maxLng: b.max_lng!, maxLat: b.max_lat! } : undefined,
  );
  return c.json({ territories });
});

app.get('/api/territories/user/:userId', optionalAuth, async (c) => {
  const targetId = uuidParam(c, 'userId');
  const viewerId = c.get('user')?.sub ?? null;
  if (viewerId !== targetId) {
    // Same rule as listTerritories: the owner's show_competitive toggle decides
    // (public game board when on, hidden from everyone when off) — never
    // follower-gated. Blocks still 404 so they're not disclosed.
    const access = await profileAccess(targetId, viewerId);
    if (access.blocked) throw ApiError.notFound('User not found');
    const row = await queryOne<{ show_competitive: boolean }>(
      'SELECT show_competitive FROM users WHERE id = $1',
      [targetId],
    );
    if (!row?.show_competitive) return c.json({ territories: [] });
  }
  const territories = await getUserTerritories(targetId);
  return c.json({ territories });
});

// ─── Users / profiles ────────────────────────────────────────────────────
app.patch('/api/users/me', requireAuth, async (c) => {
  const userId = uid(c);
  const b = updateProfileSchema.parse(await jsonBody(c));
  const mediaOwnerId = authUid(c);
  const googleAvatar = b.avatar_url ? isGoogleAvatarUrl(b.avatar_url) : false;
  const avatarMediaPath = b.avatar_url && !googleAvatar
    ? ownedUserMediaPathFromUrl(b.avatar_url, mediaOwnerId, 'avatar')
    : null;
  const coverMediaPath = b.cover_url
    ? ownedUserMediaPathFromUrl(b.cover_url, mediaOwnerId, 'cover')
    : null;
  if (b.avatar_url && !googleAvatar && !avatarMediaPath) {
    throw ApiError.badRequest('Avatar must belong to your Vollo media folder');
  }
  if (b.avatar_url && googleAvatar) {
    // Google-hosted images are accepted only as an exact no-op preservation of
    // the avatar installed by trusted OAuth provisioning. Without this check a
    // modified client could inject any googleusercontent.com tracking image.
    const current = await queryOne<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM users WHERE id = $1',
      [userId],
    );
    if (current?.avatar_url !== b.avatar_url) {
      throw ApiError.badRequest('A Google avatar can only preserve your existing OAuth photo');
    }
  }
  if (b.cover_url && !coverMediaPath) {
    throw ApiError.badRequest('Cover photo must belong to your Vollo media folder');
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (b.display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(b.display_name); }
  if (b.bio !== undefined) { sets.push(`bio = $${i++}`); params.push(b.bio); }
  // null is an explicit clear; undefined means the field was omitted/no-op.
  if (b.avatar_url !== undefined) { sets.push(`avatar_url = $${i++}`); params.push(b.avatar_url); }
  if (b.cover_url !== undefined) { sets.push(`cover_url = $${i++}`); params.push(b.cover_url); }
  if (b.dominant_hand !== undefined) { sets.push(`dominant_hand = $${i++}`); params.push(b.dominant_hand); }
  if (b.is_private !== undefined) { sets.push(`is_private = $${i++}`); params.push(b.is_private); }
  if (b.show_competitive !== undefined) { sets.push(`show_competitive = $${i++}`); params.push(b.show_competitive); }
  if (b.color !== undefined) { sets.push(`color = $${i++}`); params.push(b.color); }
  if (b.home !== undefined) {
    if (b.home === null) {
      sets.push('home_geom = NULL', 'home_label = NULL');
    } else {
      sets.push(`home_geom = ST_SetSRID(ST_MakePoint($${i++}, $${i++}), 4326)`);
      params.push(b.home.lng, b.home.lat);
      sets.push(`home_label = $${i++}`);
      params.push(b.home.label ?? null);
    }
  }
  if (b.equipment !== undefined) {
    // Pass the raw object: postgres.js serializes a jsonb param itself (same
    // convention as score_array), so a manual JSON.stringify would double-encode.
    sets.push(`equipment = $${i++}::jsonb`);
    params.push(b.equipment);
  }

  if (sets.length === 0) {
    const current = await queryOne<Record<string, unknown>>(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [userId]);
    return c.json({ user: mapUser(current!) });
  }

  params.push(userId);
  const row = await withTransaction(async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${USER_SELECT}`,
      params,
    );
    for (const objectPath of [avatarMediaPath, coverMediaPath]) {
      if (objectPath) {
        await client.query(
          `DELETE FROM media_object_cleanup_jobs
            WHERE object_path = $1 AND auth_id = $2 AND reason = 'draft'`,
          [objectPath, mediaOwnerId],
        );
      }
    }
    return rows[0]!;
  });
  return c.json({ user: mapUser(row!) });
});

app.get('/api/users/search', requireAuth, async (c) => {
  const userId = uid(c);
  const { q, limit } = userSearchQuerySchema.parse(c.req.query());
  const users = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_private,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id) AS viewer_is_following,
            EXISTS(SELECT 1 FROM follow_requests r WHERE r.requester_id = $1 AND r.target_id = u.id) AS viewer_has_requested
       FROM users u
      WHERE u.id <> $1
        AND (u.username ILIKE '%' || $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
        -- Blocked players (either direction) are mutually invisible in search.
        AND NOT EXISTS(SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                           OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY (u.username ILIKE $2 || '%' OR u.display_name ILIKE $2 || '%') DESC, u.username ASC
      LIMIT $3`,
    [userId, escapeLike(q), limit],
  );
  return c.json({ users });
});

app.post('/api/users/me/push-token', requireAuth, async (c) => {
  const userId = uid(c);
  const { token, platform } = pushTokenSchema.parse(await jsonBody(c));
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('push-token:' || $1, 0))", [userId]);
    const tokenState = await client.query<{ c: string; already_registered: boolean }>(
      `SELECT COUNT(*) AS c, COALESCE(BOOL_OR(token = $2), false) AS already_registered
         FROM push_tokens WHERE user_id = $1`,
      [userId, token],
    );
    if (!tokenState.rows[0]?.already_registered && Number(tokenState.rows[0]?.c ?? 0) >= PUSH_TOKEN_CAP) {
      throw ApiError.tooManyRequests('Too many devices registered for push notifications');
    }
    await client.query(
      `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, created_at = now()`,
      [userId, token, platform ?? 'expo'],
    );
  });
  return c.json({ ok: true }, 201);
});

// Called on logout so a signed-out device stops receiving this account's
// pushes. Scoped to the caller's own rows — you can't unregister someone
// else's token.
app.delete('/api/users/me/push-token', requireAuth, async (c) => {
  const { token } = pushTokenSchema.parse(await jsonBody(c));
  await query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [uid(c), token]);
  return c.body(null, 204);
});

app.delete('/api/users/me', requireAuth, async (c) => {
  const userId = uid(c);
  const row = await queryOne<{ auth_id: string | null }>('SELECT auth_id FROM users WHERE id = $1', [userId]);
  if (!row) throw ApiError.notFound('User not found');
  if (row.auth_id) {
    // GoTrue reports failures in `error` rather than throwing. No database or
    // media mutation happens before this succeeds, so a retry cannot find a
    // half-deleted account. The auth FK cascade deletes the profile; migration
    // 031 repairs clubs and durably queues its Storage folder in that transaction.
    const { error } = await adminClient.auth.admin.deleteUser(row.auth_id);
    if (error) {
      console.error('[account-delete] auth provider rejected deletion', error.status, error.code);
      throw new ApiError(502, 'account_deletion_failed', 'Account deletion is temporarily unavailable; please try again');
    }
    // Eager best effort for a fast privacy outcome. Storage failures stay queued
    // for maintenance retries, including if this isolate exits after Auth commits.
    await processMediaCleanupJobs(1, row.auth_id);
  } else {
    // Legacy row with no linked auth identity. Database deletion triggers still
    // repair any club from which the profile cascades.
    await query('DELETE FROM users WHERE id = $1', [userId]);
  }
  return c.body(null, 204);
});

// ─── Goals ───────────────────────────────────────────────────────────────
// Personal weekly/monthly targets. Progress is computed on read from counted
// matches in the current period, so verification flips and deletes stay exact.
app.get('/api/users/me/goals', requireAuth, async (c) => {
  const rows = await query<{
    id: string; metric: string; period: string; target: string; created_at: unknown;
    matches: string; wins: string; hours: string;
  }>(
    `SELECT g.id, g.metric::text AS metric, g.period::text AS period, g.target, g.created_at,
            COALESCE(p.matches, 0) AS matches, COALESCE(p.wins, 0) AS wins, COALESCE(p.hours, 0) AS hours
       FROM goals g
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS matches,
                COUNT(*) FILTER (WHERE m.result = 'win') AS wins,
                COALESCE(SUM(m.duration_minutes), 0) / 60.0 AS hours
           FROM matches m
          WHERE m.user_id = g.user_id
            AND m.verification_status IN ('auto','verified')
            AND m.played_at >= CASE WHEN g.period = 'weekly'
                                    THEN date_trunc('week', now())
                                    ELSE date_trunc('month', now()) END
       ) p ON true
      WHERE g.user_id = $1
      ORDER BY g.period ASC, g.metric ASC`,
    [uid(c)],
  );
  const goals = rows.map((r) => ({
    id: r.id,
    metric: r.metric,
    period: r.period,
    target: Number(r.target),
    current:
      r.metric === 'matches' ? Number(r.matches)
      : r.metric === 'wins' ? Number(r.wins)
      : Math.round(Number(r.hours) * 10) / 10,
    created_at: toIso(r.created_at),
  }));
  return c.json({ goals });
});

app.post('/api/users/me/goals', requireAuth, async (c) => {
  const b = setGoalSchema.parse(await jsonBody(c));
  await query(
    `INSERT INTO goals (user_id, metric, period, target) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, metric, period) DO UPDATE SET target = EXCLUDED.target`,
    [uid(c), b.metric, b.period, b.target],
  );
  return c.json({ ok: true }, 201);
});

app.delete('/api/users/me/goals/:id', requireAuth, async (c) => {
  await query('DELETE FROM goals WHERE id = $1 AND user_id = $2', [uuidParam(c), uid(c)]);
  return c.body(null, 204);
});

// ─── Blocking ────────────────────────────────────────────────────────────
// Declared before the /users/:username matchers so "me" is never read as a
// username. A block is one-directional in storage but symmetric in effect.
app.get('/api/users/me/blocks', requireAuth, async (c) => {
  const users = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, b.created_at AS blocked_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1
      ORDER BY b.created_at DESC LIMIT 200`,
    [uid(c)],
  );
  return c.json({ users });
});

app.post('/api/users/:username/block', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  if (targetId === userId) throw ApiError.badRequest('You cannot block yourself');
  await withTransaction(async (client) => {
    await lockSocialPair(client, userId, targetId);
    await client.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, targetId],
    );
    // Blocking severs the relationship in both directions — edges and any
    // pending follow requests.
    await client.query(
      `DELETE FROM follows
        WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)`,
      [userId, targetId],
    );
    await client.query(
      `DELETE FROM follow_requests
        WHERE (requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1)`,
      [userId, targetId],
    );
  });
  return c.json({ ok: true }, 201);
});

app.delete('/api/users/:username/block', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  await withTransaction(async (client) => {
    await lockSocialPair(client, userId, targetId);
    await client.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, targetId]);
  });
  return c.body(null, 204);
});

app.get('/api/users/:username', optionalAuth, async (c) => {
  const viewerId = c.get('user')?.sub ?? null;
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${USER_SELECT},
            (SELECT COUNT(*) FROM matches  WHERE user_id = u.id AND verification_status IN ('auto','verified')) AS match_count,
            (SELECT COUNT(*) FROM follows f
              WHERE f.following_id = u.id AND ${mutuallyVisibleCondition('$2', 'f.follower_id')}) AS follower_count,
            (SELECT COUNT(*) FROM follows f
              WHERE f.follower_id = u.id AND ${mutuallyVisibleCondition('$2', 'f.following_id')}) AS following_count,
            (SELECT COUNT(*) FROM territories WHERE user_id = u.id)   AS territory_count,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id)
            END AS viewer_is_following,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM follow_requests r WHERE r.requester_id = $2 AND r.target_id = u.id)
            END AS viewer_has_requested,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = u.id)
            END AS viewer_has_blocked,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2)
            END AS blocked_by
       FROM users u WHERE u.username = $1`,
    [c.req.param('username'), viewerId],
  );
  if (!row) throw ApiError.notFound('User not found');
  // Blocks are symmetric in effect. The blocker can still find and reverse
  // their own block through /users/me/blocks, without leaking this profile.
  if (Boolean(row.blocked_by) || Boolean(row.viewer_has_blocked)) {
    throw ApiError.notFound('User not found');
  }

  const isSelf = viewerId != null && viewerId === (row.id as string);
  const restricted =
    !isSelf && Boolean(row.is_private) && !Boolean(row.viewer_is_following);
  return c.json({
    user: isSelf ? mapUser(row) : mapPublicUser(row),
    // The schema's private-account contract covers stats as well as activity.
    // Preserve the stable numeric DTO for older clients without disclosing
    // totals before the follow request is approved.
    stats: restricted
      ? { match_count: 0, follower_count: 0, following_count: 0, territory_count: 0 }
      : {
          match_count: Number(row.match_count),
          follower_count: Number(row.follower_count),
          following_count: Number(row.following_count),
          territory_count: Number(row.territory_count),
        },
    viewer_is_following: Boolean(row.viewer_is_following),
    // Pending follow request awaiting this (private) profile's approval.
    viewer_has_requested: Boolean(row.viewer_has_requested),
    viewer_has_blocked: Boolean(row.viewer_has_blocked),
    // Private profile the viewer doesn't follow: the shell renders, content doesn't.
    restricted,
  });
});

// Follow a public account instantly; a PRIVATE account gets a pending request
// its owner must approve. Returns the resulting relationship state so the
// client can render Follow / Requested / Following without a refetch.
app.post('/api/users/:username/follow', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  if (targetId === userId) throw ApiError.badRequest('You cannot follow yourself');
  const result = await withTransaction(async (client) => {
    await lockSocialPair(client, userId, targetId);
    if (await socialPairIsBlocked(client, userId, targetId)) {
      return { status: 'blocked' as const, inserted: false };
    }
    const { rows } = await client.query<{ is_private: boolean; following: boolean }>(
      `SELECT u.is_private,
              EXISTS(SELECT 1 FROM follows f
                       WHERE f.follower_id = $2 AND f.following_id = u.id) AS following
         FROM users u WHERE u.id = $1`,
      [targetId, userId],
    );
    const target = rows[0]!;
    if (target.following) return { status: 'following' as const, inserted: false };
    if (target.is_private) {
      const inserted = await client.query(
        `INSERT INTO follow_requests (requester_id, target_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING requester_id`,
        [userId, targetId],
      );
      return { status: 'requested' as const, inserted: inserted.rows.length > 0 };
    }
    const inserted = await client.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING follower_id`,
      [userId, targetId],
    );
    return { status: 'following' as const, inserted: inserted.rows.length > 0 };
  });

  // Present a block as not-found so the relationship is never disclosed.
  if (result.status === 'blocked') throw ApiError.notFound('User not found');
  if (result.inserted && result.status === 'requested') {
    await notify({
      userId: targetId,
      type: 'follow_request',
      title: '🔐 Follow request',
      body: `${c.get('user')!.username} wants to follow you. Approve it in your alerts.`,
      data: { requesterId: userId, username: c.get('user')!.username },
      push: false,
    }).catch(() => {});
  } else if (result.inserted) {
    await notify({
      userId: targetId,
      type: 'follow',
      title: '👋 New follower',
      body: `${c.get('user')!.username} started following you.`,
      data: { followerId: userId, username: c.get('user')!.username },
      push: false,
    }).catch(() => {});
  }
  const response = { ok: true, status: result.status };
  return result.inserted ? c.json(response, 201) : c.json(response);
});

// Unfollow — also withdraws a pending follow request, so one DELETE covers
// both the "Following" and "Requested" button states.
app.delete('/api/users/:username/follow', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  await withTransaction(async (client) => {
    await lockSocialPair(client, userId, targetId);
    await client.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [userId, targetId]);
    await client.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [userId, targetId]);
  });
  return c.body(null, 204);
});

// ─── Follow requests (private-account approval queue) ───────────────────
app.get('/api/users/me/follow-requests', requireAuth, async (c) => {
  const requests = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, r.created_at AS requested_at
       FROM follow_requests r JOIN users u ON u.id = r.requester_id
      WHERE r.target_id = $1
        AND ${mutuallyVisibleCondition('$1', 'r.requester_id')}
      ORDER BY r.created_at DESC LIMIT 200`,
    [uid(c)],
  );
  return c.json({ requests });
});

app.post('/api/users/me/follow-requests/:userId', requireAuth, async (c) => {
  const userId = uid(c);
  const requesterId = uuidParam(c, 'userId');
  const { action } = followRequestActionSchema.parse(await jsonBody(c));
  const outcome = await withTransaction(async (client) => {
    // The same pair lock is taken by follow/unfollow/block. Deleting the request
    // then claims it, so double taps and accept-vs-block races have one winner.
    await lockSocialPair(client, userId, requesterId);
    const claimed = await client.query(
      'DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2 RETURNING requester_id',
      [requesterId, userId],
    );
    if (claimed.rows.length === 0) return 'missing' as const;
    if (action === 'decline') return 'declined' as const;
    // A stale legacy request may coexist with a block. Consume it, but never
    // recreate the relationship or reveal why it disappeared.
    if (await socialPairIsBlocked(client, userId, requesterId)) return 'blocked' as const;
    await client.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [requesterId, userId],
    );
    return 'accepted' as const;
  });

  if (outcome === 'missing' || outcome === 'blocked') {
    throw ApiError.notFound('Follow request not found');
  }
  if (outcome === 'accepted') {
    await notify({
      userId: requesterId,
      type: 'follow_accepted',
      title: '✅ Follow request approved',
      body: `${c.get('user')!.username} approved your follow request.`,
      data: { userId, username: c.get('user')!.username },
      push: false,
    }).catch(() => {});
  }
  return c.json({ ok: true });
});

/** Resolve a profile-content route's target and enforce privacy + blocks. */
async function resolveViewableUserId(c: Context<Env>): Promise<string> {
  // This helper is called only from routes declaring :username; Hono's generic
  // Context cannot preserve that path parameter through the helper boundary.
  const username = c.req.param('username');
  if (!username) throw ApiError.notFound('User not found');
  const id = await resolveUserId(username);
  await assertCanViewContent(id, c.get('user')?.sub ?? null);
  return id;
}

app.get('/api/users/:username/analytics', optionalAuth, async (c) => {
  return c.json({ analytics: await getProfileAnalytics(await resolveViewableUserId(c)) });
});
app.get('/api/users/:username/ratings', optionalAuth, async (c) => {
  return c.json({ ratings: await getRatings(await resolveViewableUserId(c)) });
});
app.get('/api/users/:username/achievements', optionalAuth, async (c) => {
  return c.json({ achievements: await getAchievements(await resolveViewableUserId(c)) });
});
app.get('/api/users/:username/streak', optionalAuth, async (c) => {
  return c.json({ streak: await getStreakState(await resolveViewableUserId(c)) });
});
app.get('/api/users/:username/head-to-head', optionalAuth, async (c) => {
  return c.json({
    head_to_head: await getHeadToHead(
      await resolveViewableUserId(c),
      c.get('user')?.sub ?? null,
    ),
  });
});
app.get('/api/users/:username/records', optionalAuth, async (c) => {
  return c.json({ records: await getPersonalRecords(await resolveViewableUserId(c)) });
});

// Season recap — the "Year in Sport" analog.
app.get('/api/users/:username/year-in-review', optionalAuth, async (c) => {
  const { year, tz_offset } = yearQuerySchema.parse(c.req.query());
  const id = await resolveViewableUserId(c);
  return c.json({ review: await getYearInReview(id, year, tz_offset, c.get('user')?.sub ?? null) });
});

// Training log: one month of per-day aggregates (+ light match refs so a day
// can link straight to its matches). Days bucket in the viewer's local time
// via tz_offset. Counted matches only.
app.get('/api/users/:username/calendar', optionalAuth, async (c) => {
  const { year, month, tz_offset } = calendarQuerySchema.parse(c.req.query());
  const id = await resolveViewableUserId(c);
  const rows = await query<{
    day: string; matches: string; wins: string; minutes: string; items: unknown;
  }>(
    `SELECT to_char(played_at - make_interval(mins => $4), 'YYYY-MM-DD') AS day,
            COUNT(*) AS matches,
            COUNT(*) FILTER (WHERE result = 'win') AS wins,
            COALESCE(SUM(duration_minutes), 0) AS minutes,
            jsonb_agg(jsonb_build_object('id', id, 'result', result, 'score_array', score_array)
                      ORDER BY played_at) AS items
       FROM matches
      WHERE user_id = $1
        AND verification_status IN ('auto','verified')
        AND played_at - make_interval(mins => $4) >= make_date($2, $3, 1)::timestamp
        AND played_at - make_interval(mins => $4) <  (make_date($2, $3, 1) + interval '1 month')::timestamp
      GROUP BY 1
      ORDER BY 1 ASC`,
    [id, year, month, tz_offset],
  );
  const days = rows.map((r) => ({
    date: r.day,
    matches: Number(r.matches),
    wins: Number(r.wins),
    minutes: Number(r.minutes),
    items: r.items,
  }));
  return c.json({
    year,
    month,
    days,
    totals: {
      matches: days.reduce((s, d) => s + d.matches, 0),
      wins: days.reduce((s, d) => s + d.wins, 0),
      minutes: days.reduce((s, d) => s + d.minutes, 0),
    },
  });
});
// ─── Notifications ─────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (c) => {
  const userId = uid(c);
  const notifications = await query(
    `SELECT id, type, title, body, data, read, created_at
       FROM notifications WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  const unread = await queryOne<{ c: string }>(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read = false',
    [userId],
  );
  return c.json({ notifications, unread_count: Number(unread?.c ?? 0) });
});

app.post('/api/notifications/read', requireAuth, async (c) => {
  const userId = uid(c);
  // Mark-all is an explicit action (empty/absent body). A body that was *meant*
  // to scope specific ids but arrived truncated or unparseable must 400, not
  // silently fall through to wiping the user's entire unread state — so read the
  // raw body and tell "no body" apart from "bad body" instead of coalescing both
  // to {} via jsonBody.
  const raw = (await c.req.text()).trim();
  if (raw.length > 0) {
    let body: { ids?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('Request body must be valid JSON');
    }
    if (body?.ids !== undefined) {
      const parsed = notificationIdsSchema.safeParse(body);
      if (!parsed.success) throw ApiError.badRequest('ids must be a non-empty array of UUIDs');
      await query('UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, parsed.data.ids]);
      return c.json({ ok: true });
    }
  }
  await query('UPDATE notifications SET read = true WHERE user_id = $1', [userId]);
  return c.json({ ok: true });
});

// ─── Internal: cron sweeps (invoked by pg_cron via pg_net) ──────────────────
// Guarded by a shared secret in app_secrets, so only the database scheduler can
// trigger it. Not part of the public client contract.
app.post('/api/internal/sweep', async (c) => {
  const provided = c.req.header('x-internal-secret');
  const expected = await getSecret('internal_secret');
  if (!provided || !expected || !timingSafeEqual(provided, expected)) throw ApiError.unauthorized();
  const type = (await jsonBody<{ type?: string }>(c)).type;
  const supported = ['streak', 'territory', 'ratings', 'court_names', 'media_cleanup'];
  if (!type || !supported.includes(type)) {
    throw ApiError.badRequest('type must be streak, territory, ratings, court_names or media_cleanup');
  }
  // Piggyback the durable deletion queue on existing scheduled sweeps, while
  // retaining an explicit type for operations/manual recovery.
  // Keep deletion cleanup bounded so a large Storage folder cannot crowd the
  // actual sweep out of the Edge wall-clock budget. Cron invokes this route
  // frequently and failed jobs remain durable with backoff.
  const media_cleanup = await processMediaCleanupJobs(2);
  if (type === 'streak') return c.json({ ok: true, recomputed: await runStreakSweep(), media_cleanup });
  if (type === 'territory') return c.json({ ok: true, recomputed: await runTerritorySweep(), media_cleanup });
  if (type === 'ratings') return c.json({ ok: true, recomputed: await runRatingSweep(), media_cleanup });
  if (type === 'court_names') return c.json({ ok: true, named: await runCourtNameSweep(), media_cleanup });
  return c.json({ ok: true, media_cleanup });
});

// ─── Error handling ──────────────────────────────────────────────────────
app.notFound(() => {
  throw ApiError.notFound('Route not found');
});

const TRANSIENT_DATABASE_CODES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '53300', // too_many_connections
  '57P01', '57P02', '57P03', // shutdown / cannot_connect_now
  'CONNECTION_CLOSED', 'CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT',
]);

function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  if (TRANSIENT_DATABASE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /too many clients|remaining connection slots|max client connections|connection (?:closed|terminated)|connect timeout/i.test(message);
}

app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const retryAfter = (err as ApiError & { retryAfterSeconds?: number }).retryAfterSeconds ?? 60;
      c.header('Retry-After', String(retryAfter));
    }
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'validation_error', message: 'Request validation failed', details: err.flatten() } }, 400);
  }
  if (isTransientDatabaseError(err)) {
    c.header('Retry-After', '1');
    console.warn('[database] transient failure', {
      request_id: c.get('requestId'),
      code: typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unknown',
    });
    return c.json(
      { error: { code: 'service_unavailable', message: 'Vollo is briefly busy. Please retry.' } },
      503,
    );
  }
  // Map common Postgres SQLSTATE codes to sensible client errors.
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const pgCode = (err as { code: string }).code;
    switch (pgCode) {
      case '23505':
        return c.json({ error: { code: 'conflict', message: 'Resource already exists' } }, 409);
      case '22P02':
      case '22003':
        return c.json({ error: { code: 'bad_request', message: 'Invalid identifier or value' } }, 400);
      case '23503':
        return c.json({ error: { code: 'bad_request', message: 'Referenced resource does not exist' } }, 400);
      case '23514':
        return c.json({ error: { code: 'bad_request', message: 'Value failed a database constraint' } }, 400);
    }
  }
  console.error('[error] unhandled', {
    request_id: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
});

// ─── Entrypoint ────────────────────────────────────────────────────────────
// Normalise the path so the app sees `/api/...` regardless of whether Supabase
// includes the `/functions/v1/api` prefix or strips the function name.
Deno.serve((req) => {
  const url = new URL(req.url);
  let path = url.pathname;
  const prefix = '/functions/v1/api';
  if (path.startsWith(prefix)) path = '/api' + path.slice(prefix.length);
  if (!path.startsWith('/api')) path = '/api' + (path === '/' ? '' : path);
  if (path !== url.pathname) {
    url.pathname = path;
    return app.fetch(new Request(url.toString(), req));
  }
  return app.fetch(req);
});

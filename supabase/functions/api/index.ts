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
import { cors } from 'hono/cors';
import { ZodError } from 'zod';

import { query, queryOne, withTransaction, getSecret, type Queryable } from './db.ts';
import { adminClient, authClient } from './supabaseAdmin.ts';
import { ApiError } from './errors.ts';
import { mapCourt, mapMatchCard, mapPublicUser, mapScheduledMatch, mapUser, toIso } from './mappers.ts';
import {
  bboxQuerySchema, commentSchema, commentsQuerySchema, courtsQuerySchema,
  createCourtSchema, createMatchSchema, createScheduledMatchSchema, discoverQuerySchema, feedQuerySchema,
  geocodeQuerySchema, loginSchema, notificationIdsSchema, pushTokenSchema,
  reverseGeocodeQuerySchema, setGoalSchema, updateProfileSchema, updateScheduledMatchSchema,
  userSearchQuerySchema, verifyMatchSchema,
} from './validation.ts';
import type { CreateMatchInput } from './validation.ts';
import { analyzeScore, matchScore } from './scoring.ts';
import { recomputeUserStreak, getStreakState } from './streak.ts';
import { recomputeUserRatings, getRatings } from './rating.ts';
import { evaluateAchievements, getAchievements } from './achievements.ts';
import { getCourtController, recomputeAfterMatch, getUserTerritories, listTerritories } from './territory.ts';
import { notify } from './notifications.ts';
import { geocode, reverseGeocode } from './geocoding.ts';
import { fetchOverpassSectors, type OverpassSector } from './overpass.ts';
import { getProfileAnalytics, getHeadToHead } from './analytics.ts';
import { getPersonalRecords } from './records.ts';
import { runStreakSweep, runTerritorySweep, runCourtNameSweep, runRatingSweep } from './sweeps.ts';
import type { AuthClaims, LeaderboardEntry, MatchCard, MatchResult, MatchStats, Surface } from './types.ts';

type Env = { Variables: { user?: AuthClaims } };

const USER_SELECT = `
  id, username, email, display_name, avatar_url, cover_url, bio, dominant_hand, color,
  ST_Y(home_geom) AS home_lat, ST_X(home_geom) AS home_lng, home_label, equipment, is_private, created_at
`;

// ─── Helpers ────────────────────────────────────────────────────────────────
async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

function uid(c: Context<Env>): string {
  const u = c.get('user');
  if (!u) throw ApiError.unauthorized();
  return u.sub;
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
  if (!header) return { claims: null, hadToken: false, transient: false };
  const parts = header.trim().split(/ +/);
  if (parts[0]?.toLowerCase() !== 'bearer') return { claims: null, hadToken: false, transient: false };
  const token = parts.slice(1).join(' ').trim();
  if (!token) return { claims: null, hadToken: false, transient: false };
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
    return { claims: { sub: row.id, username: row.username }, hadToken: true, transient: false };
  } catch {
    // Threw before we could decide (GoTrue network error, DB error) — transient.
    return { claims: null, hadToken: true, transient: true };
  }
}

const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const { claims, hadToken, transient } = await authFromHeader(c);
  if (!claims) {
    if (transient) throw new ApiError(503, 'auth_unavailable', 'Sign-in check is temporarily unavailable, please retry');
    throw hadToken ? ApiError.unauthorized('Invalid or expired token') : ApiError.unauthorized();
  }
  c.set('user', claims);
  await next();
};

const optionalAuth: MiddlewareHandler<Env> = async (c, next) => {
  // A transient failure here just means we treat the request as unauthenticated
  // (these routes are public) rather than failing it.
  const { claims } = await authFromHeader(c);
  if (claims) c.set('user', claims);
  await next();
};

// Best-effort in-memory fixed-window rate limiter (per isolate). The mobile app
// is the only client, so this is just an abuse backstop, not a strict quota.
function makeLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
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
  return (c.req.header('x-forwarded-for')?.split(',')[0]?.trim()) || 'unknown';
}

// Durable brute-force throttle for sign-in: failed attempts are counted in
// Postgres (per client IP and per target identifier) so the limit holds across
// the whole edge fleet — the in-memory limiter above is only per-isolate.
const LOGIN_FAILURE_WINDOW = "15 minutes";
const LOGIN_MAX_FAILURES = 10;

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
    throw ApiError.tooManyRequests('Too many sign-in attempts, please try again later');
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

/** A successful sign-in proves the actor owns the account — clear their
 *  counters so an honest user's earlier typos don't linger toward a lockout. */
function clearLoginFailures(keys: string[]): void {
  void query('DELETE FROM login_attempts WHERE key = ANY($1)', [keys]).catch(() => {});
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

/**
 * SQL fragments that hide matches the viewer may not see, matching
 * assertCanViewContent: no block in either direction, and private authors only
 * for their followers (or themselves). `viewerParam` is the placeholder holding
 * the (nullable) viewer id; `authorCol` the match author column. With a NULL
 * viewer the block EXISTS never matches and only public authors pass.
 */
function matchVisibilityConditions(viewerParam: string, authorCol: string): string[] {
  return [
    `(${authorCol} = ${viewerParam} OR NOT EXISTS(
        SELECT 1 FROM blocks b
         WHERE (b.blocker_id = ${viewerParam} AND b.blocked_id = ${authorCol})
            OR (b.blocker_id = ${authorCol} AND b.blocked_id = ${viewerParam})))`,
    `(${authorCol} = ${viewerParam}
       OR NOT (SELECT u.is_private FROM users u WHERE u.id = ${authorCol})
       OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ${viewerParam} AND f.following_id = ${authorCol}))`,
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

app.use('*', cors());

// Global request ceiling — a cheap abuse backstop.
const globalLimiter = makeLimiter(60_000, 200);
app.use('/api/*', async (c, next) => {
  if (!globalLimiter(clientIp(c))) throw ApiError.tooManyRequests();
  await next();
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
  if (!loginLimiter(clientIp(c))) throw ApiError.tooManyRequests('Too many sign-in attempts, please try again shortly');
  const { identifier, password } = loginSchema.parse(await jsonBody(c));

  // Throttle on both the source IP and the targeted account, so neither a
  // single-IP spray nor a distributed attack on one identifier gets free tries.
  const throttleKeys = [`ip:${clientIp(c)}`, `id:${identifier.toLowerCase()}`];
  await assertLoginNotThrottled(throttleKeys);

  let email: string | null = identifier.includes('@') ? identifier : null;
  if (!email) {
    const row = await queryOne<{ email: string }>('SELECT email FROM users WHERE lower(username) = lower($1)', [identifier]);
    email = row?.email ?? null;
  }
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
      throw new ApiError(403, 'email_not_confirmed', 'Please confirm your email before signing in — check your inbox.');
    }
    throw await invalid();
  }
  if (!data.session) throw await invalid();

  clearLoginFailures(throttleKeys);
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

  const conditions: string[] = [...matchVisibilityConditions('$1', 'mf.user_id')];
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
  await assertCanViewContent(c.req.param('userId'), viewerId);
  const params: unknown[] = [viewerId, c.req.param('userId')];
  let p = params.length;
  let extra = '';
  if (before) {
    const cursor = decodeCursor(before);
    params.push(cursor.t, cursor.id);
    extra = `AND (mf.played_at, mf.id) < ($${++p}::timestamptz, $${++p}::uuid)`;
  }
  params.push(limit + 1);
  const limitIdx = ++p;
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.*,
            CASE WHEN $1::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
            END AS viewer_has_kudos
       FROM match_feed mf
      WHERE mf.user_id = $2 ${extra}
      ORDER BY mf.played_at DESC, mf.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  const hasMore = rows.length > limit;
  const matches = rows.slice(0, limit).map(mapMatchCard);
  return c.json({ matches, next_cursor: nextCursor(matches, hasMore) });
});

// ─── Matches ─────────────────────────────────────────────────────────────
app.post('/api/matches', requireAuth, async (c) => {
  const userId = uid(c);
  const body = createMatchSchema.parse(await jsonBody(c)) as CreateMatchInput;

  let analysis;
  try {
    analysis = analyzeScore(body.score_array, { finalSetTiebreak: body.is_tiebreak });
  } catch (err) {
    throw ApiError.badRequest(err instanceof Error ? err.message : 'Invalid score');
  }

  if (body.opponent_id && body.opponent_id === userId) {
    throw ApiError.badRequest('You cannot log a match against yourself');
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

  const matchId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO matches
         (user_id, opponent_id, opponent_name, court_id, surface, score_array, result,
          sets_won, sets_lost, games_won, games_lost, match_score, streak_modifier,
          rpe_index, duration_minutes, notes, is_tiebreak, played_at, verification_status,
          title, photo_url)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,0,1,$12,$13,$14,$15,$16,$17,$18,$19)
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
      ],
    );
    const id = inserted.rows[0]!.id;

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

  // If this match fulfils a scheduled proposal, link it so the score surfaces on
  // both players' scheduled-match cards. Best-effort; the match is already saved.
  // Only a live (proposed/accepted) schedule the user is part of can be completed
  // — never resurrect a declined/cancelled one.
  if (body.scheduled_match_id) {
    try {
      await query(
        `UPDATE scheduled_matches SET status = 'completed', match_id = $1
          WHERE id = $2 AND (creator_id = $3 OR opponent_id = $3) AND status IN ('proposed', 'accepted')`,
        [matchId, body.scheduled_match_id, userId],
      );
    } catch (err) {
      console.error('[matches] scheduled-match link failed', err instanceof Error ? err.message : err);
    }
  }

  const card = await fetchMatchCard(matchId, userId);
  return c.json({ match: card }, 201);
});

// Matches awaiting MY confirmation (I'm the tagged opponent). Static path is
// declared before /matches/:id so "pending" isn't swallowed as an :id.
app.get('/api/matches/pending', requireAuth, async (c) => {
  const userId = uid(c);
  const rows = await query<Record<string, unknown>>(
    `SELECT mf.* FROM match_feed mf
      WHERE mf.opponent_id = $1 AND mf.verification_status = 'pending'
      ORDER BY mf.created_at DESC LIMIT 50`,
    [userId],
  );
  return c.json({ matches: rows.map(mapMatchCard) });
});

// The tagged opponent confirms (it counts) or rejects (it never counts) a match.
app.post('/api/matches/:id/verify', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const { action } = verifyMatchSchema.parse(await jsonBody(c));

  const match = await queryOne<{
    user_id: string;
    opponent_id: string | null;
    court_id: string | null;
    surface: Surface;
    result: MatchResult;
    games_won: number;
    games_lost: number;
    verification_status: string;
  }>(
    `SELECT user_id, opponent_id, court_id, surface, result, games_won, games_lost, verification_status
       FROM matches WHERE id = $1`,
    [id],
  );
  if (!match) throw ApiError.notFound('Match not found');
  if (match.opponent_id !== userId) throw ApiError.forbidden('Only the tagged opponent can verify this match');
  if (match.verification_status !== 'pending') throw ApiError.badRequest('This match has already been resolved');

  const verifier = c.get('user')!.username;

  if (action === 'reject') {
    // Status-guarded so a concurrent confirm/reject (double-tap, retry) can't
    // both fire — only the request that flips it off 'pending' proceeds.
    const rejected = await query<{ id: string }>(
      "UPDATE matches SET verification_status = 'rejected', verified_at = now() WHERE id = $1 AND verification_status = 'pending' RETURNING id",
      [id],
    );
    if (rejected.length === 0) throw ApiError.badRequest('This match has already been resolved');
    await notify({
      userId: match.user_id,
      type: 'match_rejected',
      title: '🚫 Match disputed',
      body: `@${verifier} disputed your logged match, so it won't count.`,
      data: { matchId: id },
    }).catch(() => {});
    return c.json({ match: await fetchMatchCard(id, userId) });
  }

  // confirm → the match now counts: apply its effects to the logger. The
  // status-guarded UPDATE (with the row lock it takes) serialises concurrent
  // verifies under READ COMMITTED — the loser matches 0 rows and bails BEFORE
  // applyMatchEffects, so ELO/territory are applied exactly once.
  const previousControllerId = match.court_id ? await getCourtController(match.court_id) : null;
  await withTransaction(async (client) => {
    const claimed = await client.query<{ id: string }>(
      "UPDATE matches SET verification_status = 'verified', verified_at = now() WHERE id = $1 AND verification_status = 'pending' RETURNING id",
      [id],
    );
    if (claimed.rows.length === 0) throw ApiError.badRequest('This match has already been resolved');
    await applyMatchEffects(client, {
      matchId: id,
      userId: match.user_id,
      gamesWon: Number(match.games_won),
      gamesLost: Number(match.games_lost),
    });
  });

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

/** The match's participants always see it; everyone else is subject to the
 *  author's privacy + blocks. Throws (404/403) when the viewer may not see it. */
async function assertCanViewMatch(
  match: { user_id: string; opponent_id?: string | null },
  viewerId: string | null,
): Promise<void> {
  if (viewerId && (viewerId === match.user_id || viewerId === match.opponent_id)) return;
  await assertCanViewContent(match.user_id, viewerId);
}

app.get('/api/matches/:id', optionalAuth, async (c) => {
  const card = await fetchMatchCard(c.req.param('id'), c.get('user')?.sub ?? null);
  if (!card) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(card, c.get('user')?.sub ?? null);
  return c.json({ match: card });
});

app.delete('/api/matches/:id', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const match = await queryOne<{
    user_id: string;
    court_id: string | null;
    opponent_id: string | null;
    surface: Surface;
    result: MatchResult;
    games_won: number;
    games_lost: number;
    user_rating_delta: number | null;
    verification_status: string;
  }>(
    `SELECT user_id, court_id, opponent_id, surface, result, games_won, games_lost,
            user_rating_delta, verification_status
       FROM matches WHERE id = $1`,
    [id],
  );
  if (!match) throw ApiError.notFound('Match not found');
  if (match.user_id !== userId) throw ApiError.forbidden('You can only delete your own matches');

  // A pending/rejected match never applied ELO or touched a leaderboard, so its
  // deletion must NOT reverse ratings or recompute territory (that would corrupt
  // the rating). Streak is always recomputed (cheap; it excludes the row anyway).
  const counted = match.verification_status === 'auto' || match.verification_status === 'verified';
  const previousControllerId = counted && match.court_id ? await getCourtController(match.court_id) : null;

  await withTransaction(async (client) => {
    await client.query('DELETE FROM matches WHERE id = $1', [id]);
    // Ratings are recomputed from the remaining history (exact), not delta-reversed.
    if (counted) await recomputeUserRatings(client, userId);
    await recomputeUserStreak(userId, client);
  });

  if (counted && match.court_id) {
    // Post-commit side effect: the row is already gone, so a recompute failure
    // must not turn a successful delete into a 500 (the 6-hourly sweep is the
    // backstop) — same isolation as create/verify.
    try {
      await recomputeAfterMatch({ courtId: match.court_id, loggerUserId: userId, previousControllerId });
    } catch (err) {
      console.error('post-delete territory recompute failed', err);
    }
  }
  return c.body(null, 204);
});

app.post('/api/matches/:id/kudos', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const match = await queryOne<{ user_id: string; opponent_id: string | null }>(
    'SELECT user_id, opponent_id FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(match, userId);

  const inserted = await queryOne<{ id: string }>(
    'INSERT INTO kudos (match_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
    [id, userId],
  );
  const countRow = await queryOne<{ c: string }>('SELECT COUNT(*) AS c FROM kudos WHERE match_id = $1', [id]);

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
  const id = c.req.param('id');
  await query('DELETE FROM kudos WHERE match_id = $1 AND user_id = $2', [id, userId]);
  const countRow = await queryOne<{ c: string }>('SELECT COUNT(*) AS c FROM kudos WHERE match_id = $1', [id]);
  return c.json({ kudos_count: Number(countRow?.c ?? 0), viewer_has_kudos: false });
});

app.get('/api/matches/:id/comments', optionalAuth, async (c) => {
  const { limit, before } = commentsQuerySchema.parse(c.req.query());
  const id = c.req.param('id');
  const parent = await queryOne<{ user_id: string; opponent_id: string | null }>(
    'SELECT user_id, opponent_id FROM matches WHERE id = $1', [id]);
  if (!parent) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(parent, c.get('user')?.sub ?? null);
  const params: unknown[] = [id];
  let extra = '';
  if (before) {
    // Composite "<ISO>~<uuid>" keyset cursor — a timestamp alone would
    // drop/duplicate rows on created_at ties. Both halves are validated here:
    // a malformed uuid must be a 400, not a Postgres 22P02 surfacing as a 500.
    const [ts, cid] = before.split('~');
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (Number.isNaN(Date.parse(ts)) || !cid || !UUID_RE.test(cid)) {
      throw ApiError.badRequest('Invalid pagination cursor');
    }
    params.push(ts, cid);
    extra = `AND (c.created_at, c.id) < ($2::timestamptz, $3::uuid)`;
  }
  params.push(limit);
  const rows = await query<{ id: string; created_at: string }>(
    `SELECT c.id, c.body, c.created_at, c.user_id,
            u.username, u.display_name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.match_id = $1 ${extra}
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
  const id = c.req.param('id');
  const { body } = commentSchema.parse(await jsonBody(c));
  const match = await queryOne<{ user_id: string; opponent_id: string | null }>(
    'SELECT user_id, opponent_id FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');
  await assertCanViewMatch(match, userId);

  const comment = await queryOne(
    `WITH inserted AS (
       INSERT INTO comments (match_id, user_id, body) VALUES ($1, $2, $3) RETURNING *
     )
     SELECT i.id, i.body, i.created_at, i.user_id, u.username, u.display_name, u.avatar_url
       FROM inserted i JOIN users u ON u.id = i.user_id`,
    [id, userId, body],
  );

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
    `${SCHEDULED_SELECT} WHERE s.creator_id = $1 OR s.opponent_id = $1 ORDER BY s.scheduled_at DESC LIMIT 100`,
    [userId],
  );
  return c.json({ scheduled_matches: rows.map((r) => mapScheduledMatch(r, userId)) });
});

app.post('/api/scheduled-matches', requireAuth, async (c) => {
  const userId = uid(c);
  const b = createScheduledMatchSchema.parse(await jsonBody(c));
  if (b.opponent_id === userId) throw ApiError.badRequest('You cannot schedule a match against yourself');

  // A proposal to a Vollo player needs their acceptance; an off-app opponent is
  // just a personal plan, so it starts accepted. A challenge only makes sense
  // against a registered player.
  const status = b.opponent_id ? 'proposed' : 'accepted';
  const isChallenge = !!b.is_challenge && !!b.opponent_id;
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO scheduled_matches (creator_id, opponent_id, opponent_name, court_id, surface, scheduled_at, note, status, is_challenge)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [userId, b.opponent_id ?? null, b.opponent_id ? null : b.opponent_name ?? null, b.court_id ?? null, b.surface ?? null, b.scheduled_at, b.note ?? null, status, isChallenge],
  );
  const card = await fetchScheduledMatch(inserted!.id, userId);

  if (b.opponent_id) {
    await notify({
      userId: b.opponent_id,
      type: isChallenge ? 'challenge' : 'match_scheduled',
      title: isChallenge ? '⚔️ You’ve been challenged' : '📅 Match proposed',
      body: isChallenge
        ? `${c.get('user')!.username} challenged you to a match. Accept to lock it in.`
        : `${c.get('user')!.username} wants to play you. Tap to respond.`,
      data: { scheduledMatchId: inserted!.id },
      push: isChallenge,
    }).catch(() => {});
  }
  return c.json({ scheduled_match: card }, 201);
});

app.patch('/api/scheduled-matches/:id', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const { action } = updateScheduledMatchSchema.parse(await jsonBody(c));

  const row = await queryOne<{ creator_id: string; opponent_id: string | null; status: string }>(
    'SELECT creator_id, opponent_id, status FROM scheduled_matches WHERE id = $1',
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

  await query('UPDATE scheduled_matches SET status = $1 WHERE id = $2', [newStatus, id]);
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
    console.warn('[geocode] provider error', err instanceof Error ? err.message : err);
    throw new ApiError(502, 'geocode_failed', 'Address lookup is temporarily unavailable');
  }
});

// ─── Court discovery: import real-world courts from OpenStreetMap ───────────
// Cache of recently-imported viewport cells (per isolate) so panning the map
// doesn't hammer the free Overpass API; the DB upsert is idempotent regardless.
const DISCOVER_TTL_MS = 15 * 60_000;
const discoveredCells = new Map<string, number>();
function discoverCellKey(b: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }): string {
  const snap = (x: number) => Math.round(x / 0.05) * 0.05;
  return [snap(b.min_lng), snap(b.min_lat), snap(b.max_lng), snap(b.max_lat)].map((n) => n.toFixed(2)).join(',');
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
      const key = discoverCellKey(b);
      const now = Date.now();
      const fresh = discoveredCells.get(key);
      if (b.force || !fresh || fresh <= now) {
        try {
          await importOverpassCourts(b);
          if (discoveredCells.size > 5000) discoveredCells.clear(); // bound per-isolate memory
          discoveredCells.set(key, now + DISCOVER_TTL_MS);
        } catch (err) {
          console.warn('[discover] overpass import failed', err instanceof Error ? err.message : err);
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
      [q, limit],
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
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO courts (name, description, surface, geom, address, city, osm_id, court_count, created_by)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8, $9, $10)
     RETURNING ${COURT_COLS}`,
    [b.name, b.description ?? null, b.surface, b.lng, b.lat, b.address ?? null, b.city ?? null, b.osm_id ?? null, b.court_count ?? 1, uid(c)],
  );
  return c.json({ court: mapCourt(row!) }, 201);
});

app.get('/api/courts/:id', optionalAuth, async (c) => {
  const id = c.req.param('id');
  const row = await queryOne<Record<string, unknown>>(`SELECT ${COURT_COLS} FROM courts WHERE id = $1`, [id]);
  if (!row) throw ApiError.notFound('Court not found');

  const controller = await queryOne<{ user_id: string; username: string; display_name: string; score: string }>(
    `SELECT cl.user_id, u.username, u.display_name, cl.score
       FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
      WHERE cl.court_id = $1 AND cl.rank = 1
      ORDER BY cl.score DESC LIMIT 1`,
    [id],
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

app.get('/api/courts/:id/leaderboard', async (c) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT cl.court_id, cl.user_id, cl.score, cl.matches_played, cl.wins, cl.losses,
            cl.games_won, cl.games_lost, cl.rank, cl.last_played_at,
            u.username, u.display_name, u.avatar_url
       FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
      WHERE cl.court_id = $1
      ORDER BY cl.rank ASC, cl.score DESC
      LIMIT 100`,
    [c.req.param('id')],
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
app.get('/api/territories', async (c) => {
  const b = bboxQuerySchema.parse(c.req.query());
  const hasBbox = b.min_lng != null && b.min_lat != null && b.max_lng != null && b.max_lat != null;
  const territories = await listTerritories(
    hasBbox ? { minLng: b.min_lng!, minLat: b.min_lat!, maxLng: b.max_lng!, maxLat: b.max_lat! } : undefined,
  );
  return c.json({ territories });
});

app.get('/api/territories/user/:userId', async (c) => {
  const territories = await getUserTerritories(c.req.param('userId'));
  return c.json({ territories });
});

// ─── Users / profiles ────────────────────────────────────────────────────
app.patch('/api/users/me', requireAuth, async (c) => {
  const userId = uid(c);
  const b = updateProfileSchema.parse(await jsonBody(c));
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (b.display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(b.display_name); }
  if (b.bio !== undefined) { sets.push(`bio = $${i++}`); params.push(b.bio); }
  if (b.avatar_url !== undefined) { sets.push(`avatar_url = $${i++}`); params.push(b.avatar_url); }
  if (b.cover_url !== undefined) { sets.push(`cover_url = $${i++}`); params.push(b.cover_url); }
  if (b.dominant_hand !== undefined) { sets.push(`dominant_hand = $${i++}`); params.push(b.dominant_hand); }
  if (b.is_private !== undefined) { sets.push(`is_private = $${i++}`); params.push(b.is_private); }
  if (b.color !== undefined) { sets.push(`color = $${i++}`); params.push(b.color); }
  if (b.home !== undefined) {
    sets.push(`home_geom = ST_SetSRID(ST_MakePoint($${i++}, $${i++}), 4326)`);
    params.push(b.home.lng, b.home.lat);
    sets.push(`home_label = $${i++}`);
    params.push(b.home.label ?? null);
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
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${USER_SELECT}`,
    params,
  );
  return c.json({ user: mapUser(row!) });
});

app.get('/api/users/search', requireAuth, async (c) => {
  const userId = uid(c);
  const { q, limit } = userSearchQuerySchema.parse(c.req.query());
  const users = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id) AS viewer_is_following
       FROM users u
      WHERE u.id <> $1
        AND (u.username ILIKE '%' || $2 || '%' OR u.display_name ILIKE '%' || $2 || '%')
        -- Blocked players (either direction) are mutually invisible in search.
        AND NOT EXISTS(SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                           OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY (u.username ILIKE $2 || '%' OR u.display_name ILIKE $2 || '%') DESC, u.username ASC
      LIMIT $3`,
    [userId, q, limit],
  );
  return c.json({ users });
});

app.post('/api/users/me/push-token', requireAuth, async (c) => {
  const userId = uid(c);
  const { token, platform } = pushTokenSchema.parse(await jsonBody(c));
  await query(
    `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, created_at = now()`,
    [userId, token, platform ?? 'expo'],
  );
  return c.json({ ok: true }, 201);
});

app.delete('/api/users/me', requireAuth, async (c) => {
  const userId = uid(c);
  const row = await queryOne<{ auth_id: string | null }>('SELECT auth_id FROM users WHERE id = $1', [userId]);
  if (row?.auth_id) {
    // Delete the auth identity first: users.auth_id ON DELETE CASCADE removes the
    // profile and all owned data atomically. If this throws, the account is left
    // intact (the request 500s and can be retried) rather than orphaning an auth
    // user with no profile — which would soft-lock the login.
    await adminClient.auth.admin.deleteUser(row.auth_id);
  } else {
    // Legacy row with no linked auth identity — remove the profile directly.
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
  await query('DELETE FROM goals WHERE id = $1 AND user_id = $2', [c.req.param('id'), uid(c)]);
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
    await client.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, targetId],
    );
    // Blocking severs the relationship in both directions.
    await client.query(
      `DELETE FROM follows
        WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)`,
      [userId, targetId],
    );
  });
  return c.json({ ok: true }, 201);
});

app.delete('/api/users/:username/block', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, targetId]);
  return c.body(null, 204);
});

app.get('/api/users/:username', optionalAuth, async (c) => {
  const viewerId = c.get('user')?.sub ?? null;
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${USER_SELECT},
            (SELECT COUNT(*) FROM matches  WHERE user_id = u.id AND verification_status IN ('auto','verified')) AS match_count,
            (SELECT COUNT(*) FROM follows  WHERE following_id = u.id) AS follower_count,
            (SELECT COUNT(*) FROM follows  WHERE follower_id = u.id)  AS following_count,
            (SELECT COUNT(*) FROM territories WHERE user_id = u.id)   AS territory_count,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id)
            END AS viewer_is_following,
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
  // Someone this user blocked never learns the account still exists.
  if (Boolean(row.blocked_by)) throw ApiError.notFound('User not found');

  const isSelf = viewerId != null && viewerId === (row.id as string);
  const restricted =
    !isSelf && Boolean(row.is_private) && !Boolean(row.viewer_is_following);
  return c.json({
    user: isSelf ? mapUser(row) : mapPublicUser(row),
    stats: {
      match_count: Number(row.match_count),
      follower_count: Number(row.follower_count),
      following_count: Number(row.following_count),
      territory_count: Number(row.territory_count),
    },
    viewer_is_following: Boolean(row.viewer_is_following),
    viewer_has_blocked: Boolean(row.viewer_has_blocked),
    // Private profile the viewer doesn't follow: the shell renders, content doesn't.
    restricted,
  });
});

app.post('/api/users/:username/follow', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  if (targetId === userId) throw ApiError.badRequest('You cannot follow yourself');
  // A block in either direction forbids following (presented as not-found so a
  // block is never disclosed to the blocked party).
  if ((await profileAccess(targetId, userId)).blocked) throw ApiError.notFound('User not found');
  const inserted = await queryOne(
    `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING follower_id`,
    [userId, targetId],
  );
  if (inserted) {
    await notify({
      userId: targetId,
      type: 'follow',
      title: '👋 New follower',
      body: `${c.get('user')!.username} started following you.`,
      data: { followerId: userId },
      push: false,
    }).catch(() => {});
  }
  return c.json({ ok: true }, 201);
});

app.delete('/api/users/:username/follow', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  await query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [userId, targetId]);
  return c.body(null, 204);
});

/** Resolve a profile-content route's target and enforce privacy + blocks. */
async function resolveViewableUserId(c: Context<Env>): Promise<string> {
  const id = await resolveUserId(c.req.param('username'));
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
  return c.json({ head_to_head: await getHeadToHead(await resolveViewableUserId(c)) });
});
app.get('/api/users/:username/records', optionalAuth, async (c) => {
  return c.json({ records: await getPersonalRecords(await resolveViewableUserId(c)) });
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
  const body = await jsonBody<{ ids?: unknown }>(c);
  if (body?.ids !== undefined) {
    const parsed = notificationIdsSchema.safeParse(body);
    if (!parsed.success) throw ApiError.badRequest('ids must be a non-empty array of UUIDs');
    await query('UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, parsed.data.ids]);
  } else {
    await query('UPDATE notifications SET read = true WHERE user_id = $1', [userId]);
  }
  return c.json({ ok: true });
});

// ─── Internal: cron sweeps (invoked by pg_cron via pg_net) ──────────────────
// Guarded by a shared secret in app_secrets, so only the database scheduler can
// trigger it. Not part of the public client contract.
app.post('/api/internal/sweep', async (c) => {
  const provided = c.req.header('x-internal-secret');
  const expected = await getSecret('internal_secret');
  if (!provided || provided !== expected) throw ApiError.unauthorized();
  const type = (await jsonBody<{ type?: string }>(c)).type;
  if (type === 'streak') return c.json({ ok: true, recomputed: await runStreakSweep() });
  if (type === 'territory') return c.json({ ok: true, recomputed: await runTerritorySweep() });
  if (type === 'ratings') return c.json({ ok: true, recomputed: await runRatingSweep() });
  if (type === 'court_names') return c.json({ ok: true, named: await runCourtNameSweep() });
  throw ApiError.badRequest('type must be streak, territory, ratings or court_names');
});

// ─── Error handling ──────────────────────────────────────────────────────
app.notFound(() => {
  throw ApiError.notFound('Route not found');
});

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'validation_error', message: 'Request validation failed', details: err.flatten() } }, 400);
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
  console.error('[error] unhandled', err);
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

// ════════════════════════════════════════════════════════════════════════
// Vollo API — Supabase Edge Function (Deno + Hono).
//
// A faithful port of the original Express API. The HTTP contract is unchanged
// (same /api/* paths, custom HS256 bearer auth, JSON shapes and error envelope),
// so the mobile client only needs its base URL repointed. DB access goes through
// the direct Postgres connection (service role, bypassing RLS); all auth is
// enforced here, so the public PostgREST API stays sealed by RLS.
// ════════════════════════════════════════════════════════════════════════
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';
import { ZodError } from 'zod';

import { config } from './config.ts';
import { query, queryOne, withTransaction, getSecret } from './db.ts';
import { ApiError } from './errors.ts';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth.ts';
import { mapCourt, mapMatchCard, mapPublicUser, mapUser, toIso } from './mappers.ts';
import {
  bboxQuerySchema, commentSchema, commentsQuerySchema, courtsQuerySchema,
  createCourtSchema, createMatchSchema, feedQuerySchema, geocodeQuerySchema,
  loginSchema, notificationIdsSchema, pushTokenSchema, registerSchema,
  updateProfileSchema, userSearchQuerySchema,
} from './validation.ts';
import type { CreateMatchInput } from './validation.ts';
import { analyzeScore, matchScore } from './scoring.ts';
import { recomputeUserStreak, getStreakState } from './streak.ts';
import { applyMatchToRatings, reverseMatchFromRatings, getRatings } from './rating.ts';
import { evaluateAchievements, getAchievements } from './achievements.ts';
import { getCourtController, recomputeAfterMatch, getUserTerritories, listTerritories } from './territory.ts';
import { notify } from './notifications.ts';
import { geocode } from './geocoding.ts';
import { getProfileAnalytics, getHeadToHead } from './analytics.ts';
import { runStreakSweep, runTerritorySweep } from './sweeps.ts';
import type { AuthClaims, LeaderboardEntry, MatchCard, MatchStats } from './types.ts';

type Env = { Variables: { user?: AuthClaims } };

const USER_SELECT = `
  id, username, email, display_name, avatar_url, bio, dominant_hand,
  ST_Y(home_geom) AS home_lat, ST_X(home_geom) AS home_lng, home_label, created_at
`;

// A valid bcrypt hash to compare against when the identifier is unknown, so login
// takes the same time whether or not the account exists (defeats the timing
// user-enumeration oracle), at the *configured* cost so it always matches a real
// account's work factor.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('vollo-timing-equalizer', config.auth.bcryptRounds);

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

async function authFromHeader(c: Context): Promise<{ claims: AuthClaims | null; hadToken: boolean }> {
  const header = c.req.header('Authorization') ?? c.req.header('authorization');
  if (!header) return { claims: null, hadToken: false };
  const parts = header.trim().split(/ +/);
  if (parts[0]?.toLowerCase() !== 'bearer') return { claims: null, hadToken: false };
  const token = parts.slice(1).join(' ').trim();
  if (!token) return { claims: null, hadToken: false };
  try {
    return { claims: await verifyToken(token), hadToken: true };
  } catch {
    return { claims: null, hadToken: true };
  }
}

const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const { claims, hadToken } = await authFromHeader(c);
  if (!claims) throw hadToken ? ApiError.unauthorized('Invalid or expired token') : ApiError.unauthorized();
  c.set('user', claims);
  await next();
};

const optionalAuth: MiddlewareHandler<Env> = async (c, next) => {
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
const credentialLimiter = makeLimiter(15 * 60_000, 20);
const geocodeLimiterFn = makeLimiter(60_000, 30);
function clientIp(c: Context): string {
  return (c.req.header('x-forwarded-for')?.split(',')[0]?.trim()) || 'unknown';
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
app.post('/api/auth/register', async (c) => {
  if (!credentialLimiter(clientIp(c))) throw ApiError.tooManyRequests('Too many authentication attempts, please try again later');
  const { username, email, password, display_name } = registerSchema.parse(await jsonBody(c));

  const existing = await queryOne('SELECT 1 FROM users WHERE username = $1 OR email = $2', [username, email]);
  if (existing) throw ApiError.conflict('Username or email already taken');

  const password_hash = await hashPassword(password);
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO users (username, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING ${USER_SELECT}`,
    [username, email, password_hash, display_name],
  );
  const user = mapUser(row!);
  await query('INSERT INTO user_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
  const token = await signToken({ sub: user.id, username: user.username });
  return c.json({ user, token }, 201);
});

app.post('/api/auth/login', async (c) => {
  if (!credentialLimiter(clientIp(c))) throw ApiError.tooManyRequests('Too many authentication attempts, please try again later');
  const { identifier, password } = loginSchema.parse(await jsonBody(c));
  const row = await queryOne<Record<string, unknown> & { password_hash: string }>(
    `SELECT ${USER_SELECT}, password_hash FROM users WHERE username = $1 OR email = $1`,
    [identifier],
  );
  if (!row) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw ApiError.unauthorized('Invalid credentials');
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw ApiError.unauthorized('Invalid credentials');
  const user = mapUser(row);
  const token = await signToken({ sub: user.id, username: user.username });
  return c.json({ user, token });
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

  const conditions: string[] = [];
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
  const previousControllerId = body.court_id ? await getCourtController(body.court_id) : null;

  const matchId = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO matches
         (user_id, opponent_id, opponent_name, court_id, surface, score_array, result,
          sets_won, sets_lost, games_won, games_lost, match_score, streak_modifier,
          rpe_index, duration_minutes, notes, is_tiebreak, played_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,0,1,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        userId,
        body.opponent_id ?? null,
        body.opponent_id ? null : body.opponent_name ?? null,
        body.court_id ?? null,
        body.surface,
        JSON.stringify(body.score_array),
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

    const streak = await recomputeUserStreak(userId, client);
    const score = matchScore(analysis.gamesWon, analysis.gamesLost, streak.streakModifier);

    const { userDelta } = await applyMatchToRatings(client, {
      userId,
      opponentId: body.opponent_id ?? null,
      surface: body.surface,
      result: analysis.result,
      gamesWon: analysis.gamesWon,
      gamesLost: analysis.gamesLost,
    });

    await client.query(
      'UPDATE matches SET streak_modifier = $1, match_score = $2, user_rating_delta = $3 WHERE id = $4',
      [streak.streakModifier, score, userDelta, id],
    );
    return id;
  });

  // Post-commit side effects must NOT fail the request (the match is durably
  // committed; a retry would double-log). Each is isolated; the 6-hourly sweep
  // backstops territory.
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

  if (body.opponent_id && body.opponent_id !== userId) {
    await notify({
      userId: body.opponent_id,
      type: 'match_tagged',
      title: '🎾 You were in a match',
      body: `${c.get('user')!.username} logged a match against you.`,
      data: { matchId },
      push: false,
    }).catch(() => {});
  }

  const card = await fetchMatchCard(matchId, userId);
  return c.json({ match: card }, 201);
});

app.get('/api/matches/:id', optionalAuth, async (c) => {
  const card = await fetchMatchCard(c.req.param('id'), c.get('user')?.sub ?? null);
  if (!card) throw ApiError.notFound('Match not found');
  return c.json({ match: card });
});

app.delete('/api/matches/:id', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const match = await queryOne<{
    user_id: string;
    court_id: string | null;
    opponent_id: string | null;
    surface: import('./types.ts').Surface;
    result: import('./types.ts').MatchResult;
    games_won: number;
    games_lost: number;
    user_rating_delta: number | null;
  }>(
    `SELECT user_id, court_id, opponent_id, surface, result, games_won, games_lost, user_rating_delta
       FROM matches WHERE id = $1`,
    [id],
  );
  if (!match) throw ApiError.notFound('Match not found');
  if (match.user_id !== userId) throw ApiError.forbidden('You can only delete your own matches');

  const previousControllerId = match.court_id ? await getCourtController(match.court_id) : null;

  await withTransaction(async (client) => {
    await client.query('DELETE FROM matches WHERE id = $1', [id]);
    await reverseMatchFromRatings(client, {
      userId,
      surface: match.surface,
      result: match.result,
      gamesWon: Number(match.games_won),
      gamesLost: Number(match.games_lost),
      appliedDelta: match.user_rating_delta == null ? null : Number(match.user_rating_delta),
    });
    await recomputeUserStreak(userId, client);
  });

  if (match.court_id) {
    await recomputeAfterMatch({ courtId: match.court_id, loggerUserId: userId, previousControllerId });
  }
  return c.body(null, 204);
});

app.post('/api/matches/:id/kudos', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const match = await queryOne<{ user_id: string }>('SELECT user_id FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');

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
  const params: unknown[] = [id];
  let extra = '';
  if (before) {
    params.push(before);
    extra = `AND c.created_at < $${params.length}`;
  }
  params.push(limit);
  const rows = await query(
    `SELECT c.id, c.body, c.created_at, c.user_id,
            u.username, u.display_name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.match_id = $1 ${extra}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return c.json({ comments: rows.reverse() });
});

app.post('/api/matches/:id/comments', requireAuth, async (c) => {
  const userId = uid(c);
  const id = c.req.param('id');
  const { body } = commentSchema.parse(await jsonBody(c));
  const match = await queryOne<{ user_id: string }>('SELECT user_id FROM matches WHERE id = $1', [id]);
  if (!match) throw ApiError.notFound('Match not found');

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

// ─── Courts ────────────────────────────────────────────────────────────────
const COURT_COLS = `id, name, description, surface, ST_Y(geom) AS lat, ST_X(geom) AS lng,
                    address, city, osm_id, created_by, created_at`;

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
    `INSERT INTO courts (name, description, surface, geom, address, city, osm_id, created_by)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8, $9)
     RETURNING ${COURT_COLS}`,
    [b.name, b.description ?? null, b.surface, b.lng, b.lat, b.address ?? null, b.city ?? null, b.osm_id ?? null, uid(c)],
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
  if (b.dominant_hand !== undefined) { sets.push(`dominant_hand = $${i++}`); params.push(b.dominant_hand); }
  if (b.home !== undefined) {
    sets.push(`home_geom = ST_SetSRID(ST_MakePoint($${i++}, $${i++}), 4326)`);
    params.push(b.home.lng, b.home.lat);
    sets.push(`home_label = $${i++}`);
    params.push(b.home.label ?? null);
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

app.delete('/api/users/me/push-token', requireAuth, async (c) => {
  const userId = uid(c);
  const token = (await jsonBody<{ token?: string }>(c)).token;
  if (token) await query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [userId, token]);
  return c.body(null, 204);
});

app.delete('/api/users/me', requireAuth, async (c) => {
  await query('DELETE FROM users WHERE id = $1', [uid(c)]);
  return c.body(null, 204);
});

app.get('/api/users/:username', optionalAuth, async (c) => {
  const viewerId = c.get('user')?.sub ?? null;
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${USER_SELECT},
            (SELECT COUNT(*) FROM matches  WHERE user_id = u.id)     AS match_count,
            (SELECT COUNT(*) FROM follows  WHERE following_id = u.id) AS follower_count,
            (SELECT COUNT(*) FROM follows  WHERE follower_id = u.id)  AS following_count,
            (SELECT COUNT(*) FROM territories WHERE user_id = u.id)   AS territory_count,
            CASE WHEN $2::uuid IS NULL THEN false
                 ELSE EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id)
            END AS viewer_is_following
       FROM users u WHERE u.username = $1`,
    [c.req.param('username'), viewerId],
  );
  if (!row) throw ApiError.notFound('User not found');

  const isSelf = viewerId != null && viewerId === (row.id as string);
  return c.json({
    user: isSelf ? mapUser(row) : mapPublicUser(row),
    stats: {
      match_count: Number(row.match_count),
      follower_count: Number(row.follower_count),
      following_count: Number(row.following_count),
      territory_count: Number(row.territory_count),
    },
    viewer_is_following: Boolean(row.viewer_is_following),
  });
});

app.post('/api/users/:username/follow', requireAuth, async (c) => {
  const userId = uid(c);
  const targetId = await resolveUserId(c.req.param('username'));
  if (targetId === userId) throw ApiError.badRequest('You cannot follow yourself');
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

app.get('/api/users/:username/analytics', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ analytics: await getProfileAnalytics(id) });
});
app.get('/api/users/:username/ratings', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ ratings: await getRatings(id) });
});
app.get('/api/users/:username/achievements', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ achievements: await getAchievements(id) });
});
app.get('/api/users/:username/streak', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ streak: await getStreakState(id) });
});
app.get('/api/users/:username/head-to-head', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ head_to_head: await getHeadToHead(id) });
});
app.get('/api/users/:username/territories', async (c) => {
  const id = await resolveUserId(c.req.param('username'));
  return c.json({ territories: await getUserTerritories(id) });
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
  throw ApiError.badRequest('type must be streak or territory');
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

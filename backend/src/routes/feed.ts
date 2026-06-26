import { Router } from 'express';
import { query } from '../db/pool.js';
import { mapMatchCard } from '../db/mappers.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery, validatedQuery } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/errors.js';
import { feedQuerySchema } from '../validation/schemas.js';
import type { MatchCard } from '../types/index.js';
import type { z } from 'zod';

export const feedRouter = Router();

/** Opaque keyset cursor encoding the last seen (played_at, id) pair. */
interface Cursor {
  t: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
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

/** Build the next-page cursor when (and only when) a further page exists. */
function nextCursor(rows: MatchCard[], hasMore: boolean): string | null {
  if (!hasMore || rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  return encodeCursor({ t: last.played_at, id: last.id });
}

/**
 * Paginated match-card feed. `scope=global` shows everyone; `scope=following`
 * shows the viewer + people they follow. Keyset pagination by (played_at, id)
 * keeps scrolling cheap and avoids skipping/duplicating rows that share a
 * timestamp.
 */
feedRouter.get(
  '/',
  optionalAuth,
  validateQuery(feedQuerySchema),
  asyncHandler(async (req, res) => {
    const { scope, limit, before } = validatedQuery<z.infer<typeof feedQuerySchema>>(req);
    const viewerId = req.user?.sub ?? null;

    if (scope === 'following' && !viewerId) throw ApiError.unauthorized('Sign in to view your following feed');

    const conditions: string[] = [];
    const params: unknown[] = [viewerId];
    let p = params.length;

    if (scope === 'following') {
      conditions.push(
        `(mf.user_id = $1 OR mf.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1))`,
      );
    }
    if (before) {
      const cursor = decodeCursor(before);
      params.push(cursor.t, cursor.id);
      conditions.push(`(mf.played_at, mf.id) < ($${++p}::timestamptz, $${++p}::uuid)`);
    }
    params.push(limit + 1); // fetch one extra to detect a further page
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
    res.json({ matches, next_cursor: nextCursor(matches, hasMore) });
  }),
);

/** A single user's match history (used by their profile). */
feedRouter.get(
  '/user/:userId',
  optionalAuth,
  validateQuery(feedQuerySchema),
  asyncHandler(async (req, res) => {
    const { limit, before } = validatedQuery<z.infer<typeof feedQuerySchema>>(req);
    const viewerId = req.user?.sub ?? null;
    const params: unknown[] = [viewerId, req.params.userId];
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
    res.json({ matches, next_cursor: nextCursor(matches, hasMore) });
  }),
);

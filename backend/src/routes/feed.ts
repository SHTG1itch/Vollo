import { Router } from 'express';
import { query } from '../db/pool.js';
import { mapMatchCard } from '../db/mappers.js';
import { optionalAuth } from '../middleware/auth.js';
import { validateQuery, validatedQuery } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/errors.js';
import { feedQuerySchema } from '../validation/schemas.js';
import type { z } from 'zod';

export const feedRouter = Router();

/**
 * Paginated match-card feed. `scope=global` shows everyone; `scope=following`
 * shows the viewer + people they follow. Cursor pagination by played_at keeps
 * scrolling cheap for FlashList on the client.
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
      params.push(before);
      conditions.push(`mf.played_at < $${++p}`);
    }
    params.push(limit);
    const limitIdx = ++p;

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await query<Record<string, unknown>>(
      `SELECT mf.*,
              CASE WHEN $1::uuid IS NULL THEN false
                   ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
              END AS viewer_has_kudos
         FROM match_feed mf
         ${where}
        ORDER BY mf.played_at DESC
        LIMIT $${limitIdx}`,
      params,
    );

    const matches = rows.map(mapMatchCard);
    const nextCursor = matches.length === limit ? matches[matches.length - 1]!.played_at : null;
    res.json({ matches, next_cursor: nextCursor });
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
    let extra = '';
    if (before) {
      params.push(before);
      extra = `AND mf.played_at < $3`;
    }
    params.push(limit);
    const rows = await query<Record<string, unknown>>(
      `SELECT mf.*,
              CASE WHEN $1::uuid IS NULL THEN false
                   ELSE EXISTS(SELECT 1 FROM kudos k WHERE k.match_id = mf.id AND k.user_id = $1)
              END AS viewer_has_kudos
         FROM match_feed mf
        WHERE mf.user_id = $2 ${extra}
        ORDER BY mf.played_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const matches = rows.map(mapMatchCard);
    const nextCursor = matches.length === limit ? matches[matches.length - 1]!.played_at : null;
    res.json({ matches, next_cursor: nextCursor });
  }),
);

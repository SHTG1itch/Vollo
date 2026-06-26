import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { mapUser } from '../db/mappers.js';
import { optionalAuth, requireAuth, userId } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/errors.js';
import { pushTokenSchema, updateProfileSchema } from '../validation/schemas.js';
import { getProfileAnalytics, getHeadToHead } from '../services/analytics.js';
import { getRatings } from '../services/rating.js';
import { getAchievements } from '../services/achievements.js';
import { getStreakState } from '../services/streak.js';
import { getUserTerritories } from '../services/territory.js';
import { notify } from '../services/notifications.js';

export const usersRouter = Router();

const USER_SELECT = `
  id, username, email, display_name, avatar_url, bio, dominant_hand,
  ST_Y(home_geom) AS home_lat, ST_X(home_geom) AS home_lng, home_label, created_at
`;

async function resolveUserId(username: string): Promise<string> {
  const row = await queryOne<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  if (!row) throw ApiError.notFound('User not found');
  return row.id;
}

// ─── Update own profile ────────────────────────────────────────────────────
usersRouter.patch(
  '/me',
  requireAuth,
  validateBody(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const b = req.body as import('zod').infer<typeof updateProfileSchema>;
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
      const current = await queryOne<Record<string, unknown>>(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [uid]);
      res.json({ user: mapUser(current!) });
      return;
    }

    params.push(uid);
    const row = await queryOne<Record<string, unknown>>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${USER_SELECT}`,
      params,
    );
    res.json({ user: mapUser(row!) });
  }),
);

// ─── Push token registration (Expo) ────────────────────────────────────────
usersRouter.post(
  '/me/push-token',
  requireAuth,
  validateBody(pushTokenSchema),
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const { token, platform } = req.body as import('zod').infer<typeof pushTokenSchema>;
    await query(
      `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform`,
      [uid, token, platform ?? 'expo'],
    );
    res.status(201).json({ ok: true });
  }),
);

usersRouter.delete(
  '/me/push-token',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const token = req.body?.token as string | undefined;
    if (token) await query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [uid, token]);
    res.status(204).end();
  }),
);

// ─── Public profile ────────────────────────────────────────────────────────
usersRouter.get(
  '/:username',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const viewerId = req.user?.sub ?? null;
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
      [req.params.username, viewerId],
    );
    if (!row) throw ApiError.notFound('User not found');

    res.json({
      user: mapUser(row),
      stats: {
        match_count: Number(row.match_count),
        follower_count: Number(row.follower_count),
        following_count: Number(row.following_count),
        territory_count: Number(row.territory_count),
      },
      viewer_is_following: Boolean(row.viewer_is_following),
    });
  }),
);

// ─── Follow / unfollow ─────────────────────────────────────────────────────
usersRouter.post(
  '/:username/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const targetId = await resolveUserId(req.params.username);
    if (targetId === uid) throw ApiError.badRequest('You cannot follow yourself');
    const inserted = await queryOne(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING follower_id`,
      [uid, targetId],
    );
    // Only notify on a genuinely new follow — re-tapping shouldn't spam the user.
    if (inserted) {
      void notify({
        userId: targetId,
        type: 'follow',
        title: '👋 New follower',
        body: `${req.user!.username} started following you.`,
        data: { followerId: uid },
        push: false,
      });
    }
    res.status(201).json({ ok: true });
  }),
);

usersRouter.delete(
  '/:username/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const targetId = await resolveUserId(req.params.username);
    await query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [uid, targetId]);
    res.status(204).end();
  }),
);

// ─── Analytics surface area (all keyed by username) ─────────────────────────
usersRouter.get(
  '/:username/analytics',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ analytics: await getProfileAnalytics(id) });
  }),
);

usersRouter.get(
  '/:username/ratings',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ ratings: await getRatings(id) });
  }),
);

usersRouter.get(
  '/:username/achievements',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ achievements: await getAchievements(id) });
  }),
);

usersRouter.get(
  '/:username/streak',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ streak: await getStreakState(id) });
  }),
);

usersRouter.get(
  '/:username/head-to-head',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ head_to_head: await getHeadToHead(id) });
  }),
);

usersRouter.get(
  '/:username/territories',
  asyncHandler(async (req, res) => {
    const id = await resolveUserId(req.params.username);
    res.json({ territories: await getUserTerritories(id) });
  }),
);

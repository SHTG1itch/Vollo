import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const notifications = await query(
      `SELECT id, type, title, body, data, read, created_at
         FROM notifications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [uid],
    );
    const unread = await queryOne<{ c: string }>(
      'SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1 AND read = false',
      [uid],
    );
    res.json({ notifications, unread_count: Number(unread?.c ?? 0) });
  }),
);

notificationsRouter.post(
  '/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : null;
    if (ids && ids.length > 0) {
      await query('UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2::uuid[])', [uid, ids]);
    } else {
      await query('UPDATE notifications SET read = true WHERE user_id = $1', [uid]);
    }
    res.json({ ok: true });
  }),
);

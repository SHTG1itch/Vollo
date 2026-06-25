import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { mapUser } from '../db/mappers.js';
import { requireAuth, userId } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { hashPassword, signToken, verifyPassword } from '../utils/auth.js';
import { ApiError } from '../utils/errors.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';

const USER_SELECT = `
  id, username, email, display_name, avatar_url, bio, dominant_hand,
  ST_Y(home_geom) AS home_lat, ST_X(home_geom) AS home_lng, home_label, created_at
`;

export const authRouter = Router();

authRouter.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { username, email, password, display_name } = req.body;

    const existing = await queryOne(
      'SELECT 1 FROM users WHERE username = $1 OR email = $2',
      [username, email],
    );
    if (existing) throw ApiError.conflict('Username or email already taken');

    const password_hash = await hashPassword(password);
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING ${USER_SELECT}`,
      [username, email, password_hash, display_name],
    );
    const user = mapUser(row!);

    // Seed a streak row so the modifier defaults cleanly.
    await query('INSERT INTO user_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);

    const token = signToken({ sub: user.id, username: user.username });
    res.status(201).json({ user, token });
  }),
);

authRouter.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;
    const row = await queryOne<Record<string, unknown> & { password_hash: string }>(
      `SELECT ${USER_SELECT}, password_hash FROM users WHERE username = $1 OR email = $1`,
      [identifier],
    );
    if (!row) throw ApiError.unauthorized('Invalid credentials');

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) throw ApiError.unauthorized('Invalid credentials');

    const user = mapUser(row);
    const token = signToken({ sub: user.id, username: user.username });
    res.json({ user, token });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT ${USER_SELECT} FROM users WHERE id = $1`,
      [userId(req)],
    );
    if (!row) throw ApiError.notFound('User not found');
    res.json({ user: mapUser(row) });
  }),
);

export { USER_SELECT };

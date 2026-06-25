import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { mapCourt } from '../db/mappers.js';
import { optionalAuth, requireAuth, userId } from '../middleware/auth.js';
import { validateBody, validateQuery, validatedQuery } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/errors.js';
import { courtsQuerySchema, createCourtSchema, geocodeQuerySchema } from '../validation/schemas.js';
import { geocode } from '../services/geocoding.js';
import type { LeaderboardEntry } from '../types/index.js';
import type { z } from 'zod';

export const courtsRouter = Router();

const COURT_COLS = `id, name, description, surface, ST_Y(geom) AS lat, ST_X(geom) AS lng,
                    address, city, osm_id, created_by, created_at`;

// ─── Geocode proxy (free Nominatim / Geoapify) ─────────────────────────────
courtsRouter.get(
  '/geocode',
  validateQuery(geocodeQuerySchema),
  asyncHandler(async (req, res) => {
    const { q, limit } = validatedQuery<z.infer<typeof geocodeQuerySchema>>(req);
    const results = await geocode(q, limit);
    res.json({ results });
  }),
);

// ─── List / search / nearby courts ─────────────────────────────────────────
courtsRouter.get(
  '/',
  validateQuery(courtsQuerySchema),
  asyncHandler(async (req, res) => {
    const { lat, lng, radius_km, q, limit } = validatedQuery<z.infer<typeof courtsQuerySchema>>(req);

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
      res.json({ courts: rows.map((r) => ({ ...mapCourt(r), distance_km: Number(r.distance_km) })) });
      return;
    }

    if (q) {
      const rows = await query<Record<string, unknown>>(
        `SELECT ${COURT_COLS} FROM courts
          WHERE name ILIKE '%' || $1 || '%' OR city ILIKE '%' || $1 || '%'
          ORDER BY name ASC LIMIT $2`,
        [q, limit],
      );
      res.json({ courts: rows.map(mapCourt) });
      return;
    }

    const rows = await query<Record<string, unknown>>(
      `SELECT ${COURT_COLS} FROM courts ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ courts: rows.map(mapCourt) });
  }),
);

// ─── Create a court ────────────────────────────────────────────────────────
courtsRouter.post(
  '/',
  requireAuth,
  validateBody(createCourtSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof createCourtSchema>;
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO courts (name, description, surface, geom, address, city, osm_id, created_by)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8, $9)
       RETURNING ${COURT_COLS}`,
      [b.name, b.description ?? null, b.surface, b.lng, b.lat, b.address ?? null, b.city ?? null, b.osm_id ?? null, userId(req)],
    );
    res.status(201).json({ court: mapCourt(row!) });
  }),
);

// ─── Court detail (+ current controller) ───────────────────────────────────
courtsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT ${COURT_COLS} FROM courts WHERE id = $1`,
      [req.params.id],
    );
    if (!row) throw ApiError.notFound('Court not found');

    const controller = await queryOne<{ user_id: string; username: string; display_name: string; score: string }>(
      `SELECT cl.user_id, u.username, u.display_name, cl.score
         FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
        WHERE cl.court_id = $1 AND cl.rank = 1
        ORDER BY cl.score DESC LIMIT 1`,
      [req.params.id],
    );

    res.json({
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
  }),
);

// ─── Court leaderboard (trailing 30-day window) ────────────────────────────
courtsRouter.get(
  '/:id/leaderboard',
  asyncHandler(async (req, res) => {
    const rows = await query<Record<string, unknown>>(
      `SELECT cl.court_id, cl.user_id, cl.score, cl.matches_played, cl.wins, cl.losses,
              cl.games_won, cl.games_lost, cl.rank, cl.last_played_at,
              u.username, u.display_name, u.avatar_url
         FROM court_leaderboard cl JOIN users u ON u.id = cl.user_id
        WHERE cl.court_id = $1
        ORDER BY cl.rank ASC, cl.score DESC
        LIMIT 100`,
      [req.params.id],
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
      last_played_at: String(r.last_played_at),
    }));
    res.json({ leaderboard });
  }),
);

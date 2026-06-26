import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { mapMatchCard } from '../db/mappers.js';
import { optionalAuth, requireAuth, userId } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/errors.js';
import { commentSchema, createMatchSchema } from '../validation/schemas.js';
import { analyzeScore, matchScore } from '../services/scoring.js';
import { recomputeUserStreak } from '../services/streak.js';
import { applyMatchToRatings, reverseMatchFromRatings } from '../services/rating.js';
import { evaluateAchievements } from '../services/achievements.js';
import { getCourtController, recomputeAfterMatch } from '../services/territory.js';
import { notify } from '../services/notifications.js';
import type { MatchStats } from '../types/index.js';

export const matchesRouter = Router();

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

// ─── Log a match ─────────────────────────────────────────────────────────
matchesRouter.post(
  '/',
  requireAuth,
  validateBody(createMatchSchema),
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const body = req.body as import('../validation/schemas.js').CreateMatchInput;

    // A score that passes Zod can still be an invalid scoreline (e.g. a tie) —
    // surface that as a 400, not a 500.
    let analysis;
    try {
      analysis = analyzeScore(body.score_array);
    } catch (err) {
      throw ApiError.badRequest(err instanceof Error ? err.message : 'Invalid score');
    }

    if (body.opponent_id && body.opponent_id === uid) {
      throw ApiError.badRequest('You cannot log a match against yourself');
    }

    const playedAt = body.played_at ?? new Date().toISOString();
    const isTiebreak = body.is_tiebreak ?? analysis.isTiebreak;

    // Capture the court's current controller BEFORE the new match shifts ranks.
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
          uid,
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

      // Recompute the streak inside the transaction (it now sees this match) so
      // the final match_score is written atomically with the insert — no window
      // where a crash could leave the match stuck at score 0.
      const streak = await recomputeUserStreak(uid, client);
      const score = matchScore(analysis.gamesWon, analysis.gamesLost, streak.streakModifier);

      const { userDelta } = await applyMatchToRatings(client, {
        userId: uid,
        opponentId: body.opponent_id ?? null,
        surface: body.surface,
        result: analysis.result,
        gamesWon: analysis.gamesWon,
        gamesLost: analysis.gamesLost,
      });

      // Persist streak modifier, court score, and the exact Elo delta together so
      // a later deletion can back the rating out precisely.
      await client.query(
        'UPDATE matches SET streak_modifier = $1, match_score = $2, user_rating_delta = $3 WHERE id = $4',
        [streak.streakModifier, score, userDelta, id],
      );

      return id;
    });

    // Post-commit side effects must NOT fail the request: the match is already
    // durably committed, so a PostGIS-hull or achievement hiccup that 500'd here
    // would invite a client retry that double-logs the match. Best-effort only —
    // the 6-hourly territory sweep is the backstop for any missed recompute.
    try {
      if (body.court_id) {
        await recomputeAfterMatch({ courtId: body.court_id, loggerUserId: uid, previousControllerId });
      }
      await evaluateAchievements(uid);
    } catch (err) {
      console.error('[matches] post-commit side effects failed', err instanceof Error ? err.message : err);
    }

    // Notify a registered opponent that they were tagged in a match.
    if (body.opponent_id && body.opponent_id !== uid) {
      void notify({
        userId: body.opponent_id,
        type: 'match_tagged',
        title: '🎾 You were in a match',
        body: `${req.user!.username} logged a match against you.`,
        data: { matchId },
        push: false,
      });
    }

    const card = await fetchMatchCard(matchId, uid);
    res.status(201).json({ match: card });
  }),
);

// ─── Get one match ─────────────────────────────────────────────────────────
matchesRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const card = await fetchMatchCard(req.params.id, req.user?.sub ?? null);
    if (!card) throw ApiError.notFound('Match not found');
    res.json({ match: card });
  }),
);

// ─── Delete a match (owner only) ───────────────────────────────────────────
matchesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const match = await queryOne<{
      user_id: string;
      court_id: string | null;
      opponent_id: string | null;
      surface: import('../types/index.js').Surface;
      result: import('../types/index.js').MatchResult;
      games_won: number;
      games_lost: number;
      user_rating_delta: number | null;
    }>(
      `SELECT user_id, court_id, opponent_id, surface, result, games_won, games_lost, user_rating_delta
         FROM matches WHERE id = $1`,
      [req.params.id],
    );
    if (!match) throw ApiError.notFound('Match not found');
    if (match.user_id !== uid) throw ApiError.forbidden('You can only delete your own matches');

    // Capture the controller before the delete shifts ranks, so the takeover
    // notification only fires if control actually changes.
    const previousControllerId = match.court_id ? await getCourtController(match.court_id) : null;

    // Delete and back out the rating impact atomically.
    await withTransaction(async (client) => {
      await client.query('DELETE FROM matches WHERE id = $1', [req.params.id]);
      await reverseMatchFromRatings(client, {
        userId: uid,
        surface: match.surface,
        result: match.result,
        gamesWon: Number(match.games_won),
        gamesLost: Number(match.games_lost),
        appliedDelta: match.user_rating_delta == null ? null : Number(match.user_rating_delta),
      });
      await recomputeUserStreak(uid, client);
    });

    if (match.court_id) {
      await recomputeAfterMatch({ courtId: match.court_id, loggerUserId: uid, previousControllerId });
    }
    res.status(204).end();
  }),
);

// ─── Kudos (optimistic on the client; idempotent here) ─────────────────────
matchesRouter.post(
  '/:id/kudos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const match = await queryOne<{ user_id: string }>('SELECT user_id FROM matches WHERE id = $1', [
      req.params.id,
    ]);
    if (!match) throw ApiError.notFound('Match not found');

    await query(
      'INSERT INTO kudos (match_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, uid],
    );
    const countRow = await queryOne<{ c: string }>('SELECT COUNT(*) AS c FROM kudos WHERE match_id = $1', [
      req.params.id,
    ]);

    if (match.user_id !== uid) {
      void notify({
        userId: match.user_id,
        type: 'kudos',
        title: '🎾 New kudos',
        body: `${req.user!.username} gave your match kudos.`,
        data: { matchId: req.params.id },
        push: false,
      });
    }
    res.json({ kudos_count: Number(countRow?.c ?? 0), viewer_has_kudos: true });
  }),
);

matchesRouter.delete(
  '/:id/kudos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    await query('DELETE FROM kudos WHERE match_id = $1 AND user_id = $2', [req.params.id, uid]);
    const countRow = await queryOne<{ c: string }>('SELECT COUNT(*) AS c FROM kudos WHERE match_id = $1', [
      req.params.id,
    ]);
    res.json({ kudos_count: Number(countRow?.c ?? 0), viewer_has_kudos: false });
  }),
);

// ─── Comments ──────────────────────────────────────────────────────────────
matchesRouter.get(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const comments = await query(
      `SELECT c.id, c.body, c.created_at, c.user_id,
              u.username, u.display_name, u.avatar_url
         FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.match_id = $1 ORDER BY c.created_at ASC`,
      [req.params.id],
    );
    res.json({ comments });
  }),
);

matchesRouter.post(
  '/:id/comments',
  requireAuth,
  validateBody(commentSchema),
  asyncHandler(async (req, res) => {
    const uid = userId(req);
    const match = await queryOne<{ user_id: string }>('SELECT user_id FROM matches WHERE id = $1', [
      req.params.id,
    ]);
    if (!match) throw ApiError.notFound('Match not found');

    const comment = await queryOne(
      `WITH inserted AS (
         INSERT INTO comments (match_id, user_id, body) VALUES ($1, $2, $3) RETURNING *
       )
       SELECT i.id, i.body, i.created_at, i.user_id, u.username, u.display_name, u.avatar_url
         FROM inserted i JOIN users u ON u.id = i.user_id`,
      [req.params.id, uid, req.body.body],
    );

    if (match.user_id !== uid) {
      void notify({
        userId: match.user_id,
        type: 'comment',
        title: '💬 New comment',
        body: `${req.user!.username} commented on your match.`,
        data: { matchId: req.params.id },
        push: false,
      });
    }
    res.status(201).json({ comment });
  }),
);

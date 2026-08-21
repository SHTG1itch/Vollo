import type { Queryable } from './db.ts';
import { pool } from './db.ts';
import { DEFAULT_RATING, DEFAULT_RD, replayRating, type Posterior } from './rating-model.ts';
import type { MatchResult, Surface, SurfaceRating } from './types.ts';

export { bayesianUpdate, expectedScore, marginMultiplier } from './rating-model.ts';

// ════════════════════════════════════════════════════════════════════════
// Bayesian skill rating (Glicko-style).
//
// Each (player, surface) skill is a Gaussian posterior  θ ~ N(μ, σ²)  where
// μ is the rating and σ the *rating deviation* (RD) — the model's uncertainty.
// Every counting match is a Bayesian update layer: the posterior precision is
// the prior precision PLUS the match's information precision, and the posterior
// mean is the precision-weighted blend of the prior mean and the match evidence
// (Glicko's closed form is exactly this Gaussian update). Uncertainty therefore
// shrinks as evidence accumulates, so a provisional player's rating moves fast
// and a seasoned one barely budges — far more accurate than a fixed-K Elo.
//
// Ratings are a pure function of match history, so they're recomputed by
// replaying a player's matches in chronological order (`recomputeUserRatings`),
// which makes deletion exact with no fragile delta-reversal.
// ════════════════════════════════════════════════════════════════════════

interface ReplayMatch {
  surface: Surface;
  result: MatchResult;
  games_won: number;
  games_lost: number;
  match_format: 'singles' | 'doubles';
  opponent_id: string | null;
  opponent2_id: string | null;
}

/**
 * Recompute a player's per-surface Bayesian ratings from their full match
 * history (counting matches only — auto/verified). Replays each surface's
 * matches in chronological order from the prior, applying one Bayesian update
 * per match against the opponent's *current* posterior (default prior for
 * off-app opponents). This is the single source of truth for ratings — called
 * after a match counts and after a delete — so no incremental delta bookkeeping
 * or reversal is needed.
 */
export async function recomputeUserRatings(db: Queryable, userId: string): Promise<void> {
  // Serialize concurrent recomputes for this user. The replay is a read-then-
  // absolute-write, so two overlapping same-user transactions (e.g. a DELETE
  // racing a POST/verify) could otherwise lose an update under READ COMMITTED.
  // A per-user xact advisory lock makes the second wait, then re-read full
  // history on a fresh post-commit snapshot. Mutation paths and the sweep pass
  // a transaction-bound client, so the lock spans the replay and all writes.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [userId]);

  // Inline row type (a named interface here wouldn't satisfy the driver's Row
  // constraint). Structurally a ReplayMatch.
  const { rows: matches } = await db.query<{
    surface: Surface;
    result: MatchResult;
    games_won: number;
    games_lost: number;
    match_format: 'singles' | 'doubles';
    opponent_id: string | null;
    opponent2_id: string | null;
  }>(
    `SELECT surface, result, games_won, games_lost, match_format, opponent_id, opponent2_id
       FROM matches
      WHERE user_id = $1 AND verification_status IN ('auto', 'verified')
      ORDER BY played_at ASC, id ASC`,
    [userId],
  );

  // Batch-load opponents' current posteriors so the replay needs no per-match
  // query. Keyed by `${opponentId}|${surface}`.
  const oppIds = [...new Set(matches.flatMap((m) => [m.opponent_id, m.opponent2_id]).filter((x): x is string => !!x))];
  const oppMap = new Map<string, Posterior>();
  if (oppIds.length > 0) {
    const { rows: oppRows } = await db.query<{ user_id: string; surface: Surface; rating: string; rating_deviation: string }>(
      'SELECT user_id, surface, rating, rating_deviation FROM user_ratings WHERE user_id = ANY($1::uuid[])',
      [oppIds],
    );
    for (const r of oppRows) {
      oppMap.set(`${r.user_id}|${r.surface}`, { mu: Number(r.rating), rd: Number(r.rating_deviation) });
    }
  }

  // Group by surface, replay each.
  const bySurface = new Map<Surface, ReplayMatch[]>();
  for (const m of matches) {
    const arr = bySurface.get(m.surface) ?? [];
    arr.push(m);
    bySurface.set(m.surface, arr);
  }

  const touchedSurfaces: Surface[] = [];
  for (const [surface, ms] of bySurface) {
    const replay = replayRating(ms.map((m) => ({
      result: m.result,
      gamesWon: Number(m.games_won),
      gamesLost: Number(m.games_lost),
      opponent: (() => {
        const ids = m.match_format === 'doubles' ? [m.opponent_id, m.opponent2_id] : [m.opponent_id];
        const ratings = ids.map((id) => (id ? oppMap.get(`${id}|${surface}`) : null) ?? {
          mu: DEFAULT_RATING,
          rd: DEFAULT_RD,
        });
        return {
          mu: ratings.reduce((sum, r) => sum + r.mu, 0) / ratings.length,
          rd: ratings.reduce((sum, r) => sum + r.rd, 0) / ratings.length,
        };
      })(),
    })));
    const ratingVal = Math.round(replay.posterior.mu);
    const rdVal = Math.round(replay.posterior.rd);
    await db.query(
      `INSERT INTO user_ratings (user_id, surface, rating, rating_deviation, matches_played, wins, losses, peak_rating)
       VALUES ($1, $2, $3::numeric, $4::numeric, $5::int, $6::int, $7::int, $8::numeric)
       ON CONFLICT (user_id, surface) DO UPDATE SET
         rating          = EXCLUDED.rating,
         rating_deviation= EXCLUDED.rating_deviation,
         matches_played  = EXCLUDED.matches_played,
         wins            = EXCLUDED.wins,
         losses          = EXCLUDED.losses,
         peak_rating     = EXCLUDED.peak_rating`,
      [userId, surface, ratingVal, rdVal, ms.length, replay.wins, replay.losses, Math.round(replay.peak)],
    );
    touchedSurfaces.push(surface);
  }

  // Drop rating rows for surfaces that no longer have any counting match (e.g.
  // after the last match on a surface is deleted) so a stale rating can't linger.
  if (touchedSurfaces.length > 0) {
    await db.query(
      'DELETE FROM user_ratings WHERE user_id = $1 AND surface <> ALL($2::surface_type[])',
      [userId, touchedSurfaces],
    );
  } else {
    await db.query('DELETE FROM user_ratings WHERE user_id = $1', [userId]);
  }
}

export async function getRatings(userId: string): Promise<SurfaceRating[]> {
  const { rows } = await pool.query<{
    surface: Surface;
    rating: string;
    rating_deviation: string;
    matches_played: number;
    wins: number;
    losses: number;
    peak_rating: string;
  }>(
    `SELECT surface, rating, rating_deviation, matches_played, wins, losses, peak_rating
       FROM user_ratings WHERE user_id = $1 ORDER BY surface`,
    [userId],
  );
  return rows.map((r) => ({
    surface: r.surface,
    rating: Number(r.rating),
    rating_deviation: Number(r.rating_deviation),
    matches_played: r.matches_played,
    wins: r.wins,
    losses: r.losses,
    peak_rating: Number(r.peak_rating),
  }));
}

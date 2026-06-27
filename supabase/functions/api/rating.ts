import type { Queryable } from './db.ts';
import { pool } from './db.ts';
import type { MatchResult, Surface, SurfaceRating } from './types.ts';

const DEFAULT_RATING = 1000;
const K_FACTOR = 32;

/** Expected score for player A against player B under the Elo model. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Margin multiplier: a 6-0 6-0 thrashing should move ratings more than a
 * 7-6 7-6 squeaker. Scales gently with the game differential.
 */
export function marginMultiplier(gamesWon: number, gamesLost: number): number {
  const margin = Math.abs(gamesWon - gamesLost);
  return 1 + Math.log1p(margin) / Math.log(13); // ~1.0 at margin 0, ~2.0 at margin 12
}

/** The (unrounded) Elo delta a match applies to one player. */
export function ratingDelta(
  rating: number,
  opponentRating: number,
  result: MatchResult,
  gamesWon: number,
  gamesLost: number,
): number {
  const actual = result === 'win' ? 1 : 0;
  const expected = expectedScore(rating, opponentRating);
  return K_FACTOR * marginMultiplier(gamesWon, gamesLost) * (actual - expected);
}

/** New Elo rating for one player after a match. */
export function nextRating(
  rating: number,
  opponentRating: number,
  result: MatchResult,
  gamesWon: number,
  gamesLost: number,
): number {
  return Math.round(rating + ratingDelta(rating, opponentRating, result, gamesWon, gamesLost));
}

async function currentRating(db: Queryable, userId: string, surface: Surface): Promise<number> {
  const { rows } = await db.query<{ rating: string }>(
    'SELECT rating FROM user_ratings WHERE user_id = $1 AND surface = $2',
    [userId, surface],
  );
  return rows[0] ? Number(rows[0].rating) : DEFAULT_RATING;
}

/**
 * Apply a signed rating delta *relatively* (rating = rating + delta) so two
 * matches logged concurrently compose instead of clobbering one another.
 */
async function applyRatingDelta(
  db: Queryable,
  userId: string,
  surface: Surface,
  delta: number,
  result: MatchResult,
): Promise<void> {
  const win = result === 'win' ? 1 : 0;
  const loss = result === 'loss' ? 1 : 0;
  const seed = DEFAULT_RATING + delta; // rating for a brand-new (insert) row
  await db.query(
    // Explicit casts: postgres.js sends params untyped, so a param reused across
    // numeric contexts (e.g. $3 as the rating column and inside GREATEST) can
    // trip "inconsistent types deduced for parameter". Pinning types avoids it.
    `INSERT INTO user_ratings (user_id, surface, rating, matches_played, wins, losses, peak_rating)
     VALUES ($1, $2, $3::numeric, 1, $4::int, $5::int, GREATEST($6::numeric, $3::numeric))
     ON CONFLICT (user_id, surface) DO UPDATE SET
       rating         = user_ratings.rating + $7::numeric,
       matches_played = user_ratings.matches_played + 1,
       wins           = user_ratings.wins   + $4::int,
       losses         = user_ratings.losses + $5::int,
       peak_rating    = GREATEST(user_ratings.peak_rating, user_ratings.rating + $7::numeric)`,
    [userId, surface, seed, win, loss, DEFAULT_RATING, delta],
  );
}

/**
 * Apply a match result to the logging player's per-surface Elo and return the
 * exact delta applied. The opponent's rating is intentionally NOT mutated.
 */
export async function applyMatchToRatings(
  db: Queryable,
  args: {
    userId: string;
    opponentId: string | null;
    surface: Surface;
    result: MatchResult;
    gamesWon: number;
    gamesLost: number;
  },
): Promise<{ userDelta: number }> {
  const { userId, opponentId, surface, result, gamesWon, gamesLost } = args;

  const userR = await currentRating(db, userId, surface);
  const oppR = opponentId ? await currentRating(db, opponentId, surface) : DEFAULT_RATING;

  const userDelta = Math.round(ratingDelta(userR, oppR, result, gamesWon, gamesLost));
  await applyRatingDelta(db, userId, surface, userDelta, result);
  return { userDelta };
}

/**
 * Reverse a match's effect on the logger's rating when it is deleted. Uses the
 * exact delta persisted at log time when available; for legacy matches it falls
 * back to a best-effort estimate. `peak_rating` is left as the historical high.
 */
export async function reverseMatchFromRatings(
  db: Queryable,
  args: {
    userId: string;
    surface: Surface;
    result: MatchResult;
    gamesWon: number;
    gamesLost: number;
    appliedDelta?: number | null;
  },
): Promise<void> {
  const { userId, surface, result, gamesWon, gamesLost, appliedDelta } = args;

  let delta = appliedDelta ?? null;
  if (delta == null) {
    const userR = await currentRating(db, userId, surface);
    delta = Math.round(ratingDelta(userR, DEFAULT_RATING, result, gamesWon, gamesLost));
  }
  await reverseRatingDelta(db, userId, surface, delta, result);
}

/** Undo one match from an existing rating row (no-op if the row is absent). */
async function reverseRatingDelta(
  db: Queryable,
  userId: string,
  surface: Surface,
  delta: number,
  result: MatchResult,
): Promise<void> {
  await db.query(
    `UPDATE user_ratings SET
       rating         = user_ratings.rating - $3::numeric,
       matches_played = GREATEST(0, matches_played - 1),
       wins           = GREATEST(0, wins   - $4::int),
       losses         = GREATEST(0, losses - $5::int)
     WHERE user_id = $1 AND surface = $2`,
    [userId, surface, delta, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0],
  );
}

export async function getRatings(userId: string): Promise<SurfaceRating[]> {
  const { rows } = await pool.query<{
    surface: Surface;
    rating: string;
    matches_played: number;
    wins: number;
    losses: number;
    peak_rating: string;
  }>(
    `SELECT surface, rating, matches_played, wins, losses, peak_rating
       FROM user_ratings WHERE user_id = $1 ORDER BY surface`,
    [userId],
  );
  return rows.map((r) => ({
    surface: r.surface,
    rating: Number(r.rating),
    matches_played: r.matches_played,
    wins: r.wins,
    losses: r.losses,
    peak_rating: Number(r.peak_rating),
  }));
}

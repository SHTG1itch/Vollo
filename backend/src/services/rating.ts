import type { Queryable } from '../db/pool.js';
import { pool } from '../db/pool.js';
import type { MatchResult, Surface, SurfaceRating } from '../types/index.js';

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

/** New Elo rating for one player after a match. */
export function nextRating(
  rating: number,
  opponentRating: number,
  result: MatchResult,
  gamesWon: number,
  gamesLost: number,
): number {
  const actual = result === 'win' ? 1 : 0;
  const expected = expectedScore(rating, opponentRating);
  const delta = K_FACTOR * marginMultiplier(gamesWon, gamesLost) * (actual - expected);
  return Math.round(rating + delta);
}

async function currentRating(db: Queryable, userId: string, surface: Surface): Promise<number> {
  const { rows } = await db.query<{ rating: string }>(
    'SELECT rating FROM user_ratings WHERE user_id = $1 AND surface = $2',
    [userId, surface],
  );
  return rows[0] ? Number(rows[0].rating) : DEFAULT_RATING;
}

async function upsertRating(
  db: Queryable,
  userId: string,
  surface: Surface,
  rating: number,
  result: MatchResult,
): Promise<void> {
  await db.query(
    `INSERT INTO user_ratings (user_id, surface, rating, matches_played, wins, losses, peak_rating)
     VALUES ($1, $2, $3, 1, $4, $5, $3)
     ON CONFLICT (user_id, surface) DO UPDATE SET
       rating         = $3,
       matches_played = user_ratings.matches_played + 1,
       wins           = user_ratings.wins   + $4,
       losses         = user_ratings.losses + $5,
       peak_rating    = GREATEST(user_ratings.peak_rating, $3)`,
    [userId, surface, rating, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0],
  );
}

/**
 * Apply a match result to per-surface Elo ratings. Updates the logging player
 * always, and the opponent too when they are a registered user (their result is
 * the mirror image). Runs inside the caller's transaction for consistency.
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
): Promise<void> {
  const { userId, opponentId, surface, result, gamesWon, gamesLost } = args;

  const userR = await currentRating(db, userId, surface);
  const oppR = opponentId ? await currentRating(db, opponentId, surface) : DEFAULT_RATING;

  const newUserR = nextRating(userR, oppR, result, gamesWon, gamesLost);
  await upsertRating(db, userId, surface, newUserR, result);

  if (opponentId) {
    const oppResult: MatchResult = result === 'win' ? 'loss' : 'win';
    const newOppR = nextRating(oppR, userR, oppResult, gamesLost, gamesWon);
    await upsertRating(db, opponentId, surface, newOppR, oppResult);
  }
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

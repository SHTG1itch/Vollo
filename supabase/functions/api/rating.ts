import type { Queryable } from './db.ts';
import { pool } from './db.ts';
import type { MatchResult, Surface, SurfaceRating } from './types.ts';

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

const DEFAULT_RATING = 1000;        // prior mean μ₀ (kept on the legacy 1000 scale)
const DEFAULT_RD = 350;             // prior deviation σ₀ — maximal uncertainty
const RD_MIN = 30;                  // a rating never becomes infinitely certain
const Q = Math.LN10 / 400;          // Glicko scale constant (ln 10 / 400)

interface Posterior {
  mu: number;
  rd: number;
}

/** Glicko g(RD): how much weight to give an opponent given our uncertainty about
 *  them — a very uncertain opponent's result is less informative. */
function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

/** Expected score (win probability) for a player vs an opponent under the model. */
export function expectedScore(mu: number, oppMu: number, oppRd: number): number {
  return 1 / (1 + 10 ** ((-g(oppRd) * (mu - oppMu)) / 400));
}

/**
 * Margin multiplier: a 6-0 6-0 thrashing is stronger evidence of a skill gap
 * than a 7-6 7-6 squeaker, so it carries more information. Scales gently with
 * the game differential (~1.0 at margin 0, ~2.0 at margin 12). Folded into the
 * Bayesian update as an evidence-strength weight.
 */
export function marginMultiplier(gamesWon: number, gamesLost: number): number {
  const margin = Math.abs(gamesWon - gamesLost);
  return 1 + Math.log1p(margin) / Math.log(13);
}

/**
 * One Bayesian update layer: fold a single match result into the prior posterior
 * and return the new posterior. `evidence` (the margin multiplier) scales how
 * much information this match carries — both the mean nudge and the precision
 * gain (RD reduction).
 */
export function bayesianUpdate(prior: Posterior, opp: Posterior, result: MatchResult, evidence: number): Posterior {
  const S = result === 'win' ? 1 : 0;
  const gi = g(opp.rd);
  const E = 1 / (1 + 10 ** ((-gi * (prior.mu - opp.mu)) / 400));
  // Glicko information of the observation (= 1/d²), scaled by the margin so a
  // decisive result both moves the rating more and shrinks RD more.
  const likePrecision = evidence * Q * Q * gi * gi * E * (1 - E);
  const priorPrecision = 1 / (prior.rd * prior.rd);
  const newPrecision = priorPrecision + likePrecision;
  const newRd = Math.max(RD_MIN, Math.min(DEFAULT_RD, Math.sqrt(1 / newPrecision)));
  const newMu = prior.mu + (1 / newPrecision) * Q * gi * (S - E) * evidence;
  return { mu: newMu, rd: newRd };
}

interface ReplayMatch {
  surface: Surface;
  result: MatchResult;
  games_won: number;
  games_lost: number;
  opponent_id: string | null;
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
  // Inline row type (a named interface here wouldn't satisfy the driver's Row
  // constraint). Structurally a ReplayMatch.
  const { rows: matches } = await db.query<{
    surface: Surface;
    result: MatchResult;
    games_won: number;
    games_lost: number;
    opponent_id: string | null;
  }>(
    `SELECT surface, result, games_won, games_lost, opponent_id
       FROM matches
      WHERE user_id = $1 AND verification_status IN ('auto', 'verified')
      ORDER BY played_at ASC, id ASC`,
    [userId],
  );

  // Batch-load opponents' current posteriors so the replay needs no per-match
  // query. Keyed by `${opponentId}|${surface}`.
  const oppIds = [...new Set(matches.map((m) => m.opponent_id).filter((x): x is string => !!x))];
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
    let post: Posterior = { mu: DEFAULT_RATING, rd: DEFAULT_RD };
    let wins = 0;
    let losses = 0;
    let peak = DEFAULT_RATING;
    for (const m of ms) {
      const opp = (m.opponent_id ? oppMap.get(`${m.opponent_id}|${surface}`) : null) ?? { mu: DEFAULT_RATING, rd: DEFAULT_RD };
      post = bayesianUpdate(post, opp, m.result, marginMultiplier(Number(m.games_won), Number(m.games_lost)));
      if (m.result === 'win') wins++;
      else losses++;
      if (post.mu > peak) peak = post.mu;
    }
    const ratingVal = Math.round(post.mu);
    const rdVal = Math.round(post.rd);
    await db.query(
      `INSERT INTO user_ratings (user_id, surface, rating, rating_deviation, matches_played, wins, losses, peak_rating)
       VALUES ($1, $2, $3::numeric, $4::numeric, $5::int, $6::int, $7::int, $8::numeric)
       ON CONFLICT (user_id, surface) DO UPDATE SET
         rating          = EXCLUDED.rating,
         rating_deviation= EXCLUDED.rating_deviation,
         matches_played  = EXCLUDED.matches_played,
         wins            = EXCLUDED.wins,
         losses          = EXCLUDED.losses,
         peak_rating     = GREATEST(user_ratings.peak_rating, EXCLUDED.peak_rating)`,
      [userId, surface, ratingVal, rdVal, ms.length, wins, losses, Math.round(peak)],
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

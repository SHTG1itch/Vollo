import { config } from '../config.js';
import { pool, query, queryOne } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';
import type { StreakState } from '../types/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StreakComputation {
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  streakModifier: number;
  lastMatchAtMs: number | null;
}

/**
 * Pure temporal-heat-index calculation.
 *
 * Activity is bucketed into fixed `windowDays`-long windows counting back from
 * `nowMs` (bucket 0 = the most recent window). A streak is the run of
 * consecutive non-empty buckets starting at bucket 0 — i.e. the user logged at
 * least one match in every rolling window without a gap. The streak modifier
 * scales up by `modifierStep` per maintained window, capped at `modifierMax`:
 *
 *   modifier = clamp(1 + weeks * step, 1, max)
 */
export function computeStreak(
  playedAtMs: number[],
  nowMs: number,
  opts = config.streak,
): StreakComputation {
  if (playedAtMs.length === 0) {
    return { currentStreakWeeks: 0, longestStreakWeeks: 0, streakModifier: 1, lastMatchAtMs: null };
  }

  const windowMs = Math.max(1, opts.windowDays) * DAY_MS; // guard against a 0-day window → NaN buckets
  const lastMatchAtMs = Math.max(...playedAtMs);

  // Mark which buckets (counting back from now) contain at least one match.
  const filled = new Set<number>();
  let maxBucket = 0;
  for (const ts of playedAtMs) {
    const bucket = Math.floor((nowMs - ts) / windowMs);
    if (bucket >= 0) {
      filled.add(bucket);
      if (bucket > maxBucket) maxBucket = bucket;
    }
  }

  // Current streak: consecutive filled buckets starting at 0.
  let currentStreakWeeks = 0;
  while (filled.has(currentStreakWeeks)) currentStreakWeeks++;

  // Longest streak: longest consecutive run of filled buckets in history.
  let longestStreakWeeks = 0;
  let run = 0;
  for (let b = 0; b <= maxBucket; b++) {
    if (filled.has(b)) {
      run++;
      if (run > longestStreakWeeks) longestStreakWeeks = run;
    } else {
      run = 0;
    }
  }

  const streakModifier = streakModifierFor(currentStreakWeeks, opts);
  return { currentStreakWeeks, longestStreakWeeks, streakModifier, lastMatchAtMs };
}

/** clamp(1 + weeks * step, 1, max). */
export function streakModifierFor(weeks: number, opts = config.streak): number {
  const raw = 1 + Math.max(0, weeks) * opts.modifierStep;
  return Number(Math.min(opts.modifierMax, Math.max(1, raw)).toFixed(2));
}

/** Read a user's current streak modifier (defaults to 1.0 if none recorded). */
export async function getStreakModifier(userId: string): Promise<number> {
  const row = await queryOne<{ streak_modifier: string }>(
    'SELECT streak_modifier FROM user_streaks WHERE user_id = $1',
    [userId],
  );
  return row ? Number(row.streak_modifier) : 1;
}

/**
 * Recompute and persist a user's streak from their full match history.
 * Called after logging a match and from the rolling cron worker.
 */
export async function recomputeUserStreak(
  userId: string,
  db: Queryable = pool,
  nowMs = Date.now(),
): Promise<StreakComputation> {
  const { rows } = await db.query<{ played_at: string }>(
    'SELECT played_at FROM matches WHERE user_id = $1',
    [userId],
  );
  const playedAtMs = rows.map((r) => new Date(r.played_at).getTime());
  const result = computeStreak(playedAtMs, nowMs);

  await db.query(
    `INSERT INTO user_streaks
       (user_id, current_streak_weeks, longest_streak_weeks, streak_modifier, last_match_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5 / 1000.0) END)
     ON CONFLICT (user_id) DO UPDATE SET
       current_streak_weeks = EXCLUDED.current_streak_weeks,
       longest_streak_weeks = GREATEST(user_streaks.longest_streak_weeks, EXCLUDED.longest_streak_weeks),
       streak_modifier      = EXCLUDED.streak_modifier,
       last_match_at        = EXCLUDED.last_match_at`,
    [
      userId,
      result.currentStreakWeeks,
      result.longestStreakWeeks,
      result.streakModifier,
      // NULL when the user has no matches, rather than fabricating "now".
      result.lastMatchAtMs,
    ],
  );
  return result;
}

export async function getStreakState(userId: string): Promise<StreakState> {
  const row = await queryOne<{
    current_streak_weeks: number;
    longest_streak_weeks: number;
    streak_modifier: string;
    last_match_at: string | null;
  }>(
    `SELECT current_streak_weeks, longest_streak_weeks, streak_modifier, last_match_at
       FROM user_streaks WHERE user_id = $1`,
    [userId],
  );
  return {
    current_streak_weeks: row?.current_streak_weeks ?? 0,
    longest_streak_weeks: row?.longest_streak_weeks ?? 0,
    streak_modifier: row ? Number(row.streak_modifier) : 1,
    last_match_at: row?.last_match_at ?? null,
  };
}

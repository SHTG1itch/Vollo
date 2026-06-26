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
 * Activity is bucketed into FIXED, calendar-anchored `windowDays`-long windows
 * (`floor(ts / windowMs)`), so a given match always maps to the same absolute
 * bucket no matter when this runs. The current streak is the run of consecutive
 * non-empty windows ending at the window containing `now`; the longest streak is
 * the longest such run in history. The modifier scales up by `modifierStep` per
 * maintained window, capped at `modifierMax`:
 *
 *   modifier = clamp(1 + weeks * step, 1, max)
 *
 * Anchoring to fixed boundaries (rather than rolling back from `now`) is what
 * makes `longest` deterministic: with rolling buckets the same history produced
 * different layouts on different days, and the DB's GREATEST() then ratcheted
 * the stored longest ever upward (inflating it past any real streak).
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

  // Which fixed windows contain at least one match.
  const filled = new Set<number>();
  for (const ts of playedAtMs) filled.add(Math.floor(ts / windowMs));
  const currentBucket = Math.floor(nowMs / windowMs);

  // Current streak: consecutive filled windows ending at the current window.
  let currentStreakWeeks = 0;
  while (filled.has(currentBucket - currentStreakWeeks)) currentStreakWeeks++;

  // Longest streak: longest run of consecutive filled windows in history.
  const sorted = [...filled].sort((a, b) => a - b);
  let longestStreakWeeks = 0;
  let run = 0;
  let prev: number | null = null;
  for (const b of sorted) {
    run = prev !== null && b === prev + 1 ? run + 1 : 1;
    if (run > longestStreakWeeks) longestStreakWeeks = run;
    prev = b;
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
       -- Plain assignment, not GREATEST: longest is now recomputed deterministically
       -- from full history each time, so it self-corrects (e.g. after a deletion)
       -- instead of ratcheting upward forever.
       longest_streak_weeks = EXCLUDED.longest_streak_weeks,
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

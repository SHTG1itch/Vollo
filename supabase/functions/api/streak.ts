import { config } from './config.ts';
import { queryOne } from './db.ts';
import type { Queryable } from './db.ts';
import type { StreakState } from './types.ts';

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
 * (`floor(ts / windowMs)`). The current streak is the run of consecutive
 * non-empty windows ending at the window containing `now`; the longest streak is
 * the longest such run in history. The modifier scales up by `modifierStep` per
 * maintained window, capped at `modifierMax`.
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

  const filled = new Set<number>();
  for (const ts of playedAtMs) filled.add(Math.floor(ts / windowMs));
  const currentBucket = Math.floor(nowMs / windowMs);

  let currentStreakWeeks = 0;
  while (filled.has(currentBucket - currentStreakWeeks)) currentStreakWeeks++;

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
 * Called after logging a match and from the rolling cron sweep.
 */
export async function recomputeUserStreak(
  userId: string,
  db: Queryable,
  nowMs = Date.now(),
): Promise<StreakComputation> {
  // This is a read-then-absolute-write recompute, so serialize it with rating
  // recomputes for the same user before taking the match-history snapshot. The
  // caller must provide a transaction-bound client for the lock to span all of
  // the reads and the upsert (all mutation paths and the sweep do so).
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))', [userId]);

  const { rows } = await db.query<{ played_at: string }>(
    // Only matches that actually count toward the player's record drive the
    // streak — a pending (unverified) or rejected match must not.
    "SELECT played_at FROM matches WHERE user_id = $1 AND verification_status IN ('auto', 'verified')",
    [userId],
  );
  const playedAtMs = rows.map((r) => new Date(r.played_at).getTime());
  const result = computeStreak(playedAtMs, nowMs);

  await db.query(
    `INSERT INTO user_streaks
       (user_id, current_streak_weeks, longest_streak_weeks, streak_modifier, last_match_at)
     VALUES ($1, $2::int, $3::int, $4::numeric, CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5::bigint / 1000.0) END)
     ON CONFLICT (user_id) DO UPDATE SET
       current_streak_weeks = EXCLUDED.current_streak_weeks,
       longest_streak_weeks = EXCLUDED.longest_streak_weeks,
       streak_modifier      = EXCLUDED.streak_modifier,
       last_match_at        = EXCLUDED.last_match_at`,
    [
      userId,
      result.currentStreakWeeks,
      result.longestStreakWeeks,
      result.streakModifier,
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

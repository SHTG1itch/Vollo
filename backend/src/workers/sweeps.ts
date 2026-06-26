import { pool, query } from '../db/pool.js';
import { recomputeUserStreak } from '../services/streak.js';
import { recomputeUserTerritories } from '../services/territory.js';
import { evaluateAchievements } from '../services/achievements.js';

/**
 * Rolling temporal-heat-index sweep. Recomputes every user's streak so that
 * modifiers decay the moment a 7-day window lapses without activity — this is
 * what makes the streak mechanic a real retention pressure rather than a value
 * that only ever moves when a match is logged.
 */
export async function runStreakSweep(nowMs = Date.now()): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  let ok = 0;
  for (const u of users) {
    // Isolate each user so one failure doesn't abort the rest of the sweep.
    try {
      await recomputeUserStreak(u.id, pool, nowMs);
      ok++;
    } catch (err) {
      console.error(`[worker] streak recompute failed for ${u.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[worker] streak sweep recomputed ${ok}/${users.length} user(s)`);
  return ok;
}

/**
 * Territory sweep. The court leaderboard is a trailing 30-day window, so ranks
 * (and therefore controlled courts and convex-hull territories) drift as old
 * matches age out — even with no new matches. This keeps every polygon honest.
 */
export async function runTerritorySweep(): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  let ok = 0;
  for (const u of users) {
    try {
      await recomputeUserTerritories(u.id);
      await evaluateAchievements(u.id);
      ok++;
    } catch (err) {
      console.error(`[worker] territory recompute failed for ${u.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[worker] territory sweep recomputed ${ok}/${users.length} user(s)`);
  return ok;
}

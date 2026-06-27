import { pool, query } from './db.ts';
import { recomputeUserStreak } from './streak.ts';
import { recomputeUserTerritories } from './territory.ts';
import { evaluateAchievements } from './achievements.ts';

/**
 * Rolling temporal-heat-index sweep. Recomputes every user's streak so modifiers
 * decay the moment a 7-day window lapses without activity. Invoked by pg_cron.
 */
export async function runStreakSweep(nowMs = Date.now()): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  let ok = 0;
  for (const u of users) {
    try {
      await recomputeUserStreak(u.id, pool, nowMs);
      ok++;
    } catch (err) {
      console.error(`[sweep] streak recompute failed for ${u.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[sweep] streak sweep recomputed ${ok}/${users.length} user(s)`);
  return ok;
}

/**
 * Territory sweep. The court leaderboard is a trailing 30-day window, so ranks
 * (and therefore controlled courts and convex-hull territories) drift as old
 * matches age out — even with no new matches. Invoked by pg_cron.
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
      console.error(`[sweep] territory recompute failed for ${u.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[sweep] territory sweep recomputed ${ok}/${users.length} user(s)`);
  return ok;
}

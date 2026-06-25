import { query } from '../db/pool.js';
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
  for (const u of users) {
    await recomputeUserStreak(u.id, nowMs);
  }
  console.log(`[worker] streak sweep recomputed ${users.length} user(s)`);
  return users.length;
}

/**
 * Territory sweep. The court leaderboard is a trailing 30-day window, so ranks
 * (and therefore controlled courts and convex-hull territories) drift as old
 * matches age out — even with no new matches. This keeps every polygon honest.
 */
export async function runTerritorySweep(): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  for (const u of users) {
    await recomputeUserTerritories(u.id);
    await evaluateAchievements(u.id);
  }
  console.log(`[worker] territory sweep recomputed ${users.length} user(s)`);
  return users.length;
}

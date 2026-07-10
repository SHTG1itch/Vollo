import { query, withTransaction } from './db.ts';
import { recomputeUserStreak } from './streak.ts';
import { recomputeUserTerritories } from './territory.ts';
import { recomputeUserRatings } from './rating.ts';
import { evaluateAchievements } from './achievements.ts';
import { reverseGeocode } from './geocoding.ts';

/**
 * Rolling temporal-heat-index sweep. Recomputes every user's streak so modifiers
 * decay the moment a 7-day window lapses without activity. Invoked by pg_cron.
 */
export async function runStreakSweep(nowMs = Date.now()): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  let ok = 0;
  for (const u of users) {
    try {
      await withTransaction((client) => recomputeUserStreak(u.id, client, nowMs));
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

/**
 * Bayesian rating recompute sweep. Replays every user's match history into their
 * per-surface Gaussian rating posterior. Idempotent (ratings are a pure function
 * of history), so it doubles as the one-time backfill that converts legacy Elo
 * rows to the Bayesian model. Invoked on demand via the internal sweep route.
 */
export async function runRatingSweep(): Promise<number> {
  const users = await query<{ id: string }>('SELECT id FROM users');
  let ok = 0;
  for (const u of users) {
    try {
      await withTransaction((client) => recomputeUserRatings(client, u.id));
      ok++;
    } catch (err) {
      console.error(`[sweep] rating recompute failed for ${u.id}`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[sweep] rating sweep recomputed ${ok}/${users.length} user(s)`);
  return ok;
}

/**
 * Court-naming backfill. Earlier OSM imports stored anonymous facilities as a
 * bare "Tennis Court(s)"; this names a batch of them from their neighbourhood
 * (e.g. "Red Hawk Courts"). Bounded per run and paced to respect Nominatim's
 * ~1 req/s policy, so it's safe to re-run until it reports 0. Best-effort.
 */
export async function runCourtNameSweep(limit = 20): Promise<number> {
  const courts = await query<{ id: string; lat: number; lng: number; city: string | null; court_count: number }>(
    `SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lng, city, court_count
       FROM courts
      WHERE name ~ '^Tennis Courts?$'
      ORDER BY court_count DESC, created_at DESC
      LIMIT $1`,
    [limit],
  );
  let named = 0;
  for (let i = 0; i < courts.length; i++) {
    const c = courts[i]!;
    try {
      const rg = await reverseGeocode(Number(c.lat), Number(c.lng));
      const place = rg?.neighborhood ?? rg?.city ?? c.city;
      if (place) {
        const suffix = Number(c.court_count) > 1 ? 'Courts' : 'Court';
        const name = `${place} ${suffix}`.slice(0, 118);
        await query('UPDATE courts SET name = $1 WHERE id = $2', [name, c.id]);
        named++;
      }
    } catch (err) {
      console.error(`[sweep] court naming failed for ${c.id}`, err instanceof Error ? err.message : err);
    }
    if (i < courts.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(`[sweep] court-name sweep named ${named}/${courts.length} court(s)`);
  return named;
}

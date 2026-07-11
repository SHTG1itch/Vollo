import { query, withTransaction } from './db.ts';
import { recomputeUserStreak } from './streak.ts';
import { recomputeUserTerritories } from './territory.ts';
import { recomputeUserRatings } from './rating.ts';
import { evaluateAchievements } from './achievements.ts';
import { allowsAutomatedGeocoding, reverseGeocode } from './geocoding.ts';

type SweepType = 'streak' | 'territory' | 'ratings';

interface SweepBatch {
  userIds: string[];
  leaseToken: string;
}

const SWEEP_BATCH_SIZE: Record<SweepType, number> = {
  streak: 100,
  territory: 25,
  ratings: 50,
};

/**
 * Claim a bounded, cursor-based batch. The state row lock prevents two cron
 * invocations from claiming the same work. A token makes completion safe even
 * if a slow worker outlives its lease and a replacement has already started.
 */
async function claimSweepBatch(type: SweepType): Promise<SweepBatch | null> {
  const leaseToken = crypto.randomUUID();
  const limit = SWEEP_BATCH_SIZE[type];
  return await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO sweep_state (sweep_type)
       VALUES ($1)
       ON CONFLICT (sweep_type) DO NOTHING`,
      [type],
    );
    const state = await client.query<{ cursor_user_id: string | null; lease_active: boolean }>(
      `SELECT cursor_user_id,
              COALESCE(lease_until > clock_timestamp(), false) AS lease_active
         FROM sweep_state
        WHERE sweep_type = $1
        FOR UPDATE`,
      [type],
    );
    const row = state.rows[0]!;
    if (row.lease_active) return null;

    await client.query(
      `UPDATE sweep_state
          SET lease_token = $2,
              lease_until = clock_timestamp() + interval '8 minutes',
              updated_at = clock_timestamp()
        WHERE sweep_type = $1`,
      [type, leaseToken],
    );

    let users = await client.query<{ id: string }>(
      `SELECT id FROM users
        WHERE ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT $2`,
      [row.cursor_user_id, limit],
    );
    // End of one full pass: wrap to the beginning. Newly-created UUIDs that
    // sort before the old cursor are picked up on this next pass.
    if (users.rows.length === 0 && row.cursor_user_id) {
      users = await client.query<{ id: string }>(
        'SELECT id FROM users ORDER BY id LIMIT $1',
        [limit],
      );
    }
    if (users.rows.length === 0) {
      await client.query(
        `UPDATE sweep_state
            SET cursor_user_id = NULL, lease_token = NULL,
                lease_until = NULL, updated_at = clock_timestamp()
          WHERE sweep_type = $1 AND lease_token = $2`,
        [type, leaseToken],
      );
      return null;
    }
    return { userIds: users.rows.map((user) => user.id), leaseToken };
  });
}

async function finishSweepBatch(type: SweepType, batch: SweepBatch): Promise<void> {
  const cursor = batch.userIds.at(-1)!;
  await query(
    `UPDATE sweep_state
        SET cursor_user_id = $3, lease_token = NULL,
            lease_until = NULL, updated_at = clock_timestamp()
      WHERE sweep_type = $1 AND lease_token = $2`,
    [type, batch.leaseToken, cursor],
  );
}

/**
 * Rolling temporal-heat-index sweep. Recomputes every user's streak so modifiers
 * decay the moment a 7-day window lapses without activity. Invoked by pg_cron.
 */
export async function runStreakSweep(nowMs = Date.now()): Promise<number> {
  const batch = await claimSweepBatch('streak');
  if (!batch) return 0;
  let ok = 0;
  for (const userId of batch.userIds) {
    try {
      await withTransaction((client) => recomputeUserStreak(userId, client, nowMs));
      ok++;
    } catch (err) {
      console.error('[sweep] streak recompute failed', err instanceof Error ? err.message : err);
    }
  }
  await finishSweepBatch('streak', batch);
  console.log(`[sweep] streak batch recomputed ${ok}/${batch.userIds.length} user(s)`);
  return ok;
}

/**
 * Territory sweep. The court leaderboard is a trailing 30-day window, so ranks
 * (and therefore controlled courts and convex-hull territories) drift as old
 * matches age out — even with no new matches. Invoked by pg_cron.
 */
export async function runTerritorySweep(): Promise<number> {
  const batch = await claimSweepBatch('territory');
  if (!batch) return 0;
  let ok = 0;
  for (const userId of batch.userIds) {
    try {
      await recomputeUserTerritories(userId);
      await evaluateAchievements(userId);
      ok++;
    } catch (err) {
      console.error('[sweep] territory recompute failed', err instanceof Error ? err.message : err);
    }
  }
  await finishSweepBatch('territory', batch);
  console.log(`[sweep] territory batch recomputed ${ok}/${batch.userIds.length} user(s)`);
  return ok;
}

/**
 * Bayesian rating recompute sweep. Replays every user's match history into their
 * per-surface Gaussian rating posterior. Idempotent (ratings are a pure function
 * of history), so it doubles as the one-time backfill that converts legacy Elo
 * rows to the Bayesian model. Invoked on demand via the internal sweep route.
 */
export async function runRatingSweep(): Promise<number> {
  const batch = await claimSweepBatch('ratings');
  if (!batch) return 0;
  let ok = 0;
  for (const userId of batch.userIds) {
    try {
      await withTransaction((client) => recomputeUserRatings(client, userId));
      ok++;
    } catch (err) {
      console.error('[sweep] rating recompute failed', err instanceof Error ? err.message : err);
    }
  }
  await finishSweepBatch('ratings', batch);
  console.log(`[sweep] rating batch recomputed ${ok}/${batch.userIds.length} user(s)`);
  return ok;
}

/**
 * Court-naming backfill. Earlier OSM imports stored anonymous facilities as a
 * bare "Tennis Court(s)"; this names a batch of them from their neighbourhood
 * (e.g. "Red Hawk Courts"). Bounded per run and paced to respect Nominatim's
 * ~1 req/s policy, so it's safe to re-run until it reports 0. Best-effort.
 */
export async function runCourtNameSweep(limit = 20): Promise<number> {
  // The public Nominatim instance prohibits recurring/systematic reverse
  // geocoding. Keep this operational backfill disabled unless Geoapify is
  // explicitly configured for automated use.
  if (!allowsAutomatedGeocoding()) {
    console.warn('[sweep] court-name sweep skipped: automated geocoder is not configured');
    return 0;
  }
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
      console.error('[sweep] court naming failed', err instanceof Error ? err.message : err);
    }
    if (i < courts.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(`[sweep] court-name sweep named ${named}/${courts.length} court(s)`);
  return named;
}

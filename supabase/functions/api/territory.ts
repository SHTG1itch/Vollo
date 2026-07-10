import { config } from './config.ts';
import { pool, query, queryOne, withTransaction } from './db.ts';
import type { Queryable } from './db.ts';
import { centroid, clusterByRadius, districtName, type LatLng } from './geo.ts';
import { notify } from './notifications.ts';
import type { GeoJsonPolygon, Territory } from './types.ts';

interface ControlledCourt extends LatLng {
  court_id: string;
  name: string;
  rank: number;
}

interface HullResult {
  geometry: GeoJsonPolygon;
  center: LatLng;
  areaSqKm: number;
}

interface NewTerritory {
  courtIds: string[];
  districtName: string;
  hull: HullResult;
  courtCount: number;
}

/**
 * Courts where the user currently sits at rank 1 or 2 over the trailing 30-day
 * window — the courts they control for territory purposes.
 */
export async function getControlledCourts(
  userId: string,
  db: Queryable = pool,
): Promise<ControlledCourt[]> {
  const { rows } = await db.query<{
    court_id: string;
    rank: number;
    name: string;
    lat: number;
    lng: number;
  }>(
    `SELECT cl.court_id, cl.rank::int AS rank, c.name,
            ST_Y(c.geom) AS lat, ST_X(c.geom) AS lng
       FROM court_leaderboard cl
       JOIN courts c ON c.id = cl.court_id
      WHERE cl.user_id = $1 AND cl.rank <= 2 AND cl.score > 0`,
    [userId],
  );
  return rows;
}

/**
 * Compute a player's territory polygon from the courts they control.
 *
 * Uses ST_ConcaveHull so the polygon hugs the actual courts — its vertices land
 * on the dominated courts rather than ballooning out to a convex blob — which
 * makes the shape reflect where the player really wins. Falls back to the convex
 * hull when the concave hull degenerates, and buffers a line/point (collinear or
 * <3 courts) by 75m so the client always receives a renderable Polygon with a
 * real area. ST_Dump + largest-part pick guarantees a single POLYGON for the
 * geometry(Polygon) column even if ST_MakeValid splits a pathological shape.
 */
export async function computeHullForCourts(
  courtIds: string[],
  db: Queryable = pool,
): Promise<HullResult | null> {
  const { rows } = await db.query<{ geojson: string; center: string; area_sqkm: string }>(
    `WITH pts AS (
       SELECT ST_Collect(geom) AS g FROM courts WHERE id = ANY($1::uuid[])
     ),
     hull AS (
       SELECT CASE
                WHEN ST_NPoints(g) >= 3
                  THEN COALESCE(ST_ConcaveHull(g, $2::float, false), ST_ConvexHull(g))
                ELSE ST_ConvexHull(g)
              END AS g
         FROM pts
     ),
     shaped AS (
       SELECT CASE WHEN GeometryType(g) = 'POLYGON' THEN ST_MakeValid(g)
                   ELSE ST_Buffer(g::geography, 75)::geometry END AS g
         FROM hull
     ),
     poly AS (
       SELECT g FROM (SELECT (ST_Dump(g)).geom AS g FROM shaped) d
        WHERE GeometryType(g) = 'POLYGON'
        ORDER BY ST_Area(g) DESC
        LIMIT 1
     )
     SELECT ST_AsGeoJSON(g)               AS geojson,
            ST_AsGeoJSON(ST_Centroid(g))  AS center,
            ST_Area(g::geography) / 1000000.0 AS area_sqkm
       FROM poly`,
    [courtIds, config.territory.concaveTargetPercent],
  );
  const row = rows[0] ?? null;
  if (!row?.geojson) return null;

  const geometry = JSON.parse(row.geojson) as GeoJsonPolygon;
  const centerGeo = JSON.parse(row.center) as { coordinates: [number, number] };
  return {
    geometry,
    center: { lng: centerGeo.coordinates[0], lat: centerGeo.coordinates[1] },
    areaSqKm: Number(row.area_sqkm),
  };
}

/**
 * Recompute a single user's territories from their controlled courts.
 *   1. Pull controlled courts (rank ≤ 2 in the 30-day window).
 *   2. Cluster them by the 10km radius (single-linkage) into candidate districts.
 *   3. Keep clusters with ≥ minCourts courts and hull each via PostGIS.
 *   4. Diff against the user's existing territories → gained / lost / changed.
 *   5. Atomically replace the user's territory rows.
 * Notifications are emitted after the transaction commits.
 */
export async function recomputeUserTerritories(userId: string): Promise<void> {
  const { existing, next } = await withTransaction(async (client) => {
    // Acquire the per-user lock before taking any source or existing-state
    // snapshots. Otherwise a waiter can compute stale polygons, acquire the
    // lock later, and overwrite the fresher result produced by the lock holder.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1::bigint))', [userId]);

    const controlled = await getControlledCourts(userId, client);
    const reference = await homeReference(userId, controlled, client);
    const clusters = clusterByRadius(controlled, config.territory.radiusKm)
      .filter((idx) => idx.length >= config.territory.minCourts);

    const next: NewTerritory[] = [];
    for (const idx of clusters) {
      const courts = idx.map((i) => controlled[i]!);
      const courtIds = courts.map((c) => c.court_id).sort();
      const hull = await computeHullForCourts(courtIds, client);
      if (!hull) continue;
      next.push({
        courtIds,
        districtName: districtName(hull.center, reference),
        hull,
        courtCount: courts.length,
      });
    }

    const { rows: existing } = await client.query<{
      id: string;
      court_ids: string[];
      district_name: string;
      court_count: number;
    }>('SELECT id, court_ids, district_name, court_count FROM territories WHERE user_id = $1', [userId]);

    await client.query('DELETE FROM territories WHERE user_id = $1', [userId]);
    for (const t of next) {
      await client.query(
        `INSERT INTO territories
           (user_id, geom, center_geom, court_count, area_sqkm, district_name, court_ids)
         VALUES ($1,
                 ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326),
                 ST_SetSRID(ST_GeomFromGeoJSON($3::text), 4326),
                 $4, $5, $6, $7::uuid[])`,
        [
          userId,
          JSON.stringify(t.hull.geometry),
          JSON.stringify({ type: 'Point', coordinates: [t.hull.center.lng, t.hull.center.lat] }),
          t.courtCount,
          Number(t.hull.areaSqKm.toFixed(3)),
          t.districtName,
          t.courtIds,
        ],
      );
    }
    return { existing, next };
  });

  await emitTerritoryDiffNotifications(userId, existing, next);
}

/** Compare old vs new territory sets (by shared courts) and notify the owner. */
async function emitTerritoryDiffNotifications(
  userId: string,
  existing: Array<{ court_ids: string[]; district_name: string; court_count: number }>,
  next: NewTerritory[],
): Promise<void> {
  const overlap = (a: string[], b: string[]): number => {
    const setB = new Set(b);
    return a.filter((x) => setB.has(x)).length;
  };
  const matchedOld = new Set<number>();

  for (const t of next) {
    let bestIdx = -1;
    let bestShared = 0;
    existing.forEach((old, i) => {
      const shared = overlap(old.court_ids, t.courtIds);
      if (shared > bestShared) {
        bestShared = shared;
        bestIdx = i;
      }
    });

    if (bestIdx === -1) {
      await notify({
        userId,
        type: 'territory_gained',
        title: '🟢 Territory claimed!',
        body: `You claimed the ${t.districtName} — ${t.courtCount} courts under your control.`,
        data: { district: t.districtName, courtCount: t.courtCount },
      }).catch(() => {});
    } else {
      matchedOld.add(bestIdx);
      const old = existing[bestIdx]!;
      if (old.court_count !== t.courtCount) {
        await notify({
          userId,
          type: 'territory_changed',
          title: '🟡 Territory shifted',
          body: `Your ${t.districtName} now spans ${t.courtCount} courts (was ${old.court_count}).`,
          data: { district: t.districtName, courtCount: t.courtCount },
        }).catch(() => {});
      }
    }
  }

  for (const [i, old] of existing.entries()) {
    if (!matchedOld.has(i)) {
      await notify({
        userId,
        type: 'territory_lost',
        title: '🔴 Territory lost',
        body: `Your ${old.district_name} has been cut off — you no longer control enough courts there.`,
        data: { district: old.district_name },
      }).catch(() => {});
    }
  }
}

/**
 * Recompute territories for everyone affected by a match at a court:
 *   - the player who logged it,
 *   - everyone currently top-2 at that court,
 *   - anyone whose existing territory still references that court.
 * Also emits court takeover notifications when the rank-1 controller changes.
 */
export async function recomputeAfterMatch(args: {
  courtId: string;
  loggerUserId: string;
  previousControllerId: string | null;
}): Promise<void> {
  const { courtId, loggerUserId, previousControllerId } = args;

  const affected = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM court_leaderboard WHERE court_id = $1 AND rank <= 2
     UNION
     SELECT user_id FROM territories WHERE court_ids @> ARRAY[$1]::uuid[]`,
    [courtId],
  );
  const userIds = new Set<string>(affected.map((r) => r.user_id));
  userIds.add(loggerUserId);

  for (const uid of userIds) {
    await recomputeUserTerritories(uid);
  }

  await emitCourtTakeoverNotifications(courtId, previousControllerId);
  await emitTurfWarNotification(courtId, loggerUserId).catch(() => {});
}

/**
 * Turf War: when the player who just logged a match (the challenger) climbs to
 * within `turfWarThreshold` of the rank-1 controller at a court that's part of
 * the controller's established territory — but hasn't overtaken them yet — alert
 * the controller that their zone is under threat. Only fires for the challenger's
 * own match (so the controller's own wins don't self-trigger it), and is
 * de-duped to at most once per 6h per court to avoid a barrage.
 */
async function emitTurfWarNotification(courtId: string, loggerUserId: string): Promise<void> {
  const top = await query<{ user_id: string; score: string; rank: number }>(
    `SELECT user_id, score, rank::int AS rank
       FROM court_leaderboard
      WHERE court_id = $1 AND rank <= 2 AND score > 0
      ORDER BY rank ASC`,
    [courtId],
  );
  const leader = top.find((r) => r.rank === 1);
  const challenger = top.find((r) => r.rank === 2);
  if (!leader || !challenger) return;

  // Only the challenger's own fresh result escalates a turf war, and only while
  // they're closing in (not after they've already taken the lead).
  if (challenger.user_id !== loggerUserId || leader.user_id === loggerUserId) return;
  const leaderScore = Number(leader.score);
  const challengerScore = Number(challenger.score);
  if (leaderScore <= 0 || challengerScore >= leaderScore) return;
  if (challengerScore < config.territory.turfWarThreshold * leaderScore) return;

  // Only meaningful for an established territory the leader actually holds here.
  const ownsZone = await queryOne<{ ok: boolean }>(
    'SELECT true AS ok FROM territories WHERE user_id = $1 AND court_ids @> ARRAY[$2]::uuid[] LIMIT 1',
    [leader.user_id, courtId],
  );
  if (!ownsZone) return;

  // De-dupe: don't re-alert the same court more than once every 6 hours.
  const recent = await queryOne<{ ok: boolean }>(
    `SELECT true AS ok FROM notifications
      WHERE user_id = $1 AND type = 'turf_war' AND data->>'courtId' = $2
        AND created_at > now() - INTERVAL '6 hours' LIMIT 1`,
    [leader.user_id, courtId],
  );
  if (recent) return;

  const court = await queryOne<{ name: string }>('SELECT name FROM courts WHERE id = $1', [courtId]);
  const challengerUser = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [challenger.user_id]);
  const courtName = court?.name ?? 'one of your courts';

  await notify({
    userId: leader.user_id,
    type: 'turf_war',
    title: '⚔️ Turf War Initiated',
    body: `@${challengerUser?.username ?? 'A rival'} is closing in on your control of ${courtName}. Defend your turf!`,
    data: { courtId, courtName },
  }).catch(() => {});
}

async function emitCourtTakeoverNotifications(
  courtId: string,
  previousControllerId: string | null,
): Promise<void> {
  const controller = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM court_leaderboard WHERE court_id = $1 AND rank = 1 AND score > 0
     ORDER BY score DESC LIMIT 1`,
    [courtId],
  );
  const newController = controller?.user_id ?? null;
  if (!newController || newController === previousControllerId) return;

  const court = await queryOne<{ name: string }>('SELECT name FROM courts WHERE id = $1', [courtId]);
  const courtName = court?.name ?? 'a court';

  await notify({
    userId: newController,
    type: 'court_taken',
    title: '👑 New court controller',
    body: `You're now the #1 controller at ${courtName}.`,
    data: { courtId, courtName },
  }).catch(() => {});

  if (previousControllerId) {
    await notify({
      userId: previousControllerId,
      type: 'court_dethroned',
      title: '⚔️ You were dethroned',
      body: `You lost control of ${courtName}. Time for a rematch.`,
      data: { courtId, courtName },
    }).catch(() => {});
  }
}

/** The reference point for compass-naming districts: home, else footprint centre. */
async function homeReference(
  userId: string,
  controlled: ControlledCourt[],
  db: Queryable,
): Promise<LatLng | null> {
  const { rows } = await db.query<{ lat: number | null; lng: number | null }>(
    'SELECT ST_Y(home_geom) AS lat, ST_X(home_geom) AS lng FROM users WHERE id = $1',
    [userId],
  );
  const home = rows[0] ?? null;
  if (home?.lat != null && home?.lng != null) return { lat: Number(home.lat), lng: Number(home.lng) };
  if (controlled.length > 0) return centroid(controlled);
  return null;
}

/** The current rank-1 controller of a court (for capturing pre-match state). */
export async function getCourtController(courtId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM court_leaderboard WHERE court_id = $1 AND rank = 1 AND score > 0
     ORDER BY score DESC LIMIT 1`,
    [courtId],
  );
  return row?.user_id ?? null;
}

// The dominant player's confirmed wins across the courts in this territory over
// the rolling 30-day window — what a rival has to beat to start taking the zone.
// Sums the court_leaderboard (already verified-only + windowed) for the owner.
const OWNER_ZONE_WINS = `COALESCE((
  SELECT SUM(cl.wins) FROM court_leaderboard cl
   WHERE cl.user_id = t.user_id AND cl.court_id = ANY(t.court_ids)
), 0)`;

/** All territories as GeoJSON-ready rows, optionally limited to a bbox.
 *  Visibility follows the owner's own `show_competitive` toggle: on → the zone
 *  is on the public game board for everybody; off → hidden from everyone but
 *  the owner. Deliberately NOT follower-gated (independent of is_private).
 *  Blocked players still never see each other's zones. */
export async function listTerritories(
  viewerId: string | null,
  bbox?: {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
  },
): Promise<Territory[]> {
  const params: unknown[] = [viewerId];
  const conditions = [
    `(t.user_id = $1 OR NOT EXISTS(
        SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $1 AND b.blocked_id = t.user_id)
            OR (b.blocker_id = t.user_id AND b.blocked_id = $1)))`,
    `(t.user_id = $1 OR u.show_competitive)`,
  ];
  if (bbox) {
    conditions.push('t.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)');
    params.push(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat);
  }
  const rows = await query<TerritoryRow>(
    `SELECT t.id, t.user_id, ST_AsGeoJSON(t.geom) AS geojson,
            ST_Y(t.center_geom) AS center_lat, ST_X(t.center_geom) AS center_lng,
            t.court_count, t.area_sqkm, t.district_name, t.court_ids, t.updated_at,
            u.username AS owner_username, u.display_name AS owner_display_name, u.color AS owner_color,
            ${OWNER_ZONE_WINS} AS owner_zone_wins
       FROM territories t
       JOIN users u ON u.id = t.user_id
      WHERE ${conditions.join(' AND ')}
       ORDER BY t.area_sqkm DESC
       LIMIT 500`,
    params,
  );
  return rows.map(mapTerritoryRow);
}

export async function getUserTerritories(userId: string): Promise<Territory[]> {
  const rows = await query<TerritoryRow>(
    `SELECT t.id, t.user_id, ST_AsGeoJSON(t.geom) AS geojson,
            ST_Y(t.center_geom) AS center_lat, ST_X(t.center_geom) AS center_lng,
            t.court_count, t.area_sqkm, t.district_name, t.court_ids, t.updated_at,
            u.username AS owner_username, u.display_name AS owner_display_name, u.color AS owner_color,
            ${OWNER_ZONE_WINS} AS owner_zone_wins
       FROM territories t
       JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1
      ORDER BY t.area_sqkm DESC`,
    [userId],
  );
  return rows.map(mapTerritoryRow);
}

interface TerritoryRow {
  id: string;
  user_id: string;
  geojson: string;
  center_lat: number;
  center_lng: number;
  court_count: number;
  area_sqkm: string;
  district_name: string;
  court_ids: string[];
  updated_at: string;
  owner_username: string;
  owner_display_name: string;
  owner_color: string | null;
  owner_zone_wins: string | number;
}

function mapTerritoryRow(r: TerritoryRow): Territory {
  return {
    id: r.id,
    user_id: r.user_id,
    geometry: JSON.parse(r.geojson) as GeoJsonPolygon,
    center: { lat: Number(r.center_lat), lng: Number(r.center_lng) },
    court_count: r.court_count,
    area_sqkm: Number(r.area_sqkm),
    district_name: r.district_name,
    court_ids: r.court_ids,
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at as unknown as string).toISOString(),
    owner_username: r.owner_username,
    owner_display_name: r.owner_display_name,
    owner_color: r.owner_color ?? null,
    owner_zone_wins: Number(r.owner_zone_wins ?? 0),
  };
}

import { config } from './config.ts';
import { query, queryOne, withTransaction } from './db.ts';
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
export async function getControlledCourts(userId: string): Promise<ControlledCourt[]> {
  return query<ControlledCourt>(
    `SELECT cl.court_id, cl.rank::int AS rank, c.name,
            ST_Y(c.geom) AS lat, ST_X(c.geom) AS lng
       FROM court_leaderboard cl
       JOIN courts c ON c.id = cl.court_id
      WHERE cl.user_id = $1 AND cl.rank <= 2 AND cl.score > 0`,
    [userId],
  );
}

/**
 * Run the PostGIS convex-hull computation over a set of courts:
 *   ST_AsGeoJSON(ST_ConvexHull(ST_Collect(court_geom)))
 * Collinear/degenerate hulls (a line or point) are buffered by 75m so the
 * client always receives a renderable Polygon with a real area.
 */
export async function computeHullForCourts(courtIds: string[]): Promise<HullResult | null> {
  const row = await queryOne<{ geojson: string; center: string; area_sqkm: string }>(
    `WITH hull AS (
       SELECT ST_ConvexHull(ST_Collect(geom)) AS g
         FROM courts WHERE id = ANY($1::uuid[])
     ),
     poly AS (
       SELECT CASE WHEN GeometryType(g) = 'POLYGON' THEN g
                   ELSE ST_Buffer(g::geography, 75)::geometry END AS g
         FROM hull
     )
     SELECT ST_AsGeoJSON(g)               AS geojson,
            ST_AsGeoJSON(ST_Centroid(g))  AS center,
            ST_Area(g::geography) / 1000000.0 AS area_sqkm
       FROM poly`,
    [courtIds],
  );
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
  const controlled = await getControlledCourts(userId);
  const reference = await homeReference(userId, controlled);

  const clusters = clusterByRadius(controlled, config.territory.radiusKm)
    .filter((idx) => idx.length >= config.territory.minCourts);

  const next: NewTerritory[] = [];
  for (const idx of clusters) {
    const courts = idx.map((i) => controlled[i]!);
    const courtIds = courts.map((c) => c.court_id);
    const hull = await computeHullForCourts(courtIds);
    if (!hull) continue;
    next.push({
      courtIds: courtIds.sort(),
      districtName: districtName(hull.center, reference),
      hull,
      courtCount: courts.length,
    });
  }

  const existing = await query<{ id: string; court_ids: string[]; district_name: string; court_count: number }>(
    'SELECT id, court_ids, district_name, court_count FROM territories WHERE user_id = $1',
    [userId],
  );

  await withTransaction(async (client) => {
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
async function homeReference(userId: string, controlled: ControlledCourt[]): Promise<LatLng | null> {
  const home = await queryOne<{ lat: number | null; lng: number | null }>(
    'SELECT ST_Y(home_geom) AS lat, ST_X(home_geom) AS lng FROM users WHERE id = $1',
    [userId],
  );
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

/** All territories as GeoJSON-ready rows, optionally limited to a bbox. */
export async function listTerritories(bbox?: {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}): Promise<Territory[]> {
  const params: unknown[] = [];
  let where = '';
  if (bbox) {
    where = 'WHERE t.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)';
    params.push(bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat);
  }
  const rows = await query<TerritoryRow>(
    `SELECT t.id, t.user_id, ST_AsGeoJSON(t.geom) AS geojson,
            ST_Y(t.center_geom) AS center_lat, ST_X(t.center_geom) AS center_lng,
            t.court_count, t.area_sqkm, t.district_name, t.court_ids, t.updated_at,
            u.username AS owner_username, u.display_name AS owner_display_name
       FROM territories t
       JOIN users u ON u.id = t.user_id
       ${where}
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
            u.username AS owner_username, u.display_name AS owner_display_name
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
  };
}

-- ════════════════════════════════════════════════════════════════════════
-- Vollo — court "sectors": one facility = one court
--
-- Real-world tennis facilities are mapped in OpenStreetMap as several adjacent
-- `leisure=pitch` polygons (e.g. North Creek High School has 6). Treating each
-- pitch as its own court splintered the domination engine (six separate courts
-- to win instead of one) and littered the map with overlapping markers.
--
-- We now collapse co-located pitches into a single facility row:
--   • sector_key  — stable identity/dedup key for an imported facility. One row
--                   per facility, so the existing court-level leaderboard and
--                   territory engine treat the whole facility as ONE court for
--                   domination, exactly as intended. Partial-unique so the many
--                   user-added courts (sector_key IS NULL) are exempt.
--   • court_count — how many physical courts the facility holds (display only).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE courts ADD COLUMN IF NOT EXISTS sector_key  TEXT;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS court_count INT NOT NULL DEFAULT 1;

-- One row per imported facility. Re-imports upsert on this key, so the same
-- facility is never inserted twice no matter how many users pan over it.
CREATE UNIQUE INDEX IF NOT EXISTS courts_sector_key_key
  ON courts (sector_key) WHERE sector_key IS NOT NULL;

-- Dedup now keys on sector_key (the facility), not the per-pitch osm_id. Drop
-- the old per-pitch unique index so several pitches can fold into one facility
-- row whose osm_id references the representative/container element.
DROP INDEX IF EXISTS courts_osm_id_key;
-- Migration version is normalized against the production Supabase ledger.

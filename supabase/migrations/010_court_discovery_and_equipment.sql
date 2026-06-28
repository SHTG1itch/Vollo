-- ════════════════════════════════════════════════════════════════════════
-- Vollo — real-world court discovery + player equipment
--
--  • courts.source       — provenance of a court: 'user' (added in-app) or
--                          'osm' (imported from OpenStreetMap via Overpass).
--  • courts.osm_id unique — lets the discovery importer upsert idempotently so
--                          the same OSM court is never inserted twice, no matter
--                          how many users pan the map over it.
--  • users.equipment      — public gear loadout (racquet / strings / tension /
--                          shoes), shown on every profile so players can see
--                          what gear strong opponents use.
-- ════════════════════════════════════════════════════════════════════════

-- ─── Court provenance ────────────────────────────────────────────────────
ALTER TABLE courts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- Idempotent dedup key for imported OpenStreetMap courts. Partial so the many
-- user-added courts (osm_id IS NULL) are exempt and can coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS courts_osm_id_key
  ON courts (osm_id) WHERE osm_id IS NOT NULL;

-- ─── Player equipment (public) ───────────────────────────────────────────
-- A small, flexible JSON object: { racquet, strings, string_tension, shoes }.
-- All fields optional; an empty object means "no gear listed".
ALTER TABLE users ADD COLUMN IF NOT EXISTS equipment JSONB NOT NULL DEFAULT '{}'::jsonb;

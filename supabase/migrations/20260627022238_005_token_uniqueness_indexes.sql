-- ════════════════════════════════════════════════════════════════════════
-- Vollo — device-token uniqueness, hot-path indexes, achievement code fix
-- ════════════════════════════════════════════════════════════════════════

-- ─── Push tokens: a device token must map to exactly one user ────────────
-- Previously PK (user_id, token) let the same physical device token exist once
-- per user, so after user A logged out and B logged in on the same phone, A kept
-- receiving B's notifications. Dedupe to the most recent registration per token,
-- then make token globally unique so the route can reassign it on login.
DELETE FROM push_tokens a
 USING push_tokens b
 WHERE a.token = b.token
   AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.ctid < b.ctid));

DO $$ BEGIN
  ALTER TABLE push_tokens ADD CONSTRAINT push_tokens_token_key UNIQUE (token);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Hot-path indexes ────────────────────────────────────────────────────
-- The nearby-courts scan casts geom→geography; index that projection so
-- ST_DWithin(geom::geography, …) is index-assisted instead of a seq scan.
CREATE INDEX IF NOT EXISTS courts_geog_gist ON courts USING GIST ((geom::geography));

-- Per-match territory recompute filters `$1 = ANY(court_ids)` — GIN makes that
-- a real index lookup instead of a full territories scan.
CREATE INDEX IF NOT EXISTS territories_court_ids_gin ON territories USING GIN (court_ids);

-- courts.created_by ON DELETE SET NULL seq-scans courts on user deletion.
CREATE INDEX IF NOT EXISTS courts_created_by_idx ON courts (created_by) WHERE created_by IS NOT NULL;

-- kudos_match_idx duplicated the UNIQUE(match_id, user_id) prefix — drop it.
DROP INDEX IF EXISTS kudos_match_idx;

-- ─── Achievement code/title agreement ────────────────────────────────────
-- The 'Indoor Specialist' badge had the stale code 'night_owl'. Rename existing
-- rows where the user doesn't already hold the new code; drop any leftover dup.
UPDATE achievements
   SET code = 'indoor_specialist'
 WHERE code = 'night_owl'
   AND NOT EXISTS (
     SELECT 1 FROM achievements a2
      WHERE a2.user_id = achievements.user_id AND a2.code = 'indoor_specialist'
   );
DELETE FROM achievements WHERE code = 'night_owl';
-- Migration version is normalized against the production Supabase ledger.

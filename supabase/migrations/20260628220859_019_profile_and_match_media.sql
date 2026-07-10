-- ════════════════════════════════════════════════════════════════════════
-- Vollo — profile cover photo + match photos + match titles
--
-- Three Strava-style additions, all served through the existing media bucket
-- (migration 018) and feed view:
--   • users.cover_url   — a wide banner behind the profile header
--   • matches.photo_url — a single proof-of-play shot on the feed card
--   • matches.title     — a short headline for a logged match ("Sunday clay battle")
--
-- All nullable, no backfill: existing rows simply have no cover/photo/title and
-- the client renders the prior layout. The match_feed view is `SELECT m.*`, so it
-- must be recreated to expose the new matches columns (CREATE OR REPLACE can't
-- re-expand m.* with columns inserted mid-list). The drop/recreate re-applies the
-- security_invoker + REVOKE hardening from migration 009 so the REST API stays
-- sealed.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users   ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS title     TEXT;

-- Recreate the denormalised feed view so m.* now includes photo_url + title.
DROP VIEW IF EXISTS match_feed;
CREATE VIEW match_feed AS
SELECT
  m.*,
  u.username       AS author_username,
  u.display_name   AS author_display_name,
  u.avatar_url     AS author_avatar_url,
  c.name           AS court_name,
  c.city           AS court_city,
  ST_X(c.geom)     AS court_lng,
  ST_Y(c.geom)     AS court_lat,
  opp.username     AS opponent_username,
  opp.display_name AS opponent_display_name,
  (SELECT COUNT(*) FROM kudos k WHERE k.match_id = m.id)    AS kudos_count,
  (SELECT COUNT(*) FROM comments cm WHERE cm.match_id = m.id) AS comment_count
FROM matches m
JOIN users u        ON u.id = m.user_id
LEFT JOIN courts c  ON c.id = m.court_id
LEFT JOIN users opp ON opp.id = m.opponent_id;

-- Re-apply the hardening from migration 009 (a fresh view loses it).
ALTER VIEW public.match_feed SET (security_invoker = on);
REVOKE ALL ON public.match_feed FROM anon, authenticated;
-- Migration version is normalized against the production Supabase ledger.

-- ════════════════════════════════════════════════════════════════════════
-- Vollo — Supabase advisor hardening (security + performance lints)
--
-- - Cover the foreign keys the planner actually joins on (club creator,
--   comment/kudos author, scheduled-match court/result links).
-- - Revoke client execution of PostGIS's SECURITY DEFINER
--   st_estimatedextent — nothing client-side calls PostgREST RPCs.
-- - Drop the broad public-read policy on the user-media bucket: the bucket
--   is public, so object URLs (/object/public/…) keep working, but clients
--   can no longer LIST every user's files. Owner insert/update/delete stay.
-- ════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS clubs_creator_idx            ON clubs (creator_id);
CREATE INDEX IF NOT EXISTS comments_user_idx            ON comments (user_id);
CREATE INDEX IF NOT EXISTS kudos_user_idx               ON kudos (user_id);
CREATE INDEX IF NOT EXISTS scheduled_matches_court_idx  ON scheduled_matches (court_id);
CREATE INDEX IF NOT EXISTS scheduled_matches_match_idx  ON scheduled_matches (match_id);

REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text)                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text)          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "user-media public read" ON storage.objects;

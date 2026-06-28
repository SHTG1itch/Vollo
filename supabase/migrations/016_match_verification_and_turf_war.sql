-- ════════════════════════════════════════════════════════════════════════
-- Vollo — match verification, turf war & challenge support
--
-- Competitive integrity: a match logged against a registered Vollo player must
-- be confirmed by that opponent before it counts toward ELO, streaks or
-- territorial domination. Until then it sits 'pending' and is invisible to the
-- court leaderboard (and therefore the territory engine).
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1) Match verification lifecycle ────────────────────────────────────
--   'auto'     — no registered opponent (or legacy row); counts immediately.
--   'pending'  — logged against a Vollo player; awaiting their confirmation.
--   'verified' — opponent confirmed; now counts for ELO/streak/domination.
--   'rejected' — opponent disputed; never counts.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE matches
    ADD CONSTRAINT matches_verification_status_chk
    CHECK (verification_status IN ('auto', 'pending', 'verified', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Powers "matches awaiting my confirmation" lookups without scanning.
CREATE INDEX IF NOT EXISTS matches_pending_opponent_idx
  ON matches (opponent_id) WHERE verification_status = 'pending';

-- ─── 2) Court leaderboard counts only matches that actually count ─────────
-- Same deterministic ranking as migration 003, but excludes pending/rejected
-- matches so an unconfirmed result can't seize a court or draw territory.
CREATE OR REPLACE VIEW court_leaderboard AS
SELECT
  m.court_id,
  m.user_id,
  ROUND(SUM(m.match_score), 2)                         AS score,
  COUNT(*)                                             AS matches_played,
  COUNT(*) FILTER (WHERE m.result = 'win')             AS wins,
  COUNT(*) FILTER (WHERE m.result = 'loss')            AS losses,
  SUM(m.games_won)                                     AS games_won,
  SUM(m.games_lost)                                    AS games_lost,
  MAX(m.played_at)                                     AS last_played_at,
  RANK() OVER (
    PARTITION BY m.court_id
    ORDER BY SUM(m.match_score) DESC,
             COUNT(*) FILTER (WHERE m.result = 'win') DESC,
             MAX(m.played_at) ASC,
             m.user_id ASC
  ) AS rank
FROM matches m
WHERE m.court_id IS NOT NULL
  AND m.played_at >= now() - INTERVAL '30 days'
  AND m.verification_status IN ('auto', 'verified')
GROUP BY m.court_id, m.user_id;

ALTER VIEW public.court_leaderboard SET (security_invoker = on);
REVOKE ALL ON public.court_leaderboard FROM anon, authenticated;

-- ─── 3) Feed view must expose the new match columns ──────────────────────
-- match_feed selects m.*, so the new columns slot into the MIDDLE of the
-- column list — CREATE OR REPLACE can't reorder, so drop & recreate. Identical
-- to migration 002 otherwise; nothing in the DB depends on it (only the API).
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
  (SELECT COUNT(*) FROM kudos k WHERE k.match_id = m.id)      AS kudos_count,
  (SELECT COUNT(*) FROM comments cm WHERE cm.match_id = m.id) AS comment_count
FROM matches m
JOIN users u        ON u.id = m.user_id
LEFT JOIN courts c  ON c.id = m.court_id
LEFT JOIN users opp ON opp.id = m.opponent_id;

ALTER VIEW public.match_feed SET (security_invoker = on);
REVOKE ALL ON public.match_feed FROM anon, authenticated;

-- ─── 4) New notification kinds ───────────────────────────────────────────
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'match_verify_request';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'match_verified';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'match_rejected';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'turf_war';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'challenge';

-- ─── 5) Challenge flag for scheduled matches ─────────────────────────────
-- A challenge is a scheduled-match proposal with combative framing; the
-- lifecycle (propose → accept/decline → log result) is otherwise identical.
ALTER TABLE scheduled_matches
  ADD COLUMN IF NOT EXISTS is_challenge BOOLEAN NOT NULL DEFAULT false;

-- ════════════════════════════════════════════════════════════════════════
-- Vollo — views, functions and triggers
-- ════════════════════════════════════════════════════════════════════════

-- ─── updated_at auto-touch ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated      BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_territories_updated BEFORE UPDATE ON territories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_ratings_updated    BEFORE UPDATE ON user_ratings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_streaks_updated    BEFORE UPDATE ON user_streaks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Court leaderboard (trailing 30-day window) ─────────────────────────
-- Score per (court, user) = Σ match_score over the window, where each match's
-- match_score = (games_won − games_lost) × streak_modifier (snapshotted at log
-- time). The user with rank 1 is the Court Controller; rank 1–2 hold a court
-- for territory purposes.
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
  RANK() OVER (PARTITION BY m.court_id ORDER BY SUM(m.match_score) DESC) AS rank
FROM matches m
WHERE m.court_id IS NOT NULL
  AND m.played_at >= now() - INTERVAL '30 days'
GROUP BY m.court_id, m.user_id;

-- ─── Global feed convenience view (denormalised match card) ─────────────
CREATE OR REPLACE VIEW match_feed AS
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
-- Migration version is normalized against the production Supabase ledger.

-- ════════════════════════════════════════════════════════════════════════
-- Vollo — deterministic court controller + a real "match tagged" notification
-- ════════════════════════════════════════════════════════════════════════

-- A proper notification type for "you were tagged in a match" (previously
-- mislabelled as 'follow'). IF NOT EXISTS keeps this idempotent.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'match_tagged';

-- Recreate the court leaderboard with a TOTAL ordering so ties can't produce two
-- rank-1 "controllers" (which made control flap and let 3+ users pass rank<=2).
-- Tiebreakers: more wins, then earliest claim (last_played_at ASC), then user_id
-- to guarantee determinism since user_id is unique within a court.
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
GROUP BY m.court_id, m.user_id;
-- Migration version is normalized against the production Supabase ledger.

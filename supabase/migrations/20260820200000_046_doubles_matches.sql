-- Additive doubles support. Existing rows and clients remain singles by default.
ALTER TABLE public.matches
  ADD COLUMN match_format TEXT NOT NULL DEFAULT 'singles',
  ADD COLUMN partner_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN partner_name TEXT,
  ADD COLUMN opponent2_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN opponent2_name TEXT;

ALTER TABLE public.matches
  ADD CONSTRAINT matches_format_chk CHECK (match_format IN ('singles', 'doubles')),
  ADD CONSTRAINT matches_extra_slots_chk CHECK (
    match_format = 'doubles'
    OR (partner_id IS NULL AND partner_name IS NULL AND opponent2_id IS NULL AND opponent2_name IS NULL)
  ),
  ADD CONSTRAINT matches_doubles_slots_chk CHECK (
    match_format = 'singles'
    OR (
      num_nonnulls(partner_id, NULLIF(regexp_replace(partner_name, '[[:space:]]', '', 'g'), '')) = 1
      AND num_nonnulls(opponent_id, NULLIF(regexp_replace(opponent_name, '[[:space:]]', '', 'g'), '')) = 1
      AND num_nonnulls(opponent2_id, NULLIF(regexp_replace(opponent2_name, '[[:space:]]', '', 'g'), '')) = 1
    )
  ),
  ADD CONSTRAINT matches_partner_xor_chk CHECK (
    num_nonnulls(partner_id, NULLIF(regexp_replace(partner_name, '[[:space:]]', '', 'g'), '')) <= 1
  ),
  ADD CONSTRAINT matches_opponent2_xor_chk CHECK (
    num_nonnulls(opponent2_id, NULLIF(regexp_replace(opponent2_name, '[[:space:]]', '', 'g'), '')) <= 1
  ),
  ADD CONSTRAINT matches_registered_players_unique_chk CHECK (
    user_id <> partner_id AND user_id <> opponent_id AND user_id <> opponent2_id
    AND partner_id <> opponent_id AND partner_id <> opponent2_id AND opponent_id <> opponent2_id
  );

ALTER TABLE public.scheduled_matches
  ADD COLUMN match_format TEXT NOT NULL DEFAULT 'singles',
  ADD COLUMN partner_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN partner_name TEXT,
  ADD COLUMN opponent2_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN opponent2_name TEXT;

ALTER TABLE public.scheduled_matches
  ADD CONSTRAINT scheduled_format_chk CHECK (match_format IN ('singles', 'doubles')),
  ADD CONSTRAINT scheduled_extra_slots_chk CHECK (
    match_format = 'doubles'
    OR (partner_id IS NULL AND partner_name IS NULL AND opponent2_id IS NULL AND opponent2_name IS NULL)
  ),
  ADD CONSTRAINT scheduled_doubles_slots_chk CHECK (
    match_format = 'singles'
    OR (
      num_nonnulls(partner_id, NULLIF(regexp_replace(partner_name, '[[:space:]]', '', 'g'), '')) = 1
      AND num_nonnulls(opponent2_id, NULLIF(regexp_replace(opponent2_name, '[[:space:]]', '', 'g'), '')) = 1
    )
  ),
  ADD CONSTRAINT scheduled_partner_xor_chk CHECK (
    num_nonnulls(partner_id, NULLIF(regexp_replace(partner_name, '[[:space:]]', '', 'g'), '')) <= 1
  ),
  ADD CONSTRAINT scheduled_opponent2_xor_chk CHECK (
    num_nonnulls(opponent2_id, NULLIF(regexp_replace(opponent2_name, '[[:space:]]', '', 'g'), '')) <= 1
  ),
  ADD CONSTRAINT scheduled_registered_players_unique_chk CHECK (
    creator_id <> partner_id AND creator_id <> opponent_id AND creator_id <> opponent2_id
    AND partner_id <> opponent_id AND partner_id <> opponent2_id AND opponent_id <> opponent2_id
  );

CREATE INDEX matches_pending_opponent2_idx
  ON public.matches (opponent2_id, created_at DESC)
  WHERE verification_status = 'pending' AND opponent2_id IS NOT NULL;
CREATE INDEX scheduled_partner_idx ON public.scheduled_matches (partner_id, scheduled_at DESC);
CREATE INDEX scheduled_opponent2_idx ON public.scheduled_matches (opponent2_id, scheduled_at DESC);

DROP VIEW public.match_feed;
CREATE VIEW public.match_feed AS
SELECT
  m.*,
  u.username AS author_username,
  u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url,
  c.name AS court_name,
  c.city AS court_city,
  ST_X(c.geom) AS court_lng,
  ST_Y(c.geom) AS court_lat,
  opp.username AS opponent_username,
  opp.display_name AS opponent_display_name,
  partner.username AS partner_username,
  partner.display_name AS partner_display_name,
  opp2.username AS opponent2_username,
  opp2.display_name AS opponent2_display_name,
  (SELECT COUNT(*) FROM public.kudos k WHERE k.match_id = m.id) AS kudos_count,
  (SELECT COUNT(*) FROM public.comments cm WHERE cm.match_id = m.id) AS comment_count
FROM public.matches m
JOIN public.users u ON u.id = m.user_id
LEFT JOIN public.courts c ON c.id = m.court_id
LEFT JOIN public.users opp ON opp.id = m.opponent_id
LEFT JOIN public.users partner ON partner.id = m.partner_id
LEFT JOIN public.users opp2 ON opp2.id = m.opponent2_id;

ALTER VIEW public.match_feed SET (security_invoker = on);
REVOKE ALL ON public.match_feed FROM anon, authenticated;

-- A block between any two registered participants closes unresolved shared activity.
CREATE OR REPLACE FUNCTION public.sever_relationships_after_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.follows
   WHERE (follower_id = NEW.blocker_id AND following_id = NEW.blocked_id)
      OR (follower_id = NEW.blocked_id AND following_id = NEW.blocker_id);
  DELETE FROM public.follow_requests
   WHERE (requester_id = NEW.blocker_id AND target_id = NEW.blocked_id)
      OR (requester_id = NEW.blocked_id AND target_id = NEW.blocker_id);

  UPDATE public.matches
     SET verification_status = 'rejected', verified_at = now()
   WHERE verification_status = 'pending'
     AND NEW.blocker_id = ANY (ARRAY[user_id, partner_id, opponent_id, opponent2_id])
     AND NEW.blocked_id = ANY (ARRAY[user_id, partner_id, opponent_id, opponent2_id]);

  UPDATE public.scheduled_matches
     SET status = 'cancelled', match_id = NULL, updated_at = now()
   WHERE status IN ('proposed', 'accepted')
     AND NEW.blocker_id = ANY (ARRAY[creator_id, partner_id, opponent_id, opponent2_id])
     AND NEW.blocked_id = ANY (ARRAY[creator_id, partner_id, opponent_id, opponent2_id]);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sever_relationships_after_block()
  FROM PUBLIC, anon, authenticated;

-- Vollo — privacy, social relationship, and account-deletion invariants.
--
-- The Edge Function is the public write surface, but these rules belong in the
-- database too: two requests can otherwise both observe "no block" and commit a
-- block + follow at the same time. Account deletion also cascades through
-- auth.users, so club repair and media-cleanup enqueueing must survive an Edge
-- Function crash after GoTrue has accepted the deletion.

-- Remove any legacy relationship that conflicts with an existing block before
-- enabling the cross-table guards below.
DELETE FROM follows f
USING blocks b
WHERE (f.follower_id = b.blocker_id AND f.following_id = b.blocked_id)
   OR (f.follower_id = b.blocked_id AND f.following_id = b.blocker_id);

DELETE FROM follow_requests r
USING blocks b
WHERE (r.requester_id = b.blocker_id AND r.target_id = b.blocked_id)
   OR (r.requester_id = b.blocked_id AND r.target_id = b.blocker_id);

UPDATE matches m
   SET verification_status = 'rejected', verified_at = now()
  FROM blocks b
 WHERE m.verification_status = 'pending'
   AND ((m.user_id = b.blocker_id AND m.opponent_id = b.blocked_id)
     OR (m.user_id = b.blocked_id AND m.opponent_id = b.blocker_id));

UPDATE scheduled_matches s
   SET status = 'cancelled', match_id = NULL, updated_at = now()
  FROM blocks b
 WHERE s.status IN ('proposed', 'accepted')
   AND ((s.creator_id = b.blocker_id AND s.opponent_id = b.blocked_id)
     OR (s.creator_id = b.blocked_id AND s.opponent_id = b.blocker_id));

-- Serialize all state changes for an unordered pair. A 64-bit advisory key has
-- an astronomically small collision chance; a collision only adds contention,
-- never weakens correctness.
CREATE OR REPLACE FUNCTION public.lock_social_pair(p_left UUID, p_right UUID)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'vollo-social:' || LEAST(p_left, p_right)::text || ':' || GREATEST(p_left, p_right)::text,
      0
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lock_social_pair(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_unblocked_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_left  UUID;
  v_right UUID;
BEGIN
  IF TG_TABLE_NAME = 'follows' THEN
    v_left := NEW.follower_id;
    v_right := NEW.following_id;
  ELSE
    v_left := NEW.requester_id;
    v_right := NEW.target_id;
  END IF;

  PERFORM public.lock_social_pair(v_left, v_right);
  IF EXISTS (
    SELECT 1
      FROM public.blocks b
     WHERE (b.blocker_id = v_left AND b.blocked_id = v_right)
        OR (b.blocker_id = v_right AND b.blocked_id = v_left)
  ) THEN
    RAISE EXCEPTION 'blocked users cannot create a relationship'
      USING ERRCODE = '23514', CONSTRAINT = 'social_relationship_not_blocked';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_unblocked_relationship()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lock_block_pair()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.lock_social_pair(OLD.blocker_id, OLD.blocked_id);
    RETURN OLD;
  END IF;
  PERFORM public.lock_social_pair(NEW.blocker_id, NEW.blocked_id);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lock_block_pair()
  FROM PUBLIC, anon, authenticated;

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

  -- A block must also close every still-actionable interaction. Pending tagged
  -- results have applied no competitive effects, so rejecting them is exact;
  -- open proposals/challenges are cancelled and any pending result binding is
  -- released. Completed historical records remain intact.
  UPDATE public.matches
     SET verification_status = 'rejected', verified_at = now()
   WHERE verification_status = 'pending'
     AND ((user_id = NEW.blocker_id AND opponent_id = NEW.blocked_id)
       OR (user_id = NEW.blocked_id AND opponent_id = NEW.blocker_id));

  UPDATE public.scheduled_matches
     SET status = 'cancelled', match_id = NULL, updated_at = now()
   WHERE status IN ('proposed', 'accepted')
     AND ((creator_id = NEW.blocker_id AND opponent_id = NEW.blocked_id)
       OR (creator_id = NEW.blocked_id AND opponent_id = NEW.blocker_id));
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sever_relationships_after_block()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_follows_unblocked ON public.follows;
CREATE TRIGGER trg_follows_unblocked
  BEFORE INSERT OR UPDATE OF follower_id, following_id ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.guard_unblocked_relationship();

DROP TRIGGER IF EXISTS trg_follow_requests_unblocked ON public.follow_requests;
CREATE TRIGGER trg_follow_requests_unblocked
  BEFORE INSERT OR UPDATE OF requester_id, target_id ON public.follow_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_unblocked_relationship();

DROP TRIGGER IF EXISTS trg_blocks_pair_lock ON public.blocks;
CREATE TRIGGER trg_blocks_pair_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.lock_block_pair();

DROP TRIGGER IF EXISTS trg_blocks_sever_relationships ON public.blocks;
CREATE TRIGGER trg_blocks_sever_relationships
  AFTER INSERT OR UPDATE ON public.blocks
  FOR EACH ROW EXECUTE FUNCTION public.sever_relationships_after_block();

-- Pair-scoped abuse caps and block cleanup should not scan a user's full
-- history as the app grows.
CREATE INDEX IF NOT EXISTS matches_pending_pair_idx
  ON public.matches (user_id, opponent_id)
  WHERE verification_status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_matches_open_pair_idx
  ON public.scheduled_matches (creator_id, opponent_id)
  WHERE status IN ('proposed', 'accepted');

-- A public profile has no approval queue. Convert every still-valid pending
-- request in the same transaction that turns privacy off; the users-row lock
-- serializes this with the API's follow path, so no request can be stranded.
CREATE OR REPLACE FUNCTION public.accept_requests_for_public_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.follows (follower_id, following_id)
  SELECT r.requester_id, r.target_id
    FROM public.follow_requests r
   WHERE r.target_id = NEW.id
     AND NOT EXISTS (
       SELECT 1 FROM public.blocks b
        WHERE (b.blocker_id = r.requester_id AND b.blocked_id = r.target_id)
           OR (b.blocker_id = r.target_id AND b.blocked_id = r.requester_id)
     )
  ON CONFLICT DO NOTHING;

  DELETE FROM public.follow_requests WHERE target_id = NEW.id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_requests_for_public_profile()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_accept_requests_when_public ON public.users;
CREATE TRIGGER trg_users_accept_requests_when_public
  AFTER UPDATE OF is_private ON public.users
  FOR EACH ROW
  WHEN (OLD.is_private AND NOT NEW.is_private)
  EXECUTE FUNCTION public.accept_requests_for_public_profile();

-- A raw FK cascade used to bypass the Edge Function's leaveClub() repair path,
-- which could leave a club with no administrator. Keep the invariant true for
-- account deletion and every future database-side membership removal.
CREATE OR REPLACE FUNCTION public.repair_club_after_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Use the same lock order as the Edge Function's leaveClub(): club row first,
  -- then membership inspection. This avoids an advisory/row-lock inversion when
  -- account deletion races a normal leave request.
  PERFORM 1 FROM public.clubs c WHERE c.id = OLD.club_id FOR UPDATE;
  -- The parent club may itself be in the process of being deleted.
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('vollo-club:' || OLD.club_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id = OLD.club_id) THEN
    DELETE FROM public.clubs WHERE id = OLD.club_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.club_members m
     WHERE m.club_id = OLD.club_id AND m.role = 'admin'
  ) THEN
    UPDATE public.club_members
       SET role = 'admin'
     WHERE club_id = OLD.club_id
       AND user_id = (
         SELECT m.user_id
           FROM public.club_members m
          WHERE m.club_id = OLD.club_id
          ORDER BY m.joined_at ASC, m.user_id ASC
          LIMIT 1
       );
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.repair_club_after_member_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_club_members_repair_after_delete ON public.club_members;
CREATE TRIGGER trg_club_members_repair_after_delete
  AFTER DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.repair_club_after_member_delete();

-- Storage objects are external to the relational FK graph. The trigger records
-- the auth-id folder only after the profile is actually deleted, so an Auth
-- provider failure can never erase media from a still-live account. The Edge
-- Function consumes this durable queue through the Storage API (never by
-- deleting storage.objects directly, which would orphan the physical object).
CREATE TABLE IF NOT EXISTS public.media_cleanup_jobs (
  auth_id         UUID PRIMARY KEY,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_cleanup_jobs_ready_idx
  ON public.media_cleanup_jobs (next_attempt_at, created_at);

ALTER TABLE public.media_cleanup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_cleanup_jobs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_deleted_user_media()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.auth_id IS NOT NULL THEN
    INSERT INTO public.media_cleanup_jobs (auth_id)
    VALUES (OLD.auth_id)
    ON CONFLICT (auth_id) DO UPDATE
      SET next_attempt_at = now(), locked_until = NULL, last_error = NULL,
          updated_at = now();
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_deleted_user_media()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_enqueue_deleted_media ON public.users;
CREATE TRIGGER trg_users_enqueue_deleted_media
  AFTER DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_deleted_user_media();

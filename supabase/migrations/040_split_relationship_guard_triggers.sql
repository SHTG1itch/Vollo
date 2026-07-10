-- A trigger function receives the row type of the table that fired it. Sharing
-- one function between follows and follow_requests made both incompatible NEW
-- record shapes reachable to static analysis. Keep the invariant in one typed
-- helper and give each table a trigger function that references only its own
-- columns.

DROP TRIGGER IF EXISTS trg_follows_unblocked ON public.follows;
DROP TRIGGER IF EXISTS trg_follow_requests_unblocked ON public.follow_requests;
DROP FUNCTION IF EXISTS public.guard_unblocked_relationship();

CREATE OR REPLACE FUNCTION public.assert_unblocked_relationship(
  p_left UUID,
  p_right UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.lock_social_pair(p_left, p_right);

  IF EXISTS (
    SELECT 1
      FROM public.blocks AS block
     WHERE (block.blocker_id = p_left AND block.blocked_id = p_right)
        OR (block.blocker_id = p_right AND block.blocked_id = p_left)
  ) THEN
    RAISE EXCEPTION 'blocked users cannot create a relationship'
      USING ERRCODE = '23514', CONSTRAINT = 'social_relationship_not_blocked';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_unblocked_relationship(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_unblocked_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_unblocked_relationship(NEW.follower_id, NEW.following_id);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_unblocked_follow()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_unblocked_follow_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_unblocked_relationship(NEW.requester_id, NEW.target_id);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_unblocked_follow_request()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_follows_unblocked
  BEFORE INSERT OR UPDATE OF follower_id, following_id ON public.follows
  FOR EACH ROW EXECUTE FUNCTION public.guard_unblocked_follow();

CREATE TRIGGER trg_follow_requests_unblocked
  BEFORE INSERT OR UPDATE OF requester_id, target_id ON public.follow_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_unblocked_follow_request();

-- 034: durably remove a match photo when its owning match is deleted.
--
-- Storage objects are not transactional with Postgres. Queue the exact owned
-- path in the match DELETE transaction, then let the Edge maintenance worker
-- remove it through the Storage API with leases and retry backoff.

CREATE TABLE IF NOT EXISTS public.media_object_cleanup_jobs (
  object_path     TEXT PRIMARY KEY,
  auth_id         UUID NOT NULL,
  reason          TEXT NOT NULL DEFAULT 'deleted' CHECK (reason IN ('draft', 'deleted')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT media_object_cleanup_match_path_check CHECK (
    object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
    AND object_path LIKE (auth_id::text || '/match/%')
  )
);

CREATE INDEX IF NOT EXISTS media_object_cleanup_jobs_ready_idx
  ON public.media_object_cleanup_jobs (next_attempt_at, created_at);

ALTER TABLE public.media_object_cleanup_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_object_cleanup_jobs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_deleted_match_media()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_owner_auth_id UUID;
  v_marker CONSTANT TEXT := '/storage/v1/object/public/user-media/';
  v_object_path TEXT;
BEGIN
  IF OLD.photo_url IS NULL OR position(v_marker IN OLD.photo_url) = 0 THEN
    RETURN OLD;
  END IF;

  -- During a normal match deletion the owner row still exists. During an
  -- account cascade it may not; the whole-account media job handles that case.
  SELECT u.auth_id INTO v_owner_auth_id
    FROM public.users u
   WHERE u.id = OLD.user_id;
  IF v_owner_auth_id IS NULL THEN
    RETURN OLD;
  END IF;

  v_object_path := split_part(split_part(split_part(OLD.photo_url, v_marker, 2), '?', 1), '#', 1);
  IF v_object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
     AND v_object_path LIKE (v_owner_auth_id::text || '/match/%') THEN
    INSERT INTO public.media_object_cleanup_jobs (object_path, auth_id, reason)
    VALUES (v_object_path, v_owner_auth_id, 'deleted')
    ON CONFLICT ON CONSTRAINT media_object_cleanup_jobs_pkey DO UPDATE
      SET reason = 'deleted', next_attempt_at = now(), locked_until = NULL, last_error = NULL,
          updated_at = now();
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_deleted_match_media()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_matches_enqueue_media_cleanup ON public.matches;
CREATE TRIGGER trg_matches_enqueue_media_cleanup
  AFTER DELETE ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_deleted_match_media();

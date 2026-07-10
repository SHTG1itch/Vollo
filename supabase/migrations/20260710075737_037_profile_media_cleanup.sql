-- 037: extend durable object cleanup to profile drafts and replaced media.

ALTER TABLE public.media_object_cleanup_jobs
  DROP CONSTRAINT IF EXISTS media_object_cleanup_match_path_check;

ALTER TABLE public.media_object_cleanup_jobs
  ADD CONSTRAINT media_object_cleanup_owned_path_check CHECK (
    (
      object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
      OR object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/profile/(avatar|cover)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$'
      OR object_path ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/(avatar|cover)[.]jpg$'
    )
    AND object_path LIKE (auth_id::text || '/%')
  );

CREATE OR REPLACE FUNCTION public.enqueue_owned_profile_media_url(
  media_url TEXT,
  owner_auth_id UUID,
  media_kind TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_marker CONSTANT TEXT := '/storage/v1/object/public/user-media/';
  v_object_path TEXT;
BEGIN
  IF media_url IS NULL OR owner_auth_id IS NULL OR media_kind NOT IN ('avatar', 'cover')
     OR position(v_marker IN media_url) = 0 THEN
    RETURN;
  END IF;
  v_object_path := split_part(split_part(split_part(media_url, v_marker, 2), '?', 1), '#', 1);
  IF (
       v_object_path ~ ('^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/profile/' || media_kind || '-[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
       OR v_object_path = owner_auth_id::text || '/' || media_kind || '.jpg'
     )
     AND v_object_path LIKE (owner_auth_id::text || '/%') THEN
    INSERT INTO public.media_object_cleanup_jobs (object_path, auth_id, reason)
    VALUES (v_object_path, owner_auth_id, 'deleted')
    ON CONFLICT ON CONSTRAINT media_object_cleanup_jobs_pkey DO UPDATE
      SET reason = 'deleted', next_attempt_at = now(), locked_until = NULL,
          last_error = NULL, updated_at = now();
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_owned_profile_media_url(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_replaced_profile_media()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN
    PERFORM public.enqueue_owned_profile_media_url(OLD.avatar_url, NEW.auth_id, 'avatar');
  END IF;
  IF OLD.cover_url IS DISTINCT FROM NEW.cover_url THEN
    PERFORM public.enqueue_owned_profile_media_url(OLD.cover_url, NEW.auth_id, 'cover');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_replaced_profile_media()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_enqueue_replaced_media ON public.users;
CREATE TRIGGER trg_users_enqueue_replaced_media
  AFTER UPDATE OF avatar_url, cover_url ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_replaced_profile_media();
-- Migration version is normalized against the production Supabase ledger.

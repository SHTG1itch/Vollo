-- 039: retry-safe club creation.
--
-- A lost mobile response must not turn a successful club creation into a
-- confusing name-conflict error on retry. The creator-scoped key returns the
-- original club and cannot collide with another account's request.

ALTER TABLE public.clubs ADD COLUMN IF NOT EXISTS client_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS clubs_creator_client_key_idx
  ON public.clubs (creator_id, client_key)
  WHERE creator_id IS NOT NULL AND client_key IS NOT NULL;

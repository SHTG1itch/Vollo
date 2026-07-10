-- 036: retry-safe court and scheduled-match creation.
--
-- Mobile networks routinely lose a response after the server commits. A
-- per-owner UUID lets the client repeat the logical create without producing a
-- duplicate court/proposal or sending the opponent a second notification.

ALTER TABLE public.courts ADD COLUMN IF NOT EXISTS client_key UUID;
ALTER TABLE public.scheduled_matches ADD COLUMN IF NOT EXISTS client_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS courts_creator_client_key_idx
  ON public.courts (created_by, client_key)
  WHERE created_by IS NOT NULL AND client_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_creator_client_key_idx
  ON public.scheduled_matches (creator_id, client_key)
  WHERE client_key IS NOT NULL;

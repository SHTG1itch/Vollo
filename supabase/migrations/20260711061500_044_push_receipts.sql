-- Track Expo push receipts until the asynchronous delivery result is ready.
-- Immediate send tickets do not reliably report unregistered devices; the
-- existing five-minute media-cleanup sweep processes this bounded queue.

CREATE TABLE IF NOT EXISTS public.push_receipts (
  id UUID PRIMARY KEY,
  token TEXT NOT NULL REFERENCES public.push_tokens(token) ON DELETE CASCADE,
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '15 minutes'),
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT push_receipts_attempts_chk CHECK (attempts BETWEEN 0 AND 8)
);

CREATE INDEX IF NOT EXISTS push_receipts_claim_idx
  ON public.push_receipts (next_check_at, created_at)
  WHERE attempts < 8;

ALTER TABLE public.push_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_receipts FROM PUBLIC, anon, authenticated;

-- Durable consent and abuse-report intake required for Vollo's public UGC.

ALTER TABLE public.users
  ADD COLUMN terms_version TEXT,
  ADD COLUMN terms_accepted_at TIMESTAMPTZ,
  ADD CONSTRAINT users_terms_acceptance_pair_chk CHECK (
    (terms_version IS NULL AND terms_accepted_at IS NULL)
    OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL)
  ),
  ADD CONSTRAINT users_terms_version_length_chk CHECK (
    terms_version IS NULL OR char_length(terms_version) BETWEEN 1 AND 32
  );

CREATE TABLE public.content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'match', 'comment', 'club', 'court')),
  subject_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'spam', 'harassment', 'hate', 'sexual', 'violence', 'impersonation', 'privacy', 'other'
  )),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CONSTRAINT content_reports_review_pair_chk CHECK (
    (status IN ('open', 'reviewing') AND reviewed_at IS NULL)
    OR (status IN ('resolved', 'dismissed') AND reviewed_at IS NOT NULL)
  ),
  UNIQUE (reporter_id, subject_type, subject_id)
);

CREATE INDEX content_reports_moderation_idx
  ON public.content_reports (status, created_at);
CREATE INDEX content_reports_reporter_recent_idx
  ON public.content_reports (reporter_id, created_at DESC);

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.content_reports FROM PUBLIC, anon, authenticated;

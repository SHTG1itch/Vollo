-- ════════════════════════════════════════════════════════════════════════
-- Vollo — follow approval queue for private accounts
--
-- Following a public account stays instant. Following a PRIVATE account now
-- creates a pending follow request the owner must approve: accept creates the
-- follows edge (and unlocks their content for the requester), decline removes
-- the request silently. Unfollowing or blocking cancels pending requests.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS follow_requests (
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, target_id),
  CONSTRAINT follow_requests_not_self CHECK (requester_id <> target_id)
);

-- The owner's inbox reads by target, newest first.
CREATE INDEX IF NOT EXISTS follow_requests_target_idx ON follow_requests (target_id, created_at DESC);

-- Seal the table behind the Edge Function's own auth (same posture as 008).
ALTER TABLE public.follow_requests ENABLE ROW LEVEL SECURITY;

-- Notification kinds for the request lifecycle.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'follow_request';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'follow_accepted';
-- Migration version is normalized against the production Supabase ledger.

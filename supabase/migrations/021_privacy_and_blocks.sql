-- ════════════════════════════════════════════════════════════════════════
-- Vollo — privacy controls + player blocking
--
-- is_private: a private player's matches and stats are visible only to their
-- followers (and themselves) — the Strava "followers-only" posture, enforced
-- in the edge function's feed/profile queries.
--
-- blocks: a directed block. Either direction of a block makes the two players
-- mutually invisible (feed, search, profiles) and prevents follows, kudos and
-- comments between them. Blocking also severs any existing follow edges.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);

-- Feed/search filters look the block up from both ends.
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

-- Seal the table behind the Edge Function's own auth (same posture as 008).
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

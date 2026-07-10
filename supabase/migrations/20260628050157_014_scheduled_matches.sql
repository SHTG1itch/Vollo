-- ════════════════════════════════════════════════════════════════════════
-- Vollo — scheduled matches
--
-- Players can propose a match to another player (or an off-app opponent). When
-- the opponent is on Vollo they accept/decline, and once the match is played and
-- logged it links back here (match_id) so the score is visible to both ends.
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE schedule_status AS ENUM ('proposed', 'accepted', 'declined', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS scheduled_matches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  -- One of opponent_id (a registered Vollo player) or opponent_name (free text
  -- for someone not on the app) identifies who the match is against.
  opponent_id   UUID REFERENCES users(id)  ON DELETE CASCADE,
  opponent_name TEXT,
  court_id      UUID REFERENCES courts(id) ON DELETE SET NULL,
  surface       surface_type,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  note          TEXT,
  status        schedule_status NOT NULL DEFAULT 'proposed',
  -- The logged match this proposal turned into; its score is shown to both.
  match_id      UUID REFERENCES matches(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_has_opponent CHECK (opponent_id IS NOT NULL OR opponent_name IS NOT NULL),
  CONSTRAINT scheduled_not_self     CHECK (opponent_id IS NULL OR opponent_id <> creator_id)
);

CREATE INDEX IF NOT EXISTS scheduled_creator_idx  ON scheduled_matches (creator_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS scheduled_opponent_idx ON scheduled_matches (opponent_id, scheduled_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_scheduled_updated BEFORE UPDATE ON scheduled_matches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seal the table behind the Edge Function's own auth (same posture as 008).
ALTER TABLE public.scheduled_matches ENABLE ROW LEVEL SECURITY;

-- New notification kinds for the scheduling lifecycle.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'match_scheduled';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'schedule_accepted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'schedule_declined';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'schedule_cancelled';
-- Migration version is normalized against the production Supabase ledger.

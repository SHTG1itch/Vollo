-- ════════════════════════════════════════════════════════════════════════
-- Vollo — clubs
--
-- The Strava "clubs" analog: open groups players create and join. A club has
-- a shared feed (its members' matches, still subject to each author's privacy
-- and the viewer's blocks) and a 30-day member leaderboard. The creator is
-- the first admin; if the last admin leaves, the longest-standing member is
-- promoted, and a club whose last member leaves is deleted.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clubs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  city        TEXT,
  -- SET NULL: a deleted creator account must not take the club down with it.
  creator_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Club names are unique case-insensitively ("Ace Club" == "ace club").
CREATE UNIQUE INDEX IF NOT EXISTS clubs_name_unique_idx ON clubs (lower(name));

DO $$ BEGIN
  CREATE TYPE club_role AS ENUM ('admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS club_members (
  club_id   UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      club_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);

CREATE INDEX IF NOT EXISTS club_members_user_idx ON club_members (user_id);

DO $$ BEGIN
  CREATE TRIGGER trg_clubs_updated BEFORE UPDATE ON clubs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seal the tables behind the Edge Function's own auth (same posture as 008).
ALTER TABLE public.clubs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;

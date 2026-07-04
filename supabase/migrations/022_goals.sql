-- ════════════════════════════════════════════════════════════════════════
-- Vollo — training goals
--
-- A player sets weekly or monthly targets (matches played, wins, or hours on
-- court). Progress is computed on read from counted matches in the current
-- period — nothing is denormalised, so deletes/verifications stay exact.
-- One goal per (player, metric, period): setting it again just retargets it.
-- ════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE goal_metric AS ENUM ('matches', 'wins', 'hours');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE goal_period AS ENUM ('weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS goals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric     goal_metric NOT NULL,
  period     goal_period NOT NULL,
  -- Hours goals allow halves (e.g. 2.5h); matches/wins are whole numbers,
  -- enforced in the edge function's validation.
  target     NUMERIC(6,1) NOT NULL CHECK (target > 0 AND target <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT goals_one_per_metric_period UNIQUE (user_id, metric, period)
);

CREATE INDEX IF NOT EXISTS goals_user_idx ON goals (user_id);

DO $$ BEGIN
  CREATE TRIGGER trg_goals_updated BEFORE UPDATE ON goals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seal the table behind the Edge Function's own auth (same posture as 008).
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

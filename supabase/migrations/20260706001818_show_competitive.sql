-- 027: competitive visibility toggle.
--
-- Territory polygons, court/club leaderboard rows and the court-controller
-- banner are governed by this per-user switch instead of private-account
-- follower rules: ON (default) → visible to everybody, the Turf War map is a
-- public game board even for private accounts; OFF → hidden from everyone but
-- the owner. Blocks still make two players mutually invisible.
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_competitive boolean NOT NULL DEFAULT true;
-- Migration version is normalized against the production Supabase ledger.

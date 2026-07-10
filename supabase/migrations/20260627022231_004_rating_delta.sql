-- ════════════════════════════════════════════════════════════════════════
-- Vollo — persist the exact Elo delta a match applied, so deletion is exact
-- ════════════════════════════════════════════════════════════════════════

-- The Elo delta added to the logging player at match time. Backing this out on
-- delete is exact, whereas re-deriving it from *current* ratings drifts the
-- moment either player has logged another match since. NULL for matches logged
-- before this column existed (legacy rows fall back to a best-effort estimate).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS user_rating_delta INT;
-- Migration version is normalized against the production Supabase ledger.

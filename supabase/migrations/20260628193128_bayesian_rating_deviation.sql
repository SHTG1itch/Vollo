-- ════════════════════════════════════════════════════════════════════════
-- Vollo — Bayesian rating deviation
--
-- The per-surface Vollo Rating is now a Gaussian skill posterior N(μ, σ²)
-- updated Bayesianly (Glicko-style) per match. `rating` holds the mean μ; this
-- adds the deviation σ (RD) — the model's uncertainty, which shrinks as a player
-- logs more matches. Existing rows default to the maximal prior deviation (350)
-- and converge to their true value on the next rating recompute (the one-time
-- `ratings` sweep, or the player's next counting match).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE user_ratings
  ADD COLUMN IF NOT EXISTS rating_deviation NUMERIC NOT NULL DEFAULT 350;
-- Migration version is normalized against the production Supabase ledger.

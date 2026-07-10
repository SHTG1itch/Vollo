-- ════════════════════════════════════════════════════════════════════════
-- Vollo — player colour
--
-- Each player picks a signature colour. Their domination-zone polygons render
-- in a 40%-transparent wash of it on the map, so rivals' territories stay
-- distinguishable (and see-through). Stored as a #RRGGBB hex string; NULL means
-- "unset" and the client falls back to a deterministic per-user hue.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS color TEXT
  CONSTRAINT users_color_hex CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
-- Migration version is normalized against the production Supabase ledger.

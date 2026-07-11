-- Support durable rolling per-account creation ceilings without table scans.
-- The Edge function serializes count + insert with transaction advisory locks;
-- these indexes keep each 24-hour count proportional to one account's activity.

CREATE INDEX IF NOT EXISTS matches_user_created_idx
  ON public.matches (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS scheduled_creator_created_idx
  ON public.scheduled_matches (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS comments_user_created_idx
  ON public.comments (user_id, created_at DESC);

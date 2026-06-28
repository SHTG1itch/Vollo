-- ════════════════════════════════════════════════════════════════════════
-- Vollo — initial schema
-- Tennis analytics + geospatial territorial domination engine.
-- Requires PostgreSQL with the PostGIS extension (Supabase free tier ships it).
-- ════════════════════════════════════════════════════════════════════════

-- ─── Extensions ─────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;     -- spatial types, ST_ConvexHull, GIST
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive usernames/emails

-- ─── Enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE surface_type AS ENUM ('hard', 'clay', 'grass', 'indoor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE match_result AS ENUM ('win', 'loss');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM (
    'kudos', 'comment', 'follow',
    'territory_gained', 'territory_lost', 'territory_changed',
    'court_taken', 'court_dethroned',
    'rank_up', 'achievement', 'streak_milestone'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Users ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      CITEXT UNIQUE NOT NULL,
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  bio           TEXT,
  dominant_hand TEXT NOT NULL DEFAULT 'right',   -- 'right' | 'left'
  home_geom     geometry(Point, 4326),
  home_label    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Courts (spatial Points of Interest) ────────────────────────────────
CREATE TABLE IF NOT EXISTS courts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  surface     surface_type NOT NULL DEFAULT 'hard',
  geom        geometry(Point, 4326) NOT NULL,
  address     TEXT,
  city        TEXT,
  osm_id      TEXT,                              -- optional OpenStreetMap reference
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Spatial index powers the 10km radius scan in the domination engine.
CREATE INDEX IF NOT EXISTS courts_geom_gist ON courts USING GIST (geom);

-- ─── Matches (discrete, structured activity entities) ───────────────────
CREATE TABLE IF NOT EXISTS matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  opponent_name    TEXT,                          -- free text for unregistered opponents
  court_id         UUID REFERENCES courts(id) ON DELETE SET NULL,
  surface          surface_type NOT NULL,
  score_array      JSONB NOT NULL,                -- e.g. [[6,4],[2,6],[7,6]]
  result           match_result NOT NULL,
  sets_won         INT NOT NULL DEFAULT 0,
  sets_lost        INT NOT NULL DEFAULT 0,
  games_won        INT NOT NULL DEFAULT 0,
  games_lost       INT NOT NULL DEFAULT 0,
  match_score      NUMERIC NOT NULL DEFAULT 0,    -- (games_won - games_lost) * streak_modifier
  streak_modifier  NUMERIC NOT NULL DEFAULT 1.0,  -- snapshot at log time
  rpe_index        INT CHECK (rpe_index BETWEEN 1 AND 10),
  duration_minutes INT,
  notes            TEXT,
  is_tiebreak      BOOLEAN NOT NULL DEFAULT false,
  played_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_user_played_idx  ON matches (user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS matches_court_played_idx ON matches (court_id, played_at DESC);
CREATE INDEX IF NOT EXISTS matches_played_idx       ON matches (played_at DESC);

-- ─── Per-match detailed stat matrix (1:1 with matches) ──────────────────
CREATE TABLE IF NOT EXISTS match_stats (
  match_id           UUID PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  first_serve_in     INT NOT NULL DEFAULT 0,
  first_serve_total  INT NOT NULL DEFAULT 0,
  second_serve_in    INT NOT NULL DEFAULT 0,
  second_serve_total INT NOT NULL DEFAULT 0,
  aces               INT NOT NULL DEFAULT 0,
  double_faults      INT NOT NULL DEFAULT 0,
  forehand_winners   INT NOT NULL DEFAULT 0,
  forehand_errors    INT NOT NULL DEFAULT 0,
  backhand_winners   INT NOT NULL DEFAULT 0,
  backhand_errors    INT NOT NULL DEFAULT 0,
  volley_winners     INT NOT NULL DEFAULT 0,
  volley_errors      INT NOT NULL DEFAULT 0,
  rally_short        INT NOT NULL DEFAULT 0,   -- 1-4 shots
  rally_medium       INT NOT NULL DEFAULT 0,   -- 5-8 shots
  rally_long         INT NOT NULL DEFAULT 0,   -- 9+ shots
  break_points_won   INT NOT NULL DEFAULT 0,
  break_points_total INT NOT NULL DEFAULT 0
);

-- ─── Social engine ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kudos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS kudos_match_idx ON kudos (match_id);

CREATE TABLE IF NOT EXISTS comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_match_idx ON comments (match_id, created_at);

CREATE TABLE IF NOT EXISTS follows (
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS follows_following_idx ON follows (following_id);

-- ─── Temporal heat index (streaks) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_streaks (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_streak_weeks INT NOT NULL DEFAULT 0,    -- consecutive 7-day windows with >=1 match
  longest_streak_weeks INT NOT NULL DEFAULT 0,
  streak_modifier      NUMERIC NOT NULL DEFAULT 1.0,
  last_match_at        TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Geospatial domination: territories (convex-hull polygons) ──────────
CREATE TABLE IF NOT EXISTS territories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  geom          geometry(Polygon, 4326) NOT NULL,
  center_geom   geometry(Point, 4326) NOT NULL,
  court_count   INT NOT NULL DEFAULT 0,
  area_sqkm     NUMERIC NOT NULL DEFAULT 0,
  district_name TEXT NOT NULL DEFAULT 'Territory',
  court_ids     UUID[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS territories_geom_gist ON territories USING GIST (geom);
CREATE INDEX IF NOT EXISTS territories_user_idx  ON territories (user_id);

-- ─── Per-surface skill rating (Vollo Rating — ELO-style) ────────────────
CREATE TABLE IF NOT EXISTS user_ratings (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface        surface_type NOT NULL,
  rating         NUMERIC NOT NULL DEFAULT 1000,
  matches_played INT NOT NULL DEFAULT 0,
  wins           INT NOT NULL DEFAULT 0,
  losses         INT NOT NULL DEFAULT 0,
  peak_rating    NUMERIC NOT NULL DEFAULT 1000,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, surface)
);

-- ─── Achievements / badges ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '🎾',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, code)
);

-- ─── Notifications ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       notification_type NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- ─── Expo / FCM / APNs push tokens ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_tokens (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'expo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

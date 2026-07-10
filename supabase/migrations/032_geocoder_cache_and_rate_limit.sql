-- 032: shared geocoder cache and provider rate-limit state.
--
-- Edge isolates are independent processes. A process-local timer cannot enforce
-- Nominatim's one-request-per-second application-wide limit, so the API leases a
-- single row atomically before each outbound request. Search inputs are SHA-256
-- cache keys; raw user queries are never stored in these tables.

CREATE TABLE IF NOT EXISTS public.geocode_cache (
  cache_key  TEXT PRIMARY KEY CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  provider   TEXT NOT NULL CHECK (provider IN ('nominatim', 'geoapify')),
  kind       TEXT NOT NULL CHECK (kind IN ('forward', 'reverse')),
  payload    JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geocode_cache_expiry_idx
  ON public.geocode_cache (expires_at);

CREATE TABLE IF NOT EXISTS public.outbound_service_limits (
  service         TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ NOT NULL
);

-- Fleet-wide Overpass viewport cache/lease. The key is a SHA-256 digest of the
-- snapped bounding box, so map usage is not retained as raw coordinates.
CREATE TABLE IF NOT EXISTS public.court_discovery_cells (
  cell_key        TEXT PRIMARY KEY CHECK (cell_key ~ '^[0-9a-f]{64}$'),
  next_refresh_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS court_discovery_cells_ready_idx
  ON public.court_discovery_cells (next_refresh_at, locked_until);

-- These tables are backend-only. Explicit revokes protect projects whose public
-- schema still carries Supabase's historical permissive default grants.
ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_service_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.court_discovery_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.geocode_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.outbound_service_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.court_discovery_cells FROM PUBLIC, anon, authenticated;

-- Bound stale cache growth without exposing a maintenance endpoint.
SELECT cron.schedule(
  'vollo-geocode-cache-cleanup',
  '15 4 * * 0',
  $$
  DELETE FROM public.geocode_cache WHERE expires_at < now() - interval '7 days';
  DELETE FROM public.court_discovery_cells
   WHERE next_refresh_at < now() - interval '7 days'
     AND (locked_until IS NULL OR locked_until < now());
  $$
);

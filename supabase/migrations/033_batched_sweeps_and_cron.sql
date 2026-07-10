-- 033: bounded maintenance sweeps and portable cron invocation.
--
-- Recomputing every user in one Edge invocation eventually exceeds the hosted
-- wall-clock ceiling. Cursor batches spread idempotent work across frequent cron
-- calls, while expiring tokenized leases prevent overlap and stale completion.

CREATE TABLE IF NOT EXISTS public.sweep_state (
  sweep_type     TEXT PRIMARY KEY CHECK (sweep_type IN ('streak', 'territory', 'ratings')),
  -- This is an ordering cursor, not an ownership reference. Keeping a deleted
  -- UUID is intentional so a concurrent account deletion cannot rewind a pass.
  cursor_user_id UUID,
  lease_token    UUID,
  lease_until    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sweep_lease_pair_chk CHECK (
    (lease_token IS NULL AND lease_until IS NULL)
    OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)
  )
);

ALTER TABLE public.sweep_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sweep_state FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- Provision `project_url` in Vault independently in each deployed environment
-- (see README). A clean local/CI database intentionally has no endpoint: the
-- guarded SELECTs below then produce zero rows and cannot call another project.
-- This also keeps a production hostname out of portable schema migrations.

-- Replace the unbounded legacy schedules if they exist.
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('vollo-streak-sweep', 'vollo-territory-sweep', 'vollo-media-cleanup')
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END $$;

SELECT cron.schedule(
  'vollo-streak-sweep',
  '*/15 * * * *',
  $job$
  SELECT net.http_post(
    url := rtrim(endpoint.decrypted_secret, '/') || '/functions/v1/api/internal/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (SELECT value FROM public.app_secrets WHERE key = 'internal_secret')
    ),
    body := jsonb_build_object('type', 'streak'),
    timeout_milliseconds := 300000
  )
  FROM vault.decrypted_secrets AS endpoint
  WHERE endpoint.name = 'project_url'
    AND endpoint.decrypted_secret ~ '^https://[a-z0-9]{20}\.supabase\.co/?$';
  $job$
);

SELECT cron.schedule(
  'vollo-territory-sweep',
  '*/30 * * * *',
  $job$
  SELECT net.http_post(
    url := rtrim(endpoint.decrypted_secret, '/') || '/functions/v1/api/internal/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (SELECT value FROM public.app_secrets WHERE key = 'internal_secret')
    ),
    body := jsonb_build_object('type', 'territory'),
    timeout_milliseconds := 300000
  )
  FROM vault.decrypted_secrets AS endpoint
  WHERE endpoint.name = 'project_url'
    AND endpoint.decrypted_secret ~ '^https://[a-z0-9]{20}\.supabase\.co/?$';
  $job$
);

SELECT cron.schedule(
  'vollo-media-cleanup',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url := rtrim(endpoint.decrypted_secret, '/') || '/functions/v1/api/internal/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (SELECT value FROM public.app_secrets WHERE key = 'internal_secret')
    ),
    body := jsonb_build_object('type', 'media_cleanup'),
    timeout_milliseconds := 120000
  )
  FROM vault.decrypted_secrets AS endpoint
  WHERE endpoint.name = 'project_url'
    AND endpoint.decrypted_secret ~ '^https://[a-z0-9]{20}\.supabase\.co/?$';
  $job$
);

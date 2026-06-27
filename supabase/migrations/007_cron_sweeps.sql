-- Replace the old node-cron worker process with database-native pg_cron jobs.
-- Each job POSTs to the Edge Function's guarded internal sweep endpoint via
-- pg_net, reading the shared secret from app_secrets at call time (so no secret
-- literal is stored in the job definition). Runs entirely on the free tier.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Daily 03:00 UTC — temporal-heat-index (streak) sweep.
SELECT cron.schedule(
  'vollo-streak-sweep',
  '0 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/internal/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (SELECT value FROM app_secrets WHERE key = 'internal_secret')
    ),
    body := jsonb_build_object('type', 'streak')
  );
  $$
);

-- Every 6 hours — territory recompute + achievement sweep.
SELECT cron.schedule(
  'vollo-territory-sweep',
  '0 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/internal/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-secret', (SELECT value FROM app_secrets WHERE key = 'internal_secret')
    ),
    body := jsonb_build_object('type', 'territory')
  );
  $$
);

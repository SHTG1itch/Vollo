-- 035: bounded retention for high-churn operational rows.
--
-- Credential-throttle events are useful only inside their short enforcement
-- window. Read notifications remain visible for six months and unread ones for
-- at most a year, then age out in small hourly batches so neither table grows
-- without bound or causes a large transaction after a traffic spike.

CREATE INDEX IF NOT EXISTS notifications_unread_user_idx
  ON public.notifications (user_id)
  WHERE read = false;

CREATE INDEX IF NOT EXISTS notifications_read_retention_idx
  ON public.notifications (created_at)
  WHERE read = true;

CREATE INDEX IF NOT EXISTS notifications_expiry_idx
  ON public.notifications (created_at);

SELECT cron.schedule(
  'vollo-login-attempt-retention',
  '7 * * * *',
  $job$
  WITH expired AS (
    SELECT id
      FROM public.login_attempts
     WHERE attempted_at < now() - interval '24 hours'
     ORDER BY attempted_at ASC
     LIMIT 10000
  )
  DELETE FROM public.login_attempts a
   USING expired e
   WHERE a.id = e.id;
  $job$
);

SELECT cron.schedule(
  'vollo-notification-retention',
  '17 * * * *',
  $job$
  WITH expired AS (
    SELECT id
      FROM public.notifications
     WHERE (read = true AND created_at < now() - interval '180 days')
        OR created_at < now() - interval '365 days'
     ORDER BY created_at ASC
     LIMIT 10000
  )
  DELETE FROM public.notifications n
   USING expired e
   WHERE n.id = e.id;
  $job$
);
-- Migration version is normalized against the production Supabase ledger.

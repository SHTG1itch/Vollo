-- Linked-project production audit. Run explicitly with:
--   supabase test db --linked supabase/linked-tests/production_readonly_test.sql
--
-- The pgTAP extension creation and every catalog read are wrapped in a rollback,
-- so this leaves no fixture rows or extension state behind if pgTAP was absent.
BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(21);

SELECT extensions.has_table('public', 'media_object_cleanup_jobs', 'latest cleanup schema is deployed');
SELECT extensions.has_index('public', 'matches', 'matches_user_created_idx', 'match abuse-cap index is deployed');
SELECT extensions.has_index('public', 'scheduled_matches', 'scheduled_creator_created_idx', 'schedule abuse-cap index is deployed');
SELECT extensions.has_index('public', 'comments', 'comments_user_created_idx', 'comment abuse-cap index is deployed');

SELECT extensions.ok(
  NOT has_schema_privilege('anon', 'public', 'USAGE'),
  'anon cannot resolve the application schema'
);
SELECT extensions.ok(
  NOT has_schema_privilege('authenticated', 'public', 'USAGE'),
  'authenticated cannot resolve the application schema'
);
SELECT extensions.ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_namespace n,
           LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
     WHERE n.nspname = 'public'
       AND acl.grantee = 0
       AND acl.privilege_type = 'USAGE'
  ),
  'PUBLIC has no application-schema usage'
);
SELECT extensions.ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
  ),
  'client roles have no direct application-table grants'
);

WITH expected(name) AS (
  SELECT unnest(ARRAY[
    'users', 'courts', 'matches', 'match_stats', 'kudos', 'comments',
    'follows', 'user_streaks', 'territories', 'user_ratings', 'achievements',
    'notifications', 'push_tokens', 'app_secrets', 'scheduled_matches',
    'blocks', 'goals', 'clubs', 'club_members', 'follow_requests',
    'geocode_cache', 'outbound_service_limits', 'court_discovery_cells',
    'sweep_state', 'media_cleanup_jobs', 'media_object_cleanup_jobs'
  ]::text[])
), state AS (
  SELECT e.name, c.relrowsecurity
    FROM expected e
    LEFT JOIN (
      pg_class c
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
       AND n.nspname = 'public'
    ) ON c.relname = e.name
)
SELECT extensions.is(
  (SELECT count(*)::integer FROM state WHERE relrowsecurity),
  26,
  'every application table has RLS enabled'
);
WITH expected(name) AS (
  SELECT unnest(ARRAY[
    'users', 'courts', 'matches', 'match_stats', 'kudos', 'comments',
    'follows', 'user_streaks', 'territories', 'user_ratings', 'achievements',
    'notifications', 'push_tokens', 'app_secrets', 'scheduled_matches',
    'blocks', 'goals', 'clubs', 'club_members', 'follow_requests',
    'geocode_cache', 'outbound_service_limits', 'court_discovery_cells',
    'sweep_state', 'media_cleanup_jobs', 'media_object_cleanup_jobs'
  ]::text[])
)
SELECT extensions.is(
  (SELECT count(*)::integer
     FROM expected e
     JOIN pg_class c ON c.relname = e.name
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'),
  26,
  'every expected application table exists'
);

SELECT extensions.is(
  (SELECT count(*)::integer FROM storage.buckets WHERE id = 'user-media'),
  1,
  'user-media bucket exists exactly once'
);
SELECT extensions.ok(
  EXISTS (
    SELECT 1 FROM storage.buckets
     WHERE id = 'user-media'
       AND public
       AND file_size_limit = 8388608
       AND allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  ),
  'user-media bucket has the production visibility, size, and MIME limits'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname LIKE 'user-media %'),
  4,
  'user-media has exactly four ownership/read policies'
);
SELECT extensions.ok(
  EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'user-media owner insert'
       AND with_check LIKE '%/profile/%'
       AND with_check LIKE '%/match/%'
  ),
  'Storage inserts remain restricted to Vollo object shapes'
);

SELECT extensions.is(
  (SELECT count(*)::integer FROM cron.job
    WHERE jobname IN (
      'vollo-streak-sweep', 'vollo-territory-sweep', 'vollo-media-cleanup',
      'vollo-login-attempt-retention', 'vollo-notification-retention',
      'vollo-geocode-cache-cleanup'
    )),
  6,
  'all six bounded maintenance schedules exist exactly once'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM cron.job
    WHERE active AND jobname LIKE 'vollo-%'),
  6,
  'all Vollo maintenance schedules are active'
);
SELECT extensions.ok(
  (SELECT bool_and(command LIKE '%timeout_milliseconds%')
     FROM cron.job
    WHERE jobname IN ('vollo-streak-sweep', 'vollo-territory-sweep', 'vollo-media-cleanup')),
  'every Edge-backed cron request has an explicit timeout'
);

SELECT extensions.is(
  (SELECT count(*)::integer FROM vault.decrypted_secrets WHERE name = 'project_url'),
  1,
  'production Vault has exactly one project_url'
);
SELECT extensions.ok(
  EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
     WHERE name = 'project_url'
       AND decrypted_secret ~ '^https://[a-z0-9]{20}[.]supabase[.]co/?$'
  ),
  'production project_url is a trusted Supabase origin'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM public.app_secrets WHERE key = 'internal_secret'),
  1,
  'the internal sweep secret exists exactly once'
);
SELECT extensions.ok(
  EXISTS (
    SELECT 1 FROM public.app_secrets
     WHERE key = 'internal_secret' AND length(value) >= 32
  ),
  'the internal sweep secret has production-strength length'
);

SELECT * FROM extensions.finish();
ROLLBACK;

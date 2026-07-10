-- Cross-table production invariants introduced after the original auth pgTAP
-- suite. Every fixture is rolled back; CI runs this only after replaying all
-- migrations on a clean local Supabase database.
BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(36);

SELECT extensions.has_table('public', 'geocode_cache', 'geocoder cache exists');
SELECT extensions.has_table('public', 'outbound_service_limits', 'shared provider limiter exists');
SELECT extensions.has_table('public', 'court_discovery_cells', 'shared court discovery lease exists');
SELECT extensions.has_table('public', 'media_cleanup_jobs', 'durable media cleanup queue exists');
SELECT extensions.has_table('public', 'media_object_cleanup_jobs', 'durable object cleanup queue exists');
SELECT extensions.has_table('public', 'sweep_state', 'bounded sweep state exists');
SELECT extensions.has_column('public', 'courts', 'client_key', 'court creation has an idempotency key');
SELECT extensions.has_column('public', 'scheduled_matches', 'client_key', 'scheduled creation has an idempotency key');
SELECT extensions.has_column('public', 'clubs', 'client_key', 'club creation has an idempotency key');
SELECT extensions.has_trigger('public', 'follows', 'trg_follows_unblocked', 'follows enforce block boundary');
SELECT extensions.has_trigger('public', 'follow_requests', 'trg_follow_requests_unblocked', 'requests enforce block boundary');
SELECT extensions.has_trigger('public', 'blocks', 'trg_blocks_sever_relationships', 'blocks sever relationships');
SELECT extensions.has_trigger('public', 'users', 'trg_users_accept_requests_when_public', 'public transition drains requests');
SELECT extensions.has_trigger('public', 'club_members', 'trg_club_members_repair_after_delete', 'club membership cascades repair admins');
SELECT extensions.has_trigger('public', 'matches', 'trg_matches_enqueue_media_cleanup', 'match deletion queues photo cleanup');
SELECT extensions.has_trigger('public', 'users', 'trg_users_enqueue_replaced_media', 'profile changes queue replaced media cleanup');
SELECT extensions.ok(
  EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'user-media owner insert'
       AND cmd = 'INSERT'
       AND with_check LIKE '%/profile/%'
       AND with_check LIKE '%/match/%'
  ),
  'Storage inserts are restricted to Vollo media object shapes'
);

INSERT INTO public.users (id, username, email, display_name, is_private)
VALUES
  ('03100000-0000-4000-8000-000000000001', 'privacy_a', 'privacy-a@example.test', 'Privacy A', false),
  ('03100000-0000-4000-8000-000000000002', 'privacy_b', 'privacy-b@example.test', 'Privacy B', true),
  ('03100000-0000-4000-8000-000000000003', 'privacy_c', 'privacy-c@example.test', 'Privacy C', false),
  ('03100000-0000-4000-8000-000000000004', 'cleanup_d', 'cleanup-d@example.test', 'Cleanup D', false);

INSERT INTO public.blocks (blocker_id, blocked_id)
VALUES ('03100000-0000-4000-8000-000000000001', '03100000-0000-4000-8000-000000000002');

SELECT extensions.throws_ok(
  $$INSERT INTO public.follows (follower_id, following_id)
    VALUES ('03100000-0000-4000-8000-000000000001', '03100000-0000-4000-8000-000000000002')$$,
  '23514',
  'blocked users cannot create a relationship',
  'a blocked pair cannot race a follow into existence'
);

SELECT extensions.throws_ok(
  $$INSERT INTO public.follow_requests (requester_id, target_id)
    VALUES ('03100000-0000-4000-8000-000000000001', '03100000-0000-4000-8000-000000000002')$$,
  '23514',
  'blocked users cannot create a relationship',
  'a blocked pair cannot race a follow request into existence'
);

DELETE FROM public.blocks
 WHERE blocker_id = '03100000-0000-4000-8000-000000000001'
   AND blocked_id = '03100000-0000-4000-8000-000000000002';
INSERT INTO public.follow_requests (requester_id, target_id)
VALUES ('03100000-0000-4000-8000-000000000001', '03100000-0000-4000-8000-000000000002');
INSERT INTO public.matches (
  id, user_id, opponent_id, surface, score_array, result,
  sets_won, sets_lost, games_won, games_lost, verification_status
) VALUES (
  '03100000-0000-4000-8000-000000000301',
  '03100000-0000-4000-8000-000000000001',
  '03100000-0000-4000-8000-000000000002',
  'hard', '[[6,0]]'::jsonb, 'win', 1, 0, 6, 0, 'pending'
);
INSERT INTO public.scheduled_matches (
  id, creator_id, opponent_id, scheduled_at, status, match_id
) VALUES (
  '03100000-0000-4000-8000-000000000302',
  '03100000-0000-4000-8000-000000000001',
  '03100000-0000-4000-8000-000000000002',
  '2026-12-01T20:00:00Z', 'accepted',
  '03100000-0000-4000-8000-000000000301'
);
INSERT INTO public.blocks (blocker_id, blocked_id)
VALUES ('03100000-0000-4000-8000-000000000002', '03100000-0000-4000-8000-000000000001');

SELECT extensions.is(
  (SELECT count(*)::integer FROM public.follow_requests
    WHERE requester_id = '03100000-0000-4000-8000-000000000001'
      AND target_id = '03100000-0000-4000-8000-000000000002'),
  0,
  'creating a block severs pending requests'
);
SELECT extensions.is(
  (SELECT verification_status FROM public.matches
    WHERE id = '03100000-0000-4000-8000-000000000301'),
  'rejected',
  'creating a block rejects pending shared results'
);
SELECT extensions.is(
  (SELECT status::text || ':' || COALESCE(match_id::text, 'none')
     FROM public.scheduled_matches
    WHERE id = '03100000-0000-4000-8000-000000000302'),
  'cancelled:none',
  'creating a block cancels and releases open schedules'
);

DELETE FROM public.blocks
 WHERE blocker_id = '03100000-0000-4000-8000-000000000002'
   AND blocked_id = '03100000-0000-4000-8000-000000000001';
INSERT INTO public.follow_requests (requester_id, target_id)
VALUES ('03100000-0000-4000-8000-000000000001', '03100000-0000-4000-8000-000000000002');
UPDATE public.users SET is_private = false
 WHERE id = '03100000-0000-4000-8000-000000000002';

SELECT extensions.is(
  (SELECT count(*)::integer FROM public.follows
    WHERE follower_id = '03100000-0000-4000-8000-000000000001'
      AND following_id = '03100000-0000-4000-8000-000000000002'),
  1,
  'making a profile public accepts its pending request'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM public.follow_requests
    WHERE target_id = '03100000-0000-4000-8000-000000000002'),
  0,
  'making a profile public leaves no approval queue'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03100000-0000-4000-8000-000000000104',
  'authenticated', 'authenticated', 'cleanup-auth@example.test', '', NULL,
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  clock_timestamp(), clock_timestamp()
);
UPDATE public.users SET auth_id = '03100000-0000-4000-8000-000000000104'
 WHERE id = '03100000-0000-4000-8000-000000000004';
DELETE FROM public.users WHERE id = '03100000-0000-4000-8000-000000000004';

SELECT extensions.is(
  (SELECT count(*)::integer FROM public.media_cleanup_jobs
    WHERE auth_id = '03100000-0000-4000-8000-000000000104'),
  1,
  'deleting a linked profile durably queues its Storage folder'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03100000-0000-4000-8000-000000000103',
  'authenticated', 'authenticated', 'privacy-c@example.test', '', clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  clock_timestamp(), clock_timestamp()
);
INSERT INTO public.matches (
  id, user_id, surface, score_array, result,
  sets_won, sets_lost, games_won, games_lost, verification_status, photo_url
) VALUES (
  '03100000-0000-4000-8000-000000000303',
  '03100000-0000-4000-8000-000000000003',
  'hard', '[[6,0]]'::jsonb, 'win', 1, 0, 6, 0, 'auto',
  'https://example.supabase.co/storage/v1/object/public/user-media/03100000-0000-4000-8000-000000000103/match/draft-1.jpg?v=1'
);
DELETE FROM public.matches WHERE id = '03100000-0000-4000-8000-000000000303';

SELECT extensions.is(
  (SELECT count(*)::integer FROM public.media_object_cleanup_jobs
    WHERE object_path = '03100000-0000-4000-8000-000000000103/match/draft-1.jpg'
      AND auth_id = '03100000-0000-4000-8000-000000000103'),
  1,
  'deleting a match durably queues its exact owned photo'
);

UPDATE public.users
   SET avatar_url = 'https://example.supabase.co/storage/v1/object/public/user-media/03100000-0000-4000-8000-000000000103/profile/avatar-test.jpg?v=1'
 WHERE id = '03100000-0000-4000-8000-000000000003';
UPDATE public.users SET avatar_url = NULL
 WHERE id = '03100000-0000-4000-8000-000000000003';

SELECT extensions.is(
  (SELECT count(*)::integer FROM public.media_object_cleanup_jobs
    WHERE object_path = '03100000-0000-4000-8000-000000000103/profile/avatar-test.jpg'
      AND auth_id = '03100000-0000-4000-8000-000000000103'
      AND reason = 'deleted'),
  1,
  'replacing an owned profile photo durably queues its exact object'
);

INSERT INTO public.clubs (id, name, creator_id)
VALUES ('03100000-0000-4000-8000-000000000201', 'Invariant Club', '03100000-0000-4000-8000-000000000002');
INSERT INTO public.club_members (club_id, user_id, role, joined_at)
VALUES
  ('03100000-0000-4000-8000-000000000201', '03100000-0000-4000-8000-000000000002', 'admin', '2026-01-01T00:00:00Z'),
  ('03100000-0000-4000-8000-000000000201', '03100000-0000-4000-8000-000000000003', 'member', '2026-01-02T00:00:00Z');
DELETE FROM public.club_members
 WHERE club_id = '03100000-0000-4000-8000-000000000201'
   AND user_id = '03100000-0000-4000-8000-000000000002';

SELECT extensions.is(
  (SELECT role::text FROM public.club_members
    WHERE club_id = '03100000-0000-4000-8000-000000000201'
      AND user_id = '03100000-0000-4000-8000-000000000003'),
  'admin',
  'removing the last admin promotes the oldest member'
);
DELETE FROM public.club_members
 WHERE club_id = '03100000-0000-4000-8000-000000000201'
   AND user_id = '03100000-0000-4000-8000-000000000003';
SELECT extensions.is(
  (SELECT count(*)::integer FROM public.clubs
    WHERE id = '03100000-0000-4000-8000-000000000201'),
  0,
  'removing the last club member dissolves the club'
);

SELECT extensions.col_has_check('public', 'geocode_cache', 'cache_key', 'cache keys are constrained hashes');
SELECT extensions.col_has_check('public', 'sweep_state', 'sweep_type', 'sweep types are constrained');
SELECT extensions.is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.geocode_cache'::regclass),
  true,
  'geocoder cache has RLS enabled'
);
SELECT extensions.is(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.media_cleanup_jobs'::regclass),
  true,
  'cleanup queue has RLS enabled'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM cron.job
    WHERE jobname IN ('vollo-streak-sweep', 'vollo-territory-sweep', 'vollo-media-cleanup')),
  3,
  'bounded maintenance schedules are installed exactly once'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM cron.job
    WHERE jobname IN ('vollo-login-attempt-retention', 'vollo-notification-retention')),
  2,
  'bounded operational-retention schedules are installed exactly once'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM vault.decrypted_secrets WHERE name = 'project_url'),
  0,
  'a clean local database cannot call a deployed project'
);

SELECT * FROM extensions.finish();
ROLLBACK;

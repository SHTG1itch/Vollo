-- Run after all migrations with: supabase test db
-- The transaction is rolled back so these upgrade fixtures never persist.
BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT extensions.plan(14);

-- A confirmed auth identity reclaims the legacy row instead of replacing it.
INSERT INTO public.users (id, username, email, display_name)
VALUES (
  '03000000-0000-4000-8000-000000000001',
  'legacy_keeper',
  'Legacy.030@example.test',
  'Legacy Player'
);

INSERT INTO public.user_streaks (user_id, current_streak_weeks)
VALUES ('03000000-0000-4000-8000-000000000001', 7);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'legacy.030@EXAMPLE.test',
  '',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"username":"replacement","display_name":"Replacement"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);

SELECT extensions.is(
  (SELECT auth_id FROM public.users WHERE id = '03000000-0000-4000-8000-000000000001'),
  '03000000-0000-4000-8000-000000000101'::uuid,
  'confirmed email links the existing profile id'
);
SELECT extensions.is(
  (SELECT username::text FROM public.users WHERE id = '03000000-0000-4000-8000-000000000001'),
  'legacy_keeper'::text,
  'linking does not overwrite the established handle'
);
SELECT extensions.is(
  (SELECT display_name FROM public.users WHERE id = '03000000-0000-4000-8000-000000000001'),
  'Legacy Player'::text,
  'linking does not overwrite the established display name'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM public.users WHERE email = 'legacy.030@example.test'),
  1,
  'linking does not create a duplicate profile'
);
SELECT extensions.is(
  (SELECT current_streak_weeks FROM public.user_streaks WHERE user_id = '03000000-0000-4000-8000-000000000001'),
  7,
  'dependent profile state survives linking'
);

-- Unconfirmed identities must not claim or create a public profile.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03000000-0000-4000-8000-000000000102',
  'authenticated',
  'authenticated',
  'unconfirmed.030@example.test',
  '',
  NULL,
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"username":"squatter","display_name":"Squatter"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM public.users WHERE email = 'unconfirmed.030@example.test'),
  0,
  'unconfirmed email creates no profile'
);

-- Email sign-up metadata is normalized and cannot inject an avatar origin.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03000000-0000-4000-8000-000000000103',
  'authenticated',
  'authenticated',
  'normalized.030@example.test',
  '',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object(
    'username', '  BAD !! User Name That Is Far Too Long  ',
    'display_name', E'  Alice\n\tTester  ',
    'avatar_url', 'https://tracking.example.test/pixel.gif'
  ),
  clock_timestamp(),
  clock_timestamp()
);
SELECT extensions.ok(
  (SELECT username::text ~ '^[a-z0-9_]{3,20}$' FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000103'),
  'email metadata handle is normalized and bounded'
);
SELECT extensions.ok(
  (SELECT display_name = 'Alice Tester' AND char_length(display_name) <= 60
     FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000103'),
  'display metadata has whitespace normalized and is bounded'
);
SELECT extensions.is(
  (SELECT avatar_url FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000103'),
  NULL::text,
  'email metadata cannot inject an avatar URL'
);

-- Google may supply a googleusercontent avatar, but its metadata username is
-- ignored and a lookalike hostname is rejected.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03000000-0000-4000-8000-000000000104',
  'authenticated',
  'authenticated',
  'google.030@example.test',
  '',
  clock_timestamp(),
  '{"provider":"google","providers":["google"]}'::jsonb,
  '{"username":"metadata_admin","full_name":"Google Player","avatar_url":"https://lh3.googleusercontent.com/a/avatar"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
), (
  '03000000-0000-4000-8000-000000000105',
  'authenticated',
  'authenticated',
  'evil-google.030@example.test',
  '',
  clock_timestamp(),
  '{"provider":"google","providers":["google"]}'::jsonb,
  '{"full_name":"Evil Google","avatar_url":"https://lh3.googleusercontent.com.evil.example/avatar"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);
SELECT extensions.is(
  (SELECT username::text FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000104'),
  'google_player'::text,
  'OAuth metadata cannot set an arbitrary handle'
);
SELECT extensions.is(
  (SELECT avatar_url FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000104'),
  'https://lh3.googleusercontent.com/a/avatar'::text,
  'HTTPS googleusercontent avatar is accepted'
);
SELECT extensions.is(
  (SELECT avatar_url FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000105'),
  NULL::text,
  'googleusercontent lookalike hostname is rejected'
);

-- Sequential duplicate proposals exercise the same suffix allocation covered by
-- the transaction lock in concurrent sessions.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '03000000-0000-4000-8000-000000000106',
  'authenticated',
  'authenticated',
  'collision-one.030@example.test',
  '',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"username":"same_handle","display_name":"Collision One"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
), (
  '03000000-0000-4000-8000-000000000107',
  'authenticated',
  'authenticated',
  'collision-two.030@example.test',
  '',
  clock_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"username":"same_handle","display_name":"Collision Two"}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);
SELECT extensions.is(
  (SELECT username::text FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000106'),
  'same_handle'::text,
  'first free handle keeps its base value'
);
SELECT extensions.is(
  (SELECT username::text FROM public.users WHERE auth_id = '03000000-0000-4000-8000-000000000107'),
  'same_handle1'::text,
  'colliding handle receives a bounded suffix'
);

SELECT * FROM extensions.finish();
ROLLBACK;

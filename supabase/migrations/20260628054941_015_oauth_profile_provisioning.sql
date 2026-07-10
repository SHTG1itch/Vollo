-- ════════════════════════════════════════════════════════════════════════
-- Vollo — make profile provisioning OAuth-aware (Google / Apple sign-in)
--
-- Sign-in with Google or Apple creates an auth.users row that is already
-- email-confirmed by the provider, so the on_auth_user_created trigger fires
-- immediately. Unlike email sign-up, an OAuth identity carries no `username`
-- in raw_user_meta_data — instead the provider supplies `full_name` / `name`,
-- a `picture` / `avatar_url`, and the verified email.
--
-- This migration only replaces handle_new_auth_user() to derive a clean handle,
-- display name and avatar from that provider metadata. It is purely additive:
-- the email sign-up path (which passes an explicit `username` + `display_name`)
-- keeps its exact prior behaviour because those explicit values still win via
-- COALESCE. No trigger, table, grant or edge-function change is required — an
-- OAuth session validates through the same adminClient.auth.getUser path, and
-- the profile is keyed on auth_id exactly as before.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta     JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_username TEXT;
  v_display  TEXT;
  v_avatar   TEXT;
  v_base     TEXT;
  v_cand     TEXT;
  v_user_id  UUID;
  v_suffix   INT := 0;
BEGIN
  -- Hold off until the email is confirmed. Email sign-up sets this when the user
  -- clicks the confirmation link (an UPDATE); an OAuth identity (Google/Apple) is
  -- auto-confirmed by the provider, so email_confirmed_at is already set at INSERT.
  IF NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- Idempotent: a later auth.users UPDATE must not create a second profile.
  IF EXISTS (SELECT 1 FROM public.users WHERE auth_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Display name: the sign-up form's value wins; otherwise take the provider's
  -- real name (Google sends full_name/name; Apple sends it only on first consent).
  v_display := COALESCE(
    NULLIF(trim(v_meta ->> 'display_name'), ''),
    NULLIF(trim(v_meta ->> 'full_name'), ''),
    NULLIF(trim(v_meta ->> 'name'), '')
  );

  -- Avatar from the OAuth provider, if any (Google: avatar_url / picture).
  v_avatar := COALESCE(
    NULLIF(trim(v_meta ->> 'avatar_url'), ''),
    NULLIF(trim(v_meta ->> 'picture'), '')
  );

  -- Username: an explicit handle from the sign-up form wins. OAuth users have no
  -- handle, so derive a clean candidate from their name or email local-part
  -- (lowercase, [a-z0-9_] only), then fall back to a stable id-based handle so the
  -- NOT NULL / UNIQUE(username) constraints always hold.
  v_username := NULLIF(trim(v_meta ->> 'username'), '');
  IF v_username IS NULL THEN
    v_cand := regexp_replace(
      lower(COALESCE(v_display, split_part(NEW.email, '@', 1), '')),
      '[^a-z0-9_]+', '', 'g'
    );
    IF length(v_cand) >= 3 THEN
      v_username := left(v_cand, 20);
    ELSE
      v_username := 'player_' || substr(replace(NEW.id::text, '-', ''), 1, 10);
    END IF;
  END IF;
  -- If neither the form nor the provider gave a name, mirror the handle.
  v_display := COALESCE(v_display, v_username);

  -- Resolve collisions by suffixing rather than raising — a raise would abort the
  -- auth.users insert and fail sign-up / OAuth sign-in with an opaque error.
  v_base := v_username;
  WHILE EXISTS (SELECT 1 FROM public.users WHERE username = v_username) AND v_suffix < 1000 LOOP
    v_suffix := v_suffix + 1;
    v_username := left(v_base, 14) || v_suffix::text;
  END LOOP;

  INSERT INTO public.users (auth_id, username, email, display_name, avatar_url)
  VALUES (NEW.id, v_username, NEW.email, v_display, v_avatar)
  ON CONFLICT (auth_id) DO NOTHING
  RETURNING id INTO v_user_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.user_streaks (user_id) VALUES (v_user_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- Re-assert the lockdown (CREATE OR REPLACE preserves ACL, but be explicit):
-- this function is only ever invoked by the on_auth_user_created trigger, never
-- as a PostgREST RPC by anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

-- The on_auth_user_created trigger already fires on INSERT (covers the
-- auto-confirmed OAuth case) and on UPDATE OF email_confirmed_at (email sign-up
-- confirmation), so it does not need to change.
-- Migration version is normalized against the production Supabase ledger.

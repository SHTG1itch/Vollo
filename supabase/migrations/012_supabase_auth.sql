-- ════════════════════════════════════════════════════════════════════════
-- Vollo — migrate from custom bcrypt+HS256 auth to Supabase Auth
--
-- Identity now lives in auth.users (managed by Supabase Auth). Our public.users
-- table keeps being the application profile and the FK target for everything
-- (matches, territories, …) — its `id` is unchanged. We just link each profile
-- to its auth identity via auth_id, drop the locally-stored password hash, and
-- auto-create the profile row whenever a new auth user signs up.
--
-- NOTE: this is a breaking change for any pre-existing accounts created under the
-- old bcrypt scheme — they have no auth.users row, so they must re-register.
--
-- Email confirmation: the profile is provisioned only once the auth user's email
-- is confirmed (or auto-confirmed, when confirmations are disabled). With email
-- confirmation ON — recommended, to keep bots out — sign-up creates the auth user
-- but no session; the user clicks the emailed link, which confirms them and fires
-- this trigger to create their profile. Username login is then proxied
-- server-side (POST /api/auth/login) so the client never needs, and never sees,
-- anyone's email.
-- ════════════════════════════════════════════════════════════════════════

-- Link each profile to its Supabase Auth identity. Nullable + UNIQUE: legacy
-- rows stay null, and deleting the auth user cascades the profile away.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- Passwords are Supabase Auth's job now.
ALTER TABLE public.users DROP COLUMN IF EXISTS password_hash;

-- Provision a profile row from the metadata the mobile client passes to
-- supabase.auth.signUp (username, display_name) — but only once the email is
-- confirmed, so unconfirmed bot sign-ups never squat a username or create rows.
-- Runs as SECURITY DEFINER so the auth-schema trigger can write into public.users.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
  v_display  TEXT;
  v_base     TEXT;
  v_user_id  UUID;
  v_suffix   INT := 0;
BEGIN
  -- Hold off until the email is confirmed. NEW.email_confirmed_at is set when the
  -- user clicks the confirmation link (an UPDATE), or is already set at INSERT time
  -- when confirmations are disabled / the user is auto-confirmed.
  IF NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;
  -- Idempotent: a later auth.users UPDATE must not create a second profile.
  IF EXISTS (SELECT 1 FROM public.users WHERE auth_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_username := NULLIF(trim(NEW.raw_user_meta_data ->> 'username'), '');
  v_display  := NULLIF(trim(NEW.raw_user_meta_data ->> 'display_name'), '');
  -- Fall back to a stable handle derived from the auth id so the NOT NULL
  -- username/display_name constraints always hold even without metadata.
  v_username := COALESCE(v_username, 'player_' || substr(replace(NEW.id::text, '-', ''), 1, 10));
  v_display  := COALESCE(v_display, v_username);

  -- The mobile client pre-checks username availability, but a concurrent race
  -- (or a leftover legacy row) could still collide. Rather than raising — which
  -- would abort the auth.users insert and fail signUp with an opaque error —
  -- derive a free handle by suffixing. (Email collisions can't happen here:
  -- auth.users already enforces a unique email before this trigger fires.)
  v_base := v_username;
  WHILE EXISTS (SELECT 1 FROM public.users WHERE username = v_username) AND v_suffix < 1000 LOOP
    v_suffix := v_suffix + 1;
    v_username := left(v_base, 14) || v_suffix::text;
  END LOOP;

  INSERT INTO public.users (auth_id, username, email, display_name)
  VALUES (NEW.id, v_username, NEW.email, v_display)
  ON CONFLICT (auth_id) DO NOTHING
  RETURNING id INTO v_user_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.user_streaks (user_id) VALUES (v_user_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- Fire on insert (covers the auto-confirm case) and when email_confirmed_at flips
-- on confirmation. The function itself guards against running before confirmation
-- or running twice.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

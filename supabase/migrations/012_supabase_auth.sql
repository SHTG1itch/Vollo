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
-- For username/password sign-up to log a user in immediately, the project's Auth
-- settings should have email confirmation disabled (or auto-confirm enabled).
-- ════════════════════════════════════════════════════════════════════════

-- Link each profile to its Supabase Auth identity. Nullable + UNIQUE: legacy
-- rows stay null, and deleting the auth user cascades the profile away.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- Passwords are Supabase Auth's job now.
ALTER TABLE public.users DROP COLUMN IF EXISTS password_hash;

-- Auto-provision a profile row for every new auth user from the metadata the
-- mobile client passes to supabase.auth.signUp (username, display_name). Runs as
-- SECURITY DEFINER so the auth schema's trigger can write into public.users.
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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

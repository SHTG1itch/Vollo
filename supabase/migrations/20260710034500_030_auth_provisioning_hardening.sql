-- 030: Harden profile provisioning at the auth boundary.
--
-- Auth metadata is user-controlled for password sign-up.  Treat it only as an
-- input to normalization, use auth.users.email (after confirmation) as the
-- verified identity, and use raw_app_meta_data only to identify the provider.
-- A transaction-scoped advisory lock serializes profile provisioning so two
-- confirmations cannot both select the same otherwise-free handle.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_app_meta      JSONB := CASE
    WHEN pg_catalog.jsonb_typeof(NEW.raw_app_meta_data) = 'object'
      THEN NEW.raw_app_meta_data
    ELSE '{}'::jsonb
  END;
  v_user_meta     JSONB := CASE
    WHEN pg_catalog.jsonb_typeof(NEW.raw_user_meta_data) = 'object'
      THEN NEW.raw_user_meta_data
    ELSE '{}'::jsonb
  END;
  v_provider      TEXT;
  v_email         TEXT;
  v_raw_username  TEXT;
  v_raw_display   TEXT;
  v_username      TEXT;
  v_display       TEXT;
  v_avatar        TEXT;
  v_base          TEXT;
  v_candidate     TEXT;
  v_user_id       UUID;
  v_suffix        INTEGER;
  v_handle_found  BOOLEAN := false;
BEGIN
  -- Only a confirmed address from auth.users can claim or create a profile.
  -- Never use an email carried in raw_user_meta_data for account linking.
  IF NEW.email_confirmed_at IS NULL OR NULLIF(pg_catalog.btrim(NEW.email), '') IS NULL THEN
    RETURN NEW;
  END IF;

  v_email := pg_catalog.lower(pg_catalog.btrim(NEW.email));

  -- Serialize the small critical section.  A global lock is intentional: a
  -- request for "alex" can be suffixed to "alex1", which can otherwise race a
  -- simultaneous request whose original handle is already "alex1".
  PERFORM pg_catalog.pg_advisory_xact_lock(1448037455, 30);

  -- Re-check after acquiring the lock; another trigger invocation in a
  -- concurrent transaction may have completed while this one was waiting.
  SELECT u.id
    INTO v_user_id
    FROM public.users AS u
   WHERE u.auth_id = NEW.id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.user_streaks (user_id)
    VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
  END IF;

  -- Reconnect a confirmed identity to its pre-Supabase profile.  Updating the
  -- row in place retains the profile id and every FK that points at it.  Do not
  -- overwrite the established handle, name, avatar, or other profile fields.
  UPDATE public.users AS u
     SET auth_id = NEW.id
   WHERE u.auth_id IS NULL
     AND pg_catalog.lower(pg_catalog.btrim(u.email::text)) = v_email
  RETURNING u.id INTO v_user_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.user_streaks (user_id)
    VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
  END IF;

  -- Never steal an email already attached to a different auth identity.  This
  -- should also be prevented by auth.users, but the guard keeps the linkage
  -- rule explicit for upgraded or manually repaired databases.
  IF EXISTS (
    SELECT 1
      FROM public.users AS u
     WHERE pg_catalog.lower(pg_catalog.btrim(u.email::text)) = v_email
       AND u.auth_id IS NOT NULL
       AND u.auth_id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'profile email is already linked to another auth identity'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_provider := pg_catalog.lower(COALESCE(v_app_meta ->> 'provider', ''));

  -- Password sign-up may propose these two fields.  OAuth identities do not get
  -- to inject an arbitrary handle, and unknown providers get no metadata-derived
  -- profile fields at all.
  IF v_provider = 'email' THEN
    v_raw_username := v_user_meta ->> 'username';
    v_raw_display := v_user_meta ->> 'display_name';
  ELSIF v_provider IN ('google', 'apple') THEN
    v_raw_display := COALESCE(
      v_user_meta ->> 'full_name',
      v_user_meta ->> 'name'
    );
  END IF;

  -- Display names may contain Unicode, but not control characters or unbounded
  -- whitespace.  Collapse whitespace first, then cap to the API's 60 characters.
  IF v_raw_display IS NOT NULL THEN
    v_display := pg_catalog.regexp_replace(
      pg_catalog.btrim(v_raw_display),
      '[[:space:][:cntrl:]]+',
      ' ',
      'g'
    );
    v_display := NULLIF(pg_catalog.btrim(pg_catalog.left(v_display, 60)), '');
  END IF;

  -- Normalize handles to the mobile contract: lowercase ASCII letters, digits,
  -- and underscores, with a length of 3..20.  Invalid or too-short proposals
  -- fall through to a candidate derived from the confirmed email.
  IF v_raw_username IS NOT NULL THEN
    v_base := pg_catalog.lower(pg_catalog.btrim(v_raw_username));
    v_base := pg_catalog.regexp_replace(v_base, '[^a-z0-9_]+', '_', 'g');
    v_base := pg_catalog.regexp_replace(v_base, '_+', '_', 'g');
    v_base := pg_catalog.regexp_replace(v_base, '^_+|_+$', '', 'g');
    v_base := pg_catalog.regexp_replace(pg_catalog.left(v_base, 20), '_+$', '', 'g');
    IF pg_catalog.char_length(v_base) < 3 THEN
      v_base := NULL;
    END IF;
  END IF;

  IF v_base IS NULL THEN
    v_candidate := pg_catalog.lower(COALESCE(v_display, ''));
    v_candidate := pg_catalog.regexp_replace(v_candidate, '[^a-z0-9_]+', '_', 'g');
    v_candidate := pg_catalog.regexp_replace(v_candidate, '_+', '_', 'g');
    v_candidate := pg_catalog.regexp_replace(v_candidate, '^_+|_+$', '', 'g');
    v_candidate := pg_catalog.regexp_replace(pg_catalog.left(v_candidate, 20), '_+$', '', 'g');

    -- A Unicode-only display name may not yield an ASCII handle.  Retry with
    -- the verified email local-part before using the id-based fallback.
    IF pg_catalog.char_length(v_candidate) < 3 THEN
      v_candidate := pg_catalog.lower(pg_catalog.split_part(v_email, '@', 1));
      v_candidate := pg_catalog.regexp_replace(v_candidate, '[^a-z0-9_]+', '_', 'g');
      v_candidate := pg_catalog.regexp_replace(v_candidate, '_+', '_', 'g');
      v_candidate := pg_catalog.regexp_replace(v_candidate, '^_+|_+$', '', 'g');
      v_candidate := pg_catalog.regexp_replace(pg_catalog.left(v_candidate, 20), '_+$', '', 'g');
    END IF;

    IF pg_catalog.char_length(v_candidate) >= 3 THEN
      v_base := v_candidate;
    ELSE
      v_base := 'player_' || pg_catalog.substr(pg_catalog.replace(NEW.id::text, '-', ''), 1, 10);
    END IF;
  END IF;

  -- The advisory lock makes this lookup-and-insert sequence race-free.  Keep the
  -- suffix inside the same 20-character bound and fail closed on exhaustion.
  FOR v_suffix IN 0..9999 LOOP
    IF v_suffix = 0 THEN
      v_username := v_base;
    ELSE
      v_username := pg_catalog.left(
        v_base,
        20 - pg_catalog.char_length(v_suffix::text)
      ) || v_suffix::text;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.users AS u
       WHERE pg_catalog.lower(u.username::text) = v_username
    ) THEN
      v_handle_found := true;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_handle_found THEN
    RAISE EXCEPTION 'unable to allocate profile handle'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_display := COALESCE(v_display, v_username);

  -- Avatars are accepted only for a trusted Google provider marker and only
  -- from HTTPS googleusercontent.com (or one of its subdomains).  In particular,
  -- email sign-up metadata cannot persist an arbitrary tracking URL.
  IF v_provider = 'google' THEN
    v_avatar := NULLIF(pg_catalog.btrim(v_user_meta ->> 'avatar_url'), '');
    IF v_avatar IS NULL
       OR pg_catalog.char_length(v_avatar) > 500
       OR v_avatar !~* '^https://([a-z0-9-]+[.])*googleusercontent[.]com(/[^[:space:]]*)?$' THEN
      v_avatar := NULLIF(pg_catalog.btrim(v_user_meta ->> 'picture'), '');
    END IF;
    IF v_avatar IS NULL
       OR pg_catalog.char_length(v_avatar) > 500
       OR v_avatar !~* '^https://([a-z0-9-]+[.])*googleusercontent[.]com(/[^[:space:]]*)?$' THEN
      v_avatar := NULL;
    END IF;
  END IF;

  INSERT INTO public.users (auth_id, username, email, display_name, avatar_url)
  VALUES (NEW.id, v_username, v_email, v_display, v_avatar)
  ON CONFLICT (auth_id) DO NOTHING
  RETURNING id INTO v_user_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.user_streaks (user_id)
    VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- SECURITY DEFINER trigger functions must never be callable as public RPCs.
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

-- NOT VALID avoids a blocking validation scan (and permits legacy bad rows to be
-- repaired deliberately), while PostgreSQL still enforces each constraint for
-- every new or updated row after this migration.
ALTER TABLE public.users
  ADD CONSTRAINT users_username_contract_030
  CHECK (
    pg_catalog.char_length(username::text) BETWEEN 3 AND 20
    AND username::text ~ '^[A-Za-z0-9_]+$'
  ) NOT VALID;

ALTER TABLE public.users
  ADD CONSTRAINT users_display_name_contract_030
  CHECK (
    pg_catalog.char_length(display_name) BETWEEN 1 AND 60
    AND pg_catalog.btrim(display_name) <> ''
    AND display_name !~ '[[:cntrl:]]'
  ) NOT VALID;

ALTER TABLE public.users
  ADD CONSTRAINT users_bio_contract_030
  CHECK (bio IS NULL OR pg_catalog.char_length(bio) <= 280) NOT VALID;

ALTER TABLE public.users
  ADD CONSTRAINT users_home_label_contract_030
  CHECK (home_label IS NULL OR pg_catalog.char_length(home_label) <= 160) NOT VALID;

-- Migration 013 already has an equivalent validated check in a standard
-- install.  Keeping this independently named contract also hardens databases
-- upgraded from partial/hand-applied migration histories without weakening the
-- existing constraint.
ALTER TABLE public.users
  ADD CONSTRAINT users_color_contract_030
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
-- Migration version is normalized against the production Supabase ledger.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../supabase/migrations/20260710034500_030_auth_provisioning_hardening.sql', import.meta.url),
  'utf8',
);

const functionStart = source.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_auth_user()');
const functionEnd = source.indexOf('\n$$;', functionStart);
assert.notEqual(functionStart, -1, 'hardening migration must replace the auth trigger function');
assert.notEqual(functionEnd, -1, 'hardening migration must contain a complete function body');
const functionSource = source.slice(functionStart, functionEnd);

test('auth provisioning links only a confirmed auth email to an unlinked profile in place', () => {
  assert.match(functionSource, /NEW\.email_confirmed_at IS NULL/);
  assert.match(functionSource, /v_email := pg_catalog\.lower\(pg_catalog\.btrim\(NEW\.email\)\)/);
  assert.match(
    functionSource,
    /UPDATE public\.users AS u[^]*SET auth_id = NEW\.id[^]*u\.auth_id IS NULL[^]*lower\(pg_catalog\.btrim\(u\.email::text\)\) = v_email[^]*RETURNING u\.id INTO v_user_id/,
  );
  assert.match(functionSource, /SET search_path = pg_catalog/);
  assert.ok(
    functionSource.indexOf('UPDATE public.users AS u') < functionSource.indexOf('INSERT INTO public.users'),
    'the legacy profile must be linked before a new profile is considered',
  );
  assert.doesNotMatch(functionSource, /DELETE FROM public\.users/i);
  assert.doesNotMatch(functionSource, /raw_user_meta_data\s*->>\s*'email'/);
});

test('handle allocation is normalized, bounded, and transactionally serialized', () => {
  const lockAt = functionSource.indexOf('pg_advisory_xact_lock');
  const availabilityAt = functionSource.indexOf('lower(u.username::text) = v_username');
  const insertAt = functionSource.indexOf('INSERT INTO public.users');

  assert.ok(lockAt >= 0, 'provisioning must acquire an advisory transaction lock');
  assert.ok(lockAt < availabilityAt && availabilityAt < insertAt, 'the lock must cover allocation and insert');
  assert.match(functionSource, /regexp_replace\(v_base, '\[\^a-z0-9_\]\+', '_', 'g'\)/);
  assert.match(functionSource, /left\(v_base, 20\)/);
  assert.match(functionSource, /FOR v_suffix IN 0\.\.9999 LOOP/);
  assert.match(functionSource, /20 - pg_catalog\.char_length\(v_suffix::text\)/);
  assert.match(functionSource, /pg_catalog\.left\(v_display, 60\)/);
});

test('provider metadata is allowlisted and cannot inject an arbitrary avatar URL', () => {
  const oauthBranchStart = functionSource.indexOf("ELSIF v_provider IN ('google', 'apple') THEN");
  const oauthBranchEnd = functionSource.indexOf('  END IF;', oauthBranchStart);
  const oauthBranch = functionSource.slice(oauthBranchStart, oauthBranchEnd);

  assert.match(functionSource, /v_provider := pg_catalog\.lower\(COALESCE\(v_app_meta ->> 'provider', ''\)\)/);
  assert.match(functionSource, /IF v_provider = 'email' THEN[^]*v_user_meta ->> 'username'/);
  assert.match(functionSource, /IF v_provider = 'google' THEN[^]*v_user_meta ->> 'avatar_url'/);
  assert.match(
    functionSource,
    /\^https:\/\/\(\[a-z0-9-\]\+\[\.\]\)\*googleusercontent\[\.\]com/,
  );
  assert.doesNotMatch(oauthBranch, /v_raw_username/);
});

test('profile field checks are future-write enforced without scanning legacy rows', () => {
  for (const name of [
    'users_username_contract_030',
    'users_display_name_contract_030',
    'users_bio_contract_030',
    'users_home_label_contract_030',
    'users_color_contract_030',
  ]) {
    const start = source.indexOf(`ADD CONSTRAINT ${name}`);
    assert.notEqual(start, -1, `missing ${name}`);
    const nextStatement = source.indexOf(';', start);
    assert.match(source.slice(start, nextStatement), /NOT VALID/);
  }

  assert.match(source, /char_length\(username::text\) BETWEEN 3 AND 20/);
  assert.match(source, /char_length\(display_name\) BETWEEN 1 AND 60/);
  assert.match(source, /char_length\(bio\) <= 280/);
  assert.match(source, /char_length\(home_label\) <= 160/);
  assert.match(source, /color ~ '\^#\[0-9A-Fa-f\]\{6\}\$'/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Expo delivery receipts are durable, private, bounded, and leased', async () => {
  const [migration, notifications, api] = await Promise.all([
    read('supabase/migrations/20260711061500_044_push_receipts.sql'),
    read('supabase/functions/api/notifications.ts'),
    read('supabase/functions/api/index.ts'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.push_receipts/);
  assert.match(migration, /id UUID PRIMARY KEY/);
  assert.match(migration, /REFERENCES public\.push_tokens\(token\) ON DELETE CASCADE/);
  assert.match(migration, /push_receipts_claim_idx/);
  assert.match(migration, /ALTER TABLE public\.push_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.push_receipts FROM PUBLIC, anon, authenticated/);

  assert.match(notifications, /ticket\.status === 'ok'[^]*receiptIds\.push\(ticket\.id\)/);
  assert.match(notifications, /EXPO_TICKET_ID_RE\.test\(ticket\.id\)/);
  assert.match(notifications, /INSERT INTO push_receipts \(id, token\)[^]*ON CONFLICT \(id\) DO NOTHING/);
  assert.match(notifications, /FOR UPDATE SKIP LOCKED[^]*LIMIT \$1/);
  assert.match(notifications, /Math\.max\(1, Math\.min\(limit, 100\)\)/);
  assert.match(notifications, /EXPO_RECEIPTS_URL[^]*AbortSignal\.timeout\(10_000\)/);
  assert.match(notifications, /job\.attempts >= 8/);
  assert.match(notifications, /DeviceNotRegistered[^]*deadTokens\.push\(job\.token\)/);
  assert.match(notifications, /DELETE FROM push_tokens WHERE token = ANY\(\$1::text\[\]\)/);
  assert.match(notifications, /could not finalize push receipts/);
  assert.doesNotMatch(notifications, /console\.(?:warn|error)\([^\n]*(?:job\.token|message\.to)/);
  assert.match(notifications, /Expo push ticket failed', code/);
  assert.match(notifications, /Expo push receipt failed', code/);
  assert.match(api, /const push_receipts = await processPushReceipts\(100\)/);
});

test('Expo response parsing is size-bounded for tickets and receipts', async () => {
  const notifications = await read('supabase/functions/api/notifications.ts');
  assert.match(notifications, /MAX_EXPO_RESPONSE_BYTES = 256 \* 1024/);
  assert.equal((notifications.match(/readExpoJson</g) ?? []).length, 3);
  assert.doesNotMatch(notifications, /await res\.json\(\)/);
});

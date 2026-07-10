import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sweeps = readFileSync(
  new URL('../../supabase/functions/api/sweeps.ts', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../supabase/migrations/20260710075733_033_batched_sweeps_and_cron.sql', import.meta.url),
  'utf8',
);
const retention = readFileSync(
  new URL('../../supabase/migrations/20260710075735_035_operational_retention.sql', import.meta.url),
  'utf8',
);

test('maintenance sweeps claim bounded cursor batches with tokenized leases', () => {
  assert.match(sweeps, /streak: 100/);
  assert.match(sweeps, /territory: 25/);
  assert.match(sweeps, /ratings: 50/);
  assert.match(sweeps, /SELECT cursor_user_id,[^]*lease_until > clock_timestamp\(\)[^]*FOR UPDATE/);
  assert.match(sweeps, /lease_until = clock_timestamp\(\) \+ interval '8 minutes'/);
  assert.match(sweeps, /WHERE sweep_type = \$1 AND lease_token = \$2/);
  assert.doesNotMatch(sweeps, /SELECT id FROM users['`)]/);
});

test('sweep cursors wrap safely and stale workers cannot finish a new lease', () => {
  assert.match(sweeps, /WHERE \(\$1::uuid IS NULL OR id > \$1::uuid\)/);
  assert.match(sweeps, /users\.rows\.length === 0 && row\.cursor_user_id/);
  assert.match(sweeps, /cursor_user_id = \$3, lease_token = NULL/);
  assert.match(migration, /CONSTRAINT sweep_lease_pair_chk/);
  assert.match(migration, /cursor_user_id UUID,/);
  assert.doesNotMatch(migration, /cursor_user_id UUID REFERENCES/);
});

test('cron uses Vault, explicit long timeouts, and frequent bounded schedules', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_net/);
  assert.match(migration, /FROM vault\.decrypted_secrets AS endpoint/);
  assert.match(migration, /WHERE endpoint\.name = 'project_url'/);
  assert.match(migration, /'\*\/15 \* \* \* \*'/);
  assert.match(migration, /'\*\/30 \* \* \* \*'/);
  assert.match(migration, /'vollo-media-cleanup'[\s\S]*'\*\/5 \* \* \* \*'/);
  assert.equal((migration.match(/timeout_milliseconds := 300000/g) ?? []).length, 2);
  assert.equal((migration.match(/timeout_milliseconds := 120000/g) ?? []).length, 1);
  assert.equal((migration.match(/endpoint\.decrypted_secret ~ '\^https:/g) ?? []).length, 3);
  assert.doesNotMatch(migration, /vault\.create_secret/);
  const scheduledSql = migration.slice(migration.indexOf("SELECT cron.schedule("));
  assert.doesNotMatch(scheduledSql, /https:\/\/[a-z0-9-]+\.supabase\.co\/functions/);
});

test('operational retention is indexed and deleted in bounded batches', () => {
  assert.match(retention, /notifications_unread_user_idx[\s\S]*WHERE read = false/);
  assert.match(retention, /notifications_read_retention_idx[\s\S]*WHERE read = true/);
  assert.match(retention, /notifications_expiry_idx[\s\S]*ON public\.notifications \(created_at\)/);
  assert.match(retention, /vollo-login-attempt-retention/);
  assert.match(retention, /attempted_at < now\(\) - interval '24 hours'[\s\S]*LIMIT 10000/);
  assert.match(retention, /vollo-notification-retention/);
  assert.match(retention, /created_at < now\(\) - interval '180 days'[\s\S]*created_at < now\(\) - interval '365 days'[\s\S]*LIMIT 10000/);
});

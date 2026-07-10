import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationsUrl = new URL('../../supabase/migrations/', import.meta.url);

const productionVersions = [
  '20260627022144',
  '20260627022205',
  '20260627022224',
  '20260627022231',
  '20260627022238',
  '20260627022753',
  '20260627034844',
  '20260627034958',
  '20260628005232',
  '20260628024129',
  '20260628050134',
  '20260628050142',
  '20260628050157',
  '20260628050301',
  '20260628054941',
  '20260628182120',
  '20260628193128',
  '20260628220315',
  '20260628220859',
  '20260702183602',
  '20260704201751',
  '20260704201803',
  '20260704201815',
  '20260704203508',
  '20260704203621',
  '20260705185729',
  '20260706001818',
];

test('migration files preserve the production ledger and timestamp ordering', async () => {
  const migrationFiles = (await readdir(migrationsUrl))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const versions = migrationFiles.map((name) => {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/);
    return name.slice(0, 14);
  });

  assert.equal(new Set(versions).size, versions.length, 'migration versions must be unique');
  for (const version of productionVersions) {
    assert.ok(versions.includes(version), `missing production migration ${version}`);
  }
  assert.ok(
    migrationFiles.includes('20260627030000_007_cron_sweeps_baseline.sql'),
    'the unrecorded legacy cron baseline must remain ordered before migrations 008/009',
  );
  assert.ok(
    migrationFiles.includes('20260628050301_012b_lock_signup_function.sql'),
    'the production-only 012b ledger entry must remain represented locally',
  );

  const [cronBaseline, boundedSweeps] = await Promise.all([
    readFile(new URL('../../supabase/migrations/20260627030000_007_cron_sweeps_baseline.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260710075733_033_batched_sweeps_and_cron.sql', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(cronBaseline, /https:\/\/[a-z0-9]{20}\.supabase\.co/);
  assert.match(cronBaseline, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
  assert.match(cronBaseline, /CREATE EXTENSION IF NOT EXISTS pg_net/);
  assert.match(boundedSweeps, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
  assert.match(boundedSweeps, /CREATE EXTENSION IF NOT EXISTS pg_net/);
});

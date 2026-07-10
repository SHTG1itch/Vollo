import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDatabaseUrl } from '../../supabase/functions/api/databaseUrl.ts';

const direct = 'postgresql://postgres:encoded%2Fpassword@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';

test('database URL resolver prefers an explicitly provisioned pooler URL', () => {
  const explicit = 'postgresql://pool-user:pool-pass@pool.example.test:6543/postgres';
  assert.equal(resolveDatabaseUrl({ explicitPoolUrl: explicit, directUrl: direct }), explicit);
});

test('database URL resolver derives the transaction pooler without exposing configuration credentials', () => {
  const result = new URL(resolveDatabaseUrl({
    directUrl: direct,
    poolHost: 'aws-1-us-east-1.pooler.supabase.com',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  }));

  assert.equal(result.hostname, 'aws-1-us-east-1.pooler.supabase.com');
  assert.equal(result.port, '6543');
  assert.equal(result.username, 'postgres.abcdefghijklmnopqrst');
  assert.equal(result.password, 'encoded%2Fpassword');
  assert.equal(result.pathname, '/postgres');
  assert.equal(result.searchParams.get('sslmode'), 'require');
});

test('database URL resolver keeps the injected direct URL when no pool host is configured', () => {
  assert.equal(resolveDatabaseUrl({ directUrl: direct }), direct);
  assert.equal(resolveDatabaseUrl({}), '');
});

test('database URL resolver rejects untrusted endpoints and incomplete credentials', () => {
  assert.throws(
    () => resolveDatabaseUrl({ directUrl: direct, poolHost: 'attacker.example.com' }),
    /trusted Supabase shared-pooler host/,
  );
  assert.throws(
    () => resolveDatabaseUrl({
      directUrl: 'postgresql://postgres@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
      poolHost: 'aws-1-us-east-1.pooler.supabase.com',
    }),
    /missing its injected database credential/,
  );
});

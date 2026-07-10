import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const api = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const validation = readFileSync(
  new URL('../../supabase/functions/api/validation.ts', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../supabase/migrations/20260710075736_036_creation_idempotency.sql', import.meta.url),
  'utf8',
);
const clubMigration = readFileSync(
  new URL('../../supabase/migrations/20260710075739_039_club_creation_idempotency.sql', import.meta.url),
  'utf8',
);

test('court and scheduled creation are retry-safe at the database boundary', () => {
  assert.match(migration, /ALTER TABLE public\.courts ADD COLUMN IF NOT EXISTS client_key UUID/);
  assert.match(migration, /ALTER TABLE public\.scheduled_matches ADD COLUMN IF NOT EXISTS client_key UUID/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS courts_creator_client_key_idx/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS scheduled_creator_client_key_idx/);
  assert.match(validation, /createScheduledMatchSchema[\s\S]*client_key: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(validation, /createCourtSchema[\s\S]*client_key: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(api, /scheduled_matches WHERE creator_id = \$1 AND client_key = \$2/g);
  assert.match(api, /INSERT INTO scheduled_matches[\s\S]*client_key/);
  assert.match(api, /courts WHERE created_by = \$1 AND client_key = \$2/g);
  assert.match(api, /INSERT INTO courts[\s\S]*created_by, client_key/);
});

test('club creation returns the original resource after an ambiguous retry', () => {
  assert.match(clubMigration, /ALTER TABLE public\.clubs ADD COLUMN IF NOT EXISTS client_key UUID/);
  assert.match(clubMigration, /CREATE UNIQUE INDEX IF NOT EXISTS clubs_creator_client_key_idx/);
  assert.match(validation, /createClubSchema[\s\S]*client_key: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(api, /clubs WHERE creator_id = \$1 AND client_key = \$2/g);
  assert.match(api, /INSERT INTO clubs \(name, description, city, creator_id, client_key\)/);
});

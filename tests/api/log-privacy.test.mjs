import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('maintenance logs omit account and private object identifiers', async () => {
  const [cleanup, sweeps, api] = await Promise.all([
    read('supabase/functions/api/mediaCleanup.ts'),
    read('supabase/functions/api/sweeps.ts'),
    read('supabase/functions/api/index.ts'),
  ]);

  assert.doesNotMatch(cleanup, /console\.(?:warn|error)\([^\n]*job\.auth_id/);
  assert.doesNotMatch(cleanup, /console\.(?:warn|error)\([^\n]*job\.object_path/);
  assert.doesNotMatch(sweeps, /console\.(?:warn|error)\(`[^`]*\$\{userId\}/);
  assert.doesNotMatch(sweeps, /console\.(?:warn|error)\(`[^`]*\$\{c\.id\}/);
  assert.match(cleanup, /console\.warn\('\[media-cleanup\] storage cleanup failed', safeFailureKind\(error\)\)/);
  assert.match(cleanup, /\^\[A-Za-z0-9_\.\-\]\{1,64\}\$/);
  assert.match(api, /post-delete territory recompute failed', err instanceof Error \? err\.message : err/);
});

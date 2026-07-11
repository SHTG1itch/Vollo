import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeApiUrl } from '../../scripts/production-security-smoke.mjs';

test('production security smoke accepts only canonical Supabase Edge URLs', () => {
  assert.equal(
    normalizeApiUrl('https://abcdefghijklmnopqrst.supabase.co/functions/v1'),
    'https://abcdefghijklmnopqrst.supabase.co/functions/v1/api',
  );
  assert.throws(() => normalizeApiUrl('http://abcdefghijklmnopqrst.supabase.co/functions/v1'));
  assert.throws(() => normalizeApiUrl('https://example.com/functions/v1/api'));
  assert.throws(() => normalizeApiUrl('https://user:secret@abcdefghijklmnopqrst.supabase.co/functions/v1/api'));
  assert.throws(() => normalizeApiUrl('https://abcdefghijklmnopqrst.supabase.co/functions/v1/api?token=secret'));
});

test('production security smoke cannot issue authenticated or arbitrary mutations', async () => {
  const source = await readFile(
    new URL('../../scripts/production-security-smoke.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /process\.env\.(?:TOKEN|KEY|SECRET|PASSWORD)/);
  assert.doesNotMatch(source, /method:\s*'(?:POST|PUT|DELETE)'/);
  assert.match(source, /path: '\/users\/me',[\s\S]*method: 'PATCH'[\s\S]*status: 413/);
  assert.match(source, /Authorization: 'Bearer invalid-token'/);
});

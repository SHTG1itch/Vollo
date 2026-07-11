import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const client = await readFile(new URL('../../mobile/src/api/client.ts', import.meta.url), 'utf8');

test('mobile retries one retryable safe read without replaying mutations', () => {
  assert.match(client, /res\.status === 503 && \(method === 'GET' \|\| method === 'HEAD'\)/);
  assert.match(client, /res\.headers\.get\('Retry-After'\)/);
  assert.match(client, /Math\.min\(1_500, Math\.max\(100,/);
  assert.match(client, /generic transport layer must not assume every POST\/PATCH\/DELETE is safe/);

  const retryBlock = client.slice(
    client.indexOf("const method = (options.method ?? 'GET').toUpperCase()"),
    client.indexOf('if (res.status === 204)'),
  );
  assert.equal((retryBlock.match(/await doFetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(retryBlock, /method === 'POST'|method === 'PATCH'|method === 'DELETE'/);
});

test('mobile preserves only trusted Edge request ids on response errors', () => {
  assert.match(client, /requestId\?: string/);
  assert.match(client, /response\.headers\.get\('X-Request-Id'\)/);
  assert.match(client, /REQUEST_ID_RE\.test\(value\) \? value\.toLowerCase\(\) : undefined/);

  const responseHandling = client.slice(
    client.indexOf('let text: string'),
    client.indexOf('/**\n * Snapshot-auth request'),
  );
  assert.equal(
    (responseHandling.match(/responseRequestId\(res\)/g) ?? []).length,
    3,
    'unreadable, malformed, and non-2xx responses must retain correlation ids',
  );
});

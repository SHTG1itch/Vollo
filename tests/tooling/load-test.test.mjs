import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeApiUrl,
  parseArgs,
  READ_ONLY_ENDPOINTS,
  runLoadTest,
} from '../../scripts/read-only-load-test.mjs';

test('load runner only issues bounded GET requests from the allowlist', async () => {
  const config = parseArgs([
    '--url',
    'http://127.0.0.1:54321/functions/v1',
    '--endpoint',
    'health,feed,courts',
    '--requests',
    '12',
    '--concurrency',
    '3',
    '--max-error-rate',
    '0',
    '--max-p95-ms',
    '1000',
  ], {});

  let active = 0;
  let maxActive = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ url: String(url), init });
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const payload = String(url).includes('/health')
      ? { status: 'ok' }
      : String(url).includes('/feed')
        ? { matches: [], next_cursor: null }
        : { courts: [] };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const report = await runLoadTest(config, { fetchImpl, log() {} });

  assert.equal(report.passed, true);
  assert.equal(report.attempted, 12);
  assert.ok(maxActive <= 3);
  assert.equal(calls.length, 12);
  assert.ok(calls.every((call) => call.init.method === 'GET'));
  assert.ok(calls.every((call) => call.init.redirect === 'error'));
  assert.ok(calls.every((call) => call.init.headers.authorization == null));
  const allowedTargets = new Set(
    Object.values(READ_ONLY_ENDPOINTS).map(
      (path) => 'http://127.0.0.1:54321/functions/v1/api/' + path,
    ),
  );
  assert.ok(calls.every((call) => allowedTargets.has(call.url)));
});

test('load runner rejects malformed successful payloads', async () => {
  const config = parseArgs([
    '--url',
    'http://localhost:54321/functions/v1/api',
    '--requests',
    '1',
    '--max-error-rate',
    '0',
  ], {});

  const report = await runLoadTest(config, {
    fetchImpl: async () => new Response('{"status":"degraded"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    log() {},
  });

  assert.equal(report.passed, false);
  assert.match(report.sampleErrors[0].error, /did not report ok/);
});

test('load runner rejects arbitrary endpoints, credentials, and insecure remote hosts', () => {
  assert.throws(
    () => parseArgs(['--url', 'https://example.com/functions/v1/api', '--endpoint', 'auth/login'], {}),
    /Unknown endpoint/,
  );
  assert.throws(
    () => normalizeApiUrl('https://user:secret@example.com/functions/v1/api'),
    /must not contain credentials/,
  );
  assert.throws(
    () => normalizeApiUrl('http://example.com/functions/v1/api'),
    /must use HTTPS/,
  );
});

test('load runner fails latency thresholds', async () => {
  const config = parseArgs([
    '--url',
    'http://localhost:54321/functions/v1/api',
    '--requests',
    '3',
    '--concurrency',
    '1',
    '--max-p95-ms',
    '1',
  ], {});

  const report = await runLoadTest(config, {
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response('{}', { status: 200 });
    },
    log() {},
  });

  assert.equal(report.passed, false);
  assert.match(report.thresholdFailures.join('\n'), /p95/);
});

test('load runner refuses oversized responses before buffering them', async () => {
  const config = parseArgs([
    '--url',
    'http://localhost:54321/functions/v1/api',
    '--requests',
    '1',
  ], {});

  const report = await runLoadTest(config, {
    fetchImpl: async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(3 * 1024 * 1024) },
    }),
    log() {},
  });

  assert.equal(report.passed, false);
  assert.match(report.sampleErrors[0].error, /response exceeded/);
});

test('load runner opens its circuit breaker during a sustained outage', async () => {
  const config = parseArgs([
    '--url',
    'http://localhost:54321/functions/v1/api',
    '--requests',
    '100',
    '--concurrency',
    '4',
  ], {});

  const report = await runLoadTest(config, {
    fetchImpl: async () => new Response('{}', { status: 503 }),
    log() {},
  });

  assert.equal(report.passed, false);
  assert.ok(report.attempted < 100);
  assert.match(report.thresholdFailures.join('\n'), /circuit breaker/);
});

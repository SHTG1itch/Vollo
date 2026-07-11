import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 128 * 1024;

export function normalizeApiUrl(raw) {
  assert.ok(raw, 'VOLLO_API_URL is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VOLLO_API_URL must be a valid URL');
  }
  assert.equal(url.protocol, 'https:', 'production smoke tests require HTTPS');
  assert.match(url.hostname, /^[a-z0-9]{20}\.supabase\.co$/);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('VOLLO_API_URL must not contain credentials, query parameters, or fragments');
  }

  const path = url.pathname.replace(/\/+$/, '');
  assert.ok(
    path === '/functions/v1' || path === '/functions/v1/api',
    'URL must end in /functions/v1 or /functions/v1/api',
  );
  url.pathname = path.endsWith('/api') ? path : `${path}/api`;
  return url.toString().replace(/\/$/, '');
}

async function probe(base, {
  name,
  path,
  method = 'GET',
  headers,
  body,
  status,
  code,
  noStore = false,
  appHeaders = true,
  cors,
}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, `${name}: unexpected HTTP status`);
  if (appHeaders) {
    assert.match(response.headers.get('x-request-id') ?? '', REQUEST_ID_RE, `${name}: missing request id`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${name}: missing nosniff`);
  }
  if (noStore) assert.equal(response.headers.get('cache-control'), 'no-store', `${name}: response is cacheable`);
  if (cors) assert.equal(response.headers.get('access-control-allow-origin'), cors, `${name}: CORS mismatch`);

  const declared = Number(response.headers.get('content-length') ?? 0);
  assert.ok(!declared || declared <= MAX_RESPONSE_BYTES, `${name}: oversized declared response`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength <= MAX_RESPONSE_BYTES, `${name}: oversized response`);
  const payload = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  if (code) assert.equal(payload?.error?.code, code, `${name}: unexpected error envelope`);
  return { name, status: response.status, code: payload?.error?.code ?? 'ok' };
}

export async function runSecuritySmoke(rawUrl) {
  const base = normalizeApiUrl(rawUrl);
  const oversizedBody = JSON.stringify('x'.repeat(65_537));
  const probes = [
    { name: 'health', path: '/health', status: 200 },
    { name: 'private route', path: '/scheduled-matches', status: 401, code: 'unauthorized' },
    { name: 'invalid id', path: '/matches/not-a-uuid', status: 400, code: 'bad_request' },
    {
      name: 'invalid token',
      path: '/feed',
      headers: { Authorization: 'Bearer invalid-token' },
      status: 401,
      code: 'unauthorized',
      noStore: true,
    },
    {
      name: 'CORS preflight',
      path: '/health',
      method: 'OPTIONS',
      headers: { Origin: 'https://security-smoke.invalid', 'Access-Control-Request-Method': 'GET' },
      status: 204,
      appHeaders: false,
      cors: '*',
    },
    {
      name: 'body ceiling',
      path: '/users/me',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedBody,
      status: 413,
      code: 'payload_too_large',
    },
  ];

  const results = [];
  for (const definition of probes) results.push(await probe(base, definition));
  return results;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runSecuritySmoke(process.env.VOLLO_API_URL)
    .then((results) => {
      console.table(results);
      console.log('Production security smoke: PASS');
    })
    .catch((error) => {
      console.error(`Production security smoke: FAIL — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiSource = readFileSync(
  new URL('../../supabase/functions/api/index.ts', import.meta.url),
  'utf8',
);
const denoConfig = JSON.parse(readFileSync(
  new URL('../../supabase/functions/api/deno.json', import.meta.url),
  'utf8',
));
const denoLock = JSON.parse(readFileSync(
  new URL('../../supabase/functions/api/deno.lock', import.meta.url),
  'utf8',
));
const dbSource = readFileSync(new URL('../../supabase/functions/api/db.ts', import.meta.url), 'utf8');
const runtimeConfig = readFileSync(new URL('../../supabase/functions/api/config.ts', import.meta.url), 'utf8');

test('Edge runtime dependencies are exact reviewed pins with a committed lockfile', () => {
  assert.deepEqual(denoConfig.imports, {
    hono: 'npm:hono@4.12.28',
    'hono/cors': 'npm:hono@4.12.28/cors',
    'hono/body-limit': 'npm:hono@4.12.28/body-limit',
    'hono/secure-headers': 'npm:hono@4.12.28/secure-headers',
    postgres: 'npm:postgres@3.4.9',
    zod: 'npm:zod@3.25.76',
    '@supabase/supabase-js': 'npm:@supabase/supabase-js@2.108.2',
  });

  assert.equal(denoLock.version, '5');
  for (const specifier of [
    'npm:hono@4.12.28',
    'npm:postgres@3.4.9',
    'npm:zod@3.25.76',
    'npm:@supabase/supabase-js@2.108.2',
  ]) {
    assert.ok(denoLock.specifiers[specifier], `lockfile is missing ${specifier}`);
  }
});

test('Edge database access is bounded per isolate and transaction-pooler ready', () => {
  assert.match(dbSource, /prepare: false/);
  assert.match(dbSource, /max: 1/);
  assert.match(runtimeConfig, /Deno\.env\.get\('DATABASE_POOL_URL'\) \?\? Deno\.env\.get\('SUPABASE_DB_URL'\)/);
});

test('API middleware permits authenticated CORS and protects sensitive responses', () => {
  assert.match(apiSource, /allowHeaders: \['Authorization', 'Content-Type', 'X-Client-Info', 'apikey'\]/);
  assert.match(apiSource, /app\.use\('\*', secureHeaders\(\)\)/);
  assert.match(apiSource, /c\.header\('Cache-Control', 'no-store'\)/);
  assert.match(apiSource, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(apiSource, /c\.header\('X-Request-Id', requestId\)/);
  assert.match(apiSource, /request_id: c\.get\('requestId'\)/);
});

test('all routes reject oversized request bodies before parsing JSON', () => {
  assert.match(apiSource, /import \{ bodyLimit \} from 'hono\/body-limit'/);
  const middlewareStart = apiSource.indexOf("app.use('*', bodyLimit");
  const firstRoute = apiSource.indexOf("app.get('/api'");
  assert.ok(middlewareStart >= 0 && middlewareStart < firstRoute);

  const middleware = apiSource.slice(middlewareStart, firstRoute);
  assert.match(middleware, /maxSize: 64 \* 1024/);
  assert.match(middleware, /payload_too_large/);
  assert.match(middleware, /Request body must not exceed 64 KiB/);
  assert.match(middleware, /}, 413\)/);
});

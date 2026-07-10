import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');

function section(start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

test('optional auth distinguishes anonymous, invalid, and transient credentials', () => {
  const parser = section('async function authFromHeader', 'function throwAuthFailure');
  assert.match(parser, /header === undefined[^]*hadToken: false/);
  assert.match(parser, /if \(!bearer\)[^]*hadToken: true, transient: false/);

  const failure = section('function throwAuthFailure', 'const requireAuth');
  assert.match(failure, /if \(transient\)[^]*503[^]*auth_unavailable/);
  assert.match(failure, /hadToken \? ApiError\.unauthorized\('Invalid or expired token'\)/);

  const optional = section('const optionalAuth', '// Best-effort in-memory');
  assert.match(optional, /\{ claims, hadToken, transient \} = await authFromHeader/);
  assert.match(optional, /if \(!claims && \(hadToken \|\| transient\)\) throwAuthFailure\(hadToken, transient\)/);
});

test('successful login clears only the canonical account bucket and waits for it', () => {
  const clear = section('async function clearLoginFailures', '// Opaque keyset cursor');
  assert.match(clear, /DELETE FROM login_attempts WHERE key = \$1/);
  assert.doesNotMatch(clear, /ANY|void query|ip:/);

  const login = section("app.post('/api/auth/login'", "app.get('/api/auth/me'");
  assert.match(login, /accountKey = account\s*\? `account:\$\{account\.id\}`/);
  assert.match(login, /await opaqueThrottleKey\('id', normalizedIdentifier\)/);
  assert.match(login, /const throttleKeys = \[`ip:\$\{clientIp\(c\)\}`, accountKey\]/);
  assert.match(login, /await clearLoginFailures\(accountKey\)/);
  assert.doesNotMatch(login, /clearLoginFailures\(throttleKeys\)/);
});

test('in-memory limiter is bounded and durable unknown-account keys are opaque', () => {
  const limiter = section('function makeLimiter', '// Username-availability checks');
  assert.match(limiter, /const maxBuckets = 4_096/);
  assert.match(limiter, /buckets\.delete\(bucketKey\)/);
  assert.match(limiter, /buckets\.size >= maxBuckets/);

  const opaque = section('async function opaqueThrottleKey', '/** Escape ILIKE wildcards');
  assert.match(opaque, /SHA-256/);
  assert.match(opaque, /return `\$\{prefix\}:\$\{hex\}`/);

  const clientIp = section('function clientIp', 'async function opaqueThrottleKey');
  assert.match(clientIp, /return hops\[0\]/);
  assert.doesNotMatch(clientIp, /\.at\(-1\)/);
});

test('rate-limited responses advertise when the client may retry', () => {
  const handler = section('app.onError', '// ─── Entrypoint');
  assert.match(handler, /err\.status === 429/);
  assert.match(handler, /c\.header\('Retry-After', String\(retryAfter\)\)/);
  assert.match(source, /exposeHeaders: \['Retry-After', 'X-Request-Id'\]/);
});

test('sensitive errors are non-cacheable and UUIDs fail at the HTTP boundary', () => {
  const middleware = section("app.use('/api/*'", "app.get('/api'");
  assert.ok(
    middleware.indexOf("c.header('Cache-Control', 'no-store')") < middleware.indexOf('await next()'),
    'cache protection must be installed before a route can throw',
  );
  assert.match(middleware, /suppliedAuth/);
  assert.match(middleware, /startsWith\('\/api\/internal\/'\)/);

  const uuid = section('const UUID_RE', 'function uid');
  assert.match(uuid, /\[0-9a-f\]\{8\}/);
  assert.match(uuid, /throw ApiError\.badRequest/);
  assert.doesNotMatch(source, /c\.req\.param\('(id|userId)'\)/);
  const cursor = section('function decodeCursor', 'function nextCursor');
  assert.match(cursor, /UUID_RE\.test\(parsed\.id\)/);
});

test('transient database saturation is retryable without leaking internals', () => {
  assert.match(source, /'53300',\s*\/\/ too_many_connections/);
  assert.match(source, /'57P01', '57P02', '57P03'/);
  assert.match(source, /if \(isTransientDatabaseError\(err\)\)/);
  assert.match(source, /c\.header\('Retry-After', '1'\)/);
  assert.match(source, /code: 'service_unavailable'.*Vollo is briefly busy/s);
});

test('one match guard hides unresolved matches before enforcing privacy and blocks', () => {
  const guard = section('async function assertCanViewMatch', "app.get('/api/matches/:id'");
  const statusCheck = guard.indexOf("match.verification_status !== 'auto'");
  const profileCheck = guard.indexOf('await assertCanViewContent');
  assert.ok(statusCheck >= 0, 'guard must check match status');
  assert.ok(profileCheck > statusCheck, 'unresolved matches must be hidden before profile checks');
  assert.match(guard, /viewerId === match\.user_id \|\| viewerId === match\.opponent_id/);
});

test('match detail and read/remove routes use the centralized visibility guard', () => {
  const routes = [
    ["app.get('/api/matches/:id'", "app.delete('/api/matches/:id'", false],
    ["app.delete('/api/matches/:id/kudos'", "app.get('/api/matches/:id/comments'", true],
    ["app.get('/api/matches/:id/comments'", "app.post('/api/matches/:id/comments'", true],
  ];

  for (const [start, end, loadsReference] of routes) {
    const route = section(start, end);
    assert.match(route, /await assertCanViewMatch\(/, `${start} must enforce match visibility`);
    if (loadsReference) {
      assert.match(route, /SELECT user_id, opponent_id, verification_status FROM matches/,
        `${start} must load verification status for the guard`);
    }
  }
});

test('transactions never re-enter the one-connection global pool for controller reads', () => {
  assert.match(source, /getCourtController\(locked\.court_id, client\)/g);
  assert.doesNotMatch(source, /locked\.court_id \? await getCourtController\(locked\.court_id\) : null/);
});

test('new kudos and comments enforce the block-aware interaction guard', () => {
  const guard = section('async function assertCanInteractWithMatch', "app.get('/api/matches/:id'");
  assert.match(guard, /await assertCanViewMatch/);
  assert.match(guard, /viewerId === match\.opponent_id/);
  assert.match(guard, /if \(access\.blocked\) throw ApiError\.notFound/);

  for (const [start, end] of [
    ["app.post('/api/matches/:id/kudos'", "app.delete('/api/matches/:id/kudos'"],
    ["app.post('/api/matches/:id/comments'", '// ─── Scheduled matches'],
  ]) {
    const route = section(start, end);
    assert.match(route, /await assertCanInteractWithMatch\(/);
    assert.match(route, /SELECT user_id, opponent_id, verification_status FROM matches/);
  }
});

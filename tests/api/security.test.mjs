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
  assert.match(login, /accountKey = account \? `account:\$\{account\.id\}`/);
  assert.match(login, /const throttleKeys = \[`ip:\$\{clientIp\(c\)\}`, accountKey\]/);
  assert.match(login, /await clearLoginFailures\(accountKey\)/);
  assert.doesNotMatch(login, /clearLoginFailures\(throttleKeys\)/);
});

test('rate-limited responses advertise when the client may retry', () => {
  const handler = section('app.onError', '// ─── Entrypoint');
  assert.match(handler, /err\.status === 429/);
  assert.match(handler, /c\.header\('Retry-After', String\(retryAfter\)\)/);
  assert.match(source, /cors\(\{ exposeHeaders: \['Retry-After'\] \}\)/);
});

test('one match guard hides unresolved matches before enforcing privacy and blocks', () => {
  const guard = section('async function assertCanViewMatch', "app.get('/api/matches/:id'");
  const statusCheck = guard.indexOf("match.verification_status !== 'auto'");
  const profileCheck = guard.indexOf('await assertCanViewContent');
  assert.ok(statusCheck >= 0, 'guard must check match status');
  assert.ok(profileCheck > statusCheck, 'unresolved matches must be hidden before profile checks');
  assert.match(guard, /viewerId === match\.user_id \|\| viewerId === match\.opponent_id/);
});

test('match detail, kudos, and comment routes all use the centralized guard', () => {
  const routes = [
    ["app.get('/api/matches/:id'", "app.delete('/api/matches/:id'", false],
    ["app.post('/api/matches/:id/kudos'", "app.delete('/api/matches/:id/kudos'", true],
    ["app.delete('/api/matches/:id/kudos'", "app.get('/api/matches/:id/comments'", true],
    ["app.get('/api/matches/:id/comments'", "app.post('/api/matches/:id/comments'", true],
    ["app.post('/api/matches/:id/comments'", '// ─── Scheduled matches', true],
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

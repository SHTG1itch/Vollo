import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RequestGeneration,
  SessionGeneration,
} from '../../mobile/src/utils/sessionGeneration.ts';

test('session generations advance only at account boundaries', () => {
  const sessions = new SessionGeneration();
  const signedOut = sessions.capture();

  assert.equal(sessions.updateAccount(null), false);
  assert.equal(sessions.capture(), signedOut);

  assert.equal(sessions.updateAccount('account-a'), true);
  const accountA = sessions.capture();
  assert.ok(accountA > signedOut);
  assert.equal(sessions.isCurrent(accountA), true);

  // A Supabase access-token rotation still belongs to account A.
  assert.equal(sessions.updateAccount('account-a'), false);
  assert.equal(sessions.capture(), accountA);

  assert.equal(sessions.updateAccount(null), true);
  assert.equal(sessions.isCurrent(accountA), false);

  assert.equal(sessions.updateAccount('account-b'), true);
  assert.ok(sessions.capture() > accountA);
  assert.equal(sessions.isCurrent(accountA), false);
});

test('direct account replacement invalidates work without an intermediate logout', () => {
  const sessions = new SessionGeneration();
  sessions.updateAccount('account-a');
  const accountA = sessions.capture();

  assert.equal(sessions.updateAccount('account-b'), true);
  assert.equal(sessions.isCurrent(accountA), false);
});

test('request generations implement latest-request-wins and explicit invalidation', () => {
  const requests = new RequestGeneration();
  const first = requests.next();
  assert.equal(requests.isCurrent(first), true);

  const second = requests.next();
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);

  requests.invalidate();
  assert.equal(requests.isCurrent(second), false);
  assert.equal(requests.capture() > second, true);
});

test('rapid account churn never revalidates an old session snapshot', () => {
  const sessions = new SessionGeneration();
  sessions.updateAccount('account-a');
  const original = sessions.capture();
  let previous = original;

  for (let i = 0; i < 10_000; i += 1) {
    sessions.updateAccount(null);
    assert.ok(sessions.capture() > previous);
    previous = sessions.capture();

    sessions.updateAccount(i % 2 === 0 ? 'account-a' : 'account-b');
    assert.ok(sessions.capture() > previous);
    previous = sessions.capture();
    assert.equal(sessions.isCurrent(original), false);
  }
});

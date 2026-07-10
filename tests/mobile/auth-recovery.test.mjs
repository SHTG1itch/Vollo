import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePasswordRecoveryLink } from '../../mobile/src/utils/authRecovery.ts';

test('password recovery parser accepts implicit token callbacks', () => {
  assert.deepEqual(
    parsePasswordRecoveryLink('vollo://reset-password#access_token=access.jwt&refresh_token=refresh-token&type=recovery'),
    { kind: 'tokens', accessToken: 'access.jwt', refreshToken: 'refresh-token' },
  );
});

test('password recovery parser accepts PKCE callbacks on the reset destination', () => {
  assert.deepEqual(
    parsePasswordRecoveryLink('vollo://reset-password?code=one-time-code'),
    { kind: 'code', code: 'one-time-code' },
  );
});

test('incomplete reset callbacks are consumed but never treated as credentials', () => {
  assert.deepEqual(
    parsePasswordRecoveryLink('vollo://reset-password#access_token=only-half&type=recovery'),
    { kind: 'invalid' },
  );
});

test('ordinary and non-app links are not mistaken for password recovery', () => {
  assert.equal(parsePasswordRecoveryLink('vollo://match/123'), null);
  assert.equal(
    parsePasswordRecoveryLink('vollo://match/123#type=recovery&access_token=a&refresh_token=b'),
    null,
  );
  assert.equal(
    parsePasswordRecoveryLink('https://attacker.example/reset-password?code=stolen'),
    null,
  );
  assert.equal(parsePasswordRecoveryLink('not a url'), null);
});

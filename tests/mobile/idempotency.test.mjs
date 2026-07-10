import assert from 'node:assert/strict';
import test from 'node:test';

import { newClientKey } from '../../mobile/src/utils/idempotency.ts';

test('client create keys are valid UUIDs and collision-free under burst load', () => {
  const keys = Array.from({ length: 2000 }, newClientKey);
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.every((key) => uuid.test(key)), true);
});

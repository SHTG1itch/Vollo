import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPersistedHome, mediaPatchValue } from '../../mobile/src/utils/profileDraft.ts';

test('profile media patch preserves unchanged fields and sends explicit clears', () => {
  assert.equal(mediaPatchValue('https://example.test/avatar.jpg', 'https://example.test/avatar.jpg'), undefined);
  assert.equal(mediaPatchValue('https://example.test/avatar.jpg', '   '), null);
  assert.equal(mediaPatchValue(null, ''), undefined);
});

test('a committed upload wins over the local draft URL', () => {
  assert.equal(
    mediaPatchValue('https://example.test/old.jpg', '', ' https://example.test/new.jpg '),
    'https://example.test/new.jpg',
  );
});

test('persisted home detection includes coordinate-only legacy profiles', () => {
  assert.equal(hasPersistedHome({ home_lat: 40, home_lng: -73, home_label: null }), true);
  assert.equal(hasPersistedHome({ home_lat: null, home_lng: null, home_label: '  Seattle  ' }), true);
  assert.equal(hasPersistedHome({ home_lat: null, home_lng: null, home_label: '' }), false);
});

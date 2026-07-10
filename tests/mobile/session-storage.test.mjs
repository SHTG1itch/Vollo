import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SESSION_CHUNK_SIZE,
  SESSION_MANIFEST_PREFIX,
  SESSION_MAX_CHUNKS,
  decodeSessionManifest,
  encodeSessionManifest,
  sessionChunkKey,
  sessionSlotCountKey,
  splitSessionValue,
} from '../../mobile/src/utils/sessionChunks.ts';

test('secure session framing round-trips empty, unicode, and maximum-size payloads', () => {
  const payloads = [
    '',
    'a'.repeat(SESSION_CHUNK_SIZE - 1),
    'a'.repeat(SESSION_CHUNK_SIZE),
    `${'x'.repeat(SESSION_CHUNK_SIZE - 1)}🎾${'y'.repeat(SESSION_CHUNK_SIZE + 3)}`,
    'z'.repeat(SESSION_CHUNK_SIZE * SESSION_MAX_CHUNKS),
  ];

  for (const payload of payloads) {
    const chunks = splitSessionValue(payload);
    assert.equal(chunks.join(''), payload);
    assert.ok(chunks.length >= 1 && chunks.length <= SESSION_MAX_CHUNKS);
    assert.ok(chunks.every((chunk) => chunk.length <= SESSION_CHUNK_SIZE));
  }
  assert.throws(
    () => splitSessionValue('z'.repeat(SESSION_CHUNK_SIZE * SESSION_MAX_CHUNKS + 1)),
    /too large/i,
  );
});

test('secure session manifests and keys reject malformed storage metadata', () => {
  const encoded = encodeSessionManifest({ slot: 'b', chunks: SESSION_MAX_CHUNKS });
  assert.deepEqual(decodeSessionManifest(encoded), { slot: 'b', chunks: SESSION_MAX_CHUNKS });
  for (const malformed of [
    `${SESSION_MANIFEST_PREFIX}c:1`,
    `${SESSION_MANIFEST_PREFIX}a:0`,
    `${SESSION_MANIFEST_PREFIX}a:33`,
    `${SESSION_MANIFEST_PREFIX}a:1:extra`,
    'plain legacy session',
    null,
  ]) {
    assert.equal(decodeSessionManifest(malformed), null);
  }
  assert.equal(sessionChunkKey('sb-project-auth-token', 'a', 4), 'sb-project-auth-token.vollo.a.4');
  assert.equal(sessionSlotCountKey('sb-project-auth-token', 'b'), 'sb-project-auth-token.vollo.b.count');
});

test('native auth storage is device-bound, serialized, and migrates plaintext sessions last', async () => {
  const [storage, client] = await Promise.all([
    readFile(new URL('../../mobile/src/lib/authStorage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../mobile/src/lib/supabase.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(client, /storage: authStorage/);
  assert.doesNotMatch(client, /storage: AsyncStorage/);
  assert.match(storage, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.match(storage, /serializeNative/);
  assert.match(storage, /await writeNativeValue\(SecureStore, key, legacy\);\s*await AsyncStorage\.removeItem\(key\)/s);
  assert.match(storage, /atomic commit point/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STORY_PIXEL_HEIGHT,
  STORY_PIXEL_WIDTH,
  asFileUri,
  captureIsReady,
  storyCaptureSize,
} from '../../mobile/src/utils/shareStory.ts';

test('story capture dimensions resolve to exactly 1080x1920 physical pixels', () => {
  for (const ratio of [1, 1.5, 2, 3, 3.5, 4]) {
    const size = storyCaptureSize(ratio);
    assert.equal(size.width * ratio, STORY_PIXEL_WIDTH);
    assert.equal(size.height * ratio, STORY_PIXEL_HEIGHT);
  }
});

test('share paths always have one file scheme', () => {
  assert.equal(asFileUri('/tmp/story.png'), 'file:///tmp/story.png');
  assert.equal(asFileUri('file:///tmp/story.png'), 'file:///tmp/story.png');
});

test('capture readiness is scoped to the current render generation', () => {
  const base = { key: 'match|photo|photo|2', photoFailedKey: null };
  assert.equal(captureIsReady({ ...base, laidOutKey: base.key, photoReadyKey: base.key, needsPhoto: true }), true);
  assert.equal(captureIsReady({ ...base, laidOutKey: 'old', photoReadyKey: base.key, needsPhoto: true }), false);
  assert.equal(captureIsReady({ ...base, laidOutKey: base.key, photoReadyKey: 'old', needsPhoto: true }), false);
  assert.equal(captureIsReady({ ...base, laidOutKey: base.key, photoReadyKey: null, needsPhoto: false }), true);
  assert.equal(captureIsReady({ ...base, laidOutKey: base.key, photoReadyKey: base.key, photoFailedKey: base.key, needsPhoto: true }), false);
});

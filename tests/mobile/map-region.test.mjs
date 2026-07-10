import assert from 'node:assert/strict';
import test from 'node:test';

import { regionToBbox } from '../../mobile/src/utils/mapRegion.ts';

test('region bbox uses half of the full react-native-maps delta', () => {
  assert.deepEqual(
    regionToBbox({ latitude: 40, longitude: -73, latitudeDelta: 0.2, longitudeDelta: 0.4 }),
    { min_lng: -73.2, min_lat: 39.9, max_lng: -72.8, max_lat: 40.1 },
  );
});

test('region bbox normalizes negative deltas defensively', () => {
  const bbox = regionToBbox({ latitude: 0, longitude: 0, latitudeDelta: -2, longitudeDelta: -4 });
  assert.deepEqual(bbox, { min_lng: -2, min_lat: -1, max_lng: 2, max_lat: 1 });
});

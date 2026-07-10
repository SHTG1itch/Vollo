import assert from 'node:assert/strict';
import test from 'node:test';

import { mapPublicUser, mapUser } from '../../supabase/functions/api/mappers.ts';

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'baseline_player',
  email: 'private@example.com',
  display_name: 'Baseline Player',
  avatar_url: null,
  cover_url: null,
  bio: 'Ready to play',
  dominant_hand: 'right',
  color: '#0F7A3D',
  home_lat: '47.620500',
  home_lng: '-122.349300',
  home_label: '123 Private Street, Seattle, WA',
  equipment: { racquet: 'Demo 98' },
  is_private: true,
  show_competitive: false,
  created_at: new Date('2026-01-02T03:04:05.000Z'),
};

test('owner user mapping retains private account settings', () => {
  const user = mapUser(row);
  assert.equal(user.email, row.email);
  assert.equal(user.home_lat, 47.6205);
  assert.equal(user.home_lng, -122.3493);
  assert.equal(user.home_label, row.home_label);
});

test('public user mapping never exposes email or saved home data', () => {
  const user = mapPublicUser(row);
  assert.equal('email' in user, false);
  assert.equal(user.home_lat, null);
  assert.equal(user.home_lng, null);
  assert.equal(user.home_label, null);
  assert.equal(user.username, row.username);
  assert.deepEqual(user.equipment, row.equipment);
});

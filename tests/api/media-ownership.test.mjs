import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isGoogleAvatarUrl,
  isOwnedUserMediaUrl,
  ownedUserMediaPathFromUrl,
} from '../../supabase/functions/api/mediaOwnership.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const api = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const validation = readFileSync(
  new URL('../../supabase/functions/api/validation.ts', import.meta.url),
  'utf8',
);

test('Vollo media ownership is bound to the bearer auth folder', () => {
  const base = 'https://project.supabase.co/storage/v1/object/public/user-media/';
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/profile/avatar-1.jpg?v=2`, owner), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/match/one.jpg`, owner), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/profile/avatar-1.jpg?v=2`, owner, 'avatar'), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/avatar.jpg`, owner, 'avatar'), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/profile/cover-1.jpg`, owner, 'cover'), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/cover.jpg`, owner, 'cover'), true);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/match/one.jpg`, owner, 'match'), true);
  assert.equal(ownedUserMediaPathFromUrl(`${base}${owner}/match/one.jpg?v=1`, owner, 'match'), `${owner}/match/one.jpg`);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/profile/avatar-1.jpg`, owner, 'match'), false);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/match/one.jpg`, owner, 'avatar'), false);
  assert.equal(isOwnedUserMediaUrl(`https://project.supabase.co/not-real${base}${owner}/match/one.jpg`, owner), false);
  assert.equal(isOwnedUserMediaUrl(`${base}${other}/profile/avatar.jpg`, owner), false);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}`, owner), false);
  assert.equal(isOwnedUserMediaUrl(`${base}${owner}/%2e%2e/${other}/cover.jpg`, owner), false);
  assert.equal(isOwnedUserMediaUrl(`https://example.com/${owner}/avatar.jpg`, owner), false);
});

test('only Google-hosted OAuth avatars bypass Vollo folder ownership', () => {
  assert.equal(isGoogleAvatarUrl('https://lh3.googleusercontent.com/a/avatar'), true);
  assert.equal(isGoogleAvatarUrl('http://lh3.googleusercontent.com/a/avatar'), false);
  assert.equal(isGoogleAvatarUrl('https://googleusercontent.com.evil.test/avatar'), false);
  assert.match(validation, /photo_url: volloMediaUrlSchema\.optional\(\)/);
  assert.match(validation, /cover_url: volloMediaUrlSchema\.nullable\(\)\.optional\(\)/);
  assert.match(validation, /avatar_url: profileAvatarUrlSchema\.nullable\(\)\.optional\(\)/);
});

test('match and profile routes enforce media ownership after schema validation', () => {
  assert.match(api, /body\.photo_url[^]*ownedUserMediaPathFromUrl\(body\.photo_url, authUid\(c\), 'match'\)/);
  assert.match(api, /b\.avatar_url[^]*isGoogleAvatarUrl\(b\.avatar_url\)[^]*ownedUserMediaPathFromUrl\(b\.avatar_url, mediaOwnerId, 'avatar'\)/);
  assert.match(api, /b\.cover_url[^]*ownedUserMediaPathFromUrl\(b\.cover_url, mediaOwnerId, 'cover'\)/);
  assert.match(api, /auth_id: data\.user\.id/);
});

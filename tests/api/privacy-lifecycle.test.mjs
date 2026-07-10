import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { mapMatchCard } from '../../supabase/functions/api/mappers.ts';

const api = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const validation = readFileSync(
  new URL('../../supabase/functions/api/validation.ts', import.meta.url),
  'utf8',
);
const mediaCleanup = readFileSync(
  new URL('../../supabase/functions/api/mediaCleanup.ts', import.meta.url),
  'utf8',
);
const analytics = readFileSync(
  new URL('../../supabase/functions/api/analytics.ts', import.meta.url),
  'utf8',
);
const records = readFileSync(
  new URL('../../supabase/functions/api/records.ts', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../../supabase/migrations/031_privacy_social_and_deletion_lifecycle.sql', import.meta.url),
  'utf8',
);
const mediaMigration = readFileSync(
  new URL('../../supabase/migrations/034_match_media_cleanup.sql', import.meta.url),
  'utf8',
);
const profileMediaMigration = readFileSync(
  new URL('../../supabase/migrations/037_profile_media_cleanup.sql', import.meta.url),
  'utf8',
);
const storageShapeMigration = readFileSync(
  new URL('../../supabase/migrations/038_storage_object_shape.sql', import.meta.url),
  'utf8',
);

function section(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

test('private profile shells mask all activity and social totals', () => {
  const profile = section(api, "app.get('/api/users/:username'", "app.post('/api/users/:username/follow'");
  assert.match(profile, /Boolean\(row\.blocked_by\) \|\| Boolean\(row\.viewer_has_blocked\)/);
  assert.match(profile, /stats: restricted\s*\? \{ match_count: 0, follower_count: 0, following_count: 0, territory_count: 0 \}/);
  assert.match(profile, /mutuallyVisibleCondition\('\$2', 'f\.follower_id'\)/);
  assert.match(profile, /mutuallyVisibleCondition\('\$2', 'f\.following_id'\)/);
  assert.match(api, /NOT \(SELECT ou\.is_private FROM users ou WHERE ou\.id = mf\.opponent_id\)/);
  assert.match(api, /opponentAccess\.blocked \|\| opponentAccess\.restricted/);
});

test('blocked social actors disappear from comment, kudos, and club surfaces', () => {
  const comments = section(
    api,
    "app.get('/api/matches/:id/comments'",
    "app.post('/api/matches/:id/comments'",
  );
  assert.match(comments, /mutuallyVisibleCondition\('\$2', 'c\.user_id'\)/);

  const giveKudos = section(
    api,
    "app.post('/api/matches/:id/kudos'",
    "app.delete('/api/matches/:id/kudos'",
  );
  assert.match(giveKudos, /mutuallyVisibleCondition\('\$2', 'k\.user_id'\)/);
  assert.match(api, /visibleMatchSocialColumns\('\$1'\)/);
  assert.match(api, /visibleMatchSocialColumns\('\$2'\)/);

  const clubs = section(api, 'const CLUB_SELECT', "app.post('/api/clubs/:id/join'");
  assert.match(clubs, /mutuallyVisibleCondition\('\$1', 'm\.user_id'\)/);
  assert.match(clubs, /mutuallyVisibleCondition\('\$2', 'm\.user_id'\)/);
  assert.match(clubs, /mutuallyVisibleCondition\('\$1', 'c\.creator_id'\)/);

  assert.match(analytics, /getHeadToHead\(userId: string, viewerId: string \| null\)/);
  assert.match(analytics, /b\.blocker_id = \$2 AND b\.blocked_id = m\.opponent_id/);
  assert.match(analytics, /NOT o\.is_private/);
  assert.match(records, /b\.blocker_id = \$4 AND b\.blocked_id = m\.opponent_id/);
  assert.match(records, /NOT ou\.is_private/);
  assert.match(records, /b\.blocker_id = \$4 AND b\.blocked_id = k\.user_id/);
});

test('viewer-filtered match totals override the raw feed-view aggregates', () => {
  const row = {
    id: 'match', user_id: 'author', opponent_id: null, opponent_name: 'Guest', court_id: null,
    surface: 'hard', title: null, photo_url: null, score_array: [[6, 0]], result: 'win',
    sets_won: 1, sets_lost: 0, games_won: 6, games_lost: 0, match_score: 6,
    streak_modifier: 1, rpe_index: null, duration_minutes: null, notes: null,
    is_tiebreak: false, verification_status: 'auto', verified_at: null,
    played_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    author_username: 'author', author_display_name: 'Author', author_avatar_url: null,
    court_name: null, court_city: null, court_lat: null, court_lng: null,
    opponent_username: null, opponent_display_name: null,
    kudos_count: '12', comment_count: '8',
    visible_kudos_count: '3', visible_comment_count: '2',
  };
  const card = mapMatchCard(row);
  assert.equal(card.kudos_count, 3);
  assert.equal(card.comment_count, 2);
});

test('follow, request, block, and unblock mutations serialize the user pair', () => {
  for (const [start, end] of [
    ["app.post('/api/users/:username/block'", "app.delete('/api/users/:username/block'"],
    ["app.delete('/api/users/:username/block'", "app.get('/api/users/:username'"],
    ["app.post('/api/users/:username/follow'", "app.delete('/api/users/:username/follow'"],
    ["app.delete('/api/users/:username/follow'", '// ─── Follow requests'],
    ["app.post('/api/users/me/follow-requests/:userId'", '/** Resolve a profile-content route'],
  ]) {
    assert.match(section(api, start, end), /lockSocialPair\(client,/);
  }
  const follow = section(
    api,
    "app.post('/api/users/:username/follow'",
    "app.delete('/api/users/:username/follow'",
  );
  assert.match(follow, /socialPairIsBlocked/);
  assert.match(follow, /INSERT INTO follow_requests/);
  assert.match(follow, /INSERT INTO follows/);

  const pairLock = section(api, 'async function lockSocialPair', 'async function socialPairIsBlocked');
  assert.ok(
    pairLock.indexOf('SELECT public.lock_social_pair') < pairLock.indexOf('FOR UPDATE'),
    'API social writes must take the advisory lock before user FK row locks',
  );
});

test('match tags and challenge proposals serialize block and spam-cap checks', () => {
  const createMatch = section(api, "app.post('/api/matches'", "app.get('/api/matches/pending'");
  const matchTransaction = createMatch.indexOf('matchId = await withTransaction');
  assert.ok(createMatch.indexOf('await lockSocialPair(client, userId, body.opponent_id)', matchTransaction) > matchTransaction);
  assert.ok(createMatch.indexOf('socialPairIsBlocked(client, userId, body.opponent_id)', matchTransaction) > matchTransaction);
  assert.ok(createMatch.indexOf("verification_status = 'pending'", matchTransaction) > matchTransaction);

  const schedule = section(api, "app.post('/api/scheduled-matches'", "app.patch('/api/scheduled-matches/:id'");
  const scheduleTransaction = schedule.indexOf('scheduledId = await withTransaction');
  assert.ok(scheduleTransaction >= 0);
  assert.ok(schedule.indexOf('await lockSocialPair(client, userId, b.opponent_id)', scheduleTransaction) > scheduleTransaction);
  assert.ok(schedule.indexOf('socialPairIsBlocked(client, userId, b.opponent_id)', scheduleTransaction) > scheduleTransaction);
  assert.ok(schedule.indexOf("status = 'proposed'", scheduleTransaction) > scheduleTransaction);
  assert.match(api, /scheduled_matches[\s\S]*mutuallyVisibleCondition\([\s\S]*CASE WHEN s\.creator_id = \$1/);
});

test('database triggers close cross-table races and repair cascaded club exits', () => {
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*vollo-social:/);
  assert.match(migration, /CREATE TRIGGER trg_follows_unblocked[\s\S]*guard_unblocked_relationship/);
  assert.match(migration, /CREATE TRIGGER trg_follow_requests_unblocked[\s\S]*guard_unblocked_relationship/);
  assert.match(migration, /CREATE TRIGGER trg_blocks_sever_relationships[\s\S]*sever_relationships_after_block/);
  assert.match(migration, /UPDATE public\.matches[\s\S]*verification_status = 'rejected'/);
  assert.match(migration, /UPDATE public\.scheduled_matches[\s\S]*status = 'cancelled', match_id = NULL/);
  assert.match(migration, /CREATE TRIGGER trg_users_accept_requests_when_public[\s\S]*accept_requests_for_public_profile/);
  assert.match(migration, /INSERT INTO public\.follows[\s\S]*DELETE FROM public\.follow_requests WHERE target_id = NEW\.id/);
  assert.match(migration, /CREATE TRIGGER trg_club_members_repair_after_delete[\s\S]*repair_club_after_member_delete/);
  assert.match(migration, /SET role = 'admin'[\s\S]*ORDER BY m\.joined_at ASC, m\.user_id ASC/);
  for (const triggerFunction of [
    'guard_unblocked_relationship',
    'lock_block_pair',
    'sever_relationships_after_block',
    'accept_requests_for_public_profile',
    'repair_club_after_member_delete',
  ]) {
    assert.match(
      migration,
      new RegExp(`FUNCTION public\\.${triggerFunction}\\(\\)[^]*SECURITY DEFINER[^]*SET search_path = pg_catalog, public`),
    );
  }
  const clubRepair = section(
    migration,
    'CREATE OR REPLACE FUNCTION public.repair_club_after_member_delete()',
    'REVOKE EXECUTE ON FUNCTION public.repair_club_after_member_delete()',
  );
  assert.ok(
    clubRepair.indexOf('FOR UPDATE') < clubRepair.indexOf("pg_advisory_xact_lock(hashtextextended('vollo-club:'"),
    'club repair must preserve row-lock then advisory-lock ordering',
  );
});

test('account deletion surfaces Auth failures and durably cleans owned Storage', () => {
  const route = section(api, "app.delete('/api/users/me'", '// ─── Goals');
  assert.doesNotMatch(route, /leaveClub|DELETE FROM club_members/);
  assert.match(route, /const \{ error \} = await adminClient\.auth\.admin\.deleteUser/);
  assert.match(route, /if \(error\)[\s\S]*account_deletion_failed/);
  assert.ok(
    route.indexOf('deleteUser(row.auth_id)') < route.indexOf('processMediaCleanupJobs(1, row.auth_id)'),
    'media must not be removed before Auth confirms deletion',
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.media_cleanup_jobs/);
  assert.match(migration, /REVOKE ALL ON public\.media_cleanup_jobs FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /AFTER DELETE ON public\.users[\s\S]*enqueue_deleted_user_media/);
  assert.match(mediaCleanup, /if \(item\.id == null\) \{[^]*folders\.push\(path\)/);
  assert.match(mediaCleanup, /paths\.slice\(i, i \+ REMOVE_BATCH_SIZE\)/);
  assert.match(mediaCleanup, /FOR UPDATE SKIP LOCKED/);
  assert.match(mediaCleanup, /Math\.min\(86_400/);
});

test('owned media lifecycle durably queues and bounds exact-object Storage cleanup', () => {
  assert.match(mediaMigration, /CREATE TABLE IF NOT EXISTS public\.media_object_cleanup_jobs/);
  assert.match(mediaMigration, /AFTER DELETE ON public\.matches[\s\S]*enqueue_deleted_match_media/);
  assert.match(mediaMigration, /object_path LIKE \(owner_auth_id::text \|\| '\/match\/%'\)/);
  assert.match(mediaMigration, /REVOKE ALL ON TABLE public\.media_object_cleanup_jobs FROM PUBLIC, anon, authenticated/);
  assert.match(profileMediaMigration, /media_object_cleanup_owned_path_check/);
  assert.match(profileMediaMigration, /CREATE TRIGGER trg_users_enqueue_replaced_media/);
  assert.match(profileMediaMigration, /enqueue_owned_profile_media_url/);
  assert.match(mediaCleanup, /OWNED_MEDIA_OBJECT_RE/);
  assert.match(mediaCleanup, /MAX_OBJECTS_PER_PASS = 200/);
  assert.match(mediaCleanup, /if \(batch\.complete\)[^]*DELETE FROM media_cleanup_jobs/);
  assert.match(mediaCleanup, /attempts = 0, next_attempt_at = now\(\), locked_until = NULL/);
  assert.match(mediaCleanup, /claimObjectCleanupJobs/);
  assert.match(mediaCleanup, /FOR UPDATE SKIP LOCKED/);
  assert.match(mediaCleanup, /remove\(\[job\.object_path\]\)/);
  assert.match(mediaCleanup, /DELETE FROM media_object_cleanup_jobs WHERE object_path = \$1/);
  const registerDraft = section(api, 'async function registerMediaDraft', 'async function discardMediaDraft');
  const discardDraft = section(api, 'async function discardMediaDraft', "app.post('/api/media/match-drafts'");
  assert.match(registerDraft, /interval '24 hours'/);
  assert.match(registerDraft, /COUNT\(\*\) FILTER \(WHERE reason = 'draft'\)/);
  assert.match(discardDraft, /DELETE FROM media_object_cleanup_jobs[^]*reason = 'draft'/);
  assert.match(api, /app\.post\('\/api\/media\/match-drafts'[^]*registerMediaDraft/);
  assert.match(api, /app\.delete\('\/api\/media\/match-drafts'[^]*discardMediaDraft/);
  assert.match(api, /const matchPhotoPath = body\.photo_url[^]*ownedUserMediaPathFromUrl/);
  assert.match(api, /if \(matchPhotoPath\)[^]*DELETE FROM media_object_cleanup_jobs[^]*reason = 'draft'/);
  assert.match(validation, /export const profileMediaDraftSchema/);
  assert.match(api, /app\.post\('\/api\/media\/profile-drafts'[^]*registerMediaDraft/);
  assert.match(api, /app\.delete\('\/api\/media\/profile-drafts'[^]*discardMediaDraft/);
  assert.match(storageShapeMigration, /CREATE POLICY "user-media owner insert"/);
  assert.match(storageShapeMigration, /\/match\/\[A-Za-z0-9\]/);
  assert.match(storageShapeMigration, /\/profile\/\(avatar\|cover\)-/);
  assert.doesNotMatch(storageShapeMigration, /FOR DELETE/);
});

test('profile PATCH distinguishes clear from omission for media and home', () => {
  const schema = section(validation, 'export const updateProfileSchema', '// The private-account owner');
  assert.match(schema, /avatar_url: profileAvatarUrlSchema\.nullable\(\)\.optional\(\)/);
  assert.match(schema, /cover_url: volloMediaUrlSchema\.nullable\(\)\.optional\(\)/);
  assert.match(schema, /home:[\s\S]*\.nullable\(\)[\s\S]*\.optional\(\)/);

  const patch = section(api, "app.patch('/api/users/me'", "app.get('/api/users/search'");
  assert.match(patch, /b\.avatar_url !== undefined/);
  assert.match(patch, /b\.cover_url !== undefined/);
  assert.match(patch, /if \(b\.home === null\)[\s\S]*home_geom = NULL[\s\S]*home_label = NULL/);
  assert.match(patch, /else \{[\s\S]*ST_SetSRID\(ST_MakePoint/);
  assert.match(patch, /const row = await withTransaction/);
  assert.match(patch, /for \(const objectPath of \[avatarMediaPath, coverMediaPath\]\)[^]*DELETE FROM media_object_cleanup_jobs[^]*reason = 'draft'/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { mapMatchCard } from '../../supabase/functions/api/mappers.ts';

const api = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const validation = readFileSync(new URL('../../supabase/functions/api/validation.ts', import.meta.url), 'utf8');
const rating = readFileSync(new URL('../../supabase/functions/api/rating.ts', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../supabase/migrations/20260820200000_046_doubles_matches.sql', import.meta.url),
  'utf8',
);

test('doubles data remains additive and singles stays the default', () => {
  assert.match(migration, /match_format TEXT NOT NULL DEFAULT 'singles'/);
  assert.match(migration, /matches_extra_slots_chk/);
  assert.match(migration, /scheduled_extra_slots_chk/);
  assert.match(migration, /LEFT JOIN public\.users partner ON partner\.id = m\.partner_id/);
  assert.match(migration, /LEFT JOIN public\.users opp2 ON opp2\.id = m\.opponent2_id/);
});

test('doubles creation requires three distinct player slots', () => {
  assert.match(migration, /matches_doubles_slots_chk[\s\S]*num_nonnulls\(partner_id[\s\S]*num_nonnulls\(opponent2_id/);
  assert.match(migration, /scheduled_doubles_slots_chk[\s\S]*num_nonnulls\(partner_id[\s\S]*num_nonnulls\(opponent2_id/);
  assert.match(validation, /Doubles matches require your partner/);
  assert.match(validation, /Doubles matches require the first opponent/);
  assert.match(validation, /Doubles matches require the second opponent/);
  assert.match(api, /new Set\(\[userId, \.\.\.taggedIds\]\)\.size !== taggedIds\.length \+ 1/);
});

test('either opposing doubles player can verify and receives the request', () => {
  assert.match(api, /\$1 IN \(mf\.opponent_id, mf\.opponent2_id\)/);
  assert.match(api, /locked\.opponent_id !== userId && locked\.opponent2_id !== userId/);
  assert.match(api, /for \(const verifierId of verifierIds\)/);
});

test('doubles ratings use both opponents while singles keeps one', () => {
  assert.match(rating, /m\.match_format === 'doubles' \? \[m\.opponent_id, m\.opponent2_id\] : \[m\.opponent_id\]/);
  assert.match(rating, /ratings\.reduce\(\(sum, r\) => sum \+ r\.mu, 0\) \/ ratings\.length/);
});

test('match cards expose both complete teams', () => {
  const card = mapMatchCard({
    id: 'match', user_id: 'author', match_format: 'doubles',
    partner_id: 'partner', partner_name: null,
    opponent_id: 'opponent', opponent_name: null,
    opponent2_id: 'opponent2', opponent2_name: null,
    court_id: null, surface: 'hard', title: null, photo_url: null,
    score_array: [[6, 4]], result: 'win', sets_won: 1, sets_lost: 0,
    games_won: 6, games_lost: 4, match_score: 2, streak_modifier: 1,
    rpe_index: null, duration_minutes: null, notes: null, is_tiebreak: false,
    verification_status: 'pending', verified_at: null,
    played_at: '2026-08-20T00:00:00.000Z', created_at: '2026-08-20T00:00:00.000Z',
    author_username: 'author', author_display_name: 'Author', author_avatar_url: null,
    partner_username: 'partner', partner_display_name: 'Partner',
    opponent_username: 'opponent', opponent_display_name: 'Opponent',
    opponent2_username: 'opponent2', opponent2_display_name: 'Opponent Two',
    court_name: null, court_city: null, court_lat: null, court_lng: null,
  });

  assert.equal(card.match_format, 'doubles');
  assert.equal(card.partner_display_name, 'Partner');
  assert.equal(card.opponent2_display_name, 'Opponent Two');
});

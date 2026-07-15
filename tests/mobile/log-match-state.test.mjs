import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOpponentPrefill,
  canSubmitLogMatch,
  hasRecordedMatchStats,
  logMatchPrefillKey,
  matchStatsValidationError,
  PhotoUploadGuard,
} from '../../mobile/src/utils/logMatchState.ts';

test('free-text opponent prefills clear a previously tagged player id', () => {
  assert.deepEqual(
    applyOpponentPrefill(
      { prefillOpponentName: 'Saturday ladder guest' },
      { opponentId: 'registered-player', opponentName: 'Old Player' },
    ),
    { opponentId: null, opponentName: 'Saturday ladder guest' },
  );
});

test('registered-player prefills retain the selected account identity', () => {
  assert.deepEqual(
    applyOpponentPrefill(
      { prefillOpponentId: 'new-player', prefillOpponentName: 'New Player' },
      { opponentId: 'old-player', opponentName: 'Old Player' },
    ),
    { opponentId: 'new-player', opponentName: 'New Player' },
  );
  assert.equal(logMatchPrefillKey({ scheduledMatchId: 'schedule-1' }), 'schedule-1');
});

test('a reset invalidates a late photo upload without affecting the next upload', () => {
  const guard = new PhotoUploadGuard();
  const staleToken = guard.begin();
  assert.equal(typeof staleToken, 'number');
  assert.equal(guard.begin(), null, 'only one picker/upload may be active');

  guard.invalidate();
  assert.equal(guard.active, false);
  assert.equal(guard.accepts(staleToken), false);
  assert.equal(guard.finish(staleToken), false);

  const currentToken = guard.begin();
  assert.equal(guard.accepts(currentToken), true);
  assert.equal(guard.finish(currentToken), true);
  assert.equal(guard.active, false);
});

test('submission stays disabled until validation passes and upload work is idle', () => {
  assert.equal(
    canSubmitLogMatch({ scoreValid: true, statsValid: true, submitting: false, photoUploadActive: false }),
    true,
  );
  assert.equal(
    canSubmitLogMatch({ scoreValid: true, statsValid: true, submitting: false, photoUploadActive: true }),
    false,
  );
  assert.equal(
    canSubmitLogMatch({ scoreValid: true, statsValid: true, submitting: true, photoUploadActive: false }),
    false,
  );
  assert.equal(
    canSubmitLogMatch({ scoreValid: false, statsValid: true, submitting: false, photoUploadActive: false }),
    false,
  );
  assert.equal(
    canSubmitLogMatch({ scoreValid: true, statsValid: false, submitting: false, photoUploadActive: false }),
    false,
  );
});

test('recorded advanced stats survive collapsing their editor', () => {
  const empty = {
    first_serve_in: 0,
    first_serve_total: 0,
    second_serve_in: 0,
    second_serve_total: 0,
    aces: 0,
    double_faults: 0,
    forehand_winners: 0,
    forehand_errors: 0,
    backhand_winners: 0,
    backhand_errors: 0,
    volley_winners: 0,
    volley_errors: 0,
    rally_short: 0,
    rally_medium: 0,
    rally_long: 0,
    break_points_won: 0,
    break_points_total: 0,
  };

  assert.equal(hasRecordedMatchStats(empty), false);
  assert.equal(hasRecordedMatchStats({ ...empty, aces: 3 }), true);
  assert.equal(matchStatsValidationError(empty), null);
  assert.equal(
    matchStatsValidationError({ ...empty, first_serve_in: 6, first_serve_total: 5 }),
    '1st serves in cannot exceed its total.',
  );
  assert.equal(
    matchStatsValidationError({ ...empty, break_points_won: 3, break_points_total: 2 }),
    'Break points won cannot exceed its total.',
  );
});

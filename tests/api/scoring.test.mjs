import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeScore, matchScore } from '../../supabase/functions/api/scoring.ts';
import { analyzeLocal, scoreValidationError } from '../../mobile/src/utils/format.ts';

test('analyzes standard best-of-three tennis scoring', () => {
  assert.deepEqual(analyzeScore([[6, 4], [2, 6], [7, 5]], { finalSetTiebreak: false }), {
    result: 'win',
    setsWon: 2,
    setsLost: 1,
    gamesWon: 15,
    gamesLost: 15,
    isTiebreak: false,
  });
});

test('counts an explicit deciding match tie-break as one game-equivalent', () => {
  const result = analyzeScore([[6, 4], [3, 6], [10, 8]], { finalSetTiebreak: true });
  assert.equal(result.result, 'win');
  assert.equal(result.gamesWon, 10);
  assert.equal(result.gamesLost, 10);
  assert.equal(result.isTiebreak, true);
});

test('does not misclassify a non-final advantage set as a match tie-break', () => {
  const result = analyzeScore([[10, 8], [6, 4]], {});
  assert.equal(result.gamesWon, 16);
  assert.equal(result.gamesLost, 12);
  assert.equal(result.isTiebreak, false);
});

test('rejects impossible, unfinished, and tied matches', () => {
  const invalid = [
    [[[1, 0]], {}, /invalid completed set/],
    [[[6, 5]], {}, /invalid completed set/],
    [[[6, 4], [4, 6]], {}, /decisive winner by sets/],
    [[[6, 4], [4, 6], [10, 9]], { finalSetTiebreak: true }, /won by two/],
    [[[6, 4], [4, 6], [8, 6]], { finalSetTiebreak: true }, /reach 10/],
  ];
  for (const [score, options, message] of invalid) {
    assert.throws(() => analyzeScore(score, options), message);
  }
});

test('mobile validation and result preview mirror the backend contract', () => {
  const valid = [[6, 4], [4, 6], [10, 7]];
  assert.equal(scoreValidationError(valid, true), null);
  assert.deepEqual(analyzeLocal(valid, true), { result: 'win', setsWon: 2, setsLost: 1 });
  assert.match(scoreValidationError([[1, 0]], false), /not a completed tennis set/);
  assert.match(scoreValidationError([[6, 4], [4, 6]], false), /decisive winner by sets/);
});

test('match scoring remains stable at two decimal places under load', () => {
  for (let games = -99; games <= 99; games++) {
    const score = matchScore(Math.max(games, 0), Math.max(-games, 0), 1.1);
    assert.equal(Number.isFinite(score), true);
    assert.equal(score, Number((games * 1.1).toFixed(2)));
  }
});

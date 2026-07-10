import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RATING,
  DEFAULT_RD,
  expectedScore,
  marginMultiplier,
  replayRating,
} from '../../supabase/functions/api/rating-model.ts';

const defaultOpponent = { mu: DEFAULT_RATING, rd: DEFAULT_RD };

test('rating replay derives a lower historical peak after its peak-setting win is deleted', () => {
  const win = { result: 'win', gamesWon: 12, gamesLost: 0, opponent: defaultOpponent };
  const loss = { result: 'loss', gamesWon: 0, gamesLost: 12, opponent: defaultOpponent };

  const original = replayRating([win, loss]);
  const afterDelete = replayRating([loss]);

  assert.ok(original.peak > DEFAULT_RATING);
  assert.equal(afterDelete.peak, DEFAULT_RATING);
  assert.ok(afterDelete.peak < original.peak);
  assert.deepEqual(
    { wins: afterDelete.wins, losses: afterDelete.losses },
    { wins: 0, losses: 1 },
  );
});

test('Bayesian replay remains finite and bounded across a large history', () => {
  const matches = Array.from({ length: 20_000 }, (_, i) => ({
    result: i % 2 === 0 ? 'win' : 'loss',
    gamesWon: i % 2 === 0 ? 12 : 8,
    gamesLost: i % 2 === 0 ? 8 : 12,
    opponent: defaultOpponent,
  }));

  const result = replayRating(matches);
  assert.equal(result.wins, 10_000);
  assert.equal(result.losses, 10_000);
  assert.equal(Number.isFinite(result.posterior.mu), true);
  assert.equal(Number.isFinite(result.posterior.rd), true);
  assert.ok(result.posterior.rd >= 30 && result.posterior.rd <= DEFAULT_RD);
  assert.ok(result.peak >= DEFAULT_RATING);
});

test('rating evidence and expected-score helpers preserve their model invariants', () => {
  assert.equal(expectedScore(1000, 1000, DEFAULT_RD), 0.5);
  assert.ok(expectedScore(1200, 1000, DEFAULT_RD) > 0.5);
  assert.equal(marginMultiplier(6, 6), 1);
  assert.ok(marginMultiplier(12, 0) > marginMultiplier(7, 6));
});

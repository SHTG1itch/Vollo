import { describe, expect, it } from 'vitest';
import { expectedScore, marginMultiplier, nextRating, ratingDelta } from '../src/services/rating.js';

describe('expectedScore', () => {
  it('is 0.5 for equal ratings', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 5);
  });
  it('favours the higher-rated player', () => {
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
    expect(expectedScore(800, 1000)).toBeLessThan(0.5);
  });
});

describe('marginMultiplier', () => {
  it('is 1 for an even game count and grows with margin', () => {
    expect(marginMultiplier(6, 6)).toBe(1);
    expect(marginMultiplier(12, 0)).toBeGreaterThan(1.9);
    expect(marginMultiplier(6, 4)).toBeGreaterThan(1);
  });
});

describe('nextRating', () => {
  it('rewards a win and penalises a loss', () => {
    expect(nextRating(1000, 1000, 'win', 6, 0)).toBeGreaterThan(1000);
    expect(nextRating(1000, 1000, 'loss', 0, 6)).toBeLessThan(1000);
  });
  it('moves more when beating a stronger opponent', () => {
    const vsStronger = nextRating(1000, 1300, 'win', 6, 3) - 1000;
    const vsWeaker = nextRating(1000, 700, 'win', 6, 3) - 1000;
    expect(vsStronger).toBeGreaterThan(vsWeaker);
  });
});

describe('ratingDelta', () => {
  it('is consistent with nextRating', () => {
    const r = nextRating(1000, 1100, 'win', 6, 2);
    expect(r).toBe(Math.round(1000 + ratingDelta(1000, 1100, 'win', 6, 2)));
  });
  it('reversing the delta returns close to the pre-match rating', () => {
    // Deleting a just-logged match should back out almost exactly the gain.
    const before = 1000;
    const after = nextRating(before, 1000, 'win', 6, 1);
    const reversed = Math.round(after - ratingDelta(after, 1000, 'win', 6, 1));
    expect(Math.abs(reversed - before)).toBeLessThanOrEqual(2);
  });
});

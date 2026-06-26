import { describe, expect, it } from 'vitest';
import { computeStreak, streakModifierFor } from '../src/services/streak.js';

const opts = { windowDays: 7, modifierStep: 0.1, modifierMax: 2.0 };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const daysAgo = (d: number) => NOW - d * DAY;

describe('computeStreak', () => {
  it('returns a neutral state with no matches', () => {
    const s = computeStreak([], NOW, opts);
    expect(s.currentStreakWeeks).toBe(0);
    expect(s.streakModifier).toBe(1);
    expect(s.lastMatchAtMs).toBeNull();
  });

  it('counts consecutive weekly buckets from now', () => {
    // one match in each of the last three 7-day windows
    const s = computeStreak([daysAgo(1), daysAgo(8), daysAgo(15)], NOW, opts);
    expect(s.currentStreakWeeks).toBe(3);
    expect(s.streakModifier).toBe(1.3);
  });

  it('breaks the current streak on a gap but records the longest run', () => {
    // buckets 0 and 2 filled, bucket 1 empty
    const s = computeStreak([daysAgo(1), daysAgo(16)], NOW, opts);
    expect(s.currentStreakWeeks).toBe(1);
    expect(s.longestStreakWeeks).toBe(1);
  });

  it('has no current streak when the latest match is stale', () => {
    const s = computeStreak([daysAgo(10), daysAgo(20)], NOW, opts);
    expect(s.currentStreakWeeks).toBe(0);
    expect(s.streakModifier).toBe(1);
  });

  it('reports a longest streak that does not drift as now advances', () => {
    // Fixed history → fixed longest, regardless of when the calc runs. Anchoring
    // to calendar windows is what stops the old rolling buckets from inflating it.
    const history = [daysAgo(2), daysAgo(9), daysAgo(16), daysAgo(45)];
    const a = computeStreak(history, NOW, opts).longestStreakWeeks;
    const b = computeStreak(history, NOW + 3 * DAY, opts).longestStreakWeeks;
    const c = computeStreak(history, NOW + 9 * DAY, opts).longestStreakWeeks;
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe('streakModifierFor', () => {
  it('scales up per week', () => {
    expect(streakModifierFor(0, opts)).toBe(1);
    expect(streakModifierFor(5, opts)).toBe(1.5);
  });
  it('caps at the configured maximum', () => {
    expect(streakModifierFor(50, opts)).toBe(2);
  });
});

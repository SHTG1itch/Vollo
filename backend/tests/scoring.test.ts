import { describe, expect, it } from 'vitest';
import { analyzeScore, formatScore, matchScore } from '../src/services/scoring.js';

describe('analyzeScore', () => {
  it('reads a straight-sets win', () => {
    const a = analyzeScore([[6, 3], [6, 4]]);
    expect(a.result).toBe('win');
    expect(a.setsWon).toBe(2);
    expect(a.setsLost).toBe(0);
    expect(a.gamesWon).toBe(12);
    expect(a.gamesLost).toBe(7);
    expect(a.isTiebreak).toBe(false);
  });

  it('reads a three-set win with a dropped set', () => {
    const a = analyzeScore([[6, 4], [2, 6], [7, 6]]);
    expect(a.result).toBe('win');
    expect(a.setsWon).toBe(2);
    expect(a.setsLost).toBe(1);
    expect(a.gamesWon).toBe(15);
    expect(a.gamesLost).toBe(16);
  });

  it('reads a straight-sets loss', () => {
    const a = analyzeScore([[2, 6], [3, 6]]);
    expect(a.result).toBe('loss');
    expect(a.setsWon).toBe(0);
    expect(a.setsLost).toBe(2);
  });

  it('treats a deciding match-tiebreak as one game-equivalent', () => {
    const a = analyzeScore([[6, 4], [4, 6], [10, 8]]);
    expect(a.isTiebreak).toBe(true);
    expect(a.result).toBe('win');
    expect(a.setsWon).toBe(2);
    expect(a.setsLost).toBe(1);
    expect(a.gamesWon).toBe(11); // 6 + 4 + 1
    expect(a.gamesLost).toBe(10); // 4 + 6 + 0
  });

  it('rejects ties and empty scores', () => {
    expect(() => analyzeScore([[6, 6]])).toThrow();
    expect(() => analyzeScore([])).toThrow();
    // @ts-expect-error invalid shape on purpose
    expect(() => analyzeScore([[6]])).toThrow();
  });
});

describe('matchScore', () => {
  it('is (gamesWon - gamesLost) * streakModifier', () => {
    expect(matchScore(6, 4, 1)).toBe(2);
    expect(matchScore(6, 4, 1.5)).toBe(3);
    expect(matchScore(4, 6, 1.5)).toBe(-3);
  });
});

describe('formatScore', () => {
  it('renders a readable score line', () => {
    expect(formatScore([[6, 4], [2, 6], [7, 6]])).toBe('6-4 2-6 7-6');
  });
});

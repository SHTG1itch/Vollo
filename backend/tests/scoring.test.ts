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

  it('counts an advantage set as real games, not a tiebreak', () => {
    // 8-6 is a legitimate advantage set, not a match tiebreak — its games count.
    const a = analyzeScore([[6, 4], [8, 6]]);
    expect(a.isTiebreak).toBe(false);
    expect(a.result).toBe('win');
    expect(a.gamesWon).toBe(14); // 6 + 8
    expect(a.gamesLost).toBe(10); // 4 + 6
  });

  it('still treats a first-to-10 super tiebreak as one game-equivalent', () => {
    const a = analyzeScore([[6, 4], [4, 6], [10, 3]]);
    expect(a.isTiebreak).toBe(true);
    expect(a.gamesWon).toBe(11); // 6 + 4 + 1
  });

  it('decides an even-set match by games, and rejects a dead tie', () => {
    // 1-1 in sets but more games won → a win, not a silent loss.
    expect(analyzeScore([[6, 0], [4, 6]]).result).toBe('win');
    // 1-1 sets and equal games has no winner.
    expect(() => analyzeScore([[6, 4], [4, 6]])).toThrow();
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

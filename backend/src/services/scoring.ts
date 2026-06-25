import type { ScoreArray, MatchResult } from '../types/index.js';

export interface ScoreAnalysis {
  result: MatchResult;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
  isTiebreak: boolean;
}

/** A value above this in a "set" slot is treated as a match/super tiebreak. */
const TIEBREAK_THRESHOLD = 7;

/**
 * Analyse a score array from the logging player's perspective.
 *
 * Each set is [gamesForUser, gamesForOpponent], e.g. [6, 4]. A deciding
 * match-tiebreak such as [10, 8] is recognised (value > 7) and counted as a
 * single game-equivalent so it does not distort the MatchScore game margin.
 *
 *   analyzeScore([[6,4],[2,6],[7,6]]) -> win, 2-1 sets, 15-16 games
 */
export function analyzeScore(score: ScoreArray): ScoreAnalysis {
  if (!Array.isArray(score) || score.length === 0) {
    throw new Error('score_array must contain at least one set');
  }

  let setsWon = 0;
  let setsLost = 0;
  let gamesWon = 0;
  let gamesLost = 0;
  let isTiebreak = false;

  for (const set of score) {
    if (!Array.isArray(set) || set.length !== 2) {
      throw new Error('each set must be a [you, opponent] pair');
    }
    const [me, opp] = set;
    if (!Number.isInteger(me) || !Number.isInteger(opp) || me < 0 || opp < 0) {
      throw new Error('set scores must be non-negative integers');
    }
    if (me === opp) {
      throw new Error('a set cannot end in a tie');
    }

    if (me > setsTopGuard(opp) || opp > setsTopGuard(me)) {
      // A super/match tiebreak (value over 7): counts as one game-equivalent.
      isTiebreak = true;
      if (me > opp) {
        gamesWon += 1;
        setsWon += 1;
      } else {
        gamesLost += 1;
        setsLost += 1;
      }
      continue;
    }

    gamesWon += me;
    gamesLost += opp;
    if (me > opp) setsWon += 1;
    else setsLost += 1;
  }

  return {
    result: setsWon > setsLost ? 'win' : 'loss',
    setsWon,
    setsLost,
    gamesWon,
    gamesLost,
    isTiebreak,
  };
}

/** A normal set tops out at 7 (7-6). Anything strictly above is a tiebreak. */
function setsTopGuard(_other: number): number {
  return TIEBREAK_THRESHOLD;
}

/**
 * The court-scoring contribution of a match:
 *   MatchScore = (gamesWon − gamesLost) × streakModifier
 * The winner accrues positive points, the loser negative — exactly the spec's
 * trailing-window leaderboard fuel.
 */
export function matchScore(gamesWon: number, gamesLost: number, streakModifier: number): number {
  return Number(((gamesWon - gamesLost) * streakModifier).toFixed(2));
}

/** Pretty score string, e.g. "6-4 2-6 7-6". */
export function formatScore(score: ScoreArray): string {
  return score.map(([a, b]) => `${a}-${b}`).join(' ');
}

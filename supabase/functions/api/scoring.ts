import type { ScoreArray, MatchResult } from './types.ts';

export interface ScoreAnalysis {
  result: MatchResult;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
  isTiebreak: boolean;
}

/**
 * A deciding match/super tiebreak is first-to-10 (win by two), so the winning
 * value in that slot is ≥10. Using 10 — rather than anything over 7 — avoids
 * misclassifying a legitimate advantage set like 8-6 or 9-7 as a tiebreak and
 * silently dropping its games.
 */
const SUPER_TIEBREAK_TARGET = 10;

export interface AnalyzeOptions {
  /**
   * Explicit signal that the FINAL set was a deciding match/super tiebreak
   * (first to 10), counted as a single game-equivalent. When provided this
   * overrides the score-magnitude guess.
   */
  finalSetTiebreak?: boolean;
}

function assertRegularSet(me: number, opp: number): void {
  const winner = Math.max(me, opp);
  const loser = Math.min(me, opp);
  const valid =
    (winner === 6 && loser <= 4) ||
    (winner === 7 && (loser === 5 || loser === 6)) ||
    (winner >= 8 && winner - loser === 2);
  if (!valid) {
    throw new Error(`invalid completed set ${me}-${opp}`);
  }
}

function assertMatchTiebreak(me: number, opp: number): void {
  const winner = Math.max(me, opp);
  if (winner < SUPER_TIEBREAK_TARGET || Math.abs(me - opp) < 2) {
    throw new Error('a match tie-break must reach 10 and be won by two');
  }
}

/**
 * Analyse a score array from the logging player's perspective.
 *
 *   analyzeScore([[6,4],[2,6],[7,6]]) -> win, 2-1 sets, 15-16 games
 */
export function analyzeScore(score: ScoreArray, opts: AnalyzeOptions = {}): ScoreAnalysis {
  if (!Array.isArray(score) || score.length === 0) {
    throw new Error('score_array must contain at least one set');
  }

  let setsWon = 0;
  let setsLost = 0;
  let gamesWon = 0;
  let gamesLost = 0;
  let isTiebreak = false;
  const lastIdx = score.length - 1;

  for (let i = 0; i < score.length; i++) {
    const set = score[i]!;
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

    let setIsTiebreak: boolean;
    if (opts.finalSetTiebreak === true) setIsTiebreak = i === lastIdx;
    else if (opts.finalSetTiebreak === false) setIsTiebreak = false;
    else setIsTiebreak = i === lastIdx && (me >= SUPER_TIEBREAK_TARGET || opp >= SUPER_TIEBREAK_TARGET);

    if (setIsTiebreak) {
      assertMatchTiebreak(me, opp);
      // A deciding super/match tiebreak: counts as one game-equivalent.
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

    assertRegularSet(me, opp);
    gamesWon += me;
    gamesLost += opp;
    if (me > opp) setsWon += 1;
    else setsLost += 1;
  }

  return {
    result: decideResult(setsWon, setsLost),
    setsWon,
    setsLost,
    gamesWon,
    gamesLost,
    isTiebreak,
  };
}

/**
 * A completed tennis match must have a winner by sets. Falling back to total
 * games lets an unfinished split-set match affect ratings and leaderboards.
 */
function decideResult(
  setsWon: number,
  setsLost: number,
): MatchResult {
  if (setsWon !== setsLost) return setsWon > setsLost ? 'win' : 'loss';
  throw new Error('match must have a decisive winner by sets');
}

/**
 * The court-scoring contribution of a match:
 *   MatchScore = (gamesWon − gamesLost) × streakModifier
 */
export function matchScore(gamesWon: number, gamesLost: number, streakModifier: number): number {
  return Number(((gamesWon - gamesLost) * streakModifier).toFixed(2));
}

/** Pretty score string, e.g. 6-4 2-6 7-6. */
export function formatScore(score: ScoreArray): string {
  return score.map(([a, b]) => `${a}-${b}`).join(' ');
}

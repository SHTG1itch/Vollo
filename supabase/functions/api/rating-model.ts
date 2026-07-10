import type { MatchResult } from './types.ts';

export const DEFAULT_RATING = 1000;
export const DEFAULT_RD = 350;
const RD_MIN = 30;
const Q = Math.LN10 / 400;

export interface Posterior {
  mu: number;
  rd: number;
}

export interface RatingReplayMatch {
  result: MatchResult;
  gamesWon: number;
  gamesLost: number;
  opponent: Posterior;
}

export interface RatingReplay {
  posterior: Posterior;
  wins: number;
  losses: number;
  peak: number;
}

/** Glicko g(RD): down-weight results against highly uncertain opponents. */
function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

/** Expected score (win probability) for a player vs an opponent. */
export function expectedScore(mu: number, oppMu: number, oppRd: number): number {
  return 1 / (1 + 10 ** ((-g(oppRd) * (mu - oppMu)) / 400));
}

/** Scale the evidence carried by a result according to its game margin. */
export function marginMultiplier(gamesWon: number, gamesLost: number): number {
  const margin = Math.abs(gamesWon - gamesLost);
  return 1 + Math.log1p(margin) / Math.log(13);
}

/** Fold one match result into the player's Gaussian rating posterior. */
export function bayesianUpdate(
  prior: Posterior,
  opp: Posterior,
  result: MatchResult,
  evidence: number,
): Posterior {
  const score = result === 'win' ? 1 : 0;
  const opponentWeight = g(opp.rd);
  const expected = 1 / (1 + 10 ** ((-opponentWeight * (prior.mu - opp.mu)) / 400));
  const likePrecision = evidence * Q * Q * opponentWeight * opponentWeight * expected * (1 - expected);
  const priorPrecision = 1 / (prior.rd * prior.rd);
  const newPrecision = priorPrecision + likePrecision;
  const rd = Math.max(RD_MIN, Math.min(DEFAULT_RD, Math.sqrt(1 / newPrecision)));
  const mu = prior.mu + (1 / newPrecision) * Q * opponentWeight * (score - expected) * evidence;
  return { mu, rd };
}

/** Replay one surface from the prior, including its historical peak. */
export function replayRating(matches: ReadonlyArray<RatingReplayMatch>): RatingReplay {
  let posterior: Posterior = { mu: DEFAULT_RATING, rd: DEFAULT_RD };
  let wins = 0;
  let losses = 0;
  let peak = DEFAULT_RATING;

  for (const match of matches) {
    posterior = bayesianUpdate(
      posterior,
      match.opponent,
      match.result,
      marginMultiplier(match.gamesWon, match.gamesLost),
    );
    if (match.result === 'win') wins++;
    else losses++;
    peak = Math.max(peak, posterior.mu);
  }

  return { posterior, wins, losses, peak };
}

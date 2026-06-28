import type { ScoreArray } from '../types';

export function timeAgo(iso: string): string {
  const date = new Date(iso);
  const then = date.getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  // Older than ~5 weeks: show the date, and include the year when it isn't the
  // current one so "Jan 3" can't be mistaken for a different year's January.
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

/**
 * Format a scheduled-match time as "Sat, Jun 28 · 5:00 PM" (year appended when
 * it isn't the current one). Used by the scheduling screens.
 */
export function formatSchedule(iso: string): string {
  const date = new Date(iso);
  const dayOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) dayOpts.year = 'numeric';
  const day = date.toLocaleDateString(undefined, dayOpts);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** Abbreviate large counts for compact UI, e.g. 1200 -> "1.2k", 12000 -> "12k". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

export function formatScoreLine(score: ScoreArray): string {
  return score.map(([a, b]) => `${a}-${b}`).join('  ');
}

export function setsSummary(score: ScoreArray): { won: number; lost: number } {
  let won = 0;
  let lost = 0;
  for (const [a, b] of score) {
    if (a > b) won++;
    else if (b > a) lost++;
  }
  return { won, lost };
}

/**
 * Client-side mirror of the backend's analyzeScore/decideResult: decide the
 * result by sets, falling back to total games when sets are even, and only call
 * it a tie when both are equal. `finalSetTiebreak` mirrors the server flag
 * (true = last set is a 1-game super-tiebreak, false = all games count,
 * undefined = magnitude heuristic).
 */
export function analyzeLocal(
  score: ScoreArray,
  finalSetTiebreak?: boolean,
): { result: 'win' | 'loss' | 'tie'; setsWon: number; setsLost: number } {
  let setsWon = 0;
  let setsLost = 0;
  let gamesWon = 0;
  let gamesLost = 0;
  const last = score.length - 1;
  score.forEach(([a, b], i) => {
    if (a === b) return; // an unfinished/tied set contributes nothing to the preview
    const isTb =
      finalSetTiebreak === true ? i === last : finalSetTiebreak === false ? false : a >= 10 || b >= 10;
    if (isTb) {
      if (a > b) { gamesWon += 1; setsWon += 1; }
      else { gamesLost += 1; setsLost += 1; }
    } else {
      gamesWon += a;
      gamesLost += b;
      if (a > b) setsWon += 1;
      else setsLost += 1;
    }
  });
  let result: 'win' | 'loss' | 'tie';
  if (setsWon !== setsLost) result = setsWon > setsLost ? 'win' : 'loss';
  else if (gamesWon !== gamesLost) result = gamesWon > gamesLost ? 'win' : 'loss';
  else result = 'tie';
  return { result, setsWon, setsLost };
}

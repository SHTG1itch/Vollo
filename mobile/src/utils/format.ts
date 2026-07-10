import type { ScoreArray } from '../types';

export function timeAgo(iso: string): string {
  const date = new Date(iso);
  const then = date.getTime();
  // Clamp future timestamps (clock skew) to "just now" instead of negatives.
  const diff = Math.max(0, Date.now() - then);
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

function regularSetIsComplete(a: number, b: number): boolean {
  const winner = Math.max(a, b);
  const loser = Math.min(a, b);
  return (
    (winner === 6 && loser <= 4) ||
    (winner === 7 && (loser === 5 || loser === 6)) ||
    (winner >= 8 && winner - loser === 2)
  );
}

/** Return a user-facing reason when a score cannot represent a completed match. */
export function scoreValidationError(score: ScoreArray, finalSetTiebreak = false): string | null {
  if (score.length === 0) return 'Add at least one completed set.';
  let won = 0;
  let lost = 0;
  const last = score.length - 1;
  for (let i = 0; i < score.length; i++) {
    const [a, b] = score[i]!;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a === b) {
      return `Set ${i + 1} needs a winner.`;
    }
    if (finalSetTiebreak && i === last) {
      if (Math.max(a, b) < 10 || Math.abs(a - b) < 2) {
        return 'The final match tie-break must reach 10 and be won by two.';
      }
    } else if (!regularSetIsComplete(a, b)) {
      return `Set ${i + 1} is not a completed tennis set.`;
    }
    if (a > b) won++;
    else lost++;
  }
  return won === lost ? 'The match needs a decisive winner by sets.' : null;
}

/** Client-side result preview. Invalid/in-progress scores remain a neutral tie. */
export function analyzeLocal(
  score: ScoreArray,
  finalSetTiebreak?: boolean,
): { result: 'win' | 'loss' | 'tie'; setsWon: number; setsLost: number } {
  let setsWon = 0;
  let setsLost = 0;
  score.forEach(([a, b]) => {
    if (a === b) return; // an unfinished/tied set contributes nothing to the preview
    if (a > b) setsWon += 1;
    else setsLost += 1;
  });
  let result: 'win' | 'loss' | 'tie';
  if (setsWon !== setsLost) result = setsWon > setsLost ? 'win' : 'loss';
  else result = 'tie';
  return { result, setsWon, setsLost };
}

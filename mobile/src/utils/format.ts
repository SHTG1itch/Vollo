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

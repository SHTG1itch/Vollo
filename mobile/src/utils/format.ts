import type { ScoreArray } from '../types';

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
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
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

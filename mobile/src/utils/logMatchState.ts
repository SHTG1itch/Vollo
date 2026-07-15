import type { MatchStats, Surface } from '../types';

export type LogMatchPrefill = {
  scheduledMatchId?: string;
  prefillOpponentId?: string;
  prefillOpponentName?: string;
  prefillCourtId?: string;
  prefillSurface?: Surface;
};

export type OpponentSelection = {
  opponentId: string | null;
  opponentName: string;
};

/** Stable identity for a one-shot navigation prefill. */
export function logMatchPrefillKey(prefill: LogMatchPrefill | undefined): string | null {
  if (!prefill) return null;
  if (prefill.scheduledMatchId) return prefill.scheduledMatchId;
  if (
    prefill.prefillOpponentId ||
    prefill.prefillOpponentName ||
    prefill.prefillCourtId ||
    prefill.prefillSurface
  ) {
    return `${prefill.prefillOpponentId ?? ''}|${prefill.prefillOpponentName ?? ''}|${prefill.prefillCourtId ?? ''}|${prefill.prefillSurface ?? ''}`;
  }
  return null;
}

/**
 * Applies only the opponent portion of a navigation prefill. A free-text name
 * deliberately clears a previously tagged account so the submitted name can
 * never be paired with a stale opponent_id.
 */
export function applyOpponentPrefill(
  prefill: LogMatchPrefill,
  current: OpponentSelection,
): OpponentSelection {
  if (prefill.prefillOpponentId) {
    return {
      opponentId: prefill.prefillOpponentId,
      opponentName: prefill.prefillOpponentName ?? '',
    };
  }
  if (prefill.prefillOpponentName) {
    return { opponentId: null, opponentName: prefill.prefillOpponentName };
  }
  return current;
}

/** Synchronous guard for picker/upload races that outlive a form reset. */
export class PhotoUploadGuard {
  private generation = 0;
  private activeGeneration: number | null = null;

  get active(): boolean {
    return this.activeGeneration !== null;
  }

  begin(): number | null {
    if (this.activeGeneration !== null) return null;
    const token = ++this.generation;
    this.activeGeneration = token;
    return token;
  }

  accepts(token: number): boolean {
    return this.activeGeneration === token;
  }

  finish(token: number): boolean {
    if (!this.accepts(token)) return false;
    this.activeGeneration = null;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.activeGeneration = null;
  }
}

export function canSubmitLogMatch({
  scoreValid,
  statsValid,
  submitting,
  photoUploadActive,
}: {
  scoreValid: boolean;
  statsValid: boolean;
  submitting: boolean;
  photoUploadActive: boolean;
}): boolean {
  return scoreValid && statsValid && !submitting && !photoUploadActive;
}

/**
 * Whether the player recorded any optional point-level statistics. This must be
 * derived from the values, not from whether the collapsible editor is visible:
 * collapsing a completed editor is a presentation choice and must not discard
 * its data from the create-match payload.
 */
export function hasRecordedMatchStats(stats: MatchStats): boolean {
  return Object.values(stats).some((value) => value > 0);
}

/** Mirror the backend's subset/total invariants with actionable form copy. */
export function matchStatsValidationError(stats: MatchStats): string | null {
  const pairs: [keyof MatchStats, keyof MatchStats, string][] = [
    ['first_serve_in', 'first_serve_total', '1st serves in'],
    ['second_serve_in', 'second_serve_total', '2nd serves in'],
    ['break_points_won', 'break_points_total', 'Break points won'],
  ];
  for (const [part, total, label] of pairs) {
    if (stats[part] > stats[total]) return `${label} cannot exceed its total.`;
  }
  return null;
}

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
  submitting,
  photoUploadActive,
}: {
  scoreValid: boolean;
  submitting: boolean;
  photoUploadActive: boolean;
}): boolean {
  return scoreValid && !submitting && !photoUploadActive;
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

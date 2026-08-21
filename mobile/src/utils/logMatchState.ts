import type { MatchStats, ScheduledMatchCard, Surface } from '../types';

export type LogMatchPrefill = {
  scheduledMatchId?: string;
  prefillOpponentId?: string;
  prefillOpponentName?: string;
  prefillMatchFormat?: 'singles' | 'doubles';
  prefillPartnerId?: string;
  prefillPartnerName?: string;
  prefillOpponent2Id?: string;
  prefillOpponent2Name?: string;
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
    prefill.prefillMatchFormat ||
    prefill.prefillPartnerId ||
    prefill.prefillPartnerName ||
    prefill.prefillOpponent2Id ||
    prefill.prefillOpponent2Name ||
    prefill.prefillCourtId ||
    prefill.prefillSurface
  ) {
    return `${prefill.prefillMatchFormat ?? ''}|${prefill.prefillPartnerId ?? ''}|${prefill.prefillPartnerName ?? ''}|${prefill.prefillOpponentId ?? ''}|${prefill.prefillOpponentName ?? ''}|${prefill.prefillOpponent2Id ?? ''}|${prefill.prefillOpponent2Name ?? ''}|${prefill.prefillCourtId ?? ''}|${prefill.prefillSurface ?? ''}`;
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

type ScheduledSelection = { id: string | null; name: string };

function scheduledSelection(id: string | null, displayName: string | null, name: string | null): ScheduledSelection {
  return { id, name: displayName ?? name ?? '' };
}

/** Orient a scheduled match from whichever registered participant logs it. */
export function scheduledMatchLogPrefill(match: ScheduledMatchCard, userId: string): LogMatchPrefill | null {
  const creator = scheduledSelection(match.creator_id, match.creator_display_name, null);
  const partner = scheduledSelection(match.partner_id, match.partner_display_name, match.partner_name);
  const opponent = scheduledSelection(match.opponent_id, match.opponent_display_name, match.opponent_name);
  const opponent2 = scheduledSelection(match.opponent2_id, match.opponent2_display_name, match.opponent2_name);
  let teams: { partner?: ScheduledSelection; opponent: ScheduledSelection; opponent2?: ScheduledSelection };

  if (match.match_format === 'singles') {
    if (userId === match.creator_id) teams = { opponent };
    else if (userId === match.opponent_id) teams = { opponent: creator };
    else return null;
  } else if (userId === match.creator_id) teams = { partner, opponent, opponent2 };
  else if (userId === match.partner_id) teams = { partner: creator, opponent, opponent2 };
  else if (userId === match.opponent_id) teams = { partner: opponent2, opponent: creator, opponent2: partner };
  else if (userId === match.opponent2_id) teams = { partner: opponent, opponent: creator, opponent2: partner };
  else return null;

  return {
    scheduledMatchId: match.id,
    prefillMatchFormat: match.match_format,
    ...(teams.partner?.id ? { prefillPartnerId: teams.partner.id } : {}),
    ...(teams.partner?.name ? { prefillPartnerName: teams.partner.name } : {}),
    ...(teams.opponent.id ? { prefillOpponentId: teams.opponent.id } : {}),
    ...(teams.opponent.name ? { prefillOpponentName: teams.opponent.name } : {}),
    ...(teams.opponent2?.id ? { prefillOpponent2Id: teams.opponent2.id } : {}),
    ...(teams.opponent2?.name ? { prefillOpponent2Name: teams.opponent2.name } : {}),
    ...(match.court_id ? { prefillCourtId: match.court_id } : {}),
    ...(match.surface ? { prefillSurface: match.surface } : {}),
  };
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

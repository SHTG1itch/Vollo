import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/** A navigation ref so non-component code (push handlers) can route. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Route a tapped push notification to the relevant screen from its data payload. */
export function navigateFromPush(data: Record<string, unknown> | null | undefined): void {
  if (!navigationRef.isReady() || !data) return;
  const matchId = typeof data.matchId === 'string' ? data.matchId : null;
  const courtId = typeof data.courtId === 'string' ? data.courtId : null;
  const scheduledMatchId = typeof data.scheduledMatchId === 'string' ? data.scheduledMatchId : null;
  if (matchId) navigationRef.navigate('MatchDetail', { matchId });
  else if (courtId) navigationRef.navigate('Court', { courtId });
  else if (scheduledMatchId) navigationRef.navigate('ScheduledMatches');
}

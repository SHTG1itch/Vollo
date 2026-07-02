import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/** A navigation ref so non-component code (push handlers) can route. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// A push tapped before the container mounts (cold start from a killed app) is
// parked here and replayed from NavigationContainer's onReady.
let pendingPush: Record<string, unknown> | null = null;

/** Route a tapped push notification to the relevant screen from its data payload. */
export function navigateFromPush(data: Record<string, unknown> | null | undefined): void {
  if (!data) return;
  if (!navigationRef.isReady()) {
    pendingPush = data;
    return;
  }
  const matchId = typeof data.matchId === 'string' ? data.matchId : null;
  const courtId = typeof data.courtId === 'string' ? data.courtId : null;
  const scheduledMatchId = typeof data.scheduledMatchId === 'string' ? data.scheduledMatchId : null;
  if (matchId) navigationRef.navigate('MatchDetail', { matchId });
  else if (courtId) navigationRef.navigate('Court', { courtId });
  else if (scheduledMatchId) navigationRef.navigate('ScheduledMatches');
}

/** Replay a push tap that arrived before navigation was ready. */
export function flushPendingPush(): void {
  if (!pendingPush || !navigationRef.isReady()) return;
  const data = pendingPush;
  pendingPush = null;
  navigateFromPush(data);
}

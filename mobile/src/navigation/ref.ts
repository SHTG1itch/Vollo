import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/** A navigation ref so non-component code (push handlers) can route. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// A push tapped before the container mounts (cold start from a killed app) is
// parked here and replayed from NavigationContainer's onReady.
let pendingPush: Record<string, unknown> | null = null;

// A push payload comes from the network — never trust its ids. An id that isn't
// a UUID (or a malformed username) falls back to the Alerts tab instead of
// mounting a detail screen that would fire arbitrary API requests with it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[a-z0-9_.-]+$/i;

/** Route a tapped push notification to the relevant screen from its data payload. */
export function navigateFromPush(data: Record<string, unknown> | null | undefined): void {
  if (!data) return;
  if (!navigationRef.isReady()) {
    pendingPush = data;
    return;
  }
  const matchId = typeof data.matchId === 'string' ? data.matchId : null;
  const courtId = typeof data.courtId === 'string' ? data.courtId : null;
  const username = typeof data.username === 'string' ? data.username : null;
  const scheduledMatchId = typeof data.scheduledMatchId === 'string' ? data.scheduledMatchId : null;
  if (matchId && UUID_RE.test(matchId)) navigationRef.navigate('MatchDetail', { matchId });
  else if (courtId && UUID_RE.test(courtId)) navigationRef.navigate('Court', { courtId });
  else if (username && USERNAME_RE.test(username)) navigationRef.navigate('UserProfile', { username });
  else if (scheduledMatchId) navigationRef.navigate('ScheduledMatches');
  else if (matchId || courtId || username) {
    // Payload targeted a screen but the id failed validation — land somewhere
    // sensible (the notification list) rather than dropping the tap.
    navigationRef.navigate('Tabs', { screen: 'Alerts' });
  }
}

/** Replay a push tap that arrived before navigation was ready. */
export function flushPendingPush(): void {
  if (!pendingPush || !navigationRef.isReady()) return;
  const data = pendingPush;
  pendingPush = null;
  navigateFromPush(data);
}

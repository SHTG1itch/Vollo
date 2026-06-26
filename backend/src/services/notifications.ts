import { query } from '../db/pool.js';
import type { NotificationType } from '../types/index.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  push?: boolean;
}

/**
 * Persist an in-app notification and (best-effort) fan it out to the user's
 * registered Expo push tokens, which Expo relays free of charge to both APNs
 * and FCM. Push failures never block the request.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { userId, type, title, body, data = {}, push = true } = input;

  await query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, type, title, body, JSON.stringify(data)],
  );

  if (push) {
    void sendPush(userId, title, body, { ...data, type }).catch((err) => {
      console.warn('[notify] push send failed', err instanceof Error ? err.message : err);
    });
  }
}

interface ExpoTicket {
  status?: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const tokens = await query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1',
    [userId],
  );
  if (tokens.length === 0) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title,
    body,
    data,
  }));

  const deadTokens: string[] = [];

  // Expo accepts at most 100 messages per request — chunk accordingly, and bound
  // each request with a timeout so a slow relay can't hang the caller. A failure
  // in one chunk must not abort the others.
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`[notify] expo push responded ${res.status}`);
        continue;
      }
      // Tickets line up positionally with the chunk. A DeviceNotRegistered ticket
      // means the token is dead — prune it so we stop fanning out to it.
      const payload = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = payload.data ?? [];
      tickets.forEach((ticket, j) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(chunk[j]!.to);
        }
      });
    } catch (err) {
      console.warn('[notify] push chunk failed', err instanceof Error ? err.message : err);
    }
  }

  if (deadTokens.length > 0) {
    await query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [deadTokens]).catch((err) =>
      console.warn('[notify] failed to prune dead tokens', err instanceof Error ? err.message : err),
    );
  }
}

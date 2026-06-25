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

  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    throw new Error(`expo push responded ${res.status}`);
  }
}

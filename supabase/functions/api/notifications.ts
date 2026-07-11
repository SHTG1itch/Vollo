import { query } from './db.ts';
import type { NotificationType } from './types.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const MAX_EXPO_RESPONSE_BYTES = 256 * 1024;
const EXPO_TICKET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Pass the raw object: postgres.js serializes jsonb params itself, so a
    // manual JSON.stringify here would double-encode it into a jsonb string.
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, type, title, body, data],
  );

  if (push) {
    await sendPush(userId, title, body, { ...data, type }).catch((err) => {
      console.warn('[notify] push send failed', err instanceof Error ? err.message : err);
    });
  }
}

interface ExpoTicket {
  id?: string;
  status?: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

type ExpoReceipt = ExpoTicket;

interface ReceiptJob {
  id: string;
  token: string;
  attempts: number;
}

export interface PushReceiptResult {
  checked: number;
  pending: number;
  dead_tokens: number;
  failed: number;
}

async function readExpoJson<T>(res: Response): Promise<T> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_EXPO_RESPONSE_BYTES) throw new Error('Expo push response exceeded size limit');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_EXPO_RESPONSE_BYTES) throw new Error('Expo push response exceeded size limit');
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function expoErrorCode(result: ExpoTicket): string {
  const code = result.details?.error ?? '';
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown_error';
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
  const receiptIds: string[] = [];
  const receiptTokens: string[] = [];
  const ticketErrors = new Set<string>();

  // Expo accepts at most 100 messages per request — chunk accordingly, bound each
  // request with a timeout, and isolate chunk failures.
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
      const payload = await readExpoJson<{ data?: ExpoTicket[] }>(res);
      const tickets = payload.data ?? [];
      tickets.forEach((ticket, j) => {
        const message = chunk[j];
        if (!message) return;
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(message.to);
        } else if (ticket.status === 'error') {
          ticketErrors.add(expoErrorCode(ticket));
        } else if (ticket.status === 'ok' && typeof ticket.id === 'string' && EXPO_TICKET_ID_RE.test(ticket.id)) {
          receiptIds.push(ticket.id);
          receiptTokens.push(message.to);
        } else if (ticket.status === 'ok') {
          ticketErrors.add('invalid_ticket_id');
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
  for (const code of ticketErrors) console.warn('[notify] Expo push ticket failed', code);
  if (receiptIds.length > 0) {
    await query(
      `INSERT INTO push_receipts (id, token)
       SELECT receipt_id, push_token
         FROM unnest($1::uuid[], $2::text[]) AS pending(receipt_id, push_token)
       ON CONFLICT (id) DO NOTHING`,
      [receiptIds, receiptTokens],
    );
  }
}

/**
 * Resolve Expo's asynchronous push receipts in bounded leased batches. The
 * immediate send response is only a ticket; DeviceNotRegistered commonly
 * arrives here later, so durable receipt tracking is required to prune tokens.
 */
export async function processPushReceipts(limit = 100): Promise<PushReceiptResult> {
  let jobs: ReceiptJob[];
  try {
    jobs = await query<ReceiptJob>(
      `WITH candidates AS (
         SELECT id
           FROM push_receipts
          WHERE next_check_at <= clock_timestamp()
            AND attempts < 8
            AND (locked_until IS NULL OR locked_until < clock_timestamp())
          ORDER BY next_check_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE push_receipts AS receipt
          SET attempts = receipt.attempts + 1,
              locked_until = clock_timestamp() + interval '2 minutes'
         FROM candidates
        WHERE receipt.id = candidates.id
       RETURNING receipt.id, receipt.token, receipt.attempts`,
      [Math.max(1, Math.min(limit, 100))],
    );
  } catch (error) {
    console.warn('[notify] could not claim push receipts', error instanceof Error ? error.message : error);
    return { checked: 0, pending: 0, dead_tokens: 0, failed: 1 };
  }
  if (jobs.length === 0) return { checked: 0, pending: 0, dead_tokens: 0, failed: 0 };

  let payload: { data?: Record<string, ExpoReceipt> };
  try {
    const res = await fetch(EXPO_RECEIPTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ids: jobs.map((job) => job.id) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Expo receipt endpoint responded ${res.status}`);
    payload = await readExpoJson<{ data?: Record<string, ExpoReceipt> }>(res);
  } catch (error) {
    const expiredIds = jobs.filter((job) => job.attempts >= 8).map((job) => job.id);
    const retryIds = jobs.filter((job) => job.attempts < 8).map((job) => job.id);
    await Promise.all([
      expiredIds.length > 0
        ? query('DELETE FROM push_receipts WHERE id = ANY($1::uuid[])', [expiredIds])
        : Promise.resolve([]),
      retryIds.length > 0
        ? query(
          `UPDATE push_receipts
              SET locked_until = NULL, next_check_at = clock_timestamp() + interval '5 minutes'
            WHERE id = ANY($1::uuid[])`,
          [retryIds],
        )
        : Promise.resolve([]),
    ]).catch(() => {});
    console.warn('[notify] push receipt lookup failed', error instanceof Error ? error.message : error);
    return { checked: 0, pending: retryIds.length, dead_tokens: 0, failed: jobs.length };
  }

  const completedIds: string[] = [];
  const pendingIds: string[] = [];
  const deadTokens: string[] = [];
  const receiptErrors = new Set<string>();
  for (const job of jobs) {
    const receipt = payload.data?.[job.id];
    if (!receipt) {
      if (job.attempts >= 8) completedIds.push(job.id);
      else pendingIds.push(job.id);
      continue;
    }
    completedIds.push(job.id);
    if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
      deadTokens.push(job.token);
    } else if (receipt.status === 'error') {
      receiptErrors.add(expoErrorCode(receipt));
    }
  }

  try {
    if (deadTokens.length > 0) {
      await query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [deadTokens]);
    }
    if (completedIds.length > 0) {
      await query('DELETE FROM push_receipts WHERE id = ANY($1::uuid[])', [completedIds]);
    }
    if (pendingIds.length > 0) {
      await query(
        `UPDATE push_receipts
            SET locked_until = NULL, next_check_at = clock_timestamp() + interval '15 minutes'
          WHERE id = ANY($1::uuid[])`,
        [pendingIds],
      );
    }
  } catch (error) {
    console.warn('[notify] could not finalize push receipts', error instanceof Error ? error.message : error);
    return { checked: 0, pending: jobs.length, dead_tokens: 0, failed: jobs.length };
  }
  for (const code of receiptErrors) console.warn('[notify] Expo push receipt failed', code);
  return {
    checked: jobs.length - pendingIds.length,
    pending: pendingIds.length,
    dead_tokens: deadTokens.length,
    failed: 0,
  };
}

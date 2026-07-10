import { query } from './db.ts';
import { adminClient } from './supabaseAdmin.ts';

const MEDIA_BUCKET = 'user-media';
const PAGE_SIZE = 100;
const REMOVE_BATCH_SIZE = 100;
const STORAGE_TIMEOUT_MS = 12_000;
// Keep one account-cleanup lease comfortably inside the Edge wall-clock budget.
// An account with more media remains queued and resumes from the now-smaller
// folder on the next sweep instead of attempting an unbounded delete.
const MAX_FOLDERS_PER_PASS = 1_000;
const MAX_OBJECTS_PER_PASS = 200;

interface CleanupJob {
  auth_id: string;
  attempts: number;
}

interface ObjectCleanupJob extends CleanupJob {
  object_path: string;
}

export interface MediaCleanupResult {
  processed: number;
  deleted_objects: number;
  failed: number;
}

function withTimeout<T>(promise: PromiseLike<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Storage ${operation} timed out`)),
      STORAGE_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer!));
}

/**
 * Recursively enumerate one deleted auth identity's folder. Storage's list API
 * returns immediate children and represents subfolders with a null id, so a
 * flat list of the root would otherwise leave `match/*` objects behind.
 */
async function listOwnedMediaBatch(authId: string): Promise<{ paths: string[]; complete: boolean }> {
  const bucket = adminClient.storage.from(MEDIA_BUCKET);
  const folders = [authId];
  const objects: string[] = [];
  let complete = true;

  scan: for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
    const prefix = folders[folderIndex]!;
    let offset = 0;
    let folderQueueFull = false;
    while (true) {
      const { data, error } = await withTimeout(
        bucket.list(prefix, {
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: 'name', order: 'asc' },
        }),
        'list',
      );
      if (error) throw new Error(`Storage list failed: ${error.message}`);
      const page = data ?? [];
      for (const item of page) {
        // Names originate from Storage, but reject path-looking values so a
        // malformed listing can never escape the deleted user's prefix.
        if (!item.name || item.name === '.' || item.name === '..' || item.name.includes('/')) {
          throw new Error('Storage returned an invalid object name');
        }
        const path = `${prefix}/${item.name}`;
        if (item.id == null) {
          if (folders.length < MAX_FOLDERS_PER_PASS) {
            folders.push(path);
          } else {
            // Future writes are path-depth constrained by migration 038. This
            // bound still protects upgraded projects containing legacy trees;
            // deleting earlier folders makes later ones reachable next pass.
            complete = false;
            folderQueueFull = true;
            break;
          }
        } else {
          objects.push(path);
          if (objects.length >= MAX_OBJECTS_PER_PASS) {
            complete = false;
            break scan;
          }
        }
      }
      if (folderQueueFull) break;
      if (page.length < PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return { paths: objects, complete };
}

async function deleteOwnedMediaBatch(authId: string): Promise<{ deleted: number; complete: boolean }> {
  const bucket = adminClient.storage.from(MEDIA_BUCKET);
  const { paths, complete } = await listOwnedMediaBatch(authId);
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await withTimeout(bucket.remove(batch), 'delete');
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
  return { deleted: paths.length, complete };
}

const OWNED_MEDIA_OBJECT_RE = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/(?:match\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}|profile\/(?:avatar|cover)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.jpg|(?:avatar|cover)\.jpg)$/i;

async function deleteOwnedObject(job: ObjectCleanupJob): Promise<number> {
  const match = OWNED_MEDIA_OBJECT_RE.exec(job.object_path);
  if (!match || match[1]!.toLowerCase() !== job.auth_id.toLowerCase()) {
    throw new Error('Invalid queued Storage object path');
  }
  const { error } = await withTimeout(
    adminClient.storage.from(MEDIA_BUCKET).remove([job.object_path]),
    'delete object',
  );
  if (error) throw new Error(`Storage object delete failed: ${error.message}`);
  return 1;
}

async function claimCleanupJobs(limit: number, onlyAuthId?: string): Promise<CleanupJob[]> {
  const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
  return await query<CleanupJob>(
    `WITH candidates AS (
       SELECT auth_id
         FROM media_cleanup_jobs
        WHERE next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
          AND ($2::uuid IS NULL OR auth_id = $2)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE media_cleanup_jobs j
        SET attempts = j.attempts + 1,
            locked_until = now() + interval '2 minutes',
            updated_at = now()
       FROM candidates c
      WHERE j.auth_id = c.auth_id
      RETURNING j.auth_id, j.attempts`,
    [boundedLimit, onlyAuthId ?? null],
  );
}

async function claimObjectCleanupJobs(limit: number, onlyAuthId?: string): Promise<ObjectCleanupJob[]> {
  const boundedLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
  return await query<ObjectCleanupJob>(
    `WITH candidates AS (
       SELECT object_path
         FROM media_object_cleanup_jobs
        WHERE next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
          AND ($2::uuid IS NULL OR auth_id = $2)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE media_object_cleanup_jobs j
        SET attempts = j.attempts + 1,
            locked_until = now() + interval '2 minutes',
            updated_at = now()
       FROM candidates c
      WHERE j.object_path = c.object_path
      RETURNING j.object_path, j.auth_id, j.attempts`,
    [boundedLimit, onlyAuthId ?? null],
  );
}

/**
 * Consume durable cleanup jobs. Individual Storage failures are retained with
 * exponential backoff and never prevent unrelated cron maintenance. Supplying
 * an auth id lets account deletion eagerly consume the trigger-created job.
 */
export async function processMediaCleanupJobs(
  limit = 10,
  onlyAuthId?: string,
): Promise<MediaCleanupResult> {
  let jobs: CleanupJob[];
  try {
    jobs = await claimCleanupJobs(limit, onlyAuthId);
  } catch (error) {
    // Allows function/migration deployment to be safely ordered; once migration
    // 031 exists, the next scheduled sweep will pick up every durable job.
    console.warn('[media-cleanup] could not claim jobs', error instanceof Error ? error.message : error);
    return { processed: 0, deleted_objects: 0, failed: 0 };
  }

  let objectJobs: ObjectCleanupJob[] = [];
  try {
    objectJobs = await claimObjectCleanupJobs(limit, onlyAuthId);
  } catch (error) {
    // Keep whole-account cleanup deploy-order safe when migration 034 has not
    // reached the database yet.
    console.warn('[media-cleanup] could not claim object jobs', error instanceof Error ? error.message : error);
  }

  let deletedObjects = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const batch = await deleteOwnedMediaBatch(job.auth_id);
      deletedObjects += batch.deleted;
      if (batch.complete) {
        await query('DELETE FROM media_cleanup_jobs WHERE auth_id = $1', [job.auth_id]);
      } else {
        // Successful partial progress is not a failed attempt. Release the lease
        // immediately; the frequent cron schedule will claim the next batch.
        await query(
          `UPDATE media_cleanup_jobs
              SET attempts = 0, next_attempt_at = now(), locked_until = NULL,
                  last_error = NULL, updated_at = now()
            WHERE auth_id = $1`,
          [job.auth_id],
        );
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      // 1m, 2m, 4m ... capped at 24h. The lease is released explicitly so a
      // later sweep can retry after next_attempt_at.
      const delaySeconds = Math.min(86_400, 60 * (2 ** Math.min(job.attempts - 1, 10)));
      await query(
        `UPDATE media_cleanup_jobs
            SET next_attempt_at = now() + ($2::int * interval '1 second'),
                locked_until = NULL,
                last_error = left($3, 500),
                updated_at = now()
          WHERE auth_id = $1`,
        [job.auth_id, delaySeconds, message],
      ).catch((dbError) => {
        console.error('[media-cleanup] failed to release job', dbError);
      });
      console.warn('[media-cleanup] storage cleanup failed', job.auth_id, message);
    }
  }

  for (const job of objectJobs) {
    try {
      deletedObjects += await deleteOwnedObject(job);
      await query('DELETE FROM media_object_cleanup_jobs WHERE object_path = $1', [job.object_path]);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const delaySeconds = Math.min(86_400, 60 * (2 ** Math.min(job.attempts - 1, 10)));
      await query(
        `UPDATE media_object_cleanup_jobs
            SET next_attempt_at = now() + ($2::int * interval '1 second'),
                locked_until = NULL,
                last_error = left($3, 500),
                updated_at = now()
          WHERE object_path = $1`,
        [job.object_path, delaySeconds, message],
      ).catch((dbError) => {
        console.error('[media-cleanup] failed to release object job', dbError);
      });
      console.warn('[media-cleanup] object cleanup failed', job.object_path, message);
    }
  }

  return { processed: jobs.length + objectJobs.length, deleted_objects: deletedObjects, failed };
}

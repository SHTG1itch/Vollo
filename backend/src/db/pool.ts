import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/**
 * Shared connection pool. PostGIS returns geometry as well-known text / GeoJSON
 * via the SQL functions we call, so no special type parsers are required here.
 *
 * NUMERIC columns are returned by `pg` as strings to avoid precision loss; the
 * query helpers in the services coerce the specific numeric fields they need.
 */
export const pool = new Pool({
  connectionString: config.database.url,
  ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error', err);
});

export type QueryParams = ReadonlyArray<unknown>;

/** Run a query and return the rows, typed by the caller. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[]);
  return res.rows;
}

/** Run a query expecting at most one row. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Execute a function inside a transaction. The callback receives a dedicated
 * client; commits on success, rolls back on throw.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

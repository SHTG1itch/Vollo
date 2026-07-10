// Postgres access layer for the Edge Function. Wraps postgres.js so the ported
// services keep using the exact `pg`-style surface they were written against:
//   - query(text, params)        -> rows[]
//   - queryOne(text, params)     -> row | null
//   - withTransaction(fn)        -> fn(client) where client.query() -> { rows }
//   - pool.query(text, params)   -> { rows }
//
// postgres.js returns the same shapes the code already expects: timestamptz as
// Date, numeric as string, jsonb parsed to objects, arrays as JS arrays.
import postgres from 'postgres';
import { config } from './config.ts';

export type Row = Record<string, unknown>;

// `prepare: false` is required because Supabase's connection may be brokered by
// the transaction-mode pooler, which doesn't support prepared statements.
const sql = postgres(config.database.url, {
  prepare: false,
  // Edge isolates scale horizontally. One connection per isolate follows the
  // serverless guidance and avoids exhausting Postgres with 5× every cold start.
  max: 1,
  idle_timeout: 20,
  connect_timeout: 15,
});

async function run(text: string, params?: ReadonlyArray<unknown>): Promise<Row[]> {
  // postgres.js models values passed to an untyped query as
  // ParameterOrJSON<never>. The application-level query surface deliberately
  // accepts unknown values, so narrow only at this library boundary.
  const res = await sql.unsafe(text, (params ?? []) as never[]);
  return Array.from(res as Iterable<Row>);
}

/** A pg.Pool-like object exposing `.query(text, params) -> { rows }`. */
export const pool = {
  query: async <T = Row>(text: string, params?: ReadonlyArray<unknown>) => ({
    rows: (await run(text, params)) as T[],
  }),
};

/** Either the shared pool or a transaction-bound client. */
export interface Queryable {
  query<T = Row>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>;
}

/** Run a query and return the rows. */
export async function query<T = Row>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<T[]> {
  return (await run(text, params)) as T[];
}

/** Run a query expecting at most one row. */
export async function queryOne<T = Row>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Execute a function inside a transaction. postgres.js's `sql.begin` handles
 * BEGIN/COMMIT/ROLLBACK; we hand the callback a client whose `.query()` returns
 * `{ rows }`, matching the pg.PoolClient surface the services expect.
 */
export async function withTransaction<T>(
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  return await sql.begin(async (tx) => {
    const client: Queryable = {
      query: async <R = Row>(text: string, params?: ReadonlyArray<unknown>) => ({
        rows: Array.from((await tx.unsafe(text, (params ?? []) as never[])) as Iterable<R>),
      }),
    };
    return await fn(client);
  }) as T;
}

// ─── Backend secrets (JWT signing key, internal sweep token) ────────────────
// Stored in the RLS-sealed app_secrets table; loaded once per cold start.
let secretsCache: Record<string, string> | null = null;

export async function getSecret(key: string): Promise<string> {
  if (!secretsCache) {
    const rows = await query<{ key: string; value: string }>('SELECT key, value FROM app_secrets');
    secretsCache = {};
    for (const r of rows) secretsCache[r.key] = r.value;
  }
  const v = secretsCache[key];
  if (!v) throw new Error(`Missing app secret: ${key}`);
  return v;
}

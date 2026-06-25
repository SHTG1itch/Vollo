import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';

/**
 * Minimal, dependency-free migration runner.
 * Applies every `*.sql` file in db/migrations in lexical order exactly once,
 * tracking applied files in a `schema_migrations` table. Each file runs inside
 * its own transaction so a failure leaves the database consistent.
 *
 *   npm run migrate
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED on ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) console.log('[migrate] nothing to apply — database is up to date');
  else console.log(`[migrate] done — ${count} migration(s) applied`);
}

// Run when invoked directly (tsx src/db/migrate.ts)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      closePool().finally(() => process.exit(1));
    });
}

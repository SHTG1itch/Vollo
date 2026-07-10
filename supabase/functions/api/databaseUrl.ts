export interface DatabaseUrlOptions {
  explicitPoolUrl?: string;
  directUrl?: string;
  poolHost?: string;
  supabaseUrl?: string;
}

const SHARED_POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const PROJECT_REF = /^[a-z]{20}$/;

function projectRef(supabaseUrl: string | undefined, directUrl: URL): string | null {
  if (supabaseUrl) {
    const match = new URL(supabaseUrl).hostname.match(/^([a-z]{20})\.supabase\.co$/);
    if (match) return match[1];
  }

  const directMatch = directUrl.hostname.match(/^db\.([a-z]{20})\.supabase\.co$/);
  return directMatch?.[1] ?? null;
}

/**
 * Resolve the database connection without ever copying a credential into source
 * control. Supabase injects the direct URL; production may provide only the
 * non-secret shared-pooler hostname and reuse the same encoded password on the
 * serverless transaction endpoint.
 */
export function resolveDatabaseUrl(options: DatabaseUrlOptions): string {
  const explicitPoolUrl = options.explicitPoolUrl?.trim();
  if (explicitPoolUrl) return explicitPoolUrl;

  const directUrl = options.directUrl?.trim();
  if (!directUrl) return '';

  const poolHost = options.poolHost?.trim().toLowerCase();
  if (!poolHost) return directUrl;
  if (!SHARED_POOLER_HOST.test(poolHost)) {
    throw new Error('DATABASE_POOL_HOST is not a trusted Supabase shared-pooler host');
  }

  const resolved = new URL(directUrl);
  if (!['postgres:', 'postgresql:'].includes(resolved.protocol)) {
    throw new Error('SUPABASE_DB_URL must use PostgreSQL');
  }
  if (!resolved.password) {
    throw new Error('SUPABASE_DB_URL is missing its injected database credential');
  }

  const ref = projectRef(options.supabaseUrl, resolved);
  if (!ref || !PROJECT_REF.test(ref)) {
    throw new Error('Unable to derive the Supabase project reference for the pooler');
  }

  resolved.hostname = poolHost;
  resolved.port = '6543';
  resolved.username = `postgres.${ref}`;
  resolved.searchParams.set('sslmode', 'require');
  return resolved.toString();
}

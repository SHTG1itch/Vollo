import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('UGC consent and reports are durable and sealed from client database roles', async () => {
  const migration = await read('supabase/migrations/20260816190000_045_ugc_moderation.sql');
  assert.match(migration, /ADD COLUMN terms_version TEXT/);
  assert.match(migration, /users_terms_acceptance_pair_chk/);
  assert.match(migration, /CREATE TABLE public\.content_reports/);
  assert.match(migration, /UNIQUE \(reporter_id, subject_type, subject_id\)/);
  assert.match(migration, /content_reports_moderation_idx/);
  assert.match(migration, /ALTER TABLE public\.content_reports ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.content_reports FROM PUBLIC, anon, authenticated/);
});

test('the API enforces current consent before every UGC creation path', async () => {
  const source = await read('supabase/functions/api/index.ts');
  assert.match(source, /const CURRENT_TERMS_VERSION = '2026-08-16'/);
  assert.match(source, /const requireCurrentTerms:[^]*terms_required/);
  for (const route of [
    '/api/media/match-drafts',
    '/api/media/profile-drafts',
    '/api/matches',
    '/api/matches/:id/comments',
    '/api/scheduled-matches',
    '/api/clubs',
    '/api/courts',
  ]) {
    const escaped = route.replaceAll('/', '\\/').replaceAll(':', '\\:');
    assert.match(source, new RegExp(`app\\.post\\('${escaped}', requireAuth, requireCurrentTerms`), route);
  }
  assert.match(source, /app\.patch\('\/api\/users\/me', requireAuth, requireCurrentTerms/);
  assert.match(source, /app\.post\('\/api\/users\/me\/terms', requireAuth/);
  assert.match(source, /version !== CURRENT_TERMS_VERSION/);
});

test('reports validate ownership, cap abuse, and safely reopen duplicate subjects', async () => {
  const source = await read('supabase/functions/api/index.ts');
  const start = source.indexOf("app.post('/api/reports'");
  const end = source.indexOf('// ─── Feed', start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /requireAuth, requireCurrentTerms/);
  assert.match(route, /subject\.owner_id === userId/);
  assert.match(route, /DAILY_REPORT_CAP/);
  assert.match(route, /pg_advisory_xact_lock\(hashtextextended\('report-create:' \|\| \$1, 0\)\)/);
  assert.match(route, /created_at > now\(\) - interval '24 hours'/);
  assert.match(route, /ON CONFLICT \(reporter_id, subject_type, subject_id\) DO UPDATE/);
  assert.match(route, /status = 'open'/);
  assert.match(route, /reviewed_at = NULL/);
});

test('public profile mapping masks private consent records', async () => {
  const source = await read('supabase/functions/api/mappers.ts');
  const start = source.indexOf('export function mapPublicUser');
  const end = source.indexOf('export function mapCourt', start);
  const mapper = source.slice(start, end);
  assert.match(mapper, /terms_version: _termsVersion/);
  assert.match(mapper, /terms_accepted_at: _termsAcceptedAt/);
  assert.match(mapper, /terms_version: null/);
  assert.match(mapper, /terms_accepted_at: null/);
});

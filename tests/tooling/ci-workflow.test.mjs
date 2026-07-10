import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/production-verification.yml', import.meta.url);
const databaseLintUrl = new URL('../../supabase/lint/public_app_functions.sql', import.meta.url);

test('production workflow pins runtimes, actions, and frozen dependency checks', async () => {
  const [workflow, databaseLint] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(databaseLintUrl, 'utf8'),
  ]);

  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v6\.0\.2/g);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6\.4\.0/);
  assert.match(workflow, /denoland\/setup-deno@[0-9a-f]{40} # v2\.0\.5/);
  assert.match(workflow, /supabase\/setup-cli@[0-9a-f]{40} # v3\.0\.0/);
  assert.match(workflow, /node-version: 24\.18\.0/);
  assert.match(workflow, /deno-version: 2\.9\.2/);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 3);
  assert.match(workflow, /deno check --frozen --config deno\.json --lock=deno\.lock index\.ts/);
  assert.match(workflow, /npm ci --prefix mobile/);
  assert.match(workflow, /npm --prefix mobile run typecheck/);
  assert.match(workflow, /npm --prefix mobile run lint/);
  assert.match(workflow, /npm --prefix mobile audit --omit=dev --audit-level=high/);
  assert.match(workflow, /npx --no-install expo install --check/);
  assert.match(workflow, /npx --yes expo-doctor@1\.20\.0/);
  assert.match(workflow, /npx --no-install expo config --type public/);
  assert.match(workflow, /npx --no-install expo export --platform android/);
  assert.match(workflow, /npx --no-install expo export --platform ios/);
  assert.match(workflow, /version: 2\.101\.0/);
  assert.match(workflow, /supabase db start/);
  assert.match(workflow, /supabase test db/);
  assert.match(workflow, /psql[^]*--file supabase\/lint\/public_app_functions\.sql/);
  assert.match(databaseLint, /plpgsql_check_function_tb/);
  assert.match(databaseLint, /namespace\.nspname = 'public'/);
  assert.match(databaseLint, /dependency\.deptype = 'e'/);
  assert.match(databaseLint, /lower\(issue\.level\) = 'error'/);
  assert.match(databaseLint, /RAISE EXCEPTION 'Vollo PL\/pgSQL lint failed/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|npm run load:test/);
});

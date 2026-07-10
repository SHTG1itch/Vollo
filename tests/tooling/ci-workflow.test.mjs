import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/production-verification.yml', import.meta.url);

test('production workflow pins runtimes, actions, and frozen dependency checks', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

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
  assert.match(workflow, /npx --no-install expo config --type public/);
  assert.match(workflow, /npx --no-install expo export --platform android/);
  assert.match(workflow, /npx --no-install expo export --platform ios/);
  assert.match(workflow, /version: 2\.101\.0/);
  assert.match(workflow, /supabase db start/);
  assert.match(workflow, /supabase test db/);
  assert.match(workflow, /supabase db lint --local --schema public --level error --fail-on error/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|npm run load:test/);
});

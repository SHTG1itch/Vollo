import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [serverSource, clientSource] = await Promise.all([
  readFile(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../mobile/src/api/client.ts', import.meta.url), 'utf8'),
]);

function serverRoutes() {
  const routes = new Set();
  for (const match of serverSource.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)) {
    const path = match[2].replace(/^\/api/, '') || '/';
    routes.add(`${match[1].toUpperCase()} ${path}`);
  }
  return routes;
}

function normalizeClientPath(path) {
  return path
    .replace(/\$\{seg\(([^)]+)\)\}/g, (_whole, name) => `:${name.trim()}`)
    // Every qs interpolation is a suffix; query parameters do not participate
    // in Hono route matching and may contain nested object-literal braces.
    .replace(/\$\{(?:qs\(|bbox\s*\?).*$/s, '');
}

function mobileRoutes() {
  const callPattern = /\brequest(?:<[\s\S]*?>)?\(\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)")/g;
  const calls = [...clientSource.matchAll(callPattern)];
  const routes = [];
  for (let index = 0; index < calls.length; index += 1) {
    const match = calls[index];
    const rawPath = match[1] ?? match[2] ?? match[3];
    const nextCallAt = calls[index + 1]?.index ?? clientSource.length;
    const callTail = clientSource.slice(match.index + match[0].length, nextCallAt);
    const method = /method:\s*'(POST|PATCH|DELETE)'/.exec(callTail)?.[1] ?? 'GET';
    routes.push(`${method} ${normalizeClientPath(rawPath)}`);
  }
  return routes;
}

test('every mobile API method and path exists in the Edge router', () => {
  const server = serverRoutes();
  const mobile = mobileRoutes();
  assert.ok(mobile.length >= 50, `route extractor unexpectedly found only ${mobile.length} mobile calls`);
  assert.equal(new Set(mobile).size, mobile.length, 'mobile client should expose each method/path once');

  const missing = mobile.filter((route) => !server.has(route));
  assert.deepEqual(missing, [], `mobile routes missing from Edge router: ${missing.join(', ')}`);
});

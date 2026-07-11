import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditUrl = new URL(
  '../../supabase/linked-tests/production_readonly_test.sql',
  import.meta.url,
);

test('the linked production audit remains rollback-only and non-mutating', async () => {
  const sql = await readFile(auditUrl, 'utf8');
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.replace(/^\s*(?:--[^\n]*\r?\n\s*)*/g, '').trim())
    .filter(Boolean);

  assert.match(sql, /^-- Linked-project production audit[\s\S]*\bBEGIN;/);
  assert.match(sql, /SELECT extensions\.plan\(22\);/);
  assert.match(sql, /SELECT \* FROM extensions\.finish\(\);\s*ROLLBACK;\s*$/);
  assert.equal(
    statements.some((statement) => /^(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(statement)),
    false,
    'the linked audit must not contain persistent data or schema mutations',
  );
  assert.doesNotMatch(
    sql,
    /SELECT\s+(?:value|decrypted_secret)\s+FROM/i,
    'the audit must never emit secret values',
  );
});

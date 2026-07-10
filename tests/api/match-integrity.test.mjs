import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const apiSource = readFileSync(new URL('../../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('../../supabase/migrations/20260710034401_029_scheduled_match_integrity.sql', import.meta.url),
  'utf8',
);

function section(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

function loadPureFunction(name, parameters) {
  const signature = new RegExp(`function ${name}\\([^]*?\\)\\s*:[^{]+\\{([^]*?)\\n\\}`);
  const body = apiSource.match(signature)?.[1];
  assert.ok(body, `missing pure helper: ${name}`);
  return Function(...parameters, body);
}

test('off-app opponent normalization ignores harmless Unicode, case, and whitespace differences', () => {
  const normalize = loadPureFunction('normalizeOpponentName', ['value']);

  assert.equal(normalize('  Serena\t  WILLIAMS  '), 'serena williams');
  assert.equal(normalize('Ｓｅｒｅｎａ Williams'), 'serena williams');
  assert.notEqual(normalize('Serena Williams'), normalize('Venus Williams'));
});

test('registered schedule counterparty is relative to whichever participant logs', () => {
  const counterparty = loadPureFunction('scheduledCounterpartyId', [
    'creatorId',
    'scheduledOpponentId',
    'callerId',
  ]);

  assert.equal(counterparty('creator', 'invitee', 'creator'), 'invitee');
  assert.equal(counterparty('creator', 'invitee', 'invitee'), 'creator');
  assert.equal(counterparty('creator', 'invitee', 'stranger'), null);
});

test('scheduled result creation locks and validates the schedule before inserting', () => {
  const guard = section(apiSource, 'async function lockScheduledMatchForCreate', "app.post('/api/matches'");
  assert.match(guard, /FROM scheduled_matches[^]*FOR UPDATE/);
  assert.match(guard, /scheduledCounterpartyId/);
  assert.match(guard, /scheduled\.status !== 'accepted'/);
  assert.match(guard, /body\.opponent_id !== expectedOpponentId/);
  assert.match(guard, /normalizeOpponentName\(body\.opponent_name\)[^]*normalizeOpponentName\(scheduled\.opponent_name\)/);
  assert.match(guard, /scheduled\.court_id !== \(body\.court_id \?\? null\)/);
  assert.match(guard, /scheduled\.surface !== body\.surface/);

  const create = section(apiSource, "app.post('/api/matches'", "app.get('/api/matches/pending'");
  assert.ok(
    create.indexOf('lockScheduledMatchForCreate') < create.indexOf('INSERT INTO matches'),
    'the schedule must be locked before the result insert',
  );
  assert.match(create, /UPDATE scheduled_matches SET match_id = \$1[^]*status = 'accepted'/);
  assert.match(create, /UPDATE scheduled_matches SET status = 'completed', match_id = \$1/);
  assert.doesNotMatch(create, /Best-effort[^]*scheduled-match link/);
});

test('verify and delete derive match state under a row lock', () => {
  const verify = section(apiSource, "app.post('/api/matches/:id/verify'", 'type ViewableMatch');
  const verifyLock = verify.indexOf('FOR UPDATE');
  assert.ok(verifyLock >= 0);
  assert.ok(verify.indexOf("locked.verification_status !== 'pending'") > verifyLock);
  assert.match(verify, /applyMatchEffects[^]*UPDATE scheduled_matches SET status = 'completed'/);
  assert.match(verify, /SET status = 'accepted', match_id = NULL/);

  const remove = section(apiSource, "app.delete('/api/matches/:id'", "app.post('/api/matches/:id/kudos'");
  const deleteLock = remove.indexOf('FOR UPDATE');
  assert.ok(deleteLock >= 0);
  assert.ok(remove.indexOf('const isCounted = locked.verification_status') > deleteLock);
  assert.ok(remove.indexOf('DELETE FROM matches') > remove.indexOf('UPDATE scheduled_matches'));
  assert.match(remove, /if \(isCounted\) await recomputeUserRatings/);
});

test('scheduled lifecycle truth table allows pending bindings but rejects incoherent states', () => {
  const allowed = (status, linked) =>
    (status !== 'completed' || linked) && (!linked || status === 'accepted' || status === 'completed');

  assert.equal(allowed('proposed', false), true);
  assert.equal(allowed('accepted', false), true);
  assert.equal(allowed('accepted', true), true, 'pending registered match binding');
  assert.equal(allowed('completed', true), true);
  assert.equal(allowed('completed', false), false);
  assert.equal(allowed('proposed', true), false);
  assert.equal(allowed('declined', true), false);
  assert.equal(allowed('cancelled', true), false);
});

test('migration cleans legacy rows before installing future-write constraints', () => {
  assert.match(migration, /regexp_replace\(opponent_name, '\[\[:space:\]\]'/);
  assert.match(migration, /row_number\(\) OVER[^]*PARTITION BY match_id/);
  assert.match(migration, /scheduled_opponent_xor_nonblank_chk[^]*num_nonnulls/);
  assert.match(migration, /scheduled_completion_match_chk[^]*status <> 'completed' OR match_id IS NOT NULL/);
  assert.match(migration, /match_id IS NULL OR status IN \('accepted', 'completed'\)/);
  assert.match(migration, /\) NOT VALID;/);
  assert.match(migration, /IF NOT EXISTS[^]*VALIDATE CONSTRAINT scheduled_opponent_xor_nonblank_chk/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS scheduled_matches_match_id_uidx[^]*WHERE match_id IS NOT NULL/);
});

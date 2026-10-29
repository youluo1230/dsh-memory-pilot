// The recent-memory-activity list. Its whole purpose is that a failure stops being
// invisible, so these tests hold it to two things: a failure is recorded and readable,
// and a row never carries something a user should not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLog, summarizeActivity, MAX_ACTIVITY } from '../src/activity.mjs';

test('a failed retrieval is visible as a failure, not as an empty result', () => {
  // This is the bug the record exists for: a retrieval that threw and one that found
  // nothing both produced empty context, so the user could not tell memory was broken.
  const log = createActivityLog();
  log.record({ kind: 'query', status: 'error', scopes: ['project'], durationMs: 42, reason: 'transport' });
  log.record({ kind: 'query', status: 'ok', scopes: ['project'], durationMs: 12, hitCount: 0 });
  const rows = log.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[1].status, 'error');
  assert.equal(rows[1].reason, 'transport');
  const summary = summarizeActivity(rows);
  assert.equal(summary.failures, 1);
  assert.ok(summary.lastFailure);
});

test('reads and writes are distinguishable, which is the question a user asks', () => {
  const log = createActivityLog();
  log.record({ kind: 'query', status: 'ok', scopes: ['global'], durationMs: 5 });
  log.record({ kind: 'retain', status: 'ok', scopes: ['project'], durationMs: 7 });
  log.record({ kind: 'distill', status: 'noop', durationMs: 9 });
  const summary = summarizeActivity(log.list());
  assert.equal(summary.queries, 1);
  assert.equal(summary.retains, 2, 'distillation is a write and counts with writes');
});

test('a row cannot carry a long dependency message or an unknown field', () => {
  // A store's error text may quote file content or an auth header, so only a short
  // reason code crosses this boundary.
  const log = createActivityLog();
  log.record({
    kind: 'query', status: 'error', reason: 'x'.repeat(200),
    scopes: ['secret-scope', 'project'], durationMs: 1, hitCount: 3,
    message: 'a very long upstream error quoting a token',
  });
  const row = log.list()[0];
  assert.equal(row.reason.length, 32);
  assert.deepEqual(row.scopes, ['project'], 'unknown scopes are dropped');
  assert.equal('message' in row, false);
});

test('the list is bounded so a long session cannot grow it without limit', () => {
  const log = createActivityLog({ limit: 5 });
  for (let index = 0; index < 20; index++) log.record({ kind: 'query', status: 'ok', durationMs: index });
  assert.equal(log.list().length, 5);
  // The newest rows survive: the oldest is the least interesting.
  assert.equal(log.list()[0].durationMs, 19);
});

test('the default cap is the documented one', () => {
  const log = createActivityLog();
  for (let index = 0; index < MAX_ACTIVITY + 10; index++) log.record({ kind: 'query', status: 'ok', durationMs: 0 });
  assert.equal(log.list().length, MAX_ACTIVITY);
});

test('an unusable row never breaks the caller', () => {
  const log = createActivityLog();
  log.record(undefined);
  log.record(null);
  log.record('not an object');
  log.record({ kind: 'query', status: 'ok' });
  assert.equal(log.list().length, 1);
});

test('an empty list summarizes to zeros rather than throwing', () => {
  const summary = summarizeActivity([]);
  assert.deepEqual(summary, { total: 0, queries: 0, retains: 0, failures: 0, lastSuccess: null, lastFailure: null });
  assert.deepEqual(summarizeActivity(undefined), summarizeActivity([]));
});

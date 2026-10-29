// What a memory declaration's authorized verbs actually do. The claims: the recall
// criterion finally sees resident memory, a write that exceeds the resident limit
// degrades to the external store instead of failing, and a failed retrieval leaves a
// readable activity row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { residentDigestOf, createReadLanding, createWriteLanding, reasonOf } from '../src/memory-landings.mjs';

test('resident memory is projected into a digest the recall criterion can use', () => {
  // This field was declared and never supplied: the point judged "is this already in
  // resident memory?" against something that was always absent. Assert both that it
  // arrives and that it is bounded — a digest that reproduced the files would dilute
  // the criteria it is meant to inform.
  const digest = residentDigestOf({
    user: '<!-- memory-pilot:managed:start -->\n<!-- id: name -->\n- 叫我阿宝\n<!-- memory-pilot:managed:end -->',
    global: '以后用 pnpm',
    project: '',
  });
  assert.match(digest.text, /阿宝/);
  assert.match(digest.text, /pnpm/);
  assert.match(digest.text, /\[user\]/);
  assert.equal(digest.text.includes('memory-pilot:managed'), false, 'markers carry no meaning to the model');
  assert.equal(digest.scopes, 2);
});

test('no resident memory yields no digest rather than an empty string', () => {
  assert.equal(residentDigestOf(undefined), undefined);
  assert.equal(residentDigestOf({ user: '', global: '  ', project: '' }), undefined);
  assert.equal(residentDigestOf({}), undefined);
});

test('a read landing queries only the scopes the answer chose', async () => {
  const asked = [];
  const landing = createReadLanding({
    readableScopes: ['global', 'project'],
    retrieve: async ({ scopes, mode }) => { asked.push({ scopes, mode }); return { status: 'ok', hitCount: 2, context: 'x' }; },
  });
  const applied = await landing({
    verb: { verb: 'route' },
    answers: [{ name: 'recall_gate', choice: 'memory' }, { name: 'retrieval_mode', choice: 'reflect' }, { name: 'scope_project', choice: 'query' }, { name: 'scope_global', choice: 'skip' }],
  });
  assert.deepEqual(asked, [{ scopes: ['project'], mode: 'reflect' }]);
  assert.equal(applied.acted, true);
});

test('a read landing acts on nothing when the gate said proceed', async () => {
  const landing = createReadLanding({ readableScopes: ['project'], retrieve: async () => ({ status: 'ok' }) });
  const applied = await landing({ verb: { verb: 'proceed' }, answers: [{ name: 'recall_gate', choice: 'none' }] });
  assert.equal(applied.acted, false);
});

test('a failed retrieval records its failure instead of going silent', async () => {
  const activity = [];
  const landing = createReadLanding({
    readableScopes: ['project'],
    retrieve: async () => { throw new Error('Adapter HTTP request failed'); },
    onActivity: row => activity.push(row),
  });
  await assert.rejects(landing({ verb: { verb: 'route' }, answers: [{ name: 'scope_project', choice: 'query' }] }));
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, 'query');
  assert.equal(activity[0].status, 'error');
  assert.equal(activity[0].reason, 'transport');
});

test('a full resident store degrades the write to the external backend', async () => {
  // "The file is full" is not a reason the user's correction should vanish.
  const writes = [];
  const landing = createWriteLanding({
    writableScopes: ['project-memory'],
    residentFull: error => /exceeds limit/i.test(error.message),
    retain: async ({ scope }) => {
      writes.push(scope);
      if (scope === 'project-memory') throw new Error('Resident memory content exceeds limit');
      return { target: scope, status: 'ok' };
    },
  });
  const applied = await landing({
    verb: { verb: 'store' },
    event: { id: 'e1', text: 'a fact' },
    answers: [{ name: 'retention_gate', choice: 'retain' }, { name: 'write_scope_project-memory', choice: 'write' }],
  });
  assert.deepEqual(writes, ['project-memory', 'external']);
  assert.equal(applied.acted, true);
  assert.equal(applied.results[0].status, 'degraded');
});

test('only a full resident store degrades; another failure is reported as one', async () => {
  const landing = createWriteLanding({
    writableScopes: ['project-memory'],
    residentFull: error => /exceeds limit/i.test(error.message),
    retain: async () => { throw new Error('revision conflict'); },
  });
  const applied = await landing({
    verb: { verb: 'store' },
    event: { id: 'e1', text: 'a fact' },
    answers: [{ name: 'write_scope_project-memory', choice: 'write' }],
  });
  assert.equal(applied.acted, false);
  assert.equal(applied.results[0].status, 'error');
  assert.equal(applied.results[0].reason, 'revision-conflict');
});

test('a write landing acts on nothing when the gate said discard', async () => {
  let called = 0;
  const landing = createWriteLanding({ writableScopes: ['project-memory'], retain: async () => { called++; } });
  const applied = await landing({ verb: { verb: 'proceed' }, answers: [{ name: 'retention_gate', choice: 'discard' }] });
  assert.equal(applied.acted, false);
  assert.equal(called, 0);
});

test('reasons are short codes, never messages', () => {
  assert.equal(reasonOf(new Error('Resident memory content exceeds limit')), 'resident-full');
  assert.equal(reasonOf(new Error('Operation aborted')), 'aborted');
  assert.equal(reasonOf(new Error('Adapter HTTP request failed')), 'transport');
  assert.equal(reasonOf(new Error('Write evidence does not match event')), 'evidence-mismatch');
  assert.ok(reasonOf(new Error('something else entirely')).length < 20);
});

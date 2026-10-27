import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionRouter } from '../src/retention-router.mjs';

const event = { id: 'e1', type: 'checkpoint', text: 'For every project, use pnpm from now on.', actorId: 'alice', projectId: 'repo' };
// A router write advances `revisions` in place — that is the fence moving forward
// for the next call — so every test needs its own copy. Sharing one fixture made
// the suite order-dependent: an earlier test's write left `u2` behind and the
// audit assertion below only passed because no test wrote twice.
const makeResident = () => ({ resident: { user: 'Prefers Chinese.', global: '', project: '' }, revisions: { user: 'u1', global: 'g1', project: 'p1' } });
const resident = makeResident();

test('retention router lets the decision model choose one resident target and applies an evidence-bound upsert', async () => {
  const calls = [], applied = [];
  const resident = makeResident();
  const router = createRetentionRouter({
    decision: { async decideRetention(input) { calls.push(input); return { target: 'user', key: 'package-manager', content: 'The user prefers pnpm for Node.js projects.', evidence: { eventId: 'e1', quote: 'use pnpm' } }; } },
    residentMemory: { async apply(plan, revision, identity) { applied.push({ plan, revision, identity }); return { target: plan.target, revision: 'u2' }; } },
  });
  const result = await router.retain(event, resident, { projectPath: '/repo' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls[0].availableTargets, ['user', 'global-memory', 'project-memory']);
  assert.deepEqual(calls[0].resident, resident.resident);
  assert.equal(applied[0].revision, 'u1');
  assert.equal(applied[0].plan.actor, 'agent');
  assert.equal(applied[0].plan.target, 'user');
});

test('retention router rejects soul, invented evidence, and unknown targets before writing', async () => {
  const resident = makeResident();
  for (const plan of [
    { target: 'soul', key: 'x', content: 'x', evidence: { eventId: 'e1', quote: 'use pnpm' } },
    { target: 'user', key: 'x', content: 'x', evidence: { eventId: 'e1', quote: 'invented' } },
    { target: 'other', key: 'x', content: 'x', evidence: { eventId: 'e1', quote: 'use pnpm' } },
  ]) {
    let writes = 0;
    const router = createRetentionRouter({ decision: { decideRetention: async () => plan }, residentMemory: { apply: async () => { writes++; } } });
    assert.equal((await router.retain(event, resident, {})).status, 'denied');
    assert.equal(writes, 0);
  }
});

test('retention router emits content-free audit records for resident outcomes',async()=>{
 const audits=[];const resident=makeResident();const router=createRetentionRouter({decision:{decideRetention:async()=>({target:'user',key:'preference',content:'Uses pnpm.',evidence:{eventId:'e1',quote:'use pnpm'}})},residentMemory:{apply:async()=>({revision:'u2'})},onAudit:record=>audits.push(record)});
 assert.equal((await router.retain(event,resident,{})).status,'ok');assert.deepEqual(audits,[{kind:'resident-retention',actor:'agent',target:'user',eventId:'e1',status:'ok',previousRevision:'u1',revision:'u2'}]);assert.equal(JSON.stringify(audits).includes('pnpm'),false);
});

test('retention router delegates external retention without modifying resident files', async () => {
  let residentWrites = 0, externalCalls = 0;
  const resident = makeResident();
  const router = createRetentionRouter({
    decision: { decideRetention: async () => ({ target: 'external' }) },
    residentMemory: { apply: async () => { residentWrites++; } },
    externalRetain: async received => { externalCalls++; assert.equal(received, event); return { status: 'ok', accepted: 1 }; },
  });
  assert.deepEqual(await router.retain(event, resident, {}), { status: 'ok', accepted: 1 });
  assert.equal(residentWrites, 0); assert.equal(externalCalls, 1);
});

// Regression for the parallel-remember data loss: DSH dispatches up to ten tool
// calls per step, so a model emitting two `memory_remember` calls in one turn had
// them both assert the same fence and the second one lose with a revision
// conflict. The content is dropped silently — the tool returns `accepted: 0`.
test('concurrent remembers for the same target both land instead of racing the fence', async () => {
  const resident = makeResident();
  const written = [];
  const router = createRetentionRouter({
    decision: { decideRetention: async input => ({ target: 'user', key: input.event.id, content: `fact ${input.event.id}`, evidence: { eventId: input.event.id, quote: 'use pnpm' } }) },
    // A real store asserts the fence: stale revisions are refused.
    residentMemory: {
      async apply(plan, revision) {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (revision !== resident.revisions.user) throw new Error('Resident memory revision conflict');
        written.push(plan.key);
        resident.revisions.user = `rev-${written.length}`;
        return { revision: resident.revisions.user };
      },
    },
  });
  const results = await Promise.all([
    router.retain({ ...event, id: 'e1' }, resident, {}),
    router.retain({ ...event, id: 'e2' }, resident, {}),
  ]);
  assert.deepEqual(results.map(row => row.status), ['ok', 'ok']);
  assert.deepEqual(written, ['e1', 'e2']);
});

test('a fence advanced outside this router is retried once instead of dropping the write', async () => {
  const resident = makeResident();
  let attempts = 0;
  const router = createRetentionRouter({
    decision: { decideRetention: async input => ({ target: 'user', key: 'k', content: 'fact', evidence: { eventId: input.event.id, quote: 'use pnpm' } }) },
    residentMemory: {
      // A human edited the file through the settings RPC while the model was
      // deciding, so the in-memory fence is stale but the file is intact.
      async inspect() { return { user: { revision: 'human-edit' } }; },
      async apply(_plan, revision) {
        attempts++;
        if (revision !== 'human-edit') throw new Error('Resident memory revision conflict');
        return { revision: 'after' };
      },
    },
  });
  const result = await router.retain({ ...event, id: 'e1' }, resident, {});
  assert.equal(result.status, 'ok');
  assert.equal(attempts, 2);
  assert.equal(resident.revisions.user, 'after');
});

test('an unrecoverable revision conflict reports error after exactly one retry', async () => {
  const resident = makeResident();
  let attempts = 0;
  const router = createRetentionRouter({
    decision: { decideRetention: async input => ({ target: 'user', key: 'k', content: 'fact', evidence: { eventId: input.event.id, quote: 'use pnpm' } }) },
    residentMemory: {
      // The fresh read keeps disagreeing with the file, so the retry must not
      // spin: one retry, then a shaped error the caller can see.
      async inspect() { return { user: { revision: `moving-${attempts}` } }; },
      async apply() { attempts++; throw new Error('Resident memory revision conflict'); },
    },
  });
  assert.equal((await router.retain({ ...event, id: 'e1' }, resident, {})).status, 'error');
  // One initial attempt plus exactly one retry, never an unbounded loop.
  assert.equal(attempts, 2);
});

test('without a readable store a conflict is not retried blindly', async () => {
  const resident = makeResident();
  let attempts = 0;
  const router = createRetentionRouter({
    decision: { decideRetention: async input => ({ target: 'user', key: 'k', content: 'fact', evidence: { eventId: input.event.id, quote: 'use pnpm' } }) },
    residentMemory: { async apply() { attempts++; throw new Error('Resident memory revision conflict'); } },
  });
  assert.equal((await router.retain({ ...event, id: 'e1' }, resident, {})).status, 'error');
  assert.equal(attempts, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetentionRouter } from '../src/retention-router.mjs';

const event = { id: 'e1', type: 'checkpoint', text: 'For every project, use pnpm from now on.', actorId: 'alice', projectId: 'repo' };
const resident = { resident: { user: 'Prefers Chinese.', global: '', project: '' }, revisions: { user: 'u1', global: 'g1', project: 'p1' } };

test('retention router lets the decision model choose one resident target and applies an evidence-bound upsert', async () => {
  const calls = [], applied = [];
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
 const audits=[];const router=createRetentionRouter({decision:{decideRetention:async()=>({target:'user',key:'preference',content:'Uses pnpm.',evidence:{eventId:'e1',quote:'use pnpm'}})},residentMemory:{apply:async()=>({revision:'u2'})},onAudit:record=>audits.push(record)});
 assert.equal((await router.retain(event,resident,{})).status,'ok');assert.deepEqual(audits,[{kind:'resident-retention',actor:'agent',target:'user',eventId:'e1',status:'ok',previousRevision:'u1',revision:'u2'}]);assert.equal(JSON.stringify(audits).includes('pnpm'),false);
});

test('retention router delegates external retention without modifying resident files', async () => {
  let residentWrites = 0, externalCalls = 0;
  const router = createRetentionRouter({
    decision: { decideRetention: async () => ({ target: 'external' }) },
    residentMemory: { apply: async () => { residentWrites++; } },
    externalRetain: async received => { externalCalls++; assert.equal(received, event); return { status: 'ok', accepted: 1 }; },
  });
  assert.deepEqual(await router.retain(event, resident, {}), { status: 'ok', accepted: 1 });
  assert.equal(residentWrites, 0); assert.equal(externalCalls, 1);
});

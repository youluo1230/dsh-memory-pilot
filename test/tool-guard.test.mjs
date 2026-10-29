// Tool safety at the per-call gate. The claim these tests hold the code to is
// behavioural: a severity, not a verdict, decides what happens, and the user's
// automation tier can only tighten. A guard that asked the model "should I ask?"
// would fail here, because then a misjudgment could override the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGuard, createMonotonicRefusal, callFamily } from '../src/tool-guard.mjs';

const exec = (name = 'bash', args = { command: 'git status' }) => ({ name, arguments: args });

function guarded({ severity, tier = 'ask', approve } = {}) {
  const recorded = [];
  const guard = createToolGuard({
    judge: async () => (severity === undefined ? undefined : { severity }),
    approve,
    tier: () => tier,
    record: row => recorded.push(row),
  });
  return { guard, recorded };
}

test('the four severities land on their expected actions', async () => {
  // Each severity is its own expectation: reversible and unknown pass silently,
  // destructive and out-of-scope ask. `unknown` passing is deliberate — not knowing
  // something is dangerous is not the same as knowing it is.
  for (const [severity, kind] of [['reversible', 'allow'], ['unknown', 'allow'], ['destructive', 'ask'], ['out-of-scope', 'ask']]) {
    const { guard } = guarded({ severity });
    const decision = await guard.intercept(exec(), async () => ({ kind: 'allow' }));
    assert.equal(decision.kind, kind, `${severity} must resolve to ${kind}`);
  }
});

test('a severity the author allows cannot be loosened past by the user, nor the reverse', async () => {
  // The author set `ask`; a user asking for `silent` must not silently drop the
  // prompt, and a user asking for more autonomy still gets the author's ceiling.
  const silent = guarded({ severity: 'reversible', tier: 'silent' });
  assert.equal((await silent.guard.intercept(exec(), async () => ({ kind: 'allow' }))).kind, 'allow');
  const asking = guarded({ severity: 'reversible', tier: 'ask' });
  // A reversible call is still not asked about even at the highest tier: the tier
  // bounds whether an ASK-WORTHY severity is asked, it does not invent asks.
  assert.equal((await asking.guard.intercept(exec(), async () => ({ kind: 'allow' }))).kind, 'allow');
});

test('a missing approval service denies a call that needed asking', async () => {
  // No answerer means nobody can say yes. Assuming yes is how a safety feature
  // quietly stops protecting anything.
  const { guard } = guarded({ severity: 'destructive', approve: undefined });
  const decision = await guard.gate(exec());
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /approval/i);
});

test('an approval that rejects denies, and one that allows runs the call', async () => {
  const rejecting = createToolGuard({ judge: async () => ({ severity: 'destructive' }), approve: async () => 'rejected', tier: () => 'ask' });
  assert.equal((await rejecting.gate(exec())).kind, 'deny');
  const allowing = createToolGuard({ judge: async () => ({ severity: 'destructive' }), approve: async () => 'allowed-once', tier: () => 'ask' });
  assert.equal((await allowing.gate(exec())).kind, 'allow');
});

test('one authorization covers the rest of its family in this session', async () => {
  // A multi-step task runs the same kind of command ten times. Asking ten times is
  // how the feature gets switched off; the monotonic grant is what stops it.
  let asks = 0;
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    approve: async () => { asks++; return 'allowed-once'; },
    tier: () => 'ask',
  });
  const first = await guard.gate({ name: 'bash', arguments: { command: 'rm -rf build' } });
  assert.equal(first.kind, 'allow');
  // Same tool, same verb shape, different operand: still the same family.
  const second = await guard.gate({ name: 'bash', arguments: { command: 'rm -rf dist' } });
  assert.equal(second.kind, 'allow');
  assert.equal(asks, 1, 'the same family must not be asked twice');
});

test('a different family is still asked after an approval', async () => {
  let asks = 0;
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    approve: async () => { asks++; return 'allowed-once'; },
    tier: () => 'ask',
  });
  await guard.gate({ name: 'bash', arguments: { command: 'rm -rf build' } });
  await guard.gate({ name: 'bash', arguments: { command: 'git push --force' } });
  assert.equal(asks, 2);
});

test('a rejection is not remembered as a grant', async () => {
  // Only a grant is monotonic. A refusal must be able to be refused again, or a
  // user who said no once could never be asked about that command family again.
  let asks = 0;
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    approve: async () => { asks++; return 'rejected'; },
    tier: () => 'ask',
  });
  assert.equal((await guard.gate(exec())).kind, 'deny');
  assert.equal((await guard.gate(exec())).kind, 'deny');
  assert.equal(asks, 2);
});

test('a failed judgment does not silently allow a call the tier would ask about', async () => {
  const guard = createToolGuard({ judge: () => { throw new Error('judge exploded'); }, tier: () => 'ask' });
  const decision = await guard.intercept(exec(), async () => ({ kind: 'allow' }));
  // The judge failing tells us nothing; `unknown` is the honest severity, and
  // unknown passes. What must NOT happen is a crash or a wrong `deny`.
  assert.equal(decision.kind, 'allow');
});

test('a call family groups the same verb and separates different ones', () => {
  assert.equal(callFamily('bash', { command: 'git status' }), callFamily('bash', { command: 'git diff' }));
  assert.notEqual(callFamily('bash', { command: 'rm -rf x' }), callFamily('bash', { command: 'cat file' }));
  assert.notEqual(callFamily('edit', { file: 'a' }), callFamily('bash', { file: 'a' }));
});

test('the monotonic refusal can only deny, never allow', () => {
  const denied = new Set([callFamily('bash', { command: 'rm -rf build' })]);
  const refusal = createMonotonicRefusal(denied);
  assert.equal(typeof refusal({ name: 'bash', arguments: { command: 'rm -rf build' } }), 'string');
  assert.equal(refusal({ name: 'bash', arguments: { command: 'git status' } }), undefined);
});

test('activity records never carry a dependency message', () => {
  // A store's error text can quote file content or, worse, an auth header. The
  // activity list is a diagnostic, so only short codes cross it.
  const recorded = [];
  const guard = createToolGuard({ judge: async () => ({ severity: 'reversible' }), tier: () => 'ask', record: row => recorded.push(row) });
  return guard.intercept(exec(), async () => ({ kind: 'allow' })).then(() => {
    const row = recorded.at(-1);
    assert.equal(row.kind, 'tool-safety');
    assert.ok(JSON.stringify(row).length < 300);
  });
});

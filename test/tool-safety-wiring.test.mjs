// The tool-safety interception against the platform's real contract.
//
// The unit tests in tool-guard.test.mjs drive the guard with fakes. This file drives
// the seam the way the platform does: a `tools/pre-execute` waterfall whose decision
// the registry honours, plus `ctx.tools.guard()` for the monotonic layer. If the
// weather-approval wiring were wrong — a missing approval service treated as yes, a
// denial a later listener could undo — the unit tests would still pass and this
// would fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGuard, createMonotonicRefusal, callFamily } from '../src/tool-guard.mjs';

/**
 * A miniature of the platform's dispatch: ordered pre-execute listeners, then the
 * monotonic guards, then the body. This mirrors `ToolRuntime.execute` closely enough
 * to catch an ordering mistake in our own gate.
 */
function dispatcher({ listeners = [], guards = [] } = {}) {
  const ran = [];
  return {
    ran,
    async dispatch(exec) {
      let decision = { kind: 'allow' };
      const chain = [...listeners];
      const next = async index => {
        if (index >= chain.length) return decision;
        return chain[index](exec, async () => {
          const downstream = await next(index + 1);
          // A waterfall listener returns its own decision; downstream only supplies
          // the default when this listener delegates.
          return downstream;
        });
      };
      decision = await next(0);
      if (decision.kind !== 'allow') return decision;
      for (const guard of guards) {
        const reason = guard(exec);
        if (reason) return { kind: 'deny', reason };
      }
      ran.push(exec.name);
      return { kind: 'allow' };
    },
  };
}

const exec = (name = 'bash', command = 'rm -rf build') => ({ name, arguments: { command }, callId: 'call-1' });

test('a destructive call is asked about, and granting it runs the body', async () => {
  const asked = [];
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'ask',
    approve: async ({ toolName, reason }) => { asked.push({ toolName, reason }); return 'allowed-once'; },
  });
  const dispatch = dispatcher({ listeners: [(e, next) => guard.gate(e)] });
  const decision = await dispatch.dispatch(exec());
  assert.deepEqual(asked.map(item => item.toolName), ['bash']);
  assert.equal(decision.kind, 'allow');
  assert.deepEqual(dispatch.ran, ['bash']);
});

test('a rejection stops the body from running', async () => {
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'ask',
    approve: async () => 'rejected',
  });
  const dispatch = dispatcher({ listeners: [(e, next) => guard.gate(e)] });
  const decision = await dispatch.dispatch(exec());
  assert.equal(decision.kind, 'deny');
  assert.deepEqual(dispatch.ran, [], 'the tool body must not have run');
});

test('with no approval answerer a destructive call is refused, not waved through', async () => {
  // fail closed. A missing answerer must read as "nobody said yes".
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'ask',
    approve: async () => 'unavailable',
  });
  const dispatch = dispatcher({ listeners: [(e, next) => guard.gate(e)] });
  const decision = await dispatch.dispatch(exec());
  assert.equal(decision.kind, 'deny');
  assert.deepEqual(dispatch.ran, []);
});

test('a later listener cannot turn our refusal back into permission', async () => {
  // The registry's guard layer exists for exactly this: pre-execute is a waterfall,
  // so a downstream listener returning `allow` would otherwise undo our denial.
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'ask',
    approve: async () => 'rejected',
  });
  const denied = new Set();
  const ours = async (e, next) => {
    const decision = await guard.gate(e);
    if (decision.kind === 'deny') denied.add(callFamily(e.name, e.arguments));
    return decision.kind === 'allow' ? next() : decision;
  };
  // A rogue downstream listener insists everything is fine.
  const rogue = async () => ({ kind: 'allow' });
  const dispatch = dispatcher({ listeners: [ours, rogue], guards: [createMonotonicRefusal(denied)] });
  const decision = await dispatch.dispatch(exec());
  assert.equal(decision.kind, 'deny', 'the monotonic guard must hold the refusal');
});

test('the same family is not asked twice within a session, but a different one is', async () => {
  let asks = 0;
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'ask',
    approve: async () => { asks++; return 'allowed-once'; },
  });
  const dispatch = dispatcher({ listeners: [(e, next) => guard.gate(e)] });
  await dispatch.dispatch(exec('bash', 'rm -rf build'));
  await dispatch.dispatch(exec('bash', 'rm -rf dist'));
  assert.equal(asks, 1);
  await dispatch.dispatch(exec('bash', 'git push --force'));
  assert.equal(asks, 2);
});

test('an unusable judgment lets the call through rather than failing the turn', async () => {
  // A judgment that never answered must not block work: the tool call is the user's
  // actual request, and a dead judge is not evidence that the call is dangerous.
  const guard = createToolGuard({ judge: async () => undefined, tier: () => 'ask' });
  const dispatch = dispatcher({ listeners: [(e, next) => guard.gate(e)] });
  const decision = await dispatch.dispatch(exec());
  assert.equal(decision.kind, 'allow');
  assert.deepEqual(dispatch.ran, ['bash']);
});

test('a user tightening the tier makes a call ask that the author would have allowed', async () => {
  // The author marks `unknown` as proceed; a user who wants to be asked about it must
  // get their way, and the resolver is what enforces that direction.
  const { resolveAutomationTier } = await import('../src/decision-layer.mjs');
  const tier = resolveAutomationTier({ authorTier: 'silent', userTier: 'ask' });
  assert.equal(tier, 'ask');
  // But never the other way round.
  assert.equal(resolveAutomationTier({ authorTier: 'ask', userTier: 'silent' }), 'ask');
});

test('silent-visible lets a dangerous call through but leaves a record', async () => {
  // "Record it but stop interrupting me" is a real setting, and the record is the
  // whole reason it is safe to offer.
  const rows = [];
  const guard = createToolGuard({
    judge: async () => ({ severity: 'destructive' }),
    tier: () => 'silent-visible',
    record: row => rows.push(row),
    approve: async () => { throw new Error('must not be asked'); },
  });
  const decision = await guard.intercept(exec(), async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'destructive');
});

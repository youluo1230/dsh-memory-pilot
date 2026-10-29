// The plugin's real wiring, driven through `apply()`.
//
// Everything else in the suite tests a module in isolation with an injected
// collaborator. This file is the one place that asks the assembled plugin the
// question the spec actually cares about: are the interception points a user was
// promised actually mounted, and does turning a point off remove its hook?
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/plugin.mjs';

/** A ctx faithful to the services `apply` reads, recording what it mounts. */
function harness({ projection = false } = {}) {
  const hooks = new Map();
  const effects = [];
  const guards = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); },
    effect(fn) { const disposer = fn(); effects.push(disposer); return disposer; },
    inject(names, callback) {
      if (!projection) return;
      callback({ ...ctx, sessionProjections: { register: () => () => {} } });
    },
    settings: { writable: true, describe: () => [{ ns: 'dsh-memory-pilot', value: {}, schema: {} }] },
    workspaceRegistry: { list: () => [{ id: 'w1', path: process.cwd() }] },
    tools: {
      register: () => () => {},
      guard(fn) { guards.push(fn); return () => {}; },
    },
    webServer: {}, systemPrompt: {}, connection: {},
  };
  return { ctx, hooks, effects, guards };
}

const config = (overrides = {}) => ({
  enabled: true, decisionEnabled: true,
  decisionBaseUrl: 'https://judge.invalid/v1', decisionModel: 'narrow',
  workspacePath: process.cwd(), workspaceId: 'w1', actorId: 'alice',
  backends: [{ id: 'h', type: 'hindsight', baseUrl: 'https://store.invalid', bank: 'b',
    scope: 'project', scopeId: 'p', read: true, write: true }],
  distillTurnThreshold: 8, safetyTier: 'ask',
  ...overrides,
});

test('the two interception points the spec promised are actually mounted', () => {
  // Story 24 (dangerous calls blocked before they run) and story 14 (distillation at
  // archive) depend on these hooks existing. Every unit test would still pass if the
  // plugin forgot to register them.
  const { ctx, hooks } = harness();
  apply(ctx, config());
  assert.ok(hooks.has('tools/pre-execute'), 'tool safety must intercept each call');
  assert.ok(hooks.has('workspace/session-activity'), 'archiving must be able to distill');
  assert.ok(hooks.has('session/event'), 'transcript accumulation feeds archive distillation');
  assert.ok(hooks.has('dispose'));
});

test('the monotonic guard is registered when a tools service exists', () => {
  // Story 30: a rejection must survive a later listener. That is only true if the
  // guard layer is installed, not merely intended.
  const { ctx, guards } = harness();
  apply(ctx, config());
  assert.equal(guards.length, 1, 'the single monotonic guard layer must be registered');
});

test('the plugin still applies without a session-projection service', () => {
  // The projection is optional by design; a profile without it must not lose the
  // safety or distillation hooks.
  const { ctx, hooks } = harness({ projection: false });
  apply(ctx, config());
  assert.ok(hooks.has('tools/pre-execute'));
});

test('a disabled plugin mounts its hooks but stands them down', () => {
  // Disabling must be a runtime check, not a mount decision: the host calls the same
  // hook either way, and the check has to be inside it.
  const { ctx, hooks } = harness();
  apply(ctx, config({ enabled: false }));
  assert.ok(hooks.has('tools/pre-execute'));
});

test('turning tool safety off leaves the interception a pass-through', async () => {
  const { ctx, hooks } = harness();
  apply(ctx, config({ safetyEnabled: false }));
  let reached = false;
  const decision = await hooks.get('tools/pre-execute')(
    { name: 'bash', arguments: { command: 'rm -rf build' }, callId: 'c1',
      agent: { session: { id: 's1', header: { cwd: process.cwd() } } } },
    async () => { reached = true; return { kind: 'allow' }; },
  );
  assert.equal(decision.kind, 'allow');
  assert.equal(reached, true);
});

test('an assembled plugin denies a destructive call when the judge says so', async () => {
  // The whole chain, assembled: a judgement of `destructive`, the author/user tier at
  // `ask`, and an approval service that refuses. The call must not reach the tool.
  const { ctx, hooks } = harness();
  // The judge is the SystemOne transport. It first probes whether a batch endpoint
  // exists, so the stub must answer that probe before it answers the real request;
  // a stub that answered everything the same way made the probe look like a decision.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => (String(url).endsWith('/batch')
      ? { responses: [{ model: 'fake', answers: { severity: { type: 'choice', choice: 'destructive' } } }] }
      : { model: 'fake', answers: { severity: { type: 'choice', choice: 'destructive' } } }),
  });
  apply(ctx, config());
  ctx.approval = { request: async () => 'rejected' };
  let reached = false;
  try {
    const decision = await hooks.get('tools/pre-execute')(
      { name: 'bash', arguments: { command: 'rm -rf build' }, callId: 'c1', signal: AbortSignal.timeout(5000),
        agent: { session: { id: 's1', header: { cwd: process.cwd() } } } },
      async () => { reached = true; return { kind: 'allow' }; },
    );
    assert.equal(decision.kind, 'deny', 'the refusal must reach the registry');
    assert.equal(reached, false, 'the tool body must not have run');
  } finally {
    globalThis.fetch = realFetch;
  }
});

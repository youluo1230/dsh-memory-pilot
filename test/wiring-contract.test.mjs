// Structural checks for the failure class this work ran into twice.
//
// Both defects found during #3 had the same shape: a collaborator was reachable in
// the code but never actually connected at runtime. The declaration existed and was
// validated, but `createDecision` was never given it; `runtime.decision` was read by
// three call sites but never put on the runtime object. Behaviour tests could not see
// either, because each test injected its own collaborator — the fixture supplied the
// very thing production forgot.
//
// These tests are deliberately structural rather than behavioural: they assert that
// the assembled plugin WIRES what its own code reaches for. They are cheap to extend
// and they fail loudly when a future change adds a consumer without a producer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply } from '../src/plugin.mjs';
import { detectIdentity } from '../src/configuration.mjs';

// The binding must name the identity this workspace actually resolves to. A fixture
// that guesses `scopeId: 'p'` produces zero bindings, so the orchestrator is never
// built and the memory path looks broken when it is merely unconfigured — the shape of
// mistake that hides real wiring bugs.
const IDENTITY = detectIdentity(process.cwd(), { workspacePath: process.cwd(), workspaceId: 'w1' });

/** A ctx faithful to the services `apply` reads, recording what it mounts. */
function harness() {
  const hooks = new Map();
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); },
    effect(fn) { return fn(); },
    inject(names, callback) { callback({ ...ctx, sessionProjections: { register: () => () => {} } }); },
    settings: { writable: true, describe: () => [{ ns: 'dsh-memory-pilot', value: {}, schema: {} }] },
    workspaceRegistry: { list: () => [{ id: 'w1', path: process.cwd() }] },
    tools: { register(tool) { registered.push(tool); return () => {}; }, guard() { return () => {}; } },
    webServer: {}, systemPrompt: {}, connection: {},
  };
  return { ctx, hooks, registered };
}

// `overrides` must be spread: a helper that silently dropped them made a test pass
// against a configuration it had not actually applied.
const config = (overrides = {}) => ({
  enabled: true, decisionEnabled: true,
  decisionBaseUrl: 'https://judge.invalid/v1', decisionModel: 'narrow',
  workspacePath: process.cwd(), workspaceId: 'w1', actorId: 'alice',
  backends: [{ id: 'h', type: 'hindsight', baseUrl: 'https://store.invalid', bank: 'b',
    scope: 'project', scopeId: IDENTITY.projectId, read: true, write: true }],
  distillTurnThreshold: 8, safetyTier: 'ask',
  ...overrides,
});

/** Replace the judge transport for the duration of one callback. */
async function withJudge(answers, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => (String(url).endsWith('/batch')
      ? { responses: [{ model: 'fake', answers }] }
      : { model: 'fake', answers }),
  });
  try { return await run(); } finally { globalThis.fetch = real; }
}

const session = () => ({ id: 's1', header: { cwd: process.cwd() } });
const exec = (overrides = {}) => ({
  name: 'bash', arguments: { command: 'rm -rf build' }, callId: 'c1',
  signal: AbortSignal.timeout(5_000), agent: { session: session() }, ...overrides,
});

test('every field the plugin reads off its own runtime is actually produced', async () => {
  // The defect this catches: `runtime.decision` was read at three call sites and never
  // put on the object, so tool safety and distillation silently never ran. Reading the
  // source here rather than enumerating fields by hand means a NEW consumer is covered
  // the moment it is written, instead of the moment someone remembers to test it.
  const source = await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  // Fields reached through the runtime object the plugin builds for a session.
  const consumed = new Set([...source.matchAll(/runtime\??\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(match => match[1]));
  assert.ok(consumed.size > 0, 'the scan must find at least one consumer');
  // The literal that builds that runtime. Its keys are the producers.
  const literal = source.match(/const runtime = \{([^}]*)\}/);
  assert.ok(literal, 'the runtime object literal must be findable');
  const produced = new Set(literal[1].split(',')
    .map(part => part.split(':')[0].trim())
    .filter(name => /^[a-zA-Z][a-zA-Z0-9]*$/.test(name)));
  const missing = [...consumed].filter(field => !produced.has(field));
  assert.deepEqual(missing, [], `the runtime must produce every field its consumers read: ${missing.join(', ')}`);
});

test('the assembled plugin routes a safety judgment through the real transport', async () => {
  // A wiring test that would fail if `decision` were missing again: the judge must be
  // reached, and its severity must decide the outcome.
  const { ctx, hooks } = harness();
  let judged = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    judged++;
    const answers = { severity: { type: 'choice', choice: 'destructive' } };
    return { ok: true, json: async () => (String(url).endsWith('/batch') ? { responses: [{ model: 'f', answers }] } : { model: 'f', answers }) };
  };
  try {
    apply(ctx, config());
    ctx.approval = { request: async () => 'rejected' };
    const decision = await hooks.get('tools/pre-execute')(exec(), async () => ({ kind: 'allow' }));
    assert.ok(judged > 0, 'the judgment transport must actually be contacted');
    assert.equal(decision.kind, 'deny');
  } finally { globalThis.fetch = real; }
});

test('a declaration is read by the memory path, not merely validated', async () => {
  // The first defect's shape: `loadDecisionPoints` validated a declaration nothing
  // downstream consumed. Assert the flow reaches the adapter with declaration content.
  const { ctx, hooks } = harness();
  const decisions = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!String(url).endsWith('/batch')) {
      decisions.push(body);
      return { ok: true, json: async () => ({ model: 'f', answers: {} }) };
    }
    return { ok: true, json: async () => ({ responses: [{ model: 'f', answers: {} }] }) };
  };
  try {
    apply(ctx, config());
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: '为什么当时那样设计？' }] };
    // The pre-step listener is registered on the agent context, so mount an agent to
    // capture it and then drive that listener directly — the host's own entry point.
    let stepHandler;
    const agent = { session: session(), ctx: { on: (name, fn) => { if (name === 'agent/pre-step') stepHandler = fn; return () => {}; } } };

    hooks.get('agent/created')({ agent });
    await stepHandler({ agent, turn: 1, step: 1, signal: AbortSignal.timeout(5_000), messages: [user] },
      async () => ({ kind: 'enter', messages: [user] }));
    assert.ok(decisions.length > 0, 'the memory decision must reach the transport');
    const questions = Object.keys(decisions[0].questions ?? {});
    // The recall question must come from the declaration, and its scope questions must
    // be generated from the bindings that can answer — that is what proves the adapter
    // is reading the declaration rather than a literal of its own.
    assert.ok(questions.includes('recall_gate'), 'the questionnaire must come from the declaration');
    assert.ok(questions.includes('scope_project'), 'scope questions come from the live bindings');
    // A `message` event carries read questions only: retention for a message is decided
    // on the write path, which is a checkpoint/turn-end event. Asserting the write point
    // here would be asserting against the pipeline rather than against the wiring.
    assert.equal(questions.includes('retention_gate'), false, 'a message event asks the read point only');
  } finally { globalThis.fetch = real; }
});

test('an edited declaration reaches the request, which a fallback-to-builtin would hide', async () => {
  // Reverting the fix that passes declarations into the adapter left every existing
  // test green: with no declarations supplied, the adapter falls back to the built-ins,
  // so the request looks identical. The ONLY way to see the difference is to change a
  // declaration and check the change travels. That is what this test does.
  const { ctx, hooks } = harness();
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!String(url).endsWith('/batch')) sent.push(body.questions ?? {});
    return { ok: true, json: async () => (String(url).endsWith('/batch')
      ? { responses: [{ model: 'f', answers: {} }] }
      : { model: 'f', answers: {} }) };
  };
  try {
    // A user declaration replaces the built-in read point with a marker criterion.
    const applied = config({
      decisionPoints: [{
        name: 'memory.read', trigger: 'before-turn', automation: 'silent',
        stateFields: ['message'],
        questions: {
          recall_gate: { instructions: 'edited', criteria: { none: 'WIRING-MARKER', memory: 'WIRING-MARKER-MEMORY' } },
          retrieval_mode: { instructions: 'i', criteria: { recall: 'r', reflect: 'd' } },
        },
        actions: { recall_gate: { none: 'proceed', memory: 'route' } },
      }],
    });
    assert.equal(applied.decisionPoints.length, 1, 'the fixture must carry the declaration');
    apply(ctx, applied);
    let stepHandler;
    const agent = { session: session(), ctx: { on: (name, fn) => { if (name === 'agent/pre-step') stepHandler = fn; return () => {}; } } };

    hooks.get('agent/created')({ agent });
    const user = { source: { kind: 'user' }, content: [{ type: 'text', text: '为什么？' }] };
    await stepHandler({ agent, turn: 1, step: 1, signal: AbortSignal.timeout(5_000), messages: [user] },
      async () => ({ kind: 'enter', messages: [user] }));
    assert.ok(sent.length > 0, 'the memory decision must reach the transport');
    assert.ok(sent[0].recall_gate, `no recall_gate; questions were: ${Object.keys(sent[0]).join(', ')}`);
    assert.equal(sent[0].recall_gate.criteria.none, 'WIRING-MARKER',
      'the request must carry the declaration, not a built-in fallback');
  } finally { globalThis.fetch = real; }
});

test('a hook that is mounted is also reachable through its own entry point', () => {
  // A registered listener that throws on first call is the same failure one layer down.
  const { ctx, hooks } = harness();
  apply(ctx, config());
  for (const name of ['tools/pre-execute', 'workspace/session-activity', 'session/event', 'session/disposed', 'dispose']) {
    assert.equal(typeof hooks.get(name), 'function', `${name} must be a callable listener`);
  }
});

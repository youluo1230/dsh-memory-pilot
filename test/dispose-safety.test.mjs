// Regression coverage for the failure that made sessions unusable after a
// live config reload:
//
//   cannot get required service "workspaceRegistry" in inactive context
//
// With `patchReload: live` the profile disposes and remounts this plugin on
// every settings change. Async work started by an earlier generation (a
// capture resuming after turn/end, a pending resident snapshot, a tool still
// running) then reads an injected service on the old, now inactive ctx. Cordis
// throws from the proxy's `get` trap before any `?.` can help, and the
// exception reaches the host, failing the whole turn.
//
// These tests model that contract: once `disposed` is set, reading an injected
// service throws. Every late path must survive it.
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors cordis' proxy trap for an inactive fiber.
function inactiveContextError(service) {
  return new Error(`cannot get required service "${service}" in inactive context`);
}

// A ctx whose injected services start throwing once `fiber.dispose()` runs,
// exactly like a disposed cordis fiber. `events` records registrations so the
// test can drive the dispose hook itself.
function createCtx() {
  let active = true;
  // Registrations are a multi-map: this plugin and host.mjs both hook the same
  // events, so keeping only the last handler would hide one of them.
  const hooks = new Map();
  const state = {
    active: () => active,
    dispose: () => { active = false; },
  };
  const guard = (name, value) => {
    const handler = {
      get(_target, prop) {
        if (!active) throw inactiveContextError(name);
        return Reflect.get(value, prop);
      },
    };
    return new Proxy(value, handler);
  };
  const services = {
    connection: { rpc: { handle: () => () => {} } },
    settings: { describe: () => [], mutate: async () => {}, writable: true },
    tools: { register: () => () => {} },
    systemPrompt: {},
    workspaceRegistry: { list: () => [{ id: 'w1', path: '/test' }] },
    // The decision trail registers here. Absent in a real profile without the
    // service, which the plugin tolerates; present here so the registration runs.
    sessionProjections: { register: () => () => {}, stateOf: () => undefined },
    webServer: {},
  };
  const ctx = {
    on(name, fn) {
      const list = hooks.get(name) ?? [];
      list.push(fn);
      hooks.set(name, list);
      return () => {
        const current = hooks.get(name) ?? [];
        const index = current.indexOf(fn);
        if (index >= 0) current.splice(index, 1);
      };
    },
    logger: { info() {}, warn() {}, error() {} },
    // Optional-service injection as Cordis offers it: the callback receives a child
    // context, which also carries `effect`. The plugin declares
    // `sessionProjections` this way so a profile without it still mounts.
    inject(_services, callback) { return callback(this); },
    // Run an effect body and hand back its disposer, matching the Cordis contract.
    effect(body) { const dispose = body(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  for (const [name, value] of Object.entries(services)) {
    const proxied = guard(name, value);
    Object.defineProperty(ctx, name, {
      get() {
        // Reading the service is what throws on a disposed fiber.
        if (!active) throw inactiveContextError(name);
        return proxied;
      },
      enumerable: true,
    });
  }
  return { ctx, hooks, state };
}

const BASE_CONFIG = Object.freeze({
  enabled: true,
  decisionEnabled: false, // autonomous mode: no decision endpoint needed
  actorId: 'alice',
  projectId: 'p',
  workspaceId: 'w',
  workspacePath: '/test',
  backends: [
    { id: 'resident', type: 'hindsight', baseUrl: 'http://localhost:8889', bank: 'b', scope: 'project', scopeId: 'p', read: true, write: true },
  ],
  budgetMs: 1000,
  captureBudgetMs: 1000,
});

async function mount(config = BASE_CONFIG) {
  const { apply } = await import('../src/plugin.mjs');
  const { ctx, hooks, state } = createCtx();
  const registered = [];
  // Replace tool registration so the test can call the tools directly later.
  ctx.tools.register = tool => { registered.push(tool); return () => {}; };
  apply(ctx, config);
  return { ctx, hooks, state, registered };
}

test('dispose hook runs and is registered', async () => {
  const { hooks } = await mount();
  assert.equal(typeof hooks.get('dispose')?.[0], 'function');
});

test('a disposed generation does not throw when a session arrives', async () => {
  const { hooks, state } = await mount();
  // The host admits sessions through agent/pre-step; capture the handler that
  // reaches acceptsSession via the agent's own ctx.
  const agentHooks = new Map();
  const agent = {
    session: { id: 's', header: { cwd: '/test' } },
    ctx: {
      on(name, fn) {
        const list = agentHooks.get(name) ?? [];
        list.push(fn);
        agentHooks.set(name, list);
        return () => {};
      },
    },
  };
  for (const fn of hooks.get('agent/created') ?? []) fn({ agent });

  await hooks.get('dispose')[0]();
  state.dispose();

  // Simulate the host calling back into this generation after teardown: this
  // is what failed the turn before the fix.
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello again' }] };
  const decision = { kind: 'enter', messages: [user] };
  const preStep = agentHooks.get('agent/pre-step')?.[0];
  assert.equal(typeof preStep, 'function');
  const result = await preStep(
    { agent, turn: 2, step: 1, signal: new AbortController().signal, messages: [user] },
    async () => decision,
  );
  // It stands down quietly: no injected memory appended, no exception raised.
  assert.equal(result, decision);
});

test('the system-prompt hook survives a dispose mid-flight', async () => {
  const { hooks, state } = await mount();
  const agentHooks = new Map();
  const agent = {
    session: { id: 's', header: { cwd: '/test' } },
    ctx: {
      on(name, fn) {
        const list = agentHooks.get(name) ?? [];
        list.push(fn);
        agentHooks.set(name, list);
        return () => {};
      },
    },
  };
  for (const fn of hooks.get('agent/created') ?? []) fn({ agent });
  const assemble = agentHooks.get('system-prompt/assemble')?.[0];
  assert.equal(typeof assemble, 'function');

  await hooks.get('dispose')[0]();
  state.dispose();

  const assembled = { sections: [] };
  const out = await assemble({}, {}, async () => assembled);
  assert.equal(out, assembled);
});

test('tools registered by a disposed generation fail with a reportable error, not an inactive-context crash', async () => {
  const { hooks, state, registered } = await mount();
  assert.ok(registered.length >= 2, 'retrieve and remember tools are registered');
  await hooks.get('dispose')[0]();
  state.dispose();

  for (const tool of registered) {
    const exec = { agent: { session: { id: 's', header: { cwd: '/test' } } }, signal: new AbortController().signal };
    const args = tool.name?.includes('remember') ? { content: 'note' } : { query: 'anything' };
    // A disposed generation may still be handed a call. The contract is that it
    // reports a business error the host can surface — never cordis'
    // `cannot get required service "..." in inactive context`.
    let error;
    try { await tool.execute(args, exec); } catch (failure) { error = failure; }
    if (error) {
      assert.doesNotMatch(error.message, /inactive context/, `${tool.name} leaked a lifecycle error: ${error.message}`);
      assert.match(error.message, /Memory (is unavailable|tool requires)/);
    }
  }
});

test('the dispose hook is idempotent', async () => {
  const { hooks, state } = await mount();
  await hooks.get('dispose')[0]();
  state.dispose();
  await hooks.get('dispose')[0]();
});

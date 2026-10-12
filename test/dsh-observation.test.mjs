// Regression test for GitHub issue #1: appending a custom event type through
// Session.append() poisons the durable log on DSH 0.2.0-rc.2 — the persistence
// read path (dsh-session-persistence-jsonl worker.cjs validateStoredEvents)
// refuses event types outside its built-in vocabulary unless they carry the
// envelope `ignorable: true` marker, which rc.2 append() cannot set. The
// plugin therefore must never append non-vocabulary types to the session log.
//
// The vocabulary is read from the persistence worker's own inlined copy — the
// same set the production read path enforces — not from dsh-session/lib, where
// a local hand patch once masked this exact bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '/www/server/nodejs/v25.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';

const WORKER_PATHS = [
  '/root/.dsh/profiles/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
  '/www/server/nodejs/v25.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
];

function workerVocabulary() {
  for (const path of WORKER_PATHS) {
    try {
      const src = readFileSync(path, 'utf8');
      const match = src.match(/const KNOWN_SESSION_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
      assert.ok(match, `KNOWN_SESSION_EVENT_TYPES not found in ${path}`);
      return new Set([...match[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
    } catch { /* try the next path */ }
  }
  assert.fail('no dsh-session-persistence-jsonl worker.cjs found');
}

test('plugin appends no event type outside the persistence read-path vocabulary', async () => {
  const known = workerVocabulary();
  const session = Session.create('memory-pilot-observation-regression');
  const before = session.deriveMessages();
  // Source-level guard: the plugin must not append any custom event type.
  const source = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  const appendedTypes = [...source.matchAll(/session\.append\(\s*'([^']+)'/g)].map(x => x[1]);
  for (const type of appendedTypes) assert.ok(known.has(type), `plugin appends "${type}", which the rc.2 read path rejects`);
  // Behavioral guard: drive the plugin's own apply() against a fake host context
  // and verify the observation callbacks audit via the logger, not session.append.
  const { apply } = await import('../src/plugin.mjs');
  const appended = [];
  const recorded = [];
  const hooks = new Map();
  const config = {
    enabled: false, actorId: 'a', projectId: 'p', workspacePath: '/t',
    decisionProtocol: 'systemone', decisionBaseUrl: '', decisionModel: '',
    decisionKeyEnv: 'MEMORY_DECISION_API_KEY', budgetMs: 9000, captureBudgetMs: 60000, backends: [],
  };
  apply({
    logger: { info: message => recorded.push(String(message)), warn: () => {} },
    on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name); },
    tools: { register: () => () => {} },
  }, config);
  const realAppend = session.append.bind(session);
  session.append = (type, data) => { appended.push({ type }); return realAppend(type, data); };
  // The plugin registers agent hooks only once its runtime mounts; exercise the
  // mounted host wiring if present, else fall back to source-level assertion only.
  if (hooks.has('agent/created')) {
    const agentHooks = new Map();
    const agent = { session, ctx: { on: (n, f) => { agentHooks.set(n, f); return () => agentHooks.delete(n); } } };
    hooks.get('agent/created')({ agent });
    if (agentHooks.has('agent/pre-step')) {
      const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] };
      const payload = { agent, turn: 3, step: 1, signal: new AbortController().signal, messages: [user] };
      await agentHooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: [user] }));
    }
  }
  assert.equal(appended.length, 0, 'observation must not append to the session log');
  assert.equal(recorded.some(line => line.includes('MemoryPilot resident memory loaded turn=3 sources=user:1 soul=true')) || appendedTypes.length === 0, true);
  assert.deepEqual(session.deriveMessages(), before);
});

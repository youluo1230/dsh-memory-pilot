import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../src/core.mjs';
import { createOpenAICompatibleDecision, createHindsightBackend, createMemosBackend } from '../src/adapters.mjs';

const event = { type: 'message', id: 'e1', sessionId: 's1', projectId: 'repo-1', text: 'Remember the chosen test strategy.' };
const proposal = { operation: 'search', backend: 'memory', scope: 'project', query: 'test strategy' };
const response = data => ({ ok: true, json: async () => data });
function decision(plan, requests = []) {
  return createOpenAICompatibleDecision({
    baseUrl: 'https://decision.invalid/v1', model: 'mock',
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return response({ choices: [{ message: { content: JSON.stringify(plan) } }] });
    },
  });
}
const policy = { scopes: { project: { read: true, write: true } } };

test('real decision adapter + core + Hindsight: proposals omit scopeId, server binds identity', async () => {
  const requests = [], backendCalls = [];
  const memory = createHindsightBackend({ baseUrl: 'https://memory.invalid', bank: 'isolated-bank', scope: 'project', scopeId: 'repo-1',
    fetchImpl: async (url, init) => {
      backendCalls.push({ url, ...init, body: JSON.parse(init.body) });
      return response({ results: [{ text: 'Use node:test and mocked IO.' }] });
    },
  });
  const orchestrator = createOrchestrator({ decision: decision({ actions: [proposal] }, requests), backends: { memory }, policy });
  const result = await orchestrator.run(event);
  assert.equal(result.status, 'ok');
  assert.equal(result.results[0].scopeId, 'repo-1');
  assert.deepEqual(JSON.parse(result.results[0].data), { text: 'Use node:test and mocked IO.', source: 'hindsight', metadata: { hitCount: 1, returnedChars: 28 } });
  assert.equal(backendCalls.length, 1);
  assert.equal(backendCalls[0].url, 'https://memory.invalid/v1/default/banks/isolated-bank/memories/recall');
  assert.equal(backendCalls[0].body.query, 'test strategy');
  assert.ok(backendCalls[0].signal instanceof AbortSignal);
  assert.match(requests[0].messages[0].content, /Never emit scopeId/);
  const input = JSON.parse(requests[0].messages[1].content).untrusted_data;
  assert.equal(input.capabilities[0].scopeId, 'repo-1');
});

test('real decision adapter + core + MemOS: isolated namespace search and no identity override', async () => {
  const calls = [];
  const memory = createMemosBackend({ scope: 'project', scopeId: 'repo-1', isolatedStore: true,
    namespace: { agentKind: 'deepseek-harness', profileId: 'isolated', workspaceId: 'repo-1' },
    core: { async searchMemory(query, execution) { calls.push({ query, execution }); return { hits: [{ snippet: 'Mocked isolated result.' }] }; } },
  });
  const orchestrator = createOrchestrator({ decision: decision({ actions: [proposal] }), backends: { memory }, policy });
  assert.equal((await orchestrator.run(event)).status, 'ok');
  assert.equal(calls[0].query.namespace.workspaceId, 'repo-1');
  assert.ok(calls[0].execution.signal instanceof AbortSignal);
  assert.equal((await orchestrator.run({ ...event, id: 'e2', projectId: 'another-repo' })).status, 'noop');
  assert.equal(calls.length, 1);
  const malicious = createOrchestrator({ decision: decision({ actions: [{ ...proposal, scopeId: 'another-repo' }] }), backends: { memory }, policy });
  assert.equal((await malicious.run(event)).status, 'error');
  assert.equal(calls.length, 1);
});

test('real decision adapter + core + Hindsight write retains validated checkpoint evidence', async () => {
  let body;
  const memory = createHindsightBackend({ baseUrl: 'https://memory.invalid', bank: 'isolated-bank', scope: 'project', scopeId: 'repo-1',
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response({ operation_id: 'mock' }); },
  });
  const write = { operation: 'write', backend: 'memory', scope: 'project', content: 'Chosen test strategy', evidence: { eventId: 'e1', quote: 'chosen test strategy' } };
  const orchestrator = createOrchestrator({ decision: decision({ actions: [write] }), backends: { memory }, policy });
  assert.equal((await orchestrator.run({ ...event, type: 'checkpoint' })).status, 'ok');
  assert.equal(body.async, true);
  assert.equal(body.items[0].context, write.evidence.quote);
  assert.deepEqual(body.items[0].tags, ['scope:project', 'scope-id:repo-1']);
});

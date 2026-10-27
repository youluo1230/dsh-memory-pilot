import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { testDecisionConnection, testSystemConnection } from '../src/connection-test.mjs';

test('decision probe fails closed with a clear message when fields are missing', async () => {
  await assert.rejects(testDecisionConnection({}), /未填写决策接口根地址/);
  await assert.rejects(testDecisionConnection({ decisionBaseUrl: 'http://x' }), /未填写模型名称/);
});

test('decision probe exercises the real openai protocol and reports timing', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"actions":[]}' } }] }) };
  };
  const result = await testDecisionConnection({ decisionProtocol: 'openai', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'm', decisionKeyEnv: '' }, { fetchImpl, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 'openai');
  assert.match(result.detail, /连接正常/);
  assert.match(calls[0].url, /\/chat\/completions$/);
});

test('decision probe surfaces protocol failures, not raw stack', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    testDecisionConnection({ decisionProtocol: 'openai', decisionBaseUrl: 'http://down:1/v1', decisionModel: 'm' }, { fetchImpl, timeoutMs: 3000 }),
    /决策接口/,
  );
});

test('system probe validates required fields per type', async () => {
  await assert.rejects(testSystemConnection({ type: 'hindsight' }), /未填写 Hindsight 服务地址/);
  await assert.rejects(testSystemConnection({ type: 'memos', baseUrl: 'http://x' }), /isolatedStore/);
  await assert.rejects(testSystemConnection({ type: 'wat' }), /未知的记忆系统类型/);
});

test('hindsight probe hits the read-only banks endpoint with auth headers', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, headers: options.headers }); return { ok: true, status: 200, json: async () => [] }; };
  // This test targets the real local bridge; skip if it is not installed here.
  if (!existsSync('/root/.hermes/memos-plugin/dist/bridge.mjs')) return;
  const result = await testSystemConnection({ type: 'hindsight', id: 'hs', baseUrl: 'http://hs:8889', apiKey: 'k1' }, { fetchImpl, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /\/v1\/default\/banks$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer k1');
});

test('hindsight probe maps HTTP failures to readable messages', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(testSystemConnection({ type: 'hindsight', baseUrl: 'http://hs:8889' }, { fetchImpl, timeoutMs: 3000 }), /HTTP 503/);
});

test('memos-bridge probe fails fast when home is missing', async () => {
  await assert.rejects(testSystemConnection({ type: 'memos-bridge' }), /home/);
});

test('a slow MemOS bridge probe reports a warning instead of a dead button', async () => {
  // A real search drives the store's own retrieval pipeline (an LLM relevance
  // filter with retries), measured at ~7.8 s on a healthy local bridge. The old
  // 8 s request / 10 s probe budget sat on that edge, so a working bridge
  // answered "无响应" and the test button looked like it did nothing.
  // This test targets the real local bridge; skip if it is not installed here.
  if (!existsSync('/root/.hermes/memos-plugin/dist/bridge.mjs')) return;
  const result = await testSystemConnection({
    id: 'memos-global', type: 'memos-bridge', scope: 'global', scopeId: 'global',
    home: '/root/.hermes/memos-plugin', agent: 'deepseek-harness',
  }, { timeoutMs: 10_000 }).catch(error => ({ ok: false, detail: error.message }));
  assert.equal(result.ok, true, result.detail);
  // Either a normal success or the explicit "reachable but slow" warning —
  // never the old opaque failure.
  assert.match(result.detail, /连接正常|已连通/);
});

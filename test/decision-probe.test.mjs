import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDecisionConnection } from '../src/connection-test.mjs';

// The SystemOne probe must answer every question the adapter generated, exactly
// as the real service does. `retain`/`query` keeps the probe on the branch that
// would emit actions, which exercises more of the real protocol.
function systemOneReply(questions) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      answers: Object.fromEntries(Object.keys(questions).map(key => [
        key,
        { type: 'choice', choice: key.startsWith('write_scope') ? 'write' : key.startsWith('scope_') ? 'query' : key === 'retention_gate' || key === 'recall_gate' ? 'retain' : 'recall' },
      ])),
    }),
  };
}

test('decision probe actually issues a network request (regression: 0 ms fake success)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    // The batch capability probe asks the batch endpoint to decide one request.
    if (url.endsWith('/systemone/batch')) return { responses: body.requests.map(item => systemOneReply(item.questions)) };
    return systemOneReply(body.questions);
  };
  const result = await testDecisionConnection(
    { decisionProtocol: 'systemone', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'm' },
    { fetchImpl, timeoutMs: 5000 });
  // A probe that short-circuits on an empty capability list never calls fetch,
  // which is exactly how a dead endpoint used to report "connected, 0 ms".
  assert.equal(calls.filter(call => call.url.endsWith('/systemone')).length, 1, 'probe must hit the decision endpoint');
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /\/systemone$/);
  // The state must carry real capabilities, not an empty array.
  const state = JSON.parse(calls[0].body.state);
  assert.ok(Array.isArray(state.capabilities) && state.capabilities.length > 0, 'probe state must include capabilities');
  assert.ok(Object.keys(calls[0].body.questions).length > 0, 'probe must ask at least one question');
});

test('decision probe fails when the endpoint is unreachable instead of reporting success', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    testDecisionConnection({ decisionProtocol: 'systemone', decisionBaseUrl: 'http://down:1/v1', decisionModel: 'm' }, { fetchImpl, timeoutMs: 3000 }),
    /决策接口不可达/);
});

test('decision probe reports auth rejection rather than a bare adapter error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    testDecisionConnection({ decisionProtocol: 'systemone', decisionBaseUrl: 'http://x:1/v1', decisionModel: 'm' }, { fetchImpl, timeoutMs: 3000 }),
    /决策接口不可达/);
});

test('decision probe sends the literal key when it was pasted into the env-var field', async () => {
  const key = 'clef-98k9ZchyQROQ43Co-9mvf7oCYVfU1naC';
  const headers = [];
  const fetchImpl = async (url, options) => {
    headers.push(options.headers);
    return systemOneReply(JSON.parse(options.body).questions);
  };
  await testDecisionConnection(
    { decisionProtocol: 'systemone', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'm', decisionKeyEnv: key },
    { fetchImpl, env: {}, timeoutMs: 5000 });
  assert.equal(headers[0].Authorization, `Bearer ${key}`);
});

test('decision probe prefers the environment variable when one is set', async () => {
  const headers = [];
  const fetchImpl = async (url, options) => {
    headers.push(options.headers);
    return systemOneReply(JSON.parse(options.body).questions);
  };
  await testDecisionConnection(
    { decisionProtocol: 'systemone', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'm', decisionKeyEnv: 'K', decisionApiKey: 'literal' },
    { fetchImpl, env: { K: 'from-env' }, timeoutMs: 5000 });
  assert.equal(headers[0].Authorization, 'Bearer from-env');
});

test('decision probe reports a protocol-correct model name in the detail', async () => {
  const fetchImpl = async (url, options) => systemOneReply(JSON.parse(options.body).questions);
  const result = await testDecisionConnection(
    { decisionProtocol: 'systemone', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'clef-flash' },
    { fetchImpl, timeoutMs: 5000 });
  assert.match(result.detail, /clef-flash/);
  assert.match(result.detail, /SystemOne/);
});

test('openai probe also sends capabilities so it cannot short-circuit', async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"actions":[]}' } }] }) };
  };
  const result = await testDecisionConnection(
    { decisionProtocol: 'openai', decisionBaseUrl: 'http://probe:1/v1', decisionModel: 'm' },
    { fetchImpl, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(bodies.length, 1);
  const payload = JSON.parse(bodies[0].messages[1].content);
  assert.ok(payload.untrusted_data.capabilities.length > 0, 'openai payload must include capabilities');
});

test('openai probe fails when the endpoint is down', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  await assert.rejects(
    testDecisionConnection({ decisionProtocol: 'openai', decisionBaseUrl: 'http://down:1/v1', decisionModel: 'm' }, { fetchImpl, timeoutMs: 3000 }),
    /决策接口不可达/);
});

test('decision probe still fails closed on missing fields', async () => {
  await assert.rejects(testDecisionConnection({}), /未填写决策接口根地址/);
  await assert.rejects(testDecisionConnection({ decisionBaseUrl: 'http://x' }), /未填写模型名称/);
});

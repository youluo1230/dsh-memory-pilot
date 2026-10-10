import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemosHttpBackend } from '../src/memos-http.mjs';

const action = { operation: 'search', backend: 'memos', scope: 'project', scopeId: 'pilot', query: 'remember this' };
function fixture(overrides = {}) {
  const calls = [];
  const backend = createMemosHttpBackend({ baseUrl: 'https://isolated.invalid', isolatedStore: true,
    scope: 'project', scopeId: 'pilot', fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ hits: [{ snippet: ' first ' }, { snippet: 'second' }], injectedContext: 'ignored' }) };
    }, ...overrides });
  return { backend, calls };
}

test('construction is inert; verified endpoint, POST body and snippet contract', async () => {
  const { backend, calls } = fixture({ apiKey: 'secret', agent: 'hermes', topK: 4 });
  assert.equal(calls.length, 0);
  assert.deepEqual(backend.capabilities, ['search']);
  assert.equal(backend.scope, 'project');
  assert.equal(backend.scopeId, 'pilot');
  assert.ok(Object.isFrozen(backend) && Object.isFrozen(backend.capabilities));
  assert.deepEqual(await backend.execute(action), { text: 'first\n\nsecond', source: 'memos', metadata: { hitCount: 2, returnedChars: 13 } });
  const [url, init] = calls[0];
  assert.equal(url, 'https://isolated.invalid/api/v1/memory/search');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer secret' });
  assert.deepEqual(JSON.parse(init.body), { agent: 'hermes', query: action.query, topK: { tier1: 4, tier2: 4, tier3: 4 } });
});

test('optional cookie is additional to API key; no invented X-token or ambient credentials', async () => {
  const { backend, calls } = fixture({ apiKey: 'key', sessionCookie: 'memos_sess_hermes=payload.signature' });
  await backend.execute(action);
  assert.deepEqual(calls[0][1].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer key', Cookie: 'memos_sess_hermes=payload.signature' });
  const noAuth = fixture();
  await noAuth.backend.execute(action);
  assert.deepEqual(noAuth.calls[0][1].headers, { 'Content-Type': 'application/json' });
});

test('requires explicit dedicated-service attestation and rejects fake namespace isolation', () => {
  for (const isolatedStore of [undefined, false, 'true']) assert.throws(() => fixture({ isolatedStore }), /isolatedStore:true/);
  for (const extra of [{ namespace: { profileId: 'pilot' } }, { xToken: 'secret' }, { bank: 'pilot' }]) {
    assert.throws(() => fixture(extra), /Unsupported MemOS HTTP configuration/);
  }
});

test('validates origin, scope, limits and credentials without contacting service', () => {
  for (const baseUrl of ['bad', 'file:///tmp/db', 'https://user:pass@isolated.invalid', 'https://isolated.invalid/api/v1', 'https://isolated.invalid/?q=1', 'https://isolated.invalid/#fragment']) {
    assert.throws(() => fixture({ baseUrl }), /baseUrl/);
  }
  for (const options of [{ scope: 'other' }, { scopeId: '' }, { scope: 'global', scopeId: 'pilot' },
    { topK: 0 }, { topK: 51 }, { topK: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { apiKey: 'x\r\nInjected: yes' }, { apiKey: '' }, { sessionCookie: 'X-token=secret' },
    { sessionCookie: 'memos_sess=a.b; another=secret' }, { fetchImpl: null }]) assert.throws(() => fixture(options));
  assert.doesNotThrow(() => fixture({ scope: 'global', scopeId: 'global' }));
});

test('scope mismatch, model-controlled bindings, unsupported operations fail before IO', async () => {
  const { backend, calls } = fixture();
  for (const patch of [{ scope: 'workspace' }, { scopeId: 'other' }, { namespace: {} },
    { agent: 'other' }, { sessionId: 'other' }, { filters: {} }, { bank: 'other' },
    { operation: 'write', content: 'x', evidence: { eventId: '1', quote: 'x' } },
    { operation: 'deep' }, { query: '' }, { query: 'x'.repeat(513) }]) {
    await assert.rejects(backend.execute({ ...action, ...patch }));
  }
  assert.equal(calls.length, 0);
  await backend.execute({ ...action, query: 'x'.repeat(512) });
  assert.equal(calls.length, 1);
});

test('HTTP errors, invalid JSON, bad shapes and network failures are sanitized; no retries', async () => {
  for (const fetchResult of [
    async () => { throw new Error('secret URL and key'); },
    ...[301, 401, 403, 404, 429, 500].map(status => async () => ({ ok: false, status, json: async () => { throw new Error('must not parse'); } })),
    async () => ({ ok: true, json: async () => { throw new Error('secret JSON'); } }),
    ...[null, {}, { results: [] }, { hits: [null] }, { hits: [{ text: 'not snippet' }] }].map(value => async () => ({ ok: true, json: async () => value })),
  ]) {
    let count = 0;
    const { backend } = fixture({ fetchImpl: async (...args) => { count++; return fetchResult(...args); } });
    await assert.rejects(backend.execute(action), { message: 'MemOS HTTP search failed' });
    assert.equal(count, 1);
  }
  const { backend } = fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ hits: [] }) }) });
  assert.deepEqual(await backend.execute(action), { text: '', source: 'memos', metadata: { hitCount: 0, returnedChars: 0 } });
});

test('pre-aborted request makes no call and does not expose abort reason', async () => {
  const { backend, calls } = fixture();
  const controller = new AbortController();
  controller.abort(new Error('secret'));
  await assert.rejects(backend.execute(action, { signal: controller.signal }), { name: 'AbortError', message: 'Operation aborted' });
  assert.equal(calls.length, 0);
});

test('in-flight abort propagates to fetch; timeout also aborts without retry', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let receivedSignal;
  const fetchImpl = async (_url, { signal }) => {
    receivedSignal = signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private failure')), { once: true }));
  };
  const controller = new AbortController();
  const { backend } = fixture({ fetchImpl });
  const pending = backend.execute(action, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(receivedSignal.aborted, true);
  const timed = fixture({ fetchImpl, timeoutMs: 5 });
  await assert.rejects(timed.backend.execute(action), { name: 'AbortError' });
});

test('late response or body after cancellation cannot become successful result', async () => {
  for (const duringBody of [false, true]) {
    const controller = new AbortController();
    const { backend } = fixture({ fetchImpl: async () => {
      if (!duringBody) controller.abort();
      return { ok: true, json: async () => { controller.abort(); return { hits: [] }; } };
    } });
    await assert.rejects(backend.execute(action, { signal: controller.signal }), { name: 'AbortError' });
  }
});

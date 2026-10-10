import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemosBridgeBackend } from '../src/memos-bridge.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => child.stdout;
  const sent = [];
  child.sent = sent;
  child.stdin = { write: line => { sent.push(JSON.parse(line)); return true; }, once: () => {} };
  child.pid = 4242; child.exitCode = null; child.signalCode = null;
  child.kill = () => { queueMicrotask(() => { if (child.exitCode === null) { child.exitCode = 0; child.emit('exit'); } }); };
  return child;
}
function respond(child, method, result) {
  for (let at = child.sent.length - 1; at >= 0; at--) {
    const request = child.sent[at];
    if (request.method === method) return child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
  throw new Error(`no pending request for ${method}`);
}
async function until(condition, ms = 2000) {
  for (let end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) if (condition()) return;
  throw new Error('condition not reached');
}
const EVENT = { id: 's7:3:message', type: 'turn_end', sessionId: 's7', text: '用户决定把记忆系统统一到 MemoryPilot,按范围分库。' };

test('search answers core.health once, tolerates log noise and notifications, joins snippets', async () => {
  const children = []; let calls = 0;
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => { calls++; const child = fakeChild(); children.push(child); return child; }, requestTimeoutMs: 300, readyTimeoutMs: 2000 });
  const run = backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: '记忆分库' }, { event: EVENT });
  await until(() => children[0]?.sent.length >= 1);
  children[0].stdout.emit('data', '[bridge] initializing core\n');
  respond(children[0], 'core.health', { ok: true, db: 'connected' });
  children[0].stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'events.trace', params: {} })}\n`);
  await until(() => children[0]?.sent.length >= 2);
  respond(children[0], 'memory.search', { hits: [{ snippet: ' 分库结论一 ' }, { snippet: '' }, { tier: 2, snippet: '结论二' }, {}] });
  assert.deepEqual(await run, { text: '分库结论一\n\n结论二', source: 'memos', metadata: { hitCount: 4, semanticHitCount: 4, explicitFactCount: 0, returnedChars: 10 } });
  const search = children[0].sent.find(x => x.method === 'memory.search');
  assert.equal(search.params.agent, 'deepseek-harness');
  assert.deepEqual(search.params.topK, { tier1: 5, tier2: 5, tier3: 5 });
  await backend.dispose();
});

test('write runs turn.start then turn.end with derived episode ids and provenance', async () => {
  const children = [];
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => { const child = fakeChild(); children.push(child); return child; }, requestTimeoutMs: 300, readyTimeoutMs: 2000 });
  const run = backend.execute({ operation: 'write', scope: 'project', scopeId: 'p', content: 'turn capture body', evidence: { eventId: EVENT.id, quote: '按范围分库' } }, { event: EVENT });
  await until(() => children[0]?.sent.length >= 1);
  respond(children[0], 'core.health', { ok: true });
  await until(() => children[0]?.sent.length >= 2);
  const start = children[0].sent[1];
  assert.equal(start.method, 'turn.start');
  assert.equal(start.params.agent, 'deepseek-harness');
  assert.equal(start.params.sessionId, 's7');
  assert.equal(start.params.episodeId, `ep-${EVENT.id}`);
  assert.equal(start.params.turnKey, EVENT.id);
  assert.equal(start.params.userText, 'turn capture body');
  respond(children[0], 'turn.start', { hits: [], injectedContext: '' });
  await until(() => children[0]?.sent.length >= 3);
  const end = children[0].sent[2];
  assert.equal(end.method, 'turn.end');
  assert.equal(end.params.episodeId, `ep-${EVENT.id}`);
  assert.equal(end.params.agentText, '');
  assert.deepEqual(end.params.toolCalls, []);
  respond(children[0], 'turn.end', { traceId: 't9', episodeId: `ep-${EVENT.id}` });
  const result = await run;
  assert.equal(result.source, 'memos');
  assert.match(result.text, /trace/);
  await backend.dispose();
});

test('explicit global retention remains recallable across adapter instances when semantic search misses it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-pilot-facts-'));
  try {
    const writeChildren = [];
    const writer = createMemosBridgeBackend({ home, scope: 'global', scopeId: 'global', spawnImpl: () => { const child = fakeChild(); writeChildren.push(child); return child; }, requestTimeoutMs: 300, readyTimeoutMs: 2000 });
    const write = writer.execute({ operation: 'write', scope: 'global', scopeId: 'global', content: '用户的名字叫阿宝，称呼他阿宝即可。', evidence: { eventId: EVENT.id, quote: '按范围分库' } }, { event: EVENT });
    await until(() => writeChildren[0]?.sent.length >= 1); respond(writeChildren[0], 'core.health', { ok: true });
    await until(() => writeChildren[0]?.sent.length >= 2); respond(writeChildren[0], 'turn.start', { hits: [], injectedContext: '' });
    await until(() => writeChildren[0]?.sent.length >= 3); respond(writeChildren[0], 'turn.end', { traceId: 'name-trace', episodeId: `ep-${EVENT.id}` });
    const stored = await write;
    assert.equal(stored.metadata.durable, true);
    await writer.dispose();

    const readChildren = [];
    const reader = createMemosBridgeBackend({ home, scope: 'global', scopeId: 'global', spawnImpl: () => { const child = fakeChild(); readChildren.push(child); return child; }, requestTimeoutMs: 300, readyTimeoutMs: 2000 });
    const search = reader.execute({ operation: 'search', scope: 'global', scopeId: 'global', query: '你现在知道我是谁吗？' }, { event: EVENT });
    await until(() => readChildren[0]?.sent.length >= 1); respond(readChildren[0], 'core.health', { ok: true });
    await until(() => readChildren[0]?.sent.length >= 2); respond(readChildren[0], 'memory.search', { hits: [{ snippet: '旧记忆说不知道姓名' }] });
    const recalled = await search;
    assert.match(recalled.text, /阿宝/);
    assert.match(recalled.text, /明确长期记忆/);
    assert.equal(recalled.metadata.explicitFactCount, 1);
    await reader.dispose();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('write refuses evidence that does not match the event without contacting the store', async () => {
  let spawns = 0;
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => { spawns++; return fakeChild(); } });
  await assert.rejects(backend.execute({ operation: 'write', scope: 'project', scopeId: 'p', content: 'x', evidence: { eventId: EVENT.id, quote: '不存在的话' } }, { event: EVENT }), /evidence/);
  await assert.rejects(backend.execute({ operation: 'write', scope: 'project', scopeId: 'p', content: 'x', evidence: { eventId: 'other', quote: '按范围分库' } }, { event: EVENT }), /evidence/);
  assert.equal(spawns, 0);
});

test('model-controlled storage bindings and cross-scope actions are refused', async () => {
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => fakeChild() });
  await assert.rejects(backend.execute({ operation: 'search', scope: 'project', scopeId: 'other', query: 'x' }, {}), /Scope binding/);
  await assert.rejects(backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: 'x', bank: 'hacked' }, {}), /refused/);
  await assert.rejects(backend.execute({ operation: 'deep', scope: 'project', scopeId: 'p', query: 'x' }, {}), /Unsupported operation/);
});

test('unresponsive bridge fails readiness, is killed, and a later call spawns a fresh child', async () => {
  const children = [];
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => { const child = fakeChild(); children.push(child); return child; }, requestTimeoutMs: 80, readyTimeoutMs: 200 });
  await assert.rejects(backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: 'x' }, { event: EVENT }), /not ready/);
  await until(() => children[0]?.exitCode === 0);
  const run = backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: 'x' }, { event: EVENT });
  await until(() => children.length >= 2 && children[1]?.sent.length >= 1);
  respond(children[1], 'core.health', { ok: true });
  await until(() => children[1]?.sent.length >= 2);
  respond(children[1], 'memory.search', { hits: [{ snippet: 'ok' }] });
  assert.equal((await run).text, 'ok');
  await backend.dispose();
});

test('error responses are sanitized and dispose rejects in-flight work', async () => {
  const children = [];
  const backend = createMemosBridgeBackend({ home: '/srv/memos', scope: 'project', scopeId: 'p', spawnImpl: () => { const child = fakeChild(); children.push(child); return child; }, requestTimeoutMs: 2000, readyTimeoutMs: 2000 });
  const failing = backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: 'x' }, { event: EVENT });
  await until(() => children[0]?.sent.length >= 1);
  respond(children[0], 'core.health', { ok: true });
  await until(() => children[0]?.sent.length >= 2);
  children[0].stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: children[0].sent[1].id, error: { code: 'internal', message: 'SECRET-DETAIL' } })}\n`);
  await assert.rejects(failing, /^Error: MemOS bridge request failed$/);
  const hang = backend.execute({ operation: 'search', scope: 'project', scopeId: 'p', query: 'y' }, { event: EVENT });
  await until(() => children[0]?.sent.length >= 3);
  await backend.dispose();
  await assert.rejects(hang, /MemOS bridge request failed/);
  assert.ok(children[0].exitCode !== null);
});

test('constructor validates home, agent, scope identity and numeric bounds', () => {
  assert.throws(() => createMemosBridgeBackend({ scope: 'project', scopeId: 'p' }), /home/);
  assert.throws(() => createMemosBridgeBackend({ home: '/srv', agent: '', scope: 'project', scopeId: 'p' }), /agent/);
  assert.throws(() => createMemosBridgeBackend({ home: '/srv', scope: 'global', scopeId: 'other' }), /Global scopeId/);
  assert.throws(() => createMemosBridgeBackend({ home: '/srv', scope: 'project', scopeId: 'p', topK: 0 }), /topK/);
  assert.throws(() => createMemosBridgeBackend({ home: '/srv', scope: 'project', scopeId: 'p', requestTimeoutMs: 0 }), /requestTimeoutMs/);
});

test('global turn capture uses one turn lifecycle and preserves both speakers',async()=>{
 const children=[];
 const backend=createMemosBridgeBackend({home:'/srv/memos',scope:'global',scopeId:'global',spawnImpl:()=>{const child=fakeChild();children.push(child);return child;},requestTimeoutMs:300,writeTimeoutMs:2000,readyTimeoutMs:2000});
 const run=backend.captureTurn({session:{id:'s1'},turn:2,userText:'question',assistantText:'answer'});
 await until(()=>children[0]?.sent.length>=1); respond(children[0],'core.health',{ok:true});
 await until(()=>children[0]?.sent.length>=2); const start=children[0].sent[1]; assert.equal(start.method,'turn.start'); assert.equal(start.params.userText,'question'); respond(children[0],'turn.start',{query:{episodeId:'ep1'},hits:[]});
 await until(()=>children[0]?.sent.length>=3); const end=children[0].sent[2]; assert.equal(end.method,'turn.end'); assert.equal(end.params.episodeId,'ep1'); assert.equal(end.params.agentText,'answer'); respond(children[0],'turn.end',{traceId:'tr1',episodeId:'ep1'});
 await run; await backend.dispose();
});

test('writes use their own leash while reads keep the short request timeout',async()=>{
 const children=[];
 const backend=createMemosBridgeBackend({home:'/srv/memos',scope:'project',scopeId:'p',
  spawnImpl:()=>{const child=fakeChild();children.push(child);return child;},
  requestTimeoutMs:120,writeTimeoutMs:4000,readyTimeoutMs:2000});
 const run=backend.execute({operation:'write',scope:'project',scopeId:'p',content:'capture body',evidence:{eventId:EVENT.id,quote:'按范围分库'}},{event:EVENT});
 await until(()=>children[0]?.sent.length>=1);
 respond(children[0],'core.health',{ok:true});
 await until(()=>children[0]?.sent.length>=2);
 await new Promise(resolve=>setTimeout(resolve,250)); // longer than the read leash, shorter than the write leash
 respond(children[0],'turn.start',{hits:[],injectedContext:''});
 await until(()=>children[0]?.sent.length>=3);
 respond(children[0],'turn.end',{traceId:'t1',episodeId:'ep-x'});
 const result=await run;
 assert.match(result.text,/trace/);
 await backend.dispose();
});

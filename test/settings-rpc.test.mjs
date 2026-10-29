import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsRpcHandler } from '../src/settings-rpc.mjs';

const descriptor = (value = { enabled: true, decisionKeyEnv: 'KEY', backends: [] }, revision = 3) => ({
  ns: 'dsh-memory-pilot', revision, value, base: {}, user: {}, schema: { type: 'object' }, applies: 'live',
});

// A settings service stub good enough for endpoints that do not touch configuration.
const settingsStub = () => ({ writable: true, describe: () => [descriptor()], mutate: async () => {} });

test('remote settings RPC reads only the MemoryPilot descriptor, redacted apart from declared secrets', async () => {
  const calls = [];
  const settings = {
    writable: true,
    describe(options) {
      calls.push(options);
      return [descriptor(), { ...descriptor(), ns: 'other-plugin' }];
    },
  };
  const rpc = createSettingsRpcHandler(settings);
  const result = await rpc('get', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.ns, 'dsh-memory-pilot');
  assert.equal(result.value.writable, true);
  // The view itself stays redacted — the platform strips every `role('secret')`
  // field, and that is what the panel renders. Exactly one additional unredacted
  // read supplies the secret values, because a password box cannot otherwise
  // display (or re-send) the stored key.
  assert.deepEqual(calls, [{ redactSecrets: true }, {}]);
  // Only the fields this plugin declares secret ride along, never the whole row.
  assert.deepEqual(Object.keys(result.value.secretValues).sort(), ['backends', 'decisionApiKey']);
});

test('remote settings RPC applies bounded path mutations with revision fencing', async () => {
  const writes = [];
  let current = descriptor({ enabled: false, backends: [] }, 4);
  const settings = {
    writable: true,
    describe: () => [current],
    async mutate(ns, ops, revision) {
      writes.push({ ns, ops, revision });
      current = descriptor({ enabled: true, backends: [] }, 5);
    },
  };
  const rpc = createSettingsRpcHandler(settings);
  const result = await rpc('mutate', {
    revision: 4,
    ops: [{ op: 'set', path: ['decisionProtocol'], value: 'openai' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.revision, 5);
  assert.deepEqual(writes, [{ ns: 'dsh-memory-pilot', ops: [{ op: 'set', path: ['decisionProtocol'], value: 'openai' }], revision: 4 }]);
  const override = await rpc('mutate', { revision: 5, ops: [{ op: 'set', path: ['scopeOverrides'], value: [{ scope: 'project', scopeId: 'repo', enabled: false }] }] });
  assert.equal(override.ok, true);
});

test('remote settings RPC rejects unknown endpoints, paths and oversized requests', async () => {
  const settings = { writable: true, describe: () => [descriptor()], mutate: async () => assert.fail('must not write') };
  const rpc = createSettingsRpcHandler(settings);
  assert.equal((await rpc('nope', {})).ok, false);
  assert.equal((await rpc('mutate', { revision: 0, ops: [{ op: 'set', path: ['notAllowed'], value: 1 }] })).ok, false);
  assert.equal((await rpc('mutate', { revision: 0, ops: Array.from({ length: 33 }, () => ({ op: 'set', path: ['enabled'], value: true })) })).ok, false);
});

test('remote settings RPC exposes read-only scope discovery and forwards cancellation', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const controller = new AbortController();
  const calls = [];
  const rpc = createSettingsRpcHandler(settings, { discover: async options => { calls.push(options); return { workspacePath: 'code', repositories: [], banks: [] }; } });
  assert.deepEqual(await rpc('discover', {}, controller.signal), { ok: true, value: { workspacePath: 'code', repositories: [], banks: [] } });
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(await rpc('discover', { unexpected: true }), { ok: false, error: { code: 'bad-request', message: 'Invalid MemoryPilot discovery request' } });
});

test('remote settings RPC creates only an exact currently missing Hindsight target and rediscovers it', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const discoveries = [
    { workspacePath: 'code', workspaceTargets: [{ systemId: 'hs', bank: 'workspace', exists: false }], repositories: [{ targetBanks: [{ systemId: 'hs', bank: 'repo', exists: false }] }], banks: [] },
    { workspacePath: 'code', workspaceTargets: [{ systemId: 'hs', bank: 'workspace', exists: true }], repositories: [], banks: [{ systemId: 'hs', bank: 'workspace', matched: true }] },
  ];
  const creates = [];
  const rpc = createSettingsRpcHandler(settings, {
    discover: async () => discoveries.shift(),
    createBank: async (target, options) => creates.push({ target, options }),
  });
  const controller = new AbortController();

  assert.deepEqual(await rpc('create-bank', { systemId: 'hs', bank: 'workspace' }, controller.signal), { ok: true, value: {
    workspacePath: 'code', workspaceTargets: [{ systemId: 'hs', bank: 'workspace', exists: true }], repositories: [], banks: [{ systemId: 'hs', bank: 'workspace', matched: true }],
  } });
  assert.deepEqual(creates, [{ target: { systemId: 'hs', bank: 'workspace' }, options: { signal: controller.signal } }]);
});

test('remote settings RPC rejects arbitrary, existing, and over-specified bank creation targets', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const discovery = { workspaceTargets: [{ systemId: 'hs', bank: 'missing', exists: false }, { systemId: 'hs', bank: 'existing', exists: true }], repositories: [], banks: [] };
  const rpc = createSettingsRpcHandler(settings, { discover: async () => discovery, createBank: async () => assert.fail('must not create') });
  for (const payload of [
    { systemId: 'hs', bank: 'arbitrary' },
    { systemId: 'hs', bank: 'existing' },
    { systemId: 'hs', bank: 'missing', extra: true },
    { systemId: 'hs', bank: ' missing' },
  ]) assert.equal((await rpc('create-bank', payload)).ok, false);
});

test('remote settings RPC allows a missing target from every discovered workspace', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const discovery = { workspaces: [
    { id: 'one', targets: [], repositories: [] },
    { id: 'two', targets: [{ systemId: 'hs', bank: 'workspace-two', exists: false }], repositories: [] },
  ], banks: [] };
  const creates = [];
  const rpc = createSettingsRpcHandler(settings, {
    discover: async () => discovery,
    createBank: async target => creates.push(target),
  });
  assert.equal((await rpc('create-bank', { systemId: 'hs', bank: 'workspace-two' })).ok, true);
  assert.deepEqual(creates, [{ systemId: 'hs', bank: 'workspace-two' }]);
});

test('remote settings RPC sanitizes bank creation failures', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const rpc = createSettingsRpcHandler(settings, {
    discover: async () => ({ workspaceTargets: [{ systemId: 'hs', bank: 'missing', exists: false }], repositories: [], banks: [] }),
    createBank: async () => { throw new Error('secret upstream detail'); },
  });
  assert.deepEqual(await rpc('create-bank', { systemId: 'hs', bank: 'missing' }), { ok: false, error: { code: 'create-bank-failed', message: 'Hindsight bank creation failed' } });
});

test('remote settings RPC sanitizes discovery failures', async () => {
  const settings = { writable: true, describe: () => [descriptor()] };
  const rpc = createSettingsRpcHandler(settings, { discover: async () => { throw new Error('secret upstream detail'); } });
  assert.deepEqual(await rpc('discover', {}), { ok: false, error: { code: 'discovery-failed', message: 'MemoryPilot scope discovery failed' } });
});

test('remote settings RPC reads and human-edits resident documents with revision fencing',async()=>{
 const settings={writable:true,describe:()=>[descriptor()]};const writes=[];
 const rpc=createSettingsRpcHandler(settings,{residentMemory:{inspect:async identity=>({soul:{content:'Persona',revision:'s1',path:'/dsh/SOUL.md',writable:true},user:{content:'User',revision:'u1',path:'/dsh/memory/USER.md',writable:true},globalMemory:{content:'Global',revision:'g1',path:'/dsh/memory/MEMORY.md',writable:true},projectMemory:{content:identity.projectPath||'',revision:'p1',path:'/dsh/memory/projects/x/MEMORY.md',writable:true}}),apply:async(plan,revision,identity)=>{writes.push({plan,revision,identity});return{content:plan.content,revision:'next',path:'/saved',writable:true};}}});
 const read=await rpc('resident-get',{projectPath:'/repo'});assert.equal(read.ok,true);assert.equal(read.value.projectMemory.content,'/repo');
 const saved=await rpc('resident-put',{target:'soul',content:'New persona',revision:'s1',projectPath:'/repo'});assert.equal(saved.ok,true);assert.deepEqual(writes,[{plan:{target:'soul',content:'New persona',actor:'human'},revision:'s1',identity:{projectPath:'/repo'}}]);
});

test('resident RPC emits content-free audit after a human write',async()=>{
 const audits=[];const rpc=createSettingsRpcHandler({writable:true,describe:()=>[descriptor()]},{residentMemory:{inspect:async()=>({}),apply:async()=>({revision:'next'})},onAudit:record=>audits.push(record)});
 assert.equal((await rpc('resident-put',{target:'user',content:'Secret preference',revision:'old'})).ok,true);
 assert.deepEqual(audits,[{kind:'resident-retention',actor:'human',target:'user',status:'ok',previousRevision:'old',revision:'next'}]);assert.equal(JSON.stringify(audits).includes('Secret'),false);
});

test('installed settings RPC requires project identity only for project memory',async()=>{
 const settings={writable:true,describe:()=>[descriptor()]};let handler,resolutions=0;
 const ctx={settings,connection:{rpc:{handle(_channel,value){handler=value;return()=>{}}}}};
 const {installSettingsRpc}=await import('../src/settings-rpc.mjs');
 installSettingsRpc(ctx,{residentMemory:{inspect:async identity=>({identity}),apply:async(plan)=>({target:plan.target})},resolveIdentity:()=>{resolutions++;throw new Error('missing project')}});
 assert.equal((await handler('resident-get',{})).ok,true);assert.equal(resolutions,0);
 assert.equal((await handler('resident-put',{target:'soul',content:'Persona',revision:'r'})).ok,true);assert.equal(resolutions,0);
 assert.equal((await handler('resident-put',{target:'project-memory',content:'Fact',revision:'r'})).ok,false);assert.equal(resolutions,1);
});

test('installed settings RPC resolves project paths to authoritative project identities',async()=>{
 const settings={writable:true,describe:()=>[descriptor()]};let handler,seen;
 const ctx={settings,connection:{rpc:{handle(_channel,value){handler=value;return()=>{}}}},workspaceRegistry:{list:()=>[]}};
 const {installSettingsRpc}=await import('../src/settings-rpc.mjs');
 installSettingsRpc(ctx,{residentMemory:{inspect:async identity=>{seen=identity;return{}},apply:async()=>({})},resolveIdentity:path=>({projectId:'repo-id',projectPath:path})});
 assert.equal((await handler('resident-get',{projectPath:'/repo'})).ok,true);assert.deepEqual(seen,{projectId:'repo-id',projectPath:'/repo'});
});

test('remote settings RPC sanitizes provider failures', async () => {
  const settings = { writable: true, describe: () => [descriptor()], mutate: async () => { throw new Error('secret upstream detail'); } };
  const rpc = createSettingsRpcHandler(settings);
  const result = await rpc('mutate', { revision: 3, ops: [{ op: 'set', path: ['enabled'], value: false }] });
  assert.deepEqual(result, { ok: false, error: { code: 'settings-rejected', message: 'MemoryPilot configuration was rejected' } });
});

test('remote settings RPC persists the decisionEnabled switch from the panel', async () => {
  // The settings panel exposes "使用决策模型". If this field is not on the
  // allow-list the toggle appears to save but is silently rejected.
  let current = descriptor({ enabled: true, decisionEnabled: true }, 1);
  const writes = [];
  const settings = { writable: true, describe: () => [current], async mutate(ns, ops, revision) {
    writes.push({ ns, ops, revision });
    current = descriptor({ enabled: true, decisionEnabled: false }, 2);
  } };
  const rpc = createSettingsRpcHandler(settings);
  const off = await rpc('mutate', { revision: 1, ops: [{ op: 'set', path: ['decisionEnabled'], value: false }] });
  assert.equal(off.ok, true);
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['decisionEnabled'], value: false }]);
  assert.equal(writes[0].ns, 'dsh-memory-pilot');
  const on = await rpc('mutate', { revision: 2, ops: [{ op: 'set', path: ['decisionEnabled'], value: true }] });
  assert.equal(on.ok, true);
});

test('resident write refusals report the real cause instead of always claiming a revision conflict', async () => {
  // A document over the length limit fails identically to a stale revision at the
  // storage layer, but "reload and try again" sends the user round a loop that can
  // never succeed: reloading cannot make the text shorter. Each refusal must name
  // its own remedy.
  const refuse = message => ({ inspect: async () => ({}), async apply() { throw new Error(message); } });
  const cases = [
    ['Resident memory content exceeds limit', /too long \(limit 8000 characters\)/],
    ['Resident memory revision conflict', /changed in another session/],
    ['SOUL.md is human-managed only', /human-managed only/],
    ['Resident memory content contains a reserved marker', /reserved marker/],
    ['Unexpected disk explosion', /reload and try again/],
  ];
  for (const [thrown, expected] of cases) {
    const rpc = createSettingsRpcHandler({ writable: true, describe: () => [descriptor()] }, { residentMemory: refuse(thrown) });
    const result = await rpc('resident-put', { target: 'global-memory', content: 'x', revision: 'r1' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'resident-write-failed');
    assert.match(result.error.message, expected, `"${thrown}" must surface its own remedy`);
  }
  // The length in the message tracks the target's real limit.
  const soulRefusal = createSettingsRpcHandler({ writable: true, describe: () => [descriptor()] }, { residentMemory: refuse('Resident memory content exceeds limit') });
  const soul = await soulRefusal('resident-put', { target: 'soul', content: 'x', revision: 'r1' });
  assert.match(soul.error.message, /limit 12000 characters/);
});

test('a saved decision key is returned to the panel instead of an empty slot', async () => {
  // The platform deletes every `role('secret')` field before a settings view
  // reaches a browser, so `value` carries no key. The panel therefore rendered an
  // empty password box right after a successful save, and the user concluded the
  // save had failed. The unredacted value must ride alongside the view.
  let redacted = true;
  const settings = {
    writable: true,
    describe(options) {
      redacted = options?.redactSecrets === true;
      const value = { enabled: true, backends: [{ id: 'memos-global', type: 'memos-bridge', apiKey: 'hs-STORED' }] };
      if (redacted) delete value.decisionApiKey;
      else value.decisionApiKey = 'clef-STORED';
      return [{ ...descriptor(value), secrets: [{ path: ['decisionApiKey'], set: true }] }];
    },
  };
  const rpc = createSettingsRpcHandler(settings);
  const result = await rpc('get', {});
  assert.equal(result.ok, true);
  // The rendered view is still the redacted one.
  assert.equal(result.value.value.decisionApiKey, undefined);
  // ...but the panel can show (and re-send) the stored values.
  assert.equal(result.value.secretValues.decisionApiKey, 'clef-STORED');
  assert.equal(result.value.secretValues.backends['memos-global'], 'hs-STORED');
});

test('the connection test falls back to the stored key when the draft carries none', async () => {
  // The probe runs against the DRAFT config. A draft built from a redacted view
  // has no key, so the probe sent an unauthenticated request and reported an
  // error for a perfectly healthy endpoint.
  const settings = {
    writable: true,
    describe: () => [descriptor({ enabled: true, decisionApiKey: 'clef-STORED', backends: [{ id: 'hs', type: 'hindsight', apiKey: 'hs-STORED' }] })],
  };
  const seen = [];
  const rpc = createSettingsRpcHandler(settings, { testConnection: async payload => { seen.push(payload); return { ok: true, detail: 'ok' }; } });
  await rpc('test', { kind: 'decision', config: { decisionBaseUrl: 'http://x/v1', decisionModel: 'm' } });
  await rpc('test', { kind: 'system', config: { id: 'hs', type: 'hindsight', baseUrl: 'http://y', apiKey: '' } });
  assert.equal(seen[0].config.decisionApiKey, 'clef-STORED', 'a keyless decision draft must reuse the stored key');
  assert.equal(seen[1].config.apiKey, 'hs-STORED', 'a keyless system draft must reuse the stored key');
  // A key the user actually typed still wins over the stored one.
  await rpc('test', { kind: 'decision', config: { decisionBaseUrl: 'http://x/v1', decisionModel: 'm', decisionApiKey: 'typed' } });
  assert.equal(seen[2].config.decisionApiKey, 'typed');
});

test('the activity endpoint reports what memory did, distinguishing reads from writes', async () => {
  // "Is memory working?" is the question this endpoint answers. A list that could not
  // tell a query from a write, or a failure from a success, would not answer it.
  const { createSettingsRpcHandler } = await import('../src/settings-rpc.mjs');
  const handler = createSettingsRpcHandler(settingsStub(), {
    activity: () => [
      { at: '2026-10-29T10:00:00Z', kind: 'retain', status: 'ok', scopes: ['project'], durationMs: 12 },
      { at: '2026-10-29T10:00:05Z', kind: 'query', status: 'error', scopes: ['project'], durationMs: 900, reason: 'transport' },
    ],
  });
  const result = await handler('activity', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.rows.length, 2);
  assert.equal(result.value.summary.failures, 1);
  assert.equal(result.value.summary.queries, 1);
  assert.equal(result.value.summary.retains, 1);
});

test('the points endpoint exposes the editable declarations', async () => {
  // The criteria are editable precisely because accuracy lives in their wording, so
  // the panel must be able to read them.
  const { createSettingsRpcHandler } = await import('../src/settings-rpc.mjs');
  const { BUILTIN_DECISION_POINTS } = await import('../src/decision-points.mjs');
  const handler = createSettingsRpcHandler(settingsStub(), { points: () => BUILTIN_DECISION_POINTS });
  const result = await handler('points', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.map(point => point.name), ['memory.read', 'memory.write', 'command.safety', 'session.distill']);
  assert.ok(result.value[0].questions.recall_gate.criteria.none.length > 20, 'criteria text is carried');
});

test('both new endpoints reject a payload they did not ask for', async () => {
  const { createSettingsRpcHandler } = await import('../src/settings-rpc.mjs');
  const handler = createSettingsRpcHandler(settingsStub(), { activity: () => [], points: () => [] });
  for (const endpoint of ['activity', 'points']) {
    assert.equal((await handler(endpoint, { stray: true })).ok, false);
    assert.equal((await handler(endpoint, {})).ok, true);
  }
});

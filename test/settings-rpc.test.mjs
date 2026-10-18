import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsRpcHandler } from '../src/settings-rpc.mjs';

const descriptor = (value = { enabled: true, decisionKeyEnv: 'KEY', backends: [] }, revision = 3) => ({
  ns: 'dsh-memory-pilot', revision, value, base: {}, user: {}, schema: { type: 'object' }, applies: 'live',
});

test('remote settings RPC reads only the MemoryPilot redacted descriptor', async () => {
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
  assert.deepEqual(calls, [{ redactSecrets: true }]);
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

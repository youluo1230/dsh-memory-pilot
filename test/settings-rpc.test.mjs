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

test('remote settings RPC sanitizes provider failures', async () => {
  const settings = { writable: true, describe: () => [descriptor()], mutate: async () => { throw new Error('secret upstream detail'); } };
  const rpc = createSettingsRpcHandler(settings);
  const result = await rpc('mutate', { revision: 3, ops: [{ op: 'set', path: ['enabled'], value: false }] });
  assert.deepEqual(result, { ok: false, error: { code: 'settings-rejected', message: 'MemoryPilot configuration was rejected' } });
});

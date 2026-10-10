import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHindsightBank, discoverScope } from '../src/discovery.mjs';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'memory-pilot-discovery-'));
  await mkdir(join(root, 'alpha', '.git'), { recursive: true });
  await mkdir(join(root, 'group', 'beta', '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'ignored', '.git'), { recursive: true });
  await mkdir(join(root, 'dist', 'ignored-too', '.git'), { recursive: true });
  return root;
}

test('scope discovery scans only the configured workspace and matches templated Hindsight banks', async () => {
  const root = await workspace();
  const calls = [];
  const result = await discoverScope({
    workspacePath: root,
    backends: [{ id: 'hs', type: 'hindsight', baseUrl: 'https://memory.example/api', keyEnv: 'HS_KEY', scope: 'project', scopeId: '*', bank: 'coding-{project}', read: true }],
  }, {
    env: { HS_KEY: 'top-secret' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { banks: [{ bank_id: 'coding-alpha' }, { bank_id: 'other' }] }; } };
    },
  });

  assert.equal(result.workspacePath, basename(root));
  assert.deepEqual(result.repositories.map(repo => repo.id), ['alpha', 'beta']);
  assert.deepEqual(result.repositories.map(repo => repo.path), ['alpha', 'group/beta']);
  assert.deepEqual(result.repositories[0].targetBanks, [{ systemId: 'hs', bank: 'coding-alpha', read: true, write: false, enabled: true, exists: true }]);
  assert.deepEqual(result.repositories[1].targetBanks, [{ systemId: 'hs', bank: 'coding-beta', read: true, write: false, enabled: true, exists: false }]);
  assert.deepEqual(result.banks, [
    { systemId: 'hs', bank: 'coding-alpha', matched: true },
    { systemId: 'hs', bank: 'other', matched: false },
  ]);
  assert.equal(calls[0].url, 'https://memory.example/api/v1/default/banks');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer top-secret');
  assert.doesNotMatch(JSON.stringify(result), /top-secret/);
});

test('scope discovery scans five registered workspaces independently and fetches Hindsight banks once', async () => {
  const roots = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const root = await mkdtemp(join(tmpdir(), `memory-pilot-workspace-${index}-`));
    await mkdir(join(root, `repo-${index}`, '.git'), { recursive: true });
    return root;
  }));
  let fetches = 0;
  const result = await discoverScope({
    systems: [{ id: 'hs', type: 'hindsight', baseUrl: 'https://memory.example' }],
    routes: [
      { id: 'workspace', scope: 'workspace', match: '*', systemId: 'hs', store: 'workspace-{workspace}', read: true },
      { id: 'repo', scope: 'project', match: '*', systemId: 'hs', store: 'repo-{project}', read: true, write: true },
    ],
  }, {
    workspaces: roots.map((path, index) => ({ id: `ws-${index}`, title: `Workspace ${index}`, path })),
    fetchImpl: async () => { fetches += 1; return { ok: true, async json() { return { banks: [] }; } }; },
  });

  assert.equal(fetches, 1);
  assert.equal(result.workspaces.length, 5);
  assert.deepEqual(result.workspaces.map(item => [item.id, item.title, item.path]), roots.map((_path, index) => [`ws-${index}`, `Workspace ${index}`, `Workspace ${index}`]));
  assert.deepEqual(result.workspaces[2].targets.map(target => target.bank), ['workspace-ws-2']);
  assert.deepEqual(result.workspaces[2].repositories[0].targetBanks.map(target => target.bank), ['repo-repo-2']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(roots.map(path => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
});

test('scope discovery keeps disabled targets visible with their effective target', async () => {
  const root = await workspace();
  const result = await discoverScope({
    systems: [
      { id: 'automatic', type: 'hindsight', baseUrl: 'https://automatic.example' },
      { id: 'selected', type: 'hindsight', baseUrl: 'https://selected.example' },
    ],
    routes: [
      { id: 'w', scope: 'workspace', systemId: 'automatic', store: 'workspace-{workspace}', read: true },
      { id: 'p', scope: 'project', systemId: 'automatic', store: 'repo-{project}', read: true },
    ],
    scopeOverrides: [
      { scope: 'workspace', scopeId: 'stable-workspace', enabled: false, systemId: 'selected', bank: 'disabled-bank' },
      { scope: 'project', scopeId: 'alpha', enabled: true, systemId: 'selected', bank: 'chosen-bank' },
    ],
  }, {
    workspaces: [{ id: 'stable-workspace', title: 'Stable', path: root }],
    fetchImpl: async () => ({ ok: true, async json() { return { banks: [] }; } }),
  });
  assert.deepEqual(result.workspaces[0].targets, [{ systemId: 'selected', bank: 'disabled-bank', read: true, write: false, enabled: false, exists: false }]);
  assert.deepEqual(result.workspaces[0].repositories.find(repo => repo.id === 'alpha').targetBanks,
    [{ systemId: 'selected', bank: 'chosen-bank', read: true, write: false, enabled: true, exists: false }]);
  assert.deepEqual(result.workspaces[0].repositories.find(repo => repo.id === 'beta').targetBanks,
    [{ systemId: 'automatic', bank: 'repo-beta', read: true, write: false, enabled: true, exists: false }]);
});

test('Hindsight bank creation uses the documented HTTP request and server-side credentials', async () => {
  const calls = [];
  await createHindsightBank({
    systems: [{ id: 'hs', type: 'hindsight', baseUrl: 'https://memory.example/root/', keyEnv: 'HS_KEY' }],
  }, { systemId: 'hs', bank: 'coding/a b' }, {
    env: { HS_KEY: 'top-secret' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    },
  });

  assert.equal(calls[0].url, 'https://memory.example/root/v1/default/banks/coding%2Fa%20b');
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer top-secret' });
  assert.equal(calls[0].init.body, '{}');
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
});

test('scope discovery ignores non-HTTP Hindsight responses and honors cancellation', async () => {
  const root = await workspace();
  const degraded = await discoverScope({ workspacePath: root, backends: [{ id: 'hs', type: 'hindsight', baseUrl: 'file:///secret', scope: 'project', scopeId: '*', bank: 'x' }] });
  assert.equal(degraded.repositories[0].targetBanks[0].exists, null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => discoverScope({ workspacePath: root, backends: [] }, { signal: controller.signal }), error => error?.name === 'AbortError');
});

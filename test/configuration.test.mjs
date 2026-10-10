import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsWorkspacePath, detectIdentity, matchWorkspace, normalizeConfiguration, bindingsForIdentity } from '../src/configuration.mjs';

const legacy = {
  workspacePath: '/work/app', projectId: 'app', workspaceId: '',
  backends: [{ id: 'hs', type: 'hindsight', scope: 'project', scopeId: 'app', bank: 'app-bank', baseUrl: 'http://localhost:8889', read: true, write: true }],
};

test('legacy backend bindings migrate into systems and scoped routes', () => {
  const config = normalizeConfiguration(legacy);
  assert.deepEqual(config.systems.map(x => x.id), ['hs']);
  assert.deepEqual(config.routes, [{ id: 'legacy-hs', scope: 'project', match: 'app', systemId: 'hs', store: 'app-bank', read: true, write: true }]);
});

test('identity finds the nearest repository from the session cwd within the configured workspace', () => {
  const fs = { existsSync: path => path === '/workspace/repo-a/.git' || path === '/workspace/repo-b/.git' };
  assert.deepEqual(detectIdentity('/workspace/repo-a/packages/app', { workspacePath: '/workspace', workspaceId: 'team' }, fs), {
    workspacePath: '/workspace', workspaceId: 'team', projectPath: '/workspace/repo-a', projectId: 'repo-a',
  });
  assert.deepEqual(detectIdentity('/workspace/repo-b/src', { workspacePath: '/workspace', workspaceId: 'team' }, fs), {
    workspacePath: '/workspace', workspaceId: 'team', projectPath: '/workspace/repo-b', projectId: 'repo-b',
  });
});

test('workspace path accepts descendants but not sibling prefixes', () => {
  assert.equal(acceptsWorkspacePath('/workspace', '/workspace/repo-a'), true);
  assert.equal(acceptsWorkspacePath('/workspace', '/workspace'), true);
  assert.equal(acceptsWorkspacePath('/workspace', '/workspace2/repo-a'), false);
});

test('workspace matching selects the longest registered ancestor among five workspaces', () => {
  const workspaces = [
    { id: 'root', path: '/work', title: 'Root' },
    { id: 'app', path: '/work/app', title: 'App' },
    { id: 'nested', path: '/work/app/packages/nested', title: 'Nested' },
    { id: 'other', path: '/other', title: 'Other' },
    { id: 'sibling-prefix', path: '/work-app', title: 'Sibling' },
  ];
  assert.deepEqual(matchWorkspace('/work/app/packages/nested/src', workspaces), workspaces[2]);
  assert.deepEqual(matchWorkspace('/work/app/src', workspaces), workspaces[1]);
  assert.equal(matchWorkspace('/unregistered/repo', workspaces), undefined);
});

test('identity uses the matched registered workspace path and stable id', () => {
  const fs = { existsSync: path => path === '/work/app/repo/.git' };
  assert.deepEqual(detectIdentity('/work/app/repo/src', { workspacePath: '/work/app', workspaceId: 'stable-workspace' }, fs), {
    workspacePath: '/work/app', workspaceId: 'stable-workspace', projectPath: '/work/app/repo', projectId: 'repo',
  });
});

test('repository detection never crosses the explicit workspace root', () => {
  const fs = { existsSync: path => path === '/outside/.git' };
  assert.deepEqual(detectIdentity('/workspace/plain/subdir', { workspacePath: '/workspace' }, fs), {
    workspacePath: '/workspace', workspaceId: '/workspace', projectPath: '/workspace', projectId: 'workspace',
  });
});

test('projectId override remains a legacy route match without replacing repository identity', () => {
  const fs = { existsSync: path => path === '/workspace/repo/.git' };
  assert.equal(detectIdentity('/workspace/repo/src', { workspacePath: '/workspace', projectId: 'legacy-project' }, fs).projectId, 'repo');
});

test('routes select systems for auto-detected project/workspace and global scope', () => {
  const config = normalizeConfiguration({
    systems: [
      { id: 'h', type: 'hindsight', baseUrl: 'http://localhost:8889', defaultStore: 'global-bank' },
      { id: 'm', type: 'memos-bridge', home: '/memos', agent: 'dsh' },
    ],
    routes: [
      { id: 'g', scope: 'global', match: '*', systemId: 'h', store: 'global-bank', read: true, write: false },
      { id: 'p', scope: 'project', match: 'repo', systemId: 'h', store: 'repo-bank', read: true, write: true },
      { id: 'w', scope: 'workspace', match: '/repo/app', systemId: 'm', read: true, write: true },
      { id: 'other', scope: 'project', match: 'other', systemId: 'h', store: 'other-bank', read: true, write: true },
    ],
  });
  const bindings = bindingsForIdentity(config, { projectId: 'repo', workspaceId: '/repo/app' });
  assert.deepEqual(bindings.map(x => [x.id, x.scope, x.scopeId, x.bank]), [
    ['g', 'global', 'global', 'global-bank'], ['p', 'project', 'repo', 'repo-bank'], ['w', 'workspace', '/repo/app', ''],
  ]);
});

test('legacy exact project binding still selects the discovered repository identity', () => {
  const config = normalizeConfiguration({
    projectId: 'legacy-project',
    backends: [{ id: 'memory', type: 'hindsight', baseUrl: 'http://localhost:8889', bank: 'coding::{project}', scope: 'project', scopeId: 'legacy-project', read: true }],
  });
  const [binding] = bindingsForIdentity(config, { projectId: 'repo-a', workspaceId: 'team' });
  assert.equal(binding.scopeId, 'repo-a');
  assert.equal(binding.bank, 'coding::repo-a');
});

test('wildcard project binding is copied with each session authoritative identity', () => {
  const config = normalizeConfiguration({
    backends: [{ id: 'memory', type: 'hindsight', baseUrl: 'http://localhost:8889', bank: 'coding::{project}', scope: 'project', scopeId: '*', read: true }],
  });
  const one = bindingsForIdentity(config, { projectId: 'one', workspaceId: '/src/one' });
  const two = bindingsForIdentity(config, { projectId: 'two', workspaceId: '/src/two' });
  assert.equal(one[0].scopeId, 'one');assert.equal(one[0].bank, 'coding::one');
  assert.equal(two[0].scopeId, 'two');assert.equal(two[0].bank, 'coding::two');
});

test('route store templates expand only trusted identity placeholders', () => {
  const config = normalizeConfiguration({
    systems: [{ id: 'h', type: 'hindsight', baseUrl: 'http://localhost:8889' }],
    routes: [{ id: 'p', scope: 'project', match: '*', systemId: 'h', store: 'coding::{project}', read: true, write: false }],
  });
  const [binding] = bindingsForIdentity(config, { projectId: 'repo', workspaceId: '/repo' });
  assert.equal(binding.bank, 'coding::repo');
});

test('scope overrides are exact, independent, and last duplicate wins', () => {
  const config = {
    systems: [
      { id: 'global-memos', type: 'memos-bridge', home: '/memos', agent: 'dsh' },
      { id: 'local-hs', type: 'hindsight', baseUrl: 'http://localhost:8889' },
    ],
    routes: [
      { id: 'global', scope: 'global', systemId: 'global-memos', read: true },
      { id: 'workspace', scope: 'workspace', systemId: 'local-hs', store: 'workspace-{workspace}', read: true },
      { id: 'project', scope: 'project', systemId: 'local-hs', store: 'project-{project}', read: true },
    ],
    scopeOverrides: [
      { scope: 'global', scopeId: 'global', enabled: false },
      { scope: 'workspace', scopeId: 'team', enabled: false },
      { scope: 'workspace', scopeId: 'team', enabled: true, bank: 'team-bank' },
      { scope: 'project', scopeId: 'other', enabled: false },
    ],
  };
  const bindings = bindingsForIdentity(config, { projectId: 'repo', workspaceId: 'team' });
  assert.deepEqual(bindings.map(binding => [binding.scope, binding.systemId, binding.bank]), [
    ['workspace', 'local-hs', 'team-bank'],
    ['project', 'local-hs', 'project-repo'],
  ]);
});

test('workspace disable does not cascade to project and project disable does not affect global', () => {
  const base = {
    systems: [
      { id: 'memos', type: 'memos-bridge', home: '/memos', agent: 'dsh' },
      { id: 'hs', type: 'hindsight', baseUrl: 'http://localhost:8889' },
    ],
    routes: [
      { id: 'g', scope: 'global', systemId: 'memos', read: true },
      { id: 'w', scope: 'workspace', systemId: 'hs', store: 'workspace', read: true },
      { id: 'p', scope: 'project', systemId: 'hs', store: 'project', read: true },
    ],
  };
  assert.deepEqual(bindingsForIdentity({ ...base, scopeOverrides: [{ scope: 'workspace', scopeId: 'team', enabled: false }] }, { workspaceId: 'team', projectId: 'repo' }).map(x => x.scope), ['global', 'project']);
  assert.deepEqual(bindingsForIdentity({ ...base, scopeOverrides: [{ scope: 'project', scopeId: 'repo', enabled: false }] }, { workspaceId: 'team', projectId: 'repo' }).map(x => x.scope), ['global', 'workspace']);
});

test('scope override can replace the system and Hindsight bank', () => {
  const bindings = bindingsForIdentity({
    systems: [
      { id: 'old', type: 'hindsight', baseUrl: 'http://old.example' },
      { id: 'new', type: 'hindsight', baseUrl: 'http://new.example' },
    ],
    routes: [{ id: 'p', scope: 'project', systemId: 'old', store: 'automatic-{project}', read: true }],
    scopeOverrides: [{ scope: 'project', scopeId: 'repo', enabled: true, systemId: 'new', bank: 'chosen' }],
  }, { projectId: 'repo', workspaceId: 'team' });
  assert.equal(bindings[0].systemId, 'new');
  assert.equal(bindings[0].baseUrl, 'http://new.example');
  assert.equal(bindings[0].bank, 'chosen');
});

test('scope override input is strict and unknown systems fail closed', () => {
  const base = { systems: [{ id: 'memos', type: 'memos-bridge' }], routes: [] };
  for (const scopeOverrides of [
    [{ scope: 'project', scopeId: 'repo', enabled: 'no' }],
    [{ scope: 'global', scopeId: 'not-global', enabled: true }],
    [{ scope: 'project', scopeId: 'repo', enabled: true, extra: true }],
    [{ scope: 'project', scopeId: 'repo', enabled: true, systemId: 'missing' }],
    [{ scope: 'project', scopeId: 'repo', enabled: true, systemId: 'memos', bank: 'not-supported' }],
  ]) assert.throws(() => normalizeConfiguration({ ...base, scopeOverrides }), TypeError);
});

test('global MemOS combines with a repository-specific Hindsight bank', () => {
  const config = normalizeConfiguration({
    backends: [
      { id: 'memos-global', type: 'memos-bridge', home: '/memos', agent: 'dsh', scope: 'global', scopeId: 'global', read: true, write: true },
      { id: 'hs-local', type: 'hindsight', baseUrl: 'http://localhost:8889', bank: 'coding-agent::{project}', scope: 'project', scopeId: '*', read: true, write: true },
    ],
  });
  const bindings = bindingsForIdentity(config, { projectId: 'repo-a', workspaceId: 'workspace' });
  assert.deepEqual(bindings.map(binding => [binding.id, binding.scope, binding.scopeId, binding.bank]), [
    ['legacy-memos-global', 'global', 'global', ''],
    ['legacy-hs-local', 'project', 'repo-a', 'coding-agent::repo-a'],
  ]);
});

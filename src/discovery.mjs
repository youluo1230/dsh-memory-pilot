import { readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { bindingsForIdentity, normalizeConfiguration } from './configuration.mjs';
import { resolveApiKey } from './secret.mjs';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', '.next', '.cache', 'out', 'target']);
const clean = value => typeof value === 'string' ? value.trim() : '';
const repositoryId = path => clean(basename(path)).replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';

function abortError() { return new DOMException('Discovery was cancelled', 'AbortError'); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError(); }
function discoverySignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function findRepositories(workspacePath, { signal, maxRepositories }) {
  const repositories = [], pending = [workspacePath];
  while (pending.length && repositories.length < maxRepositories) {
    throwIfAborted(signal);
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'EACCES' || error?.code === 'ENOENT') continue; throw error; }
    if (entries.some(entry => entry.name === '.git')) { repositories.push(directory); continue; }
    pending.push(...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name))
      .map(entry => resolve(directory, entry.name)).sort().reverse());
  }
  return repositories.sort();
}

function bankId(item) {
  if (typeof item === 'string') return clean(item);
  if (!item || typeof item !== 'object') return '';
  return clean(item.bank_id ?? item.bankId ?? item.id ?? item.name ?? item.bank);
}
function bankList(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.banks) ? payload.banks : Array.isArray(payload?.items) ? payload.items : [];
  return [...new Set(rows.map(bankId).filter(Boolean))].sort();
}
function hindsightSystems(config) { return normalizeConfiguration(config).systems.filter(system => system.type === 'hindsight' && clean(system.baseUrl)); }
function hindsightEndpoint(system, suffix = '') {
  let endpoint;
  try { endpoint = new URL(`${clean(system.baseUrl).replace(/\/+$/, '')}/v1/default/banks${suffix}`); }
  catch { throw new TypeError('Hindsight baseUrl must be HTTP(S)'); }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new TypeError('Hindsight baseUrl must be HTTP(S)');
  return endpoint;
}
function hindsightHeaders(system, env, json = false) {
  const apiKey = resolveApiKey({ keyEnv: system.keyEnv, apiKey: system.apiKey }, env).value;
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}
async function fetchBanks(system, { env, fetchImpl, signal }) {
  const response = await fetchImpl(hindsightEndpoint(system).href, { method: 'GET', headers: hindsightHeaders(system, env), signal });
  if (!response?.ok) throw new Error('Hindsight bank discovery failed');
  return bankList(await response.json());
}

export async function createHindsightBank(config = {}, { systemId, bank } = {}, {
  signal, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  const system = hindsightSystems(config).find(item => item.id === systemId);
  if (!system || !clean(bank)) throw new TypeError('Invalid Hindsight bank target');
  const boundedSignal = discoverySignal(signal, timeoutMs);
  throwIfAborted(boundedSignal);
  const response = await fetchImpl(hindsightEndpoint(system, `/${encodeURIComponent(bank)}`).href, {
    method: 'PUT', headers: hindsightHeaders(system, env, true), body: '{}', signal: boundedSignal,
  });
  if (!response?.ok) throw new Error('Hindsight bank creation failed');
}

function targetsFor(config, identity, routeSystems, available, matched, filter = () => true) {
  const seen = new Set();
  return bindingsForIdentity(config, identity, { includeDisabled: true }).flatMap(binding => {
    if (!filter(binding) || binding.type !== 'hindsight' || !clean(binding.bank)) return [];
    const systemId = binding.systemId ?? routeSystems.get(binding.id) ?? binding.id;
    const key = `${systemId}\0${binding.bank}`;
    if (seen.has(key)) return [];
    seen.add(key); matched.get(systemId)?.add(binding.bank);
    const knownBanks = available.get(systemId);
    return [{ systemId, bank: binding.bank, read: binding.read === true, write: binding.write === true,
      enabled: binding.enabled !== false, exists: knownBanks === null ? null : knownBanks.includes(binding.bank) }];
  });
}

/** Discover every registered workspace without exposing absolute host paths. */
export async function discoverScope(config = {}, {
  signal, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
  maxRepositories = 200, workspaces,
} = {}) {
  const boundedSignal = discoverySignal(signal, timeoutMs);
  throwIfAborted(boundedSignal);
  const normalized = normalizeConfiguration(config);
  const systems = hindsightSystems(config);
  const routeSystems = new Map(normalized.routes.map(route => [route.id, route.systemId]));
  // Service inventory is global to the connection; never refetch it per workspace.
  const available = new Map(await Promise.all(systems.map(async system => {
    try { return [system.id, await fetchBanks(system, { env, fetchImpl, signal: boundedSignal })]; }
    catch (error) { if (boundedSignal.aborted) throw error; return [system.id, null]; }
  })));
  const matched = new Map(systems.map(system => [system.id, new Set()]));
  const supplied = Array.isArray(workspaces);
  const workspaceRows = supplied ? workspaces : [{
    id: clean(config.workspaceId) || resolve(clean(config.workspacePath) || process.cwd()),
    title: basename(resolve(clean(config.workspacePath) || process.cwd())),
    path: resolve(clean(config.workspacePath) || process.cwd()),
  }];
  const discovered = [];
  for (const workspace of workspaceRows) {
    throwIfAborted(boundedSignal);
    if (!workspace || !clean(workspace.id) || !clean(workspace.path)) continue;
    const workspacePath = resolve(workspace.path);
    const workspaceId = clean(workspace.id);
    const identityBase = { workspaceId, workspacePath, actorId: clean(config.actorId) };
    const paths = await findRepositories(workspacePath, { signal: boundedSignal, maxRepositories });
    const repositories = paths.map(path => {
      const identity = { ...identityBase, projectId: repositoryId(path), projectPath: path, projectKey: createHash('sha256').update(path).digest('hex').slice(0,16) };
      return { path: relative(workspacePath, path) || '.', projectRef: `${workspaceId}::${relative(workspacePath, path) || '.'}`, id: identity.projectId,
        targetBanks: targetsFor(config, identity, routeSystems, available, matched, binding => binding.scope === 'project') };
    });
    const rootIdentity = { ...identityBase, projectId: repositoryId(workspacePath), projectPath: workspacePath };
    const workspaceTargets = targetsFor(config, rootIdentity, routeSystems, available, matched, binding => binding.scope === 'workspace');
    discovered.push({ id: workspaceId, title: clean(workspace.title) || basename(workspacePath),
      path: clean(workspace.title) || basename(workspacePath),
      targets: workspaceTargets.length ? workspaceTargets : targetsFor(config, rootIdentity, routeSystems, available, matched, binding => binding.scope === 'project'),
      repositories });
  }
  const globalBindings = bindingsForIdentity(config, { workspaceId: '', projectId: '' }, { includeDisabled: true })
    .filter(binding => binding.scope === 'global')
    .map(binding => ({ systemId: binding.systemId, type: binding.type, bank: binding.bank,
      read: binding.read, write: binding.write, enabled: binding.enabled !== false }));
  if (supplied) {
    const banks = systems.flatMap(system => (available.get(system.id) ?? []).map(bank => ({ systemId: system.id, bank, matched: matched.get(system.id)?.has(bank) === true })));
    return { globalBindings, workspaces: discovered, banks };
  }
  const [workspace] = discovered;
  const workspaceTargets = targetsFor(config, {
    workspaceId: workspace?.id, workspacePath: workspaceRows[0]?.path,
    projectId: repositoryId(workspaceRows[0]?.path ?? ''), projectPath: workspaceRows[0]?.path,
    actorId: clean(config.actorId),
  }, routeSystems, available, matched, binding => binding.scope === 'project');
  const banks = systems.flatMap(system => (available.get(system.id) ?? []).map(bank => ({ systemId: system.id, bank, matched: matched.get(system.id)?.has(bank) === true })));
  // Compatibility shape for direct callers; RPC always supplies registered workspaces.
  return { workspacePath: workspace?.path ?? '', globalBindings, workspaceTargets,
    repositories: workspace?.repositories ?? [], banks };
}

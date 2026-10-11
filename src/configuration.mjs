import { basename, dirname, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const clean = value => typeof value === 'string' ? value.trim() : '';
const identifier = value => clean(value).replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';

export function acceptsWorkspacePath(workspacePath, cwd) {
  if (!clean(workspacePath)) return true;
  const root = resolve(workspacePath);
  const candidate = resolve(cwd);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** Select the most specific registered workspace containing cwd. */
export function matchWorkspace(cwd, workspaces = []) {
  if (!clean(cwd) || !Array.isArray(workspaces)) return undefined;
  return workspaces.filter(workspace => workspace && clean(workspace.path)
    && acceptsWorkspacePath(workspace.path, cwd))
    .sort((left, right) => resolve(right.path).length - resolve(left.path).length)[0];
}

export function detectIdentity(cwd, overrides = {}, fs = { existsSync }) {
  const sessionPath = resolve(clean(cwd) || process.cwd());
  const workspacePath = resolve(clean(overrides.workspacePath) || sessionPath);
  let projectPath = sessionPath;
  while (true) {
    if (fs.existsSync(resolve(projectPath, '.git'))) break;
    if (projectPath === workspacePath) { projectPath = workspacePath; break; }
    const parent = dirname(projectPath);
    if (parent === projectPath) { projectPath = workspacePath; break; }
    projectPath = parent;
  }
  return {
    workspacePath,
    workspaceId: clean(overrides.workspaceId) || workspacePath,
    projectPath,
    projectId: identifier(basename(projectPath)),
    projectKey: createHash('sha256').update(projectPath).digest('hex').slice(0,16),
  };
}

function legacyConfiguration(input) {
  const systems = [];
  const routes = [];
  for (const item of input.backends ?? []) {
    systems.push({
      id: item.id, type: item.type, baseUrl: item.baseUrl ?? '', home: item.home ?? '',
      agent: item.agent ?? '', keyEnv: item.keyEnv ?? '', apiKey: item.apiKey ?? '',
      cookieEnv: item.cookieEnv ?? '', isolatedStore: item.isolatedStore === true,
      defaultStore: item.bank ?? '',
    });
    routes.push({ id: `legacy-${item.id}`, scope: item.scope, match: item.scopeId || '*',
      systemId: item.id, store: item.bank ?? '', read: item.read === true, write: item.write === true });
  }
  return { systems, routes };
}

export function normalizeConfiguration(input = {}) {
  const modern = Array.isArray(input.systems) && input.systems.length
    ? { systems: input.systems, routes: Array.isArray(input.routes) ? input.routes : [] }
    : legacyConfiguration(input);
  const systems = modern.systems.map(system => ({ defaultStore: '', baseUrl: '', home: '', agent: '', keyEnv: '',
    apiKey: '', cookieEnv: '', isolatedStore: false, ...system }));
  const knownSystems = new Map(systems.map(system => [system.id, system]));
  const overrides = new Map();
  for (const override of input.scopeOverrides ?? []) {
    if (!override || typeof override !== 'object' || Array.isArray(override)
      || Object.keys(override).some(key => !['id', 'scope', 'scopeId', 'enabled', 'systemId', 'bank'].includes(key))
      || !['global', 'workspace', 'project'].includes(override.scope)
      || typeof override.scopeId !== 'string' || !override.scopeId.trim()
      || typeof override.enabled !== 'boolean'
      || (override.scope === 'global' && override.scopeId !== 'global')
      || (override.systemId !== undefined && (typeof override.systemId !== 'string' || !knownSystems.has(override.systemId)))
      || (override.bank !== undefined && (typeof override.bank !== 'string' || !override.bank.trim()))) {
      throw new TypeError('Invalid scope override');
    }
    const system = override.systemId ? knownSystems.get(override.systemId) : undefined;
    if (override.bank !== undefined && system && system.type !== 'hindsight') throw new TypeError('MemOS scope overrides cannot select a bank');
    overrides.set(`${override.scope}\0${override.scopeId}`, { ...override, scopeId: override.scopeId.trim(), bank: override.bank?.trim() });
  }
  return {
    ...input,
    systems,
    routes: modern.routes.map(route => ({ match: '*', store: '', read: true, write: false, ...route })),
    scopeOverrides: [...overrides.values()],
  };
}

function expandStore(store, identity) {
  return clean(store).replaceAll('{project}', identity.projectId ?? '').replaceAll('{workspace}', identity.workspaceId ?? '');
}

export function bindingsForIdentity(input, identity, { includeDisabled = false } = {}) {
  const config = normalizeConfiguration(input);
  const systems = new Map(config.systems.map(system => [system.id, system]));
  const overrides = new Map(config.scopeOverrides.map(override => [`${override.scope}\0${override.scopeId}`, override]));
  const scopeIdentity = { global: 'global', project: identity.projectId, workspace: identity.workspaceId, personal: identity.actorId };
  return config.routes.flatMap(route => {
    const scopeId = scopeIdentity[route.scope];
    if (!scopeId || !systems.has(route.systemId)) return [];
    const legacyProjectMatch = route.scope === 'project' && route.match === clean(config.projectId);
    if (route.match !== '*' && route.match !== scopeId && !legacyProjectMatch) return [];
    const override = overrides.get(`${route.scope}\0${scopeId}`);
    if (override?.enabled === false && !includeDisabled) return [];
    const systemId = override?.systemId || route.systemId;
    const system = systems.get(systemId);
    if (!system) return [];
    if (override?.bank !== undefined && system.type !== 'hindsight') throw new TypeError('MemOS scope overrides cannot select a bank');
    const store = expandStore(override?.bank ?? (route.store || system.defaultStore), identity);
    return [{
      id: route.id, systemId, type: system.type, scope: route.scope, scopeId, enabled: override?.enabled !== false,
      baseUrl: system.baseUrl, home: system.home, agent: system.agent, keyEnv: system.keyEnv,
      apiKey: system.apiKey, cookieEnv: system.cookieEnv, isolatedStore: system.isolatedStore,
      bank: system.type === 'hindsight' ? store : '', read: route.read === true, write: route.write === true,
    }];
  });
}

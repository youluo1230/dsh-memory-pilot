import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { createOrchestrator } from './core.mjs';
import { acceptsWorkspacePath, bindingsForIdentity, detectIdentity, matchWorkspace } from './configuration.mjs';
import { createOpenAICompatibleDecision, createSystemOneDecision } from './adapters.mjs';
import { createRegistry } from './registry.mjs';
import { attachHost } from './host.mjs';
import { installSettingsRpc } from './settings-rpc.mjs';
import { registerMemoryTools } from './tools.mjs';

const debug = line => { if (process.env.MEMORY_PILOT_DEBUG) console.error(`[memory-pilot] ${line}`); };
debug('module evaluated');

// Unwrap the live Volatile<T> references the Loader passes for .volatile()
// fields into a plain snapshot, once per read (same shape as free-search).
function resolveConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  }
  return out;
}

export const name = 'dsh-memory-pilot';
export const inject = ['connection', 'webServer', 'settings', 'workspaceRegistry', 'tools'];
// Every editable field is volatile: the settings UI commits edits in place and
// the Loader hands live references instead of remounting the plugin. The
// settings describe mirror only serves entries that own at least one volatile
// field, so a non-volatile schema would make the panel invisible.
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  actorId: Schema.string().default('').volatile(),
  projectId: Schema.string().default('').volatile(),
  workspaceId: Schema.string().default('').volatile(),
  workspacePath: Schema.string().default('').volatile(),
  decisionBaseUrl: Schema.string().default('').volatile(),
  decisionModel: Schema.string().default('').volatile(),
  decisionProtocol: Schema.union(['systemone', 'openai']).default('systemone').volatile(),
  decisionKeyEnv: Schema.string().default('MEMORY_DECISION_API_KEY').volatile(),
  backends: Schema.array(Schema.object({
    id: Schema.string().required(), type: Schema.string().required(),
    baseUrl: Schema.string().default(''), bank: Schema.string().default(''),
    home: Schema.string().default(''), agent: Schema.string().default(''),
    keyEnv: Schema.string().default(''), apiKey: Schema.string().default('').role('secret'),
    cookieEnv: Schema.string().default(''),
    isolatedStore: Schema.boolean().default(false),
    scope: Schema.string().required(), scopeId: Schema.string().required(),
    read: Schema.boolean().default(false), write: Schema.boolean().default(false),
  })).default([]).volatile(),
  scopeOverrides: Schema.array(Schema.object({
    id: Schema.string(), scope: Schema.union(['global', 'workspace', 'project']).required(),
    scopeId: Schema.string().required(), enabled: Schema.boolean().required(),
    systemId: Schema.string(), bank: Schema.string(),
  })).default([]).volatile(),
  budgetMs: Schema.number().min(100).max(30000).default(2500).volatile(),
  captureBudgetMs: Schema.number().min(100).max(300000).default(60000).volatile(),
});

export function apply(ctx, config) {
  debug('apply called');
  const current = () => resolveConfig(config);
  let configHash = '';
  const runtimes = new Map();
  const disposeRuntimes = entries => void Promise.allSettled(entries.flatMap(runtime =>
    Object.values(runtime.registry?.backends ?? {}).map(backend => backend.dispose?.())));
  const prepared = () => {
    const resolved = current();
    const hash = JSON.stringify(resolved);
    if (hash !== configHash) {
      const previous = [...runtimes.values()];
      runtimes.clear();
      configHash = hash;
      disposeRuntimes(previous);
    }
    return resolved;
  };
  const workspaceFor = (cwd, resolved = prepared()) => {
    if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.list === 'function') {
      return matchWorkspace(cwd, ctx.workspaceRegistry.list());
    }
    return acceptsWorkspacePath(resolved.workspacePath, cwd)
      ? { id: resolved.workspaceId || resolved.workspacePath, path: resolved.workspacePath }
      : undefined;
  };
  const identityFor = session => {
    const resolved = prepared();
    const workspace = workspaceFor(session.header?.cwd, resolved);
    if (!workspace) return {};
    const detected = detectIdentity(session.header?.cwd, {
      ...resolved, workspacePath: workspace.path, workspaceId: String(workspace.id),
    });
    return Object.fromEntries(Object.entries({ actorId: resolved.actorId, ...detected })
      .filter(([, value]) => Boolean(value)));
  };
  const runtimeFor = session => {
    const resolved = prepared();
    if (!resolved.enabled || !resolved.decisionBaseUrl || !resolved.decisionModel) return null;
    const identity = identityFor(session);
    const key = JSON.stringify([identity.actorId, identity.projectId, identity.workspaceId, identity.workspacePath]);
    if (runtimes.has(key)) return runtimes.get(key);
    const bindings = bindingsForIdentity(resolved, identity);
    if (!bindings.length) return null;
    const registry = createRegistry({ bindings, identities: { personal: identity.actorId, project: identity.projectId, workspace: identity.workspaceId } });
    const createDecision = resolved.decisionProtocol === 'openai' ? createOpenAICompatibleDecision : createSystemOneDecision;
    const apiKey = resolved.decisionKeyEnv ? process.env[resolved.decisionKeyEnv] : undefined;
    const orchestrator = createOrchestrator({
      decision: createDecision({ baseUrl: resolved.decisionBaseUrl, model: resolved.decisionModel, apiKey }),
      backends: registry.backends, policy: registry.policy, budgetMs: resolved.budgetMs,
      onAudit: record => ctx.logger.info(`MemoryPilot ${JSON.stringify(record)}`),
    });
    const runtime = { registry, orchestrator };
    runtimes.set(key, runtime);
    debug(`orchestrator built for ${identity.projectId}:${identity.workspaceId}`);
    return runtime;
  };
  const initial = prepared();
  if (initial.enabled && initial.decisionBaseUrl && initial.decisionModel) {
    const firstPath = typeof ctx.workspaceRegistry?.list === 'function'
      ? ctx.workspaceRegistry.list()[0]?.path : initial.workspacePath;
    if (firstPath) runtimeFor({ header: { cwd: firstPath } }); // preserve fail-fast configuration
  }
  const disposeSettingsRpc = installSettingsRpc(ctx, { getConfig: current });
  const acceptsSession = session => {
    const resolved = prepared();
    if (resolved.enabled !== true || typeof session.header?.cwd !== 'string') return false;
    return Boolean(workspaceFor(session.header.cwd, resolved));
  };
  const disposeTools = registerMemoryTools(ctx, { runtimeFor, identityFor, acceptsSession,
    retrieveBudgetMs: 60000, rememberBudgetMs: current().captureBudgetMs ?? 60000 });
  const host = attachHost(ctx, {
    orchestratorFor: session => runtimeFor(session)?.orchestrator,
    retrievalBudgetMs: () => Math.max(current().budgetMs ?? 9000, 60000),
    capture: () => (prepared().backends ?? []).some(binding => binding.scope === 'global' && binding.write === true),
    captureTurn: turn => runtimeFor(turn.session)?.registry.captureTurn(turn),
    captureBudgetMs: () => current().captureBudgetMs ?? 60000,
    acceptsSession,
    identity: identityFor,
    createMessage: text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-memory-pilot', form: 'recall' } }),
    onTrace: (session, trace, location = {}) => {
      const scope = trace.executions?.[0]?.scope ?? 'none';
      const engine = trace.executions?.[0]?.engine ?? 'none';
      const operation = trace.executions?.[0]?.operation ?? 'none';
      session.append('plugin/observation', {
        plugin: 'dsh-memory-pilot', kind: trace.kind, version: trace.schemaVersion,
        turn: location.turn ?? 0, ...(location.step ? { step: location.step } : {}),
        summary: `MemoryPilot ${trace.status}: ${scope} ${engine} ${operation}`.slice(0, 120), data: trace,
      });
    },
    onError: code => ctx.logger.warn(`MemoryPilot ${code}`),
  });
  ctx.on('dispose', async () => {
    disposeSettingsRpc?.();
    disposeTools?.();
    host.dispose();
    await Promise.allSettled([...runtimes.values()].flatMap(runtime => Object.values(runtime.registry.backends).map(backend => backend.dispose?.())));
  });
}

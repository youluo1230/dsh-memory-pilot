import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';
import { createOrchestrator } from './core.mjs';
import { acceptsWorkspacePath, bindingsForIdentity, detectIdentity, matchWorkspace } from './configuration.mjs';
import { createOpenAICompatibleDecision, createSystemOneDecision } from './adapters.mjs';
import { createRegistry } from './registry.mjs';
import { attachHost } from './host.mjs';
import { installSettingsRpc } from './settings-rpc.mjs';
import { testDecisionConnection, testSystemConnection } from './connection-test.mjs';
import { registerMemoryTools } from './tools.mjs';
import { createResidentMemory } from './resident-memory.mjs';
import { createRetentionRouter } from './retention-router.mjs';

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
export const inject = ['connection', 'webServer', 'settings', 'workspaceRegistry', 'tools', 'systemPrompt'];
// Every editable field is volatile: the settings UI commits edits in place and
// the Loader hands live references instead of remounting the plugin. The
// settings describe mirror only serves entries that own at least one volatile
// field, so a non-volatile schema would make the panel invisible.
export const Config = Schema.object({
  enabled: Schema.boolean().default(false).volatile(),
  // Master switch for the external decision model. When false, MemoryPilot runs
  // in "autonomous" mode: no decision endpoint is contacted, and the calling
  // agent decides for itself when to invoke memory_retrieve / memory_remember.
  // This keeps memory working when the decision model is stopped or out of
  // memory, instead of failing every call with an opaque adapter error.
  decisionEnabled: Schema.boolean().default(true).volatile(),
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
  const residentMemory = createResidentMemory();
  const residentSnapshots = new WeakMap();
  const residentLoads = new WeakMap();
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
  const resolveProjectRef = reference => {
    if (typeof reference !== 'string') throw new Error('Unknown resident memory project');
    const split = reference.indexOf('::');
    if (split >= 0 && typeof ctx.workspaceRegistry?.list === 'function') {
      const workspaceId = reference.slice(0, split), relativePath = reference.slice(split + 2);
      const workspace = ctx.workspaceRegistry.list().find(row => String(row.id) === workspaceId);
      if (!workspace || relativePath.split(/[\\/]/).some(part => part === '..')) throw new Error('Unknown resident memory project');
      const candidate = resolve(workspace.path, relativePath);
      if (!acceptsWorkspacePath(workspace.path, candidate)) throw new Error('Unknown resident memory project');
      return candidate;
    }
    const resolved = prepared();
    const workspace = workspaceFor(reference, resolved);
    if (!workspace) throw new Error('Unknown resident memory project');
    return reference;
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
    // `enabled` gates the plugin. The decision endpoint is only required when
    // the external decision model is switched on; in autonomous mode the agent
    // drives the memory tools directly.
    if (!resolved.enabled) return null;
    const usesDecision = resolved.decisionEnabled !== false;
    if (usesDecision && (!resolved.decisionBaseUrl || !resolved.decisionModel)) return null;
    const identity = identityFor(session);
    const key = JSON.stringify([identity.actorId, identity.projectKey, identity.projectId, identity.workspaceId, identity.workspacePath]);
    if (runtimes.has(key)) return runtimes.get(key);
    const bindings = bindingsForIdentity(resolved, identity);
    const registry = bindings.length ? createRegistry({ bindings, identities: { personal: identity.actorId, project: identity.projectId, workspace: identity.workspaceId } }) : null;
    const createDecision = resolved.decisionProtocol === 'openai' ? createOpenAICompatibleDecision : createSystemOneDecision;
    const apiKey = resolved.decisionKeyEnv ? process.env[resolved.decisionKeyEnv] : undefined;
    const decision = usesDecision
      ? createDecision({ baseUrl: resolved.decisionBaseUrl, model: resolved.decisionModel, apiKey })
      : null;
    const orchestrator = registry && decision ? createOrchestrator({
      decision, backends: registry.backends, policy: registry.policy, budgetMs: resolved.budgetMs,
      onAudit: record => ctx.logger.info(`MemoryPilot ${JSON.stringify(record)}`),
    }) : null;
    const writable = Object.entries(registry?.backends ?? {}).filter(([,backend]) => backend.capabilities.includes('write'));
    const readable = Object.entries(registry?.backends ?? {}).filter(([,backend]) => backend.capabilities.includes('search'));
    const retainOn = async ([backendId, backend], event, { signal } = {}) => {
      const binding = bindings.find(row => row.id === backendId);
      // The adapter validates write evidence against the event, so the event
      // must travel in the execution options — not only inside the action.
      await backend.execute({operation:'write',backend:backendId,scope:binding.scope,scopeId:binding.scopeId,content:event.text,evidence:{eventId:event.id,quote:event.text}},{signal,event});
      return {status:'ok',accepted:1};
    };
    // The decision model may route an external write only when the destination
    // is unambiguous; with several writable backends it must not guess.
    const externalRetain = writable.length === 1 ? (event, options) => retainOn(writable[0], event, options) : undefined;
    // Autonomous recall: query every readable backend directly, no decision gate.
    const directRetrieve = readable.length ? async (query, { signal } = {}) => {
      const settled = await Promise.allSettled(readable.map(async ([backendId, backend]) => {
        const binding = bindings.find(row => row.id === backendId);
        const value = await backend.execute({
          operation: 'search', backend: backendId, scope: binding.scope, scopeId: binding.scopeId, query,
        }, { signal });
        return typeof value?.text === 'string' ? value.text.trim() : '';
      }));
      const hits = settled.filter(row => row.status === 'fulfilled' && row.value).map(row => row.value);
      const failed = settled.some(row => row.status === 'rejected');
      return {
        status: hits.length ? 'ok' : (failed ? 'error' : 'noop'),
        context: hits.join('\n\n').slice(0, 8000),
        results: [], truncated: hits.join('\n\n').length > 8000,
      };
    } : null;
    const retentionRouter = decision && typeof decision.decideRetention === 'function'
      ? createRetentionRouter({ decision, residentMemory, externalRetain,
        externalAvailable: () => writable.length === 1,
        onAudit: record => ctx.logger.info(`MemoryPilot ${JSON.stringify(record)}`) }) : undefined;
    // Autonomous retention: an explicit memory_remember IS the decision, so the
    // content goes to every write-enabled backend. Fanning out is deliberate —
    // the agent asked for a durable record and has no basis to prefer one store,
    // and partial success still counts as retained.
    const directRetain = writable.length ? async (event, { signal } = {}) => {
      const settled = await Promise.allSettled(writable.map(entry => retainOn(entry, event, { signal })));
      const accepted = settled.filter(row => row.status === 'fulfilled').length;
      if (!accepted) throw new Error('No backend accepted the write');
      return {status:'ok',accepted};
    } : null;
    const runtime = { registry, orchestrator, retentionRouter, directRetrieve, directRetain, autonomous: !usesDecision };
    runtimes.set(key, runtime);
    debug(`memory runtime built for ${identity.projectId}:${identity.workspaceId} mode=${usesDecision ? 'decision' : 'autonomous'}`);
    return runtime;
  };
  const initial = prepared();
  if (initial.enabled && (initial.decisionEnabled === false
    || (initial.decisionBaseUrl && initial.decisionModel))) {
    const firstPath = typeof ctx.workspaceRegistry?.list === 'function'
      ? ctx.workspaceRegistry.list()[0]?.path : initial.workspacePath;
    if (firstPath) runtimeFor({ header: { cwd: firstPath } }); // preserve fail-fast configuration
  }
  const disposeSettingsRpc = installSettingsRpc(ctx, {
    getConfig: current,
    residentMemory,
    resolveIdentity: reference => identityFor({ header: { cwd: resolveProjectRef(reference) } }),
    onAudit: record => ctx.logger.info(`MemoryPilot ${JSON.stringify(record)}`),
    // One-shot probes for the settings UI "测试" buttons. They receive the
    // DRAFT (possibly unsaved) config and must not touch runtimes or state.
    testConnection: async ({ kind, config }, { signal } = {}) => {
      if (kind === 'decision') return testDecisionConnection(config, { signal, timeoutMs: 10_000 });
      return testSystemConnection(config, { signal, timeoutMs: 10_000 });
    },
  });
  const acceptsSession = session => {
    const resolved = prepared();
    if (resolved.enabled !== true || typeof session.header?.cwd !== 'string') return false;
    return Boolean(workspaceFor(session.header.cwd, resolved));
  };
  const runtimeWithResidentFor = session => {
    const runtime = runtimeFor(session);
    if (!runtime) return null;
    return { ...runtime, residentSnapshot: residentSnapshots.get(session) };
  };
  const snapshotFor = async session => {
    if (residentSnapshots.has(session)) return residentSnapshots.get(session);
    if (residentLoads.has(session)) return residentLoads.get(session);
    const load = residentMemory.snapshot(identityFor(session)).then(snapshot => { residentSnapshots.set(session, snapshot); return snapshot; });
    residentLoads.set(session, load);
    try { return await load; } finally { residentLoads.delete(session); }
  };
  const disposeTools = registerMemoryTools(ctx, { runtimeFor: runtimeWithResidentFor, identityFor, acceptsSession, residentSnapshotFor: snapshotFor,
    // Tool-driven retrieval bypasses the message-path decision gate, so it gets
    // the capture budget rather than the interactive decision budget.
    retrieveBudgetMs: current().captureBudgetMs ?? 60000, rememberBudgetMs: current().captureBudgetMs ?? 60000 });
  const personaDisposers = new Map();
  const disposePersona = ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx?.on) return;
    const off = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const snapshot = acceptsSession(agent.session) ? await snapshotFor(agent.session) : undefined;
      const assembled = await next();
      if (!snapshot?.soul) return assembled;
      return { ...assembled, sections: [...assembled.sections, { name:'memory-pilot:soul',text:snapshot.soul,interpolate:false }] };
    });
    personaDisposers.set(agent, off);
  });
  const disposePersonaSession = ctx.on('session/disposed', session => {
    for (const [agent, off] of personaDisposers) if (agent.session === session) { off?.(); personaDisposers.delete(agent); }
  });
  const host = attachHost(ctx, {
    orchestratorFor: session => runtimeFor(session)?.orchestrator,
    residentSnapshotFor: snapshotFor,
    // Deliberately floored at 60s: the interactive path spends its budget on the
    // decision model plus one round of reads; a tighter value starves the reads.
    retrievalBudgetMs: () => Math.max(current().budgetMs ?? 9000, 60000),
    capture: () => (prepared().backends ?? []).some(binding => binding.scope === 'global' && binding.write === true),
    captureTurn: turn => runtimeFor(turn.session)?.registry?.captureTurn(turn),
    captureBudgetMs: () => current().captureBudgetMs ?? 60000,
    acceptsSession,
    identity: identityFor,
    createMessage: text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-memory-pilot', form: 'recall' } }),
    // rc.2 read path (dsh-session-persistence-jsonl validateStoredEvents) refuses any
    // event type outside its built-in vocabulary unless marked ignorable, and rc.2
    // append() offers no way to set that marker — appending a custom type here would
    // poison the session log (history fails to load). Audit goes to the harness log;
    // the trajectory client keeps rendering legacy plugin/observation events.
    onResidentSnapshot: (session, snapshot, location = {}) => {
      const sources = Object.entries(snapshot.resident).filter(([,value])=>Boolean(value)).map(([scope,value])=>`${scope}:${value.length}`).join(',') || 'none';
      ctx.logger.info(`MemoryPilot resident memory loaded turn=${location.turn ?? 0} sources=${sources} soul=${Boolean(snapshot.soul)}`);
    },
    onTrace: (session, trace, location = {}) => {
      const scope = trace.executions?.[0]?.scope ?? 'none';
      const engine = trace.executions?.[0]?.engine ?? 'none';
      const operation = trace.executions?.[0]?.operation ?? 'none';
      ctx.logger.info(`MemoryPilot ${trace.kind} ${trace.status}: ${scope} ${engine} ${operation} turn=${location.turn ?? 0}${location.step ? ` step=${location.step}` : ''}`);
    },
    onError: code => ctx.logger.warn(`MemoryPilot ${code}`),
  });
  ctx.on('dispose', async () => {
    disposeSettingsRpc?.();
    disposeTools?.();
    disposePersona?.();
    disposePersonaSession?.();
    for (const off of personaDisposers.values()) off?.();
    personaDisposers.clear();
    await host.dispose();
    await Promise.allSettled([...runtimes.values()].flatMap(runtime => Object.values(runtime.registry?.backends ?? {}).map(backend => backend.dispose?.())));
  });
}

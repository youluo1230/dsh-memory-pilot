import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { resolve } from 'node:path';
import { createOrchestrator } from './core.mjs';
import { acceptsWorkspacePath, bindingsForIdentity, detectIdentity, matchWorkspace } from './configuration.mjs';
import { createOpenAICompatibleDecision, createSystemOneDecision } from './adapters.mjs';
import { createRegistry } from './registry.mjs';
import { attachHost } from './host.mjs';
import { commandSafety, loadDecisionPoints, memoryRead, memoryWrite, sessionDistill } from './decision-points.mjs';
import { askPoint } from './decision-executor.mjs';
import { createToolGuard, createMonotonicRefusal, callFamily } from './tool-guard.mjs';
import { createDistillTrigger, cutCandidates, distillTurn, factKey, pickDistillTarget } from './distillation.mjs';
import { createActivityLog } from './activity.mjs';
import { resolveAutomationTier } from './decision-layer.mjs';
import { installSettingsRpc } from './settings-rpc.mjs';
import { testDecisionConnection, testSystemConnection } from './connection-test.mjs';
import { registerMemoryTools } from './tools.mjs';
import { createResidentMemory } from './resident-memory.mjs';
import { createRetentionRouter, safeReason } from './retention-router.mjs';
import { resolveApiKey } from './secret.mjs';
import { createDecisionTrail, toDecisionEntry } from './trail.mjs';

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

// Whether a finished turn should be handed to a backend's `captureTurn`.
//
// This used to be `backends.some(b => b.scope === 'global' && b.write === true)`,
// which describes configuration rather than what will happen. With the plugin
// disabled — or with a profile whose only global-capable backend cannot capture
// (Hindsight has no turn-capture endpoint) — the host still admitted every turn
// and paid the full capture budget to reach a registry that did nothing.
//
// Exported so the gate can be tested without constructing a live backend.
export function shouldCapture({ disposed = false, enabled = false, backends = [] } = {}) {
  if (disposed || enabled !== true) return false;
  // Any writable backend counts: a project repository stores turns too, and
  // requiring `global` kept project stores permanently empty.
  return Array.isArray(backends) && backends.some(binding => binding?.write === true);
}

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
  // Tool safety now intercepts at `tools/pre-execute` instead of advising at turn
  // level. On by default because a per-call veto that is off is worse than one that
  // is on and occasionally noisy — the noise is one approval prompt, the silence is
  // a deleted file.
  safetyEnabled: Schema.boolean().default(true),
  // The author's default for the safety point, and the ceiling on how autonomous a
  // user may make it. A user can tighten (`silent-visible`/`ask`); the resolver
  // clamps anything looser back to the author's tier.
  // The effective tier for tool safety. Shipped at `ask`: interruption on a
  // destructive call is the safer default, and a user who finds it noisy tightens
  // toward `silent-visible`. `resolveAutomationTier` takes the stricter of this and
  // the declaration's, so neither side can loosen the other past the author's floor.
  safetyTier: Schema.union(['silent', 'silent-visible', 'ask']).default('ask'),
  // Which severities are worth interrupting for, lowest to highest. The default asks
  // about destructive and out-of-scope work; a user who considers `unknown` risky
  // adds it, and one who trusts reversible work can narrow the list.
  safetyAskSeverities: Schema.array(Schema.union(['reversible', 'destructive', 'unknown', 'out-of-scope']))
    .default(['destructive', 'out-of-scope']),
  // Whether a severity the tier decided not to ask about still leaves a record.
  safetyRecordUnasked: Schema.boolean().default(true),
  // Which decision points are active. Turning one off must stop it ASKING, not just
  // hide a row — a disabled point that still questions the model spends tokens and can
  // still act, which is the failure this switch exists to exclude.
  disabledPoints: Schema.array(Schema.string()).default([]),
  // User-declared decision points. Validated with the same rules as the built-in
  // ones, so a broken declaration fails at load instead of judging nonsense.
  decisionPoints: Schema.any().default([]),
  // Session distillation: selecting what a finished conversation concluded, rather
  // than storing the whole conversation stream. Off-feed by default is wrong here —
  // the plugin's whole complaint was that it only ever queried — so this defaults on.
  distillEnabled: Schema.boolean().default(true),
  // The fallback for a conversation that is never archived. Zero disables it, which
  // makes archiving the only trigger.
  distillTurnThreshold: Schema.number().min(0).max(200).default(8),
  distillBudgetMs: Schema.number().min(100).max(300000).default(30000).volatile(),
  decisionKeyEnv: Schema.string().default('MEMORY_DECISION_API_KEY').volatile(),
  // Literal key fallback. Many deployments cannot inject env vars into the DSH
  // service, so the settings panel must be able to hold the key itself. When
  // both are present the env var wins and this field is only a fallback.
  decisionApiKey: Schema.string().default('').role('secret').volatile(),
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

/**
 * Normalize the user's declared decision points into an array.
 *
 * The setting is free-form (`Schema.any()`) because a declaration is a document,
 * not a scalar. A malformed one must fail loudly at load — that is the whole point
 * of validating — so this only shapes the value, never repairs it.
 */
export function normalizeDeclarations(value) {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

export function apply(ctx, config) {
  debug('apply called');
  const current = () => resolveConfig(config);
  // The recent-activity record lives for the whole plugin lifetime so a user can ask
  // "is this working" after any number of turns.
  const activity = createActivityLog({ limit: 50 });
  // The declarations the settings panel may edit. The runtime reads these objects,
  // so a change here is a change to behaviour rather than to a display.
  const declaredPoints = () => {
    const off = new Set(Array.isArray(current().disabledPoints) ? current().disabledPoints.filter(name => typeof name === 'string') : []);
    const points = loadDecisionPoints([
      memoryRead, memoryWrite, commandSafety, sessionDistill,
      ...(normalizeDeclarations(current().decisionPoints)),
    ]);
    return points.filter(point => !off.has(point.name));
  };
  const pointEnabled = name => {
    const off = current().disabledPoints;
    return !(Array.isArray(off) && off.includes(name));
  };
  const residentMemory = createResidentMemory();
  const residentSnapshots = new WeakMap();
  const residentLoads = new WeakMap();
  // Decisions are published to the Trajectory through a session projection, not
  // through a custom session event (see src/trail.mjs for why). The projection is
  // optional: a profile without `sessionProjections` keeps working, it just shows
  // nothing in the Trajectory.
  const trail = createDecisionTrail();
  // Set before any teardown. Async work started by an earlier turn (a capture
  // resuming after turn/end, a pending snapshot, a tool still in flight) can
  // run after this plugin's fiber was disposed. Cordis then throws
  // `cannot get required service "..." in inactive context` for any injected
  // service read on the old ctx; that exception escapes into the host and fails
  // the whole turn. Every late path checks this flag and stands down instead.
  let disposed = false;
  let configHash = '';
  const runtimes = new Map();
  // Reading an injected service on a disposed fiber throws before optional
  // chaining can help, so absence must be probed defensively.
  const service = name => {
    if (disposed) return undefined;
    try { return ctx[name] ?? undefined; } catch { return undefined; }
  };
  // Audit and trace records are written from turn-time paths that can outlive
  // the fiber, so logging is best-effort and never throws.
  const log = (level, line) => {
    if (disposed) return;
    try { ctx.logger?.[level]?.(line); } catch { /* observability only */ }
  };
  const workspaceList = () => {
    const registry = service('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return undefined;
    try { return registry.list(); } catch { return undefined; }
  };
  const disposeRuntimes = entries => void Promise.allSettled(entries.flatMap(runtime =>
    Object.values(runtime.registry?.backends ?? {}).map(backend => backend.dispose?.())));
  const prepared = () => {
    const resolved = current();
    // After teardown the config is still readable, but runtimes are already
    // disposed; skip the diff/recycle so late callers get a usable snapshot
    // without resurrecting backends.
    if (disposed) return resolved;
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
    const listed = workspaceList();
    if (Array.isArray(listed)) return matchWorkspace(cwd, listed);
    return acceptsWorkspacePath(resolved.workspacePath, cwd)
      ? { id: resolved.workspaceId || resolved.workspacePath, path: resolved.workspacePath }
      : undefined;
  };
  // A runtime is keyed by project+workspace identity, so "can this profile build
  // one" is answered against any admitted workspace. The capture predicate needs
  // that answer without owning a session; an empty list means there is nothing
  // to be enabled for yet.
  const anyWorkspacePath = resolved => {
    const listed = workspaceList();
    if (Array.isArray(listed)) return listed[0]?.path;
    return acceptsWorkspacePath(resolved.workspacePath, resolved.workspacePath ?? '') ? resolved.workspacePath : undefined;
  };
  const resolveProjectRef = reference => {
    if (typeof reference !== 'string') throw new Error('Unknown resident memory project');
    const split = reference.indexOf('::');
    const listed = split >= 0 ? workspaceList() : undefined;
    if (Array.isArray(listed)) {
      const workspaceId = reference.slice(0, split), relativePath = reference.slice(split + 2);
      const workspace = listed.find(row => String(row.id) === workspaceId);
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
    // Identity is derived from the workspace registry, so a disposed generation
    // reports no identity instead of throwing.
    if (disposed) return {};
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
    // Late work from a disposed generation must not rebuild runtimes or read
    // services; the host treats `null` as "memory is off for this turn".
    if (disposed) return null;
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
    const apiKey = resolveApiKey({ keyEnv: resolved.decisionKeyEnv, apiKey: resolved.decisionApiKey }).value;
    // The declarations, read live. This is the wiring whose absence made the whole
    // premise false: the adapter used to build its questionnaire from private
    // literals, so editing `memory.write`'s criteria in settings changed nothing at
    // runtime. Passing the declarations here is what makes them the only source —
    // `memoryPointsFor` re-reads them per call, so an edit takes effect immediately.
    const memoryPointsFor = () => {
      const all = declaredPoints();
      // A disabled point is absent from the map entirely, so the questionnaire drops
      // its questions rather than asking them and ignoring the answer.
      return {
        read: all.find(point => point.name === 'memory.read'),
        write: all.find(point => point.name === 'memory.write'),
      };
    };
    const decision = usesDecision
      ? createDecision({ baseUrl: resolved.decisionBaseUrl, model: resolved.decisionModel, apiKey, points: memoryPointsFor })
      : null;
    const orchestrator = registry && decision ? createOrchestrator({
      decision, backends: registry.backends, policy: registry.policy, budgetMs: resolved.budgetMs,
      onAudit: record => log('info', `MemoryPilot ${JSON.stringify(record)}`),
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
        onAudit: record => log('info', `MemoryPilot ${JSON.stringify(record)}`) }) : undefined;
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
    // `decision` must be on the runtime object. Three call sites read it — tool
    // safety, session distillation, and the retention router — and it used to be
    // omitted, so `runtime.decision` was `undefined` and both the per-call veto and
    // distillation silently never ran. That is precisely the failure mode this change
    // set exists to remove: wiring that exists but is unreachable looks present in
    // every test that injects its own collaborator.
    const runtime = { registry, orchestrator, retentionRouter, directRetrieve, directRetain, decision, autonomous: !usesDecision };
    runtimes.set(key, runtime);
    debug(`memory runtime built for ${identity.projectId}:${identity.workspaceId} mode=${usesDecision ? 'decision' : 'autonomous'}`);
    return runtime;
  };
  const initial = prepared();
  if (initial.enabled && (initial.decisionEnabled === false
    || (initial.decisionBaseUrl && initial.decisionModel))) {
    const listed = workspaceList();
    const firstPath = Array.isArray(listed) ? listed[0]?.path : initial.workspacePath;
    if (firstPath) runtimeFor({ header: { cwd: firstPath } }); // preserve fail-fast configuration
  }
  const disposeSettingsRpc = installSettingsRpc(ctx, {
    getConfig: current,
    residentMemory,
    // "Is memory working?" — the rows distinguish a query from a write, and each
    // carries its outcome, so a silent failure stops looking like an empty result.
    activity: () => activity.list(),
    points: () => declaredPoints(),
    resolveIdentity: reference => identityFor({ header: { cwd: resolveProjectRef(reference) } }),
    onAudit: record => log('info', `MemoryPilot ${JSON.stringify(record)}`),
    // One-shot probes for the settings UI "测试" buttons. They receive the
    // DRAFT (possibly unsaved) config and must not touch runtimes or state.
    testConnection: async ({ kind, config }, { signal } = {}) => {
      if (kind === 'decision') return testDecisionConnection(config, { signal, timeoutMs: 10_000 });
      return testSystemConnection(config, { signal, timeoutMs: 10_000 });
    },
  });
  const acceptsSession = session => {
    // Reached from agent/pre-step on every user message, so a stale generation
    // hits it immediately after a config reload. Standing down here is what
    // stops the turn from failing with an inactive-context error.
    if (disposed) return false;
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
    if (disposed) return undefined;
    if (residentSnapshots.has(session)) return residentSnapshots.get(session);
    if (residentLoads.has(session)) return residentLoads.get(session);
    const load = residentMemory.snapshot(identityFor(session))
      // A read that lands after teardown resolves to "no resident memory" rather
      // than keeping a rejected promise in the shared load map.
      .catch(error => { if (disposed) return undefined; throw error; })
      .then(snapshot => { if (snapshot) residentSnapshots.set(session, snapshot); return snapshot; });
    residentLoads.set(session, load);
    try { return await load; } finally { residentLoads.delete(session); }
  };
  const disposeTools = registerMemoryTools(ctx, { runtimeFor: runtimeWithResidentFor, identityFor, acceptsSession, residentSnapshotFor: snapshotFor,
    // Tool-driven retrieval bypasses the message-path decision gate, so it gets
    // the capture budget rather than the interactive decision budget.
    retrieveBudgetMs: current().captureBudgetMs ?? 60000, rememberBudgetMs: current().captureBudgetMs ?? 60000 });
  const personaDisposers = new Map();
  const disposePersona = ctx.on('agent/created', ({ agent }) => {
    // Track the live agent for the session, so a tool-safety approval can name the
    // agent it asks on behalf of and the archive hook can recover the conversation.
    if (agent?.session) {
      agents.set(agent.session, agent);
      liveSessions.set(String(agent.session.id), agent.session);
    }
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
    agents.delete(session);
    liveSessions.delete(String(session.id));
  });
  // Accumulate the transcript for archive-time distillation. Bounded to the last
  // few turns: an archived session can span hours, and distillation judges the
  // conclusions near its end rather than reliving the whole log.
  const accumulate = (session, event) => {
    // The two events carry their payload differently: `user/message` IS the message,
    // while `assistant/message` wraps it with turn/step. Reading the wrong one
    // produced an empty transcript, so archive-time distillation had nothing to cut.
    const message = event?.type === 'user/message' ? event : event?.data?.message;
    const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : undefined;
    if (!message) return;
    const entry = sessionTranscript.get(session.id) ?? { userText: '', assistantText: '', turn: 0 };
    if (turn !== undefined) entry.turn = turn;
    const body = Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n')
      : '';
    if (!body.trim()) return;
    if (event.type === 'user/message') entry.userText = body.slice(0, 2000);
    if (event.type === 'assistant/message') entry.assistantText = body.slice(0, 4000);
    sessionTranscript.set(session.id, entry);
  };
  const disposeAccumulate = ctx.on('session/event', accumulate);
  // Publish decisions to the Trajectory through the supported projection channel.
  // Registration is an effect on this fiber, so unloading the plugin removes the
  // key and Clients read it as capability absence instead of showing stale rows.
  // The service is optional: without it the plugin works and the Trajectory simply
  // shows no memory rows.
  ctx.inject(['sessionProjections'], projectionCtx => {
    projectionCtx.effect(() => projectionCtx.sessionProjections.register(trail.definition), 'dsh-memory-pilot: decision trail projection');
  });
  // ---------------------------------------------------------------------------
  // Session distillation
  // ---------------------------------------------------------------------------
  const distillTrigger = createDistillTrigger({
    threshold: () => Number(current().distillTurnThreshold) || 0,
    enabled: () => current().distillEnabled !== false,
  });

  /**
   * Run distillation for one finished turn.
   *
   * Two things are deliberately kept out of the hot path: the judgment round trip
   * and the writes that follow it. Both run from a task the host does not await on
   * the turn path — the user already has their answer — and the archive hook is the
   * only place that waits, because an archive is a durability boundary.
   */
  const runDistillation = async ({ session, turn, userText, assistantText, reason, runtime, thresholdFire, force = false }) => {
    if (disposed) return undefined;
    // The threshold is what bounds cost per turn: below it a turn is left to turn
    // capture, and only the accumulated transcript is distilled at archive time (or
    // when the threshold fires). Running the two-level judgment on every turn would
    // spend a gate request on every message to learn "nothing durable here".
    if (!force && !thresholdFire) return undefined;
    const candidates = cutCandidates({ userText, assistantText, reason: reason?.kind });
    if (!candidates.length) return { gate: 'discarded', candidates: 0, retained: [], failed: [], durationMs: 0, reason: 'no-candidates', candidateTexts: [] };
    const snapshot = residentSnapshots.get(session);
    const startedAt = performance.now();
    try {
      const report = await distillTurn({
        turn: { userText, assistantText, reason: reason?.kind },
        candidates,
        resident: snapshot?.resident ?? {},
        decideBatch: async ({ state, questions }) => {
          const [response] = await runtime.decision.decideBatch([{ id: 'session.distill', state, questions }], { signal: AbortSignal.timeout(distillBudget()) });
          const answers = {};
          for (const name of Object.keys(questions)) {
            const answer = response?.answers?.[name];
            if (!answer || typeof answer.choice !== 'string') continue;
            if (!Object.hasOwn(questions[name].criteria, answer.choice)) continue;
            answers[name] = answer.choice;
          }
          return answers;
        },
        retain: async ({ candidate, forceExternal }) => {
          // The target is chosen first because the key is derived per target: the same
          // fact in a different store is a different row, while a correction in the
          // same store must collide with the fact it replaces.
          const target = forceExternal ? 'external'
            : pickDistillTarget({ candidate, identity: identityFor(session) });
          if (target === 'external') return { target: 'external', status: 'ok', ...(await retainExternal(session, candidate)) };
          const saved = await retainResident({ session, target, key: factKey({ scope: target, text: candidate.text, explicit: candidate.key }), content: candidate.text });
          return { target, status: saved?.degraded ? 'degraded' : 'ok' };
        },
      });
      report.candidateTexts = candidates.map(candidate => candidate.text.slice(0, 200));
      const durationMs = Math.max(0, performance.now() - startedAt);
      report.durationMs = durationMs;
      activity.record({ kind: 'distill', status: report.retained.length ? 'ok' : 'noop', durationMs,
        ...(report.retained.length ? { target: report.retained[0].target } : {}),
        ...(report.failed.length && !report.retained.length ? { status: 'error', reason: report.failed[0].reason } : {}),
        hitCount: report.retained.length });
      if (report.failed.length) log('warn', `MemoryPilot distill_partial_failed count=${report.failed.length} reason=${report.failed[0]?.reason ?? 'unknown'}`);
      return report;
    } catch (error) {
      // Distillation runs after the answer, so a failure here must never surface as
      // a turn error. It must, however, leave a trace: silence was the original bug.
      const durationMs = Math.max(0, performance.now() - startedAt);
      log('warn', `MemoryPilot distill_failed reason=${safeReason(error)}`);
      activity.record({ kind: 'distill', status: 'error', reason: safeReason(error), durationMs });
      return { gate: 'keep', candidates: candidates.length, retained: [], failed: [{ reason: safeReason(error) }], durationMs, reason: 'failed', candidateTexts: candidates.map(candidate => candidate.text.slice(0, 200)) };
    }
  };

  /**
   * Where a distilled candidate belongs.
   *
   * The target names are resident-memory targets (`RESIDENT_TARGETS`), not the
   * memory-scope vocabulary: distillation writes into the always-visible files, and
   * `external` is the fallback when they are full. Choosing between them uses only
   * the identity this session actually has — an earlier version built a fake session
   * with an empty cwd just to ask whether a project existed, which answered "no" for
   * every session and silently sent every repository fact to global memory.
   */
  const retainResident = async ({ session, target, key, content }) => {
    const identity = identityFor(session);
    const snapshot = residentSnapshots.get(session);
    const revisionKey = { user: 'user', 'global-memory': 'global', 'project-memory': 'project' }[target];
    const expected = snapshot?.writeRevisions?.[revisionKey];
    try {
      const saved = await residentMemory.apply({ target, key: key ?? `distilled-${Date.now()}`, content, actor: 'agent' }, expected, identity);
      if (snapshot?.writeRevisions && typeof saved?.revision === 'string') snapshot.writeRevisions[revisionKey] = saved.revision;
      return saved;
    } catch (error) {
      // A full file is reported to the caller, which degrades to the external store
      // rather than losing the fact.
      throw error;
    }
  };

  const retainExternal = async (session, candidate) => {
    const runtime = runtimeFor(session);
    if (!runtime?.directRetain) return { accepted: 0 };
    const identity = identityFor(session);
    // The distilled candidate IS the event: retention evidence must be the text being
    // stored, so the fact travels as its own evidence rather than as a quote into
    // some larger message.
    const event = { ...identity, sessionId: session.id, id: `distill:${Date.now()}`, type: 'turn_end', text: candidate.text };
    await runtime.directRetain(event, { budgetMs: distillBudget() });
    return { accepted: 1 };
  };

  const distillBudget = () => Number(current().distillBudgetMs) || 30000;

  // ---------------------------------------------------------------------------
  // Tool safety, at the per-call extension point
  // ---------------------------------------------------------------------------
  const safetyDenied = new Set();
  // The trace sink is wired into the host below; the guard runs on tool dispatch,
  // which is later, so it reads the sink through this holder rather than needing it
  // at construction time.
  const traceSink = { current: () => {} };
  const guardFor = session => {
    const runtime = runtimeFor(session);
    if (!runtime?.decision || !pointEnabled('command.safety')) return undefined;
    return createToolGuard({
      judge: async ({ toolName, args, exec }) => {
        // The declared command.safety point judges the call. It reports severity;
        // the tier decides whether that severity is worth asking about.
        const context = `${toolName} ${safeJson(args)}`.slice(0, 2000);
        const asked = await askPoint(commandSafety, {
          decision: runtime.decision,
          state: { context },
          timeoutMs: Math.min(4000, Number(current().decisionTimeoutMs) || 4000),
        }).catch(() => undefined);
        if (!asked) return undefined;
        const severity = asked.answers.find(answer => answer.name === 'severity')?.choice;
        if (typeof severity !== 'string') return undefined;
        try {
          Promise.resolve(traceSink.current(session, asked.trace, { turn: 0, step: 0, question: context })).catch(() => {});
        } catch { /* observability must not alter execution */ }
        const confidence = asked.answers.find(answer => answer.name === 'severity')?.confidence;
        return { severity, ...(Number.isFinite(confidence) ? { confidence } : {}) };
      },
      approve: async ({ toolName, callId, reason, signal }) => {
        const approval = service('approval');
        // No approval service means nobody can say yes. Denying is the only honest
        // answer; assuming yes is how a safety feature quietly stops safetying.
        if (!approval || typeof approval.request !== 'function') return 'unavailable';
        try {
          const outcome = await approval.request({ agent: currentAgentFor(session), toolName, callId, reason, signal });
          return outcome;
        } catch { return 'unavailable'; }
      },
      tier: () => {
        // Author tier is the ceiling: a user may only tighten it.
        try { return resolveAutomationTier({ authorTier: commandSafety.automation, userTier: current().safetyTier ?? commandSafety.automation }); }
        catch { return commandSafety.automation; }
      },
      // The configured severity threshold, re-read per call so a change takes effect
      // without remounting.
      askFrom: () => {
        const configured = current().safetyAskSeverities;
        return Array.isArray(configured) && configured.length ? configured : ['destructive', 'out-of-scope'];
      },
      record: row => {
        if (current().safetyRecordUnasked === false && row.status === 'allowed') return;
        activity.record(row);
      },
    });
  };
  // The current agent per session, for the approval request. An approval must name
  // the agent it is asked on behalf of, and the tool execution carries it — this map
  // is only a fallback for the paths that do not.
  const agents = new Map();
  const currentAgentFor = session => agents.get(session) ?? (session?.agent ?? undefined);
  const safeJson = value => {
    try { const text = JSON.stringify(value); return text === undefined ? '' : text; } catch { return ''; }
  };

  /**
   * Publish one decision to the log and the Trajectory projection.
   *
   * This is the single sink: the host's turn path, the distillation path and the
   * tool guard all reach it, so every judgment type is recorded the same way and the
   * decision record's `kind` is the only thing that differs.
   */
  const recordTrace = (session, trace, location = {}) => {
    if (!trace || typeof trace !== 'object') return;
    const scope = trace.executions?.[0]?.scope ?? 'none';
    const engine = trace.executions?.[0]?.engine ?? 'none';
    const operation = trace.executions?.[0]?.operation ?? 'none';
    log('info', `MemoryPilot ${trace.kind} ${trace.status}: ${scope} ${engine} ${operation} turn=${location.turn ?? 0}${location.step ? ` step=${location.step}` : ''}`);
    // Hand the decision to the projection. It is folded into the Session's
    // published trail by the first committed event of this step, so the
    // Trajectory shows what the decision model was asked and chose.
    // Every trace is also an activity row. The Trajectory is for reading a
    // decision; the activity list answers "has this done anything at all", and a
    // failed retrieval belongs there even when the turn itself succeeded.
    try {
      const rows = Array.isArray(trace.executions) ? trace.executions : [];
      if (trace.kind === 'retrieval' || trace.kind === 'retention') {
        for (const row of rows) {
          activity.record({
            kind: row.operation === 'write' ? 'retain' : 'query',
            status: row.response?.status === 'ok' ? 'ok' : (row.response?.status ?? 'error'),
            scopes: row.scope ? [row.scope] : [],
            durationMs: Number.isFinite(row.durationMs) ? row.durationMs : 0,
            ...(Number.isFinite(row.response?.hitCount) ? { hitCount: row.response.hitCount } : {}),
          });
        }
        if (!rows.length) {
          activity.record({ kind: trace.kind === 'retention' ? 'retain' : 'query',
            status: trace.status === 'ok' ? 'ok' : (trace.status ?? 'noop'),
            scopes: [], durationMs: Number.isFinite(trace.totalDurationMs) ? trace.totalDurationMs : 0 });
        }
      }
    } catch { /* observability must not alter execution */ }
    if (disposed) return;
    try {
      trail.record({
        sessionId: session?.id,
        ...toDecisionEntry(trace, {
          id: `${session?.id ?? 'session'}:${location.turn ?? 0}:${location.step ?? 0}:${trace.kind ?? 'decision'}`,
          turn: location.turn,
          step: location.step,
          // The orchestrator records the exact text its decision saw; the
          // step's user text is a fallback for traces that predate that.
          question: trace.question ?? location.question ?? '',
        }),
      });
    } catch { /* observability must not alter execution */ }
  };

  const host = attachHost(ctx, {
    orchestratorFor: session => runtimeFor(session)?.orchestrator,
    residentSnapshotFor: snapshotFor,
    // The outer leash must be generous enough that the inner orchestrator deadline
    // fires first and produces a shaped `timeout` result: an outer abort that wins
    // the race leaves the caller with an opaque cancellation instead. The floor is
    // therefore the configured budget plus headroom for the decision round-trip,
    // NOT a constant — the previous hard 60 000 (with a 30 000 schema maximum)
    // made the budget slider inert for every value a user could actually pick.
    retrievalBudgetMs: () => {
      const inner = Number(current().budgetMs);
      const shaped = Number.isFinite(inner) && inner > 0 ? inner : 9000;
      return shaped + Math.max(15000, Math.round(shaped * 0.5));
    },
    capture: () => {
      // Two layers: the exported policy gate (config-only, testable in isolation)
      // and a runtime check, because a configured binding is not a usable one —
      // `runtimeFor` returns null when the decision endpoint is missing.
      const resolved = prepared();
      if (!shouldCapture({ disposed, enabled: resolved.enabled, backends: resolved.backends })) return false;
      const cwd = anyWorkspacePath(resolved);
      return cwd !== undefined && runtimeFor({ header: { cwd } }) !== null;
    },
    captureTurn: turn => runtimeFor(turn.session)?.registry?.captureTurn(turn),
    captureBudgetMs: () => current().captureBudgetMs ?? 60000,
    // The command-safety point runs on every turn, independent of whether memory
    // was consulted. It gets a short leash of its own: safety advice that arrives
    // after the model already acted is worth nothing, so a slow judgment is
    // dropped rather than awaited.
    // Session distillation. This is the selection step the plugin never had: what a
    // finished conversation concluded, chosen by the judgment layer from candidates
    // the plugin cut. It runs after the answer, so nothing here can slow a turn.
    distill: ({ session, turn, userText, assistantText, reason }) => {
      const resolved = prepared();
      if (resolved.distillEnabled === false || !pointEnabled('session.distill')) return undefined;
      const runtime = runtimeFor(session);
      if (!runtime?.decision) return undefined;
      // The threshold fallback exists because most conversations are never
      // archived. Without it, closing the browser loses everything since the last
      // explicit end-of-session signal. Only a turn that produced an answer is
      // durable: an aborted or errored turn has nothing to select from, and counting
      // it would let half-answers fill the threshold.
      const kind = typeof reason === 'string' ? reason : reason?.kind;
      const durable = kind !== 'aborted' && kind !== 'error';
      const thresholdFire = distillTrigger.countTurn(session.id, { durable });
      return runDistillation({ session, turn, userText, assistantText, reason, runtime, thresholdFire });
    },
    capturesTurn: () => current().distillEnabled !== false,
    acceptsSession,
    identity: identityFor,
    // `references` is what makes the Chat UI render a `recall` source as a
    // readable "recalled from …" row. Without it the surface falls back to
    // opaque, i.e. the raw untrusted-envelope JSON, which is what a user saw
    // instead of a memory summary.
    createMessage: (text, meta = {}) => createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin:dsh-memory-pilot', form: 'recall',
        references: [{
          label: typeof meta.label === 'string' && meta.label ? meta.label : 'MemoryPilot 召回',
          retainedMessages: Number.isSafeInteger(meta.count) ? meta.count : 0,
          omittedMessages: 0,
          truncated: meta.truncated === true,
        }],
        // The decision itself, carried on the injected message so it lands in the
        // Session log. The projection only held decisions in an in-memory pending
        // table, so a restart rebuilt the projection from the log, found no
        // pending entries, and showed an empty decision log for sessions whose
        // decisions had already happened.
        ...(meta.decision && typeof meta.decision === 'object' ? { decision: meta.decision } : {}),
      },
    }),
    // rc.2 read path (dsh-session-persistence-jsonl validateStoredEvents) refuses any
    // event type outside its built-in vocabulary unless marked ignorable, and rc.2
    // append() offers no way to set that marker — appending a custom type here would
    // poison the session log (history fails to load). Audit goes to the harness log;
    // the trajectory client keeps rendering legacy plugin/observation events.
    onResidentSnapshot: (session, snapshot, location = {}) => {
      const sources = Object.entries(snapshot.resident).filter(([,value])=>Boolean(value)).map(([scope,value])=>`${scope}:${value.length}`).join(',') || 'none';
      log('info', `MemoryPilot resident memory loaded turn=${location.turn ?? 0} sources=${sources} soul=${Boolean(snapshot.soul)}`);
    },
    onTrace: recordTrace,
    onError: code => log('warn', `MemoryPilot ${code}`),
  });
  // The tool guard judges on tool dispatch, which happens after this point; it
  // publishes through the same sink the host uses so tool-safety decisions reach
  // the decision log rather than existing only in memory.
  traceSink.current = recordTrace;
  // Which live session each id refers to. The archive hook receives only an id, so
  // this map is how it recovers the conversation it is about to close.
  const liveSessions = new Map();
  const liveSessionFor = sessionId => liveSessions.get(String(sessionId));
  // The accumulated conversation per session, for the archive-time distillation.
  // Bounded by turn: a long session keeps only its most recent turns, because the
  // conclusions that matter are near the end and the judged state has a hard
  // character cap anyway.
  const sessionTranscript = new Map();
  /**
   * Distill a whole conversation when it is archived.
   *
   * The turn threshold exists for conversations that are never archived; this is
   * the strong signal. It uses the accumulated transcript of the session rather than
   * one turn, because an archive is the moment the conversation as a whole becomes a
   * closed unit and its conclusions are what matter.
   */
  const archiveDistill = async session => {
    const transcript = sessionTranscript.get(session.id);
    if (!transcript || (!transcript.userText && !transcript.assistantText)) return undefined;
    const runtime = runtimeFor(session);
    if (!runtime?.decision) return undefined;
    const report = await runDistillation({
      session, turn: transcript.turn ?? 0,
      userText: transcript.userText, assistantText: transcript.assistantText,
      reason: { kind: 'archived' }, runtime, thresholdFire: true, force: true,
    });
    if (report?.retained?.length) log('info', `MemoryPilot distilled_on_archive retained=${report.retained.length}`);
    return report;
  };

  // ---------------------------------------------------------------------------
  // `tools/pre-execute`: the per-call veto
  // ---------------------------------------------------------------------------
  // This is the extension point the docs wrongly said did not exist. Being here
  // instead of at `agent/pre-step` is the change that turns the safety judgment from
  // advice the model may ignore into a decision the registry enforces.
  const disposeToolGate = ctx.on('tools/pre-execute', async (exec, next) => {
    if (disposed) return next();
    try {
      const session = exec?.agent?.session;
      if (!session || !acceptsSession(session)) return next();
      if (current().safetyEnabled === false || current().decisionEnabled === false) return next();
      const guard = guardFor(session);
      if (!guard) return next();
      const decision = await guard.gate(exec);
      if (decision.kind === 'allow') return next();
      // A refusal is pinned so a downstream listener cannot turn it back into
      // permission — but a guard pin is permanent, and pinning every refusal would
      // make a family the user rejected once unaskable forever. So the pin is keyed
      // by the exact CALL, and lifted once the registry has consumed it: the pin only
      // has to survive until the guard chain runs for this one call.
      const callId = String(exec?.callId ?? callFamilyOf(exec));
      safetyDenied.add(callId);
      // `queueMicrotask` is enough: the registry resolves guards synchronously after
      // the waterfall settles, before the tool body runs.
      queueMicrotask(() => safetyDenied.delete(callId));
      return decision;
    } catch {
      // A gate that throws must not fail the tool call; the registry's own default
      // applies. The failure is still visible through the activity list.
      log('warn', 'MemoryPilot tool_gate_failed');
      return next();
    }
  });
  const callFamilyOf = exec => {
    try { return callFamily(exec?.name, exec?.arguments); } catch { return String(exec?.name ?? 'unknown'); }
  };
  const disposeGuard = ctx.effect
    ? ctx.effect(() => {
        // The monotonic layer: it can only deny, so no later listener can turn a
        // refusal back into permission.
        const tools = service('tools');
        if (!tools || typeof tools.guard !== 'function') return () => {};
        return tools.guard(createMonotonicRefusal(safetyDenied, exec => String(exec?.callId ?? callFamily(exec?.name, exec?.arguments))));
      })
    : () => {};

  // ---------------------------------------------------------------------------
  // End of session: the archive signal
  // ---------------------------------------------------------------------------
  // Archiving is the user saying "this conversation is over", and it is the only
  // end-of-session signal the platform offers. It is also awaitable before the
  // archive set is written, which is what lets distillation finish while the
  // session's context is still live.
  const disposeArchive = ctx.on('workspace/session-activity', async (request, next) => {
    if (disposed) return next();
    const sessionId = request?.sessionId;
    if (!sessionId || current().distillEnabled === false) return next();
    const session = liveSessionFor?.(sessionId);
    if (!session) return next();
    try {
      await archiveDistill(session);
      distillTrigger.markArchived(sessionId);
    } catch (error) {
      // A failed distillation must not block the archive: the user asked to close
      // the conversation, not to guarantee a judgment succeeded.
      log('warn', `MemoryPilot distill_on_archive_failed reason=${safeReason(error)}`);
    }
    return next();
  });

  ctx.on('dispose', async () => {
    // Stand down first: in-flight captures and pending snapshots are awaited
    // below, and they must see a disposed plugin before they touch any service.
    disposed = true;
    disposeToolGate?.();
    disposeGuard?.();
    disposeArchive?.();
    disposeAccumulate?.();
    disposeSettingsRpc?.();
    disposeTools?.();
    disposePersona?.();
    disposePersonaSession?.();
    for (const off of personaDisposers.values()) off?.();
    personaDisposers.clear();
    const shuttingDown = [...runtimes.values()];
    runtimes.clear();
    trail.clear();
    // residentLoads is a WeakMap and has no clear(); its entries fall away with
    // the sessions that own them.
    await host.dispose();
    await Promise.allSettled(shuttingDown.flatMap(runtime => Object.values(runtime.registry?.backends ?? {}).map(backend => backend.dispose?.())));
  });
}

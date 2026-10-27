import { isResidentTarget, RESIDENT_TARGETS } from './resident-targets.mjs';
import { safeReason } from './retention-router.mjs';

export const SETTINGS_RPC_CHANNEL = '/dsh-memory-pilot-settings';
export const SETTINGS_NAMESPACE = 'dsh-memory-pilot';

const ALLOWED_FIELDS = new Set([
  'enabled', 'decisionEnabled', 'workspacePath', 'projectId', 'actorId', 'workspaceId',
  'decisionBaseUrl', 'decisionModel', 'decisionProtocol', 'decisionKeyEnv', 'decisionApiKey', 'budgetMs',
  'captureBudgetMs', 'backends', 'scopeOverrides',
]);

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

const clean = value => typeof value === 'string' ? value.trim() : '';

function describeRow(settings, redacted) {
  return settings.describe(redacted ? { redactSecrets: true } : {}).find(item => item.ns === SETTINGS_NAMESPACE);
}

function descriptor(settings) {
  const row = describeRow(settings, true);
  if (!row) return undefined;
  // The platform deletes every `role('secret')` field before a settings view
  // reaches a browser; `secrets` only reports whether a slot is filled. A
  // password box therefore cannot show the stored value, and — worse — a draft
  // built from this view has no key to send, so the connection probe fails on
  // an endpoint that is actually configured. Read the unredacted row here and
  // ship the secret values alongside the view so the panel can display them.
  return { ...row, writable: settings.writable === true, secretValues: secretValues(settings) };
}

// Collect the current value of every secret slot the panel may edit. Only the
// fields this plugin declares `role('secret')` are exposed; nothing else.
function secretValues(settings) {
  let row;
  try { row = describeRow(settings, false); } catch { return {}; }
  const value = row && row.value && typeof row.value === 'object' ? row.value : {};
  const backends = Array.isArray(value.backends) ? value.backends : [];
  return {
    decisionApiKey: typeof value.decisionApiKey === 'string' ? value.decisionApiKey : '',
    backends: Object.fromEntries(backends
      .filter(backend => backend && typeof backend.id === 'string')
      .map(backend => [backend.id, typeof backend.apiKey === 'string' ? backend.apiKey : ''])),
  };
}

function validOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 32) return false;
  return ops.every(op => op && (op.op === 'set' || op.op === 'unset')
    && Array.isArray(op.path) && op.path.length > 0 && op.path.length <= 4
    && op.path.every(part => typeof part === 'string' && part.length > 0 && part.length <= 80)
    && ALLOWED_FIELDS.has(op.path[0]));
}

export function createSettingsRpcHandler(settings, { discover, createBank, testConnection, residentMemory, onAudit = () => {} } = {}) {
  const safeDiscover = typeof discover === 'function' ? discover : async () => ({ workspacePath: '', repositories: [], banks: [] });
  const safeCreateBank = typeof createBank === 'function' ? createBank : async () => { throw new Error('Bank creation unavailable'); };
  const safeTestConnection = typeof testConnection === 'function' ? testConnection : async () => { throw new Error('Connection testing unavailable'); };
  return async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'Request was cancelled');
    if (endpoint === 'get') {
      try {
        const row = descriptor(settings);
        return row ? { ok: true, value: row } : fail('unavailable', 'MemoryPilot configuration is unavailable');
      } catch {
        return fail('internal', 'MemoryPilot configuration could not be read');
      }
    }
    if (endpoint === 'discover') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) return fail('bad-request', 'Invalid MemoryPilot discovery request');
      try { return { ok: true, value: await safeDiscover({ signal }) }; }
      catch { return fail('discovery-failed', 'MemoryPilot scope discovery failed'); }
    }
    if (endpoint === 'create-bank') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 2 || typeof payload.systemId !== 'string' || !payload.systemId
        || typeof payload.bank !== 'string' || !payload.bank || payload.bank !== payload.bank.trim()) {
        return fail('bad-request', 'Invalid Hindsight bank creation request');
      }
      try {
        const current = await safeDiscover({ signal });
        const legacyTargets = [...(current.workspaceTargets ?? []), ...(current.repositories ?? []).flatMap(repository => repository.targetBanks ?? [])];
        const workspaceTargets = (current.workspaces ?? []).flatMap(workspace => [
          ...(workspace.targets ?? []), ...(workspace.repositories ?? []).flatMap(repository => repository.targetBanks ?? []),
        ]);
        const targets = [...legacyTargets, ...workspaceTargets];
        const allowed = targets.some(target => target?.enabled !== false && target?.systemId === payload.systemId && target?.bank === payload.bank && target?.exists === false);
        if (!allowed) return fail('not-allowed', 'Hindsight bank target is not currently creatable');
        await safeCreateBank({ systemId: payload.systemId, bank: payload.bank }, { signal });
        return { ok: true, value: await safeDiscover({ signal }) };
      } catch {
        return fail('create-bank-failed', 'Hindsight bank creation failed');
      }
    }
    if (endpoint === 'test') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['kind', 'config'].includes(key))
        || (payload.kind !== 'decision' && payload.kind !== 'system')
        || !payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) {
        return fail('bad-request', 'Invalid MemoryPilot connection test request');
      }
      // The probe runs against the DRAFT config, and a draft built from a
      // redacted settings view carries no key at all. Sending that draft verbatim
      // made an authorised endpoint answer 401 while the stored key worked, so
      // the "test" button reported an error for a healthy configuration. Fall
      // back to the persisted secret whenever the draft does not supply one;
      // an explicitly typed key still wins, and an explicit empty string is
      // treated as "not supplied" because a password box cannot mean "clear".
      try {
        const stored = secretValues(settings);
        const config = { ...payload.config };
        if (payload.kind === 'decision' && !clean(config.decisionApiKey)) config.decisionApiKey = stored.decisionApiKey;
        if (payload.kind === 'system' && !clean(config.apiKey)) config.apiKey = stored.backends?.[config.id] ?? '';
        return { ok: true, value: await safeTestConnection({ ...payload, config }, { signal }) };
      }
      catch (error) {
        return fail('test-failed', error instanceof Error && error.message ? error.message : 'MemoryPilot connection test failed');
      }
    }
    if (endpoint === 'resident-get') {
      if (!residentMemory || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => key !== 'projectPath') || (payload.projectPath !== undefined && typeof payload.projectPath !== 'string')) return fail('bad-request','Invalid resident memory request');
      try { return { ok:true,value:await residentMemory.inspect({projectPath:payload.projectPath}) }; }
      catch { return fail('resident-read-failed','Resident memory could not be read'); }
    }
    if (endpoint === 'resident-put') {
      if (!residentMemory || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['target','content','revision','projectPath'].includes(key))
        || !isResidentTarget(payload.target)
        || typeof payload.content !== 'string' || typeof payload.revision !== 'string'
        || (payload.projectPath !== undefined && typeof payload.projectPath !== 'string')) return fail('bad-request','Invalid resident memory mutation');
      try {
        const value=await residentMemory.apply({target:payload.target,content:payload.content,actor:'human'},payload.revision,{projectPath:payload.projectPath});
        try { onAudit({kind:'resident-retention',actor:'human',target:payload.target,status:'ok',previousRevision:payload.revision,revision:value?.revision}); } catch { /* audit must never fail the write */ }
        return {ok:true,value};
      }
      catch (failure) {
        const reason = safeReason(failure);
        try { onAudit({kind:'resident-retention',actor:'human',target:payload.target,status:'error',reason}); } catch { /* audit must never fail the write */ }
        // A revision conflict is only one of several refusals. Telling the user to
        // "reload and try again" when the real cause is an over-length document
        // sends them round a loop that can never succeed: reloading cannot shrink
        // the text. Each reason gets its own actionable message instead.
        const message = {
          'revision-conflict': 'Resident memory changed in another session; reload and try again.',
          'exceeds-limit': `Resident memory is too long (limit ${RESIDENT_TARGETS[payload.target].maxLength} characters); shorten it before saving.`,
          'human-managed': 'This document is human-managed only and cannot be written by the agent.',
          'reserved-marker': 'Resident memory content contains a reserved marker comment.',
          'missing-file': 'Resident memory file is missing.',
        }[reason] ?? 'Resident memory could not be written; reload and try again';
        return fail('resident-write-failed', message);
      }
    }
    if (endpoint !== 'mutate') return fail('bad-request', 'Unknown MemoryPilot settings operation');
    if (!validOps(payload?.ops) || !Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
      return fail('bad-request', 'Invalid MemoryPilot configuration mutation');
    }
    try {
      await settings.mutate(SETTINGS_NAMESPACE, structuredClone(payload.ops), payload.revision);
      const row = descriptor(settings);
      return row ? { ok: true, value: row } : fail('unavailable', 'MemoryPilot configuration is unavailable');
    } catch {
      return fail('settings-rejected', 'MemoryPilot configuration was rejected');
    }
  };
}

// Cordis owns this message. Match its stable shape (the quoted service name and
// cordis's phrasing) rather than an unrelated substring; anything unrecognised
// is rethrown unchanged instead of being silently swallowed.
const WEB_SERVER_INJECT_ERROR = 'cannot get property "webServer" without inject';
function missingWebServerInject(error) {
  return error instanceof Error && error.message === WEB_SERVER_INJECT_ERROR;
}

function registerChannel(ctx, handler) {
  try {
    return ctx.connection.rpc.handle(SETTINGS_RPC_CHANNEL, handler);
  } catch (error) {
    if (!missingWebServerInject(error)) throw error;
    // `webServer` is in this plugin's inject list but its live getter is not
    // resolvable here. Serve it from a local waterfall for the duration of the
    // registration instead of failing; reading it again would throw the same
    // error, so probe defensively.
    let webServer;
    try { webServer = ctx.webServer; } catch { webServer = undefined; }
    if (!webServer) throw error;
    const listener = (_lookupCtx, prop, original, next) => {
      if (prop !== 'webServer') return next();
      try { return next(); } catch (failure) { if (failure !== original) throw failure; }
      return webServer;
    };
    const off = ctx.on('internal/get', listener, { global: true });
    try {
      return ctx.connection.rpc.handle(SETTINGS_RPC_CHANNEL, handler);
    } finally {
      off?.();
    }
  }
}

export function installSettingsRpc(ctx, { getConfig, discover, createBank, testConnection, residentMemory, resolveIdentity, onAudit } = {}) {
  if (!ctx?.connection?.rpc?.handle || !ctx?.settings) return () => {};
  // Discovery runs on behalf of the settings panel and can resume while the
  // plugin is being torn down, so the registry is probed defensively here too.
  const listedWorkspaces = () => {
    try {
      const registry = ctx.workspaceRegistry;
      if (!registry || typeof registry.list !== 'function') return undefined;
      return registry.list().map(({ id, path, title }) => ({ id: String(id), path, title }));
    } catch { return undefined; }
  };
  const safeDiscover = typeof discover === 'function' ? discover : async ({ signal } = {}) => {
    if (typeof getConfig !== 'function') return { workspacePath: '', repositories: [], banks: [] };
    const { discoverScope } = await import('./discovery.mjs');
    const workspaces = listedWorkspaces();
    return discoverScope(getConfig(), { signal, workspaces });
  };
  const safeCreateBank = typeof createBank === 'function' ? createBank : async (target, { signal } = {}) => {
    if (typeof getConfig !== 'function') throw new Error('Bank creation unavailable');
    const { createHindsightBank } = await import('./discovery.mjs');
    return createHindsightBank(getConfig(), target, { signal });
  };
  const scopedResident = residentMemory && typeof resolveIdentity === 'function' ? {
    inspect: identity => residentMemory.inspect(identity?.projectPath ? resolveIdentity(identity.projectPath) : {}),
    apply: (plan, revision, identity) => residentMemory.apply(plan, revision,
      RESIDENT_TARGETS[plan.target]?.requiresProject ? resolveIdentity(identity?.projectPath) : {}),
  } : residentMemory;
  return registerChannel(ctx, createSettingsRpcHandler(ctx.settings, { discover: safeDiscover, createBank: safeCreateBank, testConnection, residentMemory: scopedResident, onAudit }));
}

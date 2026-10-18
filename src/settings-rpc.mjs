import { isResidentTarget, RESIDENT_TARGETS } from './resident-targets.mjs';

export const SETTINGS_RPC_CHANNEL = '/dsh-memory-pilot-settings';
export const SETTINGS_NAMESPACE = 'dsh-memory-pilot';

const ALLOWED_FIELDS = new Set([
  'enabled', 'decisionEnabled', 'workspacePath', 'projectId', 'actorId', 'workspaceId',
  'decisionBaseUrl', 'decisionModel', 'decisionProtocol', 'decisionKeyEnv', 'budgetMs',
  'captureBudgetMs', 'backends', 'scopeOverrides',
]);

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function descriptor(settings) {
  const row = settings.describe({ redactSecrets: true }).find(item => item.ns === SETTINGS_NAMESPACE);
  if (!row) return undefined;
  return { ...row, writable: settings.writable === true };
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
      try { return { ok: true, value: await safeTestConnection(payload, { signal }) }; }
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
        try { onAudit({kind:'resident-retention',actor:'human',target:payload.target,status:'ok',previousRevision:payload.revision,revision:value?.revision}); } catch {}
        return {ok:true,value};
      }
      catch { try { onAudit({kind:'resident-retention',actor:'human',target:payload.target,status:'error'}); } catch {} return fail('resident-write-failed','Resident memory changed; reload and try again'); }
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

function missingWebServerInject(error) {
  return error instanceof Error && /webServer/.test(error.message) && /without inject/.test(error.message);
}

function registerChannel(ctx, handler) {
  try {
    return ctx.connection.rpc.handle(SETTINGS_RPC_CHANNEL, handler);
  } catch (error) {
    if (!missingWebServerInject(error) || !ctx.webServer) throw error;
    const listener = (_lookupCtx, prop, original, next) => {
      if (prop !== 'webServer') return next();
      try { return next(); } catch (failure) { if (failure !== original) throw failure; }
      return ctx.webServer;
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
  const safeDiscover = typeof discover === 'function' ? discover : async ({ signal } = {}) => {
    if (typeof getConfig !== 'function') return { workspacePath: '', repositories: [], banks: [] };
    const { discoverScope } = await import('./discovery.mjs');
    const workspaces = typeof ctx.workspaceRegistry?.list === 'function'
      ? ctx.workspaceRegistry.list().map(({ id, path, title }) => ({ id: String(id), path, title }))
      : undefined;
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

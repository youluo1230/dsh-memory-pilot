import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHindsightBackend } from './adapters.mjs';
import { createMemosHttpBackend } from './memos-http.mjs';
import { createMemosBridgeBackend } from './memos-bridge.mjs';
import { resolveApiKey } from './secret.mjs';

// Registry factories are a seam for new backend APIs and test fakes.
export function createRegistry({ bindings, identities, env = process.env, factories = {
  hindsight: createHindsightBackend, memos: createMemosHttpBackend, 'memos-bridge': createMemosBridgeBackend,
} }) {
  if (!Array.isArray(bindings) || !bindings.length) throw new Error('Explicit backend bindings required');
  const scopes = Object.create(null), backends = Object.create(null);
  for (const item of bindings) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.id) || Object.hasOwn(backends, item.id)) throw new Error('Invalid or duplicate backend id');
    const scopeId = item.scope === 'global' ? 'global' : identities[item.scope];
    if (!['personal','global','project','workspace'].includes(item.scope) || !scopeId || item.scopeId !== scopeId) throw new Error('Scope identity mismatch');
    if (!Object.hasOwn(factories, item.type)) throw new Error('Unknown backend type');
    if (item.type !== 'memos-bridge' && (typeof item.baseUrl !== 'string' || !item.baseUrl.trim())) throw new Error('Binding baseUrl required');
    const apiKey = resolveApiKey({ keyEnv: item.keyEnv, apiKey: item.apiKey }, env).value;
    const specific = item.type === 'memos'
      ? { sessionCookie: item.cookieEnv ? env[item.cookieEnv] : undefined, isolatedStore: item.isolatedStore === true }
      : item.type === 'memos-bridge'
        ? { home: item.home || join(env.DSH_HOME || join(homedir(), '.dsh'), 'memos-plugin'), agent: item.agent || 'deepseek-harness' }
        : { bank: item.bank };
    const backend = factories[item.type]({
      baseUrl: item.baseUrl, scope: item.scope, scopeId, apiKey, ...specific,
    });
    if (item.write && !backend.capabilities.includes('write')) throw new Error('Configured backend does not support write');
    const allowed = op => op === 'write' ? item.write === true : item.read === true;
    const descriptor = Object.freeze({ engine: item.type === 'memos-bridge' ? 'memos' : item.type,
      ...(item.type === 'memos-bridge' ? { adapter: 'memos-bridge', transport: 'stdio-jsonrpc', store: Object.freeze({ kind: 'shared-hub', display: 'MemOS shared store' }) }
        : item.type === 'memos' ? { adapter: 'memos-http', transport: 'http', store: Object.freeze({ kind: 'namespace', display: 'MemOS isolated store' }) }
          : { transport: 'http', store: Object.freeze({ kind: 'bank', display: String(item.bank).slice(0, 256) }) }) });
    backends[item.id] = { ...backend, descriptor, capabilities: backend.capabilities.filter(allowed), execute(action, options) {
      if (!allowed(action.operation)) throw new Error('Binding permission denied');
      return backend.execute(action, options);
    } };
    const grant = scopes[item.scope] ||= {read:false,write:false};
    grant.read ||= item.read === true; grant.write ||= item.write === true;
  }
  // Any writable backend that can store a finished turn, not just the global one.
  // Restricting capture to `global` meant a project repository never received
  // conversations at all, so project-scoped recall had nothing to find.
  const captureTargets = Object.entries(backends).filter(([id, backend]) => {
    const item = bindings.find(binding => binding.id === id);
    return item?.write === true && typeof backend.captureTurn === 'function';
  }).map(([, backend]) => backend);
  return {
    backends, policy: { scopes }, capture: captureTargets.length > 0,
    captureTurn: turn => Promise.allSettled(captureTargets.map(backend => backend.captureTurn(turn))),
  };
}

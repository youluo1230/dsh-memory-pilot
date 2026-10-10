// Verified against /root/.hermes/memos-plugin/{server,dist/server}:
// routes/memory.{ts,js}, middleware/auth.{ts,js}, routes/auth.{ts,js}, http.{ts,js}.
const SCOPES = new Set(['personal', 'global', 'project', 'workspace']);
const ACTION_KEYS = new Set(['operation', 'backend', 'scope', 'scopeId', 'query']);
const OPTIONS = new Set(['baseUrl', 'apiKey', 'sessionCookie', 'agent', 'scope', 'scopeId',
  'isolatedStore', 'fetchImpl', 'topK', 'timeoutMs']);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty text`);
  return value;
};
function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
}

/**
 * Search-only HTTP adapter for the installed Hermes MemOS viewer API.
 * baseUrl is the dedicated service ORIGIN, not /api/v1 or a hub prefix.
 * isolatedStore:true is an OPERATOR ATTESTATION: the service, database, active
 * namespace and any Hub/public retrieval sources are dedicated to scope/scopeId.
 * It is not remotely verified. Never point this adapter at the shared live Hub.
 * POST search drops namespace; agent is routing metadata, NOT a tenant boundary.
 * Therefore namespace options are rejected, not silently advertised as isolation.
 * API-key gate accepts Bearer or x-api-key; we use Bearer. Password-protected
 * services additionally require a supplied memos_sess[_agent] cookie pair.
 * No X-token contract was found. No login, cookie persistence or renewal occurs.
 * Search may write retrieval logs. Aborting HTTP does not cancel server work.
 * No verified generic add/retain or idempotency contract exists in these routes:
 * write/deep, lifecycle ingestion, import/export and admin endpoints are refused.
 */
export function createMemosHttpBackend(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !OPTIONS.has(key))) throw new TypeError('Unsupported MemOS HTTP configuration');
  const { baseUrl, apiKey, sessionCookie, agent = 'deepseek-harness', scope, scopeId,
    isolatedStore, fetchImpl = globalThis.fetch, topK = 10, timeoutMs = 15_000 } = options;
  if (isolatedStore !== true) throw new TypeError('isolatedStore:true requires an operator-attested dedicated service, not the shared live Hub');
  if (!SCOPES.has(scope)) throw new TypeError('Unsupported scope');
  text(scopeId, 'scopeId');
  if (scope === 'global' && scopeId !== 'global') throw new TypeError('Global scopeId must be global');
  text(agent, 'agent');
  let url;
  try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid baseUrl'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new TypeError('baseUrl must be an HTTP(S) origin without credentials, path, query or fragment');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) throw new TypeError('topK must be an integer from 1 to 50');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError('Invalid timeoutMs');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey !== undefined) {
    text(apiKey, 'apiKey');
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw new TypeError('Invalid apiKey');
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (sessionCookie !== undefined) {
    // Only one existing session cookie, never arbitrary Cookie header injection.
    if (typeof sessionCookie !== 'string' || !/^memos_sess(?:_[A-Za-z0-9_-]+)?=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sessionCookie)) {
      throw new TypeError('sessionCookie must be one MemOS session cookie pair');
    }
    headers.Cookie = sessionCookie;
  }
  const endpoint = `${url.origin}/api/v1/memory/search`;
  const capabilities = Object.freeze(['search']);
  return Object.freeze({ capabilities, scope, scopeId,
    async execute(action, { signal } = {}) {
      if (!action || Array.isArray(action) || typeof action !== 'object'
        || action.scope !== scope || action.scopeId !== scopeId) throw new Error('Scope binding mismatch');
      if (action.operation !== 'search') throw new Error('Unsupported operation');
      if (Object.keys(action).some(key => !ACTION_KEYS.has(key))) throw new Error('Model-controlled request fields refused');
      const query = text(action.query, 'query');
      if (query.length > 512) throw new TypeError('query exceeds 512 characters');
      checkAbort(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { ...headers }, redirect: 'error', credentials: 'omit',
          signal: controller.signal,
          body: JSON.stringify({ agent, query, topK: { tier1: topK, tier2: topK, tier3: topK } }),
        });
        checkAbort(controller.signal);
        if (!response.ok) throw new Error('Rejected');
        const result = await response.json();
        checkAbort(controller.signal);
        if (!result || !Array.isArray(result.hits) || result.hits.some(hit => !hit || typeof hit.snippet !== 'string')) {
          throw new Error('Malformed response');
        }
        const recalled = result.hits.map(hit => hit.snippet.trim()).filter(Boolean).join('\n\n');
        return { text: recalled, source: 'memos', metadata: { hitCount: result.hits.length, returnedChars: recalled.length } };
      } catch {
        checkAbort(controller.signal);
        // Never leak response bodies, credentials, URLs or dependency exception text.
        throw new Error('MemOS HTTP search failed');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  });
}

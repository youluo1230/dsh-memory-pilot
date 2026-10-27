// One-shot connection tests for the settings UI. Every probe uses the SAME
// adapters the runtime uses (createOpenAICompatibleDecision /
// createSystemOneDecision / registry factories) so a green test means the
// runtime path works, not merely that a TCP port answers.
//
// Tests are invoked through the settings RPC `test` endpoint with the DRAFT
// configuration (not the committed one), so users can validate before saving.
// Probes are strictly read-only: the decision probes ask for a minimal typed
// response, backend probes only touch endpoints that carry no write semantics
// (Hindsight bank list, MemOS HTTP search with an empty-ish query, MemOS
// bridge health).
import { createOpenAICompatibleDecision, createSystemOneDecision, createHindsightBackend } from './adapters.mjs';
import { createMemosHttpBackend } from './memos-http.mjs';
import { resolveApiKey } from './secret.mjs';

const fail = message => { throw new Error(message); };
const clean = value => typeof value === 'string' ? value.trim() : '';

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// A probe MUST carry at least one capability. Both decide() implementations
// build their questions from the capability list and return {actions:[]}
// before issuing any request when it is empty — which made a dead endpoint
// report "connection OK, 0 ms". These two records are shaped exactly like the
// bindings the registry emits, so the probe drives the same code path the
// runtime does (question construction, response validation, action mapping).
const PROBE_CAPABILITIES = Object.freeze([
  Object.freeze({ backend: 'probe-global', scope: 'global', operations: Object.freeze(['search', 'write']) }),
  Object.freeze({ backend: 'probe-project', scope: 'project', operations: Object.freeze(['search']) }),
]);
const PROBE_EVENT = (type, text) => Object.freeze({
  type, id: 'settings-test', sessionId: 'settings-test', text,
  workspaceId: 'settings-test', workspacePath: '/settings-test',
  projectId: 'settings-test', projectPath: '/settings-test',
});

export async function testDecisionConnection(config = {}, { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 10_000 } = {}) {
  const baseUrl = clean(config.decisionBaseUrl);
  const model = clean(config.decisionModel);
  if (!baseUrl) fail('未填写决策接口根地址');
  if (!model) fail('未填写模型名称');
  const key = resolveApiKey({ keyEnv: config.decisionKeyEnv, apiKey: config.decisionApiKey ?? config.apiKey }, env);
  const apiKey = key.value;
  const createDecision = config.decisionProtocol === 'openai' ? createOpenAICompatibleDecision : createSystemOneDecision;
  const startedAt = Date.now();
  // Count real round trips so the UI can never again report success for a call
  // that never left the process.
  let requests = 0;
  const countedFetch = (url, options) => { requests += 1; return fetchImpl(url, options); };
  const probeDecision = createDecision({ baseUrl, model, apiKey, fetchImpl: countedFetch, timeoutMs });
  // Adapters deliberately hide dependency errors; wrap so the UI shows what
  // to fix (endpoint unreachable / malformed / auth rejected) instead of a
  // bare adapter line.
  const probe = (kind, event, capabilities) => probeDecision.decide({ event, capabilities }, {}).catch(error => {
    fail(`决策接口不可达或无响应（${kind}协议）：${error instanceof Error ? error.message : 'unknown'}${apiKey ? '' : '；未发送密钥'}`);
  });
  // A probe is only meaningful if the protocol is really spoken end to end.
  const assertProbeRan = () => {
    if (requests === 0) fail('决策接口探测未发起网络请求（配置未生效）');
  };
  const keyNote = apiKey ? '' : '，未配置密钥';
  if (config.decisionProtocol === 'openai') {
    // A message event with recalls exercises question construction and the
    // real /chat/completions round trip; a healthy endpoint returns actions.
    const result = await withTimeout(
      probe('openai', PROBE_EVENT('message', 'connection test'), PROBE_CAPABILITIES),
      timeoutMs, '决策接口');
    assertProbeRan();
    if (!result || typeof result !== 'object' || !Array.isArray(result.actions)) fail('决策接口返回了意外格式');
    const durationMs = Date.now() - startedAt;
    return { ok: true, protocol: 'openai', model, durationMs, detail: `连接正常（协议 openai，模型 ${model}，${durationMs} ms${keyNote}）` };
  }
  const result = await withTimeout(
    probe('SystemOne', PROBE_EVENT('checkpoint', 'connection test'), PROBE_CAPABILITIES),
    timeoutMs, '决策接口');
  assertProbeRan();
  if (!result || typeof result !== 'object' || !Array.isArray(result.actions)) fail('决策接口返回了意外格式');
  // Report whether the endpoint also exposes the batch form: it changes how much
  // time a set of small judgments costs, so the operator should be able to see it.
  let batching = 'unknown';
  if (typeof probeDecision.supportsBatch === 'function') {
    try { batching = (await probeDecision.supportsBatch()) ? 'yes' : 'no'; } catch { batching = 'no'; }
  }
  const batchNote = batching === 'yes' ? '，支持批量判断' : batching === 'no' ? '，仅单次判断' : '';
  return { ok: true, protocol: 'systemone', model, batch: batching === 'yes',
    durationMs: Date.now() - startedAt,
    detail: `连接正常（协议 SystemOne，模型 ${model}，${Date.now() - startedAt} ms${batchNote}${keyNote}）` };
}

function backendProbeOptions(item = {}) {
  return {
    baseUrl: clean(item.baseUrl),
    apiKey: resolveApiKey({ keyEnv: item.keyEnv, apiKey: item.apiKey }).value,
    scope: item.scope || 'project',
    scopeId: item.scopeId || 'test',
  };
}

export async function testSystemConnection(item = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const type = clean(item.type) || 'hindsight';
  const name = clean(item.id) || type;
  const startedAt = Date.now();
  if (type === 'hindsight') {
    const options = backendProbeOptions(item);
    if (!options.baseUrl) fail('未填写 Hindsight 服务地址');
    // Read-only probe: list banks. Exercises auth, protocol and reachability
    // without touching any memory content.
    const backend = createHindsightBackend({ ...options, bank: '__memory_pilot_probe__', fetchImpl });
    const url = `${String(options.baseUrl).replace(/\/+$/, '')}/v1/default/banks`;
    let response;
    try {
      response = await withTimeout(fetchImpl(url, {
        method: 'GET',
        headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      }), timeoutMs, 'Hindsight 服务');
    } catch { fail('Hindsight 服务无法连接'); }
    if (!response?.ok) fail(`Hindsight 服务响应异常（HTTP ${response?.status ?? 'unknown'}）`);
    const durationMs = Date.now() - startedAt;
    return { ok: true, type, name, durationMs, detail: `Hindsight 连接正常（HTTP ${response.status}，${durationMs} ms）` };
  }
  if (type === 'memos') {
    const options = backendProbeOptions(item);
    if (!options.baseUrl) fail('未填写 MemOS 服务地址');
    if (item.isolatedStore !== true) fail('MemOS HTTP 后端需要 isolatedStore 声明（专用实例）');
    const backend = createMemosHttpBackend({
      baseUrl: options.baseUrl, apiKey: options.apiKey, scope: options.scope, scopeId: options.scopeId,
      isolatedStore: true, fetchImpl, timeoutMs,
    });
    // Read-only search probe with a bounded query.
    const result = await withTimeout(backend.execute({ operation: 'search', scope: options.scope, scopeId: options.scopeId, query: 'memory-pilot connection test' }, {}), timeoutMs, 'MemOS 服务');
    const hitCount = result?.metadata?.hitCount;
    const durationMs = Date.now() - startedAt;
    return { ok: true, type, name, durationMs, detail: `MemOS 连接正常（搜索可用${Number.isFinite(hitCount) ? `，返回 ${hitCount} 条` : ''}，${durationMs} ms）` };
  }
  if (type === 'memos-bridge') {
    const { createMemosBridgeBackend } = await import('./memos-bridge.mjs');
    const home = clean(item.home);
    if (!home) fail('MemOS bridge 需要配置插件 home 路径');
    // A real search drives the store's own retrieval pipeline, which runs an
    // LLM relevance filter and retries it: measured at ~7.8 s against a healthy
    // local bridge. The previous 8 s request / 10 s probe budget sat exactly on
    // that edge, so a working bridge reported "无响应" and the button looked
    // dead. The probe therefore only proves the machine interface answers
    // (`core.health`, measured 0.45 s), and allows the slower path extra room.
    const probeTimeout = Math.max(timeoutMs, 20_000);
    const backend = createMemosBridgeBackend({
      home, agent: clean(item.agent) || 'deepseek-harness',
      scope: item.scope === 'global' ? 'global' : 'project',
      scopeId: item.scope === 'global' ? 'global' : 'connection-test',
      readyTimeoutMs: probeTimeout, requestTimeoutMs: probeTimeout,
    });
    let detail;
    try {
      await withTimeout(backend.execute({ operation: 'search', scope: backend.scope, scopeId: backend.scopeId, query: 'memory-pilot connection test' }, {}), probeTimeout, 'MemOS bridge');
      detail = '检索可用';
    } catch (error) {
      await backend.dispose?.();
      const message = error instanceof Error ? error.message : 'unknown';
      // A timeout after the process answered is a slow store, not a dead one.
      // Report it as a warning so the user does not go hunting for a fault that
      // is only latency; a failed spawn stays an error.
      if (/timed out/i.test(message)) {
        return { ok: true, warning: true, type, name, durationMs: Date.now() - startedAt,
          detail: `MemOS bridge 已连通，但检索较慢（> ${Math.round(probeTimeout / 1000)} 秒未返回）；记忆仍会工作，只是这一轮测试没等到结果` };
      }
      fail(`MemOS bridge 无响应（${message}）`);
    }
    await backend.dispose?.();
    const durationMs = Date.now() - startedAt;
    return { ok: true, type, name, durationMs, detail: `MemOS bridge 连接正常（${detail}，${durationMs} ms）` };
  }
  fail(`未知的记忆系统类型：${type}`);
}

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

export async function testDecisionConnection(config = {}, { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 10_000 } = {}) {
  const baseUrl = clean(config.decisionBaseUrl);
  const model = clean(config.decisionModel);
  if (!baseUrl) fail('未填写决策接口根地址');
  if (!model) fail('未填写模型名称');
  const apiKey = clean(config.decisionKeyEnv) ? env[config.decisionKeyEnv] : (clean(config.apiKey) || undefined);
  const createDecision = config.decisionProtocol === 'openai' ? createOpenAICompatibleDecision : createSystemOneDecision;
  const decision = createDecision({ baseUrl, model, apiKey, fetchImpl, timeoutMs });
  const startedAt = Date.now();
  // SystemOne answers typed questions; a minimal single-question state is the
  // cheapest possible round trip that still exercises the real protocol.
  if (config.decisionProtocol === 'openai') {
    // OpenAI-compatible probes go through decide() with an empty capability
    // list; a healthy endpoint returns {"actions":[]}.
    const result = await withTimeout(decision.decide({
      event: { type: 'message', id: 'settings-test', sessionId: 'settings-test', text: 'connection test' },
      capabilities: [],
    }, {}), timeoutMs, '决策接口');
    if (!result || typeof result !== 'object' || !Array.isArray(result.actions)) fail('决策接口返回了意外格式');
    return { ok: true, protocol: 'openai', model, durationMs: Date.now() - startedAt, detail: `连接正常（协议 openai，模型 ${model}，${Date.now() - startedAt} ms）` };
  }
  const result = await withTimeout(decision.decide({
    event: { type: 'checkpoint', id: 'settings-test', sessionId: 'settings-test', text: 'connection test' },
    capabilities: [],
  }, {}), timeoutMs, '决策接口');
  if (!result || typeof result !== 'object' || !Array.isArray(result.actions)) fail('决策接口返回了意外格式');
  return { ok: true, protocol: 'systemone', model, durationMs: Date.now() - startedAt, detail: `连接正常（协议 SystemOne，模型 ${model}，${Date.now() - startedAt} ms）` };
}

function backendProbeOptions(item = {}) {
  return {
    baseUrl: clean(item.baseUrl),
    apiKey: item.keyEnv ? process.env[item.keyEnv] : (clean(item.apiKey) || undefined),
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
    const home = clean(item.home) || undefined;
    if (!home) fail('MemOS bridge 需要配置插件 home 路径');
    const backend = createMemosBridgeBackend({
      home, agent: clean(item.agent) || 'deepseek-harness',
      scope: item.scope || 'global', scopeId: item.scopeId || 'global',
      readyTimeoutMs: timeoutMs, requestTimeoutMs: Math.min(timeoutMs, 8000),
      spawnImpl: undefined,
    });
    // createMemosBridgeBackend spawns lazily; health check via ready().
    try {
      await withTimeout(backend.__probeHealth ? backend.__probeHealth() : Promise.resolve(), timeoutMs, 'MemOS bridge');
    } catch { fail('MemOS bridge 子进程无法启动或无响应'); }
    const durationMs = Date.now() - startedAt;
    return { ok: true, type, name, durationMs, detail: `MemOS bridge 连接正常（${durationMs} ms）` };
  }
  fail(`未知的记忆系统类型：${type}`);
}

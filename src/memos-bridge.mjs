// MemOS bridge stdio adapter: speaks line-delimited JSON-RPC 2.0 with the
// installed bridge subprocess — the same machine interface the Hermes Python
// adapter uses. No HTTP, no viewer password, no shared-cookie lifetime
// problems. The child owns the store; this process never opens the DB.
//
// Verified against /root/.hermes/memos-plugin:
//   bridge/methods.ts dispatcher, agent-contract/jsonrpc.ts RPC_METHODS,
//   agent-contract/dto.ts RetrievalResultDTO / TurnInputDTO / TurnResultDTO,
//   dist/bridge.mjs parseArgs (--no-viewer, --home=).
// `turn.start` + `turn.end` is the store's native capture path: writes land as
// traces and background induction — an accepted write is not a completed
// extraction. Search results may include hub-shared content from other agent
// namespaces by design (the store is deliberately shared across agents).
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be nonempty text`);
  return value;
}
function binding(scope, scopeId) {
  const SCOPES = new Set(['personal', 'global', 'project', 'workspace']);
  if (!SCOPES.has(scope)) throw new TypeError('Unsupported scope');
  text(scopeId, 'scopeId');
  if (scope === 'global' && scopeId !== 'global') throw new TypeError('Global scopeId must be global');
  return Object.freeze({ scope, scopeId });
}
function checkAction(action, fixed, capabilities) {
  if (!action || action.scope !== fixed.scope || action.scopeId !== fixed.scopeId) throw new Error('Scope binding mismatch');
  if (!capabilities.includes(action.operation)) throw new Error('Unsupported operation');
  if ('bank' in action || 'namespace' in action) throw new Error('Model-controlled storage binding refused');
}
function checkAbort(signal) { if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError'); }
function explicitFactTerms(value) {
  const normalized = String(value).toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu) ?? []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let at = 0; at < run.length - 1; at++) terms.add(run.slice(at, at + 2));
  }
  return terms;
}
function explicitFactScore(query, fact) {
  const q = explicitFactTerms(query), body = explicitFactTerms(fact.content);
  let overlap = 0;
  for (const term of q) if (body.has(term)) overlap++;
  const identityIntent = /谁|姓名|名字|称呼|name|identity/i.test(query);
  const identityFact = /名字|姓名|称呼|叫|name|identity/i.test(fact.content);
  return overlap + (identityIntent && identityFact ? 4 : 0);
}
function validateWriteIntent(action, event) {
  const content = text(action.content, 'content');
  const evidence = action.evidence;
  if (!event || typeof event.id !== 'string' || typeof event.text !== 'string' || typeof event.sessionId !== 'string' || !event.sessionId
    || evidence?.eventId !== event.id || typeof evidence.quote !== 'string' || !evidence.quote.trim() || !event.text.includes(evidence.quote)) {
    throw new Error('Write evidence does not match event');
  }
  return { content, sessionId: event.sessionId, episodeId: `ep-${event.id}` };
}

export function createMemosBridgeBackend({
  home, agent = 'deepseek-harness', scope, scopeId,
  nodePath = process.execPath, spawnImpl = spawn,
  requestTimeoutMs = 8000, writeTimeoutMs = 90000, readyTimeoutMs = 30000, topK = 5,
} = {}) {
  text(home, 'home');
  text(agent, 'agent');
  const fixed = binding(scope, scopeId);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('Invalid requestTimeoutMs');
  if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1) throw new TypeError('Invalid writeTimeoutMs');
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) throw new TypeError('Invalid readyTimeoutMs');
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 50) throw new TypeError('Invalid topK');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl is required');

  let child = null, nextId = 1;
  const pending = new Map();
  const factPath = join(home, 'data', 'memory-pilot-explicit-facts.json');
  async function loadFacts() {
    if (scope !== 'global') return [];
    try {
      const value = JSON.parse(await readFile(factPath, 'utf8'));
      return Array.isArray(value?.facts) ? value.facts.filter(row => row && typeof row.content === 'string' && typeof row.id === 'string').slice(-200) : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('Explicit memory store failed');
    }
  }
  async function retainFact(fact) {
    if (scope !== 'global') return;
    const facts = await loadFacts();
    const next = [...facts.filter(row => row.id !== fact.id && row.content !== fact.content), fact].slice(-200);
    await mkdir(join(home, 'data'), { recursive: true });
    const temporary = `${factPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, facts: next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, factPath);
  }
  async function relevantFacts(query) {
    return (await loadFacts()).map(fact => ({ fact, score: explicitFactScore(query, fact) }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.fact.retainedAt - a.fact.retainedAt).slice(0, 3).map(row => row.fact);
  }

  function failPending() {
    for (const settle of pending.values()) settle({ error: new Error('MemOS bridge request failed') });
    pending.clear();
  }
  function killChild() {
    if (child) { try { child.kill('SIGTERM'); } catch { /* already gone */ } child = null; }
    failPending();
  }
  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') return; // logs and notifications are noise
    let message;
    try { message = JSON.parse(trimmed); } catch { return; }
    if (!message || typeof message.id !== 'number' || !pending.has(message.id)) return; // notification
    const settle = pending.get(message.id);
    pending.delete(message.id);
    settle(message);
  }
  function startChild() {
    killChild();
    const started = spawnImpl(nodePath, [join(home, 'dist', 'bridge.mjs'), '--no-viewer', `--home=${home}`], {
      stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, MEMOS_HOME: home },
    });
    started.stdout.setEncoding('utf8');
    let buffer = '';
    started.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        handleLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
    started.on('exit', () => { if (child === started) { child = null; failPending(); } });
    started.on('error', () => { if (child === started) { child = null; failPending(); } });
    child = started;
    return started;
  }
  function request(method, params, timeoutMs, signal) {
    checkAbort(signal);
    if (!child || child.exitCode !== null || child.signalCode !== null) startChild();
    const id = nextId++;
    const written = child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('MemOS bridge request failed'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        pending.delete(id);
        reject(new DOMException('Operation aborted', 'AbortError'));
      };
      pending.set(id, message => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (message.error) reject(new Error('MemOS bridge request failed'));
        else resolve(message.result);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!written) child.stdin.once('drain', () => { /* backpressure absorbed */ });
    });
  }
  async function ready(signal) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      checkAbort(signal);
      const remaining = Math.max(1, deadline - Date.now());
      try {
        await request('core.health', {}, Math.min(requestTimeoutMs, remaining), signal);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (Date.now() >= deadline) { killChild(); throw new Error('MemOS bridge not ready'); }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }

  const capabilities = Object.freeze(['search', 'write']);
  return Object.freeze({
    capabilities, ...fixed,
    async captureTurn(turn, { signal } = {}) {
      if (scope !== 'global') throw new Error('Turn capture requires global scope');
      const sessionId = text(turn?.session?.id, 'session id');
      const userText = text(turn?.userText, 'user text');
      const assistantText = typeof turn?.assistantText === 'string' ? turn.assistantText : '';
      if (!child) await ready(signal);
      const turnKey = `${sessionId}:${turn.turn}:capture`;
      const started = await request('turn.start', { agent, sessionId, userText, ts: Date.now(), turnKey }, writeTimeoutMs, signal);
      const episodeId = started?.query?.episodeId || started?.episodeId || `ep-${turnKey}`;
      const ended = await request('turn.end', { agent, sessionId, episodeId, agentText: assistantText, toolCalls: [], ts: Date.now() }, writeTimeoutMs, signal);
      if (!ended || typeof ended.traceId !== 'string') throw new Error('Invalid MemOS capture response');
      return { traceId: ended.traceId };
    },
    async execute(action, { signal, event } = {}) {
      checkAction(action, fixed, capabilities);
      const intent = action.operation === 'write' ? validateWriteIntent(action, event) : { query: text(action.query, 'query') };
      if (!child) await ready(signal);
      checkAbort(signal);
      if (action.operation === 'search') {
        const result = await request('memory.search', {
          agent, query: intent.query,
          topK: { tier1: topK, tier2: topK, tier3: topK },
        }, requestTimeoutMs, signal);
        if (!Array.isArray(result?.hits)) throw new Error('Invalid MemOS search response');
        const semantic = result.hits.map(hit => typeof hit?.snippet === 'string' ? hit.snippet.trim() : '').filter(Boolean);
        const facts = await relevantFacts(intent.query);
        const explicit = facts.length ? `明确长期记忆（由用户或工具显式要求保存；较新的明确事实优先于冲突的旧对话）：\n${facts.map(row => `- ${row.content}`).join('\n')}` : '';
        const recalled = [explicit, ...semantic].filter(Boolean).join('\n\n');
        return { text: recalled, source: 'memos', metadata: { hitCount: result.hits.length + facts.length, semanticHitCount: result.hits.length,
          explicitFactCount: facts.length, returnedChars: recalled.length } };
      }
      const { content, sessionId, episodeId } = intent;
      const now = Date.now();
      // turn.start runs retrieval inside the store, so writes get their own leash.
      await request('turn.start', {
        agent, sessionId, episodeId, userText: content, ts: now, turnKey: event.id,
      }, writeTimeoutMs, signal);
      const ended = await request('turn.end', {
        agent, sessionId, episodeId, agentText: '', toolCalls: [], ts: Date.now(),
      }, writeTimeoutMs, signal);
      if (!ended || typeof ended.traceId !== 'string') throw new Error('Invalid MemOS write response');
      await retainFact({ id: event.id, content, retainedAt: Date.now(), traceId: ended.traceId });
      return { text: scope === 'global'
        ? 'Write captured as a turn trace and durable explicit fact; background induction has not completed.'
        : 'Write captured as a turn trace; background induction has not completed.', source: 'memos',
        metadata: { durable: scope === 'global', traceId: ended.traceId } };
    },
    async dispose() { killChild(); },
  });
}

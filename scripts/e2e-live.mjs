// Live end-to-end verification against real services. NOT part of `npm test`.
// Usage: node test/e2e-live.mjs
// Reads: Hindsight banks on localhost:8889, MemOS shared store via bridge stdio.
// Writes: only the dedicated `memory-pilot-e2e` Hindsight bank and one MemOS
// turn trace tagged e2e; never touches other banks' data.
import { createOpenAICompatibleDecision, createHindsightBackend } from '../src/adapters.mjs';
import { createMemosBridgeBackend } from '../src/memos-bridge.mjs';
import { createRegistry } from '../src/registry.mjs';
import { createOrchestrator } from '../src/core.mjs';

const GATEWAY = process.env.E2E_GATEWAY || 'http://192.168.1.10:3233/v1';
const KEY = process.env.E2E_GATEWAY_KEY || 'sk-s2oekoudClHSj6OXlZCXEN7bfFbfhitNiKl2650RJDgoWVi7';
const DECISION_MODEL = process.env.E2E_DECISION_MODEL || 'agnes-3.0-flash';
const HS = 'http://localhost:8889';
const MEMOS_HOME = '/root/.hermes/memos-plugin';
const EVENT = {
  type: 'message', id: 'e2e:s1:m1', sessionId: 'e2e-s1',
  text: '我想确认一下:MemoryPilot 已经接入 Hindsight 和 MemOS 了吗?之前统一记忆编排的结论是什么?',
};

const timing = {};
async function timed(name, promise) { const at = Date.now(); try { return await promise; } finally { timing[name] = Date.now() - at; } }

const decision = createOpenAICompatibleDecision({ baseUrl: GATEWAY, model: DECISION_MODEL, apiKey: KEY });
const registry = createRegistry({
  identities: { project: 'code' },
  bindings: [
    { id: 'hs-project-ro', type: 'hindsight', baseUrl: HS, bank: 'coding-agent::code', scope: 'project', scopeId: 'code', read: true, write: false },
    { id: 'hs-e2e', type: 'hindsight', baseUrl: HS, bank: 'memory-pilot-e2e', scope: 'project', scopeId: 'code', read: true, write: true },
    { id: 'hs-global', type: 'hindsight', baseUrl: HS, bank: 'hermes', scope: 'global', scopeId: 'global', read: true, write: false },
    { id: 'memos', type: 'memos-bridge', home: MEMOS_HOME, agent: 'deepseek-harness', scope: 'project', scopeId: 'code', read: true, write: true },
  ],
});
const backends = registry.backends;
const orchestrator = createOrchestrator({
  decision,
  backends,
  policy: registry.policy,
  budgetMs: 20000,
  onAudit: record => console.log('AUDIT', JSON.stringify(record).slice(0, 400)),
});

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };

// 1. Decision model contract on the real gateway.
const plan = await timed('decision', decision.decide({ event: EVENT, capabilities: [{ backend: 'hs-project-ro', scope: 'project', scopeId: 'code', operations: ['search'] }, { backend: 'memos', scope: 'project', scopeId: 'code', operations: ['search', 'write'] }] }));
check('decision JSON plan', Array.isArray(plan?.actions), JSON.stringify(plan?.actions)?.slice(0, 200));

// 2. Hindsight read from the real existing bank.
const hsSearch = await timed('hindsight-search', backends['hs-project-ro'].execute({ operation: 'search', scope: 'project', scopeId: 'code', query: '统一记忆编排 MemoryPilot 决策模型' }, { event: EVENT }));
check('hindsight recall from coding-agent::code', typeof hsSearch?.text === 'string' && hsSearch.text.length > 0, `${hsSearch?.text?.length ?? 0} chars`);

// 3. Hindsight global read from the hermes bank.
const hsGlobal = await timed('hindsight-global', backends['hs-global'].execute({ operation: 'search', scope: 'global', scopeId: 'global', query: '记忆系统 架构 决策' }, { event: EVENT }));
check('hindsight recall from hermes bank', typeof hsGlobal?.text === 'string', `${hsGlobal?.text?.length ?? 0} chars`);

// 4. MemOS bridge search over the real shared store.
const memosSearch = await timed('memos-search', backends.memos.execute({ operation: 'search', scope: 'project', scopeId: 'code', query: '记忆系统 设计 决策' }, { event: EVENT }));
check('memos bridge search', typeof memosSearch?.text === 'string' && memosSearch.text.length > 0, `${memosSearch?.text?.length ?? 0} chars`);

// 5. Hindsight write into the dedicated e2e bank, then poll until it is retrievable.
const token = String(Date.now()); const marker = `MemoryPilot E2E 标记 ${token}`;
const eventWithMarker = { ...EVENT, text: `${EVENT.text} ${marker}` };
const hsWrite = await timed('hindsight-write', backends['hs-e2e'].execute({ operation: 'write', scope: 'project', scopeId: 'code', content: marker, evidence: { eventId: eventWithMarker.id, quote: marker } }, { event: eventWithMarker }));
check('hindsight write accepted', /accepted/i.test(hsWrite?.text ?? ''), hsWrite?.text);
let writeRoundtrip = '';
for (let waited = 0; waited < 60000; waited += 5000) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  const probe = await backends['hs-e2e'].execute({ operation: 'search', scope: 'project', scopeId: 'code', query: marker }, { event: eventWithMarker });
  if (probe.text.includes(token)) { writeRoundtrip = probe.text; break; }
  console.log(`  ... waiting for hindsight extraction (${waited + 5000}ms)`);
}
check('hindsight write round-trip', writeRoundtrip.includes(token), writeRoundtrip.slice(0, 160));

// 6. MemOS bridge write = turn capture with provenance.
const memosWrite = await timed('memos-write', backends.memos.execute({ operation: 'write', scope: 'project', scopeId: 'code', content: JSON.stringify({ user: EVENT.text, marker }), evidence: { eventId: EVENT.id, quote: '统一记忆编排的结论' } }, { event: EVENT }));
check('memos turn capture accepted', /trace/i.test(memosWrite?.text ?? ''), memosWrite?.text);

// 7. Full orchestrator round with the real decision model and all backends.
const result = await timed('orchestrator', orchestrator.run(EVENT));
check('orchestrator run', result?.status === 'ok' || result?.status === 'noop', `status=${result?.status}`);
console.log(`  context ${result?.context?.length ?? 0} chars, results=${result?.results?.length ?? 0}`);

console.log('TIMING', JSON.stringify(timing));
await backends.memos.dispose?.();
process.exit(failures ? 1 : 0);

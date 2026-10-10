import { createMemosBridgeBackend } from '/vol1/1000/code/dsh-memory-pilot/src/memos-bridge.mjs';
const EVENT = { type: 'turn_end', id: 'e2e:s1:m1', sessionId: 'e2e-s1', text: '我想确认一下:MemoryPilot 已经接入 Hindsight 和 MemOS 了吗?统一记忆编排的结论是什么?' };
const backend = createMemosBridgeBackend({ home: '/root/.hermes/memos-plugin', scope: 'project', scopeId: 'code', requestTimeoutMs: 60000, readyTimeoutMs: 120000 });
const t0 = Date.now();
try {
  const result = await backend.execute({ operation: 'write', scope: 'project', scopeId: 'code', content: JSON.stringify({ user: EVENT.text, note: 'MemoryPilot e2e turn capture' }), evidence: { eventId: EVENT.id, quote: '统一记忆编排的结论' } }, { event: EVENT });
  console.log('WRITE OK', Date.now() - t0, 'ms', JSON.stringify(result));
} catch (err) {
  console.log('WRITE FAIL', Date.now() - t0, 'ms', err.message);
}
await backend.dispose();
process.exit(0);

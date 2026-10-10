import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '/www/server/nodejs/v25.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { KNOWN_SESSION_EVENT_TYPES } from '/www/server/nodejs/v25.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js';

test('plugin observation is durable log-only state and never enters model messages', () => {
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has('plugin/observation'), true);
  const session = Session.create('memory-pilot-observation-test');
  const before = session.deriveMessages();
  const event = session.append('plugin/observation', {
    plugin: 'dsh-memory-pilot', kind: 'retrieval', version: 1, turn: 1, step: 1,
    summary: 'Global MemOS recall succeeded', data: { status: 'ok', contextChars: 2048 },
  });
  assert.equal(event.type, 'plugin/observation');
  assert.deepEqual(session.deriveMessages(), before);
  assert.equal(session.snapshotEvents().at(-1).data.data.contextChars, 2048);
  const restored = Session.create('memory-pilot-observation-test', session.snapshotEvents());
  assert.deepEqual(restored.deriveMessages(), before);
  assert.equal(restored.snapshotEvents().some(item => item.type === 'plugin/observation'), true);
});

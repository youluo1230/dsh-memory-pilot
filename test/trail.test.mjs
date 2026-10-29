// The decision trail publishes through `ctx.sessionProjections`, not through a
// custom session event: DSH's persistence read path refuses event types outside
// its built-in vocabulary, and `Session.append()` cannot set the `ignorable`
// marker that would exempt them (issue #1). These tests pin the two halves that
// make that safe — a bounded pending table and a pure fold — so a future edit
// cannot reintroduce an event append unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createDecisionTrail, toDecisionEntry, appendDecision, decisionTrailSchema,
  DECISION_TRAIL_KEY, MAX_TRAIL_ENTRIES,
} from '../src/trail.mjs';

const trace = (overrides = {}) => ({
  schemaVersion: 1, kind: 'retrieval', status: 'ok', totalDurationMs: 1200,
  decision: {
    protocol: 'systemone', model: 'clef-flash', durationMs: 240,
    questionNames: ['recall_gate', 'scope_project'],
    answers: {
      recall_gate: { choice: 'memory', probabilities: { none: 0.2, memory: 0.8 } },
      scope_project: { choice: 'query', probabilities: { skip: 0.1, query: 0.9 } },
    },
  },
  plan: { validation: 'accepted', actions: [{ backendId: 'hs', scope: 'project', operation: 'search' }] },
  executions: [{ backendId: 'hs', scope: 'project', operation: 'search', response: { status: 'ok', hitCount: 3 }, durationMs: 800 }],
  injection: { sourceCount: 1, contextChars: 900, truncated: false },
  ...overrides,
});

test('the projection key is stable and the schema validates a folded state', () => {
  assert.equal(DECISION_TRAIL_KEY, 'memoryPilotTrail');
  // The schema must be zod: the projection service calls `parse()` on checkpoint
  // rows, so a JSON Schema literal would throw at runtime.
  const parsed = decisionTrailSchema.parse({ entries: [] });
  assert.deepEqual(parsed, { entries: [] });
});

test('a trace reduces to a bounded entry carrying the questionnaire and its chosen levels', () => {
  const entry = toDecisionEntry(trace(), { id: 'x:1:1:retrieval', turn: 1, step: 1, question: '  帮我  看看记忆插件 ' });
  assert.equal(entry.question, '帮我 看看记忆插件', 'the question is flattened for a single-line row');
  assert.equal(entry.protocol, 'systemone');
  assert.equal(entry.model, 'clef-flash');
  assert.deepEqual(entry.questions, ['recall_gate', 'scope_project']);
  // Confidence is the chosen level's probability, not the whole distribution.
  assert.deepEqual(entry.answers, [
    { name: 'recall_gate', choice: 'memory', confidence: 0.8 },
    { name: 'scope_project', choice: 'query', confidence: 0.9 },
  ]);
  assert.deepEqual(entry.actions, [{ backend: 'hs', scope: 'project', operation: 'search' }]);
  assert.equal(entry.executions[0].hitCount, 3);
  assert.equal(entry.injectedChars, 900);
});

test('a trace missing fields degrades to safe values instead of dropping the entry', () => {
  // A decision that produced no action is the most common case and the one a user
  // most needs to see, so it must still publish.
  const entry = toDecisionEntry(undefined, { id: 'x:2:1:retrieval', turn: 2, step: 1, question: 'hi' });
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.protocol, 'unknown');
  assert.deepEqual(entry.questions, []);
  assert.deepEqual(entry.answers, []);
  assert.deepEqual(entry.actions, []);
  assert.equal(entry.injectedChars, 0);
});

test('a decision is folded into the projection by the next committed event of its step', () => {
  const trail = createDecisionTrail();
  trail.record({ ...toDecisionEntry(trace(), { id: 'x:1:1:retrieval', turn: 1, step: 1, question: 'q1' }), sessionId: 's' });
  // An unrelated event adds no entry. It does advance the fold pointer, which is
  // bookkeeping kept out of the published view, so compare entries rather than
  // object identity.
  const initial = { entries: [] };
  const afterUnrelated = trail.definition.apply(initial, { type: 'step/start', data: { turn: 9, step: 9 } });
  assert.deepEqual(afterUnrelated.entries, initial.entries);
  const next = trail.definition.apply(initial, { type: 'step/start', data: { turn: 1, step: 1 } });
  assert.notEqual(next, initial);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].question, 'q1');
  // The entry drains once: a second event of the same step adds nothing.
  assert.equal(trail.definition.apply(next, { type: 'assistant/message', data: { turn: 1, step: 1 } }).entries.length, 1);
});

test('retries replace their predecessor instead of stacking duplicates', () => {
  const first = toDecisionEntry(trace(), { id: 'same-id', turn: 1, step: 1, question: 'first' });
  const second = toDecisionEntry(trace(), { id: 'same-id', turn: 1, step: 1, question: 'retried' });
  const state = appendDecision(appendDecision({ entries: [] }, first), second);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].question, 'retried');
});

test('the trail is bounded so a long session cannot grow it without limit', () => {
  let state = { entries: [] };
  for (let i = 0; i < MAX_TRAIL_ENTRIES + 20; i++) {
    state = appendDecision(state, toDecisionEntry(trace(), { id: `e${i}`, turn: i + 1, step: 1, question: `q${i}` }));
  }
  assert.equal(state.entries.length, MAX_TRAIL_ENTRIES);
  assert.equal(state.entries[state.entries.length - 1].question, `q${MAX_TRAIL_ENTRIES + 19}`, 'the newest entry is retained');
});

test('uncommitted decisions cannot accumulate past the pending bound', () => {
  const trail = createDecisionTrail();
  // A cancelled step never commits its event, so its pending record would leak.
  // The pending table is bounded: the oldest turns are evicted, the newest stay.
  for (let i = 0; i < 200; i++) {
    trail.record({ ...toDecisionEntry(trace(), { id: `p${i}`, turn: i + 1, step: 1, question: `q${i}` }), sessionId: 's' });
  }
  // Turn 1 was pushed out, so folding it adds no entry.
  const initial = { entries: [] };
  assert.deepEqual(trail.definition.apply(initial, { type: 'step/start', data: { turn: 1, step: 1 } }).entries, initial.entries);
  // The newest turn survived and folds normally.
  const newest = trail.definition.apply(initial, { type: 'step/start', data: { turn: 200, step: 1 } });
  assert.equal(newest.entries.length, 1);
  assert.equal(newest.entries[0].question, 'q199');
});

test('every folded state passes the projection schema the service will parse', () => {
  const trail = createDecisionTrail();
  trail.record({ ...toDecisionEntry(trace(), { id: 's:1:1:retrieval', turn: 1, step: 1, question: 'q' }), sessionId: 's' });
  const state = trail.definition.apply({ entries: [] }, { type: 'step/start', data: { turn: 1, step: 1 } });
  // The projection service parses checkpoint rows with this schema; anything it
  // rejects would silently break cold reads of the whole unit.
  assert.doesNotThrow(() => decisionTrailSchema.parse(state));
  assert.doesNotThrow(() => decisionTrailSchema.parse(trail.definition.wire.view(state)));
});

test('plugin.mjs publishes through the projection and appends no custom session event', () => {
  const source = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.match(source, /sessionProjections\.register\(trail\.definition\)/, 'the trail must be registered as a projection');
  // The regression that broke history loading: a non-vocabulary event type.
  const appended = [...source.matchAll(/session\.append\(\s*'([^']+)'/g)].map(x => x[1]);
  assert.deepEqual(appended, [], 'the plugin appends no session events of its own');
});

test('an execution preview survives the projection schema', () => {
  const entry = toDecisionEntry({
    kind: 'retrieval', status: 'ok', totalDurationMs: 10, candidates: [], plan: { actions: [] },
    decision: { protocol: 'systemone', model: 'm', questionNames: [], answers: {}, durationMs: 1 },
    executions: [{ backendId: 'hs', scope: 'project', operation: 'search', durationMs: 5,
      descriptor: {}, response: { status: 'ok', hitCount: 2, preview: '召回的一段内容' } }],
    injection: { sourceCount: 1, contextChars: 10, truncated: false },
  }, { id: 'x:1:1:retrieval', turn: 1, step: 1, question: 'q' });
  assert.equal(entry.executions[0].preview, '召回的一段内容');
  // The schema the projection service parses on every checkpoint row must accept it.
  assert.doesNotThrow(() => decisionTrailSchema.parse({ entries: [entry] }));
});

test('a decision survives a projection rebuild from the session log', async () => {
  // The projection kept decisions only in an in-memory pending table. A restart
  // rebuilt it by replaying the log with that table empty, so every past decision
  // vanished and the decision log showed nothing. The decision now travels on the
  // injected message, so a replay can recover it.
  const { decisionForLog } = await import('../src/host.mjs');
  const recorded = decisionForLog({
    kind: 'retrieval', status: 'ok', totalDurationMs: 5205,
    decision: { protocol: 'systemone', model: 'clef-flash', durationMs: 1054,
      questionNames: ['recall_gate', 'scope_global'],
      answers: { recall_gate: { choice: 'memory', probabilities: { none: 0.48, memory: 0.52 } },
                 scope_global: { choice: 'query', probabilities: { skip: 0.3, query: 0.7 } } },
      questionOptions: { recall_gate: ['none', 'memory'], scope_global: ['skip', 'query'] } },
    plan: { actions: [{ backendId: 'legacy-memos-global', scope: 'global', operation: 'search' }] },
    executions: [{ backendId: 'legacy-memos-global', scope: 'global', operation: 'search',
      response: { status: 'ok', hitCount: 1, preview: '阿宝 管理员' }, durationMs: 4148 }],
    injection: { contextChars: 1041, truncated: false },
  }, { turn: 5, step: 1, question: '你知道我 wxt 是什么吗？' });

  const trail = createDecisionTrail();
  // Replay the log as a restart would: no pending entries, only committed events.
  const rebuilt = trail.definition.apply(trail.definition.init(), {
    type: 'user/message', data: { turn: 5, step: 1, message: { source: { kind: 'plugin:dsh-memory-pilot', decision: recorded } } },
  });
  assert.equal(rebuilt.entries.length, 1, 'the past decision must come back');
  assert.equal(rebuilt.entries[0].question, '你知道我 wxt 是什么吗？');
  assert.equal(rebuilt.entries[0].answers.find(answer => answer.name === 'recall_gate').choice, 'memory');
  assert.deepEqual(rebuilt.entries[0].questionOptions.recall_gate, ['none', 'memory']);
  // And the result must still satisfy the projection's own schema.
  assert.doesNotThrow(() => decisionTrailSchema.parse(rebuilt));
});

test('a replayed injection without a decision still yields a row', async () => {
  // Injected messages carry no turn/step of their own, and messages logged before
  // decisions were persisted carry no decision either — only what the injection
  // was. Requiring turn/step or the decision body skipped them entirely, so a
  // replay restored nothing at all and the view always looked empty.
  const trail = createDecisionTrail();
  let state = trail.definition.apply(trail.definition.init(), { type: 'step/start', data: { turn: 3, step: 1 } });
  state = trail.definition.apply(state, {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: JSON.stringify({ sources: [{ backend: 'legacy-memos-global', scope: 'global', operation: 'search', status: 'ok', data: JSON.stringify({ text: '召回内容', metadata: { hitCount: 2 } }) }] }) }],
      source: { kind: 'plugin:dsh-memory-pilot', form: 'recall' },
      role: 'user', id: 'm1',
    },
  });
  assert.equal(state.entries.length, 1, 'the row must be reconstructed');
  assert.equal(state.entries[0].turn, 3);
  assert.equal(state.entries[0].reason, 'inferred');
  assert.equal(state.entries[0].executions[0].hitCount, 2);
  // Published state must not leak the fold pointer.
  assert.deepEqual(Object.keys(trail.definition.wire.view(state)), ['entries']);
});

test('an injected message folded before any pointer exists does not abort the turn', async () => {
  // A projection cell rebuilt after a host restart starts with an empty pointer.
  // If the first event folded into it is an injected message (no turn/step), the
  // carry path used to read `pointer.turn` off undefined and throw; the host
  // surfaced that as an opaque turn error and killed the running turn.
  const trail = createDecisionTrail();
  const injection = {
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: JSON.stringify({ sources: [{ backend: 'hs', scope: 'global', operation: 'search', status: 'ok', data: '{}' }] }) }],
      source: { kind: 'plugin:dsh-memory-pilot', form: 'recall' },
      role: 'user', id: 'm0',
    },
  };
  let state;
  assert.doesNotThrow(() => { state = trail.definition.apply(trail.definition.init(), injection); });
  assert.deepEqual(state.entries, [], 'nothing to attach it to yet, but the fold must survive');
  // Once a pointer exists the same injection is located as before.
  state = trail.definition.apply(state, { type: 'step/start', data: { turn: 1, step: 1 } });
  assert.deepEqual(state.pointer, { turn: 1, step: 1 });
  state = trail.definition.apply(state, injection);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].turn, 1);
});

test('the log carries every judgment kind, including distillation and tool safety', async () => {
  // A decision log that only understood memory judgments would drop the two new
  // kinds silently — the reader would see rows missing with no error anywhere.
  const { decisionForLog, distillTrace } = await import('../src/host.mjs');
  const safety = decisionForLog({
    subject: 'command.safety', kind: 'safety', status: 'ok',
    decision: { protocol: 'systemone', model: 'jev', questionNames: ['severity'], answers: { severity: { choice: 'destructive' } }, durationMs: 31 },
    plan: { actions: [{ backendId: 'none', scope: 'none', operation: 'ask' }] }, executions: [],
  }, { turn: 2, step: 1, question: 'rm -rf build' });
  assert.equal(safety.kind, 'safety');
  assert.equal(safety.subject, 'command.safety');
  assert.equal(safety.answers[0].choice, 'destructive');
  assert.equal(safety.decisionDurationMs, 31);

  const distill = decisionForLog(distillTrace({ gate: 'keep', retained: [{ target: 'project-memory' }], failed: [], durationMs: 240, candidateTexts: ['a fact'] }, { turn: 3, question: 'q' }), { turn: 3, step: 0, question: 'q' });
  assert.equal(distill.kind, 'distillation');
  assert.equal(distill.subject, 'session.distill');
  assert.equal(distill.actions[0].backend, 'project-memory');
});

test('a distillation that selected nothing is recorded rather than dropped', async () => {
  // The silence that started this work: a judgment that produced nothing looked the
  // same as a judgment that never ran.
  const { distillTrace } = await import('../src/host.mjs');
  const trace = distillTrace({ gate: 'discard', candidates: 4, retained: [], failed: [], durationMs: 12 }, { turn: 1 });
  assert.equal(trace.kind, 'distillation');
  assert.equal(trace.distill.candidates, 4);
  assert.equal(trace.decision.answers.turn_worth_keeping.choice, 'discard');
});

test('a record written before the new kinds existed still renders', async () => {
  // Old rows carry only `kind: 'retrieval'` and no subject; they must keep working.
  const { decisionForLog } = await import('../src/host.mjs');
  const legacy = decisionForLog({ kind: 'retrieval', status: 'ok' }, { turn: 1, step: 1, question: 'old' });
  assert.equal(legacy.kind, 'retrieval');
  assert.equal(legacy.subject, 'memory.read', 'an absent subject degrades to the memory default');
  assert.deepEqual(legacy.questions, []);
});

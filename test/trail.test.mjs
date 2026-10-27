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
  // An unrelated event leaves the state reference untouched.
  const initial = { entries: [] };
  assert.equal(trail.definition.apply(initial, { type: 'step/start', data: { turn: 9, step: 9 } }), initial);
  const next = trail.definition.apply(initial, { type: 'step/start', data: { turn: 1, step: 1 } });
  assert.notEqual(next, initial);
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].question, 'q1');
  // The entry drains once: a second event of the same step is a no-op.
  assert.equal(trail.definition.apply(next, { type: 'assistant/message', data: { turn: 1, step: 1 } }), next);
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
  // Turn 1 was pushed out, so folding it changes nothing.
  const initial = { entries: [] };
  assert.equal(trail.definition.apply(initial, { type: 'step/start', data: { turn: 1, step: 1 } }), initial);
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

// The claim this file tests is structural, not behavioural: a non-memory decision
// point must run through exactly the same layer as the memory ones. If adding
// command.safety had required editing decision-layer.mjs, the abstraction would be
// wrong regardless of whether the answers came out right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_DECISION_POINTS, loadDecisionPoints, questionsFor, stateFor } from '../src/decision-points.mjs';
import { planStages, validateDecisionPoint, resolveAutomationTier } from '../src/decision-layer.mjs';

test('every built-in decision point is valid and the set includes a non-memory one', () => {
  const points = loadDecisionPoints();
  assert.equal(points.length, BUILTIN_DECISION_POINTS.length);
  for (const point of points) assert.deepEqual(validateDecisionPoint(point), [], `${point.name} must be valid`);
  // The extension claim is only meaningful if something other than memory goes
  // through the same path.
  assert.ok(points.some(point => point.name === 'command.safety'));
  assert.ok(points.some(point => point.name.startsWith('memory.')));
});

test('a non-memory point asks the same shaped questionnaire as a memory one', () => {
  // The transport only understands this shape. A point that produced anything else
  // would need special handling, which is what the layer exists to avoid.
  for (const point of loadDecisionPoints()) {
    const questions = questionsFor(point);
    assert.ok(Object.keys(questions).length >= 1, `${point.name} asks nothing`);
    for (const question of Object.values(questions)) {
      assert.equal(question.type, 'choice');
      assert.ok(Object.keys(question.criteria).length >= 2);
      assert.ok(typeof question.instructions === 'string' && question.instructions.length > 0);
    }
  }
});

test('independent points plan into one stage and the memory pair stays parallel', () => {
  // memory.read and memory.write are independent questions about one message, so
  // they belong in the same request. command.safety answers at a different trigger
  // but is equally independent.
  const stages = planStages(loadDecisionPoints());
  assert.equal(stages.length, 1, 'none of the built-in points depends on another');
  assert.deepEqual(stages[0].map(point => point.name).sort(), ['command.safety', 'memory.read', 'memory.write']);
});

test('each point only sees the state it declared', () => {
  const raw = { message: 'hi', candidates: ['a'], context: 'git status --short', transcript: ['noisy'] };
  const read = loadDecisionPoints().find(point => point.name === 'memory.read');
  const { state } = stateFor(read, raw);
  assert.deepEqual(Object.keys(state).sort(), ['message']);
  assert.equal(state.transcript, undefined, 'a point must not receive fields it did not ask for');
});

test('a user declaration is held to the same standard as a built-in', () => {
  const userPoints = [{
    name: 'frontend.css-review',
    trigger: 'before-turn',
    automation: 'silent-visible',
    stateFields: ['message'],
    questions: { needs_review: { instructions: 'Does this change touch styles?', criteria: { no: 'No style change.', yes: 'Changes CSS or layout.' } } },
    actions: { needs_review: { no: 'proceed', yes: 'ask' } },
  }];
  const loaded = loadDecisionPoints(userPoints);
  assert.equal(loaded.length, 1);
  // Tightening is allowed, loosening is clamped.
  assert.equal(resolveAutomationTier({ authorTier: loaded[0].automation, userTier: 'ask' }), 'ask');
  assert.equal(resolveAutomationTier({ authorTier: loaded[0].automation, userTier: 'silent' }), 'silent-visible');
});

test('a broken user declaration fails at load, not at judgement time', () => {
  assert.throws(() => loadDecisionPoints([{
    name: 'bad', trigger: 'before-turn', automation: 'silent',
    questions: { q: { criteria: { only: 'one option' } } }, actions: {},
  }]), /at least two options/);
});

test('a user-declared point is judged by the same transport as a built-in one', async () => {
  // The extension claim only holds if a user's point runs without any code change.
  // This drives the real judge with a fake transport and asserts the user's point
  // produced a trace, was recorded under its own subject, and could raise a caution.
  const seen = [];
  const decision = {
    async decideBatch(requests) {
      seen.push(requests[0]);
      // Answer whatever the point asked, choosing its first (deferring) option.
      const questions = requests[0].questions;
      const answers = {};
      for (const [name, question] of Object.entries(questions)) {
        const options = Object.keys(question.criteria);
        answers[name] = { type: 'choice', choice: options[1] };
      }
      return [{ model: 'fake', answers, usage: { latency_ms: 12 } }];
    },
  };
  const { createSafetyJudge } = await import('../src/decision-points.mjs');
  const judge = createSafetyJudge({ decision, points: [{
    name: 'frontend.style-check', label: '样式检查', trigger: 'before-turn', automation: 'silent-visible',
    stateFields: ['context'],
    questions: { review: { instructions: '这是样式改动吗？', criteria: { no: '不是。', yes: '是。' } } },
    actions: { review: { no: 'proceed', yes: 'ask' } },
  }] });
  const result = await judge({ id: 's1' }, { text: '改一下按钮颜色', turn: 1, step: 1 });
  const custom = result?.extras?.find(item => item.trace.subject === 'frontend.style-check');
  assert.ok(custom, 'the user point must be judged');
  assert.equal(custom.trace.answers[0].choice, 'yes');
  assert.deepEqual(custom.trace.actions, [{ operation: 'ask' }]);
  // The state it saw is its own allowlist, not the built-in point's.
  assert.deepEqual(Object.keys(seen.at(-1).state), ['context']);
});

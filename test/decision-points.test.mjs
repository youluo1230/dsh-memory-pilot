// The claim this file tests is structural, not behavioural: a non-memory decision
// point must run through exactly the same layer as the memory ones. If adding
// command.safety had required editing decision-layer.mjs, the abstraction would be
// wrong regardless of whether the answers came out right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_DECISION_POINTS, loadDecisionPoints, questionsFor, stateFor } from '../src/decision-points.mjs';
import { planStages, validateDecisionPoint, resolveAutomationTier, unprovidedStateFields, RUNTIME_STATE_FIELDS } from '../src/decision-layer.mjs';
import { memoryQuestionnaire } from '../src/adapters.mjs';
import { questionStages, runPoints, landingFor } from '../src/decision-executor.mjs';

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
  // but is equally independent, and distillation has no cross-point dependency.
  const stages = planStages(loadDecisionPoints());
  assert.equal(stages.length, 1, 'none of the built-in points depends on another');
  assert.deepEqual(stages[0].map(point => point.name).sort(),
    ['command.safety', 'memory.read', 'memory.write', 'session.distill']);
});

test('a declared dependency really orders points, and a cycle is refused', () => {
  // This used to be inert: planStages read `after` while declarations wrote
  // `depends`, so every point landed in stage 0 and the declared order was
  // decoration. Assert the field the declaration actually uses is the one honoured.
  const base = name => ({
    name, trigger: 'before-turn', automation: 'silent', stateFields: ['message'],
    questions: { q: { instructions: 'x', criteria: { no: 'no', yes: 'yes' } } },
    actions: { q: { no: 'proceed', yes: 'proceed' } },
  });
  const stages = planStages([{ ...base('second'), depends: ['first'] }, base('first')]);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].map(point => point.name), ['first']);
  assert.deepEqual(stages[1].map(point => point.name), ['second']);
  // A cycle is a declaration bug, reported at load rather than guessed at runtime.
  assert.throws(() => planStages([{ ...base('a'), depends: ['b'] }, { ...base('b'), depends: ['a'] }]), /cycle/i);
  // Naming a dependency that does not exist is equally a bug.
  assert.throws(() => planStages([{ ...base('a'), depends: ['ghost'] }]), /Unknown dependency/);
});

test('a declared state field the runtime never provides is refused at load', () => {
  // The silent failure this exists for: memory.read declared `residentDigest` and
  // the host never supplied it, so the point judged "is this already in resident
  // memory?" against a field that was always absent. A declaration that asks to see
  // something it will never be shown must fail where a person can fix it.
  // Every built-in point now names only fields the runtime provides.
  for (const point of loadDecisionPoints()) assert.deepEqual(unprovidedStateFields(point), [], `${point.name} asks for nothing unprovided`);
  assert.throws(() => loadDecisionPoints([{
    name: 'blind', trigger: 'before-turn', automation: 'silent',
    stateFields: ['message', 'inventedField'],
    questions: { q: { instructions: 'x', criteria: { no: 'no', yes: 'yes' } } },
    actions: { q: { no: 'proceed', yes: 'proceed' } },
  }]), /never provided at runtime/);
});

test('memory.read declares residentDigest, and the runtime now supplies it', () => {
  // The declaration is only honest if the field is actually provided, which
  // `RUNTIME_STATE_FIELDS` asserts and the host's digest projection honours.
  const read = loadDecisionPoints().find(point => point.name === 'memory.read');
  assert.deepEqual(read.stateFields, ['message', 'residentDigest']);
  assert.deepEqual(unprovidedStateFields(read), []);
  assert.ok(RUNTIME_STATE_FIELDS.includes('residentDigest'));
});

test('one criteria copy: the declarations are the single source the adapter reads', () => {
  // The criteria used to exist three times — in this file, as a private literal in
  // adapters.mjs, and again in the retention path — with three different wordings.
  // Assert the runtime questionnaire is the declaration's own text rather than a
  // restatement, by changing the declaration and observing the change travel.
  const read = loadDecisionPoints().find(point => point.name === 'memory.read');
  const { questions } = memoryQuestionnaire({
    event: { type: 'message' }, points: { read },
    recalls: [{ backend: 'h', scope: 'project', operations: ['search'] }],
  });
  assert.equal(questions.recall_gate.criteria.none, read.questions.recall_gate.criteria.none);
  const edited = { ...read, questions: { ...read.questions, recall_gate: { instructions: 'changed', criteria: { none: 'EDITED-NONE', memory: 'EDITED-MEMORY' } } } };
  const after = memoryQuestionnaire({
    event: { type: 'message' }, points: { read: edited },
    recalls: [{ backend: 'h', scope: 'project', operations: ['search'] }],
  });
  assert.equal(after.questions.recall_gate.criteria.none, 'EDITED-NONE');
});

test('session distillation asks a coarse gate before any candidate', () => {
  // Two levels: judging candidates on a turn the model has already been told to
  // discard wastes the per-candidate slots the character cap exists to protect.
  const distill = loadDecisionPoints().find(point => point.name === 'session.distill');
  assert.deepEqual(questionStages(distill), [['turn_worth_keeping'], ['candidate_selection']]);
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
  // This drives the real executor with a fake transport and asserts the user's
  // point produced a trace, was recorded under its own subject, and reached its own
  // landing — with its own declared state, not the built-in point's.
  const seen = [];
  const decision = {
    async decideBatch(requests) {
      seen.push(requests[0]);
      const questions = requests[0].questions;
      const answers = {};
      for (const [name, question] of Object.entries(questions)) {
        answers[name] = { type: 'choice', choice: Object.keys(question.criteria)[1] };
      }
      return [{ model: 'fake', answers, usage: { latency_ms: 12 } }];
    },
  };
  const landed = [];
  const point = {
    name: 'frontend.style-check', label: '样式检查', trigger: 'before-turn', automation: 'silent-visible',
    stateFields: ['context'],
    questions: { review: { instructions: '这是样式改动吗？', criteria: { no: '不是。', yes: '是。' } } },
    actions: { review: { no: 'proceed', yes: 'ask' } },
  };
  const outcomes = await runPoints([point], {
    decision,
    stateForStage: () => ({ context: '改一下按钮颜色' }),
    landingFor: () => async ({ verb }) => { landed.push(verb); return { verb: verb.verb }; },
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].trace.subject, 'frontend.style-check');
  assert.deepEqual(outcomes[0].answers, [{ name: 'review', choice: 'yes' }]);
  assert.deepEqual(landed, [{ question: 'review', choice: 'yes', verb: 'ask' }]);
  // The state it saw is its own allowlist, not the built-in point's.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(seen.at(-1).state))), ['context']);
});

test('a point of an unclaimed trigger fails loudly instead of silently not running', async () => {
  // A declaration can exist and never be loaded — the audit found exactly that, and
  // it is the hardest failure to notice because it looks present. Naming a trigger
  // no landing claims must be an error, not a shrug.
  await assert.rejects(runPoints([{
    name: 'orphan', trigger: 'before-teatime', automation: 'silent', stateFields: ['message'],
    questions: { q: { instructions: 'x', criteria: { no: 'no', yes: 'yes' } } },
    actions: { q: { no: 'proceed', yes: 'proceed' } },
  }], {
    decision: { async decideBatch() { return [{ model: 'fake', answers: { q: { type: 'choice', choice: 'no' } } }]; } },
    stateForStage: () => ({ message: 'hi' }),
    landingFor: point => landingFor(point, {}),
  }), /No landing registered for orphan/);
});

test('a user declaration replaces the built-in of the same name instead of duplicating it', async () => {
  // The bug this holds: appending the user's point left two entries named
  // `memory.read`, and every lookup returned the built-in — so an edited criterion
  // validated, showed in the settings panel, and changed nothing at runtime.
  const { mergeDeclarations } = await import('../src/plugin.mjs');
  const { memoryRead, memoryWrite, commandSafety, sessionDistill } = await import('../src/decision-points.mjs');
  const builtins = [memoryRead, memoryWrite, commandSafety, sessionDistill];
  const edited = { ...memoryRead, questions: { ...memoryRead.questions,
    recall_gate: { instructions: 'edited', criteria: { none: 'EDITED', memory: 'EDITED-M' } } } };
  const merged = mergeDeclarations(builtins, [edited]);
  assert.equal(merged.filter(point => point.name === 'memory.read').length, 1, 'no duplicate name may survive');
  assert.equal(merged.find(point => point.name === 'memory.read').questions.recall_gate.criteria.none, 'EDITED');
  // The other built-ins are untouched.
  assert.ok(merged.some(point => point.name === 'session.distill'));
  // A genuinely new point is added rather than replacing anything.
  const extra = { name: 'frontend.css', trigger: 'before-turn', automation: 'silent', stateFields: ['message'],
    questions: { q: { instructions: 'i', criteria: { no: 'n', yes: 'y' } } }, actions: { q: { no: 'proceed', yes: 'proceed' } } };
  const withExtra = mergeDeclarations(builtins, [extra]);
  assert.equal(withExtra.length, builtins.length + 1);
  assert.ok(withExtra.some(point => point.name === 'frontend.css'));
});

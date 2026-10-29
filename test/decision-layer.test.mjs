// The decision layer is the part that must outlive any single judging concern.
// These tests pin the two things a second subject would depend on: a record whose
// shape does not mention memory, and a stage plan that separates independent
// judgments from dependent ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionRecord, planStages, createAnswerReader, judgeState, resolveAutomationTier, validateDecisionPoint } from '../src/decision-layer.mjs';

const question = options => ({ type: 'choice', instructions: 'pick', criteria: Object.fromEntries(options.map(option => [option, option])) });

test('a decision record carries no memory vocabulary', () => {
  // A second subject has to fit in the same log without the viewer knowing what it
  // judges. If this record mentioned gates or scopes, that would be untrue.
  const record = decisionRecord({
    subject: 'command.safety',
    questions: { risk: question(['safe', 'ask']) },
    answers: { risk: { choice: 'ask', confidence: 0.9 } },
    actions: [{ operation: 'ask', command: 'rm -rf /' }],
    outcome: 'asked',
  });
  assert.equal(record.subject, 'command.safety');
  assert.deepEqual(record.questions.map(q => [q.name, q.options]), [['risk', ['safe', 'ask']]]);
  assert.deepEqual(record.answers.map(a => [a.name, a.choice, a.confidence]), [['risk', 'ask', 0.9]]);
  assert.equal(record.outcome, 'asked');
  assert.equal(JSON.stringify(record).includes('scope'), false);
  assert.equal(JSON.stringify(record).includes('recall'), false);
});

test('independent judgments group into one stage, dependent ones do not', () => {
  // Reading and writing memory are independent; choosing a retrieval mode depends
  // on the read gate. The plan must reflect that so the first two can share a
  // request while the third waits.
  const stages = planStages([
    { name: 'read' },
    { name: 'write' },
    { name: 'mode', depends: ['read'] },
    { name: 'project', depends: ['mode'] },
  ]);
  assert.equal(stages.length, 3);
  assert.deepEqual(stages[0].map(s => s.name).sort(), ['read', 'write']);
  assert.deepEqual(stages[1].map(s => s.name), ['mode']);
  assert.deepEqual(stages[2].map(s => s.name), ['project']);
});

test('a dependency cycle is a declaration error, not a runtime guess', () => {
  assert.throws(() => planStages([{ name: 'a', depends: ['b'] }, { name: 'b', depends: ['a'] }]), /cycle/i);
  assert.throws(() => planStages([{ name: 'a', depends: ['missing'] }]), /unknown dependency/i);
});

test('an answer outside the offered options is rejected', () => {
  const questions = { risk: question(['safe', 'ask']) };
  const answer = createAnswerReader(questions);
  const response = { answers: { risk: { type: 'choice', choice: 'maybe' } } };
  assert.throws(() => answer(response, 'risk'), /Invalid choice/);
  assert.equal(answer({ answers: { risk: { type: 'choice', choice: 'safe' } } }, 'risk'), 'safe');
});

test('judged state is an allowlist, not whatever the caller passes', () => {
  // A narrow model does not reason: extra state dilutes its criteria rather than
  // helping. So an unlisted field never reaches it, even if the caller set it.
  const { state, truncated } = judgeState({
    message: 'rename this function', candidates: ['a', 'b'],
    conversationHistory: ['x'.repeat(5000)], secretToken: 'hunter2',
  });
  assert.deepEqual(Object.keys(state).sort(), ['candidates', 'message']);
  assert.equal(state.secretToken, undefined);
  assert.deepEqual(truncated, []);
});

test('overlong state is truncated and the truncation is reported', () => {
  const { state, truncated } = judgeState({ message: 'x'.repeat(2_500) });
  assert.equal(state.message.length, 2_000);
  assert.deepEqual(truncated, ['message'], 'a reader must be able to tell the model saw a cut-off message');
});

test('a user may tighten automation but never loosen it', () => {
  // The author's tier says how much autonomy the design accounted for.
  assert.equal(resolveAutomationTier({ authorTier: 'silent', userTier: 'ask' }), 'ask');
  assert.equal(resolveAutomationTier({ authorTier: 'silent', userTier: 'silent-visible' }), 'silent-visible');
  assert.equal(resolveAutomationTier({ authorTier: 'silent-visible', userTier: 'ask' }), 'ask');
  // Asking for more autonomy than the author allowed is clamped, not rejected.
  assert.equal(resolveAutomationTier({ authorTier: 'ask', userTier: 'silent' }), 'ask');
  assert.equal(resolveAutomationTier({ authorTier: 'silent' }), 'silent');
});

test('a decision point missing criteria is rejected at load time', () => {
  // The dangerous failure is silent: an empty criterion still gets answered, so
  // nothing looks broken while the choice means nothing.
  const base = { name: 'command.safety', trigger: 'before-tool', automation: 'ask', actions: { safe: 'proceed', risky: 'ask' } };
  assert.deepEqual(validateDecisionPoint({ ...base, questions: { risk: { type: 'choice', criteria: { safe: 'safe', risky: 'risky' } } } }), []);
  assert.match(validateDecisionPoint({ ...base, questions: {} }).join(), /at least one question/);
  assert.match(validateDecisionPoint({ ...base, questions: { risk: { criteria: { safe: 'only one' } } } }).join(), /at least two options/);
  assert.match(validateDecisionPoint({ ...base, questions: { risk: { criteria: { a: 'A', b: '  ' } } } }).join(), /needs a criterion/);
  assert.match(validateDecisionPoint({ ...base, automation: 'fast', questions: { q: { criteria: { a: 'A', b: 'B' } } } }).join(), /automation/);
  assert.match(validateDecisionPoint({ ...base, actions: { safe: 'explode' }, questions: { q: { criteria: { a: 'A', b: 'B' } } } }).join(), /not one of/);
});

/**
 * The declaration executor.
 *
 * This module is what the declaration layer degrades to: it reads a declaration,
 * builds the questionnaire from it, asks the transport, and interprets answers
 * through the declaration's own action table. It holds no memory semantics — it
 * does not know what "retain" means, only that the declaration says a `retain`
 * answer authorizes `store`. Everything subject-specific lives in a *landing*: a
 * function supplied by the caller that knows how to turn one authorized verb plus
 * its answer into a real effect.
 *
 * Keeping the split at exactly this line is what makes the extension claim true:
 * a new decision point is a declaration plus a landing it names, and neither the
 * layer nor any other point changes.
 */
import { declaredDependencies, planStages } from './decision-layer.mjs';
import { stateFor } from './decision-points.mjs';

/** The verbs a landing must be able to honour. A declaration validated against
 * ACTION_KINDS cannot ask for anything outside this set. */
const LANDING_VERBS = Object.freeze(['proceed', 'skip', 'ask', 'inject', 'store', 'route']);

/**
 * Resolve the landing for one decision point.
 *
 * Landings are supplied per trigger, because the trigger is the extension point
 * the platform actually offers — a `before-tool-call` landing gets a tool call, a
 * `before-turn` landing gets a message. A point of an unclaimed trigger has no
 * landing, which is a declaration error rather than a runtime shrug.
 */
export function landingFor(point, landings = {}) {
  const landing = landings[point.name] ?? landings[point.trigger];
  if (!landing) throw new Error(`No landing registered for ${point.name} (trigger ${point.trigger})`);
  return landing;
}

/**
 * Order a point's questions so a question that depends on another is asked only
 * after its prerequisite has answered.
 *
 * This is separate from `planStages`, which orders *points*. Session distillation
 * declares a dependency between two of ITS questions — the coarse gate over the
 * whole turn, then a per-candidate selection — and that dependency is intra-point.
 * Running both in one request would ask the model to judge candidates on a turn it
 * has already been told to discard.
 *
 * Returns question groups in order: each group is a set of question names that may
 * share one request.
 */
export function questionStages(point) {
  const depends = point?.questionDepends ?? {};
  const names = Object.keys(point?.questions ?? {});
  const depth = new Map();
  const visit = (name, seen = new Set()) => {
    if (depth.has(name)) return depth.get(name);
    if (seen.has(name)) throw new Error(`Question dependency cycle at ${point?.name}.${name}`);
    seen.add(name);
    const parents = [].concat(depends[name] ?? []).map(parent => {
      if (!Object.hasOwn(point.questions, parent)) throw new Error(`Unknown question dependency ${parent}`);
      return visit(parent, seen);
    });
    const value = parents.length ? Math.max(...parents) + 1 : 0;
    depth.set(name, value);
    return value;
  };
  const stages = [];
  for (const name of names) (stages[visit(name)] ??= []).push(name);
  return stages.filter(Boolean);
}

/**
 * Ask one point, honouring intra-point question dependencies.
 *
 * `shouldContinue` lets the caller stop after a gate without the executor knowing
 * what the gate meant: distillation passes a predicate that stops when the coarse
 * turn-level answer was `discard`. The executor passes the answers forward and
 * stays ignorant of their meaning.
 */
export async function askPointStaged(point, { decision, state, facts, signal, timeoutMs = 15_000, shouldContinue }) {
  const stages = questionStages(point);
  if (!stages.length) return undefined;
  const projected = stateFor(point, state);
  const allAnswers = [];
  const allVerbs = [];
  const answeredNames = [];
  let lastResponse;
  for (const [index, names] of stages.entries()) {
    // A dependent question is only asked once its prerequisite actually answered
    // with a choice that authorizes asking it. `shouldContinue` carries that
    // judgment for the caller; absent one, every stage is asked.
    if (index > 0 && typeof shouldContinue === 'function') {
      if (!shouldContinue({ answers: allAnswers, point })) break;
    }
    const questions = {};
    for (const name of names) {
      const question = point.questions[name];
      if (typeof question.when === 'function' && !question.when(facts)) continue;
      questions[name] = { type: 'choice', instructions: question.instructions, criteria: question.criteria };
    }
    if (!Object.keys(questions).length) continue;
    const [response] = await decision.decideBatch(
      [{ id: point.name, state: projected.state, questions }],
      { signal: signal ?? AbortSignal.timeout(timeoutMs) },
    );
    lastResponse = response;
    for (const name of Object.keys(questions)) {
      const answer = response?.answers?.[name];
      if (!answer || typeof answer.choice !== 'string') continue;
      if (!Object.hasOwn(questions[name].criteria, answer.choice)) continue;
      const entry = { name, choice: answer.choice };
      if (Number.isFinite(answer.confidence)) entry.confidence = answer.confidence;
      allAnswers.push(entry);
      answeredNames.push(name);
      const verb = point.actions?.[name]?.[answer.choice];
      if (verb) allVerbs.push({ question: name, choice: answer.choice, verb });
    }
  }
  if (!allAnswers.length) return undefined;
  return {
    answers: allAnswers,
    verbs: allVerbs,
    trace: {
      schemaVersion: 1,
      kind: point.trigger === 'before-tool-call' ? 'safety' : point.trigger === 'end-of-session' ? 'distillation' : 'retrieval',
      subject: point.name,
      status: 'ok',
      question: typeof projected.state.message === 'string' ? projected.state.message
        : typeof projected.state.context === 'string' ? projected.state.context : '',
      decision: {
        protocol: 'systemone',
        model: lastResponse?.model ?? 'unknown',
        questionNames: answeredNames,
        answers: Object.fromEntries(allAnswers.map(answer => [answer.name, { choice: answer.choice, ...(answer.confidence !== undefined ? { probabilities: { [answer.choice]: answer.confidence } } : {}) }])),
        questionOptions: Object.fromEntries(answeredNames.map(name => [name, Object.keys(point.questions[name].criteria)])),
        durationMs: Math.round(Number(lastResponse?.usage?.latency_ms) || 0),
      },
      ...(projected.truncated.length ? { truncated: projected.truncated } : {}),
    },
  };
}

/**
 * Ask one point and interpret its answers into a plan the landing understands.
 *
 * Returns `{ answers, verbs, trace }` or `undefined` when the model gave nothing
 * usable. `verbs` is ordered by question, and carries the parameter the answer
 * named so a landing can act on it without re-reading the questionnaire.
 */
export async function askPoint(point, options) {
  return askPointStaged(point, options);
}

/**
 * Run a set of points in declaration order and hand each authorized verb to its
 * landing.
 *
 * Ordering is real, not decorative: `planStages` groups points so that a point
 * declaring `depends` on another runs after it, and the second stage's state may
 * be built from the first stage's outcome. Points with no dependency share a
 * stage, and a stage with several points asks them in one batch — the measured
 * cost of several questions about one subject in one request is nearly the same
 * as one.
 *
 * `stateForStage(point, previous)` builds each point's judged state, so a
 * dependent point can be shown what its prerequisite answered. That is the only
 * channel between stages; the executor never inspects an answer's meaning.
 */
export async function runPoints(points, { decision, stateForStage, landingFor: resolve, facts, signal, timeoutMs, onPoint = () => {} }) {
  const stages = planStages(points);
  const outcomes = [];
  let previous = [];
  for (const stage of stages) {
    // Independent points in one stage share a request. Asking them separately
    // would spend a round trip each for questions the transport can carry
    // together, which is the cost the batching decision was made to avoid.
    const asked = await Promise.all(stage.map(async point => {
      const landing = resolve(point);
      const state = typeof stateForStage === 'function' ? await stateForStage(point, previous) : stateForStage;
      if (state === undefined) return { point, landing, skipped: 'no-state' };
      const result = await askPoint(point, { decision, state, facts, signal, timeoutMs });
      return { point, landing, result };
    }));
    const stageOutcomes = [];
    for (const entry of asked) {
      if (entry.skipped) { stageOutcomes.push({ point: entry.point, skipped: entry.skipped }); continue; }
      if (!entry.result) { stageOutcomes.push({ point: entry.point, skipped: 'no-answer' }); continue; }
      const landed = [];
      for (const verb of entry.result.verbs) {
        if (!LANDING_VERBS.includes(verb.verb)) continue;
        // A dependent question may be skipped by its own `when`; a verb for a
        // question that was never asked cannot arrive, so no filter is needed here.
        const applied = await entry.landing({ point: entry.point, verb, answers: entry.result.answers, trace: entry.result.trace, signal });
        if (applied !== undefined) landed.push(applied);
      }
      const outcome = { point: entry.point, answers: entry.result.answers, verbs: entry.result.verbs, trace: entry.result.trace, landed };
      stageOutcomes.push(outcome);
      try { onPoint(outcome); } catch { /* observability must not alter execution */ }
    }
    outcomes.push(...stageOutcomes);
    previous = stageOutcomes;
  }
  return outcomes;
}

/** Whether an outcome authorized a given verb. Used by tests and by landings that
 * need to know what else the same request decided. */
export const authorized = (outcome, verb) => Array.isArray(outcome?.verbs) && outcome.verbs.some(item => item.verb === verb);

export { declaredDependencies, planStages };

/**
 * The decision layer: run a questionnaire against a narrow-judgment model and
 * turn validated answers into actions.
 *
 * This module knows nothing about memory. A subject supplies the questions and
 * interprets the answers; the layer supplies transport, validation, timeout,
 * batching and the shape of the record. Keeping that boundary explicit is what
 * lets a second subject (command safety, task routing) be added without editing
 * the memory path, and without the memory path leaking its vocabulary here.
 */

/** Answers must be a typed choice among exactly the options the questionnaire offered. */
export function createAnswerReader(questions) {
  const read = (name, allowed) => {
    const question = questions[name];
    if (question === undefined) throw new Error(`Unknown question ${name}`);
    const options = Object.keys(question.criteria ?? {});
    if (!allowed) allowed = options;
    return choice => {
      if (!allowed.includes(choice)) throw new Error(`Invalid choice ${choice} for ${name}`);
      return choice;
    };
  };
  return (response, name, allowed) => {
    const answer = response?.answers?.[name];
    if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
      throw new Error('Invalid decision response');
    }
    read(name, allowed)(answer.choice);
    return answer.choice;
  };
}

/**
 * The durable, subject-neutral record of one decision. `subject` names which
 * judging concern produced it; everything below is the same for every subject so
 * the log and the viewer never need per-subject storage.
 */
export function decisionRecord({ subject, mode = 'single', questions = {}, answers = {}, actions = [], outcome })
{
  return Object.freeze({
    subject: String(subject),
    mode,
    questions: Object.freeze(Object.entries(questions).map(([name, question]) => Object.freeze({
      name,
      options: Object.freeze(Object.keys(question.criteria ?? {})),
    }))),
    answers: Object.freeze(Object.entries(answers).map(([name, answer]) => Object.freeze({
      name,
      choice: String(answer.choice),
      ...(Number.isFinite(answer.confidence) ? { confidence: answer.confidence } : {}),
    }))),
    actions: Object.freeze(actions.map(action => Object.freeze({ ...action }))),
    ...(outcome === undefined ? {} : { outcome: String(outcome) }),
  });
}

/**
 * Order judgments so dependencies run before their dependents, and group
 * independent ones at the same depth so they can share one request.
 *
 * Returns `[[a, b], [c]]`: entry n may run only after every entry before it has
 * resolved, and members of one entry have no dependency on each other. A cycle is
 * a programming error in the subject declaration, not a runtime condition, so it
 * throws rather than guessing.
 */
export function planStages(subjects) {
  const byName = new Map(subjects.map(subject => [subject.name, subject]));
  const depth = new Map();
  const visit = (subject, seen = new Set()) => {
    if (depth.has(subject.name)) return depth.get(subject.name);
    if (seen.has(subject.name)) throw new Error(`Dependency cycle at ${subject.name}`);
    seen.add(subject.name);
    const parents = (subject.after ?? []).map(name => {
      const parent = byName.get(name);
      if (parent === undefined) throw new Error(`Unknown dependency ${name}`);
      return visit(parent, seen);
    });
    const value = parents.length ? Math.max(...parents) + 1 : 0;
    depth.set(subject.name, value);
    return value;
  };
  const stages = [];
  for (const subject of subjects) {
    const at = visit(subject);
    (stages[at] ??= []).push(subject);
  }
  return stages.filter(Boolean);
}

/** The fields a decision point may show the judgment model.
 *
 * A narrow model has no reasoning to spend: a long state does not give it more to
 * think about, it dilutes the criteria it was given. So judged state is an explicit
 * allowlist rather than "whatever the caller passes" — the current message and the
 * candidate set, never the whole conversation. */
export const JUDGED_STATE_FIELDS = Object.freeze(['message', 'candidates', 'environment', 'residentDigest', 'context']);

/** Cap on how much of any single field reaches the model. */
export const JUDGED_STATE_CHARS = 2_000;

/**
 * Project a caller's state onto the allowlist, and truncate what survives.
 *
 * Truncation is recorded rather than silent: an answer produced from a cut-off
 * message is still an answer, but a reader of the log should be able to tell that
 * the model did not see all of it.
 */
export function judgeState(raw, { fields = JUDGED_STATE_FIELDS, limit = JUDGED_STATE_CHARS } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const kept = {};
  const truncated = [];
  for (const field of fields) {
    if (!Object.hasOwn(source, field) || source[field] === undefined || source[field] === null) continue;
    const value = source[field];
    if (typeof value === 'string') {
      if (value.length > limit) { kept[field] = value.slice(0, limit); truncated.push(field); }
      else kept[field] = value;
      continue;
    }
    let encoded;
    try { encoded = JSON.stringify(value); } catch { continue; }
    if (encoded === undefined) continue;
    if (encoded.length > limit) { kept[field] = encoded.slice(0, limit); truncated.push(field); }
    else kept[field] = JSON.parse(encoded);
  }
  return { state: kept, truncated };
}

/** Automation tiers, ordered from most autonomous to least.
 *
 * Order matters: a user may move a decision point toward asking more often, never
 * back toward acting on its own. Loosening past the author's choice would let
 * misjudgments the author never designed for take effect silently. */
export const AUTOMATION_TIERS = Object.freeze(['silent', 'silent-visible', 'ask']);

/**
 * Resolve the tier a decision point actually runs at.
 *
 * The author's tier is a ceiling on autonomy, not a floor. A user may tighten it
 * (silent → silent-visible → ask); asking for something more autonomous than the
 * author allowed is quietly clamped, because rejecting the setting would leave the
 * plugin unusable over a difference the user cannot see.
 */
export function resolveAutomationTier({ authorTier, userTier } = {}) {
  const authorIndex = AUTOMATION_TIERS.indexOf(authorTier);
  if (authorIndex === -1) throw new Error(`Unknown author tier ${authorTier}`);
  if (userTier === undefined) return authorTier;
  const userIndex = AUTOMATION_TIERS.indexOf(userTier);
  if (userIndex === -1) throw new Error(`Unknown user tier ${userTier}`);
  return AUTOMATION_TIERS[Math.max(authorIndex, userIndex)];
}

/** The action names a decision point may authorize. Closed set: a declaration
 * composes these, it cannot invent one, so the executor never meets an unknown
 * verb at runtime. */
export const ACTION_KINDS = Object.freeze(['proceed', 'skip', 'ask', 'inject', 'store', 'route']);

/**
 * Validate a declarative decision point before it is allowed to run.
 *
 * A misconfigured point fails quietly in the worst way: the questionnaire still
 * gets answered, so nothing looks broken, but the criteria are empty and the
 * choices are meaningless. Rejecting at load time turns that into a visible error.
 */
export function validateDecisionPoint(point) {
  const errors = [];
  if (!point || typeof point !== 'object') return ['a decision point must be an object'];
  if (typeof point.name !== 'string' || !point.name.trim()) errors.push('name is required');
  if (typeof point.trigger !== 'string' || !point.trigger.trim()) errors.push('trigger is required');
  if (!AUTOMATION_TIERS.includes(point.automation)) errors.push(`automation must be one of ${AUTOMATION_TIERS.join(', ')}`);
  const questions = point.questions;
  if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
    errors.push('at least one question is required');
  } else {
    for (const [name, question] of Object.entries(questions)) {
      const criteria = question?.criteria;
      if (!criteria || typeof criteria !== 'object') { errors.push(`question ${name} needs criteria`); continue; }
      const options = Object.keys(criteria);
      if (options.length < 2) errors.push(`question ${name} needs at least two options`);
      for (const option of options) {
        if (typeof criteria[option] !== 'string' || !criteria[option].trim()) errors.push(`question ${name} option ${option} needs a criterion`);
      }
      if (question.type !== undefined && question.type !== 'choice') errors.push(`question ${name} must be type choice`);
    }
  }
  // `actions` maps a question to the action each of its answers authorizes, so
  // validation has to walk one level down. A flat list is also accepted: a point
  // may authorize the same verb regardless of the answer.
  const actions = point.actions ?? {};
  const seen = new Set();
  for (const [name, value] of Object.entries(actions)) {
    if (typeof value === 'string') { seen.add(value); continue; }
    if (value && typeof value === 'object') {
      for (const [option, action] of Object.entries(value)) {
        if (questions && !Object.hasOwn(questions, name)) errors.push(`action refers to unknown question ${name}`);
        else if (questions?.[name] && !Object.hasOwn(questions[name].criteria ?? {}, option)) {
          errors.push(`action refers to unknown option ${option} of ${name}`);
        }
        seen.add(action);
      }
      continue;
    }
    errors.push(`action for ${name} must be a verb or a map of options to verbs`);
  }
  for (const action of seen) {
    if (!ACTION_KINDS.includes(action)) errors.push(`action ${action} is not one of ${ACTION_KINDS.join(', ')}`);
  }
  if (!seen.size) errors.push('at least one action is required');
  return errors;
}

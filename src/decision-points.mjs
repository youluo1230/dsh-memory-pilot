/**
 * Built-in decision points.
 *
 * Each entry is a declaration, not code: what it judges, what it may see, what it
 * asks, and which closed action each answer authorizes. Adding a capability means
 * adding an entry here (or loading a user's own), never editing the decision layer
 * or the memory path. That separation is the whole point of the layer, so the first
 * non-memory point below is also the test of whether the abstraction holds.
 *
 * These declarations are the ONLY copy of their criteria. The memory questionnaires
 * used to be private string literals in the adapter while a second, differently
 * worded copy sat here and a third sat in the retention path; the criteria are the
 * whole source of accuracy, so three copies meant three mutually unaware accuracies
 * and no way to know which one was in effect.
 */
import { judgeState, resolveAutomationTier, validateDecisionPoint } from './decision-layer.mjs';

/**
 * The tuned retention criterion.
 *
 * The wording below is the measured one: it names the shapes that count (an
 * explicit standing instruction, a correction stated as conversation, a durable
 * project fact) and the shapes that do not, because abstract wording such as
 * "durable" misjudged both directions in testing. Every other place that needs
 * this judgment imports it rather than restating it.
 */
export const RETENTION_QUESTION = Object.freeze({
  instructions: 'Independent of whether anything was read: decide whether this message contains something durable worth storing. Judge the content, not phrases such as remember this.',
  criteria: Object.freeze({
    discard: 'Do not retain: greetings, acknowledgements, thanks, transient status, this-run plans or progress, raw tool/log output, secrets, unverified speculation, generic public knowledge, or chit-chat with no durable content. Do NOT discard merely because the message is phrased as conversation — a correction stated conversationally is still a correction.',
    retain: 'Retain: (a) an explicit stable preference or instruction ("叫我阿宝", "以后用 pnpm"); (b) a correction — the user says the assistant remembered something WRONG and states what is actually true, including replace/remove/change wording ("不对", "其实不是", "已经不用了", "都卸载了", "换成了", "把这个忘掉"); (c) a durable project fact, constraint, or setup detail; (d) a confirmed decision with its rationale; (e) a verified milestone. Judge by whether a future session would be wrong without it — a correction almost always qualifies, because the wrong fact is presumably already stored.',
  }),
});

/**
 * The tuned recall criterion.
 *
 * Same reason as above: the shapes are named rather than left abstract. Measured
 * failures with abstract wording: "rename this function" was sent to memory
 * (nothing historical in it) while "how do I run this project's tests" was not (a
 * project convention it cannot invent). Naming the shapes moves both correctly.
 */
export const RECALL_QUESTION = Object.freeze({
  instructions: 'Decide whether handling this message needs cross-session memory. Judge only the need for stored history; a capable model sees the whole current message already.',
  criteria: Object.freeze({
    none: 'No stored history needed. The message is self-contained: it names what to change, or asks for anything the current message, open files, and general knowledge already answer. Includes present-tense actions on named targets ("rename this function", "fix this typo", "run it again"), greetings, thanks, definitions, and translation.',
    memory: 'Cannot be answered without stored history. (a) It asks about prior work, decisions, or causes: "why did we", "what did we try", "do you remember", "last time", "that bug". (b) OR it asks how THIS project is set up or operated — an established convention with one right answer here that the current message does not state and a general answer cannot supply: "how do I run the tests here", "what model does this use", "where is this configured", "what is our build command". Choose memory for (b) even when the sentence mentions no past event, because the answer is a recorded project fact rather than general knowledge. (c) OR it asks what this user or project is currently working on — "what are we working on", "我们在做什么", "what is this project" — when resident memory does not already state it.',
  }),
});

/** What each memory scope means, in the words retention and recall both need. */
export const SCOPE_MEANINGS = Object.freeze({
  read: Object.freeze({
    global: 'cross-workspace user history, preferences, and projects',
    workspace: 'history shared by repositories in the current workspace',
    project: 'decisions, attempts, and facts about the current repository',
    personal: 'private user-specific history',
  }),
  write: Object.freeze({
    global: 'cross-workspace user preferences, identity, enduring instructions, and project portfolio',
    workspace: 'durable facts shared by repositories in this workspace',
    project: 'durable decisions, constraints, milestones, and reusable findings for the current repository',
    personal: 'private enduring user preferences and facts',
  }),
});

/**
 * Build the write-scope questions for a point.
 *
 * Scopes are derived from the candidates the runtime actually offers, so a point
 * never asks about a scope nothing can write to. The declaration carries the shape;
 * the runtime supplies which scopes exist.
 */
export function writeScopeQuestions(scopes) {
  const questions = {};
  for (const scope of scopes) {
    const meaning = SCOPE_MEANINGS.write[scope];
    if (!meaning) continue;
    questions[`write_scope_${scope}`] = {
      instructions: `If retention_gate chooses retain, decide whether the content belongs in ${scope} memory: ${meaning}`,
      criteria: { skip: `The content does not belong in ${scope} memory.`, write: `Retain it in ${scope} memory because it is ${meaning}.` },
    };
  }
  return questions;
}

/** Build the read-scope questions for a point, from the scopes that can answer. */
export function readScopeQuestions(scopes) {
  const questions = {};
  for (const scope of scopes) {
    const meaning = SCOPE_MEANINGS.read[scope];
    if (!meaning) continue;
    questions[`scope_${scope}`] = {
      instructions: `If memory is needed, decide whether ${meaning} can answer or materially inform the request.`,
      criteria: { skip: `The request does not need ${meaning}.`, query: `Query ${scope} memory because the request needs ${meaning}.` },
    };
  }
  return questions;
}

/** Read memory: whether it is needed, how deep, and which scopes answer it.
 *
 * `residentDigest` is declared because the criterion for `memory` explicitly
 * defers to what resident memory already states — and the runtime now supplies it.
 * A declaration naming a field the host never provided was the original silent
 * failure: this point judged "does resident memory already hold this?" against a
 * field that was always absent.
 */
const memoryRead = {
  name: 'memory.read',
  trigger: 'before-turn',
  automation: 'silent',
  stateFields: ['message', 'residentDigest'],
  questions: {
    recall_gate: RECALL_QUESTION,
    retrieval_mode: {
      instructions: 'If memory is needed, choose lightweight factual recall or deep historical synthesis.',
      criteria: {
        recall: 'Use latency-bounded retrieval of relevant observations or traces.',
        reflect: 'Use slower deep synthesis for rationale, aggregation, or historical reasoning.',
      },
    },
  },
  actions: { recall_gate: { none: 'proceed', memory: 'route' } },
  depends: [],
};

/** Write memory: whether this message carries something durable, judged apart from
 * whether anything was read — a message can need no lookup and still be worth
 * storing. */
const memoryWrite = {
  name: 'memory.write',
  trigger: 'before-turn',
  automation: 'silent',
  stateFields: ['message', 'residentDigest'],
  questions: { retention_gate: RETENTION_QUESTION },
  actions: { retention_gate: { discard: 'proceed', retain: 'store' } },
  depends: [],
};

/**
 * Command safety: the severity of a pending tool call.
 *
 * This is the point that proves the layer is not memory-shaped. It shares
 * transport, ordering, recording and validation with the memory points and adds
 * nothing to them.
 *
 * It reports severity, not a decision. Whether the user is asked is the automation
 * tier's business (`src/tool-guard.mjs`), because the author sets a default and the
 * user may only tighten it — a point that returned `ask` directly would let a
 * misjudgment bypass a user's own "always ask" setting.
 */
const commandSafety = {
  name: 'command.safety',
  trigger: 'before-tool-call',
  // The author's default tier. `silent-visible` lets a destructive call proceed but
  // leaves a record, which is the least intrusive setting that is still honest about
  // what happened. A user may tighten it to `ask`; the shipped default does.
  automation: 'silent-visible',
  stateFields: ['context'],
  questions: {
    severity: {
      instructions: 'Decide how costly this pending tool call would be if it were WRONG. Judge the call, not whether it is useful, and judge what it actually does rather than how it is phrased.',
      criteria: {
        reversible: 'Reversible and contained: reading, listing, searching, formatting, running tests, creating a file that did not exist, writing inside the workspace where undo is trivial. Running it again costs nothing.',
        destructive: 'Cannot be taken back cheaply: deletion, overwriting or force-pushing, moving files between directories, killing processes, rewriting history, a write whose previous value is not recoverable.',
        unknown: 'The call itself looks fine but its blast radius cannot be told from the call alone — a script, a build, a migration whose scope depends on state the criteria cannot see. Unknown is not dangerous; it is not-yet-known.',
        'out-of-scope': 'Reaches outside the task or workspace: touching paths outside the workspace, changing global configuration, installing globally, spending money, pushing to a shared branch, anything whose effects another person or project feels.',
      },
    },
  },
  actions: {
    severity: {
      reversible: 'proceed',
      unknown: 'proceed',
      destructive: 'ask',
      'out-of-scope': 'ask',
    },
  },
  depends: [],
};

/**
 * Session distillation: which conclusions a finished conversation produced.
 *
 * Two levels, deliberately. The first question is one cheap gate over the whole
 * turn and is expected to discard most turns outright — running a per-candidate
 * judgment on a turn that said nothing durable wastes the whole budget. Only when
 * the gate passes are the candidates judged, and the candidates are cut by the
 * plugin: the judgment model may pick, never invent, so the words that land in
 * memory are the conversation's own.
 */
const sessionDistill = {
  name: 'session.distill',
  trigger: 'end-of-session',
  automation: 'silent',
  stateFields: ['candidates', 'residentDigest'],
  questions: {
    turn_worth_keeping: {
      instructions: 'Decide whether this finished turn produced anything a future session would be wrong without. Judge the turn as a whole; it is fine to discard most turns.',
      criteria: {
        discard: 'Nothing durable here: greetings, acknowledgements, status reports, this-run plans and progress, raw tool or log output, unanswered questions, restated context, chit-chat. A turn that only ran commands and reported them has nothing to keep.',
        keep: 'This turn produced something durable: a stated preference or standing instruction, a decision with its reason, a correction of a wrong belief, a project fact or constraint, a verified outcome, or a conclusion the discussion reached. Judge by whether losing it would cost a future session real work.',
      },
    },
    candidate_selection: {
      instructions: 'For each candidate, decide retain or discard. Candidates are excerpts cut from the turn by the plugin; judge only the ones given, and do not prefer a candidate for being long.',
      criteria: {
        discard: 'The candidate is conversational filler, restated context, a proposal nobody agreed to, or a detail only meaningful inside this run.',
        retain: 'The candidate states something durable and self-contained: it would still be true, and still useful, in a new session that never saw this one. Prefer the candidate that states a fact over the one that only refers to it.',
      },
      when: facts => Array.isArray(facts?.candidates) && facts.candidates.length > 0,
    },
  },
  actions: {
    turn_worth_keeping: { discard: 'proceed', keep: 'store' },
    candidate_selection: { discard: 'skip', retain: 'store' },
  },
  // Two levels inside one point: `candidate_selection` is only asked once the
  // coarse gate said `keep`. A point-level dependency would be the wrong scope —
  // no other point depends on this one.
  questionDepends: { candidate_selection: 'turn_worth_keeping' },
  depends: [],
};

export const BUILTIN_DECISION_POINTS = Object.freeze([memoryRead, memoryWrite, commandSafety, sessionDistill]);

/**
 * Load decision points, refusing any that are malformed.
 *
 * Built-ins and user declarations go through the same validation: a user's point
 * that passes validation is exactly as trusted as a built-in one, and a broken one
 * fails loudly at load instead of producing meaningless answers at runtime.
 */
export function loadDecisionPoints(declarations = BUILTIN_DECISION_POINTS) {
  const points = [];
  const errors = [];
  for (const declaration of declarations) {
    const problems = validateDecisionPoint(declaration);
    if (problems.length) { errors.push(`${declaration?.name ?? '(unnamed)'}: ${problems.join('; ')}`); continue; }
    points.push(declaration);
  }
  if (errors.length) throw new Error(`Invalid decision points: ${errors.join(' | ')}`);
  return Object.freeze(points);
}

/** Build the questionnaire for a point, leaving out dependent questions whose
 * prerequisite has not been satisfied — asking them anyway wastes a slot and lets
 * the model answer a question that does not apply. */
export function questionsFor(point, { facts = {} } = {}) {
  const questions = {};
  for (const [name, question] of Object.entries(point.questions)) {
    if (typeof question.when === 'function' && !question.when(facts)) continue;
    questions[name] = { type: 'choice', instructions: question.instructions, criteria: question.criteria };
  }
  return questions;
}

/** The state a point is allowed to see, projected onto its own allowlist. */
export function stateFor(point, raw) {
  return judgeState(raw, { fields: point.stateFields ?? ['message'] });
}

export { memoryRead, memoryWrite, commandSafety, sessionDistill, resolveAutomationTier };

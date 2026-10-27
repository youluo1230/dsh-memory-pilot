/**
 * Built-in decision points.
 *
 * Each entry is a declaration, not code: what it judges, what it may see, what it
 * asks, and which closed action each answer authorizes. Adding a capability means
 * adding an entry here (or loading a user's own), never editing the decision layer
 * or the memory path. That separation is the whole point of the layer, so the first
 * non-memory point below is also the test of whether the abstraction holds.
 */
import { judgeState, resolveAutomationTier, validateDecisionPoint } from './decision-layer.mjs';

/** Read memory: whether it is needed, how deep, and which scopes answer it. */
const memoryRead = {
  name: 'memory.read',
  trigger: 'before-turn',
  automation: 'silent',
  stateFields: ['message', 'residentDigest'],
  questions: {
    recall_gate: {
      instructions: 'Decide whether handling this message needs cross-session memory. Judge only the need for stored history; a capable model sees the whole current message already.',
      criteria: {
        none: 'No stored history needed. The message is self-contained: it names what to change, or asks for anything the current message, open files, and general knowledge already answer. Includes present-tense actions on named targets ("rename this function", "fix this typo", "run it again"), greetings, thanks, definitions, and translation.',
        memory: 'Cannot be answered without stored history. (a) It asks about prior work, decisions, or causes: "why did we", "what did we try", "do you remember", "last time", "that bug". (b) OR it asks how THIS project is set up or operated — an established convention with one right answer here that the current message does not state and a general answer cannot supply: "how do I run the tests here", "what model does this use". (c) OR it asks what this user or project is currently working on, when resident memory does not already state it.',
      },
    },
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
  questions: {
    retention_gate: {
      instructions: 'Independent of whether anything was read: decide whether this message contains something durable worth storing. Judge the content, not phrases such as remember this.',
      criteria: {
        discard: 'Do not retain: greetings, acknowledgements, thanks, transient status, this-run plans or progress, raw tool/log output, secrets, unverified speculation, generic public knowledge, or chit-chat with no durable content. Do NOT discard merely because the message is phrased as conversation — a correction stated conversationally is still a correction.',
        retain: 'Retain: (a) an explicit stable preference or instruction ("叫我阿宝", "以后用 pnpm"); (b) a correction — the user says the assistant remembered something WRONG and states what is actually true, including replace/remove/change wording ("不对", "其实不是", "已经不用了", "都卸载了", "换成了", "把这个忘掉"); (c) a durable project fact, constraint, or setup detail; (d) a confirmed decision with its rationale; (e) a verified milestone. Judge by whether a future session would be wrong without it — a correction almost always qualifies, because the wrong fact is presumably already stored.',
      },
    },
  },
  actions: { retention_gate: { discard: 'proceed', retain: 'store' } },
  depends: [],
};

/**
 * Command safety: whether a tool call may run unattended.
 *
 * This is the point that proves the layer is not memory-shaped. It shares
 * transport, ordering, recording and validation with the memory points and adds
 * nothing to them.
 */
const commandSafety = {
  name: 'command.safety',
  trigger: 'before-turn',
  automation: 'ask',
  stateFields: ['context'],
  questions: {
    risk: {
      instructions: 'Decide whether this command may run without asking the user. Judge only what the command does, not whether it is useful.',
      criteria: {
        safe: 'Reads or writes only what the task clearly intends, and the effect is reversible: listing, reading, searching, formatting, running tests, installing into a project-local directory, creating files that did not exist.',
        confirm: 'Irreversible, destructive, or wider than the task: deletion, overwriting or force-pushing, moving files across directories, touching paths outside the workspace, killing processes, changing global configuration, spending money, or anything whose blast radius is unclear.',
      },
    },
  },
  actions: { risk: { safe: 'proceed', confirm: 'ask' } },
  depends: [],
};

export const BUILTIN_DECISION_POINTS = Object.freeze([memoryRead, memoryWrite, commandSafety]);

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

export { memoryRead, memoryWrite, commandSafety, resolveAutomationTier };

/**
 * Build the command-safety judge that runs at `agent/pre-step`.
 *
 * It answers one question — may this turn run unattended — and returns a caution
 * note when the answer is "ask". It is deliberately advisory rather than blocking:
 * `agent/pre-step` runs before the model acts and cannot veto an individual tool
 * call, so the honest thing is to tell the model what was judged and why, not to
 * pretend it stopped anything.
 *
 * Returns `undefined` when the point is disabled or the model is unavailable, so a
 * judgment failure never keeps the turn from proceeding.
 */
export function createSafetyJudge({ decision, point = commandSafety, points, enabled = () => true, timeoutMs = 4_000 }) {
  // User-declared points join the same run. They are validated at load, so anything
  // that reaches here has usable criteria; a point that fails at judgment time is
  // dropped rather than allowed to fail the turn.
  const extra = Array.isArray(points) ? points.filter(item => item && item.name !== point.name) : [];
  return async function judgeSafety(session, input) {
    if (!enabled() || !decision || typeof decision.decideBatch !== 'function') return undefined;
    const primary = await judgeOne(point, input);
    const judged = await Promise.all(extra.map(item => judgeOne(item, input).catch(() => undefined)));
    // Only the primary point can contribute a caution note; extras are recorded,
    // because a custom point's verdict has no built-in meaning to act on.
    return primary ? { ...primary, extras: judged.filter(Boolean) } : (judged.filter(Boolean).length ? { extras: judged.filter(Boolean) } : undefined);
  };

  async function judgeOne(point, { text: userText, turn, step }) {
    const startedAt = Date.now();
    const { state, truncated } = stateFor(point, { context: userText });
    const questions = questionsFor(point);
    // The memory questionnaire is the orchestrator's business; a decision point
    // speaks to the transport directly. `decideBatch` is that transport-level entry
    // point, and with one request it is a single decision.
    const [response] = await decision.decideBatch([{ id: point.name, state, questions }], { signal: AbortSignal.timeout(timeoutMs) });
    // A point may ask several questions; report every answer it actually gave, in
    // the order it asked them, rather than assuming a single fixed question name.
    const answers = [];
    const options = {};
    for (const name of Object.keys(questions)) {
      const answer = response?.answers?.[name];
      if (!answer || typeof answer.choice !== 'string') continue;
      if (!Object.hasOwn(questions[name].criteria, answer.choice)) continue;
      options[name] = Object.keys(questions[name].criteria);
      answers.push({ name, choice: answer.choice, ...(Number.isFinite(answer.confidence) ? { confidence: answer.confidence } : {}) });
    }
    if (!answers.length) return undefined;
    // Alpha-listed actions: the first question that authorizes a non-proceed verb
    // decides what the reader is told. A custom point naming its own options still
    // lands on a verb from the closed set its declaration was validated against.
    const authorized = answers.map(answer => point.actions[answer.name]?.[answer.choice]).filter(Boolean);
    const verdict = authorized.find(verb => verb !== 'proceed') ?? 'proceed';
    const trace = {
      schemaVersion: 1, kind: 'safety', subject: point.name, status: 'ok',
      question: userText, totalDurationMs: Date.now() - startedAt,
      protocol: 'systemone', model: response?.model ?? 'unknown',
      decisionDurationMs: Math.round(Number(response?.usage?.latency_ms) || 0),
      questions: Object.keys(questions), questionOptions: options,
      answers, actions: [{ operation: verdict }], executions: [], injectedChars: 0,
      ...(truncated.length ? { reason: 'truncated' } : {}),
    };
    if (verdict !== 'ask') return { trace };
    const top = answers.find(answer => point.actions[answer.name]?.[answer.choice] === 'ask');
    const percent = Number.isFinite(top?.confidence) ? Math.round(top.confidence * 100) : undefined;
    const caution = [
      `【${point.label ?? point.name}】本轮可能需要你先确认。`,
      `判定：需确认${percent === undefined ? '' : `（${percent}%）`}。`,
      '执行不可逆、破坏性或超出本轮意图的操作前，先向用户说明将要做什么；可逆的读操作直接执行。',
    ].join('\n');
    return { trace, caution, label: `决策提示：${point.label ?? point.name}` };
  }
}

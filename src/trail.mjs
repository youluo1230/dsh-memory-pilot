// Decision trail for the Trajectory view.
//
// Why this module exists: the plugin used to emit `plugin/observation` session
// events, and DSH's persistence read path refuses any event type outside its
// built-in vocabulary unless the envelope carries `ignorable: true` — a marker
// `Session.append()` cannot set (issue #1: history stopped loading). Dropping the
// event fixed the corruption but left the Trajectory with nothing to render:
// `lib/client.js` still listens for `plugin/observation` and never sees one.
//
// Two supported routes exist and both are used here, split by what each can see:
//
//   * Host: a `sessionProjections` unit with `wire.view`. The projection service
//     folds the Session's own committed events and ships the computed value to
//     the browser, so nothing new enters the durable log. Its `apply` is pure and
//     synchronous and may only read real events — it cannot invent one. A decision
//     happens inside `agent/pre-step`, before any event of that step exists, so the
//     decision is held in {@link createDecisionTrail} until the step's first
//     committed event arrives and folds it in.
//   * Client: one Conversation event definition (lib/client.js) whose `match`
//     claims the published projection records, rendered under
//     `conversation.chat.node` by its own `kind`.
//
// The Client therefore never folds events itself and the log stays clean.

import { z } from "zod";

/** Projection key shared by the Host writer and the Client reader. */
export const DECISION_TRAIL_KEY = 'memoryPilotTrail';

/** Retain at most this many decisions per Session; older entries fall off the front. */
export const MAX_TRAIL_ENTRIES = 50;

/**
 * Per-Session decision trail.
 *
 * State is plain JSON so the projection cache can checkpoint it and cold reads
 * replay only the tail. Every field is bounded: a Session is long-lived and the
 * browser renders this structure, so unbounded agent-provided text must never
 * enter it.
 *
 * The schema is zod, matching every other `sessionProjections` unit in DSH: the
 * projection service calls `stateSchema.parse()` on checkpoint rows, so a JSON
 * Schema literal would be rejected at runtime.
 */
const answerSchema = z.object({
  name: z.string().max(64),
  choice: z.string().max(64),
  confidence: z.number().min(0).max(1).optional(),
});
const actionSchema = z.object({
  backend: z.string().max(64),
  scope: z.string().max(32),
  operation: z.string().max(32),
});
const executionSchema = z.object({
  backend: z.string().max(64),
  scope: z.string().max(32),
  operation: z.string().max(32),
  status: z.string().max(32),
  hitCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});
const entrySchema = z.object({
  // Stable identity: the Session event the decision was made for.
  id: z.string().max(200),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  // What the user asked, already flattened by the host adapter.
  question: z.string().max(400),
  kind: z.string().max(32),
  status: z.string().max(32),
  totalDurationMs: z.number().int().nonnegative(),
  protocol: z.string().max(32),
  model: z.string().max(120),
  decisionDurationMs: z.number().int().nonnegative(),
  // Ordered question names the decision model was asked.
  questions: z.array(z.string().max(64)).max(16),
  // name -> chosen level, with its probability when the protocol reports one.
  answers: z.array(answerSchema).max(16),
  // What the model proposed, after policy authorization.
  actions: z.array(actionSchema).max(32),
  // How each authorized action actually resolved.
  executions: z.array(executionSchema).max(32),
  injectedChars: z.number().int().nonnegative(),
});

export const decisionTrailSchema = z.object({
  entries: z.array(entrySchema).max(MAX_TRAIL_ENTRIES),
});

const text = (value, limit) => {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const int = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/**
 * Reduce one orchestrator trace to the bounded record the browser renders.
 *
 * Everything here comes from the plugin's own trace object, never from raw
 * agent text, so the shape stays stable across adapters. Missing fields degrade
 * to safe empties instead of dropping the entry: a decision that produced no
 * action is exactly what a user needs to see, and it is the most common case.
 *
 * @param trace - the orchestrator's frozen trace, or undefined.
 * @param meta - turn, step, and the flattened question.
 * @returns the projection entry.
 */
export function toDecisionEntry(trace, meta) {
  const decision = trace?.decision ?? {};
  const answers = Object.entries(decision.answers ?? {}).map(([name, answer]) => {
    const entry = { name: String(name), choice: String(answer?.choice ?? 'unknown') };
    // SystemOne reports a probability per level; keep only the chosen one so the
    // row shows a single number instead of a distribution nobody reads.
    const probability = answer?.probabilities?.[answer?.choice];
    if (Number.isFinite(probability)) entry.confidence = Math.round(probability * 100) / 100;
    return entry;
  });
  return {
    id: text(meta.id, 200) || 'unknown',
    turn: int(meta.turn),
    step: int(meta.step),
    question: text(meta.question, 400),
    kind: text(trace?.kind, 32) || 'unknown',
    status: text(trace?.status, 32) || 'unknown',
    totalDurationMs: int(trace?.totalDurationMs),
    protocol: text(decision.protocol, 32) || 'unknown',
    model: text(decision.model, 120) || 'unknown',
    decisionDurationMs: int(decision.durationMs),
    questions: Array.isArray(decision.questionNames)
      ? decision.questionNames.slice(0, 16).map(name => text(name, 64))
      : [],
    answers,
    actions: Array.isArray(trace?.plan?.actions) ? trace.plan.actions.slice(0, 32).map(action => ({
      backend: text(action.backendId, 64) || 'unknown',
      scope: text(action.scope, 32) || 'unknown',
      operation: text(action.operation, 32) || 'unknown',
    })) : [],
    executions: Array.isArray(trace?.executions) ? trace.executions.slice(0, 32).map(row => ({
      backend: text(row.backendId, 64) || 'unknown',
      scope: text(row.scope, 32) || 'unknown',
      operation: text(row.operation, 32) || 'unknown',
      status: text(row.response?.status ?? row.status, 32) || 'unknown',
      ...(Number.isSafeInteger(row.response?.hitCount) ? { hitCount: row.response.hitCount } : {}),
      durationMs: int(row.durationMs),
    })) : [],
    injectedChars: int(trace?.injection?.contextChars),
  };
}

/**
 * Append one decision, keeping the newest entries and replacing a repeat of the
 * same identity so a retried step supersedes its predecessor instead of stacking.
 *
 * @param state - current projection state.
 * @param entry - entry from {@link toDecisionEntry}.
 * @returns the next state; the same reference when nothing changed.
 */
export function appendDecision(state, entry) {
  if (!entry?.id) return state;
  const existing = state?.entries ?? [];
  const previous = existing.find(row => row.id === entry.id);
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) return state;
  const kept = existing.filter(row => row.id !== entry.id);
  kept.push(entry);
  return { entries: kept.slice(-MAX_TRAIL_ENTRIES) };
}

/**
 * Create the pairing points for a Trail: a Host-side pending table plus the
 * projection definition that drains it.
 *
 * A decision is recorded with {@link record} during `agent/pre-step`, then folded
 * into the projection by the first committed event of that step. The projection
 * stays a pure function of the log — `apply` reads the pending table, which is
 * committed state by then — and no custom event type reaches persistence.
 *
 * @returns record, the projection definition, and a settle hook for teardown.
 */
export function createDecisionTrail() {
  // "turn:step" -> entry. The projection's `apply(state, event)` receives only the
  // fold state and the event, not the Session identity, so the pending table is
  // keyed by turn and step rather than by Session. That is sound because every
  // Session gets its own projection cell: an entry recorded for one Session is
  // only ever drained by an event folded into that Session's cell, and a Session
  // that never commits the step's event simply leaves its entry to expire below.
  // Bounded so a cancelled step cannot accumulate forever.
  const MAX_PENDING = 32;
  const pending = new Map();
  const keyOf = entry => `${entry.turn}:${entry.step}`;

  const record = entry => {
    if (!entry?.id) return;
    const key = keyOf(entry);
    // Re-inserting keeps the newest position so eviction drops the oldest step.
    pending.delete(key);
    pending.set(key, entry);
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  };

  const definition = {
    key: DECISION_TRAIL_KEY,
    stateSchema: decisionTrailSchema,
    stateVersion: 1,
    init: () => ({ entries: [] }),
    apply(state, event) {
      const turn = event?.data?.turn;
      const step = event?.data?.step;
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return state;
      const key = `${turn}:${step}`;
      const entry = pending.get(key);
      if (entry === undefined) return state;
      // One event per step drains it; later events of the same step find nothing.
      pending.delete(key);
      return appendDecision(state, entry);
    },
    wire: {
      viewSchema: decisionTrailSchema,
      view: state => state,
    },
  };

  return {
    record,
    definition,
    /** Drop a specific drained step, for a caller that knows it was abandoned. */
    forget(turn, step) {
      pending.delete(`${turn}:${step}`);
    },
    /** Drop every pending entry, for plugin teardown. */
    clear() {
      pending.clear();
    },
  };
}

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
  /** Passages the relevance floor discarded as unrelated. */
  droppedLowRelevance: z.number().int().nonnegative().optional(),
  // Short excerpt of what the read returned, so "2 hits" is not all a reader gets.
  preview: z.string().max(300).optional(),
  durationMs: z.number().int().nonnegative(),
});
const entrySchema = z.object({
  // Stable identity: the Session event the decision was made for.
  id: z.string().max(200),
  // Which judging concern produced this entry, as `domain.concern`. Entries
  // recorded before decision points existed carry none and are read as memory
  // judgments, so the log never has to discard history to change shape.
  subject: z.string().max(64).optional(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  // What the user asked, already flattened by the host adapter.
  question: z.string().max(400),
  kind: z.string().max(32),
  status: z.string().max(32),
  // Why a run produced no action (no-capabilities, budget-exhausted, …).
  reason: z.string().max(48).optional(),
  totalDurationMs: z.number().int().nonnegative(),
  protocol: z.string().max(32),
  model: z.string().max(120),
  decisionDurationMs: z.number().int().nonnegative(),
  // Ordered question names the decision model was asked.
  questions: z.array(z.string().max(64)).max(16),
  // The options each question offered, so a recorded choice can be read next to
  // the alternatives it was chosen from.
  questionOptions: z.record(z.string().max(64), z.array(z.string().max(64)).max(16)).optional(),
  // name -> chosen level, with its probability when the protocol reports one.
  answers: z.array(answerSchema).max(16),
  // What the model proposed, after policy authorization.
  actions: z.array(actionSchema).max(32),
  // The candidates the questionnaire offered, so an option id like `q0` can be
  // shown as the backend it actually selected.
  candidates: z.array(z.object({
    backend: z.string().max(64),
    scope: z.string().max(32),
  })).max(32).optional(),
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
    // Older traces name no subject. They judged memory, so that is what they are
    // read as rather than being dropped or shown as unknown.
    subject: text(trace?.subject, 64) || 'memory.read',
    turn: int(meta.turn),
    step: int(meta.step),
    question: text(meta.question, 400),
    kind: text(trace?.kind, 32) || 'unknown',
    status: text(trace?.status, 32) || 'unknown',
    ...(typeof trace?.reason === 'string' && trace.reason ? { reason: text(trace.reason, 48) } : {}),
    totalDurationMs: int(trace?.totalDurationMs),
    protocol: text(decision.protocol, 32) || 'unknown',
    model: text(decision.model, 120) || 'unknown',
    decisionDurationMs: int(decision.durationMs),
    questions: Array.isArray(decision.questionNames)
      ? decision.questionNames.slice(0, 16).map(name => text(name, 64))
      : [],
    // The choices each question offered, so "chose 查" can be read next to 不查.
    ...(decision.questionOptions && typeof decision.questionOptions === 'object' ? {
      questionOptions: Object.fromEntries(Object.entries(decision.questionOptions)
        .slice(0, 16).filter(([name, list]) => Array.isArray(list) && list.length)
        .map(([name, list]) => [text(name, 64), list.slice(0, 16).map(option => text(option, 64))])),
    } : {}),
    answers,
    actions: Array.isArray(trace?.plan?.actions) ? trace.plan.actions.slice(0, 32).map(action => ({
      backend: text(action.backendId, 64) || 'unknown',
      scope: text(action.scope, 32) || 'unknown',
      operation: text(action.operation, 32) || 'unknown',
    })) : [],
    ...(Array.isArray(trace?.candidates) && trace.candidates.length ? { candidates: trace.candidates.slice(0, 32).map(row => ({
      backend: text(row.backendId, 64) || 'unknown',
      scope: text(row.scope, 32) || 'unknown',
    })) } : {}),
    executions: Array.isArray(trace?.executions) ? trace.executions.slice(0, 32).map(row => ({
      backend: text(row.backendId, 64) || 'unknown',
      scope: text(row.scope, 32) || 'unknown',
      operation: text(row.operation, 32) || 'unknown',
      status: text(row.response?.status ?? row.status, 32) || 'unknown',
      ...(Number.isSafeInteger(row.response?.hitCount) ? { hitCount: row.response.hitCount } : {}),
      ...(Number.isSafeInteger(row.response?.droppedLowRelevance) && row.response.droppedLowRelevance > 0 ? { droppedLowRelevance: row.response.droppedLowRelevance } : {}),
      ...(typeof row.response?.preview === 'string' && row.response.preview ? { preview: text(row.response.preview, 300) } : {}),
      durationMs: int(row.durationMs),
    })) : [],
    injectedChars: int(trace?.injection?.contextChars),
    ...(trace?.capture && Number.isSafeInteger(trace.capture.stored) ? {
      capture: { stored: Math.max(0, trace.capture.stored), failed: Math.max(0, trace.capture.failed ?? 0) },
    } : {}),
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
// A decision published on an injected message, so a projection rebuild can
// recover decisions the in-memory pending table no longer holds.
// An injected message carries no turn/step of its own. Associate it with the most
// recent decision-bearing step by order of arrival: the injection for a step is
// committed before that step ends, so the highest turn/step seen so far is the
// one it belongs to.
function locateCarried(event, at) {
  // A Session whose first fold starts with an injected message (typically the
  // first turn after a host restart, when the projection cell is rebuilt) has no
  // pointer yet. Reading `at.turn` off that undefined threw inside `apply`, and
  // the host surfaced it as an opaque turn error ("Cannot read properties of
  // undefined (reading 'turn')") that aborted the whole turn.
  if (!at) return undefined;
  const carried = carriedDecision(event, `${at.turn}:${at.step}`);
  return carried ? { ...carried, turn: at.turn, step: at.step } : undefined;
}

function carriedDecision(event, fallbackId) {
  const source = event?.data?.message?.source ?? event?.data?.source;
  if (!source || typeof source !== 'object') return undefined;
  const decision = source.decision;
  if (decision && typeof decision === 'object') {
    // `id` is part of the stored entry, and the log only carries the decision body.
    const parsed = decisionTrailSchema.shape.entries.element.safeParse(
      typeof decision.id === 'string' && decision.id ? decision : { ...decision, id: fallbackId });
    if (parsed.success) return parsed.data;
  }
  return inferredDecision(event, source, fallbackId);
}

// A message logged before decisions were carried on the source still records what
// the injection WAS: which backend answered, for which scope, with how many hits.
// That is enough to show the row, marked so a reader knows the questionnaire was
// never captured for it.
function inferredDecision(event, source, fallbackId) {
  // An injected message carries its content on the event data, not nested under a
  // `message` key (that shape belongs to `assistant/message`).
  const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content
    : Array.isArray(event?.data?.content) ? event.data.content : [];
  const text = blocks.map(block => typeof block?.text === 'string' ? block.text : '').join('');
  if (!text.includes('"sources"')) return undefined;
  let envelope;
  try { envelope = JSON.parse(text); } catch { return undefined; }
  if (!Array.isArray(envelope?.sources) || !envelope.sources.length) return undefined;
  const executions = envelope.sources.slice(0, 32).map(item => {
    let inner = {};
    try { inner = JSON.parse(item?.data ?? '{}') ?? {}; } catch { /* keep defaults */ }
    const metadata = inner.metadata && typeof inner.metadata === 'object' ? inner.metadata : {};
    const operation = typeof item?.operation === 'string' ? item.operation : 'search';
    return {
      backend: typeof item?.backend === 'string' ? item.backend.slice(0, 64) : 'unknown',
      scope: typeof item?.scope === 'string' ? item.scope.slice(0, 32) : 'unknown',
      operation,
      status: typeof item?.status === 'string' ? item.status.slice(0, 32) : 'ok',
      ...(Number.isSafeInteger(metadata.hitCount) ? { hitCount: metadata.hitCount } : {}),
      ...(typeof inner.text === 'string' && inner.text.trim() ? { preview: inner.text.replace(/\s+/g, ' ').trim().slice(0, 280) } : {}),
      durationMs: 0,
    };
  });
  const chars = Number.isSafeInteger(envelope.charCount) ? envelope.charCount : text.length;
  const candidate = {
    id: fallbackId, turn: Number.isSafeInteger(event?.data?.turn) ? event.data.turn : 0,
    step: Number.isSafeInteger(event?.data?.step) ? event.data.step : 0,
    question: '', kind: 'retrieval', status: 'ok', reason: 'inferred',
    totalDurationMs: 0, protocol: 'unknown', model: 'unknown', decisionDurationMs: 0,
    questions: [], answers: [],
    actions: executions.map(row => ({ backend: row.backend, scope: row.scope, operation: row.operation })),
    executions, injectedChars: chars,
  };
  const parsed = decisionTrailSchema.shape.entries.element.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

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
    stateVersion: 2,
    init: () => ({ entries: [], pointer: undefined }),
    apply(state, event) {
      // `step/start` carries the turn and step; an injected `user/message` does
      // not. Requiring both here meant a replayed log could never restore an
      // injected decision: the message that carries it was skipped before its
      // payload was ever looked at.
      const carriedSource = event?.data?.message?.source ?? event?.data?.source;
      const carryable = carriedSource && typeof carriedSource === 'object'
        && (carriedSource.decision || carriedSource.kind === 'plugin:dsh-memory-pilot');
      const turn = event?.data?.turn;
      const step = event?.data?.step;
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) {
        if (!carryable) return state;
        const at = state.pointer;
        const located = locateCarried(event, at);
        return located ? appendDecision(state, located) : state;
      }
      // Remember where the log is, so a following injection can be placed.
      const pointed = { ...state, pointer: { turn, step } };
      const key = `${turn}:${step}`;
      const entry = pending.get(key);
      if (entry !== undefined) {
        // One event per step drains it; later events of the same step find nothing.
        pending.delete(key);
        return appendDecision(pointed, entry);
      }
      // Rebuilding after a restart replays the log with an empty pending table, so
      // a decision that only ever lived in memory would vanish. The injected
      // message carries a copy precisely so this path can restore it.
      const carried = carriedDecision(event, `${turn}:${step}`);
      if (carried) return appendDecision(pointed, carried);
      return pointed;
    },
    wire: {
      viewSchema: decisionTrailSchema,
      // `pointer` is fold bookkeeping, not published state: it exists so a replayed
      // injection can be attached to the step it belongs to.
      view: state => ({ entries: state.entries }),
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

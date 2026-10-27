import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SCOPES = ['personal', 'global', 'project', 'workspace'];
const OPS = ['search', 'deep', 'write'];
const TYPES = ['message', 'checkpoint', 'turn_end'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const empty = status => ({ context: '', results: [], status });
const duration = started => Math.max(0, performance.now() - started);
const safeDescriptor = value => {
  if (!object(value)) return Object.freeze({});
  const out = {};
  for (const key of ['engine', 'adapter', 'transport']) if (identifier(value[key])) out[key] = value[key];
  if (object(value.store) && identifier(value.store.kind) && identifier(value.store.display)) {
    out.store = Object.freeze({ kind: value.store.kind, display: value.store.display.slice(0, 256) });
  }
  return Object.freeze(out);
};
const safeDecisionObservation = value => {
  if (!object(value) || !identifier(value.protocol) || !identifier(value.model)
    || !Array.isArray(value.questionNames) || !object(value.answers)) return undefined;
  const questionNames = value.questionNames.filter(identifier).slice(0, 16);
  const answers = {};
  for (const name of questionNames) {
    const answer = value.answers[name];
    if (!object(answer) || !identifier(answer.choice)) continue;
    const observed = { choice: answer.choice };
    if (object(answer.probabilities)) {
      const probabilities = Object.fromEntries(Object.entries(answer.probabilities)
        .filter(([key, probability]) => identifier(key) && Number.isFinite(probability) && probability >= 0 && probability <= 1));
      if (Object.keys(probabilities).length) observed.probabilities = Object.freeze(probabilities);
    }
    answers[name] = Object.freeze(observed);
  }
  // Keep the offered options alongside the answers so a recorded decision can be
  // read as "chose X out of [X, Y]" rather than a bare verdict.
  let questionOptions;
  if (object(value.questionOptions)) {
    const options = {};
    for (const name of questionNames) {
      const list = value.questionOptions[name];
      if (Array.isArray(list)) {
        const cleaned = list.filter(identifier).slice(0, 16);
        if (cleaned.length) options[name] = Object.freeze(cleaned);
      }
    }
    if (Object.keys(options).length) questionOptions = Object.freeze(options);
  }
  return Object.freeze({ protocol: value.protocol, model: value.model,
    questionNames: Object.freeze(questionNames), answers: Object.freeze(answers),
    ...(questionOptions ? { questionOptions } : {}),
    durationMs: Number.isFinite(value.durationMs) ? Math.max(0, value.durationMs) : 0 });
};

/**
 * Dependency-free, instance-local memory orchestration.
 * decide receives {event, capabilities:[{backend,scope,scopeId,operations}]}.
 * Evidence is {eventId, quote}: quote must occur verbatim in current event.text.
 * execute receives validated actions with authoritative scopeId and frozen event.
 * run resolves with status ok|noop|denied|timeout|error. Invalid configuration throws.
 * Deduplication is in-memory only; timed-out writes are not retried by this instance.
 * Deadlines bound asynchronous waits, not synchronous JS blocking or remote effects.
 */
// One memory turn can answer both questions — read and write — so the subject
// names the concern this trace actually exercised. A trace that neither reads nor
// writes is still a read judgment: that is the gate that decided nothing was needed.
const memorySubject = () => 'memory.read';

export function createOrchestrator({ decision, backends = {}, policy = {}, onAudit,
  budgetMs = 1000, maxActions = 8, maxContextChars = 8000 } = {}) {
  if (typeof decision?.decide !== 'function' || !object(backends) || !object(policy)
    || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 2147483647
    || !Number.isInteger(maxActions) || maxActions < 0 || maxActions > 100
    || !Number.isInteger(maxContextChars) || maxContextChars < 128
    || (policy.backends !== undefined && (!Array.isArray(policy.backends)
      || !policy.backends.every(identifier)))) throw new TypeError('Invalid orchestrator configuration');

  // Capture adapter methods and policy at construction, not model-controlled references.
  const adapters = new Map(Object.entries(backends).filter(([id, b]) => identifier(id)
    && object(b) && typeof b.execute === 'function' && Array.isArray(b.capabilities))
    .map(([id, b]) => [id, { execute: b.execute.bind(b), capabilities: new Set(b.capabilities),
      scope: b.scope, scopeId: b.scopeId, descriptor: safeDescriptor(b.descriptor) }]));
  const decide = decision.decide.bind(decision);
  const allowedBackends = policy.backends === undefined ? null : new Set(policy.backends);
  const permissions = Object.fromEntries(SCOPES.map(scope => [scope, {
    read: policy.scopes?.[scope]?.read === true, write: policy.scopes?.[scope]?.write === true,
  }]));
  const pending = new Map();
  const eventFingerprints = new Map();
  const writes = new Set();
  const audit = (phase, status, count = 0) => {
    try { Promise.resolve(onAudit?.(Object.freeze({ phase, status, count }))).catch(() => {}); }
    catch { /* Observability must not alter execution. Never include dependency errors or text. */ }
  };

  function snapshot(input) {
    if (!object(input) || !TYPES.includes(input.type) || !identifier(input.id)
      || !identifier(input.sessionId) || typeof input.text !== 'string') return null;
    const event = { type: input.type, id: input.id, sessionId: input.sessionId, text: input.text };
    if (input.availableContext !== undefined) {
      if (!Array.isArray(input.availableContext) || input.availableContext.length > 12 || !input.availableContext.every(value => typeof value === 'string' && value.length <= 2000)) return null;
      event.availableContext = Object.freeze([...input.availableContext]);
    }
    if (input.residentMemory !== undefined) {
      if (!object(input.residentMemory) || Object.keys(input.residentMemory).some(key => !['user', 'global', 'project'].includes(key))
        || Object.values(input.residentMemory).some(value => typeof value !== 'string' || value.length > 8000)) return null;
      event.residentMemory = Object.freeze({ ...input.residentMemory });
    }
    for (const key of ['actorId', 'projectId', 'workspaceId', 'projectPath', 'workspacePath']) {
      if (input[key] !== undefined && !identifier(input[key])) return null;
      if (input[key] !== undefined) event[key] = input[key];
    }
    return Object.freeze(event);
  }

  function inventory(event) {
    const identities = { personal: event.actorId, global: 'global', project: event.projectId,
      workspace: event.workspaceId };
    const entries = [];
    for (const [backend, adapter] of adapters) {
      if (allowedBackends && !allowedBackends.has(backend)) continue;
      for (const scope of SCOPES) {
        if (!identities[scope] || (adapter.scope !== undefined && adapter.scope !== scope)
          || (adapter.scopeId !== undefined && adapter.scopeId !== identities[scope])) continue;
        const operations = OPS.filter(op => adapter.capabilities.has(op)
          && (op === 'write' ? event.type !== 'message' && permissions[scope].write
            : permissions[scope].read));
        if (operations.length) entries.push(Object.freeze({ backend, scope,
          scopeId: identities[scope], operations: Object.freeze(operations) }));
      }
    }
    return Object.freeze(entries);
  }

  function validate(plan, capabilities, event) {
    if (!object(plan) || Object.keys(plan).some(k => !['actions', 'observation'].includes(k))
      || !Array.isArray(plan.actions) || plan.actions.length > maxActions) return null;
    const actions = [];
    for (const action of plan.actions) {
      if (!object(action) || Object.keys(action).some(k => ![
        'operation', 'backend', 'scope', 'query', 'content', 'evidence',
      ].includes(k))) return null;
      const entry = capabilities.find(c => c.backend === action.backend && c.scope === action.scope
        && c.operations.includes(action.operation));
      if (!entry) return null;
      const bound = { operation: action.operation, backend: entry.backend, scope: entry.scope,
        scopeId: entry.scopeId };
      if (action.operation === 'write') {
        const e = action.evidence;
        if (typeof action.content !== 'string' || !action.content.trim() || action.content.length > maxContextChars
          || action.query !== undefined || !object(e) || Object.keys(e).some(k => !['eventId', 'quote'].includes(k))
          || e.eventId !== event.id || typeof e.quote !== 'string' || !e.quote.trim()
          || e.quote.length > maxContextChars || !event.text.includes(e.quote)) return null;
        bound.content = action.content;
        bound.evidence = Object.freeze({ eventId: event.id, quote: e.quote });
      } else {
        if (typeof action.query !== 'string' || !action.query.trim() || action.query.length > maxContextChars
          || action.content !== undefined || action.evidence !== undefined) return null;
        bound.query = action.query;
      }
      actions.push(Object.freeze(bound));
    }
    return actions;
  }

  // Both the results array and complete JSON context have independent hard character limits.
  function render(items) {
    const results = [];
    const sources = [];
    let omitted = false;
    const envelope = () => ({ trust: 'untrusted', sources, truncated: omitted });
    for (const item of items) {
      const { action, status, value } = item;
      const record = { backend: action.backend, scope: action.scope, scopeId: action.scopeId,
        operation: action.operation, status };
      const read = action.operation !== 'write';
      let raw = '';
      if (read && status === 'ok') {
        try { raw = json(value ?? null); } catch { raw = 'null'; record.status = 'error'; }
        record.data = raw;
        record.truncated = false;
      }
      const fits = () => json([...results, record]).length <= maxContextChars
        && (!read || json({ ...envelope(), sources: [...sources, record] }).length <= maxContextChars);
      if (!fits() && 'data' in record) {
        record.truncated = true;
        let low = 0, high = Math.min(raw.length, maxContextChars);
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          record.data = raw.slice(0, mid);
          if (fits()) low = mid; else high = mid - 1;
        }
        record.data = raw.slice(0, low);
      }
      if (!fits()) { omitted = true; continue; }
      results.push(Object.freeze(record));
      if (read) sources.push(record);
    }
    return { results: Object.freeze(results), context: sources.length || omitted ? json(envelope()) : '' };
  }

  async function perform(event, eventKey, runBudget, callerSignal) {
    const controller = new AbortController();
    const callerAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', callerAbort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    const deadline = performance.now() + runBudget;
    let expired = false;
    let timer;
    const timeout = Symbol('timeout');
    const alive = () => !expired && !controller.signal.aborted && performance.now() < deadline;
    const expiration = new Promise(resolve => {
      timer = setTimeout(() => { expired = true; controller.abort(); resolve(timeout); }, runBudget);
    });
    const runStartedAt = performance.now();
    // A trace for a run that never reached a decision. `question` identifies the
    // turn so the Trajectory row still shows what was being evaluated.
    const failureTrace = (status, reason) => Object.freeze({
      schemaVersion: 1, subject: memorySubject(), kind: event.type === 'message' ? 'retrieval' : 'retention',
      status, reason, question: event.text,
      totalDurationMs: duration(runStartedAt), candidates: Object.freeze([]),
      decision: Object.freeze({ protocol: 'none', model: 'not-contacted', questionNames: Object.freeze([]), answers: Object.freeze({}), durationMs: 0 }),
      plan: Object.freeze({ validation: 'accepted', actions: Object.freeze([]) }),
      executions: Object.freeze([]), injection: Object.freeze({ sourceCount: 0, contextChars: 0, truncated: false }),
    });
    const work = async () => {
      const capabilities = inventory(event);
      // A turn with nothing to do is still a decision worth showing: without a
      // trace the Trajectory is simply blank, which reads as "the plugin never
      // ran". Publish the reason instead (no capable backend / no actions left).
      if (!capabilities.length || maxActions === 0) {
        const reason = maxActions === 0 ? 'no-actions-allowed' : 'no-capabilities';
        return { ...empty('noop'), trace: Object.freeze({ schemaVersion: 1,
          kind: event.type === 'message' ? 'retrieval' : 'retention', status: 'noop', reason,
          question: event.text,
          totalDurationMs: duration(runStartedAt), candidates: Object.freeze([]),
          decision: Object.freeze({ protocol: 'none', model: 'not-contacted', questionNames: Object.freeze([]), answers: Object.freeze({}), durationMs: 0 }),
          plan: Object.freeze({ validation: 'accepted', actions: Object.freeze([]) }),
          executions: Object.freeze([]), injection: Object.freeze({ sourceCount: 0, contextChars: 0, truncated: false }) }) };
      }
      const candidates = Object.freeze(capabilities.map(capability => {
        const descriptor = adapters.get(capability.backend).descriptor;
        return Object.freeze({ backendId: capability.backend, scope: capability.scope,
          operations: capability.operations, ...descriptor });
      }));
      audit('decision', 'started');
      const decisionStartedAt = performance.now();
      const proposed = await decide(Object.freeze({ event, capabilities }), { signal: controller.signal });
      const decisionObservation = safeDecisionObservation(proposed?.observation);
      const baseTrace = status => Object.freeze({ schemaVersion: 1, subject: memorySubject(), kind: event.type === 'message' ? 'retrieval' : 'retention', status,
        question: event.text,
        totalDurationMs: duration(runStartedAt), candidates,
        decision: decisionObservation ?? Object.freeze({ protocol: 'unknown', model: 'unknown', questionNames: Object.freeze([]), answers: Object.freeze({}), durationMs: duration(decisionStartedAt) }),
        plan: Object.freeze({ validation: status === 'denied' ? 'denied' : 'accepted', actions: Object.freeze([]) }),
        executions: Object.freeze([]), injection: Object.freeze({ sourceCount: 0, contextChars: 0, truncated: false }) });
      if (!alive()) return timeout;
      const actions = validate(proposed, capabilities, event);
      if (!actions) { audit('validation', 'denied'); return { ...empty('denied'), trace: baseTrace('denied') }; }
      if (!actions.length) return { ...empty('noop'), trace: baseTrace('noop') };
      audit('validation', 'ok', actions.length);
      const items = await Promise.all(actions.map(async action => {
        if (!alive()) return null;
        const executionStartedAt = performance.now();
        if (action.operation === 'write') {
          const key = hash([eventKey, action]);
          if (writes.has(key)) return { action, status: 'deduplicated', durationMs: duration(executionStartedAt) };
          // Reserve before calling; ambiguous timeout/failure must never trigger an automatic retry.
          writes.add(key);
        }
        try {
          const value = await adapters.get(action.backend).execute(action, { signal: controller.signal, event });
          return alive() ? { action, status: 'ok', value, durationMs: duration(executionStartedAt) } : null;
        } catch { return alive() ? { action, status: 'error', durationMs: duration(executionStartedAt) } : null; }
      }));
      if (!alive()) return timeout;
      const settled = items.filter(Boolean);
      const output = render(settled);
      if (!alive()) return timeout;
      const reads = settled.filter(item => item.action.operation !== 'write');
      const status = items.some(item => item?.status === 'error') ? 'error' : 'ok';
      const route = reads.length ? Object.freeze({
        decision: 'memory',
        mode: reads.some(item => item.action.operation === 'deep') ? 'reflect' : 'recall',
        targets: Object.freeze(reads.map(item => Object.freeze({ backend:item.action.backend,scope:item.action.scope,operation:item.action.operation,status:item.status }))),
      }) : undefined;
      const trace = Object.freeze({ schemaVersion: 1, subject: memorySubject(), kind: event.type === 'message' ? 'retrieval' : 'retention', status,
        // The Trajectory row shows what the user asked; the orchestrator is the
        // only place that still holds the exact text the decision saw.
        question: event.text,
        totalDurationMs: duration(runStartedAt), candidates,
        decision: decisionObservation ?? Object.freeze({ protocol: 'unknown', model: 'unknown', questionNames: Object.freeze([]), answers: Object.freeze({}), durationMs: duration(decisionStartedAt) }),
        plan: Object.freeze({ validation: 'accepted', actions: Object.freeze(actions.map(action => Object.freeze({ backendId: action.backend, scope: action.scope, operation: action.operation }))) }),
        executions: Object.freeze(settled.map(item => {
          const descriptor = adapters.get(item.action.backend).descriptor;
          const metadata = object(item.value?.metadata) ? item.value.metadata : {};
          const response = { status: item.status };
          if (Number.isSafeInteger(metadata.hitCount) && metadata.hitCount >= 0) response.hitCount = metadata.hitCount;
          // How much the relevance floor discarded. A high number next to a low
          // hit count says the store had nothing close, which is exactly what a
          // reader needs to judge a "no useful memory" outcome.
          if (Number.isSafeInteger(metadata.droppedLowRelevance) && metadata.droppedLowRelevance > 0) response.droppedLowRelevance = metadata.droppedLowRelevance;
          if (Number.isSafeInteger(metadata.returnedChars) && metadata.returnedChars >= 0) response.returnedChars = metadata.returnedChars;
          if (Number.isSafeInteger(metadata.semanticHitCount) && metadata.semanticHitCount >= 0) response.semanticHitCount = metadata.semanticHitCount;
          if (Number.isSafeInteger(metadata.explicitFactCount) && metadata.explicitFactCount >= 0) response.explicitFactCount = metadata.explicitFactCount;
          if (typeof metadata.durable === 'boolean') response.durable = metadata.durable;
          // Keep a short preview of what the read actually returned. Without it
          // the Trajectory could only say "2 hits", which tells a reader nothing
          // about whether those hits were relevant — the whole question when a
          // recalled passage looks unrelated to what was asked.
          if (item.status === 'ok' && item.action.operation !== 'write' && typeof item.value?.text === 'string') {
            const preview = item.value.text.replace(/\s+/g, ' ').trim().slice(0, 280);
            if (preview) response.preview = preview;
          }
          return Object.freeze({ backendId: item.action.backend, scope: item.action.scope, operation: item.action.operation,
            ...descriptor, response: Object.freeze(response), durationMs: item.durationMs });
        })),
        injection: Object.freeze({ sourceCount: reads.length, contextChars: output.context.length,
          truncated: reads.some(item => item.status === 'ok' && output.results.find(result => result.backend === item.action.backend && result.scope === item.action.scope && result.operation === item.action.operation)?.truncated === true) }),
      });
      return { ...output, status, trace, ...(route ? { route } : {}) };
    };
    try {
      const result = await Promise.race([work(), expiration]);
      // Timeouts and failures are the runs a user most needs to see; returning a
      // bare `empty()` erased them from the Trajectory and made a stalled
      // memory read indistinguishable from a plugin that never looked.
      const failed = (status, reason) => ({ ...empty(status), ...(failureTrace ? { trace: failureTrace(status, reason) } : {}) });
      if (callerSignal?.aborted) { expired = true; controller.abort(); audit('run', 'error'); return failed('error', 'aborted'); }
      if (result === timeout || !alive()) { expired = true; controller.abort(); audit('run', 'timeout'); return failed('timeout', 'budget-exhausted'); }
      audit('run', result.status, result.results.length);
      return Object.freeze(result);
    } catch { audit('run', 'error'); return { ...empty('error'), ...(failureTrace ? { trace: failureTrace('error', 'exception') } : {}) }; }
    finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', callerAbort); expired = true; controller.abort(); }
  }

  return Object.freeze({
    // A per-run budget override lets background capture outlive the
    // interactive budget without weakening the message-path deadline.
    run(input, options = {}) {
      const override = options?.budgetMs;
      const runBudget = Number.isFinite(override) && override > 0 && override <= 2147483647 ? override : budgetMs;
      const event = snapshot(input);
      if (!event) { audit('event', 'denied'); return Promise.resolve(empty('denied')); }
      const key = hash([event.sessionId, event.id]);
      const fingerprint = hash(event);
      if (eventFingerprints.has(key) && eventFingerprints.get(key) !== fingerprint) {
        audit('event', 'denied'); return Promise.resolve(empty('denied'));
      }
      eventFingerprints.set(key, fingerprint);
      if (pending.has(key)) return pending.get(key);
      // Defer dependency invocation until the coalescing slot exists (including reentrant calls).
      const promise = Promise.resolve().then(() => perform(event, key, runBudget, options?.signal));
      pending.set(key, promise);
      void promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); });
      return promise;
    },
  });
}

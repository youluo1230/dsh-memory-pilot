// DSH-specific lifecycle adapter. No host imports: the same seam is used by tests.
// A durable, compact form of the decision for the Session log. The projection
// rebuilds from log events after a restart, so anything kept only in memory is
// lost; this is the record the decision log reads back.
export function decisionForLog(trace, location = {}) {
  if (!trace || typeof trace !== 'object') return undefined;
  const trim = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;
  const entry = {
    turn: Number.isSafeInteger(location.turn) ? location.turn : 0,
    step: Number.isSafeInteger(location.step) ? location.step : 0,
    question: trim(location.question, 400) || '',
    // Which judging concern produced this. Carried on the record so the log can
    // classify without inferring from memory verbs that a non-memory point never uses.
    subject: trim(trace.subject, 64) || 'memory.read',
    kind: trim(trace.kind, 32) || 'unknown',
    status: trim(trace.status, 32) || 'unknown',
    protocol: trim(trace.decision?.protocol, 32) || 'unknown',
    model: trim(trace.decision?.model, 120) || 'unknown',
    decisionDurationMs: Number.isFinite(trace.decision?.durationMs) ? trace.decision.durationMs : 0,
    totalDurationMs: Number.isFinite(trace.totalDurationMs) ? trace.totalDurationMs : 0,
    questions: Array.isArray(trace.decision?.questionNames) ? trace.decision.questionNames.slice(0, 16).filter(name => typeof name === 'string') : [],
    answers: Array.isArray(trace.decision?.questionNames) ? trace.decision.questionNames.slice(0, 16).map(name => {
      const answer = trace.decision.answers?.[name] || {};
      const out = { name, choice: trim(answer.choice, 64) || '' };
      const probability = answer.probabilities?.[answer.choice];
      if (Number.isFinite(probability)) out.confidence = Math.round(probability * 100) / 100;
      return out;
    }) : [],
    actions: Array.isArray(trace.plan?.actions) ? trace.plan.actions.slice(0, 32).map(action => ({
      backend: trim(action.backendId, 64) || 'unknown', scope: trim(action.scope, 32) || 'unknown', operation: trim(action.operation, 32) || 'unknown',
    })) : [],
    executions: Array.isArray(trace.executions) ? trace.executions.slice(0, 32).map(row => ({
      backend: trim(row.backendId, 64) || 'unknown', scope: trim(row.scope, 32) || 'unknown', operation: trim(row.operation, 32) || 'unknown',
      status: trim(row.response?.status, 32) || 'ok',
      ...(Number.isSafeInteger(row.response?.hitCount) ? { hitCount: row.response.hitCount } : {}),
      ...(Number.isSafeInteger(row.response?.droppedLowRelevance) ? { droppedLowRelevance: row.response.droppedLowRelevance } : {}),
      ...(typeof row.response?.preview === 'string' ? { preview: trim(row.response.preview, 300) } : {}),
      durationMs: Number.isFinite(row.durationMs) ? row.durationMs : 0,
    })) : [],
    injectedChars: Number.isSafeInteger(trace.injection?.contextChars) ? trace.injection.contextChars : 0,
  };
  const options = trace.decision?.questionOptions;
  if (options && typeof options === 'object') {
    entry.questionOptions = Object.fromEntries(Object.entries(options).slice(0, 16)
      .filter(([, list]) => Array.isArray(list) && list.length)
      .map(([name, list]) => [name, list.slice(0, 16).filter(item => typeof item === 'string')]));
  }
  return entry;
}

// A trace for the write that happens after the answer. Capture reports either
// per-backend settled results or nothing, so the shape here is deliberately small:
// which backends stored the turn and whether each one succeeded.
export function captureTrace(settled, { turn = 0, durationMs = 0, question = '', assistantChars = 0 } = {}) {
  const results = Array.isArray(settled) ? settled : settled === undefined ? [] : [{ status: 'fulfilled', value: settled }];
  const stored = results.filter(item => item?.status === 'fulfilled').length;
  const failed = results.length - stored;
  return {
    schemaVersion: 1, kind: 'retention', status: stored > 0 ? 'ok' : failed > 0 ? 'error' : 'noop',
    marker: 'capture', question,
    totalDurationMs: Math.round(durationMs),
    candidates: [], plan: { validation: 'accepted', actions: [] },
    decision: { protocol: 'capture', model: 'turn-end', questionNames: [], answers: {}, durationMs: Math.round(durationMs) },
    executions: [],
    injection: { sourceCount: stored, contextChars: assistantChars, truncated: false },
    capture: { stored, failed },
  };
}

// A trace for the distillation attempt, so the decision log can show that a turn
// was considered and what it selected. Without it a distillation that chose nothing
// is indistinguishable from one that never ran — which is the same silence the
// capture trace was added to break.
export function distillTrace(report, { turn = 0, question = '' } = {}) {
  const retained = Array.isArray(report?.retained) ? report.retained : [];
  const failed = Array.isArray(report?.failed) ? report.failed : [];
  const gate = report?.gate === 'keep';
  return {
    schemaVersion: 1, kind: 'distillation',
    status: failed.length && !retained.length ? 'error' : retained.length ? 'ok' : 'noop',
    subject: 'session.distill', marker: 'distill', question,
    totalDurationMs: Number.isFinite(report?.durationMs) ? Math.round(report.durationMs) : 0,
    candidates: Array.isArray(report?.candidateTexts) ? report.candidateTexts.slice(0, 8) : [],
    // The coarse gate's answer is the readable part of this record: it explains why
    // a turn produced nothing, which is the question a user actually asks.
    decision: { protocol: 'systemone', model: 'narrow-judge', questionNames: gate ? ['turn_worth_keeping', 'candidate_selection'] : ['turn_worth_keeping'],
      answers: { turn_worth_keeping: { choice: gate ? 'keep' : 'discard' } },
      durationMs: Number.isFinite(report?.durationMs) ? Math.round(report.durationMs) : 0 },
    plan: { validation: 'accepted', actions: retained.map(row => ({ backendId: String(row.target ?? 'none'), scope: String(row.target ?? 'none'), operation: 'write' })) },
    executions: retained.map(row => ({ backendId: String(row.target ?? 'none'), scope: String(row.target ?? 'none'), operation: 'write',
      response: { status: row.degraded ? 'degraded' : 'ok' }, durationMs: 0 })),
    injection: { sourceCount: 0, contextChars: 0, truncated: false },
    distill: { candidates: Array.isArray(report?.candidateTexts) ? report.candidateTexts.length : (report?.candidates ?? 0),
      retained: retained.length, failed: failed.length, ...(report?.reason ? { reason: report.reason } : {}) },
  };
}

export function attachHost(ctx, { orchestrator, orchestratorFor = () => orchestrator, createMessage, identity, residentSnapshotFor, acceptsSession = () => true, retrievalBudgetMs = 60000, capture = false, captureTurn, captureBudgetMs = 60000, maxTextChars = 12000, onResidentSnapshot = () => {}, onTrace = () => {}, onError = () => {}, distill = () => undefined, capturesTurn = () => true }) {
  // capture/captureBudgetMs may be callables so a plugin backed by live
  // (volatile) config can re-evaluate them per event without remounting.
  const captureOn = typeof capture === 'function' ? capture : () => capture === true;
  const captureBudget = typeof captureBudgetMs === 'function' ? captureBudgetMs : () => captureBudgetMs;
  const turns = new Map();
  const pending = new Set();
  let disposed = false;
  const text = content => (Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text || '').join('\n') : '').slice(0, maxTextChars);
  const key = (session, turn) => `${session.id}:${turn}`;
  const describe = (session, turn, type, body) => ({
    ...identity(session), sessionId: session.id, id: `${key(session, turn)}:${type}`, type, text: body.slice(0, maxTextChars),
  });
  const safeRun = async (session, event, options) => {
    try {
      const selected = orchestratorFor(session);
      return await selected?.run(event, options) ?? { context: '', status: 'disabled' };
    }
    catch { onError('orchestration_failed'); return { context: '' }; }
  };
  const preStep = async (payload, next) => {
    // Inspect the claimed batch before downstream plugins add context. Some host
    // waterfalls replace the entered decision, while payload.messages is the
    // authoritative user batch for this proposed step.
    const claimedText = (payload.messages || []).filter(m => m.source?.kind === 'user').map(m => text(m.content)).join('\n').slice(0, maxTextChars);
    const session = payload.agent.session;
    let resident;
    if (payload.step === 1 && claimedText && acceptsSession(session)) {
      try {
        resident = typeof residentSnapshotFor === 'function' ? await residentSnapshotFor(session) : undefined;
        if (resident) try { onResidentSnapshot(session,resident,{turn:payload.turn,step:payload.step}); } catch { /* audit only */ }
      } catch { onError('resident_snapshot_failed'); }
    }
    const decision = await next();
    if (disposed || payload.signal?.aborted || payload.step !== 1 || decision.kind !== 'enter') return decision;
    const userText = claimedText || decision.messages.filter(m => m.source?.kind === 'user').map(m => text(m.content)).join('\n').slice(0, maxTextChars);
    if (!userText) return decision;
    if (!acceptsSession(session)) return decision;
    const id = key(session, payload.turn);
    // Do not persist reasoning, tool credentials, or memory-injection messages.
    turns.set(id, { userText, assistantText: '', session, turn: payload.turn });
    const visible = decision.messages.filter(message => ['user','assistant'].includes(message.source?.kind))
      .map(message => `${message.source.kind}: ${text(message.content)}`.slice(0,2000)).filter(line => !line.endsWith(': ')).slice(-12);
    const event = { ...describe(session, payload.turn, 'message', userText), availableContext: visible,
      ...(resident?.resident ? { residentMemory: resident.resident } : {}) };    const result = await safeRun(session, event, { budgetMs: typeof retrievalBudgetMs === 'function' ? retrievalBudgetMs() : retrievalBudgetMs });
    if (disposed || payload.signal?.aborted) return decision;
    if (result.trace) {
      // The trace carries the decision but not the question it answered, so pass
      // the trimmed text alongside it; the Trajectory row shows what was asked.
      try { Promise.resolve(onTrace(session, result.trace, { turn: payload.turn, step: payload.step, question: userText })).catch(() => {}); }
      catch { /* Observability must not alter execution or model context. */ }
    }
    // Pass what each injection WAS, not only its text: the Chat UI renders a
    // `recall` source through its referenced-session view and falls back to
    // showing raw JSON when the source carries no `references`. A reader then
    // sees the untrusted-envelope JSON instead of "recalled N memories".
    const executions = Array.isArray(result.trace?.executions) ? result.trace.executions : [];
    const recalled = executions.filter(row => row.operation !== 'write');
    const hits = recalled.reduce((sum, row) => sum + (Number.isFinite(row.response?.hitCount) ? row.response.hitCount : 0), 0);
    const additions = [
      resident?.context ? createMessage(resident.context, { label: '常驻记忆（USER / MEMORY）', count: Object.values(resident.resident ?? {}).filter(Boolean).length, truncated: false }) : undefined,
      result.context ? createMessage(result.context, { label: `MemoryPilot 召回（${recalled.length} 个库，${hits} 条）`, count: hits, truncated: result.trace?.injection?.truncated === true, decision: decisionForLog(result.trace, { turn: payload.turn, step: payload.step, question: userText }) }) : undefined,
    ].filter(Boolean);
    // Tool safety used to run here as a caution note. It moved to
    // `tools/pre-execute`, where it can actually veto a call, so the host no longer
    // carries a note-only judgment. What it does carry now is the field memory.read
    // declares and previously never received: a digest of resident memory, so the
    // recall criterion can stop guessing about what is already in front of the user.
    const all = additions;
    if (!all.length) return decision;
    return { ...decision, messages: [...decision.messages, ...all] };
  };
  const agentListeners = new Map();
  const registrations = [ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx || agentListeners.has(agent)) return;
    // Which turn has already been admitted. The agent instance outlives a single
    // turn — the same agent handles every turn of a conversation — so a boolean
    // here meant only the FIRST message of a Session was ever evaluated; every
    // follow-up was skipped silently, so the decision log showed one entry for a
    // four-turn conversation and memory never ran again.
    const admittedTurns = new Set();
    const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.step !== 1) return next();
      // Within one turn the decision runs once: later steps of the same turn
      // must not repeat retrieval, but every new turn must run it again.
      const turnKey = key(agent.session, payload.turn);
      if (!admittedTurns.has(turnKey)) {
        const result = await preStep(payload, next);
        if (payload.messages?.some(message => message.source?.kind === 'user')) admittedTurns.add(turnKey);
        return result;
      }
      const decision = await next();
      if (decision.kind === 'enter' && !payload.signal?.aborted && acceptsSession(agent.session)) {
        const userText = (payload.messages || []).filter(message => message.source?.kind === 'user')
          .map(message => text(message.content)).join('\n').slice(0, maxTextChars);
        if (userText) turns.set(turnKey, { userText, assistantText: '', session: agent.session, turn: payload.turn });
      }
      return decision;
    });
    agentListeners.set(agent, off);
  }), ctx.on('session/event', (session, event) => {
    const turn = event.data?.turn;
    const id = key(session, turn);
    const state = turns.get(id);
    if (!state || disposed) return;
    if (event.type === 'assistant/message') {
      state.assistantText = [state.assistantText, text(event.data.message?.content)].filter(Boolean).join('\n').slice(0, maxTextChars);
    }
    if (event.type === 'turn/end') {
      turns.delete(id);
      const reason = event.data?.reason;
      // A TurnEndReason is a tagged object, not a string; comparing it directly to
      // 'error' made every turn look successful.
      const kind = typeof reason === 'string' ? reason : reason?.kind;
      // Distillation is not capture. Capture stores the conversation stream;
      // distillation asks the decision layer which of it is worth keeping. They run
      // as separate tasks so a failure in one never suppresses the other.
      if (kind !== 'error' && kind !== 'aborted' && capturesTurn()) {
        const task = (async () => distill({
          session, turn, userText: state.userText, assistantText: state.assistantText, reason,
        }))();
        pending.add(task);
        void task.then(report => {
          if (!report) return;
          try {
            Promise.resolve(onTrace(session, distillTrace(report, { turn, question: state.userText }), { turn, step: 0, question: state.userText })).catch(() => {});
          } catch { /* observability must not alter execution */ }
        }).catch(() => {}).finally(() => pending.delete(task));
      }
      if (!captureOn() || kind === 'error' || kind === 'aborted') return;
      const captureStartedAt = performance.now();
      const task = typeof captureTurn === 'function'
        ? Promise.resolve(captureTurn({ session, turn, userText: state.userText, assistantText: state.assistantText, reason }, { budgetMs: captureBudget() }))
        : safeRun(session, describe(session, turn, 'turn_end', JSON.stringify({ user: state.userText, assistant: state.assistantText, evidenceStatus: 'conversation-only, not independently verified' })), { budgetMs: captureBudget() });
      pending.add(task);
      // Capture is silent by design — it runs after the answer — but silence is
      // indistinguishable from failure. Publish a write row so the decision log
      // can show that this turn was stored, and where.
      void task.then(settled => {
        try {
          Promise.resolve(onTrace(session, captureTrace(settled, { turn, durationMs: Math.max(0, performance.now() - captureStartedAt),
            question: state.userText, assistantChars: state.assistantText.length }), { turn, step: 0, question: state.userText })).catch(() => {});
        } catch { /* observability must not alter execution */ }
      }).catch(() => {}).finally(() => pending.delete(task));
    }
  }), ctx.on('session/disposed', session => {
    for (const [id, state] of turns) if (state.session === session) turns.delete(id);
    for (const [agent, off] of agentListeners) if (agent.session === session) { off?.(); agentListeners.delete(agent); }
  })];
  const dispose = async () => {
    disposed = true;
    for (const off of registrations) if (typeof off === 'function') off();
    for (const off of agentListeners.values()) off?.();
    agentListeners.clear();
    turns.clear();
    await Promise.allSettled([...pending]);
  };
  return {
    dispose,
    // Explicit integration point for verified milestones; not every tool result is a milestone.
    checkpoint(session, milestoneId, body) {
      if (disposed || !captureOn() || !acceptsSession(session)) return Promise.resolve({ context: '', status: 'disabled' });
      return safeRun(session, describe(session, milestoneId, 'checkpoint', body), { budgetMs: captureBudget() });
    },
  };
}

// DSH-specific lifecycle adapter. No host imports: the same seam is used by tests.
export function attachHost(ctx, { orchestrator, orchestratorFor = () => orchestrator, createMessage, identity, residentSnapshotFor, acceptsSession = () => true, retrievalBudgetMs = 60000, capture = false, captureTurn, captureBudgetMs = 60000, maxTextChars = 12000, onResidentSnapshot = () => {}, onTrace = () => {}, onError = () => {} }) {
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
      ...(resident?.resident ? { residentMemory: resident.resident } : {}) };
    const result = await safeRun(session, event, { budgetMs: typeof retrievalBudgetMs === 'function' ? retrievalBudgetMs() : retrievalBudgetMs });
    if (disposed || payload.signal?.aborted) return decision;
    if (result.trace) {
      // The trace carries the decision but not the question it answered, so pass
      // the trimmed text alongside it; the Trajectory row shows what was asked.
      try { Promise.resolve(onTrace(session, result.trace, { turn: payload.turn, step: payload.step, question: userText })).catch(() => {}); }
      catch { /* Observability must not alter execution or model context. */ }
    }
    const additions = [resident?.context, result.context].filter(Boolean).map(createMessage);
    if (!additions.length) return decision;
    return { ...decision, messages: [...decision.messages, ...additions] };
  };
  const agentListeners = new Map();
  const registrations = [ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx || agentListeners.has(agent)) return;
    let admitted = false;
    const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.step !== 1) return next();
      // The admission decision itself is synchronous with respect to this
      // handler's await points: a user message in the triggering batch admits
      // the session and no later batch can race the flag within one step.
      if (!admitted) {
        const result = await preStep(payload, next);
        if (payload.messages?.some(message => message.source?.kind === 'user')) admitted = true;
        return result;
      }
      const decision = await next();
      if (decision.kind === 'enter' && !payload.signal?.aborted && acceptsSession(agent.session)) {
        const userText = (payload.messages || []).filter(message => message.source?.kind === 'user')
          .map(message => text(message.content)).join('\n').slice(0, maxTextChars);
        if (userText) turns.set(key(agent.session, payload.turn), { userText, assistantText: '', session: agent.session, turn: payload.turn });
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
      if (!captureOn() || event.data?.reason === 'error' || event.data?.reason === 'aborted') return;
      const task = typeof captureTurn === 'function'
        ? Promise.resolve(captureTurn({ session, turn, userText: state.userText, assistantText: state.assistantText, reason: event.data?.reason }, { budgetMs: captureBudget() }))
        : safeRun(session, describe(session, turn, 'turn_end', JSON.stringify({ user: state.userText, assistant: state.assistantText, evidenceStatus: 'conversation-only, not independently verified' })), { budgetMs: captureBudget() });
      pending.add(task);
      void task.finally(() => pending.delete(task));
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

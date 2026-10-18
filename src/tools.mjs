import { defineTool } from '@deepseek-ai/dsh-tools';

const status = { type: 'string', required: true, enum: ['ok','noop','denied','timeout','error','disabled'] };
const textResult = value => [{ type: 'text', text: value }];
const bounded = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new Error(`${name} must be non-empty and bounded`);
  return value.trim();
};

export function registerMemoryTools(ctx, { runtimeFor, identityFor, residentSnapshotFor, acceptsSession = () => true, retrieveBudgetMs = 60000, rememberBudgetMs = 60000 }) {
  const owner = exec => {
    const session = exec.agent?.session;
    if (!session) throw new Error('Memory tool requires an owning agent session');
    if (!acceptsSession(session)) throw new Error('Memory is unavailable for this session');
    return { session, runtime: runtimeFor(session) };
  };
  const event = (session, callId, type, body) => ({ ...identityFor(session), sessionId: session.id, id: `${session.id}:${callId || 'tool'}:${type}`, type, text: body });
  const retrieve = defineTool({
    name: 'memory_retrieve',
    description: 'Retrieve prior memory when the current task needs historical facts or deeper rationale. Auto mode lets SystemOne choose recall versus reflect and enabled scopes.',
    parameters: {
      query: { type: 'string', required: true, description: 'The focused question to answer from prior memory.' },
      mode: { type: 'string', enum: ['auto'], description: 'Use auto to let SystemOne choose recall or reflect.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { status, context: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } }, render: (_args,value)=>textResult(value.context || `Memory retrieval: ${value.status}`) },
    async execute(args, exec) {
      const { session, runtime } = owner(exec);
      if (!runtime) return { status:'disabled',context:'',truncated:false };
      const query = bounded(args.query, 'query');
      // Autonomous mode: the calling agent already decided that memory is
      // needed, so query read-enabled backends directly instead of asking an
      // external decision model what to do.
      if (typeof runtime.directRetrieve === 'function') {
        const direct = await runtime.directRetrieve(query, { signal: exec.signal });
        return { status: direct.status, context: direct.context || '', truncated: Boolean(direct.truncated) };
      }
      if (!runtime.orchestrator) return { status:'disabled',context:'',truncated:false };
      const result = await runtime.orchestrator.run(event(session,exec.callId,'message',query),{budgetMs:retrieveBudgetMs,signal:exec.signal});
      return { status:result.status,context:result.context || '',truncated:Boolean(result.context?.includes('"truncated":true')) };
    },
  });
  const remember = defineTool({
    name: 'memory_remember',
    description: 'Request durable retention of an explicit decision, preference, verified fact, or milestone. Storage remains policy-controlled and may be asynchronous.',
    parameters: { content: { type: 'string', required: true, description: 'The durable information to retain. Do not include credentials or hidden reasoning.' } },
    output: { schema: { type:'object',additionalProperties:false,properties:{status,accepted:{type:'integer',required:true}} }, render:(_args,value)=>textResult(`Memory retention: ${value.status}; accepted=${value.accepted}`) },
    async execute(args, exec) {
      const { session, runtime } = owner(exec);
      if (!runtime) return { status:'disabled',accepted:0 };
      const memoryEvent = event(session,exec.callId,'checkpoint',bounded(args.content,'content'));
      if (runtime.retentionRouter) {
        const snapshot = runtime.residentSnapshot ?? (typeof residentSnapshotFor === 'function' ? await residentSnapshotFor(session) : undefined);
        const result = await runtime.retentionRouter.retain(memoryEvent, snapshot, identityFor(session), { signal: exec.signal });
        return { status: result.status, accepted: result.accepted ?? 0 };
      }
      // Autonomous mode: an explicit memory_remember call IS the decision, so
      // write straight to the single writable backend. Retaining to resident
      // files still needs the decision model to pick a target and rewrite
      // content, so that path stays closed here.
      if (typeof runtime.directRetain === 'function') {
        try {
          const result = await runtime.directRetain(memoryEvent, { signal: exec.signal });
          return { status: result?.status ?? 'ok', accepted: result?.accepted ?? 0 };
        } catch { return { status: 'error', accepted: 0 }; }
      }
      if (!runtime.orchestrator) return { status:'disabled',accepted:0 };
      const result = await runtime.orchestrator.run(memoryEvent,{budgetMs:rememberBudgetMs,signal:exec.signal});
      return { status:result.status,accepted:(result.results||[]).filter(row=>row.operation==='write'&&row.status==='ok').length };
    },
  });
  const disposers=[ctx.tools.register(retrieve),ctx.tools.register(remember)];
  return ()=>{for(const dispose of disposers) dispose?.()};
}

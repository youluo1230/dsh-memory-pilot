import test from 'node:test';
import assert from 'node:assert/strict';
import { attachHost } from '../src/host.mjs';
function fixture(options={}) {
  const hooks = new Map(), agentHooks = new Map(), calls=[];
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name);}};
  const host=attachHost(ctx,{orchestrator:{async run(e){calls.push(e);return {context:'memory'};}},identity:()=>({actorId:'alice',projectId:'p'}),createMessage:text=>({content:text,source:{kind:'plugin:test'}}),...options});
  const session={id:'s',header:{cwd:'/test'}};
  const agent={session,ctx:{on(name,fn){agentHooks.set(name,fn);return ()=>agentHooks.delete(name);}}};
  hooks.get('agent/created')({agent});
  const user={source:{kind:'user'},content:[{type:'text',text:'hello'}]};
  const payload={agent,turn:1,step:1,signal:new AbortController().signal,messages:[user]};
  const decision={kind:'enter',messages:[user]};
  return {hooks,agentHooks,calls,host,session,payload,decision};
}
test('accepted first step injects only memory context and records trace out of band',async()=>{
 const traces=[]; const f=fixture({onTrace:(session,trace)=>traces.push([session.id,trace]),orchestrator:{async run(e){f?.calls?.push?.(e);return {context:'memory',trace:{schemaVersion:1,kind:'retrieval',marker:'TRACE-ONLY'}};}}});
 const result=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 assert.equal(result.messages[0],f.decision.messages[0]);assert.equal(result.messages.length,2);assert.equal(result.messages[1].content,'memory');
 assert.equal(JSON.stringify(result.messages).includes('TRACE-ONLY'),false);assert.deepEqual(traces,[['s',{schemaVersion:1,kind:'retrieval',marker:'TRACE-ONLY'}]]);await f.host.dispose();
});
test('resident memory is re-injected each turn and shown to the admission decision',async()=>{
 let loads=0; const snapshots=[];
 const f=fixture({residentSnapshotFor:async()=>{loads++;return {context:'resident-context',resident:{user:'Chinese',global:'pnpm',project:'ESM'}};},orchestrator:{async run(event){snapshots.push(event.residentMemory);return {context:'dynamic-memory'};}}});
 const result=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 await f.agentHooks.get('agent/pre-step')({...f.payload,turn:2},async()=>f.decision);
 // The snapshot's file read is cached by the plugin, but the injection itself is
 // per-turn: every turn must hand the model resident memory and give the
 // admission decision the same view.
 assert.equal(loads,2);assert.deepEqual(snapshots,[{user:'Chinese',global:'pnpm',project:'ESM'},{user:'Chinese',global:'pnpm',project:'ESM'}]);
 assert.deepEqual(result.messages.slice(1).map(message=>message.content),['resident-context','dynamic-memory']);
 await f.host.dispose();
});

test('noop trace is recorded without adding model context',async()=>{
 const traces=[];const f=fixture({onTrace:(_session,trace)=>traces.push(trace),orchestrator:{async run(){return {context:'',status:'noop',trace:{schemaVersion:1,kind:'retrieval',status:'noop'}};}}});
 const result=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 assert.equal(result.messages.length,1);assert.equal(traces[0].status,'noop');await f.host.dispose();
});
test('automatic retrieval includes bounded visible conversation context but excludes plugin context',async()=>{
 const f=fixture(); const priorUser={source:{kind:'user'},content:[{type:'text',text:'Earlier I supplied value X.'}]}; const priorAssistant={source:{kind:'assistant'},content:[{type:'text',text:'I can use X.'}]}; const injected={source:{kind:'plugin:test'},content:[{type:'text',text:'SECRET MEMORY'}]};
 f.decision.messages=[priorUser,priorAssistant,injected,...f.decision.messages];
 await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 assert.deepEqual(f.calls[0].availableContext,['user: Earlier I supplied value X.','assistant: I can use X.','user: hello']);
 assert.equal(JSON.stringify(f.calls[0]).includes('SECRET MEMORY'),false); await f.host.dispose();
});
test('listener is registered on the agent scope, not the plugin-global scope',async()=>{
 const f=fixture(); assert.equal(f.hooks.has('agent/pre-step'),false); assert.equal(f.agentHooks.has('agent/pre-step'),true); await f.host.dispose();
});
test('automatic retrieval runs for every real user turn, not only the first',async()=>{
 // The agent instance spans the whole conversation, so admission must be tracked
 // per turn: a single boolean skipped every follow-up silently.
 const f=fixture();
 const user={source:{kind:'user'},content:[{type:'text',text:'hello'}]};
 await f.agentHooks.get('agent/pre-step')({...f.payload,messages:[user]},async()=>f.decision);
 await f.agentHooks.get('agent/pre-step')({...f.payload,turn:2,messages:[user]},async()=>f.decision);
 assert.equal(f.calls.length,2); await f.host.dispose();
});
test('rejected input and later steps never call decision model',async()=>{
 const f=fixture();await f.agentHooks.get('agent/pre-step')(f.payload,async()=>({kind:'reject'}));
 await f.agentHooks.get('agent/pre-step')({...f.payload,step:2},async()=>f.decision);assert.equal(f.calls.length,0);await f.host.dispose();
});
test('every completed turn is captured directly to global memory without a decision call',async()=>{
 const captured=[]; const f=fixture({capture:true,captureTurn:async turn=>captured.push(turn)}); await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 f.hooks.get('session/event')(f.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'first answer'}]}}});
 f.hooks.get('session/event')(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 await f.agentHooks.get('agent/pre-step')({...f.payload,turn:2},async()=>f.decision);
 f.hooks.get('session/event')(f.session,{type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'second answer'}]}}});
 f.hooks.get('session/event')(f.session,{type:'turn/end',data:{turn:2,reason:{kind:'completed'}}});
 await f.host.dispose(); assert.equal(f.calls.length,2); assert.deepEqual(captured.map(turn=>[turn.userText,turn.assistantText]),[['hello','first answer'],['hello','second answer']]);
});
test('capture is opt-in and excludes reasoning',async()=>{
 const f=fixture({capture:true});await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 f.hooks.get('session/event')(f.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'answer'},{type:'reasoning',text:'secret reasoning'}]}}});
 f.hooks.get('session/event')(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 await f.host.dispose();assert.equal(f.calls.length,2);assert.equal(f.calls[1].type,'turn_end');assert.ok(!f.calls[1].text.includes('secret reasoning'));
});
test('different workspace never sends text to model',async()=>{
 const f=fixture({acceptsSession:()=>false});
 const result=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 assert.equal(result,f.decision);assert.equal(f.calls.length,0);await f.host.dispose();
});
test('aborted prompt cannot inject late output',async()=>{
 const controller=new AbortController();const f=fixture({orchestrator:{async run(){controller.abort();return {context:'late'};}}});
 const result=await f.agentHooks.get('agent/pre-step')({...f.payload,signal:controller.signal},async()=>f.decision);
 assert.equal(result,f.decision);await f.host.dispose();
});
test('automatic retrieval and capture use independent budgets',async()=>{
 const seen=[];
 const f=fixture({capture:true,retrievalBudgetMs:5678,captureBudgetMs:1234,orchestrator:{run:(e,o)=>{seen.push(o);return Promise.resolve({context:'',status:'noop',results:[]});}}});
 await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 f.hooks.get('session/event')(f.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 await f.host.dispose();
 assert.equal(seen.length,2);assert.deepEqual(seen[0],{budgetMs:5678});assert.deepEqual(seen[1],{budgetMs:1234});
});
test('orchestratorFor routes each session without reusing the first project facade',async()=>{
 const seen=[];
 const f=fixture({
  orchestrator:undefined,
  identity:session=>({projectId:session.header.cwd.slice(1)}),
  orchestratorFor:session=>({async run(event){seen.push([session.header.cwd,event.projectId]);return {context:event.projectId};}}),
 });
 const secondSession={id:'s2',header:{cwd:'/two'}}; const secondHooks=new Map(); const secondAgent={session:secondSession,ctx:{on(name,fn){secondHooks.set(name,fn);return ()=>secondHooks.delete(name);}}};
 f.hooks.get('agent/created')({agent:secondAgent});
 const second={...f.payload,agent:secondAgent,turn:2};
 const first=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 const other=await secondHooks.get('agent/pre-step')(second,async()=>f.decision);
 assert.deepEqual(seen,[['/test','test'],['/two','two']]);
 assert.equal(first.messages[1].content,'test');assert.equal(other.messages[1].content,'two');
 await f.host.dispose();
});

test('injected memory tells the UI what it was, not only its text', async () => {
  // A `recall` source with no `references` array renders as opaque raw JSON in
  // the Chat UI — which is what a reader saw instead of a memory summary. The
  // injection must therefore carry the label and the hit count.
  const seen = [];
  const f = fixture({
    createMessage: (text, meta) => { seen.push({ text, meta }); return { content: text }; },
    orchestrator: { async run() { return { context: 'recalled text', status: 'ok', trace: {
      executions: [{ operation: 'search', response: { status: 'ok', hitCount: 2 } }],
      injection: { truncated: false } } }; } },
  });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'recalled text');
  assert.equal(seen[0].meta.count, 2);
  assert.match(seen[0].meta.label, /召回/);
  await f.host.dispose();
});

test('resident memory is injected once per turn, not once per session', async () => {
  // The admission flag is per agent instance, and the runtime creates a fresh
  // agent for every turn, so each turn injects resident memory exactly once.
  // Within one turn, later steps must not repeat it: a measured turn carried
  // 1 899 characters of resident text against a 13-character user message.
  const created = [];
  const f = fixture({
    residentSnapshotFor: async () => ({ context: 'RESIDENT-BODY', resident: { global: 'm' } }),
    createMessage: (text) => { created.push(text); return { content: text }; },
  });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  // Later steps of the same agent instance stay silent.
  await f.agentHooks.get('agent/pre-step')({ ...f.payload, step: 2 }, async () => f.decision);
  await f.agentHooks.get('agent/pre-step')({ ...f.payload, step: 3 }, async () => f.decision);
  assert.equal(created.filter(text => text === 'RESIDENT-BODY').length, 1, 'one injection within a turn');
  await f.host.dispose();
});

test('every turn runs the memory decision, not only the first', async () => {
  // The agent instance handles every turn of a conversation. Admission used to be
  // a single boolean, so a four-turn Session produced one decision and skipped
  // the rest without a trace — the decision log showed one row and memory never
  // ran again after the first message.
  const runs = [];
  const f = fixture({ orchestrator: { async run(event) { runs.push(event.text); return { context: 'mem' }; } } });
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] };
  for (const turn of [1, 2, 3, 4]) {
    await f.agentHooks.get('agent/pre-step')({ ...f.payload, turn, messages: [user] }, async () => f.decision);
  }
  assert.equal(runs.length, 4, 'each turn must reach the decision');
  await f.host.dispose();
});

test('a second step of the same turn does not repeat the decision', async () => {
  const runs = [];
  const f = fixture({ orchestrator: { async run(event) { runs.push(event.text); return { context: 'mem' }; } } });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  await f.agentHooks.get('agent/pre-step')({ ...f.payload, step: 2 }, async () => f.decision);
  assert.equal(runs.length, 1, 'one decision per turn, not per step');
  await f.host.dispose();
});

test('a completed turn reports its write so the log can show it', async () => {
  // Capture runs silently after the answer. That silence was indistinguishable
  // from failure: a reader saw rows with no writes and concluded nothing was
  // being stored, even when both stores had accepted the turn.
  const traces = [];
  const f = fixture({ capture: true, captureTurn: async () => [{ status: 'fulfilled', value: { accepted: true } }, { status: 'fulfilled', value: { accepted: true } }],
    onTrace: (_session, trace, location) => traces.push({ trace, location }) });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  f.hooks.get('session/event')(f.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } } });
  f.hooks.get('session/event')(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const capture = traces.find(item => item.trace?.capture);
  assert.ok(capture, 'the write must publish a trace');
  assert.equal(capture.trace.capture.stored, 2);
  assert.equal(capture.trace.capture.failed, 0);
  assert.equal(capture.trace.kind, 'retention');
  await f.host.dispose();
});

test('tool safety is no longer injected as a turn note, and memory still runs', async () => {
  // Tool safety moved to `tools/pre-execute`, where it can actually veto a call, so
  // the host must stop appending a caution note. The memory path is unaffected.
  const f = fixture();
  const result = await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  assert.equal(result.messages.at(-1).content, 'memory', 'only the memory context is injected');
  await f.host.dispose();
});

test('distillation runs after a completed turn and publishes a trace', async () => {
  // Distillation is the selection step the plugin never had. It runs after the
  // answer, so it must never appear in the turn's messages — but it must publish a
  // trace, because a distillation that chose nothing is otherwise indistinguishable
  // from one that never ran.
  const traces = [];
  const releases = [];
  const f = fixture({
    distill: ({ session, turn }) => { releases.push([session.id, turn]); return { gate: 'discard', candidates: 0, retained: [], failed: [], durationMs: 3 }; },
    onTrace: (_session, trace, location) => traces.push({ trace, location }),
  });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  f.hooks.get('session/event')(f.session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } } });
  f.hooks.get('session/event')(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(releases, [['s', 1]]);
  const distill = traces.find(item => item.trace.kind === 'distillation');
  assert.ok(distill, 'the distillation must publish a trace');
  assert.equal(distill.trace.distill.retained, 0);
  await f.host.dispose();
});

test('an aborted or errored turn is not distilled', async () => {
  // A turn that never produced a conclusion has nothing to select from, and asking
  // would spend a judgment round trip on a turn the user already abandoned.
  const releases = [];
  const f = fixture({ distill: ({ turn }) => { releases.push(turn); return undefined; } });
  const user = { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] };
  for (const [turn, kind] of [[1, 'error'], [2, 'aborted']]) {
    await f.agentHooks.get('agent/pre-step')({ ...f.payload, turn, messages: [user] }, async () => f.decision);
    f.hooks.get('session/event')(f.session, { type: 'turn/end', data: { turn, reason: { kind } } });
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(releases, []);
  await f.host.dispose();
});

test('a throwing distill callback never fails the turn', async () => {
  // Distillation runs after the answer; a failure there is worth a log line, never
  // a failed turn.
  const errors = [];
  const f = fixture({ distill: () => { throw new Error('distill exploded'); }, onError: code => errors.push(code) });
  await f.agentHooks.get('agent/pre-step')(f.payload, async () => f.decision);
  f.hooks.get('session/event')(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.host.dispose();
  // The host contains the rejection internally; what matters is that dispose settled
  // and nothing propagated into the turn.
  assert.equal(errors.filter(code => /distill/.test(code)).length, 0);
});

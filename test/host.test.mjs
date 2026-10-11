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
test('resident memory is frozen once per session, injected before dynamic recall, and shown to admission decision',async()=>{
 let loads=0; const snapshots=[];
 const f=fixture({residentSnapshotFor:async()=>{loads++;return {context:'resident-context',resident:{user:'Chinese',global:'pnpm',project:'ESM'}};},orchestrator:{async run(event){snapshots.push(event.residentMemory);return {context:'dynamic-memory'};}}});
 const result=await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 await f.agentHooks.get('agent/pre-step')({...f.payload,turn:2},async()=>f.decision);
 assert.equal(loads,1);assert.deepEqual(snapshots,[{user:'Chinese',global:'pnpm',project:'ESM'}]);
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
test('automatic retrieval runs only for the session first real user turn',async()=>{
 const f=fixture();
 await f.agentHooks.get('agent/pre-step')(f.payload,async()=>f.decision);
 await f.agentHooks.get('agent/pre-step')({...f.payload,turn:2},async()=>f.decision);
 assert.equal(f.calls.length,1); await f.host.dispose();
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
 await f.host.dispose(); assert.equal(f.calls.length,1); assert.deepEqual(captured.map(turn=>[turn.userText,turn.assistantText]),[['hello','first answer'],['hello','second answer']]);
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

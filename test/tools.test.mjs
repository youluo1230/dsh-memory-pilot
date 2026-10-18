import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMemoryTools } from '../src/tools.mjs';

function fixture() {
 const definitions=[], removed=[];
 const ctx={tools:{register(def){definitions.push(def);return()=>removed.push(def.name)}}};
 const runs=[];
 const runtimeFor=session=>({orchestrator:{async run(event,options){runs.push({session,event,options});return event.type==='checkpoint'?{status:'ok',context:'',results:[{operation:'write',status:'ok'}]}:{status:'ok',context:'{"trust":"untrusted","sources":[]}',results:[]};}}});
 const dispose=registerMemoryTools(ctx,{runtimeFor,identityFor:session=>({workspaceId:session.header.workspaceId,projectId:'repo'}),acceptsSession:()=>true});
 return {definitions,removed,runs,dispose};
}
const exec=session=>({agent:{session},signal:new AbortController().signal,callId:'call-1'});
test('registers native retrieve and remember tools with identity-free parameters',()=>{
 const f=fixture(); assert.deepEqual(f.definitions.map(x=>x.name),['memory_retrieve','memory_remember']);
 for(const tool of f.definitions){assert.equal('scope' in tool.parameters,false);assert.equal('backend' in tool.parameters,false);assert.equal(tool.output.schema.additionalProperties,false)}
 f.dispose(); assert.deepEqual(f.removed,['memory_retrieve','memory_remember']);
});
test('retrieve and remember resolve the calling agent session and return safe canonical values',async()=>{
 const f=fixture(); const session={id:'s1',header:{cwd:'/work',workspaceId:'w1'}};
 const retrieve=f.definitions.find(x=>x.name==='memory_retrieve'); const remember=f.definitions.find(x=>x.name==='memory_remember');
 assert.deepEqual(await retrieve.execute({query:'why?',mode:'auto'},exec(session)),{status:'ok',context:'{"trust":"untrusted","sources":[]}',truncated:false});
 assert.deepEqual(await remember.execute({content:'durable decision'},exec(session)),{status:'ok',accepted:1});
 assert.equal(f.runs[0].session,session); assert.equal(f.runs[0].event.type,'message'); assert.equal(f.runs[1].event.type,'checkpoint'); assert.equal(f.runs[0].event.workspaceId,'w1');
});
test('remember routes between resident files and external memory through one policy decision',async()=>{
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};const retained=[];
 registerMemoryTools(ctx,{runtimeFor:()=>({retentionRouter:{retain:async(event,snapshot,identity)=>{retained.push({event,snapshot,identity});return{status:'ok',accepted:1,target:'project-memory'}}},residentSnapshot:{resident:{user:'',global:'',project:''},revisions:{user:'u',global:'g',project:'p'}}}),identityFor:()=>({projectId:'repo',projectPath:'/repo'}),acceptsSession:()=>true});
 const remember=definitions.find(tool=>tool.name==='memory_remember');const session={id:'s',header:{cwd:'/repo'}};
 assert.deepEqual(await remember.execute({content:'Use ESM.'},exec(session)),{status:'ok',accepted:1});
 assert.equal(retained[0].event.type,'checkpoint');assert.equal(retained[0].identity.projectId,'repo');
});
test('remember can route to resident memory without an external orchestrator',async()=>{
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};let calls=0;
 registerMemoryTools(ctx,{runtimeFor:()=>({retentionRouter:{retain:async()=>{calls++;return{status:'ok',accepted:1}}}}),residentSnapshotFor:async()=>({resident:{},revisions:{}}),identityFor:()=>({projectId:'repo'}),acceptsSession:()=>true});
 const remember=definitions.find(tool=>tool.name==='memory_remember');assert.deepEqual(await remember.execute({content:'Use pnpm.'},exec({id:'s'})),{status:'ok',accepted:1});assert.equal(calls,1);
});

test('tools fail closed without an accepted owning session',async()=>{
 const f=fixture(); const tool=f.definitions[0];
 await assert.rejects(tool.execute({query:'x',mode:'auto'},{signal:new AbortController().signal}),/owning agent session/);
});

test('autonomous mode retrieves directly without a decision model',async()=>{
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};const queries=[];
 registerMemoryTools(ctx,{runtimeFor:()=>({autonomous:true,orchestrator:null,
   directRetrieve:async(query,options)=>{queries.push({query,options});return{status:'ok',context:'- 网盘下载用 bdpan',truncated:false};}}),
   identityFor:()=>({projectId:'repo'}),acceptsSession:()=>true});
 const retrieve=definitions.find(tool=>tool.name==='memory_retrieve');
 assert.deepEqual(await retrieve.execute({query:'网盘',mode:'auto'},exec({id:'s',header:{cwd:'/repo'}})),
   {status:'ok',context:'- 网盘下载用 bdpan',truncated:false});
 assert.equal(queries[0].query,'网盘');
});

test('autonomous mode writes an explicit remember straight to the backend',async()=>{
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};const retained=[];
 registerMemoryTools(ctx,{runtimeFor:()=>({autonomous:true,orchestrator:null,retentionRouter:undefined,
   directRetain:async(event)=>{retained.push(event);return{status:'ok',accepted:1};}}),
   identityFor:()=>({projectId:'repo'}),acceptsSession:()=>true});
 const remember=definitions.find(tool=>tool.name==='memory_remember');
 assert.deepEqual(await remember.execute({content:'用 pnpm 不用 npm'},exec({id:'s',header:{cwd:'/repo'}})),{status:'ok',accepted:1});
 assert.equal(retained[0].type,'checkpoint');
 assert.equal(retained[0].text,'用 pnpm 不用 npm');
});

test('autonomous mode never crashes when no backend can retrieve or retain',async()=>{
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};
 registerMemoryTools(ctx,{runtimeFor:()=>({autonomous:true,orchestrator:null,directRetrieve:null,directRetain:null}),
   identityFor:()=>({projectId:'repo'}),acceptsSession:()=>true});
 const retrieve=definitions.find(tool=>tool.name==='memory_retrieve');
 const remember=definitions.find(tool=>tool.name==='memory_remember');
 assert.deepEqual(await retrieve.execute({query:'x',mode:'auto'},exec({id:'s',header:{cwd:'/repo'}})),{status:'disabled',context:'',truncated:false});
 assert.deepEqual(await remember.execute({content:'x'},exec({id:'s',header:{cwd:'/repo'}})),{status:'disabled',accepted:0});
});

test('autonomous remember fans out to every writable backend, not only a single one',async()=>{
 // Regression: this profile has two write-enabled backends (memos-global +
 // hs-repository). Basing autonomous retention on writable.length===1 left
 // directRetain undefined, so every explicit remember returned "disabled".
 const writable=[['memos-global',{capabilities:['search','write']}],['hs-repository',{capabilities:['search','write']}]];
 const writes=[];
 for(const [id,b] of writable){b.execute=async(a)=>{writes.push({id,op:a.operation});return{text:''}}}
 const retainOn=async([backendId,backend],event)=>{
   await backend.execute({operation:'write',backend:backendId,content:event.text});
   return {status:'ok',accepted:1};
 };
 const directRetain=async(event)=>{
   const settled=await Promise.allSettled(writable.map(entry=>retainOn(entry,event)));
   const accepted=settled.filter(r=>r.status==='fulfilled').length;
   if(!accepted) throw new Error('No backend accepted the write');
   return {status:'ok',accepted};
 };
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};
 registerMemoryTools(ctx,{runtimeFor:()=>({autonomous:true,orchestrator:null,directRetain}),
   identityFor:()=>({projectId:'code'}),acceptsSession:()=>true});
 const remember=definitions.find(tool=>tool.name==='memory_remember');
 assert.deepEqual(await remember.execute({content:'记住用 pnpm'},exec({id:'s',header:{cwd:'/repo'}})),{status:'ok',accepted:2});
 assert.deepEqual(writes.map(w=>w.id).sort(),['hs-repository','memos-global']);
 assert.deepEqual(writes.map(w=>w.op),['write','write']);
});

test('autonomous remember forwards the event to the backend so evidence validates',async()=>{
 // Regression: the plugin's retain helper passed only {signal} to execute().
 // Adapters validate write evidence against the event, so every write was
 // rejected with "Write evidence does not match event".
 const captured=[];
 const backend={capabilities:['write'],async execute(action,options){
   captured.push({action,options});
   if(!options?.event) throw new Error('Write evidence does not match event');
   if(options.event.id!==action.evidence.eventId) throw new Error('Write evidence does not match event');
   return {text:'ok'};
 }};
 const retainOn=async([backendId,b],event,{signal}={})=>{
   await b.execute({operation:'write',backend:backendId,content:event.text,evidence:{eventId:event.id,quote:event.text}},{signal,event});
   return {status:'ok',accepted:1};
 };
 const directRetain=async(event)=>{
   const settled=await Promise.allSettled([['b1',backend]].map(e=>retainOn(e,event)));
   const accepted=settled.filter(r=>r.status==='fulfilled').length;
   if(!accepted) throw new Error('No backend accepted the write');
   return {status:'ok',accepted};
 };
 const definitions=[];const ctx={tools:{register(def){definitions.push(def);return()=>{}}}};
 registerMemoryTools(ctx,{runtimeFor:()=>({autonomous:true,orchestrator:null,directRetain}),
   identityFor:()=>({projectId:'code'}),acceptsSession:()=>true});
 const remember=definitions.find(tool=>tool.name==='memory_remember');
 assert.deepEqual(await remember.execute({content:'记住这个'},exec({id:'s',header:{cwd:'/repo'}})),{status:'ok',accepted:1});
 assert.ok(captured[0].options.event,'event must reach execute()');
 assert.equal(captured[0].options.event.id,captured[0].action.evidence.eventId);
});

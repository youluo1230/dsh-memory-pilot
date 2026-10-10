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
test('tools fail closed without an accepted owning session',async()=>{
 const f=fixture(); const tool=f.definitions[0];
 await assert.rejects(tool.execute({query:'x',mode:'auto'},{signal:new AbortController().signal}),/owning agent session/);
});

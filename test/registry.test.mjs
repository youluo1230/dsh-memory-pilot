import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRegistry } from '../src/registry.mjs';
const factories={memos:opts=>({...opts,capabilities:['search'],execute:async()=>({text:'m'})}),hindsight:opts=>({...opts,capabilities:['search','deep','write'],execute:async()=>({text:'h'})})};
const binding=(id,type,scope,scopeId,extra={})=>({id,type,scope,scopeId,read:true,write:false,baseUrl:'http://x',...extra});
test('project MemOS and global Hindsight can be combined without hardcoded roles',()=>{
 const r=createRegistry({bindings:[binding('project','memos','project','p'),binding('shared','hindsight','global','global')],identities:{project:'p'},factories});
 assert.deepEqual(r.backends.project.capabilities,['search']);assert.deepEqual(r.backends.shared.capabilities,['search','deep']);assert.equal(r.policy.scopes.global.read,true);
});
test('global turn capture bypasses decision and targets only writable global capture backends',async()=>{
 const seen=[];
 const captureFactory=opts=>({...opts,capabilities:['search','write'],execute:async()=>({text:'x'}),captureTurn:async turn=>seen.push([opts.scope,turn.userText,turn.assistantText])});
 const r=createRegistry({bindings:[binding('global','memos-bridge','global','global',{baseUrl:'',write:true}),binding('project','hindsight','project','p',{write:true})],identities:{project:'p'},factories:{'memos-bridge':captureFactory,hindsight:factories.hindsight}});
 await r.captureTurn({userText:'question',assistantText:'answer'});
 assert.deepEqual(seen,[['global','question','answer']]);
});
test('same scope can have multiple independently permitted backends',async()=>{
 const r=createRegistry({bindings:[binding('a','hindsight','project','p',{write:true}),binding('b','hindsight','project','p')],identities:{project:'p'},factories});
 assert.ok(r.backends.a.capabilities.includes('write'));assert.ok(!r.backends.b.capabilities.includes('write'));assert.throws(()=>r.backends.b.execute({operation:'write'},{}));
});
test('invalid identity, duplicate id, unknown backend and unsupported write fail startup',()=>{
 for(const bindings of [[binding('a','memos','project','other')],[binding('a','memos','project','p'),binding('a','memos','project','p')],[binding('a','unknown','project','p')],[binding('a','memos','project','p',{write:true})]]) assert.throws(()=>createRegistry({bindings,identities:{project:'p'},factories}));
});
test('backend secrets resolve by environment reference',()=>{
 let options;createRegistry({bindings:[binding('a','memos','personal','u',{keyEnv:'KEY',cookieEnv:'COOKIE'})],identities:{personal:'u'},env:{KEY:'secret',COOKIE:'session'},factories:{memos:o=>{options=o;return factories.memos(o)}}});assert.equal(options.apiKey,'secret');assert.equal(options.sessionCookie,'session');
});
test('memos-bridge binds a local home without baseUrl and receives bridge options',()=>{
 let options;createRegistry({bindings:[binding('bridge','memos-bridge','project','p',{baseUrl:'',home:'/srv/memos',agent:'deepseek-harness',write:true})],identities:{project:'p'},factories:{'memos-bridge':o=>{options=o;return{capabilities:['search','write'],execute:async()=>({text:'x'})}}}});
 assert.equal(options.home,'/srv/memos');assert.equal(options.agent,'deepseek-harness');assert.equal(options.baseUrl,'');
 const r=createRegistry({bindings:[binding('bridge','memos-bridge','project','p',{home:'/srv/memos'})],identities:{project:'p'},factories:{'memos-bridge':()=>({capabilities:['search','write'],execute:async()=>({text:'x'})})}});
 assert.ok(r.backends.bridge.capabilities.includes('search'));
});
test('memos-bridge defaults to the DSH-local plugin home and honors DSH_HOME',()=>{
 let options;createRegistry({bindings:[binding('bridge','memos-bridge','project','p',{baseUrl:'',home:'',agent:''})],identities:{project:'p'},env:{DSH_HOME:'/srv/dsh'},factories:{'memos-bridge':o=>{options=o;return{capabilities:['search','write'],execute:async()=>({text:'x'})}}}});
 assert.equal(options.home,join('/srv/dsh','memos-plugin'));
 assert.equal(options.agent,'deepseek-harness');
 let fallback;createRegistry({bindings:[binding('bridge','memos-bridge','project','p',{baseUrl:'',home:'',agent:''})],identities:{project:'p'},env:{},factories:{'memos-bridge':o=>{fallback=o;return{capabilities:['search','write'],execute:async()=>({text:'x'})}}}});
 assert.equal(fallback.home,join(homedir(),'.dsh','memos-plugin'));
});
test('http backends still require baseUrl and apiKey literal is the fallback',()=>{
 assert.throws(()=>createRegistry({bindings:[binding('a','hindsight','global','global',{baseUrl:''})],identities:{},factories}));
 let options;createRegistry({bindings:[binding('a','hindsight','global','global',{apiKey:'literal-key'})],identities:{},env:{},factories:{hindsight:o=>{options=o;return factories.hindsight(o)}}});
 assert.equal(options.apiKey,'literal-key');
});

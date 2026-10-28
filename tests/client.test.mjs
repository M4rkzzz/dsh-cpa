import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('settings and session quota register in the same slots as DSH',()=>{
 let factory;const hooks={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[v,()=>{}],useEffect:()=>{},useRef:()=>({current:null}),useSyncExternalStore:(_s,get)=>get()};
 const context={window:{__ModuleLoader__:{load:x=>factory=x.factory}},document:{querySelector:()=>true},console};
 vm.runInNewContext(readFileSync(new URL('../lib/client-v013a.js',import.meta.url),'utf8'),context);
 const plugin=factory(name=>name==='react'?hooks:{Button:'Button',Tag:'Tag'}),registered=[];
 const ctx={slots:{inject:(_n,cb)=>cb(),register:(config,component)=>{registered.push({config,component});return()=>{}}},inject:(_dependencies,cb)=>cb(ctx),modelDirectories:{directoryFor:()=>({store:{subscribe:()=>()=>{},getSnapshot:()=>({current:{provider:'chatgpt-cpa',model:'gpt-6.1-terra'}})}})}};
 plugin.apply(ctx);
 assert.deepEqual(registered.map(x=>x.config.name),['settings.section','conversation.input.right']);
 const quota=registered[1],props=quota.config.inject('synthetic-session'),tree=quota.component(props);
 assert.equal(tree.props.className,'cpaPill_root');assert.match(tree.children[0].children[0],/CPA/);
});
test('settings survive an unavailable conversation slot service',()=>{
 let factory;const context={window:{__ModuleLoader__:{load:x=>factory=x.factory}},document:{querySelector:()=>true},console};
 vm.runInNewContext(readFileSync(new URL('../lib/client-v013a.js',import.meta.url),'utf8'),context);
 const plugin=factory(name=>name==='react'?{createElement:()=>null}:{Button:'Button',Tag:'Tag'}),registered=[];
 const ctx={slots:{inject:(_n,cb)=>cb(),register:config=>{registered.push(config.name);return()=>{}}},inject:()=>{throw Error('unavailable')}};
 assert.doesNotThrow(()=>plugin.apply(ctx));assert.deepEqual(registered,['settings.section']);
});




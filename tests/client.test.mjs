import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('settings and direct-model quota pill both register',()=>{
 let factory;const react={createElement:(type,props,...children)=>({type,props,children}),useState:v=>[v,()=>{}],useEffect:()=>{},useRef:()=>({current:null}),useSyncExternalStore:(_s,get)=>get()};
 const context={window:{__ModuleLoader__:{load:x=>factory=x.factory}},document:{querySelector:()=>true},console};
 vm.runInNewContext(readFileSync(new URL('../lib/client-v022.js',import.meta.url),'utf8'),context);
 const plugin=factory(name=>name==='react'?react:{Button:'Button',Tag:'Tag'}),registered=[];
 const ctx={slots:{inject:(_n,cb)=>cb(),register:(config,component)=>{registered.push({config,component});return()=>{}}},inject:(_d,cb)=>cb(ctx),modelDirectories:{directoryFor:()=>({store:{subscribe:()=>()=>{},getSnapshot:()=>({current:{provider:'openai-codex',model:'gpt-6.1-terra'}})}})}};
 plugin.apply(ctx);assert.deepEqual(registered.map(x=>x.config.name),['settings.section','conversation.input.right']);
 const pill=registered[1].component(registered[1].config.inject('synthetic-session'));assert.equal(pill.props.className,'cpaPill_root');
});

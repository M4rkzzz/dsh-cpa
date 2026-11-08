import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../lib/client-v028.js',import.meta.url),'utf8');
const MODEL='synthetic-model', A='a', B='b', email=id=>id+'@example.test', provider=id=>'cpa-codex-'+id;
const account=(id=A,extra={})=>({id,provider:provider(id),email:email(id),owned:id!==A,enabled:id===A,
 availability:'ready',canRunProbe:id===A,models:[MODEL,'other-model'],quota:{windows:[
 {name:'primary',minutes:300,used:42,remaining:58},{name:'secondary',minutes:10080,used:23,remaining:77}]},...extra});
const settings=(extra={})=>({online:true,management:true,authorizationPending:false,models:[MODEL,'other-model'],
 accounts:[account(A),account(B)],sync:{status:'ok',missing:[]},
 fast:{available:true,enabled:false,reason:null,providers:[provider(A)]},
 preferences:{activeAccountId:A,fastEnabled:false,plans:{[A]:{intervalMinutes:0,model:''},[B]:{intervalMinutes:0,model:''}}},...extra});
const logRow=(extra={})=>({id:'request-a',source:'conversation',startedAt:'2026-11-08T00:01:00Z',accountId:A,accountEmail:email(A),
 provider:provider(A),model:MODEL,status:'success',finishReason:'stop',httpStatus:200,errorCode:null,inputTokens:100,outputTokens:20,
 cacheReadTokens:10,cacheWriteTokens:null,cacheHitRate:.1,ttftMs:12,durationMs:220,tps:96.15,
 estimatedCostUsd:.001,costBasis:'estimate',priceBasis:'openai-standard-reference',priceModel:'synthetic-price',
 serviceTierRequested:'priority',serviceTierReported:'default',usageEvidence:'provider',...extra});
const activity=(extra={})=>({accounts:[{id:A,pelican:{available:true,running:false,intervalMinutes:0,model:'',nextRunAt:null,lastError:null,historyCount:0}},
 {id:B,pelican:{available:false,running:false,intervalMinutes:0,model:'',nextRunAt:null,lastError:null,historyCount:0}}],
 logs:{available:true,persistent:true,storage:{available:true,error:null},page:{nextCursor:null},recording:{pending:0,failed:0,error:null},entries:[],
 pricing:{checkedAt:'2026-11-08',sources:['https://developers.openai.com/api/docs/pricing']},
 summary:{total:0,running:0,success:0,error:0,cancelled:0,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,
 avgTtftMs:null,avgDurationMs:null,avgTps:null,avgCacheHitRate:null,samples:{ttft:0,tps:0,cacheHitRate:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},
 estimatedCostUsd:0,pricedRequests:0,unpricedRequests:0,upperBoundRequests:0}},...extra});
const withPelican=(id,changes={})=>{const next=activity();next.accounts=next.accounts.map(row=>row.id===id?{...row,pelican:{...row.pelican,...changes}}:row);return next;};
const withLogs=(changes={})=>{const next=activity();next.logs={...next.logs,...changes};return next;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
const fixed=Date.parse('2026-11-08T04:34:56Z');
class BrowserDate extends Date {
 constructor(...args){super(...(args.length?args:[fixed]));}
 static now(){return fixed;}
 local(){return new Date(this.getTime()+8*3600000);}
 getFullYear(){return this.local().getUTCFullYear();}getMonth(){return this.local().getUTCMonth();}getDate(){return this.local().getUTCDate();}
 getHours(){return this.local().getUTCHours();}getMinutes(){return this.local().getUTCMinutes();}
 toLocaleString(){return this.toISOString().replace('T',' ').replace('.000Z','');}
}
function harness({pill=false,visibility='visible',currentProvider='openai-codex',currentModel=MODEL,currentSession='session-a',locked=false,confirm=true,load,select,groups,initialSettings}={}){
 const hooks=[],effects=[],timers=new Map(),listeners=new Map(),requests=[],opened=[],removed=[],registered=[],selected=[],loads=[],confirms=[],subscribers=new Set();
 let cursor=0,dirty=false,mounted=true,tree,component,props={},factory,now=0,timerId=0,afterUnmount=0,focused=0,binding={key:currentSession};
 let state={current:{provider:currentProvider,model:currentModel,reasoningEffort:'high'},status:'ready',pending:null,groups:groups??[
  {id:'openai-codex',name:'Host',models:[{id:MODEL}]},
  ...[A,B].map(id=>({id:provider(id),name:email(id),models:[{id:MODEL,reasoning:{efforts:[{id:'low'},{id:'high'}],defaultEffort:'low'}},{id:'other-model'}]})),
 ]};
 const react={
  createElement(type,props,...children){if(props?.ref&&typeof props.ref==='object')props.ref.current={focus:()=>focused++,contains:target=>target?.inside===true};return {type,props:props??{},children};},Fragment:'Fragment',
  useState(initial){const i=cursor++;if(!hooks[i]){const slot={value:typeof initial==='function'?initial():initial};slot.set=value=>{if(!mounted){afterUnmount++;return;}const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;dirty=true;}};hooks[i]=slot;}return [hooks[i].value,hooks[i].set];},
  useRef(initial){const i=cursor++;return hooks[i]??(hooks[i]={current:initial});},
  useEffect(create,deps){const i=cursor++,old=hooks[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps[j]))){const slot={deps,create,cleanup:old?.cleanup};hooks[i]=slot;effects.push(slot);}},
  useSyncExternalStore(subscribe,get){const [,force]=this.useState(0);this.useEffect(()=>subscribe(()=>force(n=>n+1)),[subscribe]);return get();},
 };
 const store={getSnapshot:()=>state,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);}};
 const directory={store,async load(){loads.push(binding.key);return load?load(state):state;},async select(value){selected.push({...value});const result=select?await select(value):{ok:true};if(result?.ok){state={...state,current:{...value}};for(const notify of subscribers)notify();}return result;}};
 const document={visibilityState:visibility,querySelector:()=>true,
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 const context={window:{__ModuleLoader__:{load:value=>factory=value.factory},open:(...args)=>opened.push(args),focus:()=>focused++,confirm:message=>{confirms.push(message);return confirm;}},document,console,URL,URLSearchParams,Date:BrowserDate,
  setInterval(fn,ms){const id=++timerId;timers.set(id,{fn,ms,next:now+ms});return id;},clearInterval:id=>timers.delete(id),
  fetch(url,options={}){
   const parsed=new URL(url,'http://fixture.invalid');assert.ok(['/api/cpa-settings','/api/cpa-activity','/api/cpa-history'].includes(parsed.pathname),'unexpected buffered fetch '+url);
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const body=options.body?JSON.parse(options.body):undefined;
   const request={url,path:parsed.pathname,query:parsed.searchParams,action:body?.action??(parsed.pathname==='/api/cpa-settings'?'get':parsed.pathname==='/api/cpa-history'?'history-get':'activity-get'),body,options,pending:true,
    respond(data,ok=true,status=ok?200:400){assert.equal(request.pending,true);request.pending=false;resolve({ok,status,json:async()=>data});},
    malformed(status){assert.equal(request.pending,true);request.pending=false;resolve({ok:status>=200&&status<300,status,json:async()=>{throw Error('private response text');}});},
    fail(message='synthetic network failure'){request.pending=false;reject(Error(message));}};
   requests.push(request);return promise;
  },
 };
 vm.runInNewContext(source,context);
 const plugin=factory(id=>id==='react'?react:{Button:'Button',Tag:'Tag'});
 const ctx={slots:{inject(_name,register){return register();},register(config,render){registered.push({config,render});return()=>removed.push(config.id);}},
  uiSession:{adapter:{current:{getSnapshot:()=>binding}}},sessions:{subagentAddress:()=>locked?'remote-agent':undefined},
  modelDirectories:{directoryFor:id=>{assert.equal(typeof id,'string');return directory;}}};
 const dispose=plugin.apply(ctx),entry=registered.find(item=>item.config.name===(pill?'conversation.input.right':'settings.section'));
 component=entry.render;props=entry.config.inject?.(pill?currentSession:'cpa-settings')??{};
 function render(){if(!mounted)return;let loops=0;do{assert.ok(++loops<100,'render did not settle');dirty=false;cursor=0;tree=component(props);while(effects.length){const effect=effects.shift();effect.cleanup?.();effect.cleanup=effect.create();}}while(dirty);}
 function expand(node){if(node==null||typeof node==='boolean')return null;if(Array.isArray(node))return node.map(expand);if(typeof node==='object'&&typeof node.type==='function')return expand(node.type({...node.props,children:node.children}));if(typeof node==='object')return {...node,children:node.children.map(expand)};return node;}
 function text(node=tree){node=expand(node);if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(text).join('');if(typeof node==='object')return node.children.map(text).join('');return String(node);}
 function all(predicate,node=tree){node=expand(node);if(node==null||typeof node==='boolean')return [];if(Array.isArray(node))return node.flatMap(item=>all(predicate,item));if(typeof node!=='object')return [];return [...(predicate(node)?[node]:[]),...node.children.flatMap(item=>all(predicate,item))];}
 function one(predicate){const nodes=all(predicate);assert.equal(nodes.length,1,'expected one node, got '+nodes.length);return nodes[0];}
 render();
 const api={requests,opened,removed,registered,selected,loads,confirms,timers,listeners,ctx,props,
  get tree(){return tree;},get afterUnmount(){return afterUnmount;},get focused(){return focused;},get directory(){return state;},
  text,all,one,byLabel:label=>one(node=>node.props['aria-label']===label),button:label=>one(node=>['Button','button'].includes(node.type)&&text(node)===label),
  click(node){assert.ok(!node.props.disabled,'control is disabled');node.props.onClick?.({preventDefault(){},currentTarget:{focus:()=>focused++}});render();},
  change(node,value){assert.ok(!node.props.disabled,'control is disabled');node.props.onChange({target:{value}});render();},
  pending:(action,accountId)=>requests.find(request=>request.pending&&request.action===action&&(accountId===undefined||request.body?.accountId===accountId)),
  async flush(){for(let i=0;i<35;i++){await Promise.resolve();if(dirty)render();}},
  advance(ms){now+=ms;for(const timer of [...timers.values()])while(timer.next<=now){timer.next+=timer.ms;timer.fn();}render();},
  visibility(value){document.visibilityState=value;for(const callback of listeners.get('visibilitychange')??[])callback();render();},
  event(name,event={}){for(const callback of listeners.get(name)??[])callback(event);render();},
  setDirectory(change){state={...state,...change};for(const notify of subscribers)notify();render();},setSession(id){binding={key:id};},
  unmount(){mounted=false;for(const hook of hooks)hook?.cleanup?.();dispose();},
 };
 api.respond=async(action,data,ok=true,status=ok?200:400)=>{const request=api.pending(action);assert.ok(request,'missing request '+action);request.respond(data,ok,status);await api.flush();return request;};
 api.ready=async(data=initialSettings??settings(),active=activity())=>{await api.respond('get',data);if(!pill)await api.respond('activity-get',active);return api;};
 return api;
}

test('v026 registers real public selection services and removes only its two entries',()=>{
 const ui=harness({pill:true});assert.deepEqual(ui.registered.map(row=>row.config.name),['settings.section','conversation.input.right']);
 assert.equal(ui.tree.props.style.height,28);ui.unmount();assert.deepEqual(ui.removed,['cpa-settings','cpa-usage']);assert.equal(ui.afterUnmount,0);
 const other=harness({pill:true,currentProvider:'other-provider'});assert.equal(other.tree,null);assert.equal(other.requests.length,0);other.unmount();
});
test('toolbar has only Fast and weekly quota with model-matched dimensions and no CPA trigger',async()=>{
 const ui=await harness({pill:true}).ready();const buttons=ui.all(n=>n.type==='button');assert.equal(buttons.length,2);assert.deepEqual(buttons.map(n=>ui.text(n)),['Fast','周 23%']);
 for(const button of buttons){assert.equal(button.props.style.height,28);assert.equal(button.props.style.fontSize,13);assert.equal(button.props.style.fontWeight,400);assert.equal(button.props.style.lineHeight,'20px');assert.equal(button.props.style.padding,'0 6px');}
 assert.equal(ui.all(n=>n.props['aria-haspopup']==='dialog').length,1);assert.equal(ui.button('Fast').props['aria-checked'],false);ui.unmount();
});
test('account list is email-named and has one enabled radio; only the active test is usable',async()=>{
 const ui=await harness().ready();assert.equal(ui.all(n=>n.type==='article').length,2);const radios=ui.all(n=>n.type==='input'&&n.props.type==='radio');
 assert.equal(radios.filter(n=>n.props.checked).length,1);assert.equal(radios[0].props.style.accentColor,'#39a878');
 assert.equal(ui.byLabel(email(A)+' 鹈鹕测试').props.disabled,false);assert.equal(ui.byLabel(email(B)+' 鹈鹕测试').props.disabled,true);
 assert.equal(ui.all(n=>n.type==='option',ui.byLabel(email(A)+' 的自动执行间隔')).length,5);
 assert.equal(ui.text().includes('连接状态'),false);assert.equal(ui.text().includes('账号与额度'),false);ui.unmount();
});
test('interval selection only configures and waits for an acknowledged state',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel(email(A)+' 的自动执行间隔'),'5');await ui.flush();
 const request=ui.pending('pelican-configure');assert.ok(request);assert.equal(request.body.accountId,A);assert.equal(request.body.intervalMinutes,5);assert.equal(request.body.model,MODEL);assert.equal(ui.pending('pelican-run'),undefined);
 request.respond(withPelican(A,{intervalMinutes:5,model:MODEL,nextRunAt:'2026-11-08T04:40:00Z'}));await ui.flush();assert.equal(ui.byLabel(email(A)+' 的自动执行间隔').props.value,'5');ui.unmount();
});
test('the words pelican test run exactly once and do not enable a schedule',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 鹈鹕测试'));await ui.flush();const request=ui.pending('pelican-run');assert.deepEqual(request.body,{action:'pelican-run',accountId:A,model:MODEL});
 assert.equal(ui.pending('pelican-configure'),undefined);request.respond(withPelican(A,{running:true}));await ui.flush();assert.equal(ui.byLabel(email(A)+' 停止').props.disabled,false);ui.unmount();
});
test('Fast activation uses normal public model selection and ACK, never an optimistic checkbox',async()=>{
 const ui=await harness({pill:true}).ready();ui.click(ui.button('Fast'));await ui.flush();assert.equal(ui.button('Fast').props['aria-checked'],false);
 assert.equal(ui.pending('fast').body.enabled,true);assert.equal(ui.pending('fast').body.accountId,A);assert.equal(ui.selected.length,0);
 await ui.respond('fast',settings({fast:{available:true,enabled:true,providers:[provider(A)]}}));
 assert.deepEqual(ui.selected,[{provider:provider(A),model:MODEL,reasoningEffort:'high'}]);
 if(ui.pending('get'))await ui.respond('get',settings({fast:{available:true,enabled:true,providers:[provider(A)]}}));
 assert.equal(ui.button('Fast').props['aria-checked'],true);assert.equal(ui.button('Fast').props.disabled,false);ui.unmount();
});
test('no-session account activation persists the one selected account without inventing a session',async()=>{
 const ui=await harness({currentSession:undefined}).ready();ui.setSession(undefined);ui.change(ui.byLabel('启用 '+email(B)),true);await ui.flush();
 const rows=[account(A,{enabled:false,canRunProbe:false}),account(B,{enabled:true,canRunProbe:true})];
 await ui.respond('account-select',settings({accounts:rows,fast:{available:true,enabled:false,providers:[provider(B)]},preferences:{activeAccountId:B,plans:{}}}));
 assert.equal(ui.selected.length,0);assert.equal(ui.byLabel('启用 '+email(B)).props.checked,true);ui.unmount();
});

test('Fast off stays on the same owned channel and omits selection RPCs',async()=>{
 const ui=await harness({pill:true,currentProvider:provider(A)}).ready(settings({fast:{available:true,enabled:true,providers:[provider(A)]}}));
 assert.equal(ui.button('Fast').props['aria-checked'],true);ui.click(ui.button('Fast'));await ui.flush();assert.equal(ui.pending('fast').body.enabled,false);
 await ui.respond('fast',settings());assert.equal(ui.button('Fast').props['aria-checked'],false);assert.equal(ui.selected.length,0);ui.unmount();
});
for(const mode of ['inactive','missing-capability','locked','unavailable-credentials'])test('Fast fails closed for '+mode,async()=>{
 const rows=mode==='inactive'?[account(A,{enabled:false}),account(B,{enabled:true})]:mode==='unavailable-credentials'?[account(A,{availability:'unknown'}),account(B)]:undefined;
 const data=settings({...rows?{accounts:rows}:{},...mode==='missing-capability'?{fast:{available:false,enabled:true,providers:[]}}:{}});
 const ui=await harness({pill:true,locked:mode==='locked'}).ready(data);assert.equal(ui.button('Fast').props.disabled,true);assert.equal(ui.button('Fast').props['aria-checked'],false);assert.equal(ui.pending('fast'),undefined);ui.unmount();
});
test('Fast failure never selects a model or fakes an enabled check, and remains retryable',async()=>{
 const ui=await harness({pill:true}).ready();ui.click(ui.button('Fast'));await ui.flush();await ui.respond('fast',{error:'settings-save-failed'},false);
 assert.equal(ui.selected.length,0);assert.equal(ui.button('Fast').props['aria-checked'],false);assert.equal(ui.button('Fast').props.disabled,false);assert.match(ui.text(),/设置未能保存/);ui.unmount();
});
test('resolved public select failure is not success and raw RPC errors are never shown',async()=>{
 const ui=await harness({pill:true,select:()=>({ok:false,error:{code:'other',message:'synthetic private error'}})}).ready();ui.click(ui.button('Fast'));await ui.flush();
 await ui.respond('fast',settings({fast:{available:true,enabled:true,providers:[provider(A)]}}));assert.equal(ui.button('Fast').props['aria-checked'],false);
 assert.match(ui.text(),/模型选择失败/);assert.equal(ui.text().includes('synthetic private'),false);ui.unmount();
});
test('unsupported current model cannot silently pick a different paid model when enabling Fast',async()=>{
 const ui=await harness({pill:true,currentModel:'unsupported-model'}).ready();ui.click(ui.button('Fast'));await ui.flush();assert.equal(ui.pending('fast'),undefined);assert.equal(ui.selected.length,0);assert.match(ui.text(),/不受此 CPA 通道支持/);ui.unmount();
});
test('quota popover does not toggle Fast and Escape restores focus',async()=>{
 const ui=await harness({pill:true}).ready();const button=ui.byLabel('查看周额度');ui.click(button);assert.equal(ui.all(n=>n.props.role==='dialog').length,1);assert.equal(ui.pending('fast'),undefined);
 ui.event('mousedown',{target:{inside:true}});assert.equal(ui.all(n=>n.props.role==='dialog').length,1);
 ui.event('keydown',{key:'Escape',preventDefault(){}});assert.equal(ui.all(n=>n.props.role==='dialog').length,0);assert.ok(ui.focused>0);ui.unmount();
});
test('stale quota observations retain their old values and a visible stale marker',async()=>{
 const ui=await harness({pill:true}).ready(settings({accounts:[account(A,{quotaStale:true,quotaError:'quota-refresh-unavailable'})]}));
 assert.match(ui.text(),/周 23% \*/);ui.click(ui.byLabel('查看周额度'));assert.match(ui.text(),/旧观测/);ui.unmount();
});
test('account activation acknowledges exactly one radio then selects through the public directory',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();assert.equal(ui.byLabel('启用 '+email(A)).props.checked,true);assert.equal(ui.selected.length,0);
 await ui.respond('account-select',settings({accounts:[account(A,{enabled:false,canRunProbe:false}),account(B,{enabled:true,canRunProbe:true})],preferences:{activeAccountId:B,plans:{}},fast:{available:true,enabled:false,providers:[provider(B)]}}));
 assert.equal(ui.byLabel('启用 '+email(B)).props.checked,true);assert.equal(ui.byLabel('启用 '+email(A)).props.checked,false);assert.equal(ui.selected[0].provider,provider(B));assert.equal(ui.selected[0].model,MODEL);ui.unmount();
});
test('busy ordinary conversations refuse activation without showing two enabled accounts',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();await ui.respond('account-select',{error:'account-switch-busy'},false,409);
 assert.equal(ui.byLabel('启用 '+email(A)).props.checked,true);assert.equal(ui.byLabel('启用 '+email(B)).props.checked,false);assert.equal(ui.selected.length,0);assert.match(ui.text(),/请先停止当前账号的会话请求/);ui.unmount();
});
for(const change of ['session','model'])test('account activation never overwrites a newer '+change+' choice',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 if(change==='session')ui.setSession('session-new');else ui.setDirectory({current:{provider:'other',model:'new-explicit-model'}});
 await ui.respond('account-select',settings({accounts:[account(A,{enabled:false}),account(B,{enabled:true})],fast:{providers:[provider(B)]},preferences:{activeAccountId:B,plans:{}}}));
 assert.equal(ui.selected.length,0);assert.match(ui.text(),change==='session'?/会话已切换/:/模型已由其它操作更改/);ui.unmount();
});
test('account with an unsupported current model is enabled but waits for an explicit replacement choice',async()=>{
 const ui=await harness({currentModel:'unsupported-model'}).ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 const next=settings({accounts:[account(A,{enabled:false}),account(B,{enabled:true})],fast:{providers:[provider(B)]},preferences:{activeAccountId:B,plans:{}}});await ui.respond('account-select',next);
 assert.equal(ui.byLabel('启用 '+email(B)).props.checked,true);assert.equal(ui.selected.length,0);ui.change(ui.byLabel(email(B)+' 的会话模型'),'other-model');await ui.flush();await ui.respond('account-select',next);
 assert.equal(ui.selected[0].model,'other-model');assert.equal(ui.selected[0].provider,provider(B));ui.unmount();
});
test('reasoning effort is retained only when the target actually advertises it',async()=>{
 const groups=[{id:provider(B),models:[{id:MODEL,reasoning:{efforts:[{id:'low'}],defaultEffort:'low'}}]}];const ui=await harness({groups}).ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 await ui.respond('account-select',settings({accounts:[account(A,{enabled:false}),account(B,{enabled:true})],fast:{providers:[provider(B)]},preferences:{activeAccountId:B,plans:{}}}));
 assert.equal(ui.selected[0].reasoningEffort,'low');ui.unmount();
});
test('model metadata failure is sanitized and does not activate another account',async()=>{
 const ui=await harness({load:()=>{throw Error('private model metadata');}}).ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();assert.equal(ui.pending('account-select'),undefined);assert.match(ui.text(),/模型目录暂不可用/);assert.equal(ui.text().includes('private model'),false);ui.unmount();
});
test('test-model preference persists through configure without running, after a successful ACK only',async()=>{
 const ui=await harness().ready();const control=ui.byLabel(email(A)+' 的测试模型');ui.change(control,'other-model');await ui.flush();assert.equal(ui.byLabel(email(A)+' 的测试模型').props.value,'');
 const request=ui.pending('pelican-configure');assert.deepEqual(request.body,{action:'pelican-configure',accountId:A,intervalMinutes:0,model:'other-model'});request.respond(withPelican(A,{model:'other-model'}));await ui.flush();
 assert.equal(ui.byLabel(email(A)+' 的测试模型').props.value,'other-model');assert.equal(ui.pending('pelican-run'),undefined);ui.unmount();
});
test('failed model preference save retains the old display instead of pretending it persisted',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel(email(A)+' 的测试模型'),'other-model');await ui.flush();await ui.respond('pelican-configure',{error:'settings-save-failed'},false);
 assert.equal(ui.byLabel(email(A)+' 的测试模型').props.value,'');assert.match(ui.text(),/设置未能保存/);ui.unmount();
});
test('selecting current-model mode clears the saved model and uses the actual current selection',async()=>{
 const data=settings();data.preferences.plans[A].model='other-model';const ui=await harness().ready(data,withPelican(A,{model:'other-model'}));
 ui.change(ui.byLabel(email(A)+' 的测试模型'),'');await ui.flush();await ui.respond('pelican-configure',withPelican(A,{model:''}));
 ui.click(ui.byLabel(email(A)+' 鹈鹕测试'));await ui.flush();assert.equal(ui.pending('pelican-run').body.model,MODEL);ui.unmount();
});
for(const value of ['1','6','60','05','0.1','Infinity',''])test('non-enumerated interval '+JSON.stringify(value)+' is never submitted',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel(email(A)+' 的自动执行间隔'),value);await ui.flush();assert.equal(ui.pending('pelican-configure'),undefined);assert.equal(ui.pending('pelican-run'),undefined);ui.unmount();
});
for(const kind of ['run','configure'])for(const order of ['old-first','stop-first'])for(const outcome of ['success','error'])test('stop supersedes pending '+kind+' / '+order+' / '+outcome,async()=>{
 const ui=await harness().ready();if(kind==='run')ui.click(ui.byLabel(email(A)+' 鹈鹕测试'));else ui.change(ui.byLabel(email(A)+' 的自动执行间隔'),'10');await ui.flush();const old=ui.pending(kind==='run'?'pelican-run':'pelican-configure');
 ui.click(ui.byLabel(email(A)+' 停止'));await ui.flush();const stop=ui.requests.find(r=>r.pending&&r!==old&&['pelican-cancel','pelican-configure'].includes(r.action));assert.ok(stop);
 const finishOld=()=>old.respond(outcome==='error'?{error:'old-operation-error'}:withPelican(A,{running:kind==='run',intervalMinutes:kind==='configure'?10:0}),outcome==='success');
 if(order==='old-first')finishOld();stop.respond(withPelican(A));await ui.flush();if(order==='stop-first'){finishOld();await ui.flush();}
 assert.equal(ui.byLabel(email(A)+' 的自动执行间隔').props.value,'0');assert.equal(ui.byLabel(email(A)+' 鹈鹕测试').props.disabled,false);assert.equal(ui.text().includes('old-operation-error'),false);ui.unmount();
});
for(const outcome of ['resolve','reject'])test('stop before deferred model validation '+outcome+' prevents any late run POST',async()=>{
 const gate=deferred();const ui=await harness({load:state=>gate.promise.then(()=>state)}).ready();ui.click(ui.byLabel(email(A)+' 鹈鹕测试'));await ui.flush();assert.equal(ui.pending('pelican-run'),undefined);
 ui.click(ui.byLabel(email(A)+' 停止'));await ui.flush();await ui.respond('pelican-cancel',withPelican(A));if(outcome==='resolve')gate.resolve();else gate.reject(Error('private late model error'));await ui.flush();
 assert.equal(ui.pending('pelican-run'),undefined);assert.equal(ui.text().includes('private late'),false);ui.unmount();
});
test('restored scheduled values only display the plan; client polling never calls a model',async()=>{
 const data=settings();data.preferences.plans[A]={intervalMinutes:30,model:MODEL};const ui=await harness().ready(data,withPelican(A,{intervalMinutes:30,model:MODEL,nextRunAt:'2026-11-08T05:00:00Z'}));
 ui.advance(60000);await ui.flush();assert.ok(ui.requests.every(r=>!r.body));assert.equal(ui.byLabel(email(A)+' 的自动执行间隔').props.value,'30');ui.unmount();
});
test('hidden UI neither fetches nor polls, then resumes once without overlap',async()=>{
 const ui=harness({visibility:'hidden'});assert.equal(ui.requests.length,0);ui.advance(120000);assert.equal(ui.requests.length,0);ui.visibility('visible');await ui.flush();assert.equal(ui.requests.length,2);ui.advance(60000);assert.equal(ui.requests.length,2);await ui.ready();ui.unmount();assert.equal(ui.timers.size,0);
});

test('history renders only authenticated PNG images and at most eight per account',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 的历史'));await ui.flush();const images=Array.from({length:12},(_,i)=>({id:'image-'+i,createdAt:'2026-11-08T01:00:00Z',url:'/api/cpa-image?accountId=a&imageId=image-'+i}));
 await ui.respond('history-get',{images,svg:'<svg><script>private-output</script></svg>'});assert.equal(ui.all(n=>n.type==='img').length,8);assert.equal(ui.all(n=>['svg','iframe','object','embed'].includes(n.type)).length,0);assert.equal(ui.all(n=>n.props.dangerouslySetInnerHTML).length,0);assert.equal(ui.text().includes('private-output'),false);ui.unmount();
});
for(const url of ['https://example.invalid/a.png','//example.invalid/a.png','data:image/png;base64,AAAA','javascript:alert(1)','/api/cpa-settings?accountId=a&imageId=x','/api/cpa-image?accountId=b&imageId=x','/api/cpa-image?accountId=a&imageId=other','/api/cpa-image?accountId=a&imageId=x&extra=1'])test('history refuses unsafe or cross-account image URL '+url,async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 的历史'));await ui.flush();await ui.respond('history-get',{images:[{id:'x',createdAt:'2026-11-08T01:00:00Z',url}]});assert.equal(ui.all(n=>n.type==='img').length,0);ui.unmount();
});
test('late history responses cannot reopen a closed panel or replace another account history',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 的历史'));await ui.flush();const old=ui.pending('history-get');ui.click(ui.button('关闭历史'));ui.click(ui.byLabel(email(B)+' 的历史'));await ui.flush();const latest=ui.requests.find(r=>r.pending&&r.action==='history-get'&&r!==old);
 latest.respond({images:[{id:'b-png',url:'/api/cpa-image?accountId=b&imageId=b-png',createdAt:'2026-11-08T01:00:00Z'}]});await ui.flush();old.respond({images:[{id:'a-png',url:'/api/cpa-image?accountId=a&imageId=a-png',createdAt:'2026-11-08T01:00:00Z'}]});await ui.flush();
 assert.equal(ui.all(n=>n.type==='img').length,1);assert.match(ui.all(n=>n.type==='img')[0].props.src,/accountId=b/);ui.unmount();
});
test('log times use local today HH:mm or MM-DD, retain full start title, and never expose end time',async()=>{
 const rows=[logRow({id:'today',startedAt:'2026-11-07T16:01:00Z',endedAt:'2099-02-03T04:05:06Z'}),logRow({id:'yesterday',startedAt:'2026-11-07T15:59:00Z'}),logRow({id:'next',startedAt:'2026-11-09T00:00:00Z'})];
 const ui=await harness().ready(settings(),withLogs({entries:rows}));const dates=ui.all(n=>n.type==='time');assert.deepEqual(dates.map(n=>ui.text(n)),['00:01','11-07','11-09']);assert.ok(dates.every(n=>n.props.title.includes('2026-11-')));assert.equal(ui.text().includes('2099'),false);assert.equal(ui.text().includes('结束时间'),false);ui.unmount();
});
test('logs display real HTTP, separate raw cache read/write, input/output, and requested/reported tier',async()=>{
 const ui=await harness().ready(settings(),withLogs({entries:[logRow()]}));const row=ui.all(n=>n.type==='tbody')[0];assert.match(ui.text(row),/20010 \/ —10%100 \/ 20/);assert.match(ui.text(row),/priority \/ default/);assert.ok(ui.all(n=>n.type==='td'&&n.props.title==='用量来源：provider').length);assert.match(ui.text(),/缓存读 \/ 写/);assert.match(ui.text(),/标准价 USD/);ui.unmount();
});
test('missing usage and HTTP are unknown, not free or guessed from success',async()=>{
 const unknown=logRow({httpStatus:null,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,cacheHitRate:null,estimatedCostUsd:null,costBasis:'unknown'});
 const ui=await harness().ready(settings(),withLogs({entries:[unknown],summary:{...activity().logs.summary,total:1,success:1,unpricedRequests:1,estimatedCostUsd:0}}));const row=ui.all(n=>n.type==='tbody')[0];assert.equal(ui.text(row).includes('200'),false);assert.equal(ui.text(row).includes('$0'),false);assert.match(ui.text(row),/— \/ —/);assert.match(ui.text(),/未知 1/);ui.unmount();
});
test('reference amounts retain conservative upper-bound markers and official-only price links',async()=>{
 const logs={...activity().logs,entries:[logRow({costBasis:'upper-bound'})],summary:{...activity().logs.summary,total:1,success:1,estimatedCostUsd:.001,pricedRequests:1,upperBoundRequests:1},pricing:{checkedAt:'2026-11-08',sources:['https://developers.openai.com/api/docs/pricing','javascript:private','https://evil.invalid/pricing']}};
 const ui=await harness().ready(settings(),activity({logs}));assert.match(ui.text(),/≤/);assert.equal(ui.all(n=>n.type==='a'&&n.props.href.includes('evil')).length,0);assert.equal(ui.all(n=>n.type==='a'&&n.props.href.startsWith('javascript')).length,0);ui.unmount();
});
test('storage corruption and write admission failures are visible rather than silently claiming persistence',async()=>{
 const ui=await harness().ready(settings(),withLogs({storage:{available:true,error:'log-storage-corrupt'},recording:{pending:0,failed:2,error:'log-store-busy'}}));assert.match(ui.text(),/日志存储警告：log-storage-corrupt/);assert.match(ui.text(),/2 条记录未能持久保存/);ui.unmount();
});
test('log export is an authenticated streaming link using active filters, not a buffered fetch',async()=>{
 const ui=await harness().ready();ui.change(ui.byLabel('日志状态'),'error');await ui.flush();await ui.respond('activity-get',activity());
 const link=ui.one(n=>n.type==='a'&&ui.text(n)==='导出全部匹配日志');assert.equal(link.props.href,'/api/cpa-logs-export?status=error');assert.equal(link.props.download,'cpa-logs.ndjson');assert.equal(ui.requests.some(r=>r.path==='/api/cpa-logs-export'),false);ui.unmount();
});
test('cursor pagination replaces one page and filters reset both cursor and navigation history',async()=>{
 const ui=await harness().ready(settings(),withLogs({entries:[logRow({id:'first',model:'first-model'})],page:{nextCursor:'cursor-2'}}));ui.click(ui.button('下一页'));await ui.flush();const next=ui.pending('activity-get');assert.equal(next.query.get('cursor'),'cursor-2');next.respond(withLogs({entries:[logRow({id:'second',model:'second-model'})],page:{nextCursor:null}}));await ui.flush();
 assert.match(ui.text(),/second-model/);assert.equal(ui.text().includes('first-model'),false);ui.change(ui.byLabel('日志来源'),'pelican');await ui.flush();const filtered=ui.pending('activity-get');assert.equal(filtered.query.get('cursor'),null);assert.equal(filtered.query.get('source'),'pelican');filtered.respond(activity());await ui.flush();ui.unmount();
});
for(const confirm of [false,true])test('clear logs requires explicit confirmation: '+confirm,async()=>{
 const ui=await harness({confirm}).ready();ui.click(ui.button('清空请求日志'));await ui.flush();assert.equal(ui.confirms.length,1);assert.match(ui.confirms[0],/无限持久保存/);assert.equal(!!ui.pending('logs-clear'),confirm);
 if(confirm)await ui.respond('logs-clear',activity());ui.unmount();
});
for(const status of [200,401,503])test('non-JSON status '+status+' exposes only a fixed API error',async()=>{
 const ui=harness();ui.pending('get').malformed(status);await ui.flush();assert.match(ui.text(),status===200?/api-invalid-json/:new RegExp('api-http-'+status));assert.equal(ui.text().includes('private response'),false);ui.unmount();
});
test('unmount invalidates pending settings, actions, history and polls without post-unmount state updates',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 的历史'));await ui.flush();const history=ui.pending('history-get');ui.click(ui.byLabel(email(A)+' 鹈鹕测试'));await ui.flush();const run=ui.pending('pelican-run');ui.unmount();
 history.respond({images:[]});run.respond(withPelican(A,{running:true}));await ui.flush();assert.equal(ui.afterUnmount,0);assert.equal(ui.timers.size,0);
});


test('a Fast ACK for a different enabled account cannot select the old inactive provider',async()=>{
 const ui=await harness({pill:true}).ready();ui.click(ui.button('Fast'));await ui.flush();
 await ui.respond('fast',settings({accounts:[account(A,{enabled:false,canRunProbe:false}),account(B,{enabled:true,canRunProbe:true})],preferences:{activeAccountId:B,plans:{}},fast:{available:true,enabled:true,providers:[provider(B)]}}));
 assert.equal(ui.selected.length,0);assert.equal(ui.button('Fast').props['aria-checked'],false);assert.match(ui.text(),/账号已更改，未切换当前会话模型/);ui.unmount();
});
test('removing an unrelated account does not invalidate an in-flight retained-account PNG history',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(A)+' 的历史'));await ui.flush();const history=ui.pending('history-get');
 ui.click(ui.byLabel('移除 '+email(B)));await ui.flush();await ui.respond('account-remove',settings({accounts:[account(A)]}));
 history.respond({images:[{id:'a-png',url:'/api/cpa-image?accountId=a&imageId=a-png',createdAt:'2026-11-08T01:00:00Z'}]});await ui.flush();
 assert.equal(ui.all(n=>n.type==='img').length,1);assert.equal(ui.text().includes('正在读取 PNG 历史'),false);ui.unmount();
});
test('removing the displayed account closes its history and ignores its late PNG response',async()=>{
 const ui=await harness().ready();ui.click(ui.byLabel(email(B)+' 的历史'));await ui.flush();const history=ui.pending('history-get');
 ui.click(ui.byLabel('移除 '+email(B)));await ui.flush();await ui.respond('account-remove',settings({accounts:[account(A)]}));
 history.respond({images:[{id:'b-png',url:'/api/cpa-image?accountId=b&imageId=b-png',createdAt:'2026-11-08T01:00:00Z'}]});await ui.flush();
 assert.equal(ui.all(n=>n.type==='img').length,0);assert.equal(ui.all(n=>n.props.role==='dialog').length,0);ui.unmount();
});


const enabledB = models => settings({accounts:[account(A,{enabled:false,canRunProbe:false}),account(B,{enabled:true,canRunProbe:true,models})],
 preferences:{activeAccountId:B,plans:{}},fast:{available:true,enabled:false,providers:[provider(B)]}});
for(const directoryUpdated of [false,true])test('activation ACK refreshes newly supported current model even when the directory update is late: '+directoryUpdated,async()=>{
 const fresh='gpt-6-recovery',old='gpt-5-old',groups=[{id:'openai-codex',models:[{id:fresh}]},{id:provider(B),models:[{id:old}]}];
 const ui=await harness({currentModel:fresh,groups}).ready(settings({accounts:[account(A),account(B,{models:[old]})]}));
 ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 if(directoryUpdated)ui.setDirectory({groups:[...groups.slice(0,1),{id:provider(B),models:[{id:old},{id:fresh}]}]});
 await ui.respond('account-select',enabledB([old,fresh]));
 assert.deepEqual(ui.selected,[{provider:provider(B),model:fresh}]);assert.equal(ui.text().includes('请选择该账号支持的模型'),false);ui.unmount();
});
test('activation chooser uses ACK models and omits withdrawn stale catalog entries',async()=>{
 const ui=await harness({currentModel:'unsupported-model'}).ready();ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 await ui.respond('account-select',enabledB(['gpt-6-new']));const chooser=ui.byLabel(email(B)+' 的会话模型');
 assert.deepEqual(ui.all(n=>n.type==='option',chooser).map(n=>n.props.value),['','gpt-6-new']);assert.equal(ui.selected.length,0);ui.unmount();
});
for(const change of ['session','model'])test('unsupported pre-ACK model still preserves a newer '+change+' choice on refresh',async()=>{
 const ui=await harness({currentModel:'gpt-6-recovery',groups:[{id:provider(B),models:[{id:MODEL}]}]}).ready();
 ui.change(ui.byLabel('启用 '+email(B)),B);await ui.flush();
 if(change==='session')ui.setSession('session-new');else ui.setDirectory({current:{provider:'other',model:'new-explicit-model'}});
 await ui.respond('account-select',enabledB([MODEL,'gpt-6-recovery']));
 assert.equal(ui.selected.length,0);assert.match(ui.text(),change==='session'?/会话已切换/:/模型已由其它操作更改/);ui.unmount();
});

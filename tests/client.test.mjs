import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../lib/client-v022.js',import.meta.url),'utf8');
const snapshot=(extra={})=>({online:true,management:true,authorizationPending:false,accounts:[],models:['synthetic-model'],sync:{status:'ok',missing:[]},quotaStale:false,...extra});
const account=(label='Synthetic account')=>({label,status:'active',quota:{plan:'Synthetic',observedAt:new Date().toISOString(),windows:[{name:'primary',minutes:300,used:42,remaining:58}]}});

// A dependency-free hook/DOM/timer harness: all requests stay deferred and synthetic.
function harness({pill=false,visibility='visible',provider='openai-codex'}={}){
 const hooks=[],effects=[],timers=new Map(),listeners=new Map(),requests=[],opened=[],removed=[];
 let cursor=0,dirty=false,mounted=true,tree,component,props={},factory,now=0,timerId=0,afterUnmount=0,focused=0;
 const react={
  createElement:(type,props,...children)=>({type,props:props??{},children}),Fragment:'Fragment',
  useState(initial){
   const i=cursor++;
   if(!hooks[i]){
    const slot={value:typeof initial==='function'?initial():initial};
    slot.set=value=>{if(!mounted){afterUnmount++;return}const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;dirty=true}};
    hooks[i]=slot;
   }
   return [hooks[i].value,hooks[i].set];
  },
  useRef(initial){const i=cursor++;return hooks[i]??(hooks[i]={current:initial})},
  useEffect(create,deps){
   const i=cursor++,previous=hooks[i];
   if(!previous||!deps||deps.some((value,j)=>!Object.is(value,previous.deps[j]))){
    const slot={deps,create,cleanup:previous?.cleanup};hooks[i]=slot;effects.push(slot);
   }
  },
  useSyncExternalStore:(_subscribe,get)=>get(),
 };
 const document={
  visibilityState:visibility,querySelector:()=>true,
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn)},
  removeEventListener(name,fn){listeners.get(name)?.delete(fn)},
 };
 const context={
  window:{__ModuleLoader__:{load:x=>factory=x.factory},open:(...args)=>opened.push(args),focus:()=>focused++},document,console,
  setInterval(fn,ms){const id=++timerId;timers.set(id,{fn,ms,next:now+ms});return id},
  clearInterval:id=>timers.delete(id),
  fetch(url,options){
   assert.equal(url,'/api/cpa-settings');
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
   const body=options.body?JSON.parse(options.body):undefined;
   const request={action:body?.action??'get',body,options,pending:true,
    respond(data,ok=true){assert.equal(request.pending,true);request.pending=false;resolve({ok,json:async()=>data})},
    fail(message='synthetic-offline'){assert.equal(request.pending,true);request.pending=false;reject(Error(message))},
   };
   requests.push(request);return promise;
  },
 };
 vm.runInNewContext(source,context);
 const plugin=factory(name=>name==='react'?react:{Button:'Button',Tag:'Tag'}),registered=[];
 const ctx={slots:{inject:(_n,cb)=>cb(),register:(config,view)=>{registered.push({config,component:view});return()=>removed.push(config.id)}},inject:(_d,cb)=>cb(ctx),modelDirectories:{directoryFor:()=>({store:{subscribe:()=>()=>{},getSnapshot:()=>({current:{provider,model:'synthetic-model'}})}})}};
 const dispose=plugin.apply(ctx);
 const registeredView=registered[pill?1:0];component=registeredView.component;if(pill)props=registeredView.config.inject('synthetic-session');
 function render(){cursor=0;dirty=false;tree=component(props);for(const slot of effects.splice(0)){slot.cleanup?.();slot.cleanup=slot.create()}}
 async function flush(){for(let i=0;i<40;i++){await Promise.resolve();if(dirty&&mounted)render()}}
 function children(node){if(typeof node?.type==='function')return [node.type(node.props)];return node?.children??[]}
 function text(node=tree){if(node==null||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(text).join('');if(typeof node!=='object')return String(node);return children(node).map(text).join('')}
 function nodes(node=tree){if(!node||typeof node!=='object')return [];if(Array.isArray(node))return node.flatMap(nodes);return [node,...children(node).flatMap(nodes)]}
 function button(label){return nodes().find(node=>(node.type==='Button'||node.type==='button')&&text(node)===label)}
 function click(label){const found=button(label);assert.ok(found,'missing button '+label);assert.equal(!!found.props.disabled,false,'disabled button '+label);return found.props.onClick()}
 function pending(action='get'){const found=requests.find(x=>x.action===action&&x.pending);assert.ok(found,'missing pending '+action);return found}
 async function respond(action,data,ok=true){pending(action).respond(data,ok);await flush()}
 async function tick(ms){const target=now+ms;for(;;){const entry=[...timers].filter(([,t])=>t.next<=target).sort((a,b)=>a[1].next-b[1].next)[0];if(!entry)break;now=entry[1].next;entry[1].next+=entry[1].ms;entry[1].fn();await flush()}now=target;await flush()}
 async function visible(state){document.visibilityState=state;for(const fn of [...listeners.get('visibilitychange')??[]])fn();await flush()}
 function unmount(){mounted=false;for(const slot of hooks)slot?.cleanup?.();dispose()}
 function replayEffects(){for(const slot of hooks)if(slot?.create){slot.cleanup?.();slot.cleanup=slot.create()}}
 render();
 return {requests,opened,removed,registered,timers,listeners,document,flush,text,nodes,button,click,pending,respond,tick,visible,unmount,replayEffects,
  count:action=>requests.filter(x=>x.action===action).length,get afterUnmount(){return afterUnmount},get focused(){return focused},get tree(){return tree}};
}

async function ready(options){const ui=harness(options);await ui.respond('get',snapshot());return ui}
async function start(ui,url='https://synthetic.invalid/authorize/first'){
 const action=ui.click('添加 ChatGPT 账号');await ui.flush();await ui.respond('start',{url});await action;await ui.flush();
}
async function typeCallback(ui,value='http://localhost:1234/auth/callback?code=synthetic&state=synthetic'){
 const input=ui.nodes().find(x=>x.type==='input'&&x.props.placeholder.includes('/auth/callback'));
 assert.ok(input);input.props.onChange({target:{value}});await ui.flush();
}

test('settings and direct-model quota pill both register and dispose',()=>{
 const ui=harness({pill:true});
 assert.deepEqual(ui.registered.map(x=>x.config.name),['settings.section','conversation.input.right']);
 assert.equal(ui.tree.props.className,'cpaPill_root');ui.unmount();
 assert.deepEqual(ui.removed,['cpa-settings','cpa-usage']);
 const hidden=harness({pill:true,provider:'synthetic-other'});assert.equal(hidden.tree,null);assert.equal(hidden.requests.length,0);hidden.unmount();
});

test('Page reads on mount, polls every visible 60s, and immediately resumes without overlap',async()=>{
 const ui=harness();assert.equal(ui.count('get'),1);assert.equal(ui.button('刷新状态').props.disabled,false);
 assert.deepEqual([...ui.timers.values()].map(x=>x.ms),[60000]);
 await ui.respond('get',snapshot());await ui.tick(59999);assert.equal(ui.count('get'),1);
 await ui.tick(1);assert.equal(ui.count('get'),2);assert.equal(ui.button('刷新状态').props.disabled,false);
 await ui.tick(60000);await ui.visible('visible');assert.equal(ui.count('get'),2);
 await ui.visible('hidden');await ui.respond('get',snapshot());await ui.tick(120000);assert.equal(ui.count('get'),2);
 await ui.visible('visible');assert.equal(ui.count('get'),3);
 assert.ok(ui.requests.filter(x=>x.action==='get').every(x=>x.options.cache==='no-store'));
 ui.unmount();assert.equal(ui.timers.size,0);assert.equal(ui.listeners.get('visibilitychange').size,0);
});

test('hidden Page waits for visibility and hidden visibility events do not fetch',async()=>{
 const ui=harness({visibility:'hidden'});await ui.tick(120000);await ui.visible('hidden');assert.equal(ui.count('get'),0);
 await ui.visible('visible');assert.equal(ui.count('get'),1);ui.unmount();
});

test('manual refresh remains busy and serializes behind an older automatic read',async()=>{
 const ui=await ready();await ui.tick(60000);const old=ui.pending();
 const manual=ui.click('刷新状态');await ui.flush();assert.equal(ui.button('刷新状态').props.disabled,true);
 // A stale event handler also cannot launch a second action.
 ui.button('刷新状态').props.onClick();await ui.tick(60000);assert.equal(ui.count('get'),2);
 old.respond(snapshot({accounts:[account('obsolete')]}));await ui.flush();assert.equal(ui.count('get'),3);assert.doesNotMatch(ui.text(),/obsolete/);
 await ui.respond('get',snapshot({accounts:[account('fresh')]}));await manual;await ui.flush();
 assert.match(ui.text(),/fresh/);assert.equal(ui.button('刷新状态').props.disabled,false);ui.unmount();
});

test('automatic refresh failures preserve action messages, old data and usable buttons',async()=>{
 const ui=await ready();const sync=ui.click('立即同步模型');await ui.respond('sync',{status:'ok',added:['synthetic-model'],missing:[]});
 await ui.respond('get',snapshot({accounts:[account()]}));await sync;await ui.flush();assert.match(ui.text(),/同步完成，新增 1 个/);
 await ui.tick(60000);ui.pending().fail();await ui.flush();
 assert.match(ui.text(),/同步完成，新增 1 个/);assert.match(ui.text(),/状态刷新失败：synthetic-offline/);assert.match(ui.text(),/上次读取的旧数据/);
 assert.match(ui.text(),/Synthetic account/);assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);
 await ui.tick(60000);await ui.respond('get',snapshot());assert.doesNotMatch(ui.text(),/状态刷新失败/);assert.match(ui.text(),/同步完成，新增 1 个/);ui.unmount();
});

for(const fail of [false,true])test('cleanup ignores late initial GET '+(fail?'failure':'success'),async()=>{
 const ui=harness(),late=ui.pending(),listener=[...ui.listeners.get('visibilitychange')][0];ui.unmount();
 if(fail)late.fail();else late.respond(snapshot());await ui.flush();listener();await ui.tick(120000);
 assert.equal(ui.afterUnmount,0);assert.equal(ui.count('get'),1);assert.equal(ui.timers.size,0);assert.equal(ui.listeners.get('visibilitychange').size,0);
});

test('effect replay rejects the previous lifetime and serializes a fresh read',async()=>{
 const ui=harness(),old=ui.pending();ui.replayEffects();await ui.flush();assert.equal(ui.count('get'),1);
 old.respond(snapshot({accounts:[account('old-lifetime')]}));await ui.flush();assert.equal(ui.count('get'),2);assert.doesNotMatch(ui.text(),/old-lifetime/);
 await ui.respond('get',snapshot({accounts:[account('new-lifetime')]}));assert.match(ui.text(),/new-lifetime/);ui.unmount();assert.equal(ui.afterUnmount,0);
});

test('cancel clears all auth UI, ignores stale GET/status success, and permits a clean retry',async()=>{
 const ui=await ready();await start(ui);await typeCallback(ui);await ui.tick(2000);const oldStatus=ui.pending('status');
 await ui.visible('visible');const oldRead=ui.pending();
 const cancel=ui.click('取消授权');await ui.flush();assert.deepEqual(ui.pending('cancel').body,{action:'cancel'});
 assert.equal(ui.pending('cancel').options.method,'POST');
 await ui.respond('cancel',{status:'cancelled'});await cancel;await ui.flush();
 assert.doesNotMatch(ui.text(),/正在等待 ChatGPT 授权/);assert.equal(ui.nodes().some(x=>x.type==='a'),false);
 assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);assert.match(ui.text(),/授权已取消/);
 await start(ui,'https://synthetic.invalid/authorize/retry');
 assert.equal(ui.nodes().find(x=>x.type==='input').props.value,'');
 oldRead.respond(snapshot({authorizationPending:true,accounts:[account('obsolete')]}));oldStatus.respond({status:'ok'});await ui.flush();
 assert.doesNotMatch(ui.text(),/obsolete|授权成功/);assert.equal(ui.focused,0);assert.equal(ui.count('get'),2);
 assert.equal(ui.nodes().find(x=>x.type==='a').props.href,'https://synthetic.invalid/authorize/retry');
 await ui.tick(2000);await ui.respond('status',{status:'ok',focused:false});await ui.respond('get',snapshot({accounts:[account('new-account')]}));
 assert.match(ui.text(),/授权成功，账号和模型已刷新；系统未允许自动切回/);assert.match(ui.text(),/new-account/);assert.equal(ui.focused,1);
 assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);ui.unmount();
});

test('cancel can supersede a pending start and its late URL never opens',async()=>{
 const ui=await ready(),begin=ui.click('添加 ChatGPT 账号');await ui.flush();const old=ui.pending('start');
 assert.equal(ui.button('取消授权').props.disabled,false);const cancel=ui.click('取消授权');await ui.respond('cancel',{status:'cancelled'});await cancel;
 old.respond({url:'https://synthetic.invalid/obsolete'});await begin;await ui.flush();
 assert.equal(ui.opened.length,0);assert.match(ui.text(),/授权已取消/);assert.equal(ui.nodes().some(x=>x.type==='a'),false);
 await start(ui);assert.equal(ui.opened.length,1);ui.unmount();
});

test('cancel supersedes callback submission and ignores its late error',async()=>{
 const ui=await ready();await start(ui);await typeCallback(ui);const callback=ui.click('提交回调');await ui.flush();const old=ui.pending('callback');
 assert.match(old.body.redirectURL,/code=synthetic/);assert.equal(ui.button('刷新状态').props.disabled,true);assert.equal(ui.button('取消授权').props.disabled,false);
 const cancel=ui.click('取消授权');await ui.respond('cancel',{status:'cancelled'});await cancel;old.fail('obsolete-callback');await callback;await ui.flush();
 assert.match(ui.text(),/授权已取消/);assert.doesNotMatch(ui.text(),/obsolete-callback|回调已提交/);assert.equal(ui.button('刷新状态').props.disabled,false);
 await start(ui);assert.equal(ui.nodes().find(x=>x.type==='input').props.value,'');ui.unmount();
});

test('a retry invalidates completion work still waiting for an older GET',async()=>{
 const ui=await ready();await start(ui);await ui.visible('visible');const old=ui.pending();
 await ui.tick(2000);await ui.respond('status',{status:'ok'});assert.equal(ui.count('get'),2);
 const retry=ui.click('添加 ChatGPT 账号');await ui.respond('start',{url:'https://synthetic.invalid/new-attempt'});await retry;
 old.respond(snapshot({accounts:[account('obsolete-completion')]}));await ui.flush();
 assert.equal(ui.count('get'),2);assert.equal(ui.focused,0);assert.doesNotMatch(ui.text(),/obsolete-completion|授权成功/);
 assert.equal(ui.nodes().find(x=>x.type==='a').props.href,'https://synthetic.invalid/new-attempt');ui.unmount();
});

test('status polls never overlap and a failed attempt can retry',async()=>{
 const ui=await ready();await start(ui);await typeCallback(ui);await ui.tick(6000);assert.equal(ui.count('status'),1);
 ui.pending('status').fail('synthetic-status-error');await ui.flush();assert.match(ui.text(),/授权检查失败：synthetic-status-error/);
 assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);await start(ui);assert.equal(ui.nodes().find(x=>x.type==='input').props.value,'');
 await ui.tick(2000);await ui.respond('status',{status:'error'});assert.match(ui.text(),/授权未完成，请重试/);assert.equal(ui.nodes().some(x=>x.type==='a'),false);ui.unmount();
});

test('unsuccessful cancel remains retryable and backend cancelled status clears auth',async()=>{
 const ui=await ready();await start(ui);const cancel=ui.click('取消授权');await ui.respond('cancel',{status:'waiting'});await cancel;await ui.flush();
 assert.match(ui.text(),/取消授权未确认/);assert.equal(ui.button('取消授权').props.disabled,false);
 await ui.tick(2000);await ui.respond('status',{status:'cancelled'});assert.match(ui.text(),/授权已取消/);assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);ui.unmount();
});

test('completion refresh failure never claims account data was refreshed',async()=>{
 const ui=await ready();await start(ui);await ui.tick(2000);await ui.respond('status',{status:'ok'});ui.pending().fail();await ui.flush();
 assert.match(ui.text(),/授权成功，但状态刷新失败，请手动刷新/);assert.doesNotMatch(ui.text(),/账号和模型已刷新/);assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,false);ui.unmount();
});

for(const kind of ['start','callback','sync','cancel','status'])test('unmount ignores pending '+kind+' action and its side effects',async()=>{
 const ui=await ready();if(['callback','cancel','status'].includes(kind))await start(ui);
 let action;
 if(kind==='start')action=ui.click('添加 ChatGPT 账号');
 if(kind==='callback'){await typeCallback(ui);action=ui.click('提交回调')}
 if(kind==='sync')action=ui.click('立即同步模型');
 if(kind==='cancel')action=ui.click('取消授权');
 if(kind==='status')await ui.tick(2000);
 await ui.flush();const late=ui.pending(kind),count=ui.requests.length,opened=ui.opened.length;ui.unmount();
 late.respond(kind==='start'?{url:'https://synthetic.invalid/late'}:kind==='cancel'?{status:'cancelled'}:{status:'ok',added:[],missing:[]});
 await action;await ui.flush();assert.equal(ui.afterUnmount,0);assert.equal(ui.requests.length,count);assert.equal(ui.opened.length,opened);assert.equal(ui.focused,0);assert.equal(ui.timers.size,0);
});

for(const resumed of [false,true])test('snapshot completion does not stop '+(resumed?'resumed':'locally started')+' authorization watching',async()=>{
 const ui=harness();await ui.respond('get',snapshot({authorizationPending:resumed}));if(!resumed)await start(ui);
 await ui.visible('visible');await ui.respond('get',snapshot({authorizationPending:false}));
 assert.match(ui.text(),/正在等待 ChatGPT 授权/);assert.equal(ui.button('添加 ChatGPT 账号').props.disabled,true);
 await ui.tick(2000);await ui.respond('status',{status:'ok'});await ui.respond('get',snapshot());
 assert.match(ui.text(),/授权成功，账号和模型已刷新/);assert.doesNotMatch(ui.text(),/正在等待 ChatGPT 授权/);assert.equal(ui.focused,1);ui.unmount();
});

test('unmount also ignores authorization completion awaiting its follow-up GET',async()=>{
 const ui=await ready();await start(ui);await ui.tick(2000);await ui.respond('status',{status:'ok'});const late=ui.pending();
 ui.unmount();late.respond(snapshot());await ui.flush();assert.equal(ui.afterUnmount,0);assert.equal(ui.focused,0);assert.equal(ui.timers.size,0);
});

test('quotaStale without an error still labels existing observations as old',async()=>{
 const data=snapshot({accounts:[account()],quotaStale:true});
 const page=harness();await page.respond('get',data);assert.match(page.text(),/当前额度为旧观测/);page.unmount();
 const pill=harness({pill:true});await pill.respond('get',data);assert.match(pill.text(),/42% \*/);
 pill.nodes().find(x=>x.type==='button').props.onClick();await pill.flush();assert.match(pill.text(),/当前额度为旧观测/);pill.unmount();
});

test('Page and pill distinguish failed quota refresh from old observations',async()=>{
 const data=snapshot({accounts:[account()],quotaError:'upstream-http-503',quotaStale:true});
 const page=harness();await page.respond('get',data);assert.match(page.text(),/额度刷新失败：upstream-http-503/);assert.match(page.text(),/旧观测，并非本次刷新结果/);assert.match(page.text(),/已用 42%/);page.unmount();
 const pill=harness({pill:true});await pill.respond('get',data);assert.match(pill.text(),/42% \*/);
 pill.nodes().find(x=>x.type==='button').props.onClick();await pill.flush();
 assert.match(pill.text(),/额度刷新失败：upstream-http-503/);assert.match(pill.text(),/旧观测/);assert.match(pill.text(),/最近观测/);pill.unmount();
});

test('pill also marks a previously observed quota stale after a network failure',async()=>{
 const ui=harness({pill:true});await ui.respond('get',snapshot({accounts:[account()]}));assert.doesNotMatch(ui.text(),/\*/);
 await ui.tick(60000);ui.pending().fail();await ui.flush();assert.match(ui.text(),/42% \*/);
 ui.nodes().find(x=>x.type==='button').props.onClick();await ui.flush();assert.match(ui.text(),/刷新失败/);assert.match(ui.text(),/旧观测/);ui.unmount();
});

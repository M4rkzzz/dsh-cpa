import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../lib/client-v024.js',import.meta.url),'utf8');
const snapshot=(extra={})=>({online:true,management:true,authorizationPending:false,accounts:[],models:['synthetic-model'],sync:{status:'ok',missing:[]},quotaStale:false,...extra});
const account=(label='Synthetic account')=>({label,status:'active',quota:{plan:'Synthetic',observedAt:new Date().toISOString(),windows:[{name:'primary',minutes:300,used:42,remaining:58}]}});

const activitySnapshot=({logs={},pelican={}}={})=>({
 logs:{available:true,limit:200,since:'2026-11-08T00:00:00Z',entries:[],...logs,summary:{total:0,running:0,success:0,error:0,cancelled:0,inputTokens:0,outputTokens:0,avgTtftMs:null,avgDurationMs:null,avgTps:null,avgCacheHitRate:null,samples:{ttft:0,tps:0,cacheHitRate:0},...logs.summary}},
 pelican:{available:true,enabled:false,intervalMinutes:60,model:null,prompt:'生成一张鹈鹕骑自行车的SVG',running:false,nextRunAt:null,lastResult:null,...pelican},
});
const logEntry=(extra={})=>({id:'synthetic-request',source:'conversation',startedAt:'2026-11-08T00:01:00Z',endedAt:'2026-11-08T00:01:01Z',model:'synthetic-model',status:'success',httpStatus:null,errorCode:null,cacheHitRate:null,inputTokens:null,outputTokens:null,ttftMs:null,durationMs:null,tps:null,...extra});

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
  window:{__ModuleLoader__:{load:x=>factory=x.factory},open:(...args)=>opened.push(args),focus:()=>focused++},document,console,URL,
  setInterval(fn,ms){const id=++timerId;timers.set(id,{fn,ms,next:now+ms});return id},
  clearInterval:id=>timers.delete(id),
  fetch(url,options){
   assert.ok(['/api/cpa-settings','/api/cpa-activity'].includes(url),'unexpected mock URL '+url);
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
   const body=options.body?JSON.parse(options.body):undefined;
   const request={url,action:body?.action??(url==='/api/cpa-activity'?'activity-get':'get'),body,options,pending:true,
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
 const input=ui.nodes().find(x=>x.type==='input'&&x.props.placeholder?.includes('/auth/callback'));
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
 assert.deepEqual([...ui.timers.values()].map(x=>x.ms).sort((a,b)=>a-b),[3000,60000]);
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

async function activityReady(data=activitySnapshot()){
 const ui=await ready();await ui.respond('activity-get',data);return ui;
}
function control(ui,label){const found=ui.nodes().find(x=>x.props?.['aria-label']===label);assert.ok(found,'missing control '+label);return found}
async function change(ui,label,value){const found=control(ui,label);assert.equal(!!found.props.disabled,false);found.props.onChange({target:{value,checked:value}});await ui.flush()}

test('activity polls every visible 3s independently, never overlaps, and never enables a task on mount',async()=>{
 const ui=await ready();assert.equal(ui.count('activity-get'),1);assert.equal(ui.requests.some(x=>x.options.method==='POST'),false);
 await ui.respond('activity-get',activitySnapshot());assert.equal(control(ui,'启用鹈鹕定时测试').props.checked,false);
 await ui.tick(2999);assert.equal(ui.count('activity-get'),1);await ui.tick(1);assert.equal(ui.count('activity-get'),2);
 assert.equal(ui.button('清空请求日志').props.disabled,false);assert.equal(ui.button('刷新状态').props.disabled,false);
 await ui.tick(9000);assert.equal(ui.count('get'),1);await ui.visible('visible');assert.equal(ui.count('activity-get'),2);
 await ui.visible('hidden');await ui.respond('activity-get',activitySnapshot());await ui.tick(9000);assert.equal(ui.count('activity-get'),2);
 await ui.visible('visible');assert.equal(ui.count('activity-get'),3);assert.equal(ui.count('get'),2); // The original Page also refreshes on visibility, not on the 3s timer.
 assert.ok(ui.requests.filter(x=>x.action==='activity-get').every(x=>x.url==='/api/cpa-activity'&&x.options.cache==='no-store'));
 assert.equal(ui.count('pelican-run'),0);assert.equal(ui.count('pelican-configure'),0);ui.unmount();
});

test('activity errors are independent of original authorization messages and busy state',async()=>{
 const ui=await activityReady();await start(ui);await ui.tick(3000);ui.pending('activity-get').fail('synthetic-activity-offline');await ui.flush();
 assert.match(ui.text(),/请求活动刷新失败：synthetic-activity-offline/);assert.match(ui.text(),/正在打开浏览器，完成登录后会自动检测/);
 assert.equal(ui.button('刷新状态').props.disabled,false);assert.equal(ui.button('清空请求日志').props.disabled,false);
 await ui.tick(3000);await ui.respond('activity-get',activitySnapshot());assert.doesNotMatch(ui.text(),/请求活动刷新失败/);assert.match(ui.text(),/正在打开浏览器/);ui.unmount();
});

test('activity commands do not take Page busy and apply their returned snapshots without quota reads',async()=>{
 const ui=await activityReady(),clear=ui.click('清空请求日志');await ui.flush();
 assert.equal(ui.button('清空请求日志').props.disabled,true);assert.equal(ui.button('刷新状态').props.disabled,false);
 const manual=ui.click('刷新状态');await ui.flush();assert.equal(ui.button('刷新状态').props.disabled,true);
 const request=ui.pending('logs-clear');assert.equal(request.url,'/api/cpa-activity');assert.equal(request.options.method,'POST');assert.deepEqual(request.body,{action:'logs-clear'});
 await ui.respond('logs-clear',activitySnapshot());await clear;assert.equal(ui.button('刷新状态').props.disabled,true);assert.equal(ui.button('清空请求日志').props.disabled,false);
 assert.equal(ui.count('get'),2);assert.equal(ui.count('activity-get'),1);await ui.respond('get',snapshot());await manual;ui.unmount();
});

test('late activity GET cannot restore logs after a successful clear',async()=>{
 const old=activitySnapshot({logs:{entries:[logEntry({model:'obsolete-log-model'})],summary:{total:9,success:9}}}),ui=await activityReady(old);
 assert.match(ui.text(),/obsolete-log-model/);await ui.tick(3000);const late=ui.pending('activity-get');
 const clear=ui.click('清空请求日志');await ui.respond('logs-clear',activitySnapshot({logs:{since:'2026-11-08T00:05:00Z'}}));await clear;
 late.respond(old);await ui.flush();assert.doesNotMatch(ui.text(),/obsolete-log-model/);assert.match(ui.text(),/请求日志与累计统计已清空/);
 await ui.tick(3000);assert.equal(ui.count('activity-get'),3);ui.unmount();
});

test('activity polling and log clearing preserve unsaved schedule edits',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试模型','synthetic-model');await change(ui,'鹈鹕测试间隔','17');await change(ui,'启用鹈鹕定时测试',true);
 assert.equal(ui.requests.some(x=>x.options.method==='POST'),false);await ui.tick(3000);await ui.respond('activity-get',activitySnapshot());
 const clear=ui.click('清空请求日志');await ui.respond('logs-clear',activitySnapshot());await clear;
 assert.equal(control(ui,'鹈鹕测试模型').props.value,'synthetic-model');assert.equal(control(ui,'鹈鹕测试间隔').props.value,'17');assert.equal(control(ui,'启用鹈鹕定时测试').props.checked,true);
 assert.match(ui.text(),/计划设置尚未保存/);assert.equal(ui.count('pelican-run'),0);ui.unmount();
});

test('schedule enable is explicit, sends an integer interval, and does not run immediately',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试模型','synthetic-model');await change(ui,'鹈鹕测试间隔','17');await change(ui,'启用鹈鹕定时测试',true);
 const save=ui.click('保存测试计划');await ui.flush();assert.deepEqual(ui.pending('pelican-configure').body,{action:'pelican-configure',enabled:true,intervalMinutes:17,model:'synthetic-model'});
 assert.equal(control(ui,'鹈鹕测试间隔').props.disabled,true);assert.equal(ui.count('pelican-run'),0);
 await ui.respond('pelican-configure',activitySnapshot({pelican:{enabled:true,intervalMinutes:17,model:'synthetic-model',nextRunAt:'2026-11-08T00:17:00Z'}}));await save;
 assert.match(ui.text(),/首次测试将在设定间隔后运行，不会立即调用模型/);assert.match(ui.text(),/当前计划：已启用/);assert.doesNotMatch(ui.text(),/计划设置尚未保存/);assert.equal(ui.count('pelican-run'),0);ui.unmount();
});

for(const interval of ['','0','-1','1.5','10081','not-a-number'])test('schedule rejects invalid interval '+JSON.stringify(interval)+' without POST',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试模型','synthetic-model');await change(ui,'启用鹈鹕定时测试',true);await change(ui,'鹈鹕测试间隔',interval);
 await ui.click('保存测试计划');await ui.flush();assert.match(ui.text(),/间隔必须为 1–10080 的整数分钟/);assert.equal(ui.count('pelican-configure'),0);ui.unmount();
});

test('disabled schedule save ignores invalid drafts and sends only enabled false',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试间隔','invalid');const save=ui.click('保存测试计划');
 assert.deepEqual(ui.pending('pelican-configure').body,{action:'pelican-configure',enabled:false});
 await ui.respond('pelican-configure',activitySnapshot());await save;assert.match(ui.text(),/计划已关闭，当前测试也已取消/);ui.unmount();
});

test('closing a schedule stays available without a valid model or execution capability',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{available:false,enabled:true,model:'removed-model',running:true}}));
 assert.equal(ui.button('立即测试一次').props.disabled,true);assert.equal(ui.button('关闭定时').props.disabled,false);
 const close=ui.click('关闭定时');assert.deepEqual(ui.pending('pelican-configure').body,{action:'pelican-configure',enabled:false});
 await ui.respond('pelican-configure',activitySnapshot({pelican:{available:false,model:'removed-model'}}));await close;
 assert.match(ui.text(),/当前计划：关闭；当前测试：未运行/);ui.unmount();
});

test('run once uses only the chosen model and cancel does not disable the schedule',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试模型','synthetic-model');const run=ui.click('立即测试一次');
 assert.deepEqual(ui.pending('pelican-run').body,{action:'pelican-run',model:'synthetic-model'});
 await ui.respond('pelican-run',activitySnapshot({pelican:{running:true}}));await run;
 assert.equal(ui.count('pelican-configure'),0);assert.equal(ui.button('立即测试一次').props.disabled,true);assert.equal(ui.button('取消当前测试').props.disabled,false);assert.equal(ui.button('刷新状态').props.disabled,false);
 const cancel=ui.click('取消当前测试');assert.deepEqual(ui.pending('pelican-cancel').body,{action:'pelican-cancel'});
 await ui.respond('pelican-cancel',activitySnapshot({pelican:{enabled:true,model:'synthetic-model',running:false,nextRunAt:'2026-11-08T01:00:00Z'}}));await cancel;
 assert.match(ui.text(),/当前计划：已启用/);assert.match(ui.text(),/如需停止后续测试，请同时关闭计划/);assert.equal(ui.count('pelican-configure'),0);ui.unmount();
});

test('unknown metrics stay em dashes, success never invents HTTP 200, and tables scroll horizontally',async()=>{
 const ui=await activityReady(activitySnapshot({logs:{entries:[logEntry(),logEntry({id:'known-metrics',source:'pelican',status:'error',httpStatus:503,errorCode:'synthetic-error',cacheHitRate:0.25,inputTokens:0,outputTokens:5,ttftMs:0,durationMs:1200,tps:1.25})],summary:{total:2,success:1,error:1,avgTps:1.25,avgTtftMs:0,avgCacheHitRate:0.25,samples:{ttft:1,tps:1,cacheHitRate:1}}}}));
 const body=ui.nodes().find(x=>x.type==='tbody'),rows=body.children;
 assert.equal(ui.text(rows[0].children[4]),'成功');for(const index of [5,6,7,8,9,10,11])assert.equal(ui.text(rows[0].children[index]),'—');
 assert.equal(ui.text(rows[1].children[5]),'503');assert.equal(ui.text(rows[1].children[6]),'25%');assert.equal(ui.text(rows[1].children[7]),'0');assert.equal(ui.text(rows[1].children[9]),'0 ms');assert.equal(ui.text(rows[1].children[11]),'1.25 token/s');
 assert.match(ui.text(),/宿主未提供该指标/);assert.match(ui.text(),/已知样本：TTFT 1；TPS 1；缓存命中率 1/);
 assert.equal(control(ui,'请求日志表格，可横向滚动').props.style.overflowX,'auto');assert.ok(ui.nodes().find(x=>x.type==='table').props.style.minWidth>=1000);ui.unmount();
});

test('SVG is inert text and no HTML, iframe, blob, download or storage path is introduced',async()=>{
 const svg='<svg onload="throw 1"><script>syntheticAttack()</script><foreignObject><img src=x onerror=syntheticAttack()></foreignObject></svg>';
 const ui=await activityReady(activitySnapshot({pelican:{lastResult:{status:'success',model:'synthetic-model',startedAt:'2026-11-08T00:00:00Z',endedAt:'2026-11-08T00:00:01Z',svg,errorCode:null}}}));
 const pre=control(ui,'最近 SVG 文本');assert.equal(pre.type,'pre');assert.equal(pre.children[0],svg);
 assert.equal(ui.nodes().some(x=>['svg','img','iframe','script','object','embed'].includes(x.type)),false);
 assert.equal(ui.nodes().some(x=>Object.hasOwn(x.props,'dangerouslySetInnerHTML')||Object.hasOwn(x.props,'download')),false);
 assert.doesNotMatch(source,/localStorage|sessionStorage|createObjectURL|new Blob|dangerouslySetInnerHTML/);assert.match(ui.text(),/不保存文件、下载或浏览器持久缓存/);ui.unmount();
});

test('activity action errors and drafts survive a successful background refresh',async()=>{
 const ui=await activityReady();await change(ui,'鹈鹕测试模型','synthetic-model');await change(ui,'启用鹈鹕定时测试',true);
 const save=ui.click('保存测试计划');await ui.respond('pelican-configure',{error:'synthetic-config-error'},false);await save;assert.match(ui.text(),/操作失败：synthetic-config-error/);
 await ui.tick(3000);await ui.respond('activity-get',activitySnapshot());assert.match(ui.text(),/操作失败：synthetic-config-error/);assert.equal(control(ui,'启用鹈鹕定时测试').props.checked,true);assert.match(ui.text(),/计划设置尚未保存/);ui.unmount();
});

for(const failed of [false,true])test('activity cleanup ignores late GET '+(failed?'failure':'success'),async()=>{
 const ui=harness(),late=ui.pending('activity-get'),listeners=[...ui.listeners.get('visibilitychange')];ui.unmount();
 if(failed)late.fail();else late.respond(activitySnapshot());await ui.flush();for(const listener of listeners)listener();await ui.tick(9000);
 assert.equal(ui.afterUnmount,0);assert.equal(ui.count('activity-get'),1);assert.equal(ui.timers.size,0);assert.equal(ui.listeners.get('visibilitychange').size,0);
});

test('activity effect replay serializes a new lifetime and ignores old data',async()=>{
 const ui=harness(),late=ui.pending('activity-get');ui.replayEffects();await ui.flush();assert.equal(ui.count('activity-get'),1);
 late.respond(activitySnapshot({logs:{entries:[logEntry({model:'old-activity-lifetime'})]}}));await ui.flush();assert.equal(ui.count('activity-get'),2);assert.doesNotMatch(ui.text(),/old-activity-lifetime/);
 await ui.respond('activity-get',activitySnapshot({logs:{entries:[logEntry({model:'new-activity-lifetime'})]}}));assert.match(ui.text(),/new-activity-lifetime/);ui.unmount();
});

for(const [label,action]of [['清空请求日志','logs-clear'],['保存测试计划','pelican-configure'],['立即测试一次','pelican-run'],['取消当前测试','pelican-cancel']])test('activity unmount ignores pending '+action+' response',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model',running:action==='pelican-cancel'}})),operation=ui.click(label),late=ui.pending(action),count=ui.requests.length;
 ui.unmount();late.respond(activitySnapshot());await operation;await ui.flush();assert.equal(ui.afterUnmount,0);assert.equal(ui.requests.length,count);assert.equal(ui.timers.size,0);
});

for(const [label,fast]of [['missing',undefined],['unsupported',{available:false,enabled:false,reason:'host-fast-unsupported'}],['unrecognized future capability',{available:true,enabled:true}]])test('Fast stays explicitly disabled for '+label+' and sits immediately left of weekly quota',async()=>{
 const a=account();a.quota.windows.push({name:'weekly',minutes:10080,used:20,remaining:80});
 const ui=harness({pill:true});await ui.respond('get',snapshot({accounts:[a],fast}));const toggle=ui.button('Fast');
 assert.equal(toggle.props.disabled,true);assert.equal(toggle.props.role,'switch');assert.equal(toggle.props['aria-checked'],false);assert.equal(toggle.props.onClick,undefined);
 assert.match(toggle.props.title,/当前 DSH 未提供 Fast \/ service_tier 接口/);assert.match(toggle.props['aria-label'],/Fast 不可用/);
 const controls=ui.tree.children.filter(x=>x?.type==='button'),index=controls.indexOf(toggle);assert.equal(ui.text(controls[index+1]),'周 20%');assert.match(ui.text(controls[0]),/5小时 42%/);
 for(const button of controls)assert.equal(button.children.some(x=>x?.type==='button'),false);
 controls[index+1].props.onClick();await ui.flush();assert.ok(ui.nodes().some(x=>x.props.className==='cpaPill_panel'));
 ui.nodes().find(x=>x.type==='button'&&x.props.title==='查看 CPA 额度').props.onClick();await ui.flush();assert.equal(ui.nodes().some(x=>x.props.className==='cpaPill_panel'),false);
 assert.equal(ui.requests.some(x=>x.options.method==='POST'),false);ui.unmount();
});

test('unknown weekly quota retains a placeholder immediately after disabled Fast',async()=>{
 const ui=harness({pill:true});await ui.respond('get',snapshot());const controls=ui.tree.children.filter(x=>x?.type==='button'),toggle=ui.button('Fast');
 assert.equal(toggle.props.disabled,true);assert.equal(ui.text(controls[controls.indexOf(toggle)+1]),'周 —');assert.match(toggle.props.title,/未提供 Fast/);assert.equal(ui.requests.length,1);ui.unmount();
});

const pricingMetadata={currency:'USD',basis:'OpenAI Standard API',checkedAt:'2026-11-08',sources:['https://openai.com/api/pricing/','https://platform.openai.com/docs/pricing']};

test('USD estimates distinguish known amounts, cache billing upper bounds, and incomplete coverage',async()=>{
 const entries=[logEntry({id:'estimated',estimatedCostUsd:0.01,costBasis:'estimate'}),logEntry({id:'upper',estimatedCostUsd:0.02,costBasis:'upper-bound'}),logEntry({id:'free-known',estimatedCostUsd:0,costBasis:'estimate'}),logEntry({id:'unknown',estimatedCostUsd:null,costBasis:'unknown'}),logEntry({id:'missing'})];
 const ui=await activityReady(activitySnapshot({logs:{entries,pricing:pricingMetadata,summary:{total:5,estimatedCostUsd:0.03,pricedRequests:3,unpricedRequests:2,upperBoundRequests:1}}}));
 const rows=ui.nodes().find(x=>x.type==='tbody').children;
 assert.deepEqual(rows.map(row=>ui.text(row.children[12])),['≈ $0.01','≤ $0.02（缓存计费上限）','≈ $0.00','—','—']);
 assert.ok(ui.nodes().some(x=>x.type==='th'&&ui.text(x)==='估算 USD'));
 assert.match(ui.text(control(ui,'已知请求估算 USD')),/≤ \$0\.03（含缓存计费上限）/);assert.match(ui.text(control(ui,'美元估算覆盖')),/已估算 3 \/ 5 个请求；未知 2；缓存计费上限 1/);
 assert.match(ui.text(),/按 OpenAI 标准 API 价格折算，不是 ChatGPT 订阅实际账单；不含 Fast 等特殊档位/);
 assert.match(ui.text(),/金额仅含已知请求，未知不代表零费用，也不能视作完整账单/);assert.match(ui.text(),/价目表核对日期：2026-11-08/);ui.unmount();
});

test('all-unpriced requests never show a complete zero dollar bill',async()=>{
 const ui=await activityReady(activitySnapshot({logs:{entries:[logEntry({estimatedCostUsd:0,costBasis:'unknown'})],summary:{total:3,estimatedCostUsd:0,pricedRequests:0,unpricedRequests:3,upperBoundRequests:0}}}));
 const card=control(ui,'已知请求估算 USD');assert.equal(ui.text(card.children[1]),'—');assert.doesNotMatch(ui.text(card),/\$0/);
 assert.match(ui.text(control(ui,'美元估算覆盖')),/已估算 0 \/ 3 个请求；未知 3/);assert.equal(ui.text(ui.nodes().find(x=>x.type==='tbody').children[0].children[12]),'—');ui.unmount();
});

test('missing pricing fields remain unknown without inventing metadata or costs',async()=>{
 const ui=await activityReady(activitySnapshot({logs:{entries:[logEntry()],summary:{total:2}}}));
 assert.equal(ui.text(control(ui,'已知请求估算 USD').children[1]),'—');assert.match(ui.text(control(ui,'美元估算覆盖')),/已估算 — \/ 2 个请求；未知 —；缓存计费上限 —/);
 assert.match(ui.text(),/价目表核对日期：—/);assert.match(ui.text(),/官方价目表来源：—/);assert.equal(ui.nodes().some(x=>x.type==='a'),false);ui.unmount();
});

test('zero requests can show zero USD while known zero plus unknown requests stays explicitly partial',async()=>{
 const empty=await activityReady();assert.equal(empty.text(control(empty,'已知请求估算 USD').children[1]),'$0.00（无请求）');assert.match(empty.text(control(empty,'美元估算覆盖')),/已估算 0 \/ 0 个请求；未知 0/);empty.unmount();
 const partial=await activityReady(activitySnapshot({logs:{summary:{total:3,estimatedCostUsd:0,pricedRequests:1,unpricedRequests:2,upperBoundRequests:0}}}));
 assert.equal(partial.text(control(partial,'已知请求估算 USD').children[1]),'≈ $0.00');assert.match(partial.text(control(partial,'美元估算覆盖')),/未知 2/);assert.match(partial.text(),/金额仅含已知请求/);partial.unmount();
});

test('invalid USD values and unknown cost bases never coerce to zero',async()=>{
 const entries=[null,undefined,'0',false,-1,NaN,Infinity].map((value,i)=>logEntry({id:'invalid-'+i,estimatedCostUsd:value,costBasis:'estimate'}));
 entries.push(logEntry({id:'missing-basis',estimatedCostUsd:1}),logEntry({id:'bad-basis',estimatedCostUsd:1,costBasis:'unsupported'}));
 const ui=await activityReady(activitySnapshot({logs:{entries,summary:{total:entries.length,estimatedCostUsd:0,pricedRequests:0,unpricedRequests:entries.length,upperBoundRequests:0}}}));
 assert.ok(ui.nodes().find(x=>x.type==='tbody').children.every(row=>ui.text(row.children[12])==='—'));ui.unmount();
});

test('small positive USD estimates do not round down to an apparent zero',async()=>{
 const ui=await activityReady(activitySnapshot({logs:{entries:[logEntry({estimatedCostUsd:1e-10,costBasis:'estimate'})],summary:{total:1,estimatedCostUsd:1e-10,pricedRequests:1,unpricedRequests:0,upperBoundRequests:0}}}));
 assert.equal(ui.text(ui.nodes().find(x=>x.type==='tbody').children[0].children[12]),'≈ $1.00e-10');assert.match(ui.text(control(ui,'已知请求估算 USD')),/\$1\.00e-10/);ui.unmount();
});

test('pricing references allow only credential-free official HTTP(S) hosts and deduplicate links',async()=>{
 const trusted=['https://openai.com/api/pricing/','http://www.openai.com/api/pricing/','https://platform.openai.com/docs/pricing','https://developers.openai.com/api/docs/pricing'];
 const hostile=['javascript:syntheticAttack()','data:text/html,<script>syntheticAttack()</script>','file:///synthetic','//openai.com/api/pricing/','https://openai.com.evil.invalid/','https://evilopenai.com/','https://openai.com@evil.invalid/','https://evil.invalid@openai.com/','https://user:secret@platform.openai.com/docs/pricing','https://openai.com:8443/api/pricing/','https://openai.com./api/pricing/',null,42,{}];
 const ui=await activityReady(activitySnapshot({logs:{pricing:{...pricingMetadata,sources:[...trusted,...hostile,trusted[0]]}}}));
 const links=ui.nodes().filter(x=>x.type==='a');assert.deepEqual(links.map(x=>x.props.href),trusted);assert.ok(links.every(x=>x.props.target==='_blank'&&x.props.rel==='noopener noreferrer'));assert.equal(ui.requests.length,2);ui.unmount();
});

test('malformed pricing metadata cannot create arbitrary links or markup',async()=>{
 const ui=await activityReady(activitySnapshot({logs:{pricing:{currency:'USD',checkedAt:'<svg onload=syntheticAttack()>',sources:{href:'javascript:syntheticAttack()'}}}}));
 assert.match(ui.text(),/价目表核对日期：—/);assert.equal(ui.nodes().some(x=>x.type==='a'||x.type==='svg'),false);ui.unmount();
});


for(const [model,amount]of [['synthetic-cache-write-ttl-unknown',0.024],['synthetic-cache-read-unknown',0.006]])test('generic cache billing upper bound wording covers '+model,async()=>{
 const ui=await activityReady(activitySnapshot({logs:{entries:[logEntry({model,estimatedCostUsd:amount,costBasis:'upper-bound'})],summary:{total:1,estimatedCostUsd:amount,pricedRequests:1,unpricedRequests:0,upperBoundRequests:1}}}));
 const row=ui.nodes().find(x=>x.type==='tbody').children[0];assert.equal(ui.text(row.children[12]),'≤ $'+amount+'（缓存计费上限）');
 assert.match(ui.text(control(ui,'已知请求估算 USD')),/≤ .*（含缓存计费上限）/);assert.match(ui.text(control(ui,'美元估算覆盖')),/缓存计费上限 1/);
 assert.match(ui.text(),/缓存细节不足，按较高标准单价估算的缓存计费上限/);assert.doesNotMatch(ui.text(),/未缓存上限|按未缓存输入/);
 assert.doesNotMatch(source,/未缓存上限|按未缓存输入/);ui.unmount();
});

for(const kind of ['run','configure'])for(const outcome of ['success','error'])for(const order of ['old-first','stop-first'])test('stop preempts slow '+kind+' and ignores '+outcome+' ('+order+')',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model'}}));if(kind==='configure')await change(ui,'启用鹈鹕定时测试',true);
 const oldOperation=ui.click(kind==='run'?'立即测试一次':'保存测试计划');await ui.flush();const old=ui.requests.at(-1),stopLabel=kind==='run'?'取消当前测试':'关闭定时';
 assert.equal(ui.button(stopLabel).props.disabled,false);if(kind==='run')assert.match(ui.text(),/当前测试：未运行/);
 const staleStopHandler=ui.button(stopLabel).props.onClick,count=ui.requests.length,stopOperation=ui.click(stopLabel);
 staleStopHandler();await ui.flush();assert.equal(ui.requests.length,count+1);const stop=ui.requests.at(-1);
 assert.deepEqual(stop.body,kind==='run'?{action:'pelican-cancel'}:{action:'pelican-configure',enabled:false});
 assert.equal(ui.button('关闭定时').props.disabled,true);assert.equal(ui.button('取消当前测试').props.disabled,true);assert.equal(ui.button('刷新状态').props.disabled,false);
 const settleOld=()=>outcome==='success'?old.respond(activitySnapshot({logs:{entries:[logEntry({model:'obsolete-stop-response'})]},pelican:{enabled:true,running:true,model:'obsolete-model'}})):old.fail('obsolete-stop-error');
 if(order==='old-first'){
  settleOld();await oldOperation;await ui.flush();assert.equal(ui.button('清空请求日志').props.disabled,true);assert.equal(ui.button('关闭定时').props.disabled,true);
  assert.doesNotMatch(ui.text(),/obsolete-stop|已请求立即测试一次|计划已保存；/);
 }
 stop.respond(activitySnapshot({pelican:{model:'synthetic-model'}}));await stopOperation;await ui.flush();
 if(order==='stop-first'){
  await change(ui,'鹈鹕测试间隔','23');settleOld();await oldOperation;await ui.flush();
  assert.equal(control(ui,'鹈鹕测试间隔').props.value,'23');assert.match(ui.text(),/计划设置尚未保存/);
 }
 assert.equal(control(ui,'启用鹈鹕定时测试').props.checked,false);assert.match(ui.text(),/当前计划：关闭；当前测试：未运行/);
 assert.match(ui.text(),kind==='run'?/已请求取消当前测试/:/计划已关闭，当前测试也已取消/);assert.doesNotMatch(ui.text(),/obsolete-stop|已请求立即测试一次|计划已保存；/);
 assert.equal(ui.button('清空请求日志').props.disabled,false);ui.unmount();
});

test('only stop actions can preempt and an old finally cannot unlock a newer run',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model'}}));
 const handlers=['清空请求日志','立即测试一次','保存测试计划'].map(label=>ui.button(label).props.onClick);
 const oldOperation=ui.click('立即测试一次'),old=ui.pending('pelican-run');await ui.flush();const count=ui.requests.length;
 for(const handler of handlers)handler();await ui.flush();assert.equal(ui.requests.length,count);
 const staleDisable=ui.button('关闭定时').props.onClick,stopOperation=ui.click('取消当前测试');staleDisable();for(const handler of handlers)handler();await ui.flush();assert.equal(ui.requests.length,count+1);
 assert.equal(ui.count('logs-clear'),0);assert.equal(ui.count('pelican-configure'),0);
 await ui.respond('pelican-cancel',activitySnapshot({pelican:{model:'synthetic-model'}}));await stopOperation;
 const nextOperation=ui.click('立即测试一次');await ui.flush();const next=ui.requests.at(-1);assert.equal(ui.count('pelican-run'),2);
 old.respond(activitySnapshot({pelican:{running:true,model:'obsolete-model'}}));await oldOperation;await ui.flush();
 assert.equal(ui.button('立即测试一次').props.disabled,true);assert.equal(ui.button('清空请求日志').props.disabled,true);assert.equal(ui.button('取消当前测试').props.disabled,false);assert.doesNotMatch(ui.text(),/obsolete-model|已请求立即测试一次/);
 next.respond(activitySnapshot({pelican:{model:'synthetic-model',running:true}}));await nextOperation;await ui.flush();assert.equal(ui.button('清空请求日志').props.disabled,false);ui.unmount();
});

test('failed stop remains retryable and its error cannot be overwritten by the superseded run',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model'}})),oldOperation=ui.click('立即测试一次');await ui.flush();const old=ui.pending('pelican-run');
 const stopOperation=ui.click('关闭定时');await ui.respond('pelican-configure',{error:'synthetic-stop-error'},false);await stopOperation;
 assert.equal(ui.button('关闭定时').props.disabled,false);old.respond(activitySnapshot({pelican:{enabled:true,running:true,model:'obsolete-model'}}));await oldOperation;await ui.flush();
 assert.match(ui.text(),/操作失败：synthetic-stop-error/);assert.doesNotMatch(ui.text(),/已请求立即测试一次|obsolete-model/);
 const retry=ui.click('关闭定时');await ui.respond('pelican-configure',activitySnapshot({pelican:{model:'synthetic-model'}}));await retry;assert.match(ui.text(),/计划已关闭，当前测试也已取消/);assert.doesNotMatch(ui.text(),/synthetic-stop-error/);ui.unmount();
});

test('stop revision also rejects a GET started before run and cancel',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model'}}));await ui.tick(3000);const oldRead=ui.pending('activity-get');
 const run=ui.click('立即测试一次');await ui.flush();const oldRun=ui.pending('pelican-run'),stop=ui.click('取消当前测试');
 await ui.respond('pelican-cancel',activitySnapshot({pelican:{model:'synthetic-model'}}));await stop;
 oldRead.respond(activitySnapshot({pelican:{enabled:true,running:true,model:'obsolete-read'}}));oldRun.fail('obsolete-run');await run;await ui.flush();
 assert.match(ui.text(),/当前计划：关闭；当前测试：未运行/);assert.doesNotMatch(ui.text(),/obsolete-read|obsolete-run/);ui.unmount();
});

test('unmount ignores both superseded configure and its pending stop',async()=>{
 const ui=await activityReady(activitySnapshot({pelican:{model:'synthetic-model'}}));await change(ui,'启用鹈鹕定时测试',true);
 const configure=ui.click('保存测试计划');await ui.flush();const old=ui.requests.at(-1),disable=ui.click('关闭定时'),stop=ui.requests.at(-1);ui.unmount();
 old.respond(activitySnapshot({pelican:{enabled:true,running:true}}));stop.respond(activitySnapshot());await configure;await disable;await ui.flush();assert.equal(ui.afterUnmount,0);assert.equal(ui.timers.size,0);assert.equal(ui.listeners.get('visibilitychange').size,0);
});

test('many official pricing sources stay in a collapsed accessible disclosure while the date remains visible',async()=>{
 const sources=Array.from({length:31},(_value,index)=>'https://developers.openai.com/api/docs/models/synthetic-'+index);
 const ui=await activityReady(activitySnapshot({logs:{pricing:{...pricingMetadata,sources}}})),details=control(ui,'官方价格来源');
 assert.equal(details.type,'details');assert.equal(details.props.open,undefined);assert.equal(details.children[0].type,'summary');assert.equal(ui.text(details.children[0]),'官方价目表来源（31）');
 assert.deepEqual(ui.nodes(details).filter(x=>x.type==='a').map(x=>x.props.href),sources);assert.match(ui.text(),/价目表核对日期：2026-11-08/);assert.doesNotMatch(ui.text(details),/核对日期/);ui.unmount();
});

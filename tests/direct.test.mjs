import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {parseUsage,readDirectUsage,readCatalog,catalogClientVersion} from '../lib/direct-v023.mjs';

const metadata=async()=>JSON.stringify({client_version:'0.165.0'});
const record=()=>Object.freeze({kind:'grant',payload:Object.freeze({access:'synthetic-token',accountId:'synthetic-account',expires:Date.now()+60000})});
const credentials=()=>Object.freeze({readRecord:async key=>{assert.equal(key,'llm-pi-ai/openai-codex');return record()}});
const model=(extra={})=>({slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list',context_window:500000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'high'}],...extra});
const bodyFor=kind=>kind==='catalog'?{models:[model()]}:{rate_limit:{}};
const response=body=>({ok:true,json:async()=>body});
const deferred=()=>Promise.withResolvers();
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const cancelReason=()=>new DOMException('synthetic cancellation','AbortError');
function invoke(kind,account,fetcher,options={}){
  return kind==='catalog'?readCatalog(account,fetcher,{readClientMetadata:metadata,...options}):readDirectUsage(account,fetcher,options);
}

test('quota windows are normalized from known fields without guessing',()=>{
  const q=parseUsage({plan_type:'pro',rate_limit:{primary_window:{used_percent:5,limit_window_seconds:604800,reset_at:2000000000},secondary_window:{used_percent:1,limit_window_seconds:0},unknown_window:{used_percent:20,limit_window_seconds:60}}},0);
  assert.deepEqual(q,{observedAt:'1970-01-01T00:00:00.000Z',plan:'pro',windows:[{name:'Primary',used:5,remaining:95,minutes:10080,resetAt:2000000000}]});
});

test('quota accepts finite decimal strings and both known windows',()=>{
  const q=parseUsage({rateLimit:{primary_window:{used_percent:' +2.5e1 ',limit_window_seconds:'3.6e3',reset_at:'2000000000'},secondary_window:{used_percent:'100',limit_window_seconds:'60'}}},0);
  assert.deepEqual(q.windows,[{name:'Primary',used:25,remaining:75,minutes:60,resetAt:2000000000},{name:'Secondary',used:100,remaining:0,minutes:1,resetAt:null}]);
  assert.equal(q.plan,null);
  assert.equal(parseUsage({rate_limit:{primary_window:{used_percent:0,limit_window_seconds:60}}},0).windows[0].remaining,100);
});

test('quota rejects coercible non-numbers instead of reporting a zero usage',()=>{
  const invalid=[undefined,null,'',' \t\n',true,false,[],[0],[1],{},new Number(0),{valueOf(){throw Error('must not coerce')}},NaN,Infinity,-Infinity,'NaN','Infinity','0x10','0b10'];
  for(const field of ['used_percent','limit_window_seconds']){
    for(const value of invalid){
      const window={used_percent:5,limit_window_seconds:60,[field]:value};
      assert.deepEqual(parseUsage({rate_limit:{primary_window:window}},0).windows,[],field+' must reject '+Object.prototype.toString.call(value));
    }
  }
  for(const value of [-1,100.01,'-1','100.01'])assert.deepEqual(parseUsage({rate_limit:{primary_window:{used_percent:value,limit_window_seconds:60}}},0).windows,[]);
  for(const value of [0,-1,'0','-1'])assert.deepEqual(parseUsage({rate_limit:{primary_window:{used_percent:0,limit_window_seconds:value}}},0).windows,[]);
  for(const value of [...invalid,0,-1,'0','-1']){
    const q=parseUsage({rate_limit:{primary_window:{used_percent:5,limit_window_seconds:60,reset_at:value}}},0);
    assert.equal(q.windows[0].resetAt,null);
  }
});

test('malformed quota rows are isolated from valid secondary windows',()=>{
  for(const primary of [null,undefined,[],{},true,0,'5']){
    const q=parseUsage({plan_type:[],rate_limit:{primary_window:primary,secondary_window:{used_percent:20,limit_window_seconds:60}}},0);
    assert.equal(q.plan,null);
    assert.deepEqual(q.windows,[{name:'Secondary',used:20,remaining:80,minutes:1,resetAt:null}]);
  }
  for(const body of [null,undefined,[],0,'',{}])assert.deepEqual(parseUsage(body,0).windows,[]);
});

test('direct quota preserves injected frozen credentials, headers and fixed endpoint',async()=>{
  let signal;
  const out=await readDirectUsage(credentials(),async(url,options)=>{
    assert.equal(url,'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{Authorization:'Bearer synthetic-token','ChatGPT-Account-Id':'synthetic-account'});
    signal=options.signal;
    assert.equal(signal.aborted,false);
    return Response.json({rate_limit:{}});
  });
  assert.equal(JSON.stringify(out).includes('synthetic-token'),false);
  assert.equal(getEventListeners(signal,'abort').length,0);
});

test('non-string account IDs are not forwarded',async()=>{
  await readDirectUsage({readRecord:async()=>({kind:'grant',payload:{access:'synthetic-token',accountId:{untrusted:true}}})},async(_,options)=>{
    assert.deepEqual(options.headers,{Authorization:'Bearer synthetic-token'});
    return response({});
  });
});

test('catalog compatibility never regresses to a legacy or malformed client version',async()=>{
  for(const value of ['0.157.1','bad','0.165.0?injected=1','9007199254740992.0.0','1.2',null,5,{}])assert.equal(await catalogClientVersion(async()=>JSON.stringify({client_version:value})),'0.165.0');
  for(const value of ['', 'not json', 'null', '{}'])assert.equal(await catalogClientVersion(async()=>value),'0.165.0');
  assert.equal(await catalogClientVersion(async()=>{throw Error('missing')}),'0.165.0');
  for(const value of ['0.165.0','0.165.1','0.166.2','1.0.0'])assert.equal(await catalogClientVersion(async()=>JSON.stringify({client_version:value})),value);
});

test('current catalog includes Sol with supported DSH efforts and no display suffix',async()=>{
  const models=await readCatalog(credentials(),async(url,options)=>{
    assert.equal(url,'https://chatgpt.com/backend-api/codex/models?client_version=0.165.0');
    assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{Authorization:'Bearer synthetic-token','ChatGPT-Account-Id':'synthetic-account'});
    return Response.json({models:[model({supported_reasoning_levels:['low','medium','high','xhigh','max','ultra'].map(effort=>({effort}))}),{slug:'gpt-hidden',visibility:'hide'}]});
  },{readClientMetadata:async()=>JSON.stringify({client_version:'0.157.1',identity:'synthetic-only'})});
  assert.deepEqual(models,[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',contextWindow:500000,maxTokens:32768,input:['text','image'],reasoningEfforts:{low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}}]);
  assert.ok(!JSON.stringify(models).includes('synthetic-token'));
});

test('catalog keeps metadata injection and higher valid client versions',async()=>{
  await readCatalog(credentials(),async url=>{
    assert.equal(url,'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3');
    return response({models:[]});
  },{readClientMetadata:async()=>JSON.stringify({client_version:'1.2.3'})});
});

test('catalog skips malformed rows, validates positive safe contexts, and deduplicates IDs',async()=>{
  const invalid=[null,undefined,[],true,0,'bad',{},
    ...[null,'gpt-bad','other-6',{},['gpt-6.1']].map(slug=>model({slug})),
    model({visibility:'hide'}),
    ...[undefined,null,0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'500000',true,[],{}].map(context_window=>model({context_window})),
    ...[undefined,null,{},'text',[],['image']].map(input_modalities=>model({input_modalities})),
    ...[undefined,null,{},'high',[],[null,true,0,[],{},'high',{effort:'ultra'},{effort:['high']}]].map(supported_reasoning_levels=>model({supported_reasoning_levels})),
  ];
  const valid=model({input_modalities:['text','text',null,'image','audio',{}],supported_reasoning_levels:[null,[],true,'high',{},...['off','minimal','low','medium','high','xhigh','max','high','ultra'].map(effort=>({effort}))]});
  const out=await invoke('catalog',credentials(),async()=>response({models:[...invalid,valid,model({display_name:'duplicate'}),model({slug:'gpt-6-safe',display_name:{bad:true},context_window:Number.MAX_SAFE_INTEGER}),model({slug:'gpt-6-small',display_name:' ',context_window:1})]}));
  assert.deepEqual(out.map(x=>x.id),['gpt-6.1-sol','gpt-6-safe','gpt-6-small']);
  assert.equal(out[0].name,'GPT-6.1-Sol');
  assert.deepEqual(out[0].input,['text','image']);
  assert.deepEqual(Object.keys(out[0].reasoningEfforts),['off','minimal','low','medium','high','xhigh','max']);
  assert.equal(out[1].name,'gpt-6-safe');
  assert.equal(out[1].contextWindow,Number.MAX_SAFE_INTEGER);
  assert.equal(out[2].name,'gpt-6-small');
  assert.equal(out[2].contextWindow,1);
});

test('malformed top-level catalogs fail with an explicit error',async()=>{
  for(const body of [null,undefined,[],{},true,{models:null},{models:{}},{models:'bad'}])await assert.rejects(invoke('catalog',credentials(),async()=>response(body)),/invalid-catalog/);
});

for(const kind of ['usage','catalog']){
  test(kind+': missing or expired credentials never fetch or refresh tokens',async()=>{
    let sent=0;
    const fetcher=async()=>{sent++;return response(bodyFor(kind))};
    for(const value of [null,{}, {kind:'other',payload:{access:'synthetic-token'}},{kind:'grant'},{kind:'grant',payload:{access:null}}])await assert.rejects(invoke(kind,{readRecord:async()=>value},fetcher),/not-authorized/);
    for(const expires of [0,Date.now()+1000])await assert.rejects(invoke(kind,{readRecord:async()=>({kind:'grant',payload:{access:'synthetic-token',expires}})},fetcher),/credential-expired/);
    assert.equal(sent,0);
  });

  test(kind+': transport, HTTP and JSON errors are preserved with listener cleanup',async()=>{
    const failure=Error('synthetic transport failure');
    let signal;
    await assert.rejects(invoke(kind,credentials(),(_,options)=>{signal=options.signal;throw failure}),error=>error===failure);
    assert.equal(getEventListeners(signal,'abort').length,0);
    await assert.rejects(invoke(kind,credentials(),async()=>({ok:false,status:403,json(){assert.fail('HTTP error must not read JSON')}})),/upstream-http-403/);
    await assert.rejects(invoke(kind,credentials(),async(_,options)=>{signal=options.signal;return {ok:true,json(){throw SyntaxError('synthetic invalid JSON')}}}),/synthetic invalid JSON/);
    assert.equal(getEventListeners(signal,'abort').length,0);
  });

  test(kind+': pre-aborted signals prohibit credentials, metadata and fetch',async()=>{
    const controller=new AbortController();
    controller.abort();
    const forbidden=()=>assert.fail('pre-aborted operation must not start');
    await assert.rejects(invoke(kind,{readRecord:forbidden},forbidden,{signal:controller.signal,readClientMetadata:forbidden}),{name:'AbortError'});
  });

  test(kind+': cancellation during readRecord settles before its late result and prevents fetch',{timeout:2000},async()=>{
    const controller=new AbortController(),started=deferred(),pending=deferred(),reason=cancelReason();
    let sent=0;
    const result=invoke(kind,{readRecord(){started.resolve();return pending.promise}},async()=>{sent++;return response(bodyFor(kind))},{signal:controller.signal});
    const rejected=assert.rejects(result,error=>error===reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    pending.resolve(record());
    await flush();
    assert.equal(sent,0);
  });

  test(kind+': cancelling an ignored fetch signal rejects before a late response',{timeout:2000},async()=>{
    const controller=new AbortController(),started=deferred(),pending=deferred(),reason=cancelReason();
    let signal,jsonReads=0;
    const result=invoke(kind,credentials(),(_,options)=>{signal=options.signal;started.resolve();return pending.promise},{signal:controller.signal});
    const rejected=assert.rejects(result,error=>error===reason);
    await started.promise;
    assert.notEqual(signal,controller.signal);
    controller.abort(reason);
    await rejected;
    assert.equal(signal.aborted,true);
    assert.equal(signal.reason,reason);
    assert.equal(getEventListeners(signal,'abort').length,0);
    pending.resolve({ok:true,json(){jsonReads++;return bodyFor(kind)}});
    await flush();
    assert.equal(jsonReads,0);
  });

  test(kind+': cancellation while decoding JSON cannot return a late success',{timeout:2000},async()=>{
    const controller=new AbortController(),started=deferred(),pending=deferred(),reason=cancelReason();
    let signal;
    const result=invoke(kind,credentials(),async(_,options)=>{signal=options.signal;return {ok:true,json(){started.resolve();return pending.promise}}},{signal:controller.signal});
    const rejected=assert.rejects(result,error=>error===reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    pending.resolve(bodyFor(kind));
    await flush();
    assert.equal(getEventListeners(signal,'abort').length,0);
  });

  test(kind+': synchronous cancellation at awaited stage boundaries never succeeds',async()=>{
    for(const phase of ['credentials','fetch','json']){
      const controller=new AbortController(),reason=cancelReason();
      let sent=0,jsonReads=0;
      await assert.rejects(invoke(kind,{readRecord(){if(phase==='credentials')controller.abort(reason);return record()}},()=>{
        sent++;
        if(phase==='fetch')controller.abort(reason);
        return {ok:true,json(){jsonReads++;if(phase==='json')controller.abort(reason);return bodyFor(kind)}};
      },{signal:controller.signal}),error=>error===reason);
      assert.equal(sent,phase==='credentials'?0:1);
      assert.equal(jsonReads,phase==='json'?1:0);
    }
  });

  test(kind+': late rejections after cancellation are handled',{timeout:2000},async()=>{
    const controller=new AbortController(),started=deferred(),pending=deferred();
    const result=invoke(kind,credentials(),()=>{started.resolve();return pending.promise},{signal:controller.signal});
    const rejected=assert.rejects(result,{name:'AbortError'});
    await started.promise;
    controller.abort();
    await rejected;
    pending.reject(Error('late synthetic fetch failure'));
    await flush();
  });

  for(const withExternal of [false,true]){
    test(kind+': ten-second timeout remains active '+(withExternal?'with':'without')+' an external signal',{timeout:2000},async t=>{
      const timeout=new AbortController(),external=new AbortController(),started=deferred(),pending=deferred();
      const timer=t.mock.method(AbortSignal,'timeout',milliseconds=>{assert.equal(milliseconds,10000);return timeout.signal});
      let signal;
      const reason=new DOMException('synthetic timeout','TimeoutError');
      const result=invoke(kind,credentials(),(_,options)=>{signal=options.signal;started.resolve();return pending.promise},withExternal?{signal:external.signal}:{});
      const rejected=assert.rejects(result,error=>error===reason);
      await started.promise;
      timeout.abort(reason);
      await rejected;
      assert.equal(timer.mock.callCount(),1);
      assert.equal(signal.aborted,true);
      assert.equal(signal.reason,reason);
      assert.equal(external.signal.aborted,false);
      assert.equal(getEventListeners(signal,'abort').length,0);
      pending.resolve(response(bodyFor(kind)));
      await flush();
    });
  }
}

test('catalog: cancellation during metadata prevents credentials and fetch despite late fallback',{timeout:2000},async()=>{
  for(const lateFailure of [false,true]){
    const controller=new AbortController(),started=deferred(),pending=deferred();
    let reads=0,sent=0;
    const result=readCatalog({readRecord(){reads++;return record()}},async()=>{sent++;return response({models:[]})},{signal:controller.signal,readClientMetadata(){started.resolve();return pending.promise}});
    const rejected=assert.rejects(result,{name:'AbortError'});
    await started.promise;
    controller.abort();
    await rejected;
    if(lateFailure)pending.reject(Error('late metadata failure'));
    else pending.resolve(JSON.stringify({client_version:'0.166.2'}));
    await flush();
    assert.equal(reads,0);
    assert.equal(sent,0);
  }
});

test('catalog: timeout also bounds stalled metadata without reading credentials',{timeout:2000},async t=>{
  const timeout=new AbortController(),started=deferred(),pending=deferred();
  t.mock.method(AbortSignal,'timeout',milliseconds=>{assert.equal(milliseconds,10000);return timeout.signal});
  const forbidden=()=>assert.fail('timed-out metadata must not continue');
  const result=readCatalog({readRecord:forbidden},forbidden,{readClientMetadata(){started.resolve();return pending.promise}});
  const rejected=assert.rejects(result,{name:'TimeoutError'});
  await started.promise;
  timeout.abort(new DOMException('synthetic timeout','TimeoutError'));
  await rejected;
  pending.resolve('{}');
  await flush();
});

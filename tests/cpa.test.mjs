import test from 'node:test';
import assert from 'node:assert/strict';
import {localUrl, normalizeAccounts, normalizeCatalog, normalizeQuota, request} from '../lib/cpa-v018.mjs';
import {sameOrigin, makeHandler} from '../lib/index-v018.mjs';
import {additions, createSynchronizer} from '../lib/sync-v018.mjs';

test('management requests are limited to fixed loopback endpoints', () => {
  assert.equal(localUrl(18317, '/v1/models'), 'http://127.0.0.1:18317/v1/models');
  for (const path of ['/v0/management/config', '/v1/models?foo=x', '//evil', '/v0/management/get-auth-status?state=x%26y']) assert.throws(() => localUrl(18317, path));
  assert.throws(() => localUrl(0, '/v1/models'));
});
test('remote response is reduced to model IDs and safe account fields', () => {
  assert.deepEqual(normalizeCatalog({data:[{id:'gpt-example', secret:'do-not-copy'}]}), ['gpt-example']);
  const [account]=normalizeAccounts({files:[{provider:'codex',email:'test@example.invalid',status:'ok',token:'secret'},{provider:'other'}]});
  assert.equal(account.label,'test@example.invalid');assert.equal(account.status,'ok');assert.equal('token' in account,false);assert.deepEqual(account.quota.windows,[]);
});
test('quota displays only observed valid windows and does not invent resets',()=>{
 const q=normalizeQuota({observed_at:'2026-10-28T00:00:00Z',signals:{'X-Codex-Primary-Used-Percent':'5','X-Codex-Primary-Window-Minutes':'10080','X-Codex-Primary-Reset-At':'1793783625','X-Codex-Secondary-Used-Percent':'0','X-Codex-Secondary-Window-Minutes':'0'}});
 assert.deepEqual(q.windows,[{name:'Primary',used:5,remaining:95,minutes:10080,resetAt:1793783625}]);
 assert.deepEqual(normalizeQuota({signals:{'X-Codex-Primary-Used-Percent':'','X-Codex-Primary-Window-Minutes':'1'}}).windows,[]);
});
test('state changing requests reject cross-origin and missing origin', () => {
  const mk = origin => new Request('http://dsh.internal/api/cpa-settings',{headers:{host:'localhost:3456',...(origin ? {origin}: {})}});
  assert.equal(sameOrigin(mk('http://localhost:3456')),true);
  assert.equal(sameOrigin(mk('http://evil.invalid')),false);
  assert.equal(sameOrigin(mk()),false);
  assert.equal(sameOrigin(new Request('http://dsh.internal/x',{method:'POST',headers:{host:'127.0.0.1:3741','content-type':'application/json'}})),true);
  assert.equal(sameOrigin(new Request('http://dsh.internal/x',{method:'POST',headers:{host:'evil.invalid','content-type':'application/json'}})),false);
  assert.equal(sameOrigin(new Request('http://dsh.internal/x',{method:'POST',headers:{host:'127.0.0.1:3741',origin:'null','content-type':'application/json'}})),false);
});
test('CPA errors do not pass response bodies or credentials to callers', async () => {
  const fetcher = async () => new Response('private details',{status:401});
  await assert.rejects(request(18317,'/v1/models','sensitive',{fetcher}), {message:'cpa-http-401'});
});
test('OAuth login binds the callback to the pending state and loopback host', async () => {
  const calls=[];
  const deps={installation:async()=>({port:18317,apiKey:'api',keyPath:'protected'}),managementKey:async()=> 'mgmt',normalizeAccounts,normalizeCatalog,request:async (_port,url,_key,options)=>{calls.push({url,options});if(url.includes('codex-auth-url'))return {url:'https://auth.openai.com/authorize?state=abc123',state:'abc123'};if(url.includes('get-auth-status'))return {status:'ok'};return {status:'ok'};}};
  const {handler}=makeHandler(deps);
  const post=body=>new Request('http://dsh.internal/api/cpa-settings',{method:'POST',headers:{host:'localhost:3456',origin:'http://localhost:3456','content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handler(post({action:'start'}))).status,200);
  assert.equal((await handler(post({action:'callback',redirectURL:'http://evil.invalid/callback?state=abc123&code=test'}))).status,400);
  assert.equal((await handler(post({action:'callback',redirectURL:'http://127.0.0.1:1455/callback?state=wrong&code=test'}))).status,400);
  assert.equal((await handler(post({action:'callback',redirectURL:'http://127.0.0.1:1455/callback?state=abc123&code=test'}))).status,200);
  assert.equal((await (await handler(post({action:'status'}))).json()).status,'ok');
  assert.equal((await handler(post({action:'status'}))).status,400);
  assert.equal(calls.filter(x=>x.url.endsWith('/oauth-callback')).length,1);
});
test('catalog sync adds only available models with metadata and preserves existing entries', async () => {
  const old={id:'gpt-old',contextWindow:99};
  const cache={models:[{slug:'gpt-6.1-terra',context_window:500000,input_modalities:['text','image','audio'],supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'ultra'}]}]};
  const result=additions([old],['gpt-old','gpt-6.1-terra','gpt-7-unknown'],cache);
  assert.deepEqual(result.missing,['gpt-7-unknown']);assert.equal(result.added[0].contextWindow,500000);
  assert.deepEqual(result.added[0].input,['text','image']);assert.equal('ultra' in result.added[0].reasoningEfforts,false);
  let op; const settings={describe:()=>[{ns:'llm-pi-ai',revision:3,value:{providers:{'chatgpt-cpa':{models:[old]}}}}],mutate:async(ns,ops,revision)=>{op={ns,ops,revision}}};
  const sync=createSynchronizer(settings,{installation:async()=>({port:1,apiKey:'k'}),normalizeCatalog:x=>x.data,request:async()=>({data:['gpt-old','gpt-6.1-terra','gpt-7-unknown']}),readCache:async()=>cache});
  assert.equal((await sync.run()).status,'ok');assert.deepEqual(op.ops[0].value[0],old);assert.equal(op.ops[0].value[1].id,'gpt-6.1-terra');assert.equal(op.revision,3);
});
test('catalog sync fails closed without writing when CPA or metadata is unavailable', async () => {
  let writes=0;
  const settings={describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers:{'chatgpt-cpa':{models:[]}}}}],mutate:async()=>{writes++}};
  const sync=createSynchronizer(settings,{installation:async()=>({port:1,apiKey:'k'}),normalizeCatalog:x=>x.data,request:async()=>({data:['gpt-7-example']}),readCache:async()=>{throw Error('missing-cache')}});
  const state=await sync.run();assert.equal(state.status,'error');assert.equal(writes,0);
});








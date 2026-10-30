import test from 'node:test';import assert from 'node:assert/strict';import {parseUsage,readDirectUsage,readCatalog,catalogClientVersion} from '../lib/direct-v022.mjs';
test('quota windows are normalized from known fields without guessing',()=>{const q=parseUsage({plan_type:'pro',rate_limit:{primary_window:{used_percent:5,limit_window_seconds:604800,reset_at:2000000000},secondary_window:{used_percent:1,limit_window_seconds:0}}},0);assert.deepEqual(q.windows,[{name:'Primary',used:5,remaining:95,minutes:10080,resetAt:2000000000}])});
test('direct quota uses only the fixed endpoint and does not expose credentials',async()=>{let url;const credentials={readRecord:async()=>({kind:'grant',payload:{access:'synthetic-token',accountId:'synthetic',expires:Date.now()+60000}})};const out=await readDirectUsage(credentials,async(u,o)=>{url=u;assert.equal(o.redirect,'error');return new Response(JSON.stringify({rate_limit:{}}),{status:200})});assert.equal(url,'https://chatgpt.com/backend-api/wham/usage');assert.equal(JSON.stringify(out).includes('synthetic-token'),false)});
test('expired access does not attempt an uncoordinated token refresh',async()=>{let sent=false;await assert.rejects(readDirectUsage({readRecord:async()=>({kind:'grant',payload:{access:'x',expires:0}})},async()=>{sent=true}),/credential-expired/);assert.equal(sent,false)});

test('catalog compatibility never regresses to a legacy or malformed client version',async()=>{
 for(const value of ['0.157.1','bad','0.165.0?injected=1',null])assert.equal(await catalogClientVersion(async()=>JSON.stringify({client_version:value})),'0.165.0');
 assert.equal(await catalogClientVersion(async()=>{throw Error('missing')}),'0.165.0');
 assert.equal(await catalogClientVersion(async()=>JSON.stringify({client_version:'0.166.2'})),'0.166.2');
});
test('current catalog includes Sol with supported DSH efforts and no display suffix',async()=>{
 const credentials={readRecord:async()=>({kind:'grant',payload:{access:'synthetic-token',expires:Date.now()+60000}})};
 const models=await readCatalog(credentials,async(url,options)=>{
  assert.equal(url,'https://chatgpt.com/backend-api/codex/models?client_version=0.165.0');assert.equal(options.redirect,'error');
  return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',visibility:'list',context_window:500000,input_modalities:['text','image'],supported_reasoning_levels:['low','medium','high','xhigh','max','ultra'].map(effort=>({effort}))},{slug:'gpt-hidden',visibility:'hide'}]});
 },{readClientMetadata:async()=>JSON.stringify({client_version:'0.157.1',identity:'synthetic-only'})});
 assert.equal(models.length,1);assert.equal(models[0].id,'gpt-6.1-sol');assert.equal(models[0].name,'GPT-6.1-Sol');assert.equal(models[0].contextWindow,500000);assert.deepEqual(Object.keys(models[0].reasoningEfforts),['low','medium','high','xhigh','max']);
 assert.ok(!JSON.stringify(models).includes('synthetic-token'));
});

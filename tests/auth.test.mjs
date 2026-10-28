import test from 'node:test';import assert from 'node:assert/strict';import {createDirectLogin} from '../lib/auth-v021.mjs';
test('direct OAuth starts only the registered Codex flow and returns URL, then observes completion',async()=>{
 let requested;const authorization={begin:async r=>{requested=r;assert.equal(await r.interaction.prompt({kind:'select',options:[{id:'browser'}]}),'browser');r.interaction.notify({url:'https://auth.openai.com/oauth/authorize?state=synthetic'});return {status:'authorized'}}};
 const login=createDirectLogin(authorization);const url=await login.begin();assert.match(url,/auth\.openai\.com/);await new Promise(r=>setTimeout(r,0));assert.equal(login.status().state,'authorized');assert.equal(requested.key,'llm-pi-ai/openai-codex');
});
test('non-OpenAI login destinations are rejected',async()=>{
 const login=createDirectLogin({begin:async r=>{await r.interaction.prompt({kind:'select',options:[{id:'browser'}]});r.interaction.notify({url:'https://example.invalid'});return {status:'cancelled'}}});
 await assert.rejects(login.begin(),/invalid-auth-url/);
});

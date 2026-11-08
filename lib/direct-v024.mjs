import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

const USAGE_URL='https://chatgpt.com/backend-api/wham/usage';
const CATALOG_URL='https://chatgpt.com/backend-api/codex/models';
const MIN_CATALOG_VERSION='0.165.0';
// Only public client-version metadata is read from an optional local Codex cache.
// Account models and authorization always come from this DSH account's endpoint.
async function readClientMetadata(){return readFile(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'models_cache.json'),'utf8')}
export async function catalogClientVersion(readMetadata=readClientMetadata){
  try {
    const version=JSON.parse(await readMetadata()).client_version;
    if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))return MIN_CATALOG_VERSION;
    const candidate=version.split('.').map(Number),minimum=MIN_CATALOG_VERSION.split('.').map(Number);
    if(!candidate.every(Number.isSafeInteger))return MIN_CATALOG_VERSION;
    for(let i=0;i<3;i++){if(candidate[i]>minimum[i])return version;if(candidate[i]<minimum[i])return MIN_CATALOG_VERSION}
    return version;
  }catch{return MIN_CATALOG_VERSION}
}
function requestSignal(signal){
  const timeout=AbortSignal.timeout(10000);
  return signal?AbortSignal.any([signal,timeout]):timeout;
}
// Injected readers/fetchers need not honor AbortSignal themselves. Race each wait
// so cancellation settles promptly, and never continue with their late results.
async function abortable(operation,signal){
  signal.throwIfAborted();
  let onAbort;
  const aborted=new Promise((_,reject)=>{
    onAbort=()=>reject(signal.reason);
    signal.addEventListener('abort',onAbort,{once:true});
  });
  try {
    const result=await Promise.race([
      Promise.resolve().then(()=>{signal.throwIfAborted();return operation()}),
      aborted,
    ]);
    signal.throwIfAborted();
    return result;
  }finally{signal.removeEventListener('abort',onAbort)}
}
async function directGet(credentials,url,fetcher,signal){
  const record=await abortable(()=>credentials.readRecord('llm-pi-ai/openai-codex'),signal);
  signal.throwIfAborted();
  if(record?.kind!=='grant'||typeof record.payload?.access!=='string')throw Error('not-authorized');
  const {access,accountId,expires}=record.payload;
  if(typeof expires==='number'&&expires<=Date.now()+30000)throw Error('credential-expired');
  const response=await abortable(()=>fetcher(url,{headers:{Authorization:`Bearer ${access}`,...typeof accountId==='string'?{'ChatGPT-Account-Id':accountId}:{}},redirect:'error',signal}),signal);
  signal.throwIfAborted();
  if(!response.ok)throw Error(`upstream-http-${response.status}`);
  const body=await abortable(()=>response.json(),signal);
  signal.throwIfAborted();
  return body;
}
export async function readCatalog(credentials,fetcher=fetch,{readClientMetadata:versionMetadata,signal}={}){
  const pendingSignal=requestSignal(signal);
  const version=await abortable(()=>catalogClientVersion(versionMetadata),pendingSignal);
  pendingSignal.throwIfAborted();
  const body=await directGet(credentials,`${CATALOG_URL}?client_version=${version}`,fetcher,pendingSignal);
  pendingSignal.throwIfAborted();
  if(!Array.isArray(body?.models))throw Error('invalid-catalog');
  const levels=new Set(['off','minimal','low','medium','high','xhigh','max']),seen=new Set(),models=[];
  for(const x of body.models){
    if(!x||typeof x!=='object'||Array.isArray(x)||x.visibility!=='list'||typeof x.slug!=='string'||!/^gpt-\d[\w.-]*$/.test(x.slug)||seen.has(x.slug))continue;
    if(!Number.isSafeInteger(x.context_window)||x.context_window<=0||!Array.isArray(x.input_modalities)||!Array.isArray(x.supported_reasoning_levels))continue;
    const modes=[...new Set(x.input_modalities.filter(m=>m==='text'||m==='image'))];
    const efforts=x.supported_reasoning_levels.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&levels.has(v.effort)).map(v=>v.effort);
    if(!modes.includes('text')||!efforts.length)continue;
    seen.add(x.slug);
    models.push({id:x.slug,name:typeof x.display_name==='string'&&x.display_name.trim()?x.display_name:x.slug,contextWindow:x.context_window,maxTokens:32768,input:modes,reasoningEfforts:Object.fromEntries(efforts.map(v=>[v,v]))});
  }
  return models;
}
function usageNumber(value){
  if(typeof value==='number')return value;
  if(typeof value!=='string')return NaN;
  const text=value.trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)?Number(text):NaN;
}
export function parseUsage(body, observedAt=Date.now()) {
  const rate=body?.rate_limit??body?.rateLimit??{};const windows=[];
  for(const [name,key] of [['Primary','primary_window'],['Secondary','secondary_window']]) {
    const x=rate[key];if(!x||typeof x!=='object'||Array.isArray(x))continue;
    const used=usageNumber(x.used_percent),seconds=usageNumber(x.limit_window_seconds),reset=usageNumber(x.reset_at);
    if(Number.isFinite(used)&&used>=0&&used<=100&&Number.isFinite(seconds)&&seconds>0)windows.push({name,used,remaining:100-used,minutes:seconds/60,resetAt:Number.isFinite(reset)&&reset>0?reset:null});
  }
  return {observedAt:new Date(observedAt).toISOString(),plan:typeof body?.plan_type==='string'?body.plan_type:null,windows};
}
export async function readDirectUsage(credentials, fetcher=fetch, {signal}={}) {
  const pendingSignal=requestSignal(signal);
  const body=await directGet(credentials,USAGE_URL,fetcher,pendingSignal);
  pendingSignal.throwIfAborted();
  return parseUsage(body);
}

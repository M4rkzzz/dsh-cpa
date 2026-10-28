const USAGE_URL='https://chatgpt.com/backend-api/wham/usage';
const CATALOG_URL='https://chatgpt.com/backend-api/codex/models?client_version=0.157.1';
async function directGet(credentials,url,fetcher=fetch){
  const record=await credentials.readRecord('llm-pi-ai/openai-codex');
  if(record?.kind!=='grant'||typeof record.payload?.access!=='string')throw Error('not-authorized');
  const {access,accountId,expires}=record.payload;
  if(typeof expires==='number'&&expires<=Date.now()+30000)throw Error('credential-expired');
  const response=await fetcher(url,{headers:{Authorization:`Bearer ${access}`,...typeof accountId==='string'?{'ChatGPT-Account-Id':accountId}:{}},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`upstream-http-${response.status}`);
  return response.json();
}
export async function readCatalog(credentials,fetcher=fetch){
  const body=await directGet(credentials,CATALOG_URL,fetcher);
  if(!Array.isArray(body.models))throw Error('invalid-catalog');
  const levels=new Set(['off','minimal','low','medium','high','xhigh','max']);
  return body.models.filter(x=>x.visibility==='list'&&/^gpt-\d[\w.-]*$/.test(x.slug??'')).flatMap(x=>{
    const modes=(x.input_modalities??[]).filter(m=>['text','image'].includes(m)),efforts=(x.supported_reasoning_levels??[]).map(v=>v.effort).filter(v=>levels.has(v));
    if(!Number.isInteger(x.context_window)||!modes.includes('text')||!efforts.length)return [];
    return [{id:x.slug,name:`${x.display_name??x.slug} · 直连`,contextWindow:x.context_window,maxTokens:32768,input:modes,reasoningEfforts:Object.fromEntries(efforts.map(v=>[v,v]))}];
  });
}
export function parseUsage(body, observedAt=Date.now()) {
  const rate=body?.rate_limit??body?.rateLimit??{};const windows=[];
  for(const [name,key] of [['Primary','primary_window'],['Secondary','secondary_window']]) {
    const x=rate[key];if(!x)continue;
    const used=Number(x.used_percent),seconds=Number(x.limit_window_seconds),reset=Number(x.reset_at);
    if(Number.isFinite(used)&&used>=0&&used<=100&&Number.isFinite(seconds)&&seconds>0)windows.push({name,used,remaining:100-used,minutes:seconds/60,resetAt:Number.isFinite(reset)&&reset>0?reset:null});
  }
  return {observedAt:new Date(observedAt).toISOString(),plan:typeof body?.plan_type==='string'?body.plan_type:null,windows};
}
export async function readDirectUsage(credentials, fetcher=fetch) {
  return parseUsage(await directGet(credentials,USAGE_URL,fetcher));
}

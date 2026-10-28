import fs from 'node:fs/promises';
import path from 'node:path';
import {installation, normalizeCatalog, request} from './cpa-v018.mjs';

export function additions(current, ids, cache) {
  const known = new Set(current.map(m => m.id));
  const metadata = new Map((cache.models ?? []).map(m => [m.slug, m]));
  const added = [], missing = [];
  for (const id of ids) {
    if (known.has(id) || !/^gpt-\d[\w.-]*$/.test(id)) continue;
    const m = metadata.get(id);
    if (!m || !Number.isInteger(m.context_window) || !Array.isArray(m.supported_reasoning_levels) || !m.supported_reasoning_levels.length || !Array.isArray(m.input_modalities)) {missing.push(id);continue;}
    const allowed = new Set(['off','minimal','low','medium','high','xhigh','max']);
    const levels = m.supported_reasoning_levels.map(x=>x.effort).filter(x=>allowed.has(x));
    const modalities = m.input_modalities.filter(x=>['text','image'].includes(x));
    if (!levels.length || !modalities.includes('text')) {missing.push(id);continue;}
    added.push({id, name:`${id} · CPA`, contextWindow:m.context_window, maxTokens:32768, input:modalities, reasoningEfforts:Object.fromEntries(levels.map(x=>[x,x]))});
  }
  return {added, missing};
}

export function createSynchronizer(settings, dependencies = {installation, normalizeCatalog, request, readCache:async()=>JSON.parse(await fs.readFile(path.join(process.env.USERPROFILE, '.codex', 'models_cache.json'),'utf8'))}) {
  let active = null, state = {status:'waiting', added:[], missing:[], at:null};
  const run = () => active ??= (async()=>{
    try {
      const cpa = await dependencies.installation();
      const ids = dependencies.normalizeCatalog(await dependencies.request(cpa.port, '/v1/models', cpa.apiKey));
      const descriptor = settings.describe({redactSecrets:false}).find(x=>x.ns==='llm-pi-ai');
      const route = descriptor?.value?.providers?.['chatgpt-cpa'];
      if (!route || !Array.isArray(route.models)) throw Error('cpa-route-unavailable');
      const {added,missing} = additions(route.models, ids, await dependencies.readCache());
      if (added.length) await settings.mutate('llm-pi-ai', [{op:'set',path:['providers','chatgpt-cpa','models'],value:[...route.models,...added]}], descriptor.revision);
      state={status:'ok',added:added.map(m=>m.id),missing,at:Date.now()};
    } catch (e) {state={status:'error',error:/^[a-z][a-z0-9-]+$/.test(e.message??'')?e.message:'sync-failed',added:[],missing:[],at:Date.now()};}
    return state;
  })().finally(()=>{active=null});
  return {run, getState:()=>state};
}



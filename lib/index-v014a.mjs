import {installation, managementKey, normalizeAccounts, normalizeCatalog, request, focusDesktop} from './cpa-v014a.mjs';
import {createSynchronizer} from './sync-v014a.mjs';
export const name = 'cpa-settings';
export const inject = ['connection', 'settings'];

export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) {
    // The authenticated DSH Desktop bridge omits Origin; limit this case to
    // JSON requests addressed to loopback. Cross-site browser forms cannot
    // issue application/json requests without a CORS preflight.
    try {
      const host = request.headers.get('host');
      const target = new URL(`http://${host}`);
      return !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash && ['127.0.0.1','localhost','[::1]'].includes(target.hostname) && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '');
    } catch { return false; }
  }
  try {
    const o = new URL(origin), host = request.headers.get('host') ?? new URL(request.url).host;
    return ['http:', 'https:'].includes(o.protocol) && !o.username && !o.password && o.host === new URL(`${o.protocol}//${host}`).host;
  } catch { return false; }
}

export function makeHandler(deps = {installation, managementKey, normalizeAccounts, normalizeCatalog, request, focusDesktop}, sync = null) {
  let pending = null;
  async function handler(req) {
    try {
      const cpa = await deps.installation();
      if (req.method === 'GET') {
        const data = await deps.request(cpa.port, '/v1/models', cpa.apiKey);
        let accounts = [], management = false;
        try {
          const key = await deps.managementKey(cpa.keyPath);
          accounts = deps.normalizeAccounts(await deps.request(cpa.port, '/v0/management/auth-files', key));
          management = true;
        } catch { /* A healthy model endpoint does not imply management access. */ }
        if (pending && Date.now() > pending.until) pending = null;
        return Response.json({online:true, port:cpa.port, models:deps.normalizeCatalog(data), management, accounts, authorizationPending:!!pending, sync:sync?.getState()}, {headers:{'cache-control':'no-store'}});
      }
      if (!sameOrigin(req)) return Response.json({error:'cross-origin-write-denied'}, {status:403});
      const body = await req.json();
      if (body.action === 'sync') return Response.json(await sync.run(), {headers:{'cache-control':'no-store'}});
      const key = await deps.managementKey(cpa.keyPath);
      if (body.action === 'start') {
        const result = await deps.request(cpa.port, '/v0/management/codex-auth-url?is_webui=true', key);
        const u = new URL(result.url);
        if (u.protocol !== 'https:' || u.hostname !== 'auth.openai.com' || !/^[A-Za-z0-9_-]+$/.test(result.state ?? '') || u.searchParams.get('state') !== result.state) throw Error('invalid-authorization-response');
        pending = {state:result.state, until:Date.now()+300000};
        return Response.json({url:u.href, expiresIn:300}, {headers:{'cache-control':'no-store'}});
      }
      if (!pending || Date.now() > pending.until) throw Error('authorization-expired');
      if (body.action === 'status') {
        const result = await deps.request(cpa.port, `/v0/management/get-auth-status?state=${pending.state}`, key);
        if (!['ok','wait','error'].includes(result.status)) throw Error('invalid-auth-status');
        if (result.status !== 'wait') pending = null;
        if (result.status === 'ok' && sync) await sync.run();
        const focused = result.status === 'ok' ? await deps.focusDesktop?.() : undefined;
        return Response.json({status:result.status, ...(focused === undefined ? {} : {focused})}, {headers:{'cache-control':'no-store'}});
      }
      if (body.action === 'callback') {
        const u = new URL(String(body.redirectURL ?? ''));
        if (!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname) || u.searchParams.get('state') !== pending.state || !u.searchParams.has('code')) throw Error('invalid-callback');
        await deps.request(cpa.port, '/v0/management/oauth-callback', key, {method:'POST', body:{provider:'codex', redirect_url:u.href}});
        return Response.json({status:'submitted'}, {headers:{'cache-control':'no-store'}});
      }
      throw Error('invalid-action');
    } catch (e) {
      const code = /^(?:cpa-http-\d+|[a-z][a-z-]+)$/.test(e.message ?? '') ? e.message : 'cpa-unavailable';
      return Response.json({error:code}, {status:400, headers:{'cache-control':'no-store'}});
    }
  }
  return {handler, clear:() => {pending = null}};
}

export function apply(ctx) {
  const sync = createSynchronizer(ctx.settings);
  const {handler, clear} = makeHandler(undefined, sync);
  const remove = ctx.connection.fetch.register({path:'/api/cpa-settings', methods:['GET','POST'], requestBody:'buffered', fetch:handler});
  const start = setTimeout(()=>sync.run(), 3000);
  const interval = setInterval(()=>sync.run(), 300000);
  const dispose = () => { clearTimeout(start); clearInterval(interval); clear(); remove?.(); };
  ctx.effect(() => dispose);
  return dispose;
}










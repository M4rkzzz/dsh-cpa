import {createDirectLogin} from './auth-v022.mjs';
import {readCatalog, readDirectUsage} from './direct-v022.mjs';

export const name = 'cpa-settings';
export const inject = ['connection', 'settings', 'credentials', 'authorization', 'llm', 'webServer'];
const CREDENTIAL_KEY = 'llm-pi-ai/openai-codex';
const waiting = () => ({status: 'waiting', added: [], missing: []});
const publicErrors = new Set([
  'account-changed', 'not-authorized', 'credential-expired', 'invalid-catalog', 'settings-unavailable', 'empty-catalog',
  'already-running', 'authorization-cancelled', 'no-prompt', 'invalid-callback', 'invalid-action', 'plugin-disposed',
  'invalid-auth-url', 'authorization-start-timeout', 'authorization-completion-timeout', 'authorization-failed',
  'cancelled', 'login-ended', 'unsupported-login-method', 'already-prompting',
]);
const errorCode = (error, fallback) => publicErrors.has(error?.message) || /^upstream-http-\d{3}$/.test(error?.message ?? '') ? error.message : fallback;
const json = (body, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});

export function sameOrigin(req) {
  try {
    const url = new URL(req.url), host = req.headers.get('host');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host) return false;
    const authority = new URL(url.protocol + '//' + host);
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash || authority.origin !== url.origin) return false;
    const origin = req.headers.get('origin');
    if (origin !== null) {
      const source = new URL(origin);
      return !source.username && !source.password && source.pathname === '/' && !source.search && !source.hash && source.origin === url.origin;
    }
    // Non-browser loopback clients may omit Origin, but cross-site browser writes may not.
    const site = req.headers.get('sec-fetch-site');
    return (!site || site === 'same-origin') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && /^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '');
  } catch { return false; }
}

export function apply(ctx) {
  const auth = createDirectLogin(ctx.authorization), lifetime = new AbortController();
  let account = null, scheduledFlight = null, authGeneration = 0;
  const active = () => lifetime.signal.throwIfAborted();

  async function selectAccount() {
    active();
    const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
    active();
    const grant = record?.kind === 'grant' && typeof record.payload?.access === 'string' && record.payload.access.trim()
      ? {kind: 'grant', payload: {access: record.payload.access, accountId: record.payload.accountId, expires: record.payload.expires}} : null;
    // This key stays in process. Token rotation invalidates the snapshot even without an accountId.
    const key = grant ? JSON.stringify([grant.payload.access, grant.payload.accountId, grant.payload.expires]) : null;
    if (!account || account.key !== key) {
      account?.controller.abort(Error('account-changed'));
      const controller = new AbortController();
      account = {key, grant, controller, signal: AbortSignal.any([lifetime.signal, controller.signal]),
        credentials: {readRecord: async () => grant}, quota: null, quotaAt: 0, quotaError: undefined,
        quotaFlight: null, syncFlight: null, syncState: waiting()};
    }
    return account;
  }

  async function current(snapshot) {
    active();
    if (await selectAccount() !== snapshot) throw Error('account-changed');
    snapshot.signal.throwIfAborted();
  }

  async function refreshQuota(snapshot) {
    if (!snapshot.grant || (snapshot.quota && Date.now() - snapshot.quotaAt < 60000)) return;
    if (snapshot.quotaFlight) return snapshot.quotaFlight;
    const flight = (async () => {
      try {
        const quota = await readDirectUsage(snapshot.credentials, fetch, {signal: snapshot.signal});
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        snapshot.quota = quota;
        snapshot.quotaAt = Date.now();
        snapshot.quotaError = undefined;
      } catch (error) {
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        snapshot.quotaError = errorCode(error, 'quota-unavailable');
      }
    })().finally(() => { if (snapshot.quotaFlight === flight) snapshot.quotaFlight = null; });
    snapshot.quotaFlight = flight;
    return flight;
  }

  async function sync() {
    const snapshot = await selectAccount();
    if (snapshot.syncFlight) return snapshot.syncFlight;
    const flight = (async () => {
      let result;
      try {
        const models = await readCatalog(snapshot.credentials, fetch, {signal: snapshot.signal});
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        const description = ctx.settings.describe({redactSecrets: false}).find(x => x.ns === 'llm-pi-ai');
        if (!description) throw Error('settings-unavailable');
        const provider = description.value.providers?.['openai-codex'], existing = provider?.models ?? [];
        const ids = new Set(existing.map(x => x.id)), added = models.filter(model => !ids.has(model.id));
        if (!provider && !models.length) throw Error('empty-catalog');
        const ops = [];
        if (!provider) {
          ops.push({op: 'set', path: ['providers', 'openai-codex'], value: {displayName: 'ChatGPT', models}});
        } else {
          const cleaned = existing.map(model => typeof model.name === 'string' && model.name.endsWith(' · 直连')
            ? {...model, name: model.name.replace(/ · 直连$/, '')} : model);
          if (['ChatGPT 直连', 'ChatGPT 直连（测试）'].includes(provider.displayName)) ops.push({op: 'set', path: ['providers', 'openai-codex', 'displayName'], value: 'ChatGPT'});
          if (added.length || cleaned.some((model, i) => model.name !== existing[i].name)) ops.push({op: 'set', path: ['providers', 'openai-codex', 'models'], value: [...cleaned, ...added]});
        }
        snapshot.signal.throwIfAborted();
        if (ops.length) await ctx.settings.mutate('llm-pi-ai', ops, description.revision);
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        result = {status: 'ok', added: added.map(x => x.id), missing: [], at: Date.now()};
      } catch (error) {
        result = {status: 'error', error: errorCode(error, 'sync-failed'), added: [], missing: [], at: Date.now()};
      }
      if (!snapshot.signal.aborted && account === snapshot) snapshot.syncState = result;
      return result;
    })().finally(() => { if (snapshot.syncFlight === flight) snapshot.syncFlight = null; });
    snapshot.syncFlight = flight;
    return flight;
  }

  async function state() {
    // Retry a changing credential snapshot, never label a previous account's data as current.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await selectAccount();
      try {
        await refreshQuota(snapshot);
        snapshot.signal.throwIfAborted();
        const models = await ctx.llm.listModels('openai-codex').catch(() => []);
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        return {online: !!snapshot.grant, management: true, port: null, models: models.map(x => x.id),
          accounts: snapshot.grant ? [{label: 'ChatGPT 账号', status: '已授权', disabled: false, quota: snapshot.quota ?? {windows: []}, modelQuotas: []}] : [],
          quotaError: snapshot.quotaError, quotaStale: !!snapshot.quota && (!!snapshot.quotaError || Date.now() - snapshot.quotaAt >= 60000),
          authorizationPending: auth.status().state === 'waiting', sync: snapshot.syncState};
      } catch (error) {
        active();
        if (error?.message !== 'account-changed') throw error;
      }
    }
    throw Error('account-changed');
  }

  async function handle(req) {
    try {
      active();
      if (req.method === 'GET') {
        const value = await state();
        active();
        return json(value);
      }
      if (req.method !== 'POST') return json({error: 'method-not-allowed'}, 405);
      if (!sameOrigin(req)) return json({error: 'cross-origin-write-denied'}, 403);
      const body = await req.json();
      active();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('invalid-action');
      if (body.action === 'start') {
        if (auth.status().state === 'waiting') throw Error('already-running');
        const generation = ++authGeneration, url = await auth.begin();
        active();
        if (generation !== authGeneration) throw Error('authorization-cancelled');
        return json({url});
      }
      if (body.action === 'cancel') {
        authGeneration++;
        auth.cancel();
        return json({status: 'cancelled'});
      }
      if (body.action === 'status') {
        const generation = authGeneration, status = auth.status();
        if (status.state === 'authorized') {
          await sync();
          active();
          return json({status: generation === authGeneration && auth.status().state === 'authorized' ? 'ok' : 'error'});
        }
        return json({status: status.state === 'waiting' ? 'wait' : 'error'});
      }
      if (body.action === 'callback') {
        auth.answer(String(body.redirectURL ?? ''));
        return json({status: 'submitted'});
      }
      if (body.action === 'sync') {
        const result = await sync();
        active();
        return json(result);
      }
      throw Error('invalid-action');
    } catch (error) {
      return json({error: errorCode(error, 'request-failed')}, lifetime.signal.aborted ? 503 : 400);
    }
  }

  const remove = ctx.connection.fetch.register({path: '/api/cpa-settings', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handle});
  // Keep settings mutations outside the plugin reload transaction, through authenticated local HTTP.
  function scheduledSync() {
    if (lifetime.signal.aborted) return Promise.resolve();
    if (scheduledFlight) return scheduledFlight;
    const flight = (async () => {
      let snapshot;
      try {
        snapshot = await selectAccount();
        snapshot.signal.throwIfAborted();
        if (!snapshot.grant) return;
        const origin = ctx.webServer.getOrigin();
        const login = await fetch(ctx.connection.authenticatedUrl(origin), {redirect: 'manual', signal: AbortSignal.any([snapshot.signal, AbortSignal.timeout(10000)])});
        const cookie = login.headers.getSetCookie().map(x => x.split(';', 1)[0]).join('; ');
        await login.body?.cancel();
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        if (!cookie) throw Error('local-auth-unavailable');
        const response = await fetch(new URL('/api/cpa-settings', origin), {method: 'POST', headers: {cookie, origin: new URL(origin).origin, 'content-type': 'application/json'}, body: JSON.stringify({action: 'sync'}), signal: AbortSignal.any([snapshot.signal, AbortSignal.timeout(30000)])});
        await response.body?.cancel();
        await current(snapshot);
        snapshot.signal.throwIfAborted();
        if (!response.ok) throw Error('local-sync-failed');
      } catch {
        if (snapshot && !snapshot.signal.aborted && account === snapshot) snapshot.syncState = {status: 'error', error: 'sync-schedule-failed', added: [], missing: [], at: Date.now()};
      }
    })().finally(() => { if (scheduledFlight === flight) scheduledFlight = null; });
    scheduledFlight = flight;
    return flight;
  }

  const start = setTimeout(scheduledSync, 3000), timer = setInterval(scheduledSync, 300000);
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(Error('plugin-disposed'));
    clearTimeout(start);
    clearInterval(timer);
    authGeneration++;
    auth.cancel();
    account?.controller.abort(Error('plugin-disposed'));
    account = null;
    remove?.();
  };
  ctx.effect(() => dispose);
  return dispose;
}

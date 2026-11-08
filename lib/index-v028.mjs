import {createAccounts, ACCOUNT_ERROR_CODES} from './accounts-v026.mjs';
import {readCatalog, readDirectUsage} from './direct-v024.mjs';
import {createTelemetry} from './telemetry-v026.mjs';
import {createPelican} from './pelican-v026.mjs';
import {createPngRenderer} from './png-v026.mjs';
import {createLogStore} from './log-store-v026.mjs';
import {Config, createPreferences} from './settings-v026.mjs';
import {PRICING_INFO} from './pricing-v024.mjs';

export {Config};
export const name = 'cpa-settings';
export const inject = ['connection', 'settings', 'credentials', 'authorization', 'llm', 'webServer', 'profileContext'];
const publicErrors = new Set([
  ...ACCOUNT_ERROR_CODES,
  'account-changed', 'account-inactive', 'account-switch-busy', 'pelican-account-inactive', 'CPA_ACCOUNT_INACTIVE',
  'not-authorized', 'credential-expired', 'invalid-catalog', 'empty-catalog',
  'settings-unavailable', 'settings-save-failed', 'settings-superseded', 'invalid-fast-setting', 'invalid-account',
  'already-running', 'authorization-cancelled', 'no-prompt', 'invalid-callback', 'invalid-action', 'invalid-json',
  'invalid-auth-url', 'authorization-start-timeout', 'authorization-completion-timeout', 'authorization-failed',
  'cancelled', 'login-ended', 'unsupported-login-method', 'already-prompting', 'plugin-disposed',
  'cpa-transport-unavailable', 'cpa-models-unavailable', 'cpa-account-unavailable', 'cpa-transport-disposed',
  'pelican-unavailable', 'pelican-busy', 'pelican-disposed', 'pelican-invalid-config', 'pelican-invalid-interval',
  'pelican-invalid-model', 'pelican-models-unavailable', 'pelican-cancelled', 'pelican-timeout', 'pelican-output-limit',
  'pelican-invalid-stream', 'pelican-stream-closed', 'pelican-tool-call', 'pelican-max-tokens',
  'pelican-generation-failed', 'pelican-invalid-svg', 'pelican-save-failed',
  'png-invalid-input', 'png-input-limit', 'png-invalid-svg', 'png-unsafe-svg', 'png-complexity-limit',
  'png-output-limit', 'png-render-failed', 'png-unavailable', 'png-invalid-output', 'png-timeout', 'png-aborted', 'png-worker-error',
  'log-store-invalid-cursor', 'log-store-cleared', 'log-store-invalid-filter', 'log-store-invalid-row',
  'log-store-disposed', 'log-store-busy', 'log-store-aborted', 'log-storage-unavailable',
]);
const failure = code => Object.assign(new Error(code), {code});
const errorCode = (error, fallback = 'request-failed') => {
  for (const candidate of [error?.code, error?.message]) {
    if (publicErrors.has(candidate) || typeof candidate === 'string' && /^upstream-http-[1-5]\d{2}$/.test(candidate)) return candidate;
  }
  return fallback;
};
const json = (body, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
const safeId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)
  && !['__proto__', 'prototype', 'constructor'].includes(id);
const matches = (row, filter) => ['status', 'model', 'source', 'accountId'].every(key => !filter[key] || row[key] === filter[key]);

// Keep the real Host Connection bridge contract. Forwarded headers do not
// establish public origin or weaken authentication on writes.
export function sameOrigin(req, trustedProtocol) {
  try {
    const url = new URL(req.url), host = req.headers.get('host');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host) return false;
    const bridged = url.origin === 'http://dsh.internal';
    const protocol = bridged ? trustedProtocol : url.protocol;
    if (!['http:', 'https:'].includes(protocol) || /[\s\\/?#@,;]/.test(host) || host.endsWith(':')) return false;
    const authority = new URL(protocol + '//' + host);
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) return false;
    if (!bridged && authority.origin !== url.origin) return false;
    const origin = req.headers.get('origin');
    if (origin !== null) {
      if (!/^https?:\/\/[^/?#@\\\s,;]+\/?$/i.test(origin)) return false;
      const source = new URL(origin);
      return !source.username && !source.password && source.pathname === '/' && !source.search && !source.hash && source.origin === authority.origin;
    }
    const site = req.headers.get('sec-fetch-site');
    return (!site || site === 'same-origin') && ['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname)
      && /^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '');
  } catch { return false; }
}

async function readJson(req, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw failure('invalid-json');
  if (!req.body) throw failure('invalid-json');
  const reader = req.body.getReader();
  const chunks = [];
  let length = 0, aborted;
  const stopped = new Promise((_, reject) => {
    aborted = () => reject(failure('invalid-json'));
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
  });
  try {
    while (true) {
      const {value, done} = await Promise.race([reader.read(), stopped]);
      if (done) break;
      length += value.byteLength;
      if (length > 16 * 1024) throw failure('invalid-json');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid-action');
    return value;
  } catch (error) {
    try {Promise.resolve(reader.cancel()).catch(() => {});} catch { /* an already closed body is not an error source */ }
    throw failure(error?.code === 'invalid-action' ? 'invalid-action' : 'invalid-json');
  } finally {
    signal.removeEventListener('abort', aborted);
    try {reader.releaseLock();} catch { /* cancellation may still own a pending read */ }
  }
}
function filtersOf(req) {
  const params = new URL(req.url).searchParams;
  return Object.fromEntries(['cursor', 'status', 'model', 'source', 'accountId'].flatMap(key => {
    const value = params.get(key);
    return value ? [[key, value]] : [];
  }));
}
const statusFor = code => ['plugin-disposed', 'accounts-disposed', 'cpa-transport-unavailable', 'pelican-unavailable', 'log-storage-unavailable', 'settings-unavailable', 'settings-save-failed'].includes(code) ? 503
  : ['account-not-found', 'image-not-found'].includes(code) ? 404
  : ['pelican-busy', 'pelican-cancelled', 'settings-superseded', 'settings-conflict', 'account-changed', 'log-store-invalid-cursor', 'log-store-cleared', 'log-store-busy', 'account-switch-busy', 'account-inactive', 'pelican-account-inactive', 'CPA_ACCOUNT_INACTIVE'].includes(code) ? 409 : 400;

// The dependency hooks are for offline contract tests. Production apply uses
// only the public host services and declared npm exports, never private paths.
export function createCpaApp(ctx, config = Config({}), options = {}) {
  const lifetime = new AbortController(), now = options.now ?? Date.now;
  const fetcher = options.fetchImpl ?? fetch;
  const preferences = createPreferences(ctx, config);
  const accounts = options.accounts ?? createAccounts(ctx, options.accountOptions);
  const profileDir = ctx.profileContext?.dir;
  const logs = options.logStore ?? createLogStore({profileDir});
  const telemetry = options.telemetry ?? createTelemetry(ctx, {onRecord: row => logs.append(row)});
  const renderer = options.renderer ?? createPngRenderer();
  const removers = [], quotaCache = new Map(), syncCache = new Map(), stops = new Map();
  let transport = null, pelican = null, transportError = null, accountError = null;
  let rows = [], reconcileFlight = null, booting = true, authGeneration = 0, controlSequence = 0;
  let startTimer, syncTimer, disposePromise, switching = false, accountGeneration = 0;
  const active = () => {if (lifetime.signal.aborted) throw failure('plugin-disposed');};
  const activeAccountId = () => {
    const selected = preferences.snapshot().activeAccountId;
    return selected === 'host-current' ? rows.find(row => row.owned === false && row.availability === 'ready')?.id ?? ''
      : rows.some(row => row.id === selected && row.availability === 'ready') ? selected : '';
  };
  const isEnabled = id => !switching && !lifetime.signal.aborted && id === activeAccountId();
  const activeConversation = id => {
    const provider = rows.find(row => row.id === id)?.provider;
    return Boolean(provider && telemetry.hasRunningConversation(provider));
  };
  function report(code) {try {Promise.resolve(options.onError?.(code)).catch(() => {});} catch { /* diagnostics are non-authoritative */ }}
  function stop(id) {stops.set(id, ++controlSequence);}
  async function reconcile() {
    active();
    if (reconcileFlight) return reconcileFlight;
    const flight = (async () => {
      const nextRows = await accounts.list();
      active();
      if (transport) await transport.refresh();
      active();
      const byId = new Map(nextRows.map(row => [row.id, row]));
      for (const id of new Set([...quotaCache.keys(), ...syncCache.keys()])) {
        const row = byId.get(id);
        if (!row || row.availability !== 'ready') {quotaCache.delete(id); syncCache.delete(id); continue;}
        try {
          const binding = await accounts.capture(id, row.provider);
          await binding.assertCurrent(); active();
          if (quotaCache.get(id)?.principalHash !== binding.principalHash) quotaCache.delete(id);
          if (syncCache.get(id)?.principalHash !== binding.principalHash) syncCache.delete(id);
        } catch {quotaCache.delete(id); syncCache.delete(id);}
      }
      rows = nextRows;
      if (pelican) await pelican.refresh();
      active();
      accountError = null;
      return rows;
    })().catch(error => {
      accountError = errorCode(error, 'accounts-unavailable');
      throw error;
    }).finally(() => {if (reconcileFlight === flight) reconcileFlight = null;});
    reconcileFlight = flight;
    return flight;
  }
  const onChanged = () => {
    if (booting || lifetime.signal.aborted) return;
    queueMicrotask(() => {if (!lifetime.signal.aborted) reconcile().catch(() => report('accounts-unavailable'));});
  };
  removers.push(accounts.onChange?.(onChanged));
  const ready = (async () => {
    try {
      const factory = options.transportFactory ?? (await import('./transport-v026.mjs')).createCpaTransport;
      active();
      transport = await factory(ctx, {accounts, getFast: () => preferences.snapshot().fastEnabled,
        telemetry, ...(options.transportOptions ?? {}), isEnabled});
      active();
    } catch (error) {
      if (lifetime.signal.aborted) return;
      transportError = 'cpa-transport-unavailable';
      report(transportError);
    }
    const unavailable = {listModels: async () => [], stream: () => {throw failure('cpa-transport-unavailable');}};
    pelican = createPelican({accounts, transport: transport ?? unavailable, telemetry, renderer,
      getPlans: () => preferences.snapshot().plans,
      savePlan: (id, plan, guard) => preferences.savePlan(id, plan, guard),
      ...(options.pelicanOptions ?? {}), isEnabled});
    booting = false;
    try {await reconcile();} catch {report('accounts-unavailable');}
  })();
  ready.catch(() => report('cpa-transport-unavailable'));

  async function refreshQuota(row) {
    const binding = await accounts.capture(row.id, row.provider);
    active();
    let cache = quotaCache.get(row.id);
    if (!cache || cache.principalHash !== binding.principalHash) {
      cache = {principalHash: binding.principalHash, quota: null, at: 0, attemptAt: 0, error: null, flight: null};
      quotaCache.set(row.id, cache);
    }
    if (cache.flight) {await cache.flight; await binding.assertCurrent(); return binding;}
    if (cache.attemptAt && now() - cache.attemptAt < 60000) {await binding.assertCurrent(); return binding;}
    cache.attemptAt = now();
    const signal = AbortSignal.any([lifetime.signal, binding.signal]);
    const flight = (async () => {
      try {
        const quota = await readDirectUsage({readRecord: () => binding.readCredentialRecord()}, fetcher, {signal});
        await binding.assertCurrent(); active();
        if (quotaCache.get(row.id) !== cache) throw failure('account-changed');
        cache.quota = quota; cache.at = now(); cache.error = null;
      } catch (error) {
        await binding.assertCurrent(); active();
        if (quotaCache.get(row.id) === cache) cache.error = errorCode(error, 'quota-unavailable');
      }
    })().finally(() => {if (cache.flight === flight) cache.flight = null;});
    cache.flight = flight;
    await flight;
    return binding;
  }
  async function parallel(items, action) {
    let next = 0;
    await Promise.all(Array.from({length: Math.min(items.length, 4)}, async () => {
      while (next < items.length) {const item = items[next++]; await action(item);}
    }));
  }
  async function state() {
    await ready; active();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const currentRows = await reconcile();
        const generation = accountGeneration, selectedId = activeAccountId(), wasSwitching = switching;
        const enabled = row => !wasSwitching && row.id === selectedId && row.availability === 'ready';
        const identity = values => JSON.stringify(values.map(row => [row.id, row.provider, row.email, row.owned, row.availability, row.canRunProbe]));
        const expectedIdentity = identity(currentRows);
        const availableRows = currentRows.filter(enabled);
        const bindings = [];
        await parallel(availableRows, async row => {bindings.push(await refreshQuota(row));});
        active();
        const modelIds = new Set(), accountRows = [];
        for (const row of currentRows) {
          const models = transport ? await transport.listModels(row.id).catch(() => []) : [];
          for (const model of models) modelIds.add(model.id);
          const cache = quotaCache.get(row.id);
          accountRows.push({...row, enabled: enabled(row), canRunProbe: Boolean(transport) && row.canRunProbe && enabled(row),
            quota: cache?.quota ?? null,
            quotaStale: !enabled(row) || row.availability !== 'ready' || !cache?.quota || Boolean(cache.error) || now() - cache.at >= 60000,
            quotaError: cache?.error ?? null, models: models.map(model => model.id)});
        }
        // Recheck identity after network/catalog awaits before returning labels.
        const latest = await accounts.list();
        if (identity(latest) !== expectedIdentity) throw failure('account-changed');
        await Promise.all(bindings.map(binding => binding.assertCurrent()));
        active();
        if (generation !== accountGeneration || selectedId !== activeAccountId() || wasSwitching !== switching) throw failure('account-changed');
        const saved = preferences.snapshot(), activeId = selectedId;
        const activeSync = syncCache.get(activeId)?.result ?? {status: 'waiting', added: [], missing: []};
        const providers = accountRows.filter(row => row.enabled && row.canRunProbe).map(row => row.provider);
        return {online: accountRows.some(row => row.availability === 'ready'), management: !accountError,
          port: null, accounts: accountRows, models: [...modelIds],
          authorizationPending: accounts.loginStatus().state === 'waiting', sync: activeSync,
          fast: {available: Boolean(transport) && providers.length > 0, enabled: Boolean(transport) && providers.length > 0 && saved.fastEnabled,
            reason: transportError ?? (providers.length ? null : 'cpa-account-unavailable'), providers},
          preferences: {...saved, activeAccountId: activeId}, persistence: preferences.status(), transportError, switching: wasSwitching};
      } catch (error) {
        active();
        if (errorCode(error) !== 'account-changed' || attempt === 2) throw error;
      }
    }
  }
  async function sync(accountId) {
    await ready; active();
    if (!transport) throw failure('cpa-transport-unavailable');
    await reconcile();
    const id = accountId ?? activeAccountId();
    if (!isEnabled(id)) throw failure('account-inactive');
    const row = rows.find(item => item.id === id);
    if (!row) throw failure('account-not-found');
    const binding = await accounts.capture(row.id, row.provider);
    let cache = syncCache.get(row.id);
    if (!cache || cache.principalHash !== binding.principalHash) {
      cache = {principalHash: binding.principalHash, flight: null, result: {status: 'waiting', added: [], missing: []}};
      syncCache.set(row.id, cache);
    }
    if (cache.flight) return cache.flight;
    const flight = (async () => {
      let result;
      try {
        const before = new Set((await transport.listModels(row.id)).map(model => model.id));
        const models = await readCatalog({readRecord: () => binding.readCredentialRecord()}, fetcher,
          {signal: AbortSignal.any([lifetime.signal, binding.signal]), ...(options.catalogOptions ?? {})});
        await binding.assertCurrent(); active();
        if (!models.length) throw failure('empty-catalog');
        if (typeof transport.setCatalog !== 'function') throw failure('cpa-models-unavailable');
        await transport.setCatalog(row.id, models, binding);
        await binding.assertCurrent(); active();
        result = {status: 'ok', added: models.filter(model => !before.has(model.id)).map(model => model.id), missing: [], at: now()};
      } catch (error) {
        active();
        result = {status: 'error', error: errorCode(error, 'sync-failed'), added: [], missing: [], at: now()};
      }
      if (!binding.signal.aborted && syncCache.get(row.id) === cache) cache.result = result;
      return result;
    })().finally(() => {if (cache.flight === flight) cache.flight = null;});
    cache.flight = flight;
    return flight;
  }
  async function activity(req) {
    await ready; active();
    await reconcile();
    const filter = filtersOf(req), live = telemetry.snapshot();
    const running = filter.cursor ? [] : live.entries.filter(row => row.status === 'running' && matches(row, filter)).slice(0, 49);
    const page = await logs.page({...filter, limit: 50 - running.length});
    active();
    const stored = logs.snapshot(), summary = stored.summary ? structuredClone(stored.summary) : structuredClone(live.summary);
    if (stored.storage?.available && stored.summary) {
      summary.running = live.summary.running;
      summary.total += live.summary.running;
    }
    return {logs: {available: live.available, entries: page.storage.available ? [...running, ...page.entries]
        : live.entries.filter(row => matches(row, filter)).slice(0, 50), summary,
      pricing: structuredClone(PRICING_INFO), page: page.page, storage: page.storage,
      recording: live.recording, persistent: true}, ...pelican.snapshot()};
  }
  async function removeSavedAccount(id) {
    active();
    if (!rows.find(row => row.id === id)?.owned) throw failure('account-delete-forbidden');
    if (switching) throw failure('account-switch-busy');
    const removingActive = id === activeAccountId();
    if (removingActive) {switching = true; accountGeneration++;}
    try {
      if (activeConversation(id)) throw failure('account-switch-busy');
      stop(id); pelican.cancel(id);
      await accounts.remove(id); active();
      await preferences.removeAccount(id); active();
      pelican.removeAccount(id);
    } finally {
      if (removingActive) switching = false;
      if (!lifetime.signal.aborted) await reconcile();
    }
  }
  async function selectEnabledAccount(id) {
    active();
    if (switching) throw failure('account-switch-busy');
    const row = rows.find(row => row.id === id);
    if (!row || row.availability !== 'ready') throw failure('account-not-found');
    const previous = activeAccountId();
    if (previous === id) {await preferences.selectAccount(id); return;}
    switching = true;
    const generation = ++accountGeneration;
    try {
      // No new prepared/paid calls can enter while this gate is closed. An
      // ordinary conversation must be stopped explicitly before changing users.
      if (activeConversation(previous)) throw failure('account-switch-busy');
      for (const account of rows) if (account.id !== id) {stop(account.id); pelican.cancel(account.id);}
      await preferences.selectAccount(id, {isCurrent: () => !lifetime.signal.aborted && generation === accountGeneration});
      active();
    } finally {
      switching = false;
      if (!lifetime.signal.aborted) await reconcile();
    }
    await sync(id);
  }
  function respondError(error) {
    const code = lifetime.signal.aborted ? 'plugin-disposed' : errorCode(error);
    return json({error: code}, statusFor(code));
  }
  function guardWrite(req) {
    active();
    return sameOrigin(req, ctx.webServer.protocol) ? null : json({error: 'cross-origin-write-denied'}, 403);
  }
  async function handle(req) {
    const entered = controlSequence, authEntered = authGeneration, accountEntered = accountGeneration;
    try {
      active();
      if (req.method === 'GET') {const value = await state(); active(); return json(value);}
      if (req.method !== 'POST') return json({error: 'method-not-allowed'}, 405);
      const denied = guardWrite(req); if (denied) return denied;
      const body = await readJson(req, AbortSignal.any([req.signal, lifetime.signal])); active();
      if (body.action === 'cancel') {
        authGeneration++;
        await accounts.cancelLogin(); active();
        return json({status: 'cancelled'});
      }
      if (body.action === 'start') {
        if (authEntered !== authGeneration) throw failure('authorization-cancelled');
        const generation = ++authGeneration, result = await accounts.beginLogin();
        active();
        if (generation !== authGeneration) throw failure('authorization-cancelled');
        return json(result);
      }
      if (body.action === 'callback') {
        if (authEntered !== authGeneration) throw failure('authorization-cancelled');
        accounts.answerLogin(body.redirectURL);
        return json({status: 'submitted'});
      }
      if (body.action === 'status') {
        const status = accounts.loginStatus();
        if (status.state === 'authorized') {
          await ready; await reconcile(); active();
          return json({status: authEntered === authGeneration && accounts.loginStatus().state === 'authorized' ? 'ok' : 'error'});
        }
        return json({status: status.state === 'waiting' ? 'wait' : 'error'});
      }
      await ready; active();
      if (body.action === 'fast') {
        if (!transport) throw failure('cpa-transport-unavailable');
        await reconcile();
        if (accountEntered !== accountGeneration || switching || body.accountId !== undefined && body.accountId !== activeAccountId()) throw failure('account-changed');
        if (body.enabled === true && !activeAccountId()) throw failure('cpa-account-unavailable');
        await preferences.setFast(body.enabled, {isCurrent: () => !lifetime.signal.aborted && accountEntered === accountGeneration && !switching});
        const value = await state(); active();
        if (accountEntered !== accountGeneration || switching || body.accountId !== undefined && value.preferences.activeAccountId !== body.accountId) throw failure('account-changed');
        return json(value);
      }
      if (body.action === 'account-select' || body.action === 'account-remove') {
        if (!safeId(body.accountId)) throw failure('invalid-account');
        if (accountEntered !== accountGeneration) throw failure('account-changed');
        await reconcile();
        if (!rows.some(row => row.id === body.accountId)) throw failure('account-not-found');
        if (body.action === 'account-select') {
          if (entered < (stops.get(body.accountId) ?? 0)) throw failure('account-changed');
          await selectEnabledAccount(body.accountId);
        } else {
          await removeSavedAccount(body.accountId);
        }
        const value = await state(); active(); return json(value);
      }
      if (body.action === 'sync') {const value = await sync(body.accountId); active(); return json(value);}
      throw failure('invalid-action');
    } catch (error) {return respondError(error);}
  }
  async function handleActivity(req) {
    const entered = controlSequence, accountEntered = accountGeneration;
    try {
      active();
      if (req.method === 'GET') {const value = await activity(req); active(); return json(value);}
      if (req.method !== 'POST') return json({error: 'method-not-allowed'}, 405);
      const denied = guardWrite(req); if (denied) return denied;
      const body = await readJson(req, AbortSignal.any([req.signal, lifetime.signal])); active();
      await ready; active();
      if (body.action === 'logs-clear') {
        const clearing = logs.clear(); telemetry.clear(); await clearing;
      } else if (['pelican-run', 'pelican-configure', 'pelican-cancel'].includes(body.action)) {
        if (!safeId(body.accountId)) throw failure('invalid-account');
        // Do not await reconciliation before stop: it must supersede older
        // bodies/configuration/model resolution that have not completed yet.
        const stopping = body.action === 'pelican-cancel' || body.action === 'pelican-configure' && body.intervalMinutes === 0;
        if (stopping) {
          if (!rows.some(row => row.id === body.accountId)) throw failure('account-not-found');
          stop(body.accountId);
          if (body.action === 'pelican-cancel') pelican.cancel(body.accountId);
          else await pelican.configure(body.accountId, {intervalMinutes: 0, ...(body.model === undefined ? {} : {model: body.model})});
        } else {
          if (accountEntered !== accountGeneration || entered < (stops.get(body.accountId) ?? 0)) throw failure('pelican-cancelled');
          await reconcile();
          if (accountEntered !== accountGeneration || entered < (stops.get(body.accountId) ?? 0)) throw failure('pelican-cancelled');
          if (body.action === 'pelican-run') await pelican.run(body.accountId, {model: body.model});
          else await pelican.configure(body.accountId, {intervalMinutes: body.intervalMinutes, ...(body.model === undefined ? {} : {model: body.model})});
        }
      } else throw failure('invalid-action');
      active();
      const value = await activity(req); active(); return json(value);
    } catch (error) {return respondError(error);}
  }
  async function handleHistory(req) {
    try {
      active(); await ready; await reconcile();
      const id = new URL(req.url).searchParams.get('accountId');
      if (!safeId(id)) throw failure('invalid-account');
      const row = rows.find(row => row.id === id);
      if (!row) throw failure('account-not-found');
      const binding = await accounts.capture(id, row.provider);
      await binding.assertCurrent(); active();
      return json(pelican.history(id));
    } catch (error) {return respondError(error);}
  }
  async function handleImage(req) {
    try {
      active(); await ready; await reconcile();
      const params = new URL(req.url).searchParams, id = params.get('accountId'), imageId = params.get('imageId');
      if (!safeId(id) || !safeId(imageId)) return json({error: 'image-not-found'}, 404);
      const row = rows.find(row => row.id === id);
      if (!row) return json({error: 'image-not-found'}, 404);
      const binding = await accounts.capture(id, row.provider), bytes = pelican.image(id, imageId);
      await binding.assertCurrent(); active();
      if (!bytes) return json({error: 'image-not-found'}, 404);
      return new Response(bytes, {headers: {'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}});
    } catch (error) {return respondError(error);}
  }
  async function handleExport(req) {
    try {
      active(); await ready; await logs.ready; active();
      if (!logs.snapshot().storage.available) throw failure('log-storage-unavailable');
      const filters = filtersOf(req); delete filters.cursor;
      return new Response(logs.export(filters, {signal: AbortSignal.any([req.signal, lifetime.signal])}), {
        headers: {'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': 'attachment; filename="cpa-logs.ndjson"',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff'},
      });
    } catch (error) {return respondError(error);}
  }
  const register = (path, methods, handler) => {
    removers.push(ctx.connection.fetch.register({path, methods, requestBody: 'buffered', fetch: handler}));
  };
  register('/api/cpa-settings', ['GET', 'POST'], handle);
  register('/api/cpa-activity', ['GET', 'POST'], handleActivity);
  register('/api/cpa-history', ['GET'], handleHistory);
  register('/api/cpa-image', ['GET'], handleImage);
  register('/api/cpa-logs-export', ['GET'], handleExport);
  if (typeof ctx.on === 'function') removers.push(ctx.on('settings/document-updated', ns => {
    if (ns === (ctx.fiber?.entry?.options?.id ?? name)) onChanged();
  }));
  try {removers.push(ctx.settings.configure?.({auto: false}, ctx.fiber));} catch {report('settings-unavailable');}
  async function scheduledSync() {
    if (lifetime.signal.aborted) return;
    try {
      await ready; active(); await reconcile();
      await parallel(rows.filter(row => isEnabled(row.id)), row => sync(row.id));
    } catch {if (!lifetime.signal.aborted) report('sync-schedule-failed');}
  }
  if (options.schedule !== false) {
    startTimer = setTimeout(scheduledSync, 3000);
    syncTimer = setInterval(scheduledSync, 300000);
    startTimer.unref?.(); syncTimer.unref?.();
  }
  function dispose() {
    if (disposePromise) return disposePromise;
    lifetime.abort(failure('plugin-disposed'));
    clearTimeout(startTimer); clearInterval(syncTimer);
    authGeneration++;
    for (const remove of removers.splice(0)) try {remove?.();} catch {report('dispose-failed');}
    preferences.dispose();
    pelican?.dispose();
    const accountCleanup = accounts.dispose();
    // Observe cleanup immediately; it may finish before the rest of teardown.
    const accountsSettled = Promise.resolve(accountCleanup).catch(() => report('account-login-cleanup-failed'));
    telemetry.dispose();
    quotaCache.clear(); syncCache.clear(); stops.clear(); rows = [];
    disposePromise = (async () => {
      await Promise.allSettled([ready, preferences.flush(), accountsSettled]);
      // A factory that settled after disposal is still owned by this instance.
      await Promise.allSettled([Promise.resolve().then(() => transport?.dispose()),
        Promise.resolve().then(() => renderer.dispose()), Promise.resolve().then(() => logs.dispose())]);
    })();
    return disposePromise;
  }
  return {ready, dispose, state, scheduledSync};
}

export function apply(ctx, config = Config({})) {
  const app = createCpaApp(ctx, config);
  ctx.effect(() => app.dispose);
  return app.dispose;
}

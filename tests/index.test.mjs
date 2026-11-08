import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply, sameOrigin} from '../lib/index-v022.mjs';

const NOW = 2000000000000;
const grant = id => ({kind: 'grant', payload: {access: 'synthetic-token-' + id, accountId: 'synthetic-account-' + id, expires: NOW + 3600000}});
const model = (slug = 'gpt-6-synthetic') => ({slug, display_name: slug, visibility: 'list', context_window: 100000, input_modalities: ['text'], supported_reasoning_levels: [{effort: 'medium'}]});
const quota = used => Response.json({rate_limit: {primary_window: {used_percent: used, limit_window_seconds: 18000}}});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cpa-test-'));
  await writeFile(join(directory, 'models_cache.json'), JSON.stringify({client_version: '0.165.0'}));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  let now = NOW, record = options.record === undefined ? grant('a') : options.record, handler, removed = 0, nextTimer = 1;
  let upstream = options.fetcher ?? (async url => {
    if (String(url).startsWith('https://chatgpt.com/backend-api/codex/models?')) return Response.json({models: [model()]});
    assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage');
    return quota(12);
  });
  const timers = new Map(), calls = [], mutations = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { const id = nextTimer++; timers.set(id, {fn, delay}); return id; });
  t.mock.method(globalThis, 'setInterval', (fn, delay) => { const id = nextTimer++; timers.set(id, {fn, delay, interval: true}); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'clearInterval', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({url: String(url), init}); return upstream(url, init); });
  const settings = options.settings ?? {providers: {}, defaultProvider: 'retained-provider', defaultModel: 'retained-model'};
  let revision = 7;
  const ctx = {
    authorization: options.authorization ?? {begin: async () => { throw Error('unexpected-login'); }},
    credentials: {readRecord: async key => { assert.equal(key, 'llm-pi-ai/openai-codex'); return record; }},
    llm: {listModels: async () => [{id: 'gpt-configured'}]},
    settings: {
      describe: () => [{ns: 'llm-pi-ai', value: settings, revision}],
      mutate: async (ns, ops, expected) => {
        assert.equal(expected, revision);
        mutations.push({ns, ops, expected});
        for (const op of ops) {
          let target = settings;
          for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
          target[op.path.at(-1)] = structuredClone(op.value);
        }
        revision++;
      }
    },
    webServer: {getOrigin: () => 'http://localhost:7452'},
    connection: {authenticatedUrl: origin => origin + '/synthetic-login', fetch: {register: route => { handler = route.fetch; return () => { removed++; }; }}},
    effect: () => {}
  };
  const dispose = apply(ctx);
  t.after(async () => {
    dispose();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(directory, {recursive: true, force: true});
  });
  const request = (body, headers = {}, method = body === undefined ? 'GET' : 'POST') => handler(new Request('http://localhost:7452/api/cpa-settings', {
    method, headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json', ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }));
  return {ctx, calls, timers, mutations, settings, dispose, request,
    setRecord: value => { record = value; }, setFetcher: value => { upstream = value; }, advance: ms => { now += ms; },
    get removed() { return removed; },
    get: async () => { const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); },
    post: async (action, body = {}) => { const response = await request({action, ...body}); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); },
    scheduled: () => [...timers.values()].find(x => x.delay === 3000).fn()
  };
}

test('same-origin writes compare scheme, host and port and reject malformed origins', () => {
  const check = (url, host, origin, extra = {}) => sameOrigin(new Request(url, {headers: {host, 'content-type': 'application/json; charset=utf-8', ...(origin === undefined ? {} : {origin}), ...extra}}));
  assert.equal(check('http://localhost/api', 'localhost', 'http://localhost'), true);
  assert.equal(check('https://localhost/api', 'localhost', 'https://localhost:443'), true);
  for (const origin of ['https://localhost', 'http://localhost:1234', 'http://example.invalid', 'null', 'http://user@localhost', 'http://localhost/path', 'http://localhost?x=1']) assert.equal(check('http://localhost/api', 'localhost', origin), false, origin);
  assert.equal(check('http://localhost/api', 'example.invalid', 'http://localhost'), false);
  assert.equal(check('http://localhost/api', 'localhost/path', 'http://localhost'), false);
  assert.equal(check('http://localhost/api', 'user@localhost', 'http://localhost'), false);
  assert.equal(check('http://localhost/api', 'localhost', undefined), true);
  assert.equal(check('http://127.0.0.1:7452/api', '127.0.0.1:7452', undefined), true);
  assert.equal(check('http://[::1]/api', '[::1]', undefined), true);
  assert.equal(check('http://example.invalid/api', 'example.invalid', undefined), false);
  assert.equal(check('http://localhost/api', 'localhost', undefined, {'content-type': 'text/plain'}), false);
  assert.equal(check('http://localhost/api', 'localhost', undefined, {'sec-fetch-site': 'cross-site'}), false);
});

test('quota cache is reused only for the same credential snapshot', async t => {
  const f = await fixture(t);
  const first = await f.get();
  await f.get();
  assert.equal(f.calls.length, 1);
  f.setRecord(grant('b'));
  f.setFetcher(async () => quota(88));
  const second = await f.get();
  assert.equal(second.accounts[0].quota.windows[0].used, 88);
  assert.equal(first.accounts[0].quota.windows[0].used, 12);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(second).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(second).includes('synthetic-account'), false);
});

test('a failed new-account refresh cannot retain the old account quota', async t => {
  const f = await fixture(t);
  await f.get();
  f.setRecord(grant('b'));
  f.setFetcher(async () => new Response(null, {status: 503}));
  const state = await f.get();
  assert.deepEqual(state.accounts[0].quota, {windows: []});
  assert.equal(state.quotaError, 'upstream-http-503');
  f.advance(61000);
  assert.deepEqual((await f.get()).accounts[0].quota, {windows: []});
});

test('credential removal and token rotation invalidate the quota cache', async t => {
  const f = await fixture(t);
  await f.get();
  f.setRecord(null);
  const signedOut = await f.get();
  assert.equal(signedOut.online, false);
  assert.deepEqual(signedOut.accounts, []);
  f.setRecord(grant('a'));
  await f.get();
  f.setRecord({...grant('a'), payload: {...grant('a').payload, access: 'synthetic-rotated'}});
  await f.get();
  assert.equal(f.calls.length, 3);
});

test('same-account refresh failure retains an explicitly stale observation', async t => {
  const f = await fixture(t);
  const initial = await f.get();
  f.advance(60000);
  f.setFetcher(async () => new Response(null, {status: 503}));
  const failed = await f.get();
  assert.deepEqual(failed.accounts[0].quota, initial.accounts[0].quota);
  assert.equal(failed.quotaStale, true);
  assert.equal(failed.quotaError, 'upstream-http-503');
  f.setFetcher(async () => quota(23));
  const recovered = await f.get();
  assert.equal(recovered.quotaStale, false);
  assert.equal(recovered.quotaError, undefined);
  assert.equal(recovered.accounts[0].quota.windows[0].used, 23);
});

test('concurrent state reads share one quota request', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return quota(30); }});
  const first = f.get();
  await started.promise;
  const second = f.get();
  gate.resolve();
  const states = await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(states[0], states[1]);
});

test('late old-account quota responses are discarded even if fetch ignores abort', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async (_url, init) => {
    if (init.headers.Authorization.endsWith('-a')) { started.resolve(); await gate.promise; return quota(1); }
    return quota(90);
  }});
  const oldRequest = f.get();
  await started.promise;
  f.setRecord(grant('b'));
  const newState = await f.get();
  assert.equal(f.calls[0].init.signal.aborted, true);
  gate.resolve();
  const oldState = await oldRequest;
  assert.equal(newState.accounts[0].quota.windows[0].used, 90);
  assert.equal(oldState.accounts[0].quota.windows[0].used, 90);
});

test('model sync adds reliable models without replacing existing or default selections', async t => {
  const existing = {id: 'gpt-existing', name: 'Existing · 直连', custom: true};
  const f = await fixture(t, {settings: {providers: {'openai-codex': {displayName: 'ChatGPT 直连', models: [existing], custom: 'retain'}}, defaultModel: 'gpt-existing'}});
  const result = await f.post('sync');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.added, ['gpt-6-synthetic']);
  assert.equal(f.settings.defaultModel, 'gpt-existing');
  assert.equal(f.settings.providers['openai-codex'].custom, 'retain');
  assert.deepEqual(f.settings.providers['openai-codex'].models[0], {...existing, name: 'Existing'});
  await f.post('sync');
  assert.equal(f.mutations.length, 1);
});

test('invalid or empty catalog leaves existing settings untouched', async t => {
  const settings = {providers: {'openai-codex': {displayName: 'ChatGPT', models: [{id: 'gpt-existing'}]}}};
  const f = await fixture(t, {settings, fetcher: async () => Response.json({models: [null, {}]})});
  assert.equal((await f.post('sync')).status, 'ok');
  assert.equal(f.mutations.length, 0);
  f.setFetcher(async () => Response.json({unexpected: true}));
  assert.equal((await f.post('sync')).error, 'invalid-catalog');
  assert.equal(f.mutations.length, 0);
  assert.deepEqual(settings.providers['openai-codex'].models, [{id: 'gpt-existing'}]);
});

test('a late catalog from a replaced account cannot write model settings', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return Response.json({models: [model()]}); }});
  const syncing = f.post('sync');
  await started.promise;
  f.setRecord(grant('b'));
  gate.resolve();
  assert.equal((await syncing).error, 'account-changed');
  assert.equal(f.mutations.length, 0);
});

test('dispose aborts quota requests and removes routes and timers once', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return quota(4); }});
  const request = f.request();
  await started.promise;
  f.dispose(); f.dispose();
  assert.equal(f.calls[0].init.signal.aborted, true);
  assert.equal(f.removed, 1);
  assert.equal(f.timers.size, 0);
  gate.resolve();
  assert.equal((await request).status, 503);
  assert.equal((await f.request()).status, 503);
});

test('dispose prevents in-flight catalog requests from mutating settings', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return Response.json({models: [model()]}); }});
  const request = f.request({action: 'sync'});
  await started.promise;
  f.dispose();
  assert.equal(f.calls[0].init.signal.aborted, true);
  gate.resolve();
  assert.equal((await request).status, 503);
  assert.equal(f.mutations.length, 0);
});

test('dispose while reading credentials prevents any upstream request', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t);
  f.ctx.credentials.readRecord = async () => { started.resolve(); await gate.promise; return grant('a'); };
  const response = f.request();
  await started.promise;
  f.dispose(); gate.resolve();
  assert.equal((await response).status, 503);
  assert.equal(f.calls.length, 0);
});

test('scheduled sync does not POST after disposal during local authentication', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return new Response(null, {status: 302, headers: {'set-cookie': 'synthetic=1; HttpOnly'}}); }});
  const scheduled = f.scheduled();
  await started.promise;
  f.dispose();
  assert.equal(f.calls[0].init.signal.aborted, true);
  gate.resolve(); await scheduled;
  assert.equal(f.calls.length, 1);
});

test('scheduled work is deduplicated and its POST signal aborts on disposal', async t => {
  const gate = deferred(), posted = deferred();
  const f = await fixture(t, {fetcher: async (url, init) => {
    if (String(url).endsWith('/synthetic-login')) return new Response(null, {status: 302, headers: {'set-cookie': 'synthetic=1; HttpOnly'}});
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.cookie, 'synthetic=1');
    assert.equal(init.headers.origin, 'http://localhost:7452');
    posted.resolve(); await gate.promise; return Response.json({status: 'ok'});
  }});
  const first = f.scheduled(), second = f.scheduled();
  assert.equal(first, second);
  await posted.promise;
  f.dispose();
  assert.equal(f.calls[1].init.signal.aborted, true);
  gate.resolve(); await first;
  assert.equal(f.calls.length, 2);
});

test('write routes reject cross-origin requests and malformed actions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({action: 'sync'}, {origin: 'https://localhost:7452'})).status, 403);
  for (const body of [null, [], {action: 'unknown'}]) assert.equal((await f.request(body)).status, 400);
  assert.equal((await f.request(undefined, {}, 'DELETE')).status, 405);
  assert.equal(f.calls.length, 0);
});

test('OAuth can be cancelled through the API and immediately restarted', async t => {
  let starts = 0;
  const f = await fixture(t, {authorization: {begin: async request => {
    starts++;
    request.interaction.notify({url: 'https://auth.openai.com/oauth/authorize?state=synthetic'});
    await request.interaction.prompt({kind: 'text', signal: request.signal});
    return {status: 'authorized'};
  }}});
  assert.match((await f.post('start')).url, /^https:\/\/auth\.openai\.com/);
  assert.equal((await f.post('status')).status, 'wait');
  assert.equal((await f.post('start')).error, 'already-running');
  assert.equal((await f.post('cancel')).status, 'cancelled');
  assert.equal((await f.post('status')).status, 'error');
  assert.match((await f.post('start')).url, /^https:\/\/auth\.openai\.com/);
  assert.equal(starts, 2);
  await f.post('cancel');
});


test('concurrent model syncs share one request and one revisioned mutation', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return Response.json({models: [model()]}); }});
  const first = f.post('sync');
  await started.promise;
  const second = f.post('sync');
  gate.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.equal(f.mutations.length, 1);
});

test('an empty first catalog does not create an empty provider', async t => {
  const f = await fixture(t, {fetcher: async () => Response.json({models: []})});
  assert.equal((await f.post('sync')).error, 'empty-catalog');
  assert.deepEqual(f.settings.providers, {});
  assert.equal(f.mutations.length, 0);
});

test('scheduled login cannot continue under a replaced account', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {fetcher: async () => { started.resolve(); await gate.promise; return new Response(null, {status: 302, headers: {'set-cookie': 'synthetic=1'}}); }});
  const scheduled = f.scheduled();
  await started.promise;
  f.setRecord(grant('b'));
  gate.resolve(); await scheduled;
  assert.equal(f.calls.length, 1);
});

test('cancelled OAuth completion cannot report success after an in-flight sync', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, {authorization: {begin: async request => {
    request.interaction.notify({url: 'https://auth.openai.com/oauth/authorize?state=synthetic'});
    return {status: 'authorized'};
  }}, fetcher: async () => { started.resolve(); await gate.promise; return Response.json({models: [model()]}); }});
  await f.post('start');
  const status = f.post('status');
  await started.promise;
  await f.post('cancel');
  gate.resolve();
  assert.equal((await status).status, 'error');
});

test('disposal in the final state-await microtask cannot return a successful GET', async t => {
  const f = await fixture(t, {record: null});
  let reads = 0;
  f.ctx.credentials.readRecord = async () => {
    if (++reads === 2) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => f.dispose())));
    return null;
  };
  const response = await f.request();
  assert.equal(f.removed, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'plugin-disposed'});
});

test('quota and sync errors also redact safe-looking upstream details', async t => {
  const f = await fixture(t, {fetcher: async () => { throw Error('synthetic-private-token'); }});
  assert.equal((await f.get()).quotaError, 'quota-unavailable');
  assert.equal((await f.post('sync')).error, 'sync-failed');
});

test('API errors never echo arbitrary credential service error text', async t => {
  const f = await fixture(t);
  for (const detail of ['private synthetic-token payload', 'synthetic-secret-token', 'private', 'upstream-http-private']) {
    f.ctx.credentials.readRecord = async () => { throw Error(detail); };
    const response = await f.request();
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {error: 'request-failed'});
  }
});

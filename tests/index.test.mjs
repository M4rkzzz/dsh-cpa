import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply, sameOrigin} from '../lib/index-v025.mjs';

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
  let now = NOW, record = options.record === undefined ? grant('a') : options.record, handler, activityHandler, removed = 0, nextTimer = 1;
  let upstream = options.fetcher ?? (async url => {
    if (String(url).startsWith('https://chatgpt.com/backend-api/codex/models?')) return Response.json({models: [model()]});
    assert.equal(String(url), 'https://chatgpt.com/backend-api/wham/usage');
    return quota(12);
  });
  const timers = new Map(), listeners = new Map(), calls = [], mutations = [], modelCalls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => now - NOW);
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
    llm: {
      listModels: options.listModels ?? (async () => [{id: 'gpt-configured'}]),
      stream: options.stream === null ? undefined : request => {
        modelCalls.push(request);
        const next = () => {
          assert.equal(typeof options.stream, 'function', 'model calls must be explicitly mocked');
          return options.stream(request);
        };
        const observe = listeners.get('llm/stream');
        return observe ? observe(request, next) : next();
      }
    },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
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
    webServer: {protocol: 'http:', getOrigin: () => 'http://localhost:7452'},
    connection: {authenticatedUrl: origin => origin + '/synthetic-login', fetch: {register: route => {
      if (route.path === '/api/cpa-settings') handler = route.fetch;
      else { assert.equal(route.path, '/api/cpa-activity'); activityHandler = route.fetch; }
      return () => { removed++; };
    }}},
    effect: () => {}
  };
  const dispose = apply(ctx);
  t.after(async () => {
    dispose();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(directory, {recursive: true, force: true});
  });
  const request = (body, headers = {}, method = body === undefined ? 'GET' : 'POST') => handler(new Request('http://dsh.internal/api/cpa-settings', {
    method, headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json', ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }));
  const activity = (body, headers = {}, method = body === undefined ? 'GET' : 'POST') => activityHandler(new Request('http://dsh.internal/api/cpa-activity', {
    method, headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json', ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }));
  return {ctx, calls, timers, mutations, modelCalls, listeners, settings, dispose, request, activity, raw: req => handler(req), activityRaw: req => activityHandler(req),
    setRecord: value => { record = value; }, setFetcher: value => { upstream = value; }, advance: ms => { now += ms; },
    get removed() { return removed; },
    get: async () => { const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); },
    post: async (action, body = {}) => { const response = await request({action, ...body}); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); },
    scheduled: () => [...timers.values()].find(x => x.delay === 3000).fn()
  };
}

const settleActivity = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const activityJson = async f => {
  const response = await f.activity();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
};

test('activity GET is memory-only and defaults to a disabled schedule', async t => {
  const f = await fixture(t);
  const state = await activityJson(f);
  assert.equal(state.logs.summary.total, 0);
  assert.equal(state.logs.limit, 200);
  assert.deepEqual(state.logs.entries, []);
  assert.equal(state.pelican.enabled, false);
  assert.equal(state.pelican.running, false);
  assert.equal(state.pelican.nextRunAt, null);
  assert.equal(state.pelican.prompt, '生成一张鹈鹕骑自行车的SVG');
  assert.equal(f.calls.length, 0);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.mutations.length, 0);
});

test('activity mutations enforce origin and request shape before any model work', async t => {
  const f = await fixture(t);
  let response = await f.activity({action: 'pelican-run', model: 'gpt-configured'}, {origin: 'https://attacker.invalid'});
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error, 'cross-origin-write-denied');
  response = await f.activity(undefined, {}, 'DELETE');
  assert.equal(response.status, 405);
  for (const body of [null, [], 'pelican-run', {action: 'not-an-action'}]) {
    response = await f.activity(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid-action');
  }
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.mutations.length, 0);
});

test('Fast cannot claim enabled or mutate unsupported host provider configuration', async t => {
  const f = await fixture(t);
  const state = await f.get();
  assert.deepEqual(state.fast, {available: false, enabled: false, reason: 'host-fast-unsupported'});
  const response = await f.request({action: 'fast', enabled: true});
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, 'host-fast-unsupported');
  assert.equal(f.mutations.length, 0);
  assert.equal(f.modelCalls.length, 0);
});

test('a manual pelican request is observed exactly once without a session or attachments', async t => {
  const end = deferred();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
  const f = await fixture(t, {stream: async function* () {
    yield {type: 'text-delta', index: 0, text: svg};
    await end.promise;
    yield {type: 'usage', usage: {inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 160}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  const response = await f.activity({action: 'pelican-run', model: 'gpt-configured'});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pelican.running, true);
  await settleActivity();
  assert.equal(f.modelCalls.length, 1);
  const request = f.modelCalls[0];
  assert.equal(request.provider, 'openai-codex');
  assert.equal(request.model, 'gpt-configured');
  assert.equal(request.sessionId, undefined);
  assert.deepEqual(request.tools, []);
  assert.equal(request.messages.length, 1);
  assert.deepEqual(request.messages[0].content, [{type: 'text', text: '生成一张鹈鹕骑自行车的SVG'}]);
  assert.equal(request.messages[0].source.kind, 'user');
  f.advance(100);
  end.resolve();
  await settleActivity();
  const state = await activityJson(f);
  assert.equal(state.pelican.running, false);
  assert.equal(state.pelican.lastResult.status, 'success');
  assert.equal(state.pelican.lastResult.svg, svg);
  assert.equal(state.logs.summary.total, 1);
  assert.equal(state.logs.entries.length, 1);
  const entry = state.logs.entries[0];
  assert.equal(entry.source, 'pelican');
  assert.equal(entry.status, 'success');
  assert.equal(entry.httpStatus, null);
  assert.equal(entry.inputTokens, 150);
  assert.equal(entry.outputTokens, 10);
  assert.equal(entry.cacheHitRate, 1 / 3);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mutations.length, 0);
});

test('pelican schedule configuration is explicit, delayed, and unconditionally stoppable', async t => {
  const f = await fixture(t);
  let response = await f.activity({action: 'pelican-configure', enabled: true, model: 'gpt-configured', intervalMinutes: 1});
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.equal(state.pelican.enabled, true);
  assert.equal(state.pelican.nextRunAt, new Date(NOW + 60000).toISOString());
  assert.equal(f.modelCalls.length, 0);
  response = await f.activity({action: 'pelican-configure', enabled: false, model: '', intervalMinutes: -1});
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.pelican.enabled, false);
  assert.equal(state.pelican.nextRunAt, null);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 60000), false);
  assert.equal(f.mutations.length, 0);
});

test('pelican busy, cancellation, and log clearing remain isolated from generation', async t => {
  const gate = deferred();
  const f = await fixture(t, {stream: async function* () {
    await gate.promise;
    yield {type: 'text-delta', index: 0, text: '<svg></svg>'};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  assert.equal((await f.activity({action: 'pelican-run', model: 'gpt-configured'})).status, 200);
  await settleActivity();
  const busy = await f.activity({action: 'pelican-run', model: 'gpt-configured'});
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'pelican-busy');
  assert.equal((await f.activity({action: 'logs-clear'})).status, 200);
  assert.equal((await activityJson(f)).logs.summary.total, 0);
  assert.equal((await f.activity({action: 'pelican-cancel'})).status, 200);
  await settleActivity();
  let state = await activityJson(f);
  assert.equal(state.pelican.running, false);
  assert.equal(state.pelican.lastResult.status, 'cancelled');
  assert.equal(f.modelCalls[0].signal.aborted, true);
  gate.resolve();
  await settleActivity();
  state = await activityJson(f);
  assert.equal(state.logs.summary.total, 0);
  assert.equal(state.pelican.lastResult.svg, null);
});

test('activity disposal aborts pending model validation and rejects later writes', async t => {
  const catalog = deferred();
  const f = await fixture(t, {listModels: () => catalog.promise});
  const pending = f.activity({action: 'pelican-run', model: 'gpt-configured'});
  await settleActivity();
  f.dispose();
  catalog.resolve([{id: 'gpt-configured'}]);
  assert.equal((await pending).status, 503);
  assert.equal((await f.activity()).status, 503);
  assert.equal((await f.activity({action: 'pelican-configure', enabled: true, model: 'gpt-configured', intervalMinutes: 1})).status, 503);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.removed, 2);
});

test('activity errors do not expose arbitrary catalog or provider error text', async t => {
  const f = await fixture(t, {listModels: async () => { throw Error('synthetic-private-access-token'); }});
  const response = await f.activity({action: 'pelican-run', model: 'gpt-configured'});
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes('synthetic-private-access-token'), false);
  assert.equal(JSON.parse(text).error, 'pelican-models-unavailable');
});

test('activity disposal during body parsing rejects control work before it starts', async t => {
  const f = await fixture(t), body = deferred();
  const req = new Request('http://dsh.internal/api/cpa-activity', {method: 'POST', headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json'}, body: '{}'});
  req.json = () => body.promise;
  const pending = f.activityRaw(req);
  f.dispose();
  body.resolve({action: 'pelican-run', model: 'gpt-configured'});
  assert.equal((await pending).status, 503);
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('cancel and disable supersede older control bodies that finish parsing late', async t => {
  for (const [action, stop] of [['pelican-run', 'pelican-cancel'], ['pelican-configure', 'pelican-configure']]) {
    await t.test(action, async t => {
      const f = await fixture(t), body = deferred();
      const req = new Request('http://dsh.internal/api/cpa-activity', {method: 'POST', headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json'}, body: '{}'});
      req.json = () => body.promise;
      const pending = f.activityRaw(req);
      const stopped = await f.activity({action: stop, enabled: false});
      assert.equal(stopped.status, 200);
      body.resolve({action, enabled: true, intervalMinutes: 1, model: 'gpt-configured'});
      const late = await pending;
      assert.equal(late.status, 400);
      assert.equal((await late.json()).error, 'pelican-cancelled');
      const state = await activityJson(f);
      assert.equal(state.pelican.enabled, false);
      assert.equal(state.pelican.running, false);
      assert.equal(state.pelican.nextRunAt, null);
      assert.equal(f.modelCalls.length, 0);
    });
  }
});

test('disable cancels a pending configure lookup and late catalogs cannot enable a plan', async t => {
  const catalog = deferred();
  const f = await fixture(t, {listModels: () => catalog.promise});
  const pending = f.activity({action: 'pelican-configure', enabled: true, model: 'gpt-configured', intervalMinutes: 1});
  await settleActivity();
  assert.equal((await f.activity({action: 'pelican-configure', enabled: false})).status, 200);
  const rejected = await pending;
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'pelican-cancelled');
  catalog.resolve([{id: 'gpt-configured'}]);
  await settleActivity();
  const state = await activityJson(f);
  assert.equal(state.pelican.enabled, false);
  assert.equal(state.pelican.nextRunAt, null);
  assert.equal(f.modelCalls.length, 0);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 60000), false);
});

test('activity disposal aborts an active probe and discards late provider output', async t => {
  const gate = deferred();
  const f = await fixture(t, {stream: async function* () {
    await gate.promise;
    yield {type: 'text-delta', index: 0, text: '<svg>late</svg>'};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }});
  assert.equal((await f.activity({action: 'pelican-run', model: 'gpt-configured'})).status, 200);
  await settleActivity();
  f.dispose();
  assert.equal(f.modelCalls[0].signal.aborted, true);
  gate.resolve();
  await settleActivity();
  assert.equal((await f.activity()).status, 503);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.mutations.length, 0);
});

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

const bridgeRequest = (host, origin, extra = {}, url = 'http://dsh.internal/api/cpa-settings') => new Request(url, {
  method: 'POST', headers: {host, 'content-type': 'application/json; charset=utf-8', ...(origin === undefined ? {} : {origin}), ...extra},
  body: '{}',
});

test('the exact DSH bridge origin uses trusted HTTP or HTTPS and real Host authority', () => {
  for (const [protocol, host, origin] of [
    ['http:', '127.0.0.1:1699', 'http://127.0.0.1:1699'],
    ['https:', 'localhost:7452', 'https://localhost:7452'],
    ['https:', 'cpa.example.invalid:8443', 'https://cpa.example.invalid:8443'],
    ['https:', 'cpa.example.invalid:443', 'https://cpa.example.invalid'],
    ['http:', 'localhost:80', 'http://localhost'],
    ['https:', '[::1]:7452', 'https://[::1]:7452'],
  ]) assert.equal(sameOrigin(bridgeRequest(host, origin), protocol), true, origin);
  for (const origin of ['https://localhost:7452', 'http://localhost:7453', 'http://127.0.0.1:7452', 'http://dsh.internal']) {
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', origin), 'http:'), false, origin);
  }
});

test('bridge authority reconstruction is not granted to other URL origins or unknown protocols', () => {
  for (const url of ['https://dsh.internal/api', 'http://dsh.internal:7452/api', 'http://other.internal/api', 'ftp://dsh.internal/api']) {
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'http://localhost:7452', {}, url), 'http:'), false, url);
  }
  for (const protocol of [undefined, null, '', 'http', 'https', 'ws:', 'ftp:', true, {}]) {
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'http://localhost:7452'), protocol), false);
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', undefined), protocol), false);
  }
  assert.equal(sameOrigin(bridgeRequest('attacker.invalid', 'http://attacker.invalid', {}, 'http://localhost:7452/api'), 'http:'), false);
  assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'http://localhost:7452', {}, 'http://localhost:7452/api')), true);
});

test('bridge checks reject malformed Host and Origin before URL normalization can hide delimiters', () => {
  for (const host of ['', 'localhost:7452/', 'localhost:7452/path', 'localhost:7452?', 'localhost:7452#',
    'user@localhost:7452', '@localhost:7452', 'localhost:7452\\path', 'localhost:7452,evil.invalid',
    'localhost:7452;foo', 'localhost :7452', 'localhost:', ':7452', 'localhost:99999', 'http://localhost:7452']) {
    assert.equal(sameOrigin(bridgeRequest(host, 'http://localhost:7452'), 'http:'), false, host);
  }
  for (const origin of ['null', '', 'http://user@localhost:7452', 'http://@localhost:7452',
    'http://localhost:7452/path', 'http://localhost:7452/../', 'http://localhost:7452?',
    'http://localhost:7452#', 'http://localhost:7452/#', 'http://localhost:7452\\',
    'http://localhost:7452 http://attacker.invalid', 'http://localhost:7452,https://attacker.invalid']) {
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', origin), 'http:'), false, origin);
  }
});

test('untrusted forwarded headers cannot establish or change the real origin', () => {
  const spoof = {'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.invalid', forwarded: 'for=127.0.0.1;proto=https;host=attacker.invalid'};
  assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'http://localhost:7452', spoof), 'http:'), true);
  assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'https://attacker.invalid', spoof), 'http:'), false);
  assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'https://localhost:7452', spoof), 'http:'), false);
  assert.equal(sameOrigin(bridgeRequest('localhost:7452', 'http://localhost:7452', {'x-forwarded-proto': 'http'})), false);
});

test('missing-Origin bridge requests require real loopback Host plus JSON and non-cross-site context', () => {
  for (const host of ['localhost:7452', '127.0.0.1:1699', '[::1]:7452']) {
    for (const protocol of ['http:', 'https:']) assert.equal(sameOrigin(bridgeRequest(host, undefined), protocol), true, host);
  }
  for (const host of ['dsh.internal', 'cpa.example.invalid', '192.168.1.2:7452']) {
    assert.equal(sameOrigin(bridgeRequest(host, undefined, {'x-forwarded-host': 'localhost:7452'}), 'http:'), false, host);
  }
  for (const headers of [{'content-type': 'text/plain'}, {'content-type': ''}, {'sec-fetch-site': 'cross-site'}, {'sec-fetch-site': 'same-site'}]) {
    assert.equal(sameOrigin(bridgeRequest('localhost:7452', undefined, headers), 'http:'), false);
  }
});

test('both POST routes accept the HTTPS bridge and reject scheme port and forwarded spoofing', async t => {
  const f = await fixture(t);
  f.ctx.webServer.protocol = 'https:';
  for (const [send, action] of [[f.request, 'cancel'], [f.activity, 'logs-clear']]) {
    assert.equal((await send({action}, {origin: 'https://localhost:7452'})).status, 200);
    for (const headers of [
      {origin: 'http://localhost:7452'}, {origin: 'https://localhost:7453'},
      {host: 'localhost:7453', origin: 'https://localhost:7452'},
      {origin: 'http://localhost:7452', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost:7452'},
    ]) assert.equal((await send({action}, headers)).status, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0); assert.equal(f.mutations.length, 0);
});

test('both POST routes fail closed when a bridge has no trustworthy service protocol', async t => {
  const f = await fixture(t);
  for (const protocol of [undefined, null, 'http', 'ftp:']) {
    f.ctx.webServer.protocol = protocol;
    for (const [send, action] of [[f.request, 'cancel'], [f.activity, 'logs-clear']]) {
      const response = await send({action}, {'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost:7452'});
      assert.equal(response.status, 403); assert.equal((await response.json()).error, 'cross-origin-write-denied');
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0); assert.equal(f.mutations.length, 0);
});

test('both POST routes retain missing-Origin loopback support without treating dsh.internal as local', async t => {
  const f = await fixture(t);
  for (const [raw, action, path] of [[f.raw, 'cancel', 'cpa-settings'], [f.activityRaw, 'logs-clear', 'cpa-activity']]) {
    for (const [host, status] of [['localhost:7452', 200], ['dsh.internal', 403], ['example.invalid', 403]]) {
      const req = new Request('http://dsh.internal/api/' + path, {method: 'POST', headers: {host, 'content-type': 'application/json'}, body: JSON.stringify({action})});
      assert.equal((await raw(req)).status, status, host);
    }
  }
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
  assert.equal(f.removed, 2);
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
  assert.equal(f.removed, 2);
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

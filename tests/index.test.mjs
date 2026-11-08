import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as zlib from 'node:zlib';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createCpaApp, Config, sameOrigin} from '../lib/index-v026.mjs';
import {createAccounts} from '../lib/accounts-v026.mjs';
import {createCpaTransport} from '../lib/transport-v026.mjs';

const MODEL = 'gpt-5.5', A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const NATIVE_KEY = 'llm-pi-ai/openai-codex';
const provider = id => 'cpa-codex-' + id;
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const token = (id, version = 1) => 'synthetic.' + Buffer.from(JSON.stringify({sub: 'subject-' + id, email: id + '@example.test', version,
  'https://api.openai.com/auth': {chatgpt_account_id: 'upstream-' + id, chatgpt_user_id: 'subject-' + id}})).toString('base64url') + '.signature';
const grant = (id, version = 1) => ({kind: 'grant', payload: {type: 'oauth', access: token(id, version),
  refresh: 'synthetic-refresh-' + id, expires: Date.now() + 3600000, accountId: 'upstream-' + id}});
const owned = (id, principal = id) => {
  const record = grant(principal), principalHash = createHash('sha256').update(JSON.stringify(['upstream-' + principal, 'subject-' + principal])).digest('hex');
  record.payload.cpaBinding = {version: 1, id, principalHash}; return record;
};
const quota = used => Response.json({plan_type: 'plus', rate_limit: {
  primary_window: {used_percent: used, limit_window_seconds: 18000},
  secondary_window: {used_percent: used / 2, limit_window_seconds: 604800},
}});
const catalogModel = (slug = 'gpt-6-synthetic') => ({slug, display_name: slug, visibility: 'list', context_window: 100000,
  input_modalities: ['text'], supported_reasoning_levels: [{effort: 'medium'}]});
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="orange"/></svg>';
function modelResponse(text = SVG, extra = {}) {
  const item = {id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text, annotations: []}]};
  const response = {id: 'resp_synthetic', status: 'completed', model: MODEL, output: [item], service_tier: 'default',
    usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: {cached_tokens: 20, cache_write_tokens: 0}}, ...extra};
  const events = [{type: 'response.created', response: {id: response.id}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, content: []}},
    {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text},
    {type: 'response.output_item.done', output_index: 0, item}, {type: 'response.completed', response}];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
    status: 200, headers: {'content-type': 'text/event-stream'},
  });
}
function decodeBody(init) {
  const bytes = Buffer.from(init.body);
  return JSON.parse((new Headers(init.headers).get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8'));
}
function png() {
  const table = Uint32Array.from({length: 256}, (_, i) => {let c = i; for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0;});
  const chunk = (type, bytes) => {
    const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(type, 4); bytes.copy(result, 8);
    let crc = 0xffffffff; for (const v of result.subarray(4, -4)) crc = table[(crc ^ v) & 255] ^ crc >>> 8;
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(1024, 0); head.writeUInt32BE(1024, 4); head[8] = 8; head[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((1024 * 4 + 1) * 1024))), chunk('IEND', Buffer.alloc(0))]));
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cpa-index-v026-'));
  const ctx = new Context(), llm = new LlmRuntime(ctx), routes = new Map(), calls = [], modelCalls = [], settingsWrites = [], locks = new Map();
  const records = options.records ?? new Map([[NATIVE_KEY, grant('native-a')]]);
  let clock = Date.now(), removed = 0, raw = structuredClone(options.preferences ?? {}), revision = 0;
  let fetcher = options.fetcher ?? (async (url, init) => String(url).includes('/codex/models?')
    ? Response.json({models: [catalogModel()]}) : quota(init.headers['ChatGPT-Account-Id']?.endsWith('native-b') ? 84 : 12));
  const config = Config(raw), flows = new Map();
  const credentials = {
    async listRecords() {return [...records].map(([key, value]) => ({key, kind: value.kind}));},
    async readRecord(key) {await options.beforeCredentialRead?.(key); return records.has(key) ? structuredClone(records.get(key)) : undefined;},
    modifyRecord(key, transform) {
      const previous = locks.get(key) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        const current = records.has(key) ? structuredClone(records.get(key)) : undefined;
        const next = await transform(current);
        if (next !== undefined) {records.set(key, structuredClone(next)); ctx.emit('credentials/record-updated', key);}
        return records.has(key) ? structuredClone(records.get(key)) : undefined;
      });
      locks.set(key, task.catch(() => {})); return task;
    },
    deleteRecord(key) {return this.modifyRecord(key, () => {records.delete(key); ctx.emit('credentials/record-updated', key);});},
  };
  ctx.provide('credentials', credentials);
  ctx.provide('authorization', {
    registerFlow(flow) {assert.match(flow.key, /^cpa-codex\//); flows.set(flow.key, flow); return () => flows.delete(flow.key);},
    async begin(request) {const flow = flows.get(request.key); assert.ok(flow, 'the independent account flow must own its exact key');
      await flow.run({key: request.key, method: request.method, signal: request.signal,
        notify: request.interaction.notify, prompt: request.interaction.prompt});
      return {status: 'authorized'};},
  });
  ctx.provide('profileContext', {dir: directory});
  ctx.provide('webServer', {protocol: 'http:'});
  ctx.provide('connection', {fetch: {register(route) {
    assert.equal(route.requestBody, 'buffered'); assert.equal(Object.hasOwn(route, 'public'), false);
    routes.set(route.path, route); return () => {removed++;};
  }}});
  ctx.provide('settings', {
    describe() {return [{ns: 'cpa-settings', value: structuredClone(raw), revision}];},
    configure() {return () => {};},
    async mutate(ns, ops, expected) {
      assert.equal(ns, 'cpa-settings'); assert.equal(expected, revision);
      await options.beforeSettingsWrite?.(ops);
      for (const op of ops) {
        let target = raw;
        for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
        if (op.op === 'unset') delete target[op.path.at(-1)];
        else target[op.path.at(-1)] = structuredClone(op.value);
      }
      Object.assign(config, Config(raw));
      await writeFile(join(directory, 'preferences.json'), JSON.stringify(raw));
      settingsWrites.push(structuredClone(ops)); revision++;
      ctx.emit('settings/document-updated', 'cpa-settings', revision);
    },
  });
  class Host extends LlmAdapter {async *stream() {yield {type: 'finish', reason: {kind: 'stop'}};}}
  const host = new Host(), offHost = llm.registerAdapter(['openai-codex'], host);
  const renderCalls = [], renderer = options.renderer ?? {
    render(svg, {signal}) {renderCalls.push({svg, signal}); return Promise.resolve(png());}, dispose() {},
  };
  let accountManager;
  if (options.decorateAccounts) {accountManager = createAccounts(ctx, options.accountOptions); options.decorateAccounts(accountManager);}
  const app = createCpaApp(ctx, config, {schedule: false, now: () => clock, renderer,
    ...(accountManager ? {accounts: accountManager} : {}),
    accountOptions: options.accountOptions,
    fetchImpl: async (url, init) => {calls.push({url: String(url), init}); return fetcher(url, init);},
    catalogOptions: {readClientMetadata: async () => JSON.stringify({client_version: '0.165.0'})},
    transportOptions: {fetchImpl: async (url, init) => {const call = {url: String(url), init, body: decodeBody(init)}; modelCalls.push(call);
      return options.modelFetch ? options.modelFetch(call) : modelResponse();}},
    ...(options.appOptions ?? {}),
  });
  t.after(async () => {await app.dispose(); offHost(); await rm(directory, {recursive: true, force: true});});
  await app.ready;
  const send = (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
    const request = new Request('http://dsh.internal' + path, {method,
      headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    return routes.get(new URL(request.url).pathname).fetch(request);
  };
  const get = async () => {const response = await send('/api/cpa-settings'); assert.equal(response.status, 200, await response.clone().text()); return response.json();};
  const activity = async query => {const response = await send('/api/cpa-activity' + (query ?? '')); assert.equal(response.status, 200, await response.clone().text()); return response.json();};
  return {ctx, llm, app, records, directory, calls, modelCalls, renderCalls, settingsWrites, routes, flows, get, activity, send, host,
    setFetcher: value => {fetcher = value;}, advance: ms => {clock += ms;}, get removed() {return removed;},
    async setNative(value) {if (value) records.set(NATIVE_KEY, value); else records.delete(NATIVE_KEY); await ctx.emit('credentials/record-updated', NATIVE_KEY);},
  };
}
async function settle(f, id, count = 1) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await f.send('/api/cpa-history?accountId=' + encodeURIComponent(id));
    const history = await response.json();
    if (history.images?.length === count) return history;
    await tick();
  }
  assert.fail('expected the synthetic probe to produce its PNG history');
}
function delayedBody(f, path, body) {
  let controller;
  const stream = new ReadableStream({start(value) {controller = value;}});
  const request = new Request('http://dsh.internal' + path, {method: 'POST', duplex: 'half', body: stream,
    headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json'}});
  return {response: f.routes.get(path).fetch(request), finish() {try {controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close();} catch { /* body may have been cancelled by disposal */ }}};
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


test('settings publishes only real isolated accounts and no credential data', async t => {
  const f = await fixture(t, {records: new Map([[NATIVE_KEY, grant('native-a')], ['cpa-codex/' + B, owned(B)]])});
  const state = await f.get();
  assert.equal(state.accounts.length, 2);
  assert.deepEqual(new Set(state.accounts.map(a => a.email)), new Set(['native-a@example.test', B + '@example.test']));
  assert.ok(state.accounts.every(a => a.availability === 'ready' && a.models.includes(MODEL)));
  assert.equal(state.accounts.filter(a => a.enabled).length, 1);
  assert.equal(state.accounts.filter(a => a.canRunProbe).length, 1);
  assert.equal(state.accounts.find(a => a.enabled).owned, false);
  assert.deepEqual(state.fast.providers, [state.accounts.find(a => a.enabled).provider]);
  assert.equal(state.fast.available, true); assert.equal(state.fast.enabled, false);
  assert.equal(state.preferences.fastEnabled, false);
  assert.equal(state.accounts[0].quota.windows.length, 2);
  assert.equal(f.modelCalls.length, 0);
  for (const secret of ['synthetic-refresh', '.signature', 'principalHash', 'cpaBinding', NATIVE_KEY]) assert.equal(JSON.stringify(state).includes(secret), false, secret);
});

test('activity reads persistent metadata but never initiates a model or enables a schedule', async t => {
  const f = await fixture(t);
  const data = await f.activity();
  assert.equal(data.logs.storage.available, true); assert.equal(data.logs.persistent, true);
  assert.deepEqual(data.logs.entries, []); assert.equal(data.logs.page.nextCursor, null);
  assert.equal(data.accounts[0].pelican.intervalMinutes, 0); assert.equal(data.accounts[0].pelican.running, false);
  assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0); assert.equal(f.settingsWrites.length, 0);
});

test('Fast is an acknowledged durable preference and changes the actual owned request body', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  const before = await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL});
  assert.equal(before.status, 200); await settle(f, id);
  assert.equal(Object.hasOwn(f.modelCalls[0].body, 'service_tier'), false);
  const ack = await f.send('/api/cpa-settings', {action: 'fast', enabled: true});
  assert.equal(ack.status, 200); assert.equal((await ack.json()).fast.enabled, true);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'preferences.json'), 'utf8')).fastEnabled, true);
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL}); await settle(f, id, 2);
  assert.equal(f.modelCalls[1].body.service_tier, 'priority');
  assert.ok(f.settingsWrites.every(ops => ops.every(op => ['fastEnabled', 'plans', 'activeAccountId'].includes(op.path[0]))));
});

test('manual probes cross the real SDK once with fixed prompt and PNG-only account history', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL})).status, 200);
  const history = await settle(f, id), image = history.images[0];
  assert.equal(image.width, 1024); assert.equal(image.height, 1024);
  assert.equal(f.modelCalls.length, 1); assert.equal(f.renderCalls.length, 1);
  assert.equal(JSON.stringify(f.modelCalls[0].body).includes('生成一张鹈鹕骑自行车的SVG'), true);
  assert.equal(f.modelCalls[0].body.tools?.length ?? 0, 0);
  assert.equal(f.modelCalls[0].body.store, false);
  assert.equal(Object.hasOwn(f.modelCalls[0].body, 'conversation'), false);
  const response = await f.send(image.url);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png());
  const activity = await f.activity();
  assert.equal(activity.logs.entries.length, 1);
  const row = activity.logs.entries[0];
  assert.equal(row.source, 'pelican'); assert.equal(row.accountId, id); assert.equal(row.accountEmail, 'native-a@example.test');
  assert.equal(row.httpStatus, 200); assert.equal(row.usageEvidence, 'provider'); assert.equal(row.finishReason, 'stop');
  assert.equal(row.inputTokens, 100); assert.equal(row.outputTokens, 20); assert.equal(row.cacheReadTokens, 20); assert.equal(row.cacheWriteTokens, 0);
  assert.equal(Object.hasOwn(row, 'endedAt'), false);
  const text = await readFile(join(f.directory, '.dsh-cpa', 'activity.ndjson'), 'utf8');
  for (const value of ['<svg', '生成一张', 'synthetic-refresh', '.signature', 'endedAt']) assert.equal(text.includes(value), false, value);
  assert.equal(text.trim().split('\n').length, 1);
  assert.deepEqual((await readdir(join(f.directory, '.dsh-cpa'))).sort(), ['activity.ndjson']);
});

test('per-account image endpoints reject a different account and unknown identities', async t => {
  const f = await fixture(t, {records: new Map([[NATIVE_KEY, grant('native-a')], ['cpa-codex/' + B, owned(B)]])});
  const accounts = (await f.get()).accounts, id = accounts.find(a => !a.owned).id;
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL});
  const image = (await settle(f, id)).images[0];
  assert.equal((await f.send('/api/cpa-image?accountId=' + B + '&imageId=' + image.id)).status, 404);
  assert.equal((await f.send('/api/cpa-image?accountId=missing&imageId=' + image.id)).status, 404);
  assert.equal((await f.send('/api/cpa-image?accountId=' + id + '&imageId=../secret')).status, 404);
  assert.equal((await f.send('/api/cpa-history?accountId=missing')).status, 404);
});

test('deleting an owned account clears its plans, selection, route and PNG history only', async t => {
  const f = await fixture(t, {records: new Map([[NATIVE_KEY, grant('native-a')], ['cpa-codex/' + B, owned(B)]]),
    preferences: {activeAccountId: B, plans: {[B]: {intervalMinutes: 0, model: MODEL}}}});
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: B, model: MODEL});
  const image = (await settle(f, B)).images[0];
  const response = await f.send('/api/cpa-settings', {action: 'account-remove', accountId: B});
  assert.equal(response.status, 200); const state = await response.json();
  assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0].owned, false);
  assert.equal(state.preferences.activeAccountId, ''); assert.equal(Object.hasOwn(state.preferences.plans, B), false);
  assert.equal(f.records.has('cpa-codex/' + B), false); assert.equal(f.records.has(NATIVE_KEY), true);
  assert.equal((await f.send(image.url)).status, 404);
});

test('the host-owned native grant cannot be deleted through CPA', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  const response = await f.send('/api/cpa-settings', {action: 'account-remove', accountId: id});
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), {error: 'account-delete-forbidden'});
  assert.equal(f.records.has(NATIVE_KEY), true);
});

test('configuring an interval persists it but waits the full period without a charged call', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id, before = Date.now();
  const response = await f.send('/api/cpa-activity', {action: 'pelican-configure', accountId: id, intervalMinutes: 5, model: MODEL});
  assert.equal(response.status, 200); const activity = await response.json();
  const state = activity.accounts.find(a => a.id === id).pelican;
  assert.equal(state.intervalMinutes, 5); assert.equal(state.running, false);
  assert.ok(Date.parse(state.nextRunAt) >= before + 5 * 60000);
  assert.equal(f.modelCalls.length, 0);
  assert.equal((await f.get()).preferences.plans[id].intervalMinutes, 5);
  const off = await f.send('/api/cpa-activity', {action: 'pelican-configure', accountId: id, intervalMinutes: 0});
  assert.equal(off.status, 200); assert.equal((await off.json()).accounts.find(a => a.id === id).pelican.nextRunAt, null);
});

test('off and stop supersede control bodies that entered before them', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  for (const action of ['pelican-cancel', 'pelican-configure']) {
    const delayed = delayedBody(f, '/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL});
    assert.equal((await f.send('/api/cpa-activity', {action, accountId: id, intervalMinutes: 0})).status, 200);
    delayed.finish();
    const response = await delayed.response;
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), {error: 'pelican-cancelled'});
  }
  assert.equal(f.modelCalls.length, 0);
});

test('stopping account B does not supersede an earlier account A request', async t => {
  const f = await fixture(t, {records: new Map([[NATIVE_KEY, grant('native-a')], ['cpa-codex/' + B, owned(B)]])});
  const id = (await f.get()).accounts.find(a => !a.owned).id;
  const delayed = delayedBody(f, '/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL});
  assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-cancel', accountId: B})).status, 200);
  delayed.finish(); assert.equal((await delayed.response).status, 200); await settle(f, id);
  assert.equal(f.modelCalls.length, 1);
});

test('body parsing after disposal cannot start control work', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  const delayed = delayedBody(f, '/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL});
  await f.app.dispose(); delayed.finish();
  assert.equal((await delayed.response).status, 503); assert.equal(f.modelCalls.length, 0);
});

test('unsupported schedule values and invalid account/model values never make a model request', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  for (const intervalMinutes of [-1, 1, 60, '5', null]) {
    const response = await f.send('/api/cpa-activity', {action: 'pelican-configure', accountId: id, intervalMinutes, model: MODEL});
    assert.equal(response.status, 400);
  }
  for (const accountId of ['', '../secret', 'email@example.test', '__proto__']) assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-run', accountId, model: MODEL})).status, 400);
  assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: 'does-not-exist'})).status, 400);
  assert.equal(f.modelCalls.length, 0);
});

test('quota cache is isolated by principal and retains only an explicitly stale same-account observation', async t => {
  const f = await fixture(t);
  const original = await f.get(); await f.get(); assert.equal(f.calls.length, 1);
  f.advance(61000); f.setFetcher(async () => new Response(null, {status: 503}));
  const stale = await f.get(); assert.deepEqual(stale.accounts[0].quota, original.accounts[0].quota);
  assert.equal(stale.accounts[0].quotaStale, true); assert.equal(stale.accounts[0].quotaError, 'upstream-http-503');
  await f.setNative(grant('native-b'));
  const replaced = await f.get(); assert.notEqual(replaced.accounts[0].id, original.accounts[0].id);
  assert.equal(replaced.accounts[0].quota, null); assert.equal(replaced.accounts[0].quotaError, 'upstream-http-503');
});

test('credential removal clears the account row; same-principal token rotation keeps identity safely', async t => {
  const f = await fixture(t), first = await f.get();
  await f.setNative(grant('native-a', 2)); const rotated = await f.get();
  assert.equal(rotated.accounts[0].id, first.accounts[0].id); assert.equal(rotated.accounts[0].email, first.accounts[0].email);
  await f.setNative(null); const removed = await f.get();
  assert.equal(removed.online, false); assert.deepEqual(removed.accounts, []); assert.equal(removed.fast.available, false);
});

test('concurrent state reads share one real quota fetch', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {fetcher: async () => {entered.resolve(); await gate.promise; return quota(30);}});
  const first = f.get(); await entered.promise;
  const second = f.get(); gate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(f.calls.length, 1); assert.deepEqual(results[0].accounts, results[1].accounts);
});

test('late old-account quota is discarded even if its fetch ignores abort', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {fetcher: async (_url, init) => {
    if (init.headers['ChatGPT-Account-Id'] === 'upstream-native-a') {entered.resolve(); await gate.promise; return quota(1);}
    return quota(90);
  }});
  const older = f.get(); await entered.promise; await f.setNative(grant('native-b'));
  const current = await f.get(); gate.resolve();
  assert.equal(current.accounts[0].quota.windows[0].used, 90);
  const previous = await older; assert.equal(previous.accounts[0].quota.windows[0].used, 90);
});

test('catalog sync adds reliable account models without mutating native host settings or defaults', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  const result = await f.send('/api/cpa-settings', {action: 'sync', accountId: id});
  assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.status, 'ok');
  assert.ok(data.added.includes('gpt-6-synthetic'));
  const state = await f.get(); assert.ok(state.accounts[0].models.includes('gpt-6-synthetic')); assert.ok(state.accounts[0].models.includes(MODEL));
  assert.equal(f.settingsWrites.length, 0); assert.equal(f.modelCalls.length, 0);
});

test('invalid and empty catalogs leave the owned route untouched', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  f.setFetcher(async () => Response.json({models: []}));
  assert.equal((await (await f.send('/api/cpa-settings', {action: 'sync', accountId: id})).json()).error, 'empty-catalog');
  f.setFetcher(async () => Response.json({unexpected: true}));
  assert.equal((await (await f.send('/api/cpa-settings', {action: 'sync', accountId: id})).json()).error, 'invalid-catalog');
  assert.ok((await f.get()).models.includes(MODEL)); assert.equal(f.modelCalls.length, 0);
});

test('late catalogs cannot update a replaced account and concurrent sync is deduplicated', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id, gate = deferred(), entered = deferred();
  f.setFetcher(async () => {entered.resolve(); await gate.promise; return Response.json({models: [catalogModel()]});});
  const first = f.send('/api/cpa-settings', {action: 'sync', accountId: id}); await entered.promise;
  const second = f.send('/api/cpa-settings', {action: 'sync', accountId: id});
  await tick(); await f.setNative(grant('native-b')); gate.resolve();
  const results = await Promise.all([first, second]);
  assert.ok((await results[0].json()).error); assert.ok((await results[1].json()).error);
  assert.equal(f.calls.filter(call => call.url.includes('/codex/models')).length, 1);
});

test('logs persist across plugin restart while per-account PNG history does not', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL}); await settle(f, id);
  await f.activity(); await f.app.dispose();
  const ctx = f.ctx, newRoutes = new Map();
  const oldRegister = ctx.connection.fetch.register;
  ctx.connection.fetch.register = route => {newRoutes.set(route.path, route); return () => {};};
  const app = createCpaApp(ctx, Config({}), {schedule: false, renderer: {render() {throw Error('unexpected');}, dispose() {}}, fetchImpl: async () => quota(5)});
  t.after(async () => {await app.dispose(); ctx.connection.fetch.register = oldRegister;});
  await app.ready;
  const response = await newRoutes.get('/api/cpa-activity').fetch(new Request('http://dsh.internal/api/cpa-activity'));
  assert.equal(response.status, 200); const restored = await response.json();
  assert.equal(restored.logs.entries.length, 1); assert.equal(restored.logs.summary.total, 1);
  assert.equal(restored.accounts[0].pelican.historyCount, 0);
});

test('logs export streams only displayed metadata and manual clear invalidates old cursors', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id;
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: id, model: MODEL}); await settle(f, id);
  const exported = await f.send('/api/cpa-logs-export?source=pelican');
  assert.equal(exported.status, 200); assert.match(exported.headers.get('content-type'), /ndjson/);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const text = await exported.text(); assert.equal(text.trim().split('\n').length, 1);
  for (const bad of ['endedAt', '<svg', '生成一张', 'synthetic-refresh', '.signature']) assert.equal(text.includes(bad), false, bad);
  const cleared = await f.send('/api/cpa-activity', {action: 'logs-clear'});
  assert.equal(cleared.status, 200); assert.deepEqual((await cleared.json()).logs.entries, []);
  assert.equal((await f.activity()).logs.summary.total, 0);
  assert.equal((await f.send('/api/cpa-logs-export')).status, 200);
});

test('invalid log filters/cursors and arbitrary errors return only fixed safe codes', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/api/cpa-activity?cursor=not-a-valid-cursor')).status, 409);
  assert.deepEqual(await (await f.send('/api/cpa-activity?status=private')).json(), {error: 'log-store-invalid-filter'});
  f.ctx.credentials.readRecord = async () => {throw Error('synthetic-private-access-token');};
  const response = await f.send('/api/cpa-settings');
  assert.notEqual(response.status, 200); assert.equal((await response.text()).includes('synthetic-private'), false);
});

test('a transport import/initialization failure does not claim working Fast or remove base routes', async t => {
  const f = await fixture(t, {appOptions: {transportFactory: () => {throw Error('private internal failure');}}});
  const state = await f.get(); assert.equal(state.fast.available, false); assert.equal(state.fast.enabled, false);
  assert.equal(state.transportError, 'cpa-transport-unavailable'); assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0].canRunProbe, false);
  const response = await f.send('/api/cpa-settings', {action: 'fast', enabled: true});
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('private'), false);
});

test('no configured account cannot be falsely enabled for Fast', async t => {
  const f = await fixture(t, {records: new Map()});
  const response = await f.send('/api/cpa-settings', {action: 'fast', enabled: true});
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), {error: 'cpa-account-unavailable'});
  assert.equal((await f.get()).fast.enabled, false);
});

test('write routes reject origins, malformed actions, oversized JSON, and invalid UTF-8 before model work', async t => {
  const f = await fixture(t);
  for (const path of ['/api/cpa-settings', '/api/cpa-activity']) {
    assert.equal((await f.send(path, {action: 'cancel'}, {origin: 'https://localhost:7452'})).status, 403);
    for (const body of [null, [], {action: 'unknown'}]) assert.equal((await f.send(path, body)).status, 400);
    assert.equal((await f.send(path, undefined, {}, 'DELETE')).status, 405);
    assert.equal((await f.send(path, {action: 'unknown', extra: 'x'.repeat(17000)})).status, 400);
    const request = new Request('http://dsh.internal' + path, {method: 'POST', body: new Uint8Array([0xff]),
      headers: {host: 'localhost:7452', origin: 'http://localhost:7452', 'content-type': 'application/json'}});
    assert.equal((await f.routes.get(path).fetch(request)).status, 400);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0);
});

test('both POST routes accept the real HTTPS bridge and reject forwarded origin spoofing', async t => {
  const f = await fixture(t); f.ctx.webServer.protocol = 'https:';
  for (const [path, action] of [['/api/cpa-settings', 'cancel'], ['/api/cpa-activity', 'logs-clear']]) {
    assert.equal((await f.send(path, {action}, {origin: 'https://localhost:7452'})).status, 200);
    for (const headers of [{origin: 'http://localhost:7452'}, {origin: 'https://localhost:7453'},
      {host: 'localhost:7453', origin: 'https://localhost:7452'},
      {origin: 'http://localhost:7452', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost:7452'}]) {
      assert.equal((await f.send(path, {action}, headers)).status, 403);
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.modelCalls.length, 0);
});

test('both POST routes reject unknown bridge protocol and non-loopback missing-Origin writes', async t => {
  const f = await fixture(t);
  for (const protocol of [undefined, null, 'http', 'ftp:']) {
    f.ctx.webServer.protocol = protocol;
    for (const [path, action] of [['/api/cpa-settings', 'cancel'], ['/api/cpa-activity', 'logs-clear']]) assert.equal((await f.send(path, {action})).status, 403);
  }
  f.ctx.webServer.protocol = 'http:';
  for (const [path, action] of [['/api/cpa-settings', 'cancel'], ['/api/cpa-activity', 'logs-clear']]) {
    for (const [host, expected] of [['localhost:7452', 200], ['dsh.internal', 403], ['example.invalid', 403]]) {
      const req = new Request('http://dsh.internal' + path, {method: 'POST', headers: {host, 'content-type': 'application/json'}, body: JSON.stringify({action})});
      assert.equal((await f.routes.get(path).fetch(req)).status, expected);
    }
  }
});

test('disposal aborts metadata IO, removes exactly the registered routes, and rejects late replies', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {fetcher: async () => {entered.resolve(); await gate.promise; return quota(9);}});
  const response = f.send('/api/cpa-settings'); await entered.promise;
  const first = f.app.dispose(), second = f.app.dispose(); assert.equal(first, second);
  assert.equal(f.calls[0].init.signal.aborted, true); assert.equal(f.removed, 5);
  gate.resolve(); assert.equal((await response).status, 503);
  await first; assert.equal((await f.send('/api/cpa-settings')).status, 503);
});

test('disposal prevents an in-flight account catalog from changing a route', async t => {
  const f = await fixture(t), id = (await f.get()).accounts[0].id, gate = deferred(), entered = deferred();
  f.setFetcher(async () => {entered.resolve(); await gate.promise; return Response.json({models: [catalogModel()]});});
  const response = f.send('/api/cpa-settings', {action: 'sync', accountId: id}); await entered.promise;
  const disposing = f.app.dispose(); assert.equal(f.calls.at(-1).init.signal.aborted, true); gate.resolve();
  assert.equal((await response).status, 503); await disposing;
});

test('OAuth API adds independent accounts without replacing the native grant and cancellation can restart', async t => {
  const pending = [];
  const f = await fixture(t, {accountOptions: {loadOAuth: async () => ({login({notify, prompt, signal}) {
    notify({type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=synthetic&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'});
    const result = prompt({type: 'manual_code', message: 'callback', signal}).then(() => grant('new-account').payload);
    pending.push(result); return result;
  }})}});
  const original = structuredClone(f.records.get(NATIVE_KEY));
  const start = await f.send('/api/cpa-settings', {action: 'start'}); assert.equal(start.status, 200); assert.match((await start.json()).url, /^https:\/\/auth\.openai\.com/);
  assert.equal((await (await f.send('/api/cpa-settings', {action: 'status'})).json()).status, 'wait');
  assert.equal((await f.send('/api/cpa-settings', {action: 'cancel'})).status, 200);
  assert.equal((await f.send('/api/cpa-settings', {action: 'start'})).status, 200);
  assert.equal((await f.send('/api/cpa-settings', {action: 'callback', redirectURL: 'http://localhost:1455/auth/callback?state=synthetic&code=synthetic-code'})).status, 200);
  for (let n = 0; n < 30; n++) {if ((await (await f.send('/api/cpa-settings', {action: 'status'})).json()).status === 'ok') break; await tick();}
  const state = await f.get(); assert.equal(state.accounts.length, 2); assert.ok(state.accounts.some(a => a.email === 'new-account@example.test'));
  assert.deepEqual(f.records.get(NATIVE_KEY), original);
  assert.ok([...f.records.keys()].some(key => key.startsWith('cpa-codex/'))); assert.equal(f.modelCalls.length, 0);
  await Promise.allSettled(pending);
});

const consume = async stream => {const result = []; for await (const chunk of stream) result.push(chunk); return result;};
const conversation = (prepared, text = 'synthetic policy test') => prepared.stream({model: MODEL,
  messages: [{role: 'user', content: [{type: 'text', text}]}], tools: [], ...prepared.config});
const twoOwned = () => new Map([['cpa-codex/' + A, owned(A)], ['cpa-codex/' + B, owned(B)]]);

test('only one persisted account is enabled; inactive requests and late prepared calls perform zero model IO', async t => {
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}});
  const old = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  await assert.rejects(f.llm.prepareCall({provider: provider(B), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE'});
  const switched = await f.send('/api/cpa-settings', {action: 'account-select', accountId: B});
  assert.equal(switched.status, 200); const state = await switched.json();
  assert.deepEqual(state.accounts.filter(row => row.enabled).map(row => row.id), [B]);
  assert.deepEqual(state.fast.providers, [provider(B)]);
  const denied = await consume(conversation(old));
  assert.equal(denied.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.modelCalls.length, 0);
  const saved = JSON.parse(await readFile(join(f.directory, 'preferences.json'), 'utf8'));
  assert.equal(saved.activeAccountId, B);
  const restarted = await fixture(t, {records: twoOwned(), preferences: saved});
  assert.deepEqual((await restarted.get()).accounts.filter(row => row.enabled).map(row => row.id), [B]);
});

test('explicitly saved empty account selection never falls back to the native host account', async t => {
  const f = await fixture(t, {preferences: {activeAccountId: ''}}), state = await f.get();
  assert.equal(state.accounts.length, 1); assert.ok(state.accounts.every(row => !row.enabled && !row.canRunProbe));
  assert.equal(state.fast.available, false); assert.equal(state.preferences.activeAccountId, '');
  const response = await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: state.accounts[0].id, model: MODEL});
  assert.equal(response.status, 409); assert.equal((await response.json()).error, 'pelican-account-inactive'); assert.equal(f.modelCalls.length, 0);
});

test('clearing visible logs cannot bypass an active ordinary conversation lock for switching or removal', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}, modelFetch: () => {entered.resolve(); return gate.promise;}});
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  const work = consume(conversation(prepared)); await entered.promise;
  try {
    assert.equal((await f.send('/api/cpa-activity', {action: 'logs-clear'})).status, 200);
    assert.equal((await f.activity()).logs.summary.running, 0);
    for (const action of ['account-select', 'account-remove']) {
      const response = await f.send('/api/cpa-settings', {action, accountId: action === 'account-select' ? B : A});
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'account-switch-busy');
    }
    assert.equal(f.records.has('cpa-codex/' + A), true);
  } finally {gate.resolve(modelResponse()); await work;}
  assert.equal((await f.send('/api/cpa-settings', {action: 'account-select', accountId: B})).status, 200);
});

test('active removal closes the gate before awaiting its credential deletion, including old prepared calls', async t => {
  const entered = deferred(), gate = deferred(); let manager;
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}, decorateAccounts: value => {manager = value;}});
  const original = manager.remove;
  manager.remove = async id => {entered.resolve(); await gate.promise; return original(id);};
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  const removing = f.send('/api/cpa-settings', {action: 'account-remove', accountId: A}); await entered.promise;
  try {
    const denied = await consume(conversation(prepared));
    assert.equal(denied.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE');
    await assert.rejects(f.llm.prepareCall({provider: provider(B), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE'});
    assert.equal(f.modelCalls.length, 0);
  } finally {gate.resolve();}
  assert.equal((await removing).status, 200);
  const after = await f.get(); assert.equal(after.preferences.activeAccountId, ''); assert.equal(after.accounts.some(row => row.enabled), false);
});

test('state retries across an account selection epoch instead of returning two enabled rows', async t => {
  const entered = deferred(), gate = deferred(); let hold = false, captured = false;
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}, appOptions: {
    transportFactory: async (ctx, options) => {
      const real = await createCpaTransport(ctx, options);
      return {...real, async listModels(id) {const result = await real.listModels(id); if (hold && id === B && !captured) {captured = true; entered.resolve(); await gate.promise;} return result;}};
    },
  }});
  hold = true; const reading = f.send('/api/cpa-settings'); await entered.promise;
  assert.equal((await f.send('/api/cpa-settings', {action: 'account-select', accountId: B})).status, 200);
  gate.resolve(); const response = await reading; assert.equal(response.status, 200); const state = await response.json();
  assert.deepEqual(state.accounts.filter(row => row.enabled).map(row => row.id), [B]);
  assert.equal(state.preferences.activeAccountId, B); assert.deepEqual(state.fast.providers, [provider(B)]);
});

test('unavailable or replaced principal never inherits fresh quota metadata', async t => {
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}});
  const initial = await f.get(); assert.ok(initial.accounts.find(row => row.id === A).quota); assert.equal(initial.accounts.find(row => row.id === A).quotaStale, false);
  const broken = owned(A); broken.payload.access = 'not-a-token'; f.records.set('cpa-codex/' + A, broken);
  const state = await f.get(), row = state.accounts.find(row => row.id === A);
  assert.notEqual(row.availability, 'ready'); assert.equal(row.quota, null); assert.equal(row.quotaStale, true); assert.equal(row.enabled, false);
});

test('switching pauses an old saved plan but preserves its PNG history and waits a full interval when re-enabled', async t => {
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A}});
  await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: A, model: MODEL}); await settle(f, A);
  assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-configure', accountId: A, model: MODEL, intervalMinutes: 5})).status, 200);
  await f.send('/api/cpa-settings', {action: 'account-select', accountId: B});
  let row = (await f.activity()).accounts.find(value => value.id === A).pelican;
  assert.equal(row.available, false); assert.equal(row.intervalMinutes, 5); assert.equal(row.nextRunAt, null); assert.equal(row.historyCount, 1);
  assert.equal((await f.send('/api/cpa-history?accountId=' + A)).status, 200);
  assert.equal((await f.send('/api/cpa-activity', {action: 'pelican-run', accountId: A, model: MODEL})).status, 409);
  await f.send('/api/cpa-settings', {action: 'account-select', accountId: A});
  row = (await f.activity()).accounts.find(value => value.id === A).pelican;
  assert.equal(row.available, true); assert.equal(row.historyCount, 1); assert.ok(Date.parse(row.nextRunAt) >= Date.now() + 290000);
  assert.equal(f.modelCalls.length, 1);
});


for (const fail of [false,true]) test('settings ACK keeps both account gates closed and restores safely on failure: '+fail, async t=>{
  const entered=deferred(),gate=deferred();
  const f=await fixture(t,{records:twoOwned(),preferences:{activeAccountId:A,plans:{[A]:{intervalMinutes:5,model:MODEL}}},beforeSettingsWrite:async ops=>{
    if(ops.some(op=>op.path[0]==='activeAccountId'&&op.value===B)){entered.resolve();await gate.promise;if(fail)throw Error('synthetic private write failure');}
  }});
  const stale=delayedBody(f,'/api/cpa-activity',{action:'pelican-run',accountId:A,model:MODEL});
  const selecting=f.send('/api/cpa-settings',{action:'account-select',accountId:B});await entered.promise;
  try{for(const id of [A,B])await assert.rejects(f.llm.prepareCall({provider:provider(id),model:MODEL}),{code:'CPA_ACCOUNT_INACTIVE'});stale.finish();assert.equal((await stale.response).status,409);assert.equal(f.modelCalls.length,0);}finally{gate.resolve();}
  assert.equal((await selecting).status,fail?503:200);assert.deepEqual((await f.get()).accounts.filter(row=>row.enabled).map(row=>row.id),[fail?A:B]);
  if(fail){const plan=(await f.activity()).accounts.find(row=>row.id===A).pelican;assert.equal(plan.intervalMinutes,5);assert.ok(Date.parse(plan.nextRunAt)>Date.now()+290000);}
});

test('a late Fast response cannot acknowledge a different newly enabled account',async t=>{
  const entered=deferred(),gate=deferred();let hold=false,captured=false;
  const f=await fixture(t,{records:twoOwned(),preferences:{activeAccountId:A},appOptions:{transportFactory:async(ctx,options)=>{
    const real=await createCpaTransport(ctx,options);return {...real,async listModels(id){const result=await real.listModels(id);if(hold&&id===B&&!captured){captured=true;entered.resolve();await gate.promise;}return result;}};
  }}});
  hold=true;const fast=f.send('/api/cpa-settings',{action:'fast',enabled:true,accountId:A});await entered.promise;
  assert.equal((await f.send('/api/cpa-settings',{action:'account-select',accountId:B})).status,200);gate.resolve();const response=await fast;
  assert.equal(response.status,409);assert.equal((await response.json()).error,'account-changed');
});

test('inactive identity replacement cannot relabel a former account quota as fresh',async t=>{
  const f=await fixture(t,{records:twoOwned(),preferences:{activeAccountId:A}});assert.ok((await f.get()).accounts.find(row=>row.id===A).quota);
  await f.send('/api/cpa-settings',{action:'account-select',accountId:B});f.records.set('cpa-codex/'+A,owned(A,'replacement-person'));
  const row=(await f.get()).accounts.find(row=>row.id===A);assert.equal(row.email,'replacement-person@example.test');assert.equal(row.quota,null);assert.equal(row.quotaStale,true);assert.equal(row.enabled,false);
});


test('temporary credential-store failure recovers through ordinary model listing and catalog sync without reload', async t => {
  let unavailable = false, accounts;
  const f = await fixture(t, {records: twoOwned(), preferences: {activeAccountId: A},
    decorateAccounts: manager => {accounts = manager;},
    beforeCredentialRead: () => {if (unavailable) throw Error('synthetic temporary credential read failure');}});
  const sync = () => f.send('/api/cpa-settings', {action: 'sync', accountId: A});
  assert.equal((await sync()).status, 200);
  assert.ok((await f.llm.listModels(provider(A))).some(model => model.id === 'gpt-6-synthetic'));
  const old = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  const bound = await accounts.capture(A, provider(A));
  unavailable = true; await assert.rejects(bound.assertCurrent(), {code: 'accounts-unavailable'});
  await tick(); unavailable = false;
  assert.equal((await accounts.list()).find(row => row.id === A).availability, 'ready');
  const recovered = await accounts.capture(A, provider(A)); await recovered.assertCurrent();
  const models = await f.llm.listModels(provider(A));
  assert.ok(models.some(model => model.id === MODEL)); assert.equal(models.some(model => model.id === 'gpt-6-synthetic'), false);
  assert.equal((await consume(conversation(old))).at(-1).reason.kind, 'aborted'); assert.equal(f.modelCalls.length, 0);
  assert.equal((await sync()).status, 200);
  assert.ok((await f.llm.listModels(provider(A))).some(model => model.id === 'gpt-6-synthetic'));
  const fresh = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  assert.equal((await consume(conversation(fresh))).at(-1).reason.kind, 'stop'); assert.equal(f.modelCalls.length, 1);
});


test('default runtime clock persists real TTFT duration and TPS after a bundled SDK stream', async t=>{
  const f=await fixture(t,{records:twoOwned(),preferences:{activeAccountId:A},modelFetch:async()=>{
    const original=modelResponse(),text=await original.text(),frames=text.split('\n\n').filter(Boolean);let index=0;
    return new Response(new ReadableStream({async pull(controller){
      if(index>=frames.length){controller.close();return;}
      await new Promise(resolve=>setTimeout(resolve,8));controller.enqueue(new TextEncoder().encode(frames[index++]+'\n\n'));
    }}),{status:200,headers:{'content-type':'text/event-stream'}});
  }});
  const prepared=await f.llm.prepareCall({provider:provider(A),model:MODEL});
  assert.equal((await consume(conversation(prepared))).at(-1).reason.kind,'stop');
  const activity=await f.activity(),row=activity.logs.entries[0];
  assert.equal(row.source,'conversation');assert.equal(row.usageEvidence,'provider');assert.equal(row.outputTokens,20);
  assert.ok(Number.isFinite(row.ttftMs)&&row.ttftMs>=0,'default-clock TTFT is measured');
  assert.ok(Number.isFinite(row.durationMs)&&row.durationMs>row.ttftMs,'default-clock total duration is measured');
  assert.ok(Number.isFinite(row.tps)&&row.tps>0,'real output and elapsed generation produce TPS');
  assert.ok(Math.abs(row.tps-20/((row.durationMs-row.ttftMs)/1000))<0.000001);
  assert.equal(activity.logs.summary.samples.ttft,1);assert.equal(activity.logs.summary.samples.tps,1);
  const stored=JSON.parse((await readFile(join(f.directory,'.dsh-cpa','activity.ndjson'),'utf8')).trim());
  assert.equal(stored.ttftMs,row.ttftMs);assert.equal(stored.durationMs,row.durationMs);assert.equal(stored.tps,row.tps);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import {cp, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime, {LlmAdapter, LlmError, attributionHeaders, createAssistantMessage, createToolResultMessage} from '@deepseek-ai/dsh-llm';
import {createCpaTransport} from '../lib/transport-v026.mjs';
import {readEvidence} from '../lib/evidence-v026.mjs';
import {createTelemetry} from '../lib/telemetry-v026.mjs';

const MODEL = 'gpt-5.5';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const provider = id => 'cpa-codex-' + id;
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const collect = async iterable => {const result = []; for await (const value of iterable) result.push(value); return result;};
const request = (extra = {}) => ({model: MODEL, messages: [{role: 'user', content: [{type: 'text', text: 'synthetic request'}]}], tools: [], ...extra});
const token = (id, version = 1) => 'synthetic.' + Buffer.from(JSON.stringify({sub: 'subject-' + id, email: id + '@example.test',
  version, 'https://api.openai.com/auth': {chatgpt_account_id: 'upstream-' + id, chatgpt_user_id: 'subject-' + id}})).toString('base64') + '.signature';
function decodeBody(init) {
  const bytes = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body);
  const decoded = new Headers(init.headers).get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes;
  return JSON.parse(decoded.toString('utf8'));
}
function events(text = 'synthetic answer', overrides = {}) {
  const item = {id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{type: 'output_text', text, annotations: []}]};
  const response = {id: 'resp_synthetic', status: 'completed', model: MODEL, output: [item], service_tier: 'default',
    usage: {input_tokens: 41, output_tokens: 7, total_tokens: 48, input_tokens_details: {cached_tokens: 11},
      output_tokens_details: {reasoning_tokens: 2}}, ...overrides};
  return [{type: 'response.created', response: {id: response.id}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, content: []}},
    {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response}];
}
const sseBytes = values => new TextEncoder().encode(values.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
const responseFor = (values = events()) => new Response(sseBytes(values), {status: 200, headers: {'content-type': 'text/event-stream'}});

function fakeAccounts(ids = [A, B]) {
  const state = new Map(ids.map(id => [id, {hash: 'principal-' + id, controller: new AbortController(),
    credential: {type: 'oauth', access: token(id), refresh: 'synthetic-refresh-' + id, expires: Date.now() + 3600000, accountId: 'upstream-' + id}}]));
  const listeners = new Set(), reads = [], captures = [], mutations = [];
  const accounts = {
    list: async () => [...state.keys()].map(id => ({id, provider: provider(id), email: id + '@example.test', availability: 'ready', canRunProbe: true})),
    async capture(id, route) {
      assert.equal(route, provider(id));
      const current = state.get(id);
      if (!current) throw new LlmError('synthetic account unavailable', 'MISSING_CREDENTIAL');
      const hash = current.hash;
      const guard = async () => {
        if (state.get(id) !== current || current.hash !== hash || current.controller.signal.aborted) throw new LlmError('synthetic identity changed', 'CPA_BINDING_MISMATCH');
      };
      const credentials = {
        async read(key) {assert.equal(key, route); await guard(); reads.push({id, key}); return structuredClone(current.credential);},
        async modify(key, mutate) {assert.equal(key, route); await guard(); const next = await mutate(structuredClone(current.credential)); await guard();
          if (next !== undefined) current.credential = structuredClone(next); mutations.push({id, key}); return structuredClone(current.credential);},
        async list() {await guard(); return [{providerId: route, type: 'oauth'}];},
        async delete() {throw new Error('synthetic forbidden delete');},
      };
      const binding = Object.freeze({accountId: id, providerId: route, email: id + '@example.test', principalHash: hash,
        signal: current.controller.signal, credentials, assertCurrent: guard});
      captures.push(binding); return binding;
    },
    onChange(callback) {listeners.add(callback); return () => listeners.delete(callback);},
    remove(id) {const current = state.get(id); current?.controller.abort(); state.delete(id); for (const listener of listeners) listener();},
  };
  return {accounts, state, reads, captures, mutations};
}
async function fixture(t, options = {}) {
  const RuntimeContext = options.Context ?? Context;
  const Runtime = options.LlmRuntime ?? LlmRuntime;
  const ctx = new RuntimeContext();
  const offServices = Object.entries(options.services ?? {}).map(([key, value]) => ctx.provide(key, value));
  const llm = new Runtime(ctx);
  const registered = new Map(), registrations = [];
  const register = llm.registerAdapter.bind(llm);
  llm.registerAdapter = (routes, adapter) => {
    const off = register(routes, adapter); registrations.push({routes: [...routes], adapter});
    for (const route of routes) registered.set(route, adapter);
    return () => {for (const route of routes) registered.delete(route); off();};
  };
  class Host extends LlmAdapter {async *stream() {yield {type: 'finish', reason: {kind: 'stop'}};}}
  const host = new Host();
  const offHost = llm.registerAdapter(['openai-codex'], host);
  const account = options.account ?? fakeAccounts();
  let fast = options.fast ?? false;
  const observed = new Set(), calls = [];
  const telemetry = options.telemetry ?? options.createTelemetry?.(ctx) ?? {registerProvider(id) {observed.add(id); return () => observed.delete(id);}};
  const transport = createCpaTransport(ctx, {accounts: account.accounts, telemetry, getFast: () => fast, isEnabled: options.isEnabled,
    fetchImpl: async (input, init) => {const call = {input: String(input), init, body: decodeBody(init)}; calls.push(call);
      return options.fetchImpl ? options.fetchImpl(call, calls.length) : responseFor();}});
  await transport.refresh();
  t.after(() => {transport.dispose(); telemetry.dispose?.(); offHost(); for (const off of offServices) off();});
  return {ctx, llm, transport, telemetry, ...account, calls, registered, registrations, observed, host, setFast: value => {fast = value;}};
}

test('public PiAiAdapter delegate sends priority ON and omits service_tier OFF on the same owned SSE route', async t => {
  const f = await fixture(t);
  const rawFetch = globalThis.fetch;
  const offChunks = await collect(f.transport.stream(A, request()));
  assert.equal(f.calls.length, 1, JSON.stringify(offChunks));
  assert.equal(Object.hasOwn(f.calls[0].body, 'service_tier'), false);
  assert.equal(f.calls[0].input, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(f.calls[0].body.stream, true);
  assert.equal(new Headers(f.calls[0].init.headers).get('accept'), 'text/event-stream');
  for (const [key, value] of Object.entries(attributionHeaders())) assert.equal(new Headers(f.calls[0].init.headers).get(key), value);
  assert.equal(offChunks.at(-1).reason.kind, 'stop');
  assert.equal(offChunks.find(chunk => chunk.type === 'text-delta').text, 'synthetic answer');
  const offEvidence = readEvidence(offChunks.at(-1));
  assert.equal(offEvidence.httpStatus, 200); assert.equal(offEvidence.serviceTierRequested, null);
  assert.equal(offEvidence.serviceTierReported, 'default'); assert.equal(offEvidence.inputTokens, 41);
  assert.equal(offEvidence.cacheReadTokens, 11); assert.equal(offEvidence.accountId, A);
  f.setFast(true);
  const onChunks = await collect(f.transport.stream(A, request({reasoningEffort: 'high', temperature: 0.3})));
  assert.equal(f.calls[1].body.service_tier, 'priority');
  assert.equal(f.calls[1].body.reasoning.effort, 'high');
  assert.equal(f.calls[1].body.temperature, 0.3);
  const onEvidence = readEvidence(onChunks.at(-1));
  assert.equal(onEvidence.serviceTierRequested, 'priority');
  assert.equal(onEvidence.serviceTierReported, 'default'); // Requested is NOT evidence of served tier.
  assert.notEqual(onEvidence.evidenceId, offEvidence.evidenceId);
  assert.equal(globalThis.fetch, rawFetch);
  assert.equal(f.registered.get('openai-codex'), f.host);
  assert.deepEqual([...f.observed].sort(), [provider(A), provider(B)].sort());
});

test('core prepared calls freeze Fast and retain a stable account wrapper across refresh', async t => {
  const f = await fixture(t, {fast: true});
  const wrapper = f.registered.get(provider(A));
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  f.setFast(false); await f.transport.refresh();
  const chunks = await collect(prepared.stream({...request(), ...prepared.config}));
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(f.calls[0].body.service_tier, 'priority');
  assert.equal(f.registered.get(provider(A)), wrapper);
  await collect(f.transport.stream(A, request()));
  assert.equal(Object.hasOwn(f.calls[1].body, 'service_tier'), false);
  assert.equal(f.registrations.filter(item => item.routes.includes(provider(A))).length, 1);
});

test('concurrent accounts use only their exact native stores and independent per-call audits', async t => {
  const f = await fixture(t, {fast: true});
  const [a, b] = await Promise.all([collect(f.transport.stream(A, request())), collect(f.transport.stream(B, request()))]);
  assert.equal(f.calls.length, 2);
  const headers = f.calls.map(call => new Headers(call.init.headers));
  assert.deepEqual(new Set(headers.map(h => h.get('chatgpt-account-id'))), new Set(['upstream-' + A, 'upstream-' + B]));
  assert.ok(f.reads.every(({id, key}) => key === provider(id)));
  assert.equal(readEvidence(a.at(-1)).accountId, A); assert.equal(readEvidence(b.at(-1)).accountId, B);
  assert.notEqual(readEvidence(a[0]).evidenceId, readEvidence(b[0]).evidenceId);
});

test('probe expected binding principal mismatch fails closed before provider I/O', async t => {
  const f = await fixture(t);
  const outer = await f.accounts.capture(A, provider(A));
  await assert.rejects(collect(f.transport.stream(A, request(), {...outer, principalHash: 'different-principal'})), {code: 'CPA_BINDING_MISMATCH'});
  await assert.rejects(collect(f.transport.stream(A, request(), {...outer, accountId: B})), {code: 'CPA_BINDING_MISMATCH'});
  await assert.rejects(collect(f.transport.stream(A, request(), {...outer, providerId: 'openai-codex'})), {code: 'CPA_BINDING_MISMATCH'});
  assert.equal(f.calls.length, 0);
});

const descriptor = (overrides = {}) => ({id: MODEL, name: 'Synthetic Codex model', contextWindow: 131072,
  maxTokens: 32768, input: ['text', 'image'], reasoningEfforts: {low: 'low', high: 'high'}, ...overrides});

test('trusted endpoint catalogs become complete native models and preserve prepared snapshots', async t => {
  const f = await fixture(t);
  const outer = await f.accounts.capture(A, provider(A));
  const before = await f.llm.prepareCall({provider: provider(A), model: MODEL, reasoningEffort: 'high'});
  const newer = descriptor({id: 'gpt-99-cpa', contextWindow: 16000});
  const rows = [descriptor({contextWindow: 65536}), newer];
  await f.transport.setCatalog(A, rows, outer);
  newer.name = 'mutated'; newer.input.length = 0; rows.length = 0;
  const listed = await f.transport.listModels(A);
  assert.ok(listed.some(row => row.id === MODEL));
  assert.equal(listed.find(row => row.id === 'gpt-99-cpa').name, 'Synthetic Codex model');
  assert.ok(listed.some(row => row.id !== MODEL && row.id !== 'gpt-99-cpa'));
  const after = await f.llm.prepareCall({provider: provider(A), model: MODEL, reasoningEffort: 'high'});
  assert.equal(after.context.contextWindow, 65536);
  assert.notEqual(before.context.contextWindow, after.context.contextWindow);
  await assert.rejects(f.llm.prepareCall({provider: provider(A), model: MODEL, reasoningEffort: 'medium'}), {code: 'UNSUPPORTED_REASONING_EFFORT'});
  const oldChunks = await collect(before.stream({...request(), ...before.config}));
  assert.equal(oldChunks.at(-1).reason.kind, 'stop');
  const newChunks = await collect(f.transport.stream(A, request({model: 'gpt-99-cpa', reasoningEffort: 'low'})));
  assert.equal(newChunks.at(-1).reason.kind, 'stop');
  assert.equal(f.calls.at(-1).body.model, 'gpt-99-cpa');
  assert.equal(f.calls.at(-1).body.reasoning.effort, 'low');
  assert.equal(readEvidence(newChunks.at(-1)).inputTokens, 41);
  assert.ok((await f.transport.listModels(B)).length > 2); // Account B's native catalog is independent.
});

test('catalog validation rejects malformed capabilities atomically and binds updates to their principal', async t => {
  const f = await fixture(t);
  await f.transport.setCatalog(A, [descriptor()]);
  const baseline = (await f.transport.listModels(A)).map(row => row.id);
  for (const invalid of [null, true, [], {id: 'host-route'}, {contextWindow: null}, {contextWindow: 0},
    {contextWindow: Number.MAX_SAFE_INTEGER + 1}, {maxTokens: ''}, {input: ['audio']},
    {reasoningEfforts: {medium: 'invented'}}, {reasoningEfforts: {invented: 'high'}}]) {
    const row = invalid && !Array.isArray(invalid) && typeof invalid === 'object' ? descriptor(invalid) : invalid;
    await assert.rejects(f.transport.setCatalog(A, [row]), {code: 'CPA_CATALOG_INVALID'});
  }
  await assert.rejects(f.transport.setCatalog(A, [descriptor(), descriptor()]), {code: 'CPA_CATALOG_INVALID'});
  const outer = await f.accounts.capture(A, provider(A));
  await assert.rejects(f.transport.setCatalog(A, [], {...outer, principalHash: 'another'}), {code: 'CPA_BINDING_MISMATCH'});
  assert.deepEqual((await f.transport.listModels(A)).map(row => row.id), baseline);
  assert.equal(f.calls.length, 0);
});

test('latest catalog update wins even when an older capture resolves last', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const capture = f.accounts.capture;
  let first = true;
  f.accounts.capture = async (...args) => {const binding = await capture(...args); if (first) {first = false; entered.resolve(); await gate.promise;} return binding;};
  const stale = f.transport.setCatalog(A, [descriptor({name: 'stale'})]);
  const staleCheck = assert.rejects(stale, {code: 'CPA_CATALOG_SUPERSEDED'});
  await entered.promise;
  await f.transport.setCatalog(A, [descriptor({name: 'latest'})]);
  gate.resolve(); await staleCheck;
  assert.equal((await f.transport.listModels(A)).find(row => row.id === MODEL).name, 'latest');
});

test('full tool schemas and tool-result history use the SDK converter without mutating frozen inputs', async t => {
  const f = await fixture(t);
  const assistant = createAssistantMessage({content: [{type: 'tool-call', id: 'call_synthetic', name: 'weather', arguments: '{"city":"Oslo"}'}],
    source: {provider: provider(A), model: MODEL}});
  const result = createToolResultMessage({callId: 'call_synthetic', content: [{type: 'text', text: 'sunny'}], isError: false});
  const tool = {name: 'weather', description: 'Synthetic weather', parameters: {type: 'object', properties: {city: {type: 'string'}}, required: ['city'], additionalProperties: false}};
  const options = request({system: 'synthetic system', messages: [assistant, result, ...request().messages], tools: [tool]});
  const original = structuredClone(options);
  Object.freeze(options.messages); Object.freeze(options.tools); Object.freeze(options);
  const chunks = await collect(f.transport.stream(A, options));
  assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks));
  assert.deepEqual(options, original);
  const body = f.calls[0].body;
  assert.equal(body.instructions, 'synthetic system');
  assert.equal(body.tools[0].name, 'weather');
  assert.deepEqual(body.tools[0].parameters, tool.parameters);
  assert.ok(body.input.some(item => item.type === 'function_call' && item.name === 'weather' && item.arguments.includes('Oslo')));
  assert.ok(body.input.some(item => item.type === 'function_call_output' && item.output === 'sunny'));
});

test('durable image references use the official attachment bridge and native multimodal serializer', async t => {
  const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const ref = {attachmentId: 'synthetic-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1, name: 'fixture.png'};
  const reads = [];
  const attachments = {
    async readImageRequest(value, target, signal) {assert.equal(value, ref); assert.equal(signal.aborted, false); reads.push(target);
      return {variantId: 'synthetic-variant', attachment: ref, data: png, mediaType: 'image/png', bytes: png.length,
        width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false};},
    imageHostPath() {return undefined;}, // No filesystem access is needed or performed.
  };
  const f = await fixture(t, {services: {attachments}});
  const chunks = await collect(f.transport.stream(A, request({messages: [{role: 'user', content: [{type: 'text', text: 'synthetic image'}, {type: 'image', attachment: ref}]}]})));
  assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks));
  assert.equal(reads.length, 1); assert.equal(reads[0].maxBytes, 1048576);
  const parts = f.calls[0].body.input.flatMap(item => item.content ?? []);
  assert.ok(parts.some(part => part.type === 'input_image' && part.image_url === 'data:image/png;base64,' + Buffer.from(png).toString('base64')));
  assert.ok(parts.some(part => part.type === 'input_text' && part.text.includes('fixture.png')));
});

test('same-account replay survives new per-call delegates but does not cross account wrappers', async t => {
  const reasoning = {id: 'rs_synthetic', type: 'reasoning', summary: [{type: 'summary_text', text: 'synthetic thought'}], encrypted_content: 'synthetic-encrypted'};
  const responseEvents = events();
  responseEvents.splice(1, 0, {type: 'response.output_item.added', output_index: 1, item: reasoning},
    {type: 'response.output_item.done', output_index: 1, item: reasoning});
  responseEvents.at(-1).response.output.unshift(reasoning);
  const f = await fixture(t, {fetchImpl: (_call, n) => responseFor(n === 1 ? responseEvents : events())});
  const first = await collect(f.transport.stream(A, request()));
  assert.equal(first.at(-1).reason.kind, 'stop');
  const blocks = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  const replayState = first.at(-1).replayState;
  assert.ok(replayState);
  const assistant = createAssistantMessage({content: blocks, source: {provider: provider(A), model: MODEL, replayState}});
  await collect(f.transport.stream(A, request({messages: [assistant, ...request().messages]})));
  assert.ok(f.calls[1].body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'synthetic-encrypted'));
  await collect(f.transport.stream(B, request({messages: [assistant, ...request().messages]})));
  assert.ok(!f.calls[2].body.input.some(item => item.encrypted_content === 'synthetic-encrypted'));
});

test('native SSE tool-call deltas, parsed arguments, finish reason and replay metadata pass through', async t => {
  const item = {id: 'fc_synthetic', type: 'function_call', call_id: 'call_synthetic', name: 'weather', arguments: '{"city":"Oslo"}', status: 'completed'};
  const values = [{type: 'response.created', response: {id: 'resp_tool'}},
    {type: 'response.output_item.added', output_index: 0, item: {...item, arguments: ''}},
    {type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments},
    {type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response: {...events().at(-1).response, id: 'resp_tool', output: [item]}}];
  const f = await fixture(t, {fetchImpl: () => responseFor(values)});
  const chunks = await collect(f.transport.stream(A, request()));
  const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;
  assert.equal(block.name, 'weather'); assert.deepEqual(JSON.parse(block.arguments), {city: 'Oslo'});
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls'); assert.ok(chunks.at(-1).replayState);
});

test('real HTTP error status remains request-local and missing raw usage remains unknown', async t => {
  const f = await fixture(t, {fetchImpl: () => new Response('{"error":{"message":"synthetic denial"}}', {status: 403})});
  const chunks = await collect(f.transport.stream(A, request()));
  assert.equal(f.calls.length, 1); assert.equal(chunks.at(-1).reason.kind, 'error');
  const proof = readEvidence(chunks.at(-1));
  assert.equal(proof.httpStatus, 403); assert.equal(proof.usageReported, false); assert.equal(proof.inputTokens, null);
  assert.equal(proof.serviceTierReported, null);
});

test('same model and shared AbortSignal never correlate separate delegate audits', async t => {
  const controller = new AbortController();
  const f = await fixture(t, {fetchImpl: (_call, n) => responseFor(events('request-' + n, {service_tier: n === 1 ? 'priority' : 'default',
    usage: {input_tokens: n * 10, output_tokens: n, total_tokens: n * 11}}))});
  const [first, second] = await Promise.all([collect(f.transport.stream(A, request({signal: controller.signal}))), collect(f.transport.stream(A, request({signal: controller.signal})))]);
  const a = readEvidence(first.at(-1)), b = readEvidence(second.at(-1));
  assert.notEqual(a.evidenceId, b.evidenceId); assert.notEqual(a.inputTokens, b.inputTokens);
  assert.notEqual(a.serviceTierReported, b.serviceTierReported);
  assert.equal(a.cacheReadTokens, null); assert.equal(b.cacheReadTokens, null);
});

test('prepared identity change fails closed and same-principal access-token rotation remains usable', async t => {
  const f = await fixture(t);
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  f.state.get(A).hash = 'changed';
  const failed = await collect(prepared.stream({...request(), ...prepared.config}));
  assert.equal(failed.at(-1).reason.kind, 'error'); assert.equal(f.calls.length, 0);
  f.state.get(A).hash = 'principal-' + A;
  const next = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  f.state.get(A).credential.access = token(A, 2);
  const ok = await collect(next.stream({...request(), ...next.config}));
  assert.equal(ok.at(-1).reason.kind, 'stop');
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), 'Bearer ' + token(A, 2));
});

test('identity is rechecked after an awaited fetch and no late body is attributed to a different principal', async t => {
  const gate = deferred(), entered = deferred(); let cancelled = false;
  const f = await fixture(t, {fetchImpl: async () => {entered.resolve(); await gate.promise;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(sseBytes(events('must not escape')));}, cancel() {cancelled = true;}}),
      {status: 200, headers: {'content-type': 'text/event-stream'}});}});
  const pending = collect(f.transport.stream(A, request()));
  await entered.promise; f.state.get(A).hash = 'other-principal'; gate.resolve();
  const chunks = await pending;
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.ok(!chunks.some(chunk => chunk.type === 'text-delta')); assert.equal(cancelled, true);
});

for (const origin of ['caller', 'outer', 'fresh', 'remove', 'dispose']) {
  test('cancellation from ' + origin + ' aborts an outstanding HTTP fetch and keeps the host route', {timeout: 3000}, async t => {
    const entered = deferred(), caller = new AbortController(), outerController = new AbortController();
    const f = await fixture(t, {fetchImpl: async call => {entered.resolve(call.init.signal); return new Promise((_, reject) => {
      call.init.signal.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), {once: true});});}});
    const binding = await f.accounts.capture(A, provider(A));
    const outer = {...binding, signal: outerController.signal};
    const pending = collect(f.transport.stream(A, request({signal: caller.signal}), outer));
    const fetchSignal = await entered.promise;
    if (origin === 'caller') caller.abort();
    if (origin === 'outer') outerController.abort();
    if (origin === 'fresh') f.state.get(A).controller.abort();
    if (origin === 'remove') {f.accounts.remove(A); await f.transport.refresh();}
    if (origin === 'dispose') f.transport.dispose();
    const chunks = await pending;
    assert.equal(fetchSignal.aborted, true); assert.equal(chunks.at(-1).reason.kind, 'aborted');
    assert.equal(f.registered.get('openai-codex'), f.host);
    if (origin === 'remove' || origin === 'dispose') assert.equal(f.observed.has(provider(A)), false);
  });
}

test('caller abort and consumer return cancel native SSE readers without waiting for a complete response', {timeout: 3000}, async t => {
  for (const stop of ['abort', 'return']) {
    const cancelled = deferred(), caller = new AbortController();
    const f = await fixture(t, {fetchImpl: () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(sseBytes(events().slice(0, 3)));}, cancel() {cancelled.resolve();},
    }), {status: 200, headers: {'content-type': 'text/event-stream'}})});
    const iterator = f.transport.stream(A, request({signal: caller.signal}))[Symbol.asyncIterator]();
    const first = await iterator.next(); assert.equal(first.done, false);
    if (stop === 'abort') {caller.abort(); const rest = []; for (;;) {const item = await iterator.next(); if (item.done) break; rest.push(item.value);}
      assert.equal(rest.at(-1).reason.kind, 'aborted');}
    else await iterator.return();
    await cancelled.promise;
  }
});

test('preparation cancellation settles promptly even when account capture never resolves', {timeout: 3000}, async t => {
  const f = await fixture(t), entered = deferred(), caller = new AbortController();
  f.accounts.capture = async () => {entered.resolve(); return new Promise(() => {});};
  const preparing = f.llm.prepareCall({provider: provider(A), model: MODEL}, caller.signal);
  const rejected = assert.rejects(preparing, {code: 'ABORTED'});
  await entered.promise; caller.abort(); await rejected;
  assert.equal(f.calls.length, 0);
});

test('the official core waterfall runs once and probe telemetry observes exactly one terminal record', async t => {
  const records = [];
  const f = await fixture(t, {createTelemetry: ctx => createTelemetry(ctx, {onRecord: row => {records.push(row);}})});
  let waterfall = 0;
  const off = f.ctx.on('llm/stream', (options, next) => {waterfall++; assert.equal(options.provider, provider(A)); return next();});
  t.after(off);
  const options = request({provider: provider(A)});
  const binding = await f.accounts.capture(A, provider(A));
  await collect(f.telemetry.observeProbe(options, () => f.transport.stream(A, options, binding)));
  assert.equal(waterfall, 1);
  assert.equal(records.length, 1); assert.equal(records[0].source, 'pelican');
  assert.equal(records[0].httpStatus, 200); assert.equal(records[0].accountId, A); assert.equal(records[0].usageEvidence, 'provider');
  assert.equal(Object.hasOwn(records[0], 'endedAt'), false);
  await collect(f.transport.stream(A, request()));
  assert.equal(waterfall, 2); assert.equal(records.length, 2); assert.equal(records[1].source, 'conversation');
});

test('unknown models, foreign routes and SDK-unsupported options fail without provider I/O', async t => {
  const f = await fixture(t);
  await assert.rejects(collect(f.transport.stream(A, request({model: 'not-in-catalog'}))), {code: 'UNKNOWN_MODEL'});
  await assert.rejects(collect(f.transport.stream(A, request({provider: 'openai-codex'}))), {code: 'CPA_BINDING_MISMATCH'});
  assert.throws(() => f.transport.providerFor('../account'), {code: 'CPA_ACCOUNT_INVALID'});
  const chunks = await collect(f.transport.stream(A, request({stop: ['unsupported']})));
  assert.equal(chunks.at(-1).reason.failure.code, 'UNSUPPORTED_OPTION');
  assert.equal(readEvidence(chunks.at(-1)).httpStatus, null); assert.equal(f.calls.length, 0);
});

test('catalog sync is additive across refreshes and never inherits prior-principal remote metadata', async t => {
  const f = await fixture(t);
  const nativeIds = (await f.transport.listModels(A)).map(row => row.id);
  await f.transport.setCatalog(A, [descriptor({id: 'gpt-99-remote-one'})]);
  await f.transport.setCatalog(A, [descriptor({id: 'gpt-99-remote-two'})]);
  const merged = (await f.transport.listModels(A)).map(row => row.id);
  for (const id of [...nativeIds, 'gpt-99-remote-one', 'gpt-99-remote-two']) assert.ok(merged.includes(id));
  const current = f.state.get(A);
  current.controller.abort(); current.controller = new AbortController(); current.hash = 'new-principal';
  await f.transport.setCatalog(A, [descriptor({id: 'gpt-99-current-principal'})]);
  const replaced = (await f.transport.listModels(A)).map(row => row.id);
  assert.ok(replaced.includes('gpt-99-current-principal'));
  assert.ok(!replaced.includes('gpt-99-remote-one')); assert.ok(!replaced.includes('gpt-99-remote-two'));
  for (const id of nativeIds) assert.ok(replaced.includes(id));
});

test('outer and fresh binding assertions are both used through preparation and dispatch', async t => {
  const f = await fixture(t), original = f.accounts.capture;
  let outerChecks = 0, freshChecks = 0;
  const outerBase = await original(A, provider(A));
  const outer = {...outerBase, assertCurrent: async () => {outerChecks++; await outerBase.assertCurrent();}};
  f.accounts.capture = async (...args) => {const binding = await original(...args);
    return {...binding, assertCurrent: async () => {freshChecks++; await binding.assertCurrent();}};};
  const chunks = await collect(f.transport.stream(A, request(), outer));
  assert.equal(chunks.at(-1).reason.kind, 'stop'); assert.ok(outerChecks > 2); assert.ok(freshChecks > 2);
});

test('native OAuth lock recheck accepts same-principal concurrent refresh but rejects changed identity without auth I/O', async t => {
  for (const changed of [false, true]) {
    const account = fakeAccounts([A]), original = account.accounts.capture;
    account.state.get(A).credential.expires = Date.now() + 1000; // Forces native getAuth into its store.modify path.
    account.accounts.capture = async (...args) => {
      const binding = await original(...args);
      return {...binding, credentials: {...binding.credentials, async modify(key, mutate, options) {
        assert.equal(key, provider(A));
        const current = account.state.get(A);
        current.credential = {...current.credential, access: token(A, 3), expires: Date.now() + 3600000};
        if (changed) current.hash = 'unexpected-principal';
        // Emulate another refresh winning the official store lock. Native must
        // re-check the now-fresh grant rather than invoke any real OAuth fetch.
        return binding.credentials.modify(key, mutate, options);
      }}};
    };
    const f = await fixture(t, {account});
    const chunks = await collect(f.transport.stream(A, request()));
    assert.equal(chunks.at(-1).reason.kind, changed ? 'error' : 'stop');
    assert.equal(f.calls.length, changed ? 0 : 1);
    if (!changed) {assert.equal(f.mutations.length, 1); assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), 'Bearer ' + token(A, 3));}
  }
});

test('late custom fetch responses are reclaimed after cancellation even if fetch ignores its signal', {timeout: 3000}, async t => {
  const entered = deferred(), gate = deferred(), cancelled = deferred(), caller = new AbortController();
  const f = await fixture(t, {fetchImpl: async () => {entered.resolve(); return gate.promise;}});
  const pending = collect(f.transport.stream(A, request({signal: caller.signal})));
  await entered.promise; caller.abort();
  const chunks = await pending;
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
  gate.resolve(new Response(new ReadableStream({start(controller) {controller.enqueue(sseBytes(events('late')));}, cancel() {cancelled.resolve();}}),
    {status: 200, headers: {'content-type': 'text/event-stream'}}));
  await cancelled.promise;
  assert.ok(!chunks.some(chunk => chunk.type === 'text-delta'));
});

test('consumer-injected failures remain thrown while native SSE cleanup still runs', {timeout: 3000}, async t => {
  const cancelled = deferred();
  const f = await fixture(t, {fetchImpl: () => new Response(new ReadableStream({start(controller) {controller.enqueue(sseBytes(events().slice(0, 3)));},
    cancel() {cancelled.resolve();}}), {status: 200, headers: {'content-type': 'text/event-stream'}})});
  const iterator = f.transport.stream(A, request())[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  const sentinel = new Error('synthetic consumer failure');
  await assert.rejects(iterator.throw(sentinel), error => error === sentinel);
  await cancelled.promise;
});

test('a separately installed Host LLM/Cordis copy accepts the plugin adapter, tools, replay and foreign SDK errors', async t => {
  // Copy only existing public packages, never install or import app.asar code.
  // The fixture lives under this project so unrelated dependencies resolve from
  // its parent, but LLM, Cordis and its Service base are genuinely independent.
  const root = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.cpa-sdk-copy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const name of ['dsh-llm', 'cordis', 'dsh-typert-protocol']) {
    const source = dirname(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/' + name))));
    const target = join(root, 'node_modules', '@deepseek-ai', name);
    await mkdir(dirname(target), {recursive: true});
    await cp(source, target, {recursive: true});
  }
  const hostSdk = await import(pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href);
  const hostCordis = await import(pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  assert.notEqual(hostSdk.LlmAdapter, LlmAdapter); assert.notEqual(hostSdk.LlmError, LlmError);
  assert.notEqual(hostCordis.Context, Context);
  let enabled = true;
  const f = await fixture(t, {Context: hostCordis.Context, LlmRuntime: hostSdk.default, isEnabled: () => enabled});
  assert.equal(Context.is(f.ctx), true); assert.equal(hostCordis.Context.is(new Context()), true);
  assert.equal(f.registered.get(provider(A)) instanceof hostSdk.LlmAdapter, false);
  const tool = {name: 'synthetic_tool', description: 'cross-copy schema', parameters: {type: 'object', properties: {value: {type: 'integer'}}, required: ['value']}};
  const first = await collect(f.transport.stream(A, request({tools: [tool]})));
  assert.equal(first.at(-1).reason.kind, 'stop'); assert.equal(f.calls[0].body.tools[0].name, tool.name);
  assert.deepEqual(f.calls[0].body.tools[0].parameters, tool.parameters);
  const assistant = createAssistantMessage({content: first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
    source: {provider: provider(A), model: MODEL, replayState: first.at(-1).replayState}});
  const second = await collect(f.transport.stream(A, request({messages: [assistant, ...request().messages]})));
  assert.equal(second.at(-1).reason.kind, 'stop');
  assert.ok(f.calls[1].body.input.some(item => item.type === 'message' && item.role === 'assistant' && item.id === 'msg_synthetic'));
  const unsupported = await collect(f.transport.stream(A, request({stop: ['unsupported']})));
  assert.equal(unsupported.at(-1).reason.failure.code, 'UNSUPPORTED_OPTION');
  assert.equal(readEvidence(unsupported.at(-1)).accountId, A);
  // This path deliberately lets the HOST core normalize a thrown PLUGIN-copy
  // LlmError during prepare; own failure snapshots must retain its stable code.
  const foreign = await collect(f.llm.stream({...request({model: 'missing-model'}), provider: provider(A)}));
  assert.equal(foreign.at(-1).reason.kind, 'error');
  assert.equal(foreign.at(-1).reason.failure.code, 'UNKNOWN_MODEL');
  enabled = false;
  const inactive = await collect(f.llm.stream({...request(), provider: provider(A)}));
  assert.equal(inactive.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE');
  assert.ok((await f.transport.listModels(A)).length > 0);
  assert.equal(f.calls.length, 2);
});

test('a stream-only abort signal bounds identity checks after signal-free core preparation', {timeout: 3000}, async t => {
  const f = await fixture(t), original = f.accounts.capture, entered = deferred(), caller = new AbortController();
  let block = false;
  f.accounts.capture = async (...args) => {const binding = await original(...args);
    return {...binding, assertCurrent: async () => {if (block) {entered.resolve(); await new Promise(() => {});} await binding.assertCurrent();}};};
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  block = true;
  const pending = collect(prepared.stream({...request({signal: caller.signal}), ...prepared.config}));
  await entered.promise; caller.abort();
  const chunks = await pending;
  assert.equal(chunks.at(-1).reason.kind, 'aborted'); assert.equal(f.calls.length, 0);
});

test('single-enabled-account policy permits only the selected CPA route while metadata remains readable for both', async t => {
  const f = await fixture(t, {isEnabled: id => id === A});
  assert.ok((await f.transport.listModels(A)).length > 0); assert.ok((await f.transport.listModels(B)).length > 0);
  assert.equal((await f.registered.get(provider(B)).resolveModel(provider(B), MODEL)).id, MODEL);
  await f.transport.setCatalog(B, [descriptor({id: 'gpt-99-inactive-metadata'})]);
  assert.ok((await f.transport.listModels(B)).some(row => row.id === 'gpt-99-inactive-metadata'));
  await assert.rejects(f.llm.prepareCall({provider: provider(B), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE'});
  await assert.rejects(collect(f.transport.stream(B, request())), {code: 'CPA_ACCOUNT_INACTIVE'});
  assert.equal(f.calls.length, 0);
  const active = await collect(f.transport.stream(A, request()));
  assert.equal(active.at(-1).reason.kind, 'stop'); assert.equal(f.calls.length, 1);
  assert.equal(new Headers(f.calls[0].init.headers).get('chatgpt-account-id'), 'upstream-' + A);
  assert.equal(f.registered.get('openai-codex'), f.host);
});

test('switching from A to B invalidates an unstarted A prepared call without redirecting its frozen options', async t => {
  let enabled = A;
  const f = await fixture(t, {isEnabled: id => id === enabled});
  const old = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  const options = Object.freeze({...request(), ...old.config});
  enabled = B;
  const refused = await collect(old.stream(options));
  assert.equal(refused.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.calls.length, 0);
  assert.equal(options.provider, provider(A)); assert.equal(readEvidence(refused.at(-1)).accountId, A);
  const next = await collect(f.transport.stream(B, request()));
  assert.equal(next.at(-1).reason.kind, 'stop'); assert.equal(f.calls.length, 1);
  assert.equal(new Headers(f.calls[0].init.headers).get('chatgpt-account-id'), 'upstream-' + B);
});

test('the root switching gate denies every paid route, then permits a fresh preparation after a persisted selection', async t => {
  let enabled = A, switching = false;
  const f = await fixture(t, {isEnabled: id => !switching && id === enabled});
  const before = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  switching = true;
  for (const id of [A, B]) await assert.rejects(f.llm.prepareCall({provider: provider(id), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE'});
  const old = await collect(before.stream({...request(), ...before.config}));
  assert.equal(old.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.calls.length, 0);
  assert.ok((await f.transport.listModels(B)).length > 0);
  enabled = B; switching = false;
  await collect(f.transport.stream(B, request()));
  enabled = A;
  const again = await collect(f.transport.stream(A, request()));
  assert.equal(again.at(-1).reason.kind, 'stop'); assert.equal(f.calls.length, 2);
  assert.equal(f.registered.get('openai-codex'), f.host);
});

test('all CPA accounts may be disabled without hiding their saved metadata or changing the host route', async t => {
  const f = await fixture(t, {isEnabled: () => false});
  for (const id of [A, B]) {
    assert.ok((await f.transport.listModels(id)).length > 0);
    await assert.rejects(collect(f.transport.stream(id, request())), {code: 'CPA_ACCOUNT_INACTIVE'});
  }
  assert.equal(f.calls.length, 0); assert.equal(f.registered.get('openai-codex'), f.host);
});

test('a policy change while capture is pending is rejected before returning a prepared call', async t => {
  let enabled = A;
  const f = await fixture(t, {isEnabled: id => id === enabled}), entered = deferred(), gate = deferred(), original = f.accounts.capture;
  f.accounts.capture = async (...args) => {const binding = await original(...args); entered.resolve(); await gate.promise; return binding;};
  const rejected = assert.rejects(f.llm.prepareCall({provider: provider(A), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE'});
  await entered.promise; enabled = B; gate.resolve(); await rejected;
  assert.equal(f.calls.length, 0);
});

test('requestGuard rechecks policy after an awaited identity assertion before any model I/O', async t => {
  let enabled = A, block = false;
  const f = await fixture(t, {isEnabled: id => id === enabled}), entered = deferred(), gate = deferred(), original = f.accounts.capture;
  f.accounts.capture = async (...args) => {const binding = await original(...args); return {...binding, assertCurrent: async () => {
    if (block) {entered.resolve(); await gate.promise;} await binding.assertCurrent();
  }};};
  const prepared = await f.llm.prepareCall({provider: provider(A), model: MODEL});
  block = true;
  const pending = collect(prepared.stream({...request(), ...prepared.config}));
  await entered.promise; enabled = B; gate.resolve();
  const chunks = await pending;
  assert.equal(chunks.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.calls.length, 0);
});

test('native fetch policy guard closes the gap after scoped authentication resolves', async t => {
  let enabled = A;
  const f = await fixture(t, {isEnabled: id => id === enabled}), original = f.accounts.capture;
  f.accounts.capture = async (...args) => {const binding = await original(...args); return {...binding, credentials: {...binding.credentials,
    async read(key) {const value = await binding.credentials.read(key); enabled = B; return value;},
  }};};
  const chunks = await collect(f.transport.stream(A, request()));
  assert.equal(chunks.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.calls.length, 0);
});

test('native response guard rejects and reclaims a body if its account became inactive during fetch', async t => {
  let enabled = A;
  const entered = deferred(), gate = deferred(), cancelled = deferred();
  const f = await fixture(t, {isEnabled: id => id === enabled, fetchImpl: async () => {entered.resolve(); await gate.promise;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(sseBytes(events('must not escape')));}, cancel() {cancelled.resolve();}}),
      {status: 200, headers: {'content-type': 'text/event-stream'}});}});
  const pending = collect(f.transport.stream(A, request()));
  await entered.promise; enabled = B; gate.resolve();
  const chunks = await pending; await cancelled.promise;
  assert.equal(chunks.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); assert.equal(f.calls.length, 1);
  assert.ok(!chunks.some(chunk => chunk.type === 'text-delta'));
});

test('inactivation during SSE streaming stops old chunks and closes the native reader without touching account B', {timeout: 3000}, async t => {
  let enabled = A;
  const cancelled = deferred();
  const f = await fixture(t, {isEnabled: id => id === enabled, fetchImpl: () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(sseBytes(events().slice(0, 3)));}, cancel() {cancelled.resolve();},
  }), {status: 200, headers: {'content-type': 'text/event-stream'}})});
  const iterator = f.transport.stream(A, request())[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false); enabled = B;
  const rest = []; for (;;) {const next = await iterator.next(); if (next.done) break; rest.push(next.value);}
  assert.equal(rest.at(-1).reason.failure.code, 'CPA_ACCOUNT_INACTIVE'); await cancelled.promise;
  assert.equal(f.calls.length, 1); assert.equal(f.state.get(B).controller.signal.aborted, false);
});

test('throwing, asynchronous or merely truthy policy predicates fail closed with only a fixed safe code', async t => {
  for (const predicate of [() => 'true', () => 1, () => ({}), () => null,
    () => {throw new Error('synthetic-private-policy-error');}, () => Promise.reject(new Error('synthetic-private-async-policy-error'))]) {
    let calls = 0;
    const f = await fixture(t, {isEnabled: id => {calls++; return predicate(id);}});
    assert.ok((await f.transport.listModels(A)).length > 0); assert.equal(calls, 0);
    await assert.rejects(f.llm.prepareCall({provider: provider(A), model: MODEL}), {code: 'CPA_ACCOUNT_INACTIVE', message: 'CPA_ACCOUNT_INACTIVE'});
    assert.equal(f.calls.length, 0);
  }
});

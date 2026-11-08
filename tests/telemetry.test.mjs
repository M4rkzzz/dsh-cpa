import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import * as zlib from 'node:zlib';
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import {createCpaTransport} from '../lib/transport-v026.mjs';
import {createTelemetry} from '../lib/telemetry-v026.mjs';
import {createTelemetry as createLegacyTelemetry} from '../lib/telemetry-v024.mjs';
import {createEvidence, attachEvidence} from '../lib/evidence-v026.mjs';

const done = (kind = 'stop', failure) => ({type: 'finish', reason: {kind, ...(failure ? {failure} : {})}});
const usage = value => ({type: 'usage', usage: value});
const text = value => ({type: 'text-delta', index: 0, text: value});
const options = extra => Object.freeze({provider: 'openai-codex', model: 'synthetic-model', ...extra});
const chunks = (...values) => (async function* () { yield* values; })();
const collect = async stream => { const output = []; for await (const chunk of stream) output.push(chunk); return output; };
const deferred = () => Promise.withResolvers();
function fixture(t, config = {}) {
  let listener, disposed = 0, clock = 0, wall = 0;
  const ctx = {on(name, fn) { assert.equal(name, 'llm/stream'); listener = fn; return () => { disposed++; }; }};
  const telemetry = createTelemetry(ctx, {now: () => clock, dateNow: () => wall, ...config});
  t.after(() => telemetry.dispose());
  return {telemetry, hook: (request, factory) => listener(request, factory),
    tick(time) { clock = time; wall = time; }, wall(time) { wall = time; }, get disposed() { return disposed; }};
}
async function sample(t, value) {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(usage(value), done())));
  return f.telemetry.snapshot().entries[0];
}

test('initial DTO exposes capability, fixed capacity and empty nullable metrics', t => {
  const f = fixture(t), s = f.telemetry.snapshot();
  assert.equal(s.available, true);
  assert.equal(s.limit, 200);
  assert.equal(s.since, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.summary, {total: 0, running: 0, success: 0, error: 0, cancelled: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    avgTtftMs: null, avgDurationMs: null, avgTps: null, avgCacheHitRate: null,
    samples: {ttft: 0, tps: 0, cacheHitRate: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0},
    estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, upperBoundRequests: 0});
  for (const limit of [0, -1, 1001, 1.5, NaN, Infinity, '200', null]) assert.throws(() => createTelemetry({}, {limit}), /invalid-telemetry-limit/);
  assert.throws(() => createTelemetry({}, {now: null}), /invalid-telemetry-clock/);
});

test('hook is synchronous, lazy and preserves chunk identity without pre-reading', async t => {
  const f = fixture(t), payload = Object.freeze(text('synthetic-response'));
  let calls = 0, pulls = 0, returns = 0;
  const upstream = { [Symbol.asyncIterator]() { return this; }, async next() { pulls++; return {value: payload, done: false}; },
    async return() { returns++; return {done: true}; } };
  const stream = f.hook(options(), () => { calls++; return upstream; });
  assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  assert.equal(typeof stream.then, 'undefined');
  assert.equal(calls, 1); assert.equal(pulls, 0); assert.equal(f.telemetry.snapshot().summary.total, 0);
  assert.equal((await stream.next()).value, payload);
  assert.equal(calls, 1); assert.equal(pulls, 1);
  await Promise.resolve();
  assert.equal(pulls, 1);
  assert.equal(f.telemetry.snapshot().summary.running, 1);
  await stream.return();
  assert.equal(returns, 1); assert.equal(pulls, 1);
  assert.equal(f.telemetry.snapshot().entries[0].status, 'cancelled');
});

test('unrelated providers preserve the exact next result and are not observed', t => {
  const f = fixture(t), upstream = chunks(done());
  let calls = 0;
  assert.equal(f.hook(options({provider: 'another-provider'}), () => { calls++; return upstream; }), upstream);
  assert.equal(calls, 1);
  assert.equal(f.telemetry.snapshot().summary.total, 0);
});

test('complete prompt input, token TTFT, elapsed time and TPS use observed values', async t => {
  const f = fixture(t), controller = new AbortController();
  const frames = [text('synthetic'), usage({inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 50, totalTokens: 150}), done()];
  const result = await collect(f.hook(options({signal: controller.signal}), () => (async function* () {
    f.tick(100); yield frames[0];
    f.tick(1100); yield frames[1];
    yield frames[2];
  })()));
  assert.deepEqual(result, frames);
  const s = f.telemetry.snapshot(), e = s.entries[0];
  assert.deepEqual(e, {id: 'cpa-1', source: 'conversation', provider: 'openai-codex', model: 'synthetic-model',
    accountId: null, accountEmail: null, startedAt: '1970-01-01T00:00:00.000Z',
    finishReason: 'stop', usageEvidence: 'host-normalized', serviceTierRequested: null, serviceTierReported: null,
    priceModel: null, priceBasis: 'openai-standard-reference',
    status: 'success', httpStatus: null, errorCode: null, inputTokens: 100, outputTokens: 50,
    cacheHitRate: 0.6, cacheReadTokens: 60, cacheWriteTokens: 20,
    estimatedCostUsd: null, costBasis: 'unknown', ttftMs: 100, durationMs: 1100, tps: 50});
  assert.equal(s.summary.inputTokens, 100); assert.equal(s.summary.outputTokens, 50);
  assert.equal(s.summary.avgTtftMs, 100); assert.equal(s.summary.avgDurationMs, 1100); assert.equal(s.summary.avgTps, 50);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const first of [text('x'), {type: 'reasoning-delta', index: 0, text: 'thinking'},
  {type: 'text-delta', index: 0, delta: 'x'}, {type: 'reasoning-delta', index: 0, delta: 'thinking'},
  {type: 'text-delta', index: 0, text: '', delta: ' '},
  {type: 'reasoning-delta', index: 0, text: null, delta: 'thinking'},
  {type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{'},
  {type: 'tool-call-delta', index: 0, id: 'call-synthetic', argumentsDelta: '', name: 'tool'},
  {type: 'tool-call-delta', index: 0, id: 'call-synthetic', name: 'tool', argumentsDelta: '{'}]) {
  test('TTFT includes nonempty ' + first.type + ' ' + Object.keys(first).at(-1), async t => {
    const f = fixture(t);
    await collect(f.hook(options(), () => (async function* () {
      f.tick(10); yield {type: 'block-start', index: 0, blockType: 'tool-call'}; yield text(''); yield {type: 'reasoning-delta', text: ''};
      yield {type: 'tool-call-delta', index: 0, id: 'call-metadata', argumentsDelta: ''}; yield usage({outputTokens: 1});
      f.tick(20); yield first;
      f.tick(40); yield text('later');
      f.tick(1020); yield done();
    })()));
    const e = f.telemetry.snapshot().entries[0];
    assert.equal(e.ttftMs, 20); assert.equal(e.tps, 1);
  });
}

for (const type of ['text-delta', 'reasoning-delta']) test(type + ' with only delta preserves chunk identity and once-only terminal metrics', async t => {
  const rows = [], f = fixture(t, {onRecord: row => {rows.push(row);}});
  const controller = new AbortController(), first = Object.freeze({type, index: 0, delta: 'synthetic token'}), terminal = done();
  const stream = f.hook(options({signal: controller.signal}), () => (async function* () {
    f.tick(25); yield first;
    f.tick(1025); yield usage({outputTokens: 8}); yield terminal;
    f.tick(5000); yield {type, index: 0, delta: 'late ignored token'}; yield done('error');
  })());
  assert.equal((await stream.next()).value, first);
  assert.equal(f.telemetry.snapshot().entries[0].ttftMs, 25);
  assert.equal(f.telemetry.snapshot().entries[0].tps, null);
  const output = await collect(stream); controller.abort();
  assert.equal(output[1], terminal);
  assert.equal(rows.length, 1); assert.equal(rows[0].ttftMs, 25); assert.equal(rows[0].tps, 8);
  assert.equal(rows[0].durationMs, 1025); assert.equal(rows[0].status, 'success');
  assert.equal(f.telemetry.snapshot().summary.success, 1); assert.equal(f.telemetry.snapshot().summary.samples.tps, 1);
});

test('token field accessors are ignored without losing a safe delta or invoking getters', async t => {
  const f = fixture(t);
  let reads = 0;
  const first = Object.freeze({type: 'text-delta', delta: 'synthetic token', get text() {reads++; throw Error('private getter');}});
  const response = await collect(f.hook(options(), () => (async function* () {
    f.tick(10); yield {type: 'reasoning-delta', get delta() {reads++; return 'not evidence';}};
    f.tick(20); yield first;
    f.tick(1020); yield usage({outputTokens: 2}); yield done();
  })()));
  assert.equal(response[1], first); assert.equal(reads, 0);
  assert.equal(f.telemetry.snapshot().entries[0].ttftMs, 20); assert.equal(f.telemetry.snapshot().entries[0].tps, 2);
});

test('usage/finish and empty or malformed deltas do not invent a first token', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(text(''), {type: 'reasoning-delta', text: false},
    {type: 'tool-call-delta', id: 'call-metadata', argumentsDelta: ''},
    {type: 'tool-call-delta', argumentsDelta: {}, name: ''},
    {type: 'tool-call-delta', arguments: 'not-a-delta-field'}, {type: 'thinking_delta', delta: 'not-the-host-protocol'},
    ...[undefined, null, '', false, 0, [], {}, {text: 'not-a-string'}].flatMap(delta => [
      {type: 'text-delta', delta}, {type: 'reasoning-delta', delta}]),
    {type: 'usage', delta: 'not-a-token'}, {type: 'block-start', delta: 'not-a-token'},
    usage({inputTokens: 2, outputTokens: 3, totalTokens: 5}), done())));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.ttftMs, null); assert.equal(e.tps, null);
  assert.deepEqual(f.telemetry.snapshot().summary.samples, {ttft: 0, tps: 0, cacheHitRate: 0,
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0});
});

test('real pi-ai tool delta starts TTFT at argumentsDelta after ID-only metadata', async t => {
  const f = fixture(t);
  const blockStart = {type: 'block-start', index: 0, blockType: 'tool-call'};
  const metadata = {type: 'tool-call-delta', index: 0, id: 'call-synthetic', argumentsDelta: ''};
  const fragment = {type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{'};
  const output = await collect(f.hook(options(), () => (async function* () {
    f.tick(10); yield blockStart;
    f.tick(20); yield metadata;
    f.tick(50); yield fragment;
    f.tick(1050); yield usage({outputTokens: 2}); yield done('tool-calls');
  })()));
  assert.equal(output[0], blockStart); assert.equal(output[1], metadata); assert.equal(output[2], fragment);
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.ttftMs, 50); assert.equal(e.durationMs, 1050); assert.equal(e.tps, 2);
});

test('tool IDs and completed block metadata alone never create a token timing sample', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => (async function* () {
    f.tick(10); yield {type: 'block-start', index: 0, blockType: 'tool-call'};
    f.tick(20); yield {type: 'tool-call-delta', index: 0, id: 'call-synthetic', argumentsDelta: ''};
    f.tick(30); yield {type: 'block-end', index: 0, block: {type: 'tool-call', id: 'call-synthetic', name: 'synthetic-tool', arguments: '{}'}};
    f.tick(1000); yield usage({outputTokens: 2}); yield done('tool-calls');
  })()));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.status, 'success'); assert.equal(e.ttftMs, null); assert.equal(e.tps, null);
  assert.equal(f.telemetry.snapshot().summary.samples.ttft, 0);
});

test('legacy cache accounting preserves positives but never derives exact zero', async t => {
  const cases = [
    [{inputTokens: 20, outputTokens: 10, totalTokens: 110, cacheReadTokens: 80}, 100, 0.8],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, cacheWriteTokens: 20}, 100, 0.6],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30}, 20, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheWriteTokens: 5}, 25, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35}, 25, null],
    [{inputTokens: 20, outputTokens: 10}, null, null],
    [{inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0}, null, null],
    [{inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5}, 30, 1 / 6],
    [{outputTokens: 10, totalTokens: 30, cacheReadTokens: 5}, 20, 0.25],
    [{outputTokens: 10, totalTokens: 30}, 20, null],
    [{inputTokens: 0, outputTokens: 10, totalTokens: 10}, null, null],
    [{inputTokens: 0, outputTokens: 0, totalTokens: 0}, null, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: null}, 20, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheWriteTokens: false}, 20, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 20}, null, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 5}, null, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0}, 25, null],
    [{inputTokens: 0, outputTokens: 10, totalTokens: 5}, null, null],
    [{inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1, cacheWriteTokens: 0}, null, null],
  ];
  for (const [value, prompt, rate] of cases) {
    const e = await sample(t, value);
    assert.equal(e.inputTokens, prompt, JSON.stringify(value));
    assert.equal(e.cacheHitRate, rate, JSON.stringify(value));
  }
});

test('token counters are numeric safe integers, never coercible false zeroes', async t => {
  for (const value of [null, '', '10', true, false, [], [1], {}, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const e = await sample(t, {inputTokens: value, outputTokens: value, totalTokens: value, cacheReadTokens: value, cacheWriteTokens: value});
    assert.equal(e.inputTokens, null); assert.equal(e.outputTokens, null); assert.equal(e.cacheHitRate, null);
  }
});

test('latest cumulative usage replaces previous counts rather than summing', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(usage({inputTokens: 10, outputTokens: 1, totalTokens: 11}),
    usage({inputTokens: 10, outputTokens: 4, totalTokens: 14}), done())));
  const s = f.telemetry.snapshot();
  assert.equal(s.summary.inputTokens, 10); assert.equal(s.summary.outputTokens, 4);
});

test('missing usage remains unknown and absent metrics never enter means', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(done())));
  f.tick(10);
  await collect(f.hook(options(), () => (async function* () {
    f.tick(30); yield text('x');
    f.tick(1030); yield usage({inputTokens: 2, outputTokens: 0, totalTokens: 2}); yield done();
  })()));
  const s = f.telemetry.snapshot();
  assert.equal(s.entries[1].inputTokens, null); assert.equal(s.entries[1].outputTokens, null);
  assert.equal(s.summary.avgTtftMs, 20); assert.equal(s.summary.avgTps, null); assert.equal(s.summary.avgCacheHitRate, null);
  assert.equal(s.summary.avgDurationMs, 510);
  assert.deepEqual(s.summary.samples, {ttft: 1, tps: 0, cacheHitRate: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0});
});

test('zero/negative generation duration yields unknown TPS, not infinity', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(text('x'), usage({outputTokens: 10}), done())));
  assert.equal(f.telemetry.snapshot().entries[0].tps, null);
  f.tick(100);
  await collect(f.hook(options(), () => (async function* () {
    f.tick(50); yield text('x'); yield usage({outputTokens: 10}); f.tick(25); yield done();
  })()));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.ttftMs, null); assert.equal(e.durationMs, null); assert.equal(e.tps, null);
});

test('only structured failure status is exposed and success does not guess HTTP 200', async t => {
  const f = fixture(t);
  for (const status of [401, 429, 500, 100, 599, undefined, null, '429', 99, 600, 200.5, true]) {
    await collect(f.hook(options(), () => chunks(done('error', {message: 'synthetic raw 429 secret', code: 'RATE_LIMIT', status}))));
    const e = f.telemetry.snapshot().entries[0];
    assert.equal(e.httpStatus, Number.isInteger(status) && status >= 100 && status <= 599 ? status : null);
    assert.equal(e.errorCode, 'RATE_LIMIT');
  }
  await collect(f.hook(options(), () => chunks(done('stop', {status: 200}))));
  assert.equal(f.telemetry.snapshot().entries[0].httpStatus, null);
  await collect(f.hook(options(), () => chunks(done('error', {code: 'AUTH', message: 'HTTP 403'}))));
  assert.equal(f.telemetry.snapshot().entries[0].httpStatus, null);
});

test('error identity passes through and arbitrary error text/code is not retained', async t => {
  const f = fixture(t);
  for (const synchronous of [true, false]) {
    const error = Object.assign(Error('synthetic-private-payload'), {code: 'synthetic-private-token', failure: {code: 'synthetic-private-token', status: 503, requestId: 'synthetic-identity'}});
    const factory = synchronous ? () => { throw error; } : async function* () { yield text('synthetic-response'); throw error; };
    await assert.rejects(async () => collect(f.hook(options({sessionId: 'synthetic-session', headers: {authorization: 'synthetic-token'}, messages: ['synthetic-prompt']}), factory)), actual => actual === error);
    const e = f.telemetry.snapshot().entries[0];
    assert.equal(e.errorCode, 'UNKNOWN'); assert.equal(e.httpStatus, 503);
    const serialized = JSON.stringify(f.telemetry.snapshot());
    for (const secret of ['synthetic-private', 'synthetic-identity', 'synthetic-session', 'synthetic-prompt', 'synthetic-response', 'synthetic-token']) assert.equal(serialized.includes(secret), false);
  }
});

test('normal terminal reasons and failures settle exactly once', async t => {
  const f = fixture(t);
  for (const [kind, status] of [['stop', 'success'], ['tool-calls', 'success'], ['max-tokens', 'success'], ['error', 'error'], ['aborted', 'cancelled'], ['unknown', 'error']]) {
    await collect(f.hook(options(), () => chunks(done(kind), done('error'), usage({inputTokens: 999, outputTokens: 999, totalTokens: 1998}))));
    assert.equal(f.telemetry.snapshot().entries[0].status, status);
  }
  const s = f.telemetry.snapshot().summary;
  assert.equal(s.total, 6); assert.equal(s.running, 0); assert.equal(s.success, 3); assert.equal(s.error, 2); assert.equal(s.cancelled, 1);
  assert.equal(s.inputTokens, null); assert.equal(s.outputTokens, null);
});

test('exhaustion without finish records STREAM_CLOSED, not success', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(text('partial'))));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.status, 'error'); assert.equal(e.errorCode, 'STREAM_CLOSED');
});

test('abort settles a pending probe immediately without terminating or consuming its stream', {timeout: 2000}, async t => {
  const f = fixture(t), controller = new AbortController(), started = deferred(), pending = deferred();
  const frame = text('late synthetic'), reason = Object.assign(Error('pelican-cancelled'), {name: 'AbortError', code: 'pelican-cancelled'});
  let returns = 0;
  const stream = f.telemetry.observeProbe(options({signal: controller.signal}), () => ({
    [Symbol.asyncIterator]() { return this; }, next() { started.resolve(); return pending.promise; },
    return() { returns++; return Promise.resolve({done: true}); },
  }));
  const pull = stream.next(); await started.promise;
  f.tick(200); controller.abort(reason);
  assert.equal(f.telemetry.snapshot().entries[0].status, 'cancelled');
  assert.equal(f.telemetry.snapshot().entries[0].errorCode, 'pelican-cancelled');
  assert.equal(f.telemetry.snapshot().summary.running, 0); assert.equal(returns, 0);
  pending.resolve({done: false, value: frame});
  assert.equal((await pull).value, frame);
  await stream.return();
  assert.equal(returns, 1); assert.equal(f.telemetry.snapshot().summary.cancelled, 1);
  assert.equal(f.telemetry.snapshot().entries[0].ttftMs, null);
});

test('probe timeout is an error and late abort cannot override an observed finish', async t => {
  const f = fixture(t), first = new AbortController();
  const stream = f.telemetry.observeProbe(options({signal: first.signal}), () => chunks(text('x'), done()));
  await stream.next();
  first.abort(Object.assign(Error('pelican-timeout'), {name: 'TimeoutError', code: 'pelican-timeout'}));
  assert.equal(f.telemetry.snapshot().entries[0].status, 'error');
  assert.equal(f.telemetry.snapshot().entries[0].errorCode, 'pelican-timeout');
  await collect(stream);
  const second = new AbortController();
  await collect(f.telemetry.observeProbe(options({signal: second.signal}), () => chunks(done())));
  second.abort();
  assert.equal(f.telemetry.snapshot().entries[0].status, 'success');
  assert.equal(f.telemetry.snapshot().summary.error, 1); assert.equal(f.telemetry.snapshot().summary.success, 1);
});

test('probe validation abort errors are not classified as user cancellation', async t => {
  const f = fixture(t);
  for (const code of ['pelican-output-limit', 'pelican-invalid-svg', 'pelican-invalid-stream', 'pelican-stream-closed', 'pelican-tool-call', 'pelican-max-tokens', 'pelican-generation-failed']) {
    const controller = new AbortController();
    const stream = f.telemetry.observeProbe(options({signal: controller.signal}), () => chunks(text('x'), done()));
    await stream.next();
    controller.abort(Object.assign(Error(code), {code}));
    assert.equal(f.telemetry.snapshot().entries[0].status, 'error', code);
    assert.equal(f.telemetry.snapshot().entries[0].errorCode, code);
    await collect(stream);
    assert.equal(f.telemetry.snapshot().entries[0].status, 'error', code);
  }
});

test('pre-aborted signals are observed without changing original factory or error behavior', async t => {
  const f = fixture(t), controller = new AbortController();
  controller.abort();
  let called = 0;
  await collect(f.hook(options({signal: controller.signal}), () => { called++; return chunks(done()); }));
  assert.equal(called, 1);
  assert.equal(f.telemetry.snapshot().entries[0].status, 'cancelled');
});

test('clear detaches old in-flight listeners and late results cannot repopulate statistics', async t => {
  const f = fixture(t), controller = new AbortController();
  const old = f.hook(options({signal: controller.signal}), () => chunks(text('old'), usage({inputTokens: 100, outputTokens: 100, totalTokens: 200}), done()));
  await old.next();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  f.tick(1000); f.telemetry.clear();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await collect(f.hook(options(), () => chunks(done())));
  const expected = f.telemetry.snapshot();
  assert.equal(expected.since, '1970-01-01T00:00:01.000Z');
  controller.abort(); await collect(old);
  assert.deepEqual(f.telemetry.snapshot(), expected);
});

test('dispose unregisters and clears without aborting or closing normal conversations', async t => {
  const f = fixture(t), controller = new AbortController();
  const frame = text('x'); let returns = 0;
  const stream = f.hook(options({signal: controller.signal}), () => ({[Symbol.asyncIterator]() { return this; },
    async next() { return {value: frame, done: false}; }, async return() { returns++; return {done: true}; }}));
  await stream.next(); f.telemetry.dispose(); f.telemetry.dispose();
  assert.equal(f.disposed, 1); assert.equal(controller.signal.aborted, false); assert.equal(returns, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await stream.next()).value, frame);
  await stream.return();
  assert.equal(f.telemetry.snapshot().available, false); assert.deepEqual(f.telemetry.snapshot().entries, []);
  assert.equal(f.telemetry.snapshot().summary.total, 0);
  const upstream = chunks(done());
  assert.equal(f.hook(options(), () => upstream), upstream);
  await collect(f.telemetry.observeProbe(options(), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().summary.total, 0);
});

test('history and active listeners stay bounded while since totals include evicted streams', async t => {
  const f = fixture(t, {limit: 2}), controllers = [], streams = [];
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const stream = f.hook(options({model: 'gpt-6-' + i, signal: controller.signal}), () => chunks(text('x'), usage({inputTokens: 1, outputTokens: 1, totalTokens: 2}), done()));
    streams.push(stream); await stream.next();
    assert.ok(controllers.reduce((n, c) => n + getEventListeners(c.signal, 'abort').length, 0) <= 2);
  }
  assert.deepEqual(f.telemetry.snapshot().entries.map(e => e.model), ['gpt-6-7', 'gpt-6-6']);
  assert.equal(f.telemetry.snapshot().summary.running, 8);
  for (const stream of streams) await collect(stream);
  const s = f.telemetry.snapshot();
  assert.equal(s.entries.length, 2); assert.equal(s.summary.total, 8); assert.equal(s.summary.success, 8);
  assert.equal(s.summary.running, 0); assert.equal(s.summary.inputTokens, 8); assert.equal(s.summary.outputTokens, 8);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('snapshots are detached and means include only finite observed samples', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(usage({inputTokens: 2, outputTokens: 2, totalTokens: 4}), done())));
  await collect(f.hook(options(), () => chunks(usage({inputTokens: 2, outputTokens: 2, totalTokens: 6, cacheReadTokens: 2}), done())));
  const s = f.telemetry.snapshot();
  assert.equal(s.summary.avgCacheHitRate, 0.5); assert.equal(s.summary.samples.cacheHitRate, 1);
  s.entries[0].status = 'fake'; s.entries.push({}); s.summary.total = -1; s.summary.samples.cacheHitRate = -1;
  const actual = f.telemetry.snapshot();
  assert.equal(actual.entries.length, 2); assert.equal(actual.entries[0].status, 'success');
  assert.equal(actual.summary.total, 2); assert.equal(actual.summary.samples.cacheHitRate, 1);
});

for (const clone of [false, true]) {
  test('probe is lazy and deduplicated through its private SDK chain with ' + (clone ? 'cloned options' : 'original options'), async t => {
    const f = fixture(t), request = options({signal: new AbortController().signal});
    let calls = 0;
    const stream = f.telemetry.observeProbe(request, () => {
      calls++; return f.hook(clone ? {...request} : request, () => chunks(done()));
    });
    assert.equal(calls, 0); assert.equal(f.telemetry.snapshot().summary.total, 0);
    await collect(stream);
    assert.equal(calls, 1); assert.equal(f.telemetry.snapshot().summary.total, 1);
    assert.equal(f.telemetry.snapshot().entries[0].source, 'pelican');
  });
}

test('clear preserves probe deduplication for a not-yet-consumed iterator', async t => {
  const f = fixture(t), request = options({signal: new AbortController().signal});
  const stream = f.telemetry.observeProbe(request, () => f.hook({...request}, () => chunks(done())));
  f.telemetry.clear(); await collect(stream);
  assert.equal(f.telemetry.snapshot().summary.total, 1);
});

test('explicit probes work without an available event hook', async () => {
  for (const ctx of [undefined, {}, {on() { throw Error('unsupported'); }}]) {
    const telemetry = createTelemetry(ctx, {now: () => 0, dateNow: () => 0});
    assert.equal(telemetry.snapshot().available, false);
    await collect(telemetry.observeProbe(options(), () => chunks(done())));
    assert.equal(telemetry.snapshot().entries[0].source, 'pelican');
    assert.equal(telemetry.snapshot().summary.total, 1); telemetry.dispose();
  }
});

test('malformed metadata and diagnostic clocks never alter original stream behavior', async t => {
  const f = fixture(t, {now() { throw Error('clock unavailable'); }});
  const malicious = Object.freeze({get type() { throw Error('hostile metadata'); }});
  const response = await collect(f.hook(options({model: {toString() { throw Error('must not coerce'); }}}), () => chunks(malicious, done())));
  assert.equal(response[0], malicious);
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.model, 'unknown'); assert.equal(e.durationMs, null); assert.equal(e.status, 'success');
});

test('a missing first-token clock sample remains unknown rather than sampling a later token', async t => {
  let calls = 0;
  const f = fixture(t, {now: () => ++calls === 2 ? NaN : calls * 100});
  await collect(f.hook(options(), () => chunks(text('first'), text('later'), usage({outputTokens: 5}), done())));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.ttftMs, null); assert.equal(e.tps, null); assert.equal(e.durationMs, 200);
  assert.equal(calls, 3);
});

test('synchronous waterfall failure keeps its timing and original error identity', t => {
  const f = fixture(t), failure = Object.assign(Error('synthetic'), {code: 'NETWORK'});
  assert.throws(() => f.hook(options(), () => { throw failure; }), actual => actual === failure);
  assert.equal(f.telemetry.snapshot().entries[0].errorCode, 'NETWORK');
  assert.equal(f.telemetry.snapshot().summary.error, 1);
});

test('a failing hook disposer cannot interrupt an in-flight conversation', async () => {
  let hook, unhooks = 0;
  const telemetry = createTelemetry({on(_, listener) { hook = listener; return () => { unhooks++; throw Error('cleanup failed'); }; }});
  const controller = new AbortController(), frame = text('synthetic');
  let closed = 0;
  const stream = hook(options({signal: controller.signal}), () => (async function* () {
    try { yield frame; yield frame; yield done(); } finally { closed++; }
  })());
  await stream.next();
  assert.doesNotThrow(() => telemetry.dispose());
  assert.equal(unhooks, 1); assert.equal(closed, 0); assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await stream.next()).value, frame);
  await collect(stream);
  assert.equal(closed, 1); assert.equal(telemetry.snapshot().summary.total, 0);
});

test('Host totals cannot prove missing or normalized zero cache counters', async t => {
  for (const counts of [
    {inputTokens: 20, outputTokens: 10, totalTokens: 30},
    {inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0},
    {inputTokens: 20, outputTokens: 10, totalTokens: 35},
    {inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: null},
  ]) {
    const row = await sample(t, counts);
    assert.equal(row.cacheReadTokens, null); assert.equal(row.cacheWriteTokens, null);
    assert.equal(row.cacheHitRate, null); assert.equal(row.usageEvidence, 'host-normalized');
  }
  const read = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheReadTokens: 5});
  assert.equal(read.cacheReadTokens, 5); assert.equal(read.cacheWriteTokens, null);
  const write = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheWriteTokens: 5});
  assert.equal(write.cacheReadTokens, null); assert.equal(write.cacheWriteTokens, 5);
});

test('verified Standard price estimates aggregate with coverage and upper-bound counts', async t => {
  const f = fixture(t, {limit: 2});
  const cases = [
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40}, 0.00046, 'estimate'],
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20, totalTokens: 120}, 0.00055, 'upper-bound'],
    ['synthetic-model', {inputTokens: 60, outputTokens: 20, totalTokens: 80}, null, 'unknown'],
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20}, null, 'unknown'],
    ['gpt-6.1-sol', {inputTokens: 100, outputTokens: 20, totalTokens: 120}, null, 'unknown'],
    ['gpt-6.1-sol', {inputTokens: 50, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 10}, 0.000354, 'upper-bound'],
    ['gpt-6.1-sol', {inputTokens: 50, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40}, null, 'unknown'],
  ];
  for (const [model, counts, cost, basis] of cases) {
    await collect(f.hook(options({model}), () => chunks(usage(counts), done())));
    const e = f.telemetry.snapshot().entries[0];
    assert.equal(e.estimatedCostUsd, cost, model); assert.equal(e.costBasis, basis, model);
  }
  const s = f.telemetry.snapshot();
  assert.equal(s.entries.length, 2); assert.equal(s.summary.total, 7);
  assert.equal(s.summary.pricedRequests, 3); assert.equal(s.summary.unpricedRequests, 4);
  assert.equal(s.summary.upperBoundRequests, 2);
  assert.ok(Math.abs(s.summary.estimatedCostUsd - 0.001364) < 1e-12);
  assert.equal(s.pricing.currency, 'USD'); assert.equal(s.pricing.basis, 'OpenAI Standard API');
  assert.equal(s.pricing.checkedAt, '2026-11-08');
  assert.ok(s.pricing.sources.includes('https://developers.openai.com/api/docs/pricing.md'));
  s.pricing.sources.length = 0;
  assert.ok(f.telemetry.snapshot().pricing.sources.length > 0);
  f.telemetry.clear();
  assert.equal(f.telemetry.snapshot().summary.estimatedCostUsd, 0);
  assert.equal(f.telemetry.snapshot().summary.pricedRequests, 0);
});

test('only explicit raw zero can price zero; Host defaultusage stays unknown', async t => {
  const f = fixture(t), request = options({model: 'gpt-5.4'});
  await collect(f.hook(request, () => chunks(done())));
  assert.equal(f.telemetry.snapshot().entries[0].estimatedCostUsd, null);
  await collect(f.hook(request, () => chunks(usage({inputTokens: 0, outputTokens: 0, totalTokens: 0}), done('error'))));
  const missing = f.telemetry.snapshot().entries[0];
  assert.equal(missing.estimatedCostUsd, null); assert.equal(missing.usageEvidence, 'unavailable');
  const audit = createEvidence();
  audit.onRawEvent({type: 'response.completed', response: {usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0,
    input_tokens_details: {cached_tokens: 0, cache_write_tokens: 0}}}});
  await collect(f.hook(request, () => chunks(attachEvidence(done(), audit))));
  const zero = f.telemetry.snapshot().entries[0];
  assert.equal(zero.estimatedCostUsd, 0); assert.equal(zero.usageEvidence, 'provider');
  assert.equal(zero.inputTokens, 0); assert.equal(zero.outputTokens, 0); assert.equal(zero.cacheReadTokens, 0);
  await collect(f.hook(request, () => chunks(
    usage({inputTokens: 10, outputTokens: 1, totalTokens: 11}),
    usage({inputTokens: 10, outputTokens: 2, totalTokens: 12}), done(), done())));
  const s = f.telemetry.snapshot();
  assert.equal(s.summary.pricedRequests, 2); assert.equal(s.summary.unpricedRequests, 2);
  assert.equal(s.summary.estimatedCostUsd, (10 * 2.5 + 2 * 15) / 1_000_000);
});

const rawEvent = (counts, extra = {}) => ({type: 'response.completed', response: {usage: counts, ...extra}});
const tagAll = (audit, ...frames) => frames.map(frame => attachEvidence(frame, audit));
const rawCounts = (extra = {}) => ({input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: {cached_tokens: 40, cache_write_tokens: 0}, ...extra});

test('only registered CPA routes plus native Codex are observed, with reference-counted disposers', async t => {
  const f = fixture(t), provider = 'cpa-codex-account-a';
  for (const invalid of [undefined, null, 5, '', 'openai-codex', 'cpa-codex-', 'cpa-codex-../escape', 'cpa-codex-a b']) {
    assert.throws(() => f.telemetry.registerProvider(invalid), /invalid-telemetry-provider/);
  }
  const before = chunks(done());
  assert.equal(f.hook(options({provider}), () => before), before);
  await collect(f.telemetry.observeProbe(options({provider}), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().summary.total, 0);
  const first = f.telemetry.registerProvider(provider), second = f.telemetry.registerProvider(provider);
  await collect(f.hook(options({provider}), () => chunks(done())));
  first(); first();
  await collect(f.hook(options({provider}), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().summary.total, 2);
  second(); second();
  const after = chunks(done());
  assert.equal(f.hook(options({provider}), () => after), after);
  const lookalike = chunks(done());
  assert.equal(f.hook(options({provider: provider + '-not-registered'}), () => lookalike), lookalike);
  await collect(f.hook(options(), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().summary.total, 3);
  f.telemetry.dispose(); assert.doesNotThrow(() => f.telemetry.registerProvider(provider)());
});

test('raw provider proof overrides Host defaults without double-counting cache or reasoning', async t => {
  const f = fixture(t), provider = 'cpa-codex-account-a'; f.telemetry.registerProvider(provider);
  const audit = createEvidence({accountId: 'account-a', accountEmail: 'a@example.test', serviceTierRequested: 'priority'});
  audit.onHttpStatus(200);
  audit.onRawEvent(rawEvent(rawCounts({output_tokens_details: {reasoning_tokens: 10}}), {service_tier: 'default',
    output: ['private-output'], headers: {authorization: 'private-token'}}));
  const frames = tagAll(audit, usage({inputTokens: 0, outputTokens: 0, totalTokens: 0}), done());
  const output = await collect(f.hook(options({provider, model: 'gpt-5.4', serviceTier: 'priority',
    accountId: 'spoof-account', accountEmail: 'spoof@example.test'}), () => chunks(...frames)));
  assert.equal(output[0], frames[0]); assert.equal(output[1], frames[1]);
  const row = f.telemetry.snapshot().entries[0];
  assert.equal(row.inputTokens, 100); assert.equal(row.outputTokens, 20);
  assert.equal(row.cacheReadTokens, 40); assert.equal(row.cacheWriteTokens, 0); assert.equal(row.cacheHitRate, 0.4);
  assert.equal(row.accountId, 'account-a'); assert.equal(row.accountEmail, 'a@example.test');
  assert.equal(row.provider, provider); assert.equal(row.httpStatus, 200); assert.equal(row.usageEvidence, 'provider');
  assert.equal(row.estimatedCostUsd, 0.00046); assert.equal(row.costBasis, 'estimate');
  assert.equal(row.priceModel, 'gpt-5.4'); assert.equal(row.priceBasis, 'openai-standard-reference');
  assert.equal(row.serviceTierRequested, 'priority'); assert.equal(row.serviceTierReported, 'default');
  assert.equal(row.finishReason, 'stop');
  const serialized = JSON.stringify(f.telemetry.snapshot());
  for (const privateValue of ['private-', 'spoof-account', 'spoof@example.test', 'reasoningTokens', 'evidenceId', 'endedAt']) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test('priority request alone and native options never confirm a served tier or HTTP success', async t => {
  const f = fixture(t), audit = createEvidence({serviceTierRequested: 'priority'});
  await collect(f.hook(options({model: 'gpt-5.4', serviceTier: 'priority'}), () => chunks(attachEvidence(done(), audit))));
  let row = f.telemetry.snapshot().entries[0];
  assert.equal(row.serviceTierRequested, 'priority'); assert.equal(row.serviceTierReported, null); assert.equal(row.httpStatus, null);
  await collect(f.hook(options({serviceTier: 'priority', accountId: 'untrusted-account', accountEmail: 'untrusted@example.test'}), () => chunks(done())));
  row = f.telemetry.snapshot().entries[0];
  assert.equal(row.serviceTierRequested, null); assert.equal(row.serviceTierReported, null);
  assert.equal(row.accountId, null); assert.equal(row.accountEmail, null); assert.equal(row.httpStatus, null);
});

test('missing and malformed raw usage never fall back to normalized counts', async t => {
  const f = fixture(t);
  for (const raw of [undefined, null, false, [], {}, {output_tokens: 10, total_tokens: 30},
    {input_tokens: '20', output_tokens: 10, total_tokens: 30}]) {
    const audit = createEvidence(); audit.onRawEvent(rawEvent(raw));
    await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(
      usage({inputTokens: 20, outputTokens: 10, totalTokens: 30}), attachEvidence(done(), audit))));
    const row = f.telemetry.snapshot().entries[0];
    assert.equal(row.inputTokens, null); assert.equal(row.estimatedCostUsd, null);
    assert.equal(row.cacheReadTokens, null); assert.equal(row.cacheWriteTokens, null);
    assert.equal(row.usageEvidence, raw && !Array.isArray(raw) && typeof raw === 'object' ? 'provider' : 'unavailable');
  }
});

test('raw cache absence stays null, raw zero survives, and malformed raw fields prevent pricing', async t => {
  const f = fixture(t);
  const cases = [
    [{input_tokens: 20, output_tokens: 10, total_tokens: 30}, null, null, 0.0002, 'upper-bound'],
    [{input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: {cached_tokens: 0}}, 0, null, 0.0002, 'estimate'],
    [{input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: {cached_tokens: null}}, null, null, 0.0002, 'upper-bound'],
    [{input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: {cached_tokens: false}}, null, null, null, 'unknown'],
    [{input_tokens: 20, output_tokens: 10, total_tokens: '30', input_tokens_details: {cached_tokens: 0}}, 0, null, null, 'unknown'],
    [{input_tokens: 20, output_tokens: 10, total_tokens: 29, input_tokens_details: {cached_tokens: 0}}, 0, null, null, 'unknown'],
    [{input_tokens: 20, output_tokens: 10, input_tokens_details: []}, null, null, null, 'unknown'],
    [{input_tokens: 20, output_tokens: 10, input_tokens_details: {cached_tokens: 21}}, 21, null, null, 'unknown'],
  ];
  for (const [raw, read, write, cost, basis] of cases) {
    const audit = createEvidence(); audit.onRawEvent(rawEvent(raw));
    await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(attachEvidence(done(), audit))));
    const row = f.telemetry.snapshot().entries[0];
    assert.equal(row.cacheReadTokens, read); assert.equal(row.cacheWriteTokens, write);
    assert.equal(row.estimatedCostUsd, cost); assert.equal(row.costBasis, basis);
  }
});

test('raw GPT-6 write-cache absence remains unpriced, while confirmed zero permits reference pricing', async t => {
  const f = fixture(t);
  for (const write of [undefined, null, false, 0, 10]) {
    const audit = createEvidence();
    audit.onRawEvent(rawEvent(rawCounts({input_tokens_details: {cached_tokens: 40, cache_write_tokens: write}})));
    await collect(f.hook(options({model: 'gpt-6.1-sol'}), () => chunks(attachEvidence(done(), audit))));
    const row = f.telemetry.snapshot().entries[0];
    if (write === 0 || write === 10) {
      assert.equal(row.estimatedCostUsd, write === 0 ? 0.000324 : 0.000354);
      assert.equal(row.costBasis, write === 0 ? 'estimate' : 'upper-bound'); assert.equal(row.priceModel, 'gpt-6.1-sol');
    } else { assert.equal(row.estimatedCostUsd, null); assert.equal(row.cacheWriteTokens, null); }
  }
});

test('malformed legacy totals cannot become apparently valid reference estimates', async t => {
  const f = fixture(t);
  for (const totalTokens of [false, '120', -1, Infinity]) {
    await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(
      usage({inputTokens: 50, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens}), done())));
    assert.equal(f.telemetry.snapshot().entries[0].estimatedCostUsd, null);
  }
});

test('concurrent accounts sharing model and AbortSignal keep each call audit independent', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  const a = createEvidence({accountId: 'a', accountEmail: 'a@example.test', serviceTierRequested: 'priority'});
  const b = createEvidence({accountId: 'b', accountEmail: 'b@example.test'});
  a.onHttpStatus(200); a.onRawEvent(rawEvent(rawCounts()));
  b.onHttpStatus(429);
  const providerA = 'cpa-codex-a', providerB = 'cpa-codex-b';
  f.telemetry.registerProvider(providerA); f.telemetry.registerProvider(providerB);
  const first = f.hook(options({provider: providerA, model: 'gpt-5.4', signal}), () => chunks(...tagAll(a, text('private-a'), done())));
  const second = f.hook(options({provider: providerB, model: 'gpt-5.4', signal}), () => chunks(...tagAll(b, text('private-b'), done('error', {code: 'RATE_LIMIT'}))));
  await first.next(); await second.next(); await collect(second); await collect(first);
  const [rowB, rowA] = f.telemetry.snapshot().entries;
  assert.equal(rowA.accountId, 'a'); assert.equal(rowA.httpStatus, 200); assert.equal(rowA.inputTokens, 100);
  assert.equal(rowA.estimatedCostUsd, 0.00046); assert.equal(rowA.serviceTierRequested, 'priority');
  assert.equal(rowB.accountId, 'b'); assert.equal(rowB.httpStatus, 429); assert.equal(rowB.inputTokens, null);
  assert.equal(rowB.estimatedCostUsd, null); assert.equal(rowB.serviceTierRequested, null);
  assert.equal(rowB.errorCode, 'RATE_LIMIT'); assert.equal(rowB.finishReason, 'error');
});

test('conflicting audit IDs in one stream fail closed instead of mixing request metadata', async t => {
  const f = fixture(t), a = createEvidence({accountId: 'a'}), b = createEvidence({accountId: 'b'});
  a.onHttpStatus(200); a.onRawEvent(rawEvent(rawCounts())); b.onHttpStatus(429); b.onRawEvent(rawEvent(rawCounts()));
  await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(attachEvidence(text('x'), a),
    attachEvidence(usage({inputTokens: 1, outputTokens: 1}), b), attachEvidence(done(), a))));
  const row = f.telemetry.snapshot().entries[0];
  assert.equal(row.accountId, null); assert.equal(row.httpStatus, null); assert.equal(row.estimatedCostUsd, null);
  assert.equal(row.inputTokens, null); assert.equal(row.usageEvidence, 'unavailable');
});

test('synchronous and asynchronous tagged errors preserve identity and expose safe per-call evidence', async t => {
  const f = fixture(t);
  for (const synchronous of [true, false]) {
    const audit = createEvidence({accountId: 'a', accountEmail: 'a@example.test'}); audit.onHttpStatus(401);
    const failure = attachEvidence(Object.assign(Error('private-response'), {code: 'MISSING_CREDENTIAL',
      headers: {authorization: 'private-token'}, requestId: 'private-id'}), audit);
    const factory = synchronous ? () => { throw failure; } : async function* () { throw failure; };
    await assert.rejects(async () => collect(f.hook(options(), factory)), error => error === failure);
    const row = f.telemetry.snapshot().entries[0];
    assert.equal(row.httpStatus, 401); assert.equal(row.errorCode, 'MISSING_CREDENTIAL'); assert.equal(row.accountId, 'a');
    assert.equal(row.estimatedCostUsd, null); assert.equal(JSON.stringify(row).includes('private-'), false);
  }
});

test('public SDK error codes and finish reasons are retained, not error message guesses', async t => {
  const {LlmError, ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE,
    EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, IMAGE_OFFLOAD_REQUIRED_CODE} = await import('@deepseek-ai/dsh-llm');
  const f = fixture(t);
  const codes = [ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE, CONTEXT_WINDOW_EXCEEDED_CODE,
    EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, IMAGE_OFFLOAD_REQUIRED_CODE, 'MISSING_CREDENTIAL',
    'UNKNOWN_MODEL', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_CONTENT', 'INVALID_REPLAY_STATE', 'REQUEST_HEADERS', 'INVALID_ARGS'];
  for (const code of codes) {
    const failure = new LlmError('private-error-text', code, {status: 429});
    await assert.rejects(async () => collect(f.hook(options(), () => { throw failure; })), error => error === failure);
    assert.equal(f.telemetry.snapshot().entries[0].errorCode, code);
    assert.equal(f.telemetry.snapshot().entries[0].httpStatus, 429);
  }
  for (const kind of ['stop', 'tool-calls', 'max-tokens', 'error', 'aborted', 'private-finish']) {
    await collect(f.hook(options(), () => chunks(done(kind))));
    assert.equal(f.telemetry.snapshot().entries[0].finishReason, kind === 'private-finish' ? null : kind);
  }
});

test('probe SDK dispatch after await is counted once, unrelated same-signal calls remain conversations', async t => {
  const f = fixture(t), request = options({signal: new AbortController().signal});
  const entered = deferred(), release = deferred();
  const probe = f.telemetry.observeProbe(request, () => (async function* () {
    entered.resolve(); await release.promise;
    yield* f.hook({...request}, () => chunks(text('probe'), done()));
  })());
  const pending = probe.next(); await entered.promise;
  await collect(f.hook(request, () => chunks(done())));
  release.resolve(); await pending; await collect(probe);
  await collect(f.hook(request, () => chunks(done())));
  const rows = f.telemetry.snapshot().entries;
  assert.equal(rows.length, 3); assert.deepEqual(rows.map(row => row.source), ['conversation', 'conversation', 'pelican']);
  assert.equal(f.telemetry.snapshot().summary.total, 3);
});

test('token sums disclose sample coverage and explicit raw zero participates in timing/rate samples', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().summary.inputTokens, null); assert.equal(f.telemetry.snapshot().summary.samples.inputTokens, 0);
  const audit = createEvidence();
  audit.onRawEvent(rawEvent({input_tokens: 20, output_tokens: 0, total_tokens: 20,
    input_tokens_details: {cached_tokens: 0, cache_write_tokens: 0}}));
  await collect(f.hook(options(), () => (async function* () {
    f.tick(10); yield attachEvidence(text('x'), audit);
    f.tick(1010); yield attachEvidence(done(), audit);
  })()));
  const s = f.telemetry.snapshot();
  assert.equal(s.summary.inputTokens, 20); assert.equal(s.summary.outputTokens, 0);
  assert.equal(s.summary.cacheReadTokens, 0); assert.equal(s.summary.cacheWriteTokens, 0);
  assert.deepEqual(s.summary.samples, {ttft: 1, tps: 1, cacheHitRate: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1});
  assert.equal(s.summary.avgTps, 0); assert.equal(s.summary.avgCacheHitRate, 0);
  assert.equal(s.entries[0].tps, 0); assert.equal(s.entries[1].outputTokens, null);
});

test('onRecord gets one detached terminal whitelist row and never waits for disk backpressure', {timeout: 2000}, async t => {
  const rows = [], gate = deferred();
  const f = fixture(t, {onRecord(row) { rows.push(row); return gate.promise; }});
  const end = done(), stream = f.hook(options(), () => chunks(text('private-output'), end, done('error')));
  assert.equal(rows.length, 0);
  await stream.next(); assert.equal(rows.length, 0);
  assert.equal((await stream.next()).value, end);
  assert.equal(rows.length, 1); assert.equal(f.telemetry.snapshot().recording.pending, 1);
  await collect(stream); assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'source', 'startedAt', 'provider', 'model', 'accountId', 'accountEmail',
    'status', 'finishReason', 'httpStatus', 'errorCode', 'serviceTierRequested', 'serviceTierReported', 'usageEvidence',
    'priceBasis', 'priceModel', 'cacheHitRate', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'estimatedCostUsd', 'costBasis', 'ttftMs', 'durationMs', 'tps'].sort());
  assert.equal(rows[0].status, 'success'); assert.equal(Object.hasOwn(rows[0], 'endedAt'), false);
  rows[0].status = 'fake'; rows[0].accountEmail = 'fake@example.test';
  assert.equal(f.telemetry.snapshot().entries[0].status, 'success'); assert.equal(f.telemetry.snapshot().entries[0].accountEmail, null);
  gate.resolve(); await new Promise(setImmediate);
  assert.deepEqual(f.telemetry.snapshot().recording, {pending: 0, failed: 0, error: null});
});

test('synchronous sink throws, rejected promises, and hostile thenables are observed with a safe error', async t => {
  for (const sink of [() => { throw Error('private-disk-error'); }, () => Promise.reject(Error('private-disk-error')),
    () => ({get then() { throw Error('private-disk-error'); }})]) {
    const f = fixture(t, {onRecord: sink});
    await collect(f.hook(options(), () => chunks(done())));
    await new Promise(setImmediate);
    const s = f.telemetry.snapshot();
    assert.equal(s.entries[0].status, 'success');
    assert.deepEqual(s.recording, {pending: 0, failed: 1, error: 'record-write-failed'});
    assert.equal(JSON.stringify(s).includes('private-disk-error'), false);
  }
  assert.throws(() => createTelemetry({}, {onRecord: false}), /invalid-telemetry-sink/);
});

test('RAM eviction never suppresses terminal persistence, while clear invalidates old in-flight rows', async t => {
  const rows = [], f = fixture(t, {limit: 1, onRecord(row) { rows.push(row); }}), streams = [];
  for (let i = 0; i < 5; i++) {
    const stream = f.hook(options(), () => chunks(text('x'), done())); streams.push(stream); await stream.next();
  }
  for (const stream of streams) await collect(stream);
  assert.equal(f.telemetry.snapshot().entries.length, 1); assert.equal(rows.length, 5);
  const stale = f.hook(options(), () => chunks(text('old'), done())); await stale.next();
  f.telemetry.clear(); await collect(stale); assert.equal(rows.length, 5);
  await collect(f.hook(options(), () => chunks(done()))); assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => row.id)).size, 6);
});

test('abort/error/iterator-return terminals each persist once despite late upstream results', async t => {
  const rows = [], f = fixture(t, {onRecord(row) { rows.push(row); }}), controller = new AbortController();
  const stream = f.telemetry.observeProbe(options({signal: controller.signal}), () => chunks(text('x'), done(), done('error')));
  await stream.next(); controller.abort(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'cancelled');
  await collect(stream); assert.equal(rows.length, 1);
  const returned = f.hook(options(), () => chunks(text('x'), done())); await returned.next(); await returned.return();
  assert.equal(rows.length, 2); assert.equal(rows[1].status, 'cancelled');
  const error = Error('private-error');
  await assert.rejects(async () => collect(f.hook(options(), async function* () { throw error; })), value => value === error);
  assert.equal(rows.length, 3); assert.equal(rows[2].status, 'error');
});

test('priceModel resolves only verified aliases and stays a Standard reference even for priority evidence', async t => {
  const f = fixture(t), audit = createEvidence({serviceTierRequested: 'priority'});
  audit.onRawEvent(rawEvent(rawCounts(), {service_tier: 'priority'}));
  await collect(f.hook(options({model: 'gpt-5.4-2026-03-05'}), () => chunks(attachEvidence(done(), audit))));
  const row = f.telemetry.snapshot().entries[0];
  assert.equal(row.model, 'gpt-5.4-2026-03-05'); assert.equal(row.priceModel, 'gpt-5.4');
  assert.equal(row.priceBasis, 'openai-standard-reference'); assert.equal(row.estimatedCostUsd, 0.00046);
  assert.equal(row.serviceTierReported, 'priority');
});

test('legacy telemetry module remains available to old cached entry imports', async () => {
  let listener;
  const legacy = createLegacyTelemetry({on(_, fn) { listener = fn; return () => {}; }}, {now: () => 0, dateNow: () => 0});
  try { await collect(listener(options(), () => chunks(done()))); assert.equal(legacy.snapshot().summary.success, 1); }
  finally { legacy.dispose(); }
});

test('single-account policy counters survive display eviction and manual clear without retaining rows', async t => {
  const f = fixture(t, {limit: 1}), route = 'cpa-codex-a';
  f.telemetry.registerProvider(route);
  const stream = f.hook(options({provider: route}), () => chunks(text('hold'), done()));
  assert.equal(f.telemetry.hasRunningConversation(route), false);
  await stream.next();
  assert.equal(f.telemetry.hasRunningConversation(route), true);
  await collect(f.hook(options({provider: route}), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().entries[0].status, 'success');
  assert.equal(f.telemetry.hasRunningConversation(route), true);
  f.telemetry.clear();
  assert.equal(f.telemetry.snapshot().summary.running, 0);
  assert.equal(f.telemetry.hasRunningConversation(route), true);
  await stream.return();
  assert.equal(f.telemetry.hasRunningConversation(route), false);
});

test('independent conversation counters release on done, return, throw, and disposal, not on probe work', async t => {
  const f = fixture(t), route = 'cpa-codex-a';
  f.telemetry.registerProvider(route);
  const first = f.hook(options({provider: route}), () => chunks(text('a'), done()));
  const second = f.hook(options({provider: route}), () => chunks(text('b'), done()));
  await first.next(); await second.next();
  await first.return(); assert.equal(f.telemetry.hasRunningConversation(route), true);
  await collect(second); assert.equal(f.telemetry.hasRunningConversation(route), false);
  const failed = f.hook(options({provider: route}), () => (async function* () {throw Error('synthetic private failure');})());
  await assert.rejects(collect(failed)); assert.equal(f.telemetry.hasRunningConversation(route), false);
  const probe = f.telemetry.observeProbe(options({provider: route}), () => chunks(text('probe'), done()));
  await probe.next(); assert.equal(f.telemetry.hasRunningConversation(route), false); await probe.return();
  const retired = f.hook(options({provider: route}), () => chunks(text('old'), done()));
  await retired.next(); f.telemetry.dispose(); assert.equal(f.telemetry.hasRunningConversation(route), false); await retired.return();
});

for (const code of ['CPA_ACCOUNT_INACTIVE', 'CPA_BINDING_MISMATCH', 'CPA_TRANSPORT_FAILED']) test('fixed owned transport error survives the metadata allowlist: ' + code, async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(done('error', {code}))));
  assert.equal(f.telemetry.snapshot().entries[0].errorCode, code);
});

// No network, ambient auth, disk profile or mocked adapter chunks: production
// CPA transport -> bundled public PiAiAdapter -> pi-ai's real SSE parser.
async function sdkFixture(t, {defaultClock = false} = {}) {
  const ctx = new Context();
  new LlmRuntime(ctx);
  const accountId = 'telemetry-synthetic', provider = 'cpa-codex-' + accountId;
  const signal = new AbortController().signal, fetched = deferred(), rows = [], calls = [];
  const access = 'synthetic.' + Buffer.from(JSON.stringify({sub: 'telemetry-subject',
    'https://api.openai.com/auth': {chatgpt_account_id: 'telemetry-upstream'}})).toString('base64url') + '.signature';
  const binding = {accountId, providerId: provider, email: 'telemetry@example.test', principalHash: 'synthetic-principal', signal,
    assertCurrent: async () => {}, credentials: {
      async read(key) {assert.equal(key, provider); return {type: 'oauth', access,
        refresh: 'synthetic-never-refresh', expires: 4102444800000, accountId: 'telemetry-upstream'};},
      async modify() {throw Error('synthetic grant must never refresh');},
    }};
  let clock = 0, wall = 0, body;
  const telemetry = createTelemetry(ctx, {...(defaultClock ? {} : {now: () => clock}),
    dateNow: () => wall, onRecord: row => {rows.push(row);}});
  const transport = createCpaTransport(ctx, {telemetry, getFast: () => true, accounts: {
    async list() {return [{id: accountId, provider, email: binding.email}];},
    async capture(id, route) {assert.equal(id, accountId); assert.equal(route, provider); return binding;},
  }, fetchImpl: async (input, init) => {
    assert.equal(String(input), 'https://chatgpt.com/backend-api/codex/responses');
    const bytes = Buffer.from(init.body), headers = new Headers(init.headers);
    calls.push(JSON.parse((headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8')));
    const response = new Response(new ReadableStream({start(controller) {body = controller;}}),
      {status: 200, headers: {'content-type': 'text/event-stream'}});
    fetched.resolve(); return response;
  }});
  t.after(() => {transport.dispose(); telemetry.dispose(); try {body?.close();} catch {}});
  await transport.refresh();
  return {telemetry, transport, accountId, provider, fetched: fetched.promise, rows, calls,
    tick(value) {clock = value;}, wall(value) {wall = value;},
    send(...events) {body.enqueue(new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')));},
    close() {body.close();}};
}

async function sdkTiming(t, {kind = 'text', counts = rawCounts(), emitDelta = true, omitUsage = false, defaultClock = false} = {}) {
  const f = await sdkFixture(t, {defaultClock}), request = {provider: f.provider, model: 'gpt-5.5', reasoningEffort: 'high',
    messages: [{role: 'user', content: [{type: 'text', text: 'synthetic timing request'}]}], tools: []};
  const item = kind === 'reasoning'
    ? {id: 'rs_telemetry', type: 'reasoning', summary: [{type: 'summary_text', text: 'synthetic thought'}], encrypted_content: 'synthetic-encrypted'}
    : kind === 'tool'
    ? {id: 'fc_telemetry', type: 'function_call', call_id: 'call_telemetry', name: 'weather', arguments: '{"city":"Oslo"}', status: 'completed'}
    : {id: 'msg_telemetry', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'synthetic answer', annotations: []}]};
  const iterator = f.transport.stream(f.accountId, request)[Symbol.asyncIterator](), output = [];
  const initial = iterator.next(); await f.fetched;
  assert.equal(f.telemetry.hasRunningConversation(f.provider), true);
  f.tick(20); f.wall(86400000);
  f.send({type: 'response.created', response: {id: 'resp_telemetry'}},
    {type: 'response.output_item.added', output_index: 0,
      item: {...item, ...(kind === 'text' ? {content: []} : kind === 'tool' ? {arguments: ''} : {summary: []})}});
  output.push((await initial).value);
  assert.equal(output[0].type, 'block-start');
  assert.equal(f.telemetry.snapshot().entries[0].ttftMs, null);
  if (emitDelta) {
    f.tick(100); f.wall(-86400000);
    f.send({type: kind === 'reasoning' ? 'response.reasoning_summary_text.delta' : kind === 'tool'
      ? 'response.function_call_arguments.delta' : 'response.output_text.delta', output_index: 0, content_index: 0,
      delta: kind === 'reasoning' ? 'synthetic thought' : kind === 'tool' ? item.arguments : 'synthetic answer'});
    output.push((await iterator.next()).value);
    assert.equal(output[1].type, kind === 'reasoning' ? 'reasoning-delta' : kind === 'tool' ? 'tool-call-delta' : 'text-delta');
  }
  f.tick(1100); f.wall(999999999999);
  f.send({type: 'response.output_item.done', output_index: 0, item},
    {type: 'response.completed', response: {id: 'resp_telemetry', status: 'completed', model: request.model,
      output: [item], service_tier: 'default', ...(omitUsage ? {} : {usage: counts})}});
  f.close(); output.push(...await collect(iterator));
  return {...f, output};
}

test('genuine SDK SSE uses the default monotonic clock with its required Performance receiver', {timeout: 5000}, async t => {
  const before = performance.now(), f = await sdkTiming(t, {defaultClock: true}), after = performance.now();
  const row = f.telemetry.snapshot().entries[0];
  // Deliberately do not inject now: detached performance.now throws ERR_INVALID_THIS
  // on supported Node 22/24, silently making all three production metrics unknown.
  assert.equal(Number.isFinite(row.ttftMs), true);
  assert.equal(Number.isFinite(row.durationMs), true);
  assert.equal(Number.isFinite(row.tps), true);
  assert.ok(row.ttftMs >= 0); assert.ok(row.durationMs > row.ttftMs); assert.ok(row.durationMs <= after - before);
  assert.equal(row.tps, row.outputTokens / ((row.durationMs - row.ttftMs) / 1000));
  assert.equal(row.outputTokens, 20); assert.equal(row.usageEvidence, 'provider');
  assert.equal(row.serviceTierRequested, 'priority'); assert.equal(row.serviceTierReported, 'default');
  assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0], row);
  assert.equal(f.telemetry.snapshot().summary.samples.ttft, 1); assert.equal(f.telemetry.snapshot().summary.samples.tps, 1);
  t.diagnostic(JSON.stringify({node: process.version, ttftMs: row.ttftMs, durationMs: row.durationMs, tps: row.tps,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens, usageEvidence: row.usageEvidence}));
});

for (const kind of ['text', 'reasoning', 'tool']) test('genuine bundled SDK SSE ' + kind + ' produces numeric TTFT/TPS with raw usage', {timeout: 5000}, async t => {
  const f = await sdkTiming(t, {kind, counts: rawCounts({output_tokens_details: {reasoning_tokens: 10}})});
  const row = f.telemetry.snapshot().entries[0], terminal = f.output.at(-1);
  assert.equal(terminal.reason.kind, kind === 'tool' ? 'tool-calls' : 'stop');
  assert.ok(terminal.replayState);
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].id, row.id);
  assert.equal(f.telemetry.hasRunningConversation(f.provider), false);
  assert.equal(f.calls[0].service_tier, 'priority'); assert.equal(f.calls[0].reasoning.effort, 'high');
  assert.equal(row.serviceTierRequested, 'priority'); assert.equal(row.serviceTierReported, 'default');
  assert.equal(row.ttftMs, 100); assert.equal(row.durationMs, 1100); assert.equal(row.tps, 20);
  assert.equal(row.usageEvidence, 'provider'); assert.equal(row.inputTokens, 100); assert.equal(row.outputTokens, 20);
  assert.equal(row.cacheReadTokens, 40); assert.equal(row.cacheWriteTokens, 0); assert.equal(row.cacheHitRate, 0.4);
  const normalized = f.output.find(chunk => chunk.type === 'usage').usage;
  assert.equal(normalized.inputTokens, 60); assert.equal(normalized.outputTokens, 20);
  assert.equal(f.telemetry.snapshot().summary.samples.ttft, 1); assert.equal(f.telemetry.snapshot().summary.samples.tps, 1);
  assert.equal(JSON.stringify(row).includes('synthetic answer'), false);
  assert.equal(JSON.stringify(row).includes('synthetic-encrypted'), false);
});

for (const [label, counts, outputTokens, rate] of [
  ['absent', undefined, null, null], ['null', null, null, null], ['partial', {input_tokens: 100}, null, null],
  ['malformed', {input_tokens: 100, output_tokens: false}, null, null],
  ['explicit zero', rawCounts({output_tokens: 0, total_tokens: 100}), 0, 0],
]) test('genuine SDK SSE ' + label + ' raw usage preserves unknown versus zero TPS', {timeout: 5000}, async t => {
  const f = await sdkTiming(t, {counts, omitUsage: label === 'absent'}), row = f.telemetry.snapshot().entries[0];
  assert.equal(row.ttftMs, 100); assert.equal(row.durationMs, 1100);
  assert.equal(row.outputTokens, outputTokens); assert.equal(row.tps, rate);
  assert.equal(f.telemetry.snapshot().summary.samples.tps, rate === null ? 0 : 1);
});

test('genuine SDK completed blocks and raw usage never backdate a missing first delta', {timeout: 5000}, async t => {
  const f = await sdkTiming(t, {emitDelta: false}), row = f.telemetry.snapshot().entries[0];
  assert.equal(row.outputTokens, 20); assert.equal(row.ttftMs, null); assert.equal(row.tps, null);
  assert.equal(f.telemetry.snapshot().summary.samples.ttft, 0);
});

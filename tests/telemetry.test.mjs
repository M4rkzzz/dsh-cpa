import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createTelemetry} from '../lib/telemetry-v024.mjs';

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
    inputTokens: 0, outputTokens: 0, avgTtftMs: null, avgDurationMs: null, avgTps: null, avgCacheHitRate: null,
    samples: {ttft: 0, tps: 0, cacheHitRate: 0}, estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, upperBoundRequests: 0});
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
  assert.deepEqual(e, {id: 'cpa-1', source: 'conversation', model: 'synthetic-model',
    startedAt: '1970-01-01T00:00:00.000Z', endedAt: '1970-01-01T00:00:01.100Z',
    status: 'success', httpStatus: null, errorCode: null, inputTokens: 100, outputTokens: 50,
    cacheHitRate: 0.6, cacheReadTokens: 60, cacheWriteTokens: 20,
    estimatedCostUsd: null, costBasis: 'unknown', ttftMs: 100, durationMs: 1100, tps: 50});
  assert.equal(s.summary.inputTokens, 100); assert.equal(s.summary.outputTokens, 50);
  assert.equal(s.summary.avgTtftMs, 100); assert.equal(s.summary.avgDurationMs, 1100); assert.equal(s.summary.avgTps, 50);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const first of [text('x'), {type: 'reasoning-delta', index: 0, text: 'thinking'},
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

test('usage/finish and empty or malformed deltas do not invent a first token', async t => {
  const f = fixture(t);
  await collect(f.hook(options(), () => chunks(text(''), {type: 'reasoning-delta', text: false},
    {type: 'tool-call-delta', id: 'call-metadata', argumentsDelta: ''},
    {type: 'tool-call-delta', argumentsDelta: {}, name: ''},
    {type: 'tool-call-delta', arguments: 'not-a-delta-field'}, {type: 'thinking_delta', delta: 'not-the-host-protocol'},
    usage({inputTokens: 2, outputTokens: 3, totalTokens: 5}), done())));
  const e = f.telemetry.snapshot().entries[0];
  assert.equal(e.ttftMs, null); assert.equal(e.tps, null);
  assert.deepEqual(f.telemetry.snapshot().summary.samples, {ttft: 0, tps: 0, cacheHitRate: 1});
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

test('Codex cache accounting distinguishes known, derived-zero and unavailable', async t => {
  const cases = [
    [{inputTokens: 20, outputTokens: 10, totalTokens: 110, cacheReadTokens: 80}, 100, 0.8],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, cacheWriteTokens: 20}, 100, 0.6],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30}, 20, 0],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheWriteTokens: 5}, 25, 0],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35}, 25, null],
    [{inputTokens: 20, outputTokens: 10}, null, null],
    [{inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0}, 20, 0],
    [{inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5}, 30, 1 / 6],
    [{outputTokens: 10, totalTokens: 30, cacheReadTokens: 5}, 20, 0.25],
    [{outputTokens: 10, totalTokens: 30}, 20, null],
    [{inputTokens: 0, outputTokens: 10, totalTokens: 10}, 0, null],
    [{inputTokens: 0, outputTokens: 0, totalTokens: 0}, 0, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: null}, 20, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheWriteTokens: false}, 20, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 20}, null, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: 5}, null, null],
    [{inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0}, null, null],
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
  assert.equal(s.summary.avgTtftMs, 20); assert.equal(s.summary.avgTps, 0); assert.equal(s.summary.avgCacheHitRate, 0);
  assert.equal(s.summary.avgDurationMs, 510);
  assert.deepEqual(s.summary.samples, {ttft: 1, tps: 1, cacheHitRate: 1});
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
  assert.equal(s.inputTokens, 0); assert.equal(s.outputTokens, 0);
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
  assert.equal(s.summary.avgCacheHitRate, 0.25); assert.equal(s.summary.samples.cacheHitRate, 2);
  s.entries[0].status = 'fake'; s.entries.push({}); s.summary.total = -1; s.summary.samples.cacheHitRate = -1;
  const actual = f.telemetry.snapshot();
  assert.equal(actual.entries.length, 2); assert.equal(actual.entries[0].status, 'success');
  assert.equal(actual.summary.total, 2); assert.equal(actual.summary.samples.cacheHitRate, 2);
});

for (const clone of [false, true]) {
  test('probe is lazy and deduplicated through hook by ' + (clone ? 'signal' : 'options identity'), async t => {
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

test('cache counters remain nullable unless cumulative accounting proves exact zero', async t => {
  const zero = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 30});
  assert.equal(zero.cacheReadTokens, 0); assert.equal(zero.cacheWriteTokens, 0);
  const read = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheReadTokens: 5});
  assert.equal(read.cacheReadTokens, 5); assert.equal(read.cacheWriteTokens, 0);
  const write = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 35, cacheWriteTokens: 5});
  assert.equal(write.cacheReadTokens, 0); assert.equal(write.cacheWriteTokens, 5);
  const unknown = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 35});
  assert.equal(unknown.cacheReadTokens, null); assert.equal(unknown.cacheWriteTokens, null);
  const bad = await sample(t, {inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadTokens: null});
  assert.equal(bad.cacheReadTokens, null); assert.equal(bad.cacheWriteTokens, null);
});

test('verified Standard price estimates aggregate with coverage and upper-bound counts', async t => {
  const f = fixture(t, {limit: 2});
  const cases = [
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40}, 0.00046, 'estimate'],
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20, totalTokens: 120}, 0.00055, 'upper-bound'],
    ['synthetic-model', {inputTokens: 60, outputTokens: 20, totalTokens: 80}, null, 'unknown'],
    ['gpt-5.4', {inputTokens: 60, outputTokens: 20}, null, 'unknown'],
    ['gpt-6.1-sol', {inputTokens: 100, outputTokens: 20, totalTokens: 120}, 0.0004, 'estimate'],
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
  assert.equal(s.summary.pricedRequests, 4); assert.equal(s.summary.unpricedRequests, 3);
  assert.equal(s.summary.upperBoundRequests, 2);
  assert.ok(Math.abs(s.summary.estimatedCostUsd - 0.001764) < 1e-12);
  assert.equal(s.pricing.currency, 'USD'); assert.equal(s.pricing.basis, 'OpenAI Standard API');
  assert.equal(s.pricing.checkedAt, '2026-11-08');
  assert.ok(s.pricing.sources.includes('https://developers.openai.com/api/docs/pricing.md'));
  s.pricing.sources.length = 0;
  assert.ok(f.telemetry.snapshot().pricing.sources.length > 0);
  f.telemetry.clear();
  assert.equal(f.telemetry.snapshot().summary.estimatedCostUsd, 0);
  assert.equal(f.telemetry.snapshot().summary.pricedRequests, 0);
});

test('known zero cost is distinct from missing usage and cumulative cost is charged once', async t => {
  const f = fixture(t);
  await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(done())));
  assert.equal(f.telemetry.snapshot().entries[0].estimatedCostUsd, null);
  await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(usage({inputTokens: 0, outputTokens: 0, totalTokens: 0}), done())));
  assert.equal(f.telemetry.snapshot().entries[0].estimatedCostUsd, 0);
  await collect(f.hook(options({model: 'gpt-5.4'}), () => chunks(
    usage({inputTokens: 10, outputTokens: 1, totalTokens: 11}),
    usage({inputTokens: 10, outputTokens: 2, totalTokens: 12}), done(), done())));
  const s = f.telemetry.snapshot();
  assert.equal(s.summary.pricedRequests, 2); assert.equal(s.summary.unpricedRequests, 1);
  assert.equal(s.summary.estimatedCostUsd, (10 * 2.5 + 2 * 15) / 1_000_000);
});

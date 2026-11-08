import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {apply as applySessionStats} from '@deepseek-ai/dsh-session-stats';
import {Session} from '@deepseek-ai/dsh-session';
import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm';
import {createSessionTiming} from '../lib/session-timing-v0211.mjs';
import {createTelemetry} from '../lib/telemetry-v026.mjs';
import {createEvidence, attachEvidence} from '../lib/evidence-v026.mjs';

// Capture the REAL native fold through the public plugin seam. No copied fold,
// private Host import, actual model request, credential, or real session log.
let native;
await applySessionStats({sessionProjections: {register(definition) {native = definition;}}});
assert.equal(native.key, 'sessionStats');
const token = (time = 1200, text = 'synthetic') => ({type: 'chunk', time, chunk: {type: 'text-delta', index: 0, text}});
const finish = (kind = 'stop') => ({type: 'finish', reason: {kind}});
const usage = (outputTokens = 120) => ({type: 'usage', usage: {inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens}});
const options = (extra = {}) => ({provider: 'openai-codex', model: 'gpt-5.4', sessionId: 'synthetic-session', ...extra});
const chunks = (...frames) => (async function* () {yield* frames;})();
const collect = async stream => {const out = []; for await (const frame of stream) out.push(frame); return out;};
const event = (type, time, data = {}) => ({type, time, data: {turn: 0, step: 0, ...data}});
const start = (time = 1000, data) => event('step/start', time, data);
const message = (time = 3200, data = {}) => event('assistant/message', time, {stream: [token()], usage: {outputTokens: 120}, ...data});

function context() {
  const hooks = new Map();
  return {hooks, on(name, listener) {
    if (!hooks.has(name)) hooks.set(name, new Set());
    hooks.get(name).add(listener);
    return () => hooks.get(name).delete(listener);
  }, emit(name, ...args) {for (const listener of hooks.get(name) ?? []) listener(...args);}};
}
function fixture(t, config = {}) {
  const ctx = context(), rows = [], states = new Map();
  let clock = 0, wall = 0;
  const telemetry = createTelemetry(ctx, {now: () => clock, dateNow: () => wall,
    onRecord(row) {rows.push(row); return config.sink?.(row);}, ...config});
  t.after(() => telemetry.dispose());
  const session = {id: 'synthetic-session'};
  return {ctx, telemetry, rows, session,
    tick(value) {clock = value; wall = value;},
    hook(request = options(), factory = () => chunks(usage(), finish())) {
      return [...ctx.hooks.get('llm/stream')][0](request, factory);
    },
    emit(value, owner = session, fold = true) {
      // The exact same event object feeds native and CPA in live order.
      if (fold) states.set(owner.id, native.apply(states.get(owner.id) ?? native.init(), value));
      ctx.emit('session/event', owner, value);
    },
    stats(id = session.id) {return native.wire.view(states.get(id) ?? native.init());},
  };
}
function assertTiming(row, {ttft = 200, duration = 2200, decode = 2000, output = 120, tps = 60, source = 'dsh-session'} = {}) {
  assert.equal(row.timingVersion, 2); assert.equal(row.timingSource, source);
  assert.equal(row.ttftMs, ttft); assert.equal(row.durationMs, duration);
  assert.equal(row.decodeMs, decode); assert.equal(row.timingOutputTokens, output); assert.equal(row.tps, tps);
}
function assertUnknown(row) {assertTiming(row, {ttft: null, duration: null, decode: null, output: null, tps: null, source: 'unavailable'});}
function assertNative(row, state) {
  assert.equal(row.durationMs, state.llmMs);
  assert.equal(row.ttftMs, state.ttftSteps ? state.ttftMs / state.ttftSteps : null);
  if (row.decodeMs !== null && row.timingOutputTokens !== null) {
    assert.equal(row.decodeMs, state.decodeMs); assert.equal(row.timingOutputTokens, state.decodeTokens);
    assert.equal(row.tps, state.decodeMs > 0 ? state.decodeTokens / (state.decodeMs / 1000) : null);
  }
}

test('native durable message, not local preparation/backpressure/finish or step end, settles time', async t => {
  const gate = Promise.withResolvers(), f = fixture(t, {sink: () => gate.promise});
  f.emit(start()); f.tick(9000);
  const frames = [{type: 'text-delta', index: 0, text: 'private stream'}, usage(), finish('tool-calls')];
  let calls = 0, pulls = 0, returns = 0;
  const stream = f.hook(options(), () => {calls++; return {[Symbol.asyncIterator]() {return this;},
    async next() {pulls++; return pulls <= frames.length ? {value: frames[pulls - 1], done: false} : {done: true};},
    async return() {returns++; return {done: true};}};});
  assert.equal(calls, 1); assert.equal(pulls, 0); assert.equal(f.telemetry.snapshot().summary.total, 0);
  f.tick(10000); assert.equal((await stream.next()).value, frames[0]);
  f.tick(500000); await Promise.resolve(); assert.equal(pulls, 1);
  assert.equal(f.telemetry.snapshot().entries[0].ttftMs, null);
  assert.deepEqual(await collect(stream), frames.slice(1));
  assert.equal(returns, 0); assert.equal(f.rows.length, 0);
  assert.equal(f.telemetry.hasRunningConversation('openai-codex'), false);
  f.emit(message(3200, {stream: [token(), {type: 'chunk', time: 2100, chunk: finish('tool-calls')}]}));
  assert.equal(f.rows.length, 1); assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
  assert.equal(f.telemetry.snapshot().recording.pending, 1);
  f.emit(event('tool/call', 3300, {callId: 'tool'}));
  f.emit(event('tool/result', 8000, {message: {source: {callId: 'tool'}}}));
  f.emit(event('step/end', 9000));
  assertTiming(f.rows[0]); assert.equal(f.rows.length, 1);
  gate.resolve(); await new Promise(setImmediate);
  assert.equal(f.telemetry.snapshot().recording.pending, 0);
});

for (const [label, stream] of [
  ['reasoning before visible text', [{type: 'chunk', time: 1200, chunk: {type: 'reasoning-delta', index: 0, text: 'thought'}}, token(1500)]],
  ['whitespace text is a token', [token(1200, ' '), token(1500)]],
  ['empty tool name exists', [{type: 'chunk', time: 1200, chunk: {type: 'tool-call-delta', index: 0, id: 'call', argumentsDelta: '', name: ''}}, token(1500)]],
  ['tool name alone is enough', [{type: 'chunk', time: 1200, chunk: {type: 'tool-call-delta', index: 0, name: ''}}]],
  ['compact text time0 + dt', [{type: 'text-chunks', index: 0, time0: 1100, dt: [40, 60, 2000], texts: ['', '', 'x', 'later']}]],
  ['compact reasoning time0 + dt', [{type: 'reasoning-chunks', index: 0, time0: 1100, dt: [100], texts: ['', 'thought']}, token(1600)]],
  ['compact empty tool name', [{type: 'tool-call-chunks', index: 0, time0: 1200, dt: [100], args: ['', '{}'], name: ''}]],
  ['compact tool arguments', [{type: 'tool-call-chunks', index: 0, time0: 1100, dt: [100], args: ['', '{']}]],
]) test('public native projection parity: ' + label, async t => {
  const f = fixture(t); f.emit(start());
  await collect(f.hook()); assert.equal(f.rows.length, 0);
  f.emit(message(3200, {stream}));
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
});

test('compact scanning stops at F and does not expand or read later members', async t => {
  const f = fixture(t), texts = ['', 'first']; let reads = 0;
  Object.defineProperty(texts, '2', {get() {reads++; throw Error('must stop before later content');}});
  const stream = [{type: 'text-chunks', index: 0, time0: 1100, dt: [100, 400], texts}];
  Object.defineProperty(stream, '1', {get() {reads++; throw Error('must stop before later record');}});
  f.emit(start()); await collect(f.hook()); f.emit(message(3200, {stream}));
  assert.equal(reads, 0); assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
});

test('retry keeps failed attempt F and backoff, but only final message output supplies TPS', async t => {
  const f = fixture(t); f.emit(start());
  await collect(f.hook(options(), () => chunks(usage(80), finish('error'))));
  assert.equal(f.rows.length, 0);
  f.emit(event('assistant/attempt', 2000, {stream: [token()], usage: {outputTokens: 80}}));
  assert.equal(f.rows.length, 1); assertUnknown(f.rows[0]); assert.equal(f.rows[0].status, 'error');
  assert.equal(f.stats().llmMs, 0); assert.equal(f.stats().ttftSteps, 0);
  f.emit(event('llm/retry', 2600));
  await collect(f.hook()); assert.equal(f.rows.length, 1);
  f.emit(message(4200, {stream: [token(3000)], usage: {outputTokens: 120}}));
  assertTiming(f.rows[1], {duration: 3200, decode: 3000, tps: 40}); assertNative(f.rows[1], f.stats());
  assert.equal(f.telemetry.snapshot().summary.avgTps, 40);
  assert.equal(f.telemetry.snapshot().summary.samples.tps, 1);
  assert.equal(f.telemetry.snapshot().summary.outputTokens, 200);
});

for (const mode of ['aborted finish', 'abort signal']) test('interrupted durable message is timed after ' + mode, async t => {
  const f = fixture(t), controller = new AbortController(); f.emit(start());
  const stream = f.hook(options({signal: controller.signal}), () => chunks({type: 'text-delta', text: 'partial'}, usage(), finish('aborted')));
  if (mode === 'abort signal') {await stream.next(); controller.abort();}
  await collect(stream); assert.equal(f.rows.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  f.emit(message(3200, {interrupted: true}));
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].status, 'cancelled');
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
});

test('attempt-only interrupted stream never supplies native time', async t => {
  const f = fixture(t); f.emit(start());
  await collect(f.hook(options(), () => chunks(usage(), finish('aborted'))));
  f.emit(event('assistant/attempt', 3200, {stream: [token()], usage: {outputTokens: 120}, interrupted: true}));
  f.emit(event('step/end', 9000));
  assert.equal(f.rows.length, 1); assertUnknown(f.rows[0]);
  assert.equal(f.stats().llmMs, 0); assert.equal(f.stats().ttftSteps, 0); assert.equal(f.stats().decodeTokens, 0);
});

test('summary weights native decode pairs, including positive tokens at zero decode', async t => {
  const f = fixture(t);
  for (const [step, s, first, c, output] of [[0, 1000, 1200, 2200, 100], [1, 3000, 3200, 13200, 100], [2, 14000, 14200, 14200, 50]]) {
    f.emit(start(s, {step})); await collect(f.hook(options(), () => chunks(usage(output), finish())));
    f.emit(message(c, {step, stream: [token(first)], usage: {outputTokens: output}}));
    if (step === 1) {assert.equal(f.telemetry.snapshot().summary.avgTps, 200 / 11); assert.notEqual(f.telemetry.snapshot().summary.avgTps, 55);}
  }
  const s = f.telemetry.snapshot().summary, n = f.stats();
  assert.deepEqual(f.rows.map(row => row.tps), [100, 10, null]);
  assert.equal(s.avgTps, 250 / 11); assert.equal(s.samples.tps, 3);
  assert.equal(s.avgTps, n.decodeTokens / (n.decodeMs / 1000));
  assert.equal(s.avgTtftMs, n.ttftMs / n.ttftSteps); assert.ok(Math.abs(s.avgDurationMs - n.llmMs / 3) < 1e-9);
});

test('normalized native numerator coexists with independent raw usage, reasoning, cost and tier proof', async t => {
  const f = fixture(t), audit = createEvidence({accountId: 'account-a', accountEmail: 'a@example.test', serviceTierRequested: 'priority'});
  audit.onHttpStatus(200); audit.onRequestDispatch({tier: 'priority', state: 'value'});
  audit.onRawEvent({type: 'response.completed', response: {service_tier: 'default', usage: {
    input_tokens: 100, output_tokens: 80, total_tokens: 180, input_tokens_details: {cached_tokens: 40, cache_write_tokens: 0},
    output_tokens_details: {reasoning_tokens: 40}}, output: ['private content']}});
  f.emit(start()); await collect(f.hook(options(), () => chunks(attachEvidence(usage(120), audit), attachEvidence(finish(), audit))));
  f.emit(message()); const row = f.rows[0]; assertTiming(row); assertNative(row, f.stats());
  assert.equal(row.outputTokens, 80); assert.equal(row.inputTokens, 100); assert.equal(row.cacheReadTokens, 40);
  assert.equal(row.estimatedCostUsd, 0.00136); assert.equal(row.usageEvidence, 'provider');
  assert.equal(row.serviceTierRequested, 'priority'); assert.equal(row.serviceTierSent, 'priority'); assert.equal(row.serviceTierReported, 'default');
  assert.equal(row.accountId, 'account-a'); assert.equal(row.accountEmail, 'a@example.test');
  const serialized = JSON.stringify(f.telemetry.snapshot());
  for (const forbidden of ['private content', 'synthetic-session', 'reasoning_tokens', 'stream', 'signal', 'credential']) assert.equal(serialized.includes(forbidden), false, forbidden);
});

for (const [label, normalized] of [['missing', undefined], ['null', null], ['negative', -1], ['infinite', Infinity], ['nan', NaN], ['string', '120'], ['boolean', false]]) {
  test('invalid or missing normalized ' + label + ' output cannot borrow raw positive tokens for native TPS', async t => {
    const f = fixture(t); f.emit(start()); await collect(f.hook());
    f.emit(message(3200, {usage: normalized === undefined ? undefined : {outputTokens: normalized}}));
    assertTiming(f.rows[0], {output: null, tps: null}); assertNative(f.rows[0], f.stats());
    assert.equal(f.rows[0].outputTokens, 120); assert.equal(f.telemetry.snapshot().summary.samples.tps, 0);
  });
}

test('native positive normalized output remains usable when raw usage is missing', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook(options(), () => chunks(finish())));
  f.emit(message()); assertTiming(f.rows[0]); assert.equal(f.rows[0].outputTokens, null); assertNative(f.rows[0], f.stats());
});

test('native normalized zero without explicit raw zero evidence is unknown, not Host defaultUsage zero', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook(options(), () => chunks(usage(0), finish())));
  f.emit(message(3200, {usage: {outputTokens: 0}}));
  assertTiming(f.rows[0], {output: null, tps: null}); assert.equal(f.rows[0].outputTokens, null);
  assert.equal(f.telemetry.snapshot().summary.samples.tps, 0);
});

test('native explicit raw zero enters TPS coverage without changing billing evidence', async t => {
  const f = fixture(t), audit = createEvidence();
  audit.onRawEvent({type: 'response.completed', response: {usage: {input_tokens: 10, output_tokens: 0, total_tokens: 10}}});
  f.emit(start()); await collect(f.hook(options(), () => chunks(attachEvidence(finish(), audit))));
  f.emit(message(3200, {usage: {outputTokens: 0}}));
  assertTiming(f.rows[0], {output: 0, tps: 0}); assertNative(f.rows[0], f.stats());
  assert.equal(f.rows[0].outputTokens, 0); assert.equal(f.telemetry.snapshot().summary.samples.tps, 1);
});

test('message without F has duration but no first token or decode pair', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook());
  f.emit(message(3200, {stream: [{type: 'chunk', time: 3100, chunk: finish()}]}));
  assertTiming(f.rows[0], {ttft: null, decode: null, tps: null}); assertNative(f.rows[0], f.stats());
  assert.equal(f.telemetry.snapshot().summary.samples.tps, 0);
});

test('native wall-clock rollback clamps TTFT, duration and decode independently', async t => {
  const f = fixture(t); f.emit(start(2000)); await collect(f.hook()); f.emit(message(1000));
  assertTiming(f.rows[0], {ttft: 0, duration: 0, decode: 0, tps: null}); assertNative(f.rows[0], f.stats());
  assert.equal(f.telemetry.snapshot().summary.samples.tps, 1); assert.equal(f.telemetry.snapshot().summary.avgTps, null);
});

test('F=0 is not confused with absent time', async t => {
  const f = fixture(t); f.emit(start(0)); await collect(f.hook()); f.emit(message(2000, {stream: [token(0)]}));
  assertTiming(f.rows[0], {ttft: 0, duration: 2000}); assertNative(f.rows[0], f.stats());
});

test('session and step mismatches cannot steal the pending row', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook());
  f.emit(message(), {id: 'another-session'}); f.emit(message(9000, {step: 1}));
  assert.equal(f.rows.length, 0); f.emit(message());
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
});

test('mid-install session or malformed session identity never falls back to observer timing', async t => {
  const f = fixture(t);
  for (const sid of ['synthetic-session', '', null, 5, 'x'.repeat(201)]) {
    f.tick(0); await collect(f.hook(options({sessionId: sid}), () => (async function* () {
      f.tick(100); yield {type: 'text-delta', text: 'first'}; f.tick(1100); yield usage(); yield finish();
    })()));
    assertUnknown(f.rows.at(-1));
  }
  f.emit(message()); assert.equal(f.rows.length, 5);
});

test('concurrent eligible streams with the same sid fail closed even with identical model and signal', async t => {
  const f = fixture(t), signal = new AbortController().signal; f.emit(start());
  const request = options({signal}), first = f.hook(request), second = f.hook({...request});
  await collect(first); await collect(second);
  assert.equal(f.rows.length, 2); f.rows.forEach(assertUnknown);
  f.emit(message()); assert.equal(f.rows.length, 2);
  f.emit(start(4000, {step: 1})); await collect(f.hook()); f.emit(message(6200, {step: 1, stream: [token(4200)]}));
  assertTiming(f.rows[2]);
});

test('different sid streams remain independent despite sharing model and signal', async t => {
  const f = fixture(t), other = {id: 'other'}, signal = new AbortController().signal;
  f.emit(start()); f.emit(start(2000), other);
  const first = f.hook(options({signal})), second = f.hook(options({sessionId: other.id, signal}));
  await collect(second); await collect(first); assert.equal(f.rows.length, 0);
  f.emit(message(4200, {stream: [token(2200)]}), other); f.emit(message());
  f.rows.forEach(row => assertTiming(row));
  assertNative(f.rows[0], f.stats(other.id)); assertNative(f.rows[1], f.stats());
});

for (const purpose of ['title', '', null]) test('declared auxiliary purpose ' + JSON.stringify(purpose) + ' cannot claim a live ordinary step', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook(options({purpose}))); assertUnknown(f.rows[0]);
  await collect(f.hook()); f.emit(message()); assertTiming(f.rows[1]);
});

test('foreign public SDK copy marking does not exclude a valid session-bound request', async t => {
  const foreign = await import(import.meta.resolve('@deepseek-ai/dsh-llm') + '?cpa-independent-sdk-copy');
  const request = foreign.markAgentLoopRequest(options());
  assert.equal(foreign.isAgentLoopRequest(request), true); assert.equal(isAgentLoopRequest(request), false);
  const f = fixture(t); f.emit(start()); await collect(f.hook(request)); f.emit(message());
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats());
});

test('real public Session.id prototype getter works, with no event-log/seed reads', async t => {
  const f = fixture(t), session = Session.create('real-getter-synthetic');
  assert.equal(Object.hasOwn(session, 'id'), false); assert.equal(typeof Object.getOwnPropertyDescriptor(Session.prototype, 'id').get, 'function');
  Object.defineProperty(session, 'log', {get() {throw Error('do not read actual session content');}});
  f.emit(start(), session); await collect(f.hook(options({sessionId: session.id}))); f.emit(message(), session);
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats(session.id));
});

test('session proxies and option accessors cannot run diagnostic identity traps', t => {
  const ctx = context(), tracker = createSessionTiming(ctx); t.after(() => tracker.dispose());
  let reads = 0;
  const hostile = new Proxy({}, {get() {reads++; throw Error('private');}, getOwnPropertyDescriptor() {reads++; throw Error('private');}});
  ctx.emit('session/event', hostile, start()); ctx.emit('session/disposed', hostile);
  assert.equal(tracker.snapshot().sessions, 0); assert.equal(reads, 0);
  assert.equal(tracker.claim(hostile).result.timingSource, 'unavailable'); assert.equal(reads, 0);
  const request = {get sessionId() {reads++; return 'synthetic-session';}};
  assert.equal(tracker.claim(request).result.timingSource, 'unavailable'); assert.equal(reads, 0);
  ctx.emit('session/event', {header: {id: 'synthetic-session'}}, start());
  const purpose = {sessionId: 'synthetic-session', get purpose() {reads++; return undefined;}};
  assert.equal(tracker.claim(purpose).result.timingSource, 'unavailable'); assert.equal(reads, 0);
});

test('clear invalidates terminal pending, active and dispatched-but-unconsumed native rows', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook()); assert.equal(f.rows.length, 0);
  f.telemetry.clear(); f.emit(message()); assert.equal(f.rows.length, 0); assert.equal(f.telemetry.snapshot().summary.total, 0);
  f.emit(start(4000, {step: 1})); const active = f.hook(); await active.next();
  f.telemetry.clear(); await collect(active); f.emit(message(6200, {step: 1, stream: [token(4200)]}));
  assert.equal(f.rows.length, 0); assert.equal(f.telemetry.snapshot().summary.total, 0);
  f.emit(start(7000, {step: 2})); const lazy = f.hook(); f.telemetry.clear(); await collect(lazy);
  assert.equal(f.telemetry.snapshot().summary.total, 0);
  f.emit(start(10000, {step: 3})); await collect(f.hook()); f.emit(message(12200, {step: 3, stream: [token(10200)]}));
  assert.equal(f.rows.length, 1); assertTiming(f.rows[0]); assert.equal(f.telemetry.snapshot().summary.avgTps, 60);
});

for (const ending of ['step/end', 'session/disposed', 'next step/start']) test(ending + ' safely settles a missing durable message once', async t => {
  const f = fixture(t); f.emit(start()); await collect(f.hook());
  assert.equal(f.rows.length, 0);
  if (ending === 'session/disposed') f.ctx.emit(ending, f.session);
  else f.emit(ending === 'next step/start' ? start(5000, {step: 1}) : event(ending, 9000));
  assert.equal(f.rows.length, 1); assertUnknown(f.rows[0]); assert.equal(f.rows[0].outputTokens, 120);
  f.emit(message()); assert.equal(f.rows.length, 1);
});

test('dispose safely sinks already-terminal pending rows but neither aborts nor closes active transport', async t => {
  const f = fixture(t), other = {id: 'other'}, controller = new AbortController();
  f.emit(start()); await collect(f.hook()); f.emit(start(), other);
  let pulls = 0, returns = 0;
  const active = f.hook(options({sessionId: other.id, signal: controller.signal}), () => ({[Symbol.asyncIterator]() {return this;},
    async next() {pulls++; return pulls < 3 ? {value: {type: 'text-delta', text: 'active'}, done: false} : {done: true};},
    async return() {returns++; return {done: true};}}));
  await active.next(); f.telemetry.dispose(); f.telemetry.dispose();
  assert.equal(f.rows.length, 1); assertUnknown(f.rows[0]);
  assert.equal(controller.signal.aborted, false); assert.equal(returns, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal((await active.next()).value.text, 'active'); await active.return(); assert.equal(returns, 1);
  assert.equal(f.rows.length, 1); assert.deepEqual(f.telemetry.snapshot().entries, []);
  assert.equal(f.ctx.hooks.get('session/event').size, 0); assert.equal(f.ctx.hooks.get('session/disposed').size, 0);
});

test('native pending persistence survives display eviction and terminal sink remains once-only', async t => {
  const f = fixture(t, {limit: 1}), other = {id: 'other'};
  f.emit(start()); await collect(f.hook()); f.emit(start(), other);
  await collect(f.hook(options({sessionId: other.id}))); assert.equal(f.telemetry.snapshot().entries.length, 1);
  f.emit(message()); f.emit(message(), other); f.emit(message());
  assert.equal(f.rows.length, 2); f.rows.forEach(row => assertTiming(row));
  assert.equal(f.telemetry.snapshot().summary.success, 2); assert.equal(f.telemetry.snapshot().summary.samples.tps, 2);
});

test('session cache has a strict 256-bound and evicts missing-message rows to unknown', async t => {
  const f = fixture(t, {limit: 1});
  for (let i = 0; i < 257; i++) {
    const owner = {id: 'session-' + i}; f.emit(start(), owner);
    await collect(f.hook(options({sessionId: owner.id})));
  }
  assert.equal(f.rows.length, 1); assertUnknown(f.rows[0]);
  assert.equal(f.telemetry.snapshot().summary.running, 256);
  f.telemetry.dispose(); assert.equal(f.rows.length, 257); f.rows.forEach(assertUnknown);
  assert.equal(new Set(f.rows.map(row => row.id)).size, 257);
});

test('pending and session bounds retain only safe callbacks/scalars and release on clear/dispose', t => {
  const ctx = context(), tracker = createSessionTiming(ctx, {maxSessions: 4, maxPending: 2}); t.after(() => tracker.dispose());
  const results = [];
  for (let i = 0; i < 3; i++) {
    const id = 'bounded-' + i; ctx.emit('session/event', {id}, start());
    const handle = tracker.claim({sessionId: id}); tracker.settle(handle, result => results.push(result));
    assert.ok(tracker.snapshot().sessions <= 4); assert.ok(tracker.snapshot().pending <= 2);
  }
  assert.equal(results.length, 1); assertUnknown(results[0]);
  tracker.clear(); assert.equal(results.length, 1); assert.equal(tracker.snapshot().pending, 0); assert.equal(tracker.snapshot().sessions, 0);
  ctx.emit('session/event', {id: 'last'}, start()); tracker.settle(tracker.claim({sessionId: 'last'}), result => results.push(result));
  tracker.dispose(); assert.equal(results.length, 2); assertUnknown(results[1]);
  for (const size of [0, -1, Infinity, 0.5, '2', 4097]) assert.throws(() => createSessionTiming({}, {maxPending: size}), /invalid-session-timing-limit/);
});

test('native timing never samples or substitutes the local observer clock', async t => {
  let calls = 0;
  const f = fixture(t, {now() {calls++; throw Error('local observer is not a native clock');}});
  f.emit(start()); await collect(f.hook()); f.emit(message());
  assertTiming(f.rows[0]); assertNative(f.rows[0], f.stats()); assert.equal(calls, 0);
});

test('durable message before stream terminal stores only scalar result until once-only terminal sink', async t => {
  const f = fixture(t); f.emit(start());
  const terminal = finish(), stream = f.hook(options(), () => chunks(usage(), terminal, finish('error')));
  await stream.next(); f.emit(message()); assert.equal(f.rows.length, 0);
  assert.equal((await stream.next()).value, terminal); assert.equal(f.rows.length, 1);
  await collect(stream); assert.equal(f.rows.length, 1); assertTiming(f.rows[0]);
});

test('session event content/accessors are not retained or executed as compact-stream evidence', async t => {
  const f = fixture(t); let reads = 0;
  f.emit(start()); await collect(f.hook());
  const compact = [{type: 'text-chunks', time0: 1200, dt: [], get texts() {reads++; throw Error('private compact getter');}}];
  f.emit(message(3200, {stream: compact}), f.session, false);
  assert.equal(reads, 0); assertTiming(f.rows[0], {ttft: null, decode: null, tps: null});
});

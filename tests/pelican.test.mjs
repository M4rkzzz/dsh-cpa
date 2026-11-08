import test from 'node:test';
import assert from 'node:assert/strict';
import {createPelican} from '../lib/pelican-v024.mjs';
import {createTelemetry} from '../lib/telemetry-v024.mjs';

const MODEL = 'synthetic-codex';
const NEXT_MODEL = 'synthetic-codex-next';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
const CATALOG = [{provider: 'openai-codex', id: MODEL}, {provider: 'openai-codex', id: NEXT_MODEL}];
const flush = () => new Promise(resolve => setImmediate(resolve));
const stop = {type: 'finish', reason: {kind: 'stop'}};
const text = value => ({type: 'text-delta', index: 0, text: value});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function* chunks(values) {yield* values;}
function fakeClock() {
  let time = Date.UTC(2026, 0, 1), id = 0;
  const jobs = new Map();
  return {
    now: () => time,
    iso: (delta = 0) => new Date(time + delta).toISOString(),
    size: () => jobs.size,
    pending: () => [...jobs.values()],
    timers: {
      setTimeout(fn, delay) {const key = ++id; jobs.set(key, {fn, at: time + delay}); return key;},
      clearTimeout(key) {jobs.delete(key);},
    },
    async advance(ms) {
      const target = time + ms;
      while (true) {
        const next = [...jobs].sort((a, b) => a[1].at - b[1].at).find(([, job]) => job.at <= target);
        if (!next) break;
        time = next[1].at;
        jobs.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}
function fixture(t, options = {}) {
  const clock = fakeClock(), calls = [], catalogs = [], observed = [];
  const llm = {
    listModels(provider) {catalogs.push(provider); return options.listModels?.(provider) ?? CATALOG;},
    stream(request) {calls.push(request); return options.stream ? options.stream(request) : chunks([text(SVG), stop]);},
  };
  const telemetry = {observeProbe(request, factory) {
    observed.push(request);
    return {async *[Symbol.asyncIterator]() {yield* factory();}};
  }};
  const pelican = createPelican({llm, telemetry, now: clock.now, timers: clock.timers, ...options.config});
  t.after(() => pelican.dispose());
  return {pelican, llm, telemetry, clock, calls, catalogs, observed};
}

test('pelican is available but disabled by default without timers or requests', t => {
  const {pelican, clock, calls, catalogs} = fixture(t);
  assert.deepEqual(pelican.snapshot(), {
    available: true, enabled: false, intervalMinutes: 60, model: null,
    prompt: '生成一张鹈鹕骑自行车的SVG', running: false, nextRunAt: null, lastResult: null,
  });
  assert.equal(clock.size(), 0);
  assert.equal(calls.length, 0);
  assert.equal(catalogs.length, 0);
});

test('manual run returns running immediately and sends only a fixed text request through telemetry', async t => {
  const gate = deferred();
  const {pelican, calls, observed, catalogs, clock} = fixture(t, {stream: async function* () {
    yield text('\n\n');
    await gate.promise;
    yield text(SVG);
    yield stop;
  }});
  const started = await pelican.run({model: MODEL});
  assert.equal(started.running, true);
  await flush();
  assert.equal(pelican.snapshot().running, true);
  assert.deepEqual(catalogs, ['openai-codex']);
  assert.equal(calls.length, 1);
  assert.equal(observed[0], calls[0]);
  const request = calls[0];
  assert.equal(request.provider, 'openai-codex');
  assert.equal(request.model, MODEL);
  assert.equal(request.maxTokens, 4096);
  assert.deepEqual(request.tools, []);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.equal(typeof request.messages[0].id, 'string');
  assert.deepEqual(request.messages[0].source, {kind: 'user'});
  assert.deepEqual(request.messages[0].content, [{type: 'text', text: '生成一张鹈鹕骑自行车的SVG'}]);
  for (const key of ['sessionId', 'toolHistory', 'attachments', 'fs', 'apiKey', 'attemptId']) assert.equal(key in request, false);
  assert.equal(request.signal.aborted, false);
  gate.resolve();
  await flush();
  const result = pelican.snapshot();
  assert.equal(result.enabled, false);
  assert.equal(result.running, false);
  assert.equal(result.nextRunAt, null);
  assert.deepEqual(result.lastResult, {status: 'success', startedAt: clock.iso(), endedAt: clock.iso(), model: MODEL, svg: SVG, errorCode: null});
  assert.equal(clock.size(), 0);
});

test('overlapping runs are refused while catalog validation is pending', async t => {
  const catalog = deferred();
  const {pelican, calls} = fixture(t, {listModels: () => catalog.promise});
  const first = pelican.run({model: MODEL});
  assert.equal(pelican.snapshot().running, true);
  await assert.rejects(pelican.run({model: MODEL}), /pelican-busy/);
  catalog.resolve(CATALOG);
  await first;
  await flush();
  assert.equal(calls.length, 1);
});

test('manual runs validate exact catalog membership and sanitize catalog failures', async t => {
  for (const value of [null, '', 'unknown-model', {}, 123]) {
    const {pelican, calls} = fixture(t);
    await assert.rejects(pelican.run({model: value}), /pelican-invalid-model/);
    assert.equal(calls.length, 0);
    assert.equal(pelican.snapshot().running, false);
  }
  const {pelican, calls} = fixture(t, {listModels() {throw Error('synthetic-private-upstream-detail');}});
  await assert.rejects(pelican.run({model: MODEL}), /^Error: pelican-models-unavailable$/);
  assert.equal(calls.length, 0);
  assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-models-unavailable');
  assert.equal(JSON.stringify(pelican.snapshot()).includes('private'), false);
});

test('a model from a different provider cannot pass catalog validation', async t => {
  const {pelican, calls} = fixture(t, {listModels: () => [{provider: 'other-provider', id: MODEL}]});
  await assert.rejects(pelican.run({model: MODEL}), /pelican-invalid-model/);
  assert.equal(calls.length, 0);
});

test('enabling waits a full interval, runs once, then schedules from completion', async t => {
  const {pelican, clock, calls} = fixture(t);
  const configured = await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  assert.equal(configured.nextRunAt, clock.iso(60000));
  assert.equal(calls.length, 0);
  assert.equal(clock.size(), 1);
  await clock.advance(59999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(pelican.snapshot().lastResult.status, 'success');
  assert.equal(pelican.snapshot().nextRunAt, clock.iso(60000));
  await clock.advance(60000);
  assert.equal(calls.length, 2);
});

test('stale cancelled timer callbacks cannot run early or erase a newer schedule', async t => {
  const {pelican, clock, calls} = fixture(t);
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  const stale = clock.pending()[0].fn;
  await pelican.configure({enabled: true, model: NEXT_MODEL, intervalMinutes: 2});
  const next = pelican.snapshot();
  stale();
  await flush();
  assert.deepEqual(pelican.snapshot(), next);
  assert.equal(calls.length, 0);
  await pelican.configure({enabled: false});
  await pelican.configure({enabled: true, model: NEXT_MODEL, intervalMinutes: 10080});
  stale();
  await flush();
  assert.equal(pelican.snapshot().nextRunAt, clock.iso(10080 * 60000));
  assert.equal(calls.length, 0);
});

test('a long scheduled generation never overlaps and completion restarts the interval', async t => {
  const gate = deferred();
  const {pelican, clock, calls} = fixture(t, {stream: async function* () {yield text(SVG); await gate.promise; yield stop;}});
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  await clock.advance(60000);
  assert.equal(pelican.snapshot().running, true);
  assert.equal(pelican.snapshot().nextRunAt, null);
  await clock.advance(90000);
  assert.equal(calls.length, 1);
  gate.resolve();
  await flush();
  assert.equal(pelican.snapshot().nextRunAt, clock.iso(60000));
  await clock.advance(59999);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
});

test('invalid enabled configurations preserve the previous plan', async t => {
  const {pelican} = fixture(t);
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 2});
  const before = pelican.snapshot();
  for (const value of [0, -1, 1.5, 10081, '1', NaN, Infinity, null]) {
    await assert.rejects(pelican.configure({enabled: true, model: MODEL, intervalMinutes: value}), /pelican-invalid-interval/);
    assert.deepEqual(pelican.snapshot(), before);
  }
  await assert.rejects(pelican.configure({enabled: true, model: 'not-advertised', intervalMinutes: 1}), /pelican-invalid-model/);
  assert.deepEqual(pelican.snapshot(), before);
  await assert.rejects(pelican.configure({enabled: 'true'}), /pelican-invalid-config/);
});

test('disabling ignores invalid fields, cancels the request, and retains prior model and interval', async t => {
  const gate = deferred();
  const {pelican, clock, calls, catalogs} = fixture(t, {stream: async function* () {yield text(SVG); await gate.promise; yield stop;}});
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 3});
  await pelican.run({model: MODEL});
  await flush();
  const count = catalogs.length;
  const disabled = await pelican.configure({enabled: false, model: {}, intervalMinutes: 'invalid'});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.running, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(disabled.model, MODEL);
  assert.equal(disabled.intervalMinutes, 3);
  assert.equal(disabled.lastResult.status, 'cancelled');
  assert.equal(disabled.lastResult.svg, null);
  assert.equal(disabled.lastResult.errorCode, null);
  assert.equal(catalogs.length, count);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(clock.size(), 0);
  gate.resolve();
  await flush();
  await clock.advance(1000000);
  assert.deepEqual(pelican.snapshot(), disabled);
});

test('disabling prevents a pending enable validation from installing a late schedule', async t => {
  const catalog = deferred();
  const {pelican, clock, calls} = fixture(t, {listModels: () => catalog.promise});
  const enabling = assert.rejects(pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1}), /pelican-cancelled/);
  await flush();
  await pelican.configure({enabled: false, model: null, intervalMinutes: 0});
  await enabling;
  catalog.resolve(CATALOG);
  await flush();
  assert.equal(pelican.snapshot().enabled, false);
  assert.equal(pelican.snapshot().model, null);
  assert.equal(clock.size(), 0);
  assert.equal(calls.length, 0);
});

test('a newer valid configuration supersedes an older pending validation', async t => {
  const firstCatalog = deferred();
  let count = 0;
  const {pelican} = fixture(t, {listModels: () => ++count === 1 ? firstCatalog.promise : CATALOG});
  const older = assert.rejects(pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1}), /pelican-cancelled/);
  await flush();
  await pelican.configure({enabled: true, model: NEXT_MODEL, intervalMinutes: 2});
  await older;
  firstCatalog.resolve(CATALOG);
  await flush();
  assert.equal(pelican.snapshot().model, NEXT_MODEL);
  assert.equal(pelican.snapshot().intervalMinutes, 2);
});

test('configuring an in-flight plan changes only the next run', async t => {
  const gate = deferred();
  const {pelican, clock, calls} = fixture(t, {stream: async function* () {yield text(SVG); await gate.promise; yield stop;}});
  await pelican.run({model: MODEL});
  await flush();
  await pelican.configure({enabled: true, model: NEXT_MODEL, intervalMinutes: 2});
  assert.equal(pelican.snapshot().running, true);
  assert.equal(pelican.snapshot().nextRunAt, null);
  assert.equal(calls[0].model, MODEL);
  gate.resolve();
  await flush();
  assert.equal(pelican.snapshot().lastResult.model, MODEL);
  assert.equal(pelican.snapshot().nextRunAt, clock.iso(120000));
  await clock.advance(120000);
  assert.equal(calls[1].model, NEXT_MODEL);
});

test('cancel does not disable a plan and resets the interval from cancellation', async t => {
  const gate = deferred();
  const {pelican, clock, calls} = fixture(t, {stream: async function* () {yield text(SVG); await gate.promise; yield stop;}});
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  await clock.advance(60000);
  await clock.advance(10000);
  const cancelled = pelican.cancel();
  assert.equal(cancelled.enabled, true);
  assert.equal(cancelled.nextRunAt, clock.iso(60000));
  assert.equal(cancelled.lastResult.status, 'cancelled');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[0].signal.reason.name, 'AbortError');
  assert.deepEqual(pelican.cancel(), cancelled);
  gate.resolve();
  await flush();
  assert.deepEqual(pelican.snapshot(), cancelled);
  await clock.advance(60000);
  assert.equal(calls.length, 2);
});

test('cancelling a pending catalog settles run and never sends a late request', async t => {
  const catalog = deferred();
  const {pelican, calls, clock} = fixture(t, {listModels: () => catalog.promise});
  const running = assert.rejects(pelican.run({model: MODEL}), /pelican-cancelled/);
  await flush();
  pelican.cancel();
  await running;
  const cancelled = pelican.snapshot();
  assert.equal(clock.size(), 0);
  catalog.resolve(CATALOG);
  await flush();
  assert.equal(calls.length, 0);
  assert.deepEqual(pelican.snapshot(), cancelled);
});

test('the default 120 second deadline settles an abort-ignoring iterator and cleanup', async t => {
  const never = deferred();
  let returned = 0;
  const {pelican, calls, clock} = fixture(t, {stream: () => ({
    [Symbol.asyncIterator]() {return this;},
    next() {return never.promise;},
    return() {returned++; return new Promise(() => {});},
  })});
  await pelican.run({model: MODEL});
  await flush();
  await clock.advance(119999);
  assert.equal(pelican.snapshot().running, true);
  await clock.advance(1);
  assert.equal(pelican.snapshot().running, false);
  assert.equal(pelican.snapshot().lastResult.status, 'error');
  assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-timeout');
  assert.equal(pelican.snapshot().lastResult.svg, null);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[0].signal.reason.name, 'TimeoutError');
  assert.equal(clock.size(), 0);
  // The source is still blocked; retiring the request never waits for return().
  never.resolve({done: false, value: text(SVG)});
  await flush();
  assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-timeout');
  assert.equal(returned, 1);
});

test('the generation deadline includes catalog lookup, not just provider streaming', async t => {
  const catalog = deferred();
  const {pelican, clock, calls} = fixture(t, {listModels: () => catalog.promise, stream: async function* () {await new Promise(() => {});}});
  const starting = pelican.run({model: MODEL});
  await clock.advance(119000);
  catalog.resolve(CATALOG);
  await starting;
  await flush();
  assert.equal(calls.length, 1);
  await clock.advance(1000);
  assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-timeout');
});

test('a hung configuration lookup is bounded too', async t => {
  const {pelican, clock} = fixture(t, {listModels: () => new Promise(() => {})});
  const result = assert.rejects(pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1}), /pelican-timeout/);
  await clock.advance(120000);
  await result;
  assert.equal(pelican.snapshot().enabled, false);
  assert.equal(clock.size(), 0);
});

test('late aborted stream completion or rejection cannot overwrite a newer result', async t => {
  for (const reject of [false, true]) {
    const gate = deferred();
    let requests = 0;
    const {pelican, calls} = fixture(t, {stream: () => ++requests === 1 ? (async function* () {await gate.promise; yield text('<svg>old</svg>'); yield stop;})() : chunks([text(SVG), stop])});
    await pelican.run({model: MODEL});
    await flush();
    pelican.cancel();
    await pelican.run({model: NEXT_MODEL});
    await flush();
    const before = pelican.snapshot();
    if (reject) gate.reject(Error('synthetic-secret-late-error'));
    else gate.resolve();
    await flush();
    assert.deepEqual(pelican.snapshot(), before);
    assert.equal(before.lastResult.svg, SVG);
    assert.equal(before.lastResult.model, NEXT_MODEL);
    assert.notEqual(calls[0].signal, calls[1].signal);
    assert.notEqual(calls[0], calls[1]);
  }
});

test('SVG extraction accepts fences and authoritative text block endings without duplication', async t => {
  const {pelican} = fixture(t, {stream: () => chunks([
    text('partial-not-svg'),
    {type: 'block-end', index: 0, block: {type: 'text', text: '\u0060\u0060\u0060svg\n' + SVG + '\n\u0060\u0060\u0060'}},
    {type: 'usage', usage: {inputTokens: 5, outputTokens: 10, totalTokens: 15}},
    stop,
  ])});
  await pelican.run({model: MODEL});
  await flush();
  assert.equal(pelican.snapshot().lastResult.svg, SVG);
  assert.equal(pelican.snapshot().lastResult.status, 'success');
});

test('nested and self-closing SVG roots remain complete strings', async t => {
  for (const svg of ['<svg><svg><path/></svg></svg>', '<svg/>']) {
    const {pelican} = fixture(t, {stream: () => chunks([text(svg), stop])});
    await pelican.run({model: MODEL});
    await flush();
    assert.equal(pelican.snapshot().lastResult.svg, svg);
  }
});

test('the 256 KiB limit is enforced in bytes, including streamed reasoning', async t => {
  const exact = '<svg>' + 'x'.repeat(256 * 1024 - 11) + '</svg>';
  for (const [value, error] of [[exact, false], [exact + 'x', true]]) {
    const {pelican} = fixture(t, {stream: () => chunks([text(value), stop])});
    await pelican.run({model: MODEL});
    await flush();
    assert.equal(pelican.snapshot().lastResult.status, error ? 'error' : 'success');
    assert.equal(pelican.snapshot().lastResult.svg, error ? null : exact);
    assert.equal(pelican.snapshot().lastResult.errorCode, error ? 'pelican-output-limit' : null);
  }
  for (const chunk of [text('鹈'.repeat(11)), {type: 'reasoning-delta', index: 0, text: '鹈'.repeat(11)}, {type: 'block-end', index: 0, block: {type: 'text', text: '鹈'.repeat(11)}}, {type: 'block-end', index: 0, block: {type: 'reasoning', text: '鹈'.repeat(11)}}]) {
    const {pelican} = fixture(t, {config: {maxOutputBytes: 32}, stream: () => chunks([chunk, stop])});
    await pelican.run({model: MODEL});
    await flush();
    assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-output-limit');
    assert.equal(pelican.snapshot().lastResult.svg, null);
  }
});

test('malformed and unsuccessful streams only expose safe local error codes', async t => {
  const cases = [
    {values: [text('not SVG'), stop], code: 'pelican-invalid-svg'},
    {values: [text(SVG)], code: 'pelican-stream-closed'},
    {values: [text(SVG), {type: 'finish', reason: {kind: 'max-tokens'}}], code: 'pelican-max-tokens'},
    {values: [{type: 'tool-call-delta', index: 0, argumentsDelta: 'secret'}], code: 'pelican-tool-call'},
    {values: [{type: 'text-delta', index: 0, text: null}], code: 'pelican-invalid-stream'},
    {values: [{type: 'finish', reason: {kind: 'error', failure: {code: 'SECRET', message: 'private-token'}}}], code: 'pelican-generation-failed'},
  ];
  for (const {values, code} of cases) {
    const {pelican} = fixture(t, {stream: () => chunks(values)});
    await pelican.run({model: MODEL});
    await flush();
    const result = pelican.snapshot().lastResult;
    assert.equal(result.status, 'error');
    assert.equal(result.svg, null);
    assert.equal(result.errorCode, code);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('synchronous provider throws and iterator rejection are sanitized', async t => {
  for (const stream of [() => {throw Error('private-sync');}, async function* () {throw Error('private-async');}]) {
    const {pelican} = fixture(t, {stream});
    await pelican.run({model: MODEL});
    await flush();
    assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-generation-failed');
  }
});

test('provider aborted finish yields a cancelled result without SVG', async t => {
  const {pelican} = fixture(t, {stream: () => chunks([text(SVG), {type: 'finish', reason: {kind: 'aborted'}}])});
  await pelican.run({model: MODEL});
  await flush();
  assert.equal(pelican.snapshot().lastResult.status, 'cancelled');
  assert.equal(pelican.snapshot().lastResult.svg, null);
});

test('scheduled catalog failures are contained and retain a bounded next interval', async t => {
  let catalogs = 0;
  const {pelican, clock, calls} = fixture(t, {listModels() {if (++catalogs > 1) throw Error('private-scheduled'); return CATALOG;}});
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  await clock.advance(60000);
  assert.equal(pelican.snapshot().lastResult.errorCode, 'pelican-models-unavailable');
  assert.equal(pelican.snapshot().nextRunAt, clock.iso(60000));
  assert.equal(clock.size(), 1);
  assert.equal(calls.length, 0);
});

test('last result is detached, bounded to one entry, and SVG is inert text', async t => {
  const inert = '<svg onload="neverExecute()"><script>neverExecute()</script></svg>';
  let requests = 0;
  const {pelican} = fixture(t, {stream: () => chunks([text(++requests === 1 ? SVG : inert), stop])});
  await pelican.run({model: MODEL});
  await flush();
  const first = pelican.snapshot();
  first.lastResult.svg = 'mutated by caller';
  assert.equal(pelican.snapshot().lastResult.svg, SVG);
  await pelican.run({model: NEXT_MODEL});
  await flush();
  assert.equal(pelican.snapshot().lastResult.svg, inert);
  assert.equal(pelican.snapshot().lastResult.model, NEXT_MODEL);
  assert.equal('results' in pelican.snapshot(), false);
});

test('dispose aborts active work, clears timers and SVG, and cannot be reversed', async t => {
  const gate = deferred();
  const {pelican, clock, calls} = fixture(t, {stream: async function* () {yield text(SVG); await gate.promise; yield stop;}});
  await pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1});
  await pelican.run({model: MODEL});
  await flush();
  pelican.dispose();
  pelican.dispose();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(clock.size(), 0);
  const disposed = pelican.snapshot();
  assert.equal(disposed.available, false);
  assert.equal(disposed.enabled, false);
  assert.equal(disposed.running, false);
  assert.equal(disposed.nextRunAt, null);
  assert.equal(disposed.lastResult, null);
  await assert.rejects(pelican.run({model: MODEL}), /pelican-disposed/);
  await assert.rejects(pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1}), /pelican-disposed/);
  await pelican.configure({enabled: false, model: {}, intervalMinutes: 0});
  gate.resolve();
  await flush();
  assert.deepEqual(pelican.snapshot(), disposed);
});

test('dispose promptly settles pending run and configure validation without late I/O', async t => {
  for (const configure of [false, true]) {
    const catalog = deferred();
    const {pelican, clock, calls} = fixture(t, {listModels: () => catalog.promise});
    const work = configure ? pelican.configure({enabled: true, model: MODEL, intervalMinutes: 1}) : pelican.run({model: MODEL});
    const rejected = assert.rejects(work, /pelican-disposed|pelican-cancelled/);
    await flush();
    pelican.dispose();
    await rejected;
    catalog.resolve(CATALOG);
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(clock.size(), 0);
    assert.equal(pelican.snapshot().lastResult, null);
  }
});

test('dispose during stream construction prevents consumption of the returned provider iterator', async t => {
  let pelican, nextCalls = 0;
  const setup = fixture(t, {stream() {
    pelican.dispose();
    return {[Symbol.asyncIterator]() {return this;}, next() {nextCalls++; return Promise.resolve({done: true});}};
  }});
  pelican = setup.pelican;
  await pelican.run({model: MODEL});
  await flush();
  assert.equal(nextCalls, 0);
  assert.equal(pelican.snapshot().lastResult, null);
});

test('unavailable services stay inert and disabling remains safe', async () => {
  for (const options of [{}, {llm: {stream() {}, listModels() {}}}]) {
    const pelican = createPelican(options);
    assert.equal(pelican.snapshot().available, false);
    await assert.rejects(pelican.run({model: MODEL}), /pelican-unavailable/);
    await pelican.configure({enabled: false, model: {}, intervalMinutes: -1});
    pelican.dispose();
  }
});

test('public telemetry integration counts each copied-signal probe exactly once without retaining SVG', async t => {
  const clock = fakeClock();
  let hook, requests = 0;
  const telemetry = createTelemetry({on(event, listener) {
    assert.equal(event, 'llm/stream');
    hook = listener;
    return () => {};
  }}, {now: clock.now, dateNow: clock.now});
  const llm = {
    listModels: () => CATALOG,
    stream(options) {
      requests++;
      return hook({...options}, () => chunks([
        text(SVG), {type: 'usage', usage: {inputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 25}}, stop,
      ]));
    },
  };
  const pelican = createPelican({llm, telemetry, now: clock.now, timers: clock.timers});
  t.after(() => {pelican.dispose(); telemetry.dispose();});
  await pelican.run({model: MODEL});
  await flush();
  const activity = telemetry.snapshot();
  assert.equal(requests, 1);
  assert.equal(activity.entries.length, 1);
  assert.equal(activity.summary.total, 1);
  assert.equal(activity.entries[0].source, 'pelican');
  assert.equal(activity.entries[0].status, 'success');
  assert.equal(activity.entries[0].inputTokens, 15);
  assert.equal(activity.entries[0].outputTokens, 10);
  assert.equal(activity.entries[0].cacheHitRate, 10 / 15);
  assert.equal(activity.entries[0].httpStatus, null);
  assert.equal(JSON.stringify(activity).includes(SVG), false);
  assert.equal(JSON.stringify(activity).includes('生成一张'), false);
  assert.equal(pelican.snapshot().lastResult.svg, SVG);
  telemetry.clear();
  assert.equal(telemetry.snapshot().entries.length, 0);
  assert.equal(pelican.snapshot().lastResult.svg, SVG);
});

test('telemetry records immediate cancellation, timeout and local output-limit errors for probes', async t => {
  for (const reason of ['cancel', 'timeout', 'output-limit']) {
    await t.test(reason, async t => {
      const clock = fakeClock(), gate = deferred();
      let hook;
      const telemetry = createTelemetry({on(event, listener) {hook = listener; return () => {}; }}, {now: clock.now, dateNow: clock.now});
      const llm = {
        listModels: () => CATALOG,
        stream(options) {return hook({...options}, () => reason === 'output-limit' ? chunks([text('x'.repeat(33)), stop]) : (async function* () {await gate.promise; yield stop;})());},
      };
      const pelican = createPelican({llm, telemetry, now: clock.now, timers: clock.timers, maxOutputBytes: 32});
      t.after(() => {pelican.dispose(); telemetry.dispose();});
      await pelican.run({model: MODEL});
      await flush();
      if (reason === 'cancel') pelican.cancel();
      else if (reason === 'timeout') await clock.advance(120000);
      await flush();
      const entries = telemetry.snapshot().entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, reason === 'cancel' ? 'cancelled' : 'error');
      assert.equal(entries[0].errorCode, reason === 'cancel' ? 'pelican-cancelled' : reason === 'timeout' ? 'pelican-timeout' : 'pelican-output-limit');
      assert.equal(pelican.snapshot().lastResult.svg, null);
      const before = {...entries[0]};
      gate.resolve();
      await flush();
      assert.deepEqual(telemetry.snapshot().entries[0], before);
    });
  }
});

test('test injection cannot enlarge or disable the production resource bounds', () => {
  for (const timeoutMs of [0, -1, 120001, Infinity, NaN, '10']) assert.throws(() => createPelican({timeoutMs}), /pelican-invalid-config/);
  for (const maxOutputBytes of [0, -1, 256 * 1024 + 1, Infinity, '10']) assert.throws(() => createPelican({maxOutputBytes}), /pelican-invalid-config/);
});

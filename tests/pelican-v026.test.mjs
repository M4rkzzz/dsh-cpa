import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {deflateSync} from 'node:zlib';
import {createPelican} from '../lib/pelican-v026.mjs';
import {createTelemetry} from '../lib/telemetry-v026.mjs';

const MODEL = 'synthetic-codex', NEXT_MODEL = 'synthetic-codex-next';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L1 1"/></svg>';
const PROMPT = '生成一张鹈鹕骑自行车的SVG';
const stop = {type: 'finish', reason: {kind: 'stop'}};
const text = (value, index = 0) => ({type: 'text-delta', text: value, index});
const chunks = values => (async function* () {yield* values;})();
const flush = () => new Promise(resolve => setImmediate(resolve));
const fixedError = (...codes) => error => codes.includes(error?.code) && error.message === error.code;
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ i >>> 1 : i >>> 1;
  return i >>> 0;
});
function pngChunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(12 + data.length); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, 8 + data.length)) crc = crcTable[(crc ^ value) & 255] ^ crc >>> 8;
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
const raw = Buffer.alloc(1024 * (1024 * 4 + 1)), compressed = deflateSync(raw);
function png({data = compressed, width = 1024, height = 1024, before = [], after = []} = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), ...before,
    pngChunk('IDAT', data), ...after, pngChunk('IEND')]);
}
const PNG = png();
function fakeClock() {
  let now = Date.UTC(2026, 10, 8), sequence = 0;
  const jobs = new Map();
  const timers = {setTimeout(fn, delay) {
    const token = {id: ++sequence, unref() { token.unrefed = true; }};
    jobs.set(token, {fn, at: now + delay, delay, token}); return token;
  }, clearTimeout(token) {jobs.delete(token);}};
  return {now: () => now, iso: (delay = 0) => new Date(now + delay).toISOString(), jobs, timers,
    jump(ms) {now += ms;},
    async advance(ms) {
      now += ms;
      const due = [...jobs].filter(([, job]) => job.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [token, job] of due) if (jobs.delete(token)) {job.fn(); await flush();}
      await flush();
    }};
}
async function fixture(t, options = {}) {
  const clock = fakeClock(), behavior = {...options}, records = new Map(), calls = [], catalogs = [], captures = [], rendered = [], observed = [], saves = [];
  const preferences = structuredClone(options.plans ?? {}), metrics = {credentialReads: 0, credentialModifies: 0, off: 0, borrowedDisposals: 0};
  let onChange;
  for (const id of options.ids ?? ['a', 'b']) records.set(id, {id, provider: 'cpa-codex-' + id,
    principalHash: 'principal-' + id, life: new AbortController(), email: id + '@example.invalid', availability: 'ready', canRunProbe: true});
  const defaultList = () => [...records.values()].map(({id, provider, email, availability, canRunProbe}) => ({id, provider, email, availability, canRunProbe}));
  const defaultCapture = (id, providerId) => {
    const item = records.get(id);
    if (!item || providerId !== item.provider) throw new Error('PRIVATE-CREDENTIAL-LOOKUP');
    const principalHash = item.principalHash, signal = item.life.signal;
    const binding = {accountId: id, providerId, principalHash, email: item.email, signal,
      credentials: {async read() {metrics.credentialReads++; return null;}, async modify() {metrics.credentialModifies++;}},
      async assertCurrent() {
        if (behavior.assertCurrent) await behavior.assertCurrent(id, binding);
        const current = records.get(id);
        if (!current || current.principalHash !== principalHash || signal.aborted) throw new Error('PRIVATE-IDENTITY-CHANGE');
      }};
    return binding;
  };
  const accounts = {
    list() {return behavior.list ? behavior.list(defaultList) : defaultList();},
    capture(id, providerId) {captures.push({id, providerId}); return behavior.capture ? behavior.capture(id, providerId, defaultCapture) : defaultCapture(id, providerId);},
    onChange(fn) {onChange = fn; return () => {metrics.off++; onChange = null;};},
    dispose() {metrics.borrowedDisposals++;},
  };
  const transport = {
    providerFor(id) {return behavior.providerFor ? behavior.providerFor(id) : 'cpa-codex-' + id;},
    listModels(id) {catalogs.push(id); return behavior.catalog ? behavior.catalog(id) : [{id: MODEL, provider: 'cpa-codex-' + id}, {id: NEXT_MODEL, provider: 'cpa-codex-' + id}];},
    stream(id, request, binding) {calls.push({id, request, binding}); return behavior.stream ? behavior.stream(id, request, binding) : chunks([text(SVG), stop]);},
    dispose() {metrics.borrowedDisposals++;},
  };
  const telemetry = {observeProbe(request, next) {observed.push(request); return next();}, dispose() {metrics.borrowedDisposals++;}};
  const renderer = {render(svg, input) {rendered.push({svg, input}); return behavior.render ? behavior.render(svg, input) : PNG;}, dispose() {metrics.borrowedDisposals++;}};
  const defaultSave = (id, plan, guard) => {
    if (!guard.isCurrent()) throw new Error('PRIVATE-STALE-SAVE');
    preferences[id] = {...plan};
  };
  const pelican = createPelican({accounts, transport, telemetry, renderer,
    getPlans() {return behavior.getPlans ? behavior.getPlans(preferences) : structuredClone(preferences);},
    savePlan(id, plan, guard) {saves.push({id, plan, guard}); return behavior.save ? behavior.save(id, plan, guard, defaultSave) : defaultSave(id, plan, guard);},
    now: clock.now, timers: clock.timers, ...options.config});
  t.after(() => pelican.dispose());
  if (!options.noRefresh) await pelican.refresh();
  return {pelican, clock, behavior, records, calls, catalogs, captures, rendered, observed, saves, preferences,
    metrics, accounts, transport, renderer, telemetry, emit() {onChange?.();}, defaultCapture, defaultList};
}
const state = (f, id = 'a') => f.pelican.snapshot().accounts.find(row => row.id === id)?.pelican;
async function run(f, id = 'a', model = MODEL) {await f.pelican.run(id, {model}); await flush(); return state(f, id);}

for (const interval of [0, 5, 10, 20, 30]) test('restores interval ' + interval + ' without an immediate call or startup catch-up', async t => {
  const f = await fixture(t, {ids: ['a'], plans: {a: {intervalMinutes: interval, model: MODEL}}});
  assert.equal(f.calls.length, 0); assert.equal(f.catalogs.length, 0); assert.equal(state(f).intervalMinutes, interval);
  assert.equal(state(f).nextRunAt, interval ? f.clock.iso(interval * 60000) : null);
  if (interval) {
    assert.ok([...f.clock.jobs.values()][0].token.unrefed);
    await f.clock.advance(interval * 60000 - 1); assert.equal(f.calls.length, 0);
    await f.clock.advance(1); assert.equal(f.calls.length, 1); assert.equal(state(f).historyCount, 1);
    assert.equal(state(f).nextRunAt, f.clock.iso(interval * 60000));
  } else {await f.clock.advance(24 * 60 * 60000); assert.equal(f.calls.length, 0);}
});

test('default accounts are disabled plans, detached snapshots expose no prompt/SVG and credentials are never read by runner', async t => {
  const f = await fixture(t);
  assert.equal(state(f).available, true); assert.equal(state(f).running, false); assert.equal(state(f).intervalMinutes, 0);
  assert.equal(f.clock.jobs.size, 0); assert.equal(f.calls.length, 0); assert.equal(f.metrics.credentialReads, 0);
  const snapshot = f.pelican.snapshot(); snapshot.accounts[0].pelican.model = 'changed'; assert.equal(state(f).model, '');
  assert.ok(!JSON.stringify(snapshot).includes(PROMPT)); assert.deepEqual(f.pelican.history('absent'), {images: []});
});

test('validates injected bounds and missing capabilities fail closed', async t => {
  for (const options of [{timeoutMs: 0}, {timeoutMs: 120001}, {maxOutputBytes: 0}, {maxOutputBytes: 256 * 1024 + 1},
    {now: null}, {timers: null}, {timers: {setTimeout: 1}}, {isEnabled: true}]) {
    assert.throws(() => createPelican(options), fixedError('pelican-invalid-config'));
  }
  const unavailable = createPelican(); t.after(() => unavailable.dispose());
  await assert.rejects(unavailable.refresh(), fixedError('pelican-unavailable'));
  const f = await fixture(t, {config: {renderer: {}}});
  assert.equal(state(f).available, false); await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-unavailable'));
});

test('poll refresh and same-principal token rotation do not continually reset timers', async t => {
  const f = await fixture(t, {ids: ['a'], plans: {a: {intervalMinutes: 5, model: MODEL}}});
  const next = state(f).nextRunAt;
  for (let i = 0; i < 4; i++) {await f.clock.advance(60000); await f.pelican.refresh(); assert.equal(state(f).nextRunAt, next);}
  await f.clock.advance(60000); assert.equal(f.calls.length, 1);
});

test('a late timer fires at most once and schedules the next full interval, not missed intervals', async t => {
  const f = await fixture(t, {ids: ['a'], plans: {a: {intervalMinutes: 5, model: MODEL}}});
  await f.clock.advance(24 * 60 * 60000); assert.equal(f.calls.length, 1);
  assert.equal(state(f).nextRunAt, f.clock.iso(5 * 60000));
});

for (const interval of [1, 4, 6, 60, -1, 0.5, '5', null, NaN, Infinity]) test('rejects invalid interval ' + String(interval), async t => {
  const f = await fixture(t);
  await assert.rejects(f.pelican.configure('a', {intervalMinutes: interval, model: MODEL}), fixedError('pelican-invalid-interval'));
  assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0);
});

test('configuring a plan validates model and persists only the enum/model without starting a request', async t => {
  const f = await fixture(t);
  await f.pelican.configure('a', {intervalMinutes: 5, model: MODEL, prompt: 'PRIVATE'});
  assert.equal(f.calls.length, 0); assert.deepEqual(f.preferences.a, {intervalMinutes: 5, model: MODEL});
  assert.deepEqual(f.saves[0].plan, {intervalMinutes: 5, model: MODEL});
  assert.equal(state(f).nextRunAt, f.clock.iso(300000));
  await f.clock.advance(60000); await f.pelican.configure('a', {intervalMinutes: 5, model: MODEL});
  assert.equal(state(f).nextRunAt, f.clock.iso(300000)); assert.equal(f.calls.length, 0);
});

test('unknown model/provider and catalog errors fail before model calls or persistence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.pelican.run('a'), fixedError('pelican-invalid-model'));
  await assert.rejects(f.pelican.configure('a', {intervalMinutes: 5}), fixedError('pelican-invalid-model'));
  f.behavior.catalog = () => [{id: MODEL, provider: 'wrong-provider'}];
  await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-invalid-model'));
  f.behavior.catalog = () => {throw new Error('PRIVATE-CATALOG-PATH');};
  await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-models-unavailable'));
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
});

test('positive save failure retains the acknowledged plan; failed off stays stopped across refresh', async t => {
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}}});
  f.behavior.save = () => {throw new Error('PRIVATE-SETTINGS-PATH');};
  await assert.rejects(f.pelican.configure('a', {intervalMinutes: 10, model: NEXT_MODEL}), fixedError('pelican-save-failed'));
  assert.equal(state(f).intervalMinutes, 5); assert.equal(state(f).model, MODEL);
  const off = f.pelican.configure('a', {intervalMinutes: 0});
  assert.equal(state(f).intervalMinutes, 0); assert.equal(state(f).nextRunAt, null);
  await assert.rejects(off, fixedError('pelican-save-failed')); await f.pelican.refresh();
  assert.equal(state(f).intervalMinutes, 0); assert.equal(state(f).nextRunAt, null); assert.equal(state(f).lastError, 'pelican-save-failed');
  await f.clock.advance(30 * 60000); assert.equal(f.calls.length, 0);
});

test('manual run freezes a credential binding and sends only fixed prompt/tools[] through one telemetry call', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t, {stream: () => (async function* () {await gate.promise; yield text(SVG); yield stop;})()});
  const response = await f.pelican.run('a', {model: MODEL, prompt: 'PRIVATE', tools: ['PRIVATE'], sessionId: 'PRIVATE'});
  assert.equal(response.accounts[0].pelican.running, true); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.observed.length, 1);
  const {id, request, binding} = f.calls[0];
  assert.equal(id, 'a'); assert.equal(request, f.observed[0]); assert.equal(request.provider, 'cpa-codex-a');
  assert.equal(request.accountId, 'a'); assert.equal(request.accountEmail, 'a@example.invalid'); assert.equal(request.model, MODEL);
  assert.equal(request.maxTokens, 4096); assert.deepEqual(request.tools, []);
  assert.deepEqual(Object.keys(request).sort(), ['provider', 'model', 'maxTokens', 'accountId', 'accountEmail', 'messages', 'tools', 'signal'].sort());
  assert.equal(request.messages.length, 1); assert.deepEqual(request.messages[0].content, [{type: 'text', text: PROMPT}]);
  assert.equal(request.messages[0].role, 'user'); assert.deepEqual(request.messages[0].source, {kind: 'user'});
  assert.ok(Object.isFrozen(binding)); assert.equal(binding.accountId, 'a'); assert.equal(binding.principalHash, 'principal-a');
  gate.resolve(); await flush(); assert.equal(state(f).historyCount, 1); assert.equal(state(f).running, false);
  assert.equal(f.metrics.credentialReads, 0); assert.equal(f.metrics.credentialModifies, 0);
});

test('per-account single flight begins before catalog awaits, while other accounts are independent by default', async t => {
  const gates = {a: Promise.withResolvers(), b: Promise.withResolvers()};
  const f = await fixture(t, {stream: id => (async function* () {await gates[id].promise; yield text(SVG); yield stop;})()});
  await f.pelican.run('a', {model: MODEL}); await f.pelican.run('b', {model: NEXT_MODEL}); await flush();
  await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-busy'));
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(c => c.binding.accountId), ['a', 'b']);
  assert.notEqual(f.calls[0].binding.signal, f.calls[1].binding.signal); assert.notEqual(f.calls[0].request.signal, f.calls[1].request.signal);
  gates.a.resolve(); gates.b.resolve(); await flush(); assert.equal(state(f, 'a').historyCount, 1); assert.equal(state(f, 'b').historyCount, 1);
});

test('delta/final block reconciliation avoids duplicated SVG and orders separate blocks by index', async t => {
  const half = Math.floor(SVG.length / 2), a = SVG.slice(0, half), b = SVG.slice(half);
  const f = await fixture(t, {stream: () => chunks([
    {type: 'reasoning-delta', index: 2, text: 'PRIVATE-REASONING'}, text(b, 1), text(a, 0),
    {type: 'block-end', index: 0, block: {type: 'text', text: a}},
    {type: 'block-end', index: 1, block: {type: 'text', text: b}}, stop,
  ])});
  await run(f); assert.equal(f.rendered[0].svg, SVG); assert.equal(state(f).historyCount, 1);
  const publicData = JSON.stringify([f.pelican.snapshot(), f.pelican.history('a')]);
  for (const secret of [SVG, PROMPT, 'PRIVATE-REASONING', '<svg', 'credentials']) assert.ok(!publicData.includes(secret));
});

const failures = [
  ['stream exhausted', [], 'pelican-stream-closed'], ['max tokens', [text(SVG), {type: 'finish', reason: {kind: 'max-tokens'}}], 'pelican-max-tokens'],
  ['upstream failure', [{type: 'finish', reason: {kind: 'error', failure: {message: 'PRIVATE'}}}], 'pelican-generation-failed'],
  ['tool finish', [{type: 'finish', reason: {kind: 'tool-calls'}}], 'pelican-tool-call'],
  ['tool delta', [{type: 'tool-call-delta', name: 'PRIVATE'}], 'pelican-tool-call'],
  ['tool block start', [{type: 'block-start', blockType: 'tool-call'}], 'pelican-tool-call'],
  ['tool block end', [{type: 'block-end', block: {type: 'tool-call'}}], 'pelican-tool-call'],
  ['invalid text', [{type: 'text-delta', text: {}, index: 0}], 'pelican-invalid-stream'],
  ['invalid index', [text(SVG, -1)], 'pelican-invalid-stream'],
  ['closed block duplication', [{type: 'block-end', index: 0, block: {type: 'text', text: SVG}}, text('extra')], 'pelican-invalid-stream'],
  ['mixed block kind', [text(SVG), {type: 'reasoning-delta', index: 0, text: 'private'}], 'pelican-invalid-stream'],
  ['no SVG', [text('PRIVATE-NON-SVG'), stop], 'pelican-invalid-svg'],
];
for (const [label, stream, expected] of failures) test('rejects ' + label + ' without retaining an image or raw errors', async t => {
  const f = await fixture(t, {stream: () => chunks(stream)}); await run(f);
  assert.equal(state(f).running, false); assert.equal(state(f).lastError, expected); assert.equal(state(f).historyCount, 0); assert.equal(f.rendered.length, 0);
});

test('actual aborted finish is cancellation, not successful history', async t => {
  const f = await fixture(t, {stream: () => chunks([{type: 'finish', reason: {kind: 'aborted'}}])}); await run(f);
  assert.equal(state(f).lastError, null); assert.equal(state(f).historyCount, 0);
});

test('total output byte budget includes reasoning, final blocks and multibyte strings', async t => {
  const f = await fixture(t, {config: {maxOutputBytes: 100}, stream: () => chunks([
    {type: 'reasoning-delta', index: 1, text: '鹈'.repeat(20)}, text(SVG), stop,
  ])}); await run(f); assert.equal(state(f).lastError, 'pelican-output-limit'); assert.equal(f.rendered.length, 0);
  f.behavior.stream = () => chunks([{type: 'block-end', index: 0, block: {type: 'text', text: SVG + 'x'.repeat(100)}}, stop]);
  await run(f); assert.equal(state(f).lastError, 'pelican-output-limit');
});

test('text block count is bounded even for empty deltas', async t => {
  const f = await fixture(t, {stream: () => chunks(Array.from({length: 1025}, (_, index) => text('', index)))});
  await run(f); assert.equal(state(f).lastError, 'pelican-output-limit');
});

test('uncooperative iterator next/return never blocks cancel or leaks a late rejection', async t => {
  const next = Promise.withResolvers(), returned = Promise.withResolvers(); let returns = 0;
  const f = await fixture(t, {stream: () => ({[Symbol.asyncIterator]() {return this;}, next: () => next.promise,
    return() {returns++; return returned.promise;}})});
  await f.pelican.run('a', {model: MODEL}); await flush(); f.pelican.cancel('a');
  assert.equal(state(f).running, false); await flush(); assert.equal(returns, 1);
  next.reject(new Error('PRIVATE-LATE-NEXT')); returned.reject(new Error('PRIVATE-LATE-RETURN')); await flush();
  assert.equal(state(f).lastError, null); assert.equal(state(f).historyCount, 0);
});

test('cancel supersedes a pending model validation and permits a fresh round without late dispatch', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), f = await fixture(t);
  let once = true;
  f.behavior.catalog = id => {if (once) {once = false; entered.resolve(); return gate.promise;} return [{id: MODEL, provider: 'cpa-codex-' + id}];};
  const old = assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-cancelled'));
  await entered.promise; f.pelican.cancel('a'); assert.equal(state(f).running, false); await old;
  await run(f); gate.resolve([{id: MODEL, provider: 'cpa-codex-a'}]); await flush();
  assert.equal(f.calls.length, 1); assert.equal(state(f).historyCount, 1);
});

test('cancel also supersedes pending capture and late capture cannot dispatch', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers(); let once = true;
  f.behavior.capture = (id, provider, next) => {if (once) {once = false; entered.resolve(); return gate.promise;} return next(id, provider);};
  const old = assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-cancelled'));
  await entered.promise; f.pelican.cancel('a'); await old; gate.resolve(f.defaultCapture('a', 'cpa-codex-a')); await flush();
  assert.equal(f.calls.length, 0); assert.equal(state(f).running, false);
});

test('cancel during rendering aborts immediately and late render success cannot replace a fresh image', async t => {
  const f = await fixture(t), old = Promise.withResolvers(); let once = true;
  f.behavior.render = () => {if (once) {once = false; return old.promise;} return PNG;};
  await f.pelican.run('a', {model: MODEL}); await flush(); const signal = f.rendered[0].input.signal;
  f.pelican.cancel('a'); assert.equal(signal.aborted, true); assert.equal(state(f).running, false);
  await run(f); const id = f.pelican.history('a').images[0].id;
  old.resolve(PNG); await flush(); assert.deepEqual(f.pelican.history('a').images.map(image => image.id), [id]);
  assert.equal(state(f).lastError, null);
});

test('off preempts a slow positive configure before catalog result or persistence can arrive', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.catalog = () => {entered.resolve(); return gate.promise;};
  const old = assert.rejects(f.pelican.configure('a', {intervalMinutes: 5, model: MODEL}), fixedError('pelican-cancelled'));
  await entered.promise; await f.pelican.configure('a', {intervalMinutes: 0}); await old;
  gate.resolve([{id: MODEL, provider: 'cpa-codex-a'}]); await flush();
  assert.deepEqual(f.preferences.a, {intervalMinutes: 0, model: ''}); assert.equal(f.saves.length, 1); assert.equal(f.clock.jobs.size, 0);
});

test('off supersedes an old save ACK and old guard cannot commit after stop', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers(); let oldGuard;
  f.behavior.save = (id, plan, guard, next) => {
    if (plan.intervalMinutes) {oldGuard = guard; entered.resolve(); return gate.promise;}
    return next(id, plan, guard);
  };
  const old = assert.rejects(f.pelican.configure('a', {intervalMinutes: 5, model: MODEL}), fixedError('pelican-cancelled'));
  await entered.promise; const off = f.pelican.configure('a', {intervalMinutes: 0}); assert.equal(oldGuard.isCurrent(), false);
  await off; await old; gate.resolve(); await flush();
  assert.equal(state(f).intervalMinutes, 0); assert.equal(state(f).nextRunAt, null);
});

test('cancel preempts pending configure but retains ACK plan and blocks old persisted snapshots', async t => {
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let guard;
  f.behavior.save = (id, plan, input) => {guard = input; entered.resolve(); return gate.promise;};
  const pending = assert.rejects(f.pelican.configure('a', {intervalMinutes: 10, model: NEXT_MODEL}), fixedError('pelican-cancelled'));
  await entered.promise; f.pelican.cancel('a'); await pending; assert.equal(guard.isCurrent(), false);
  f.preferences.a = {intervalMinutes: 10, model: NEXT_MODEL}; gate.resolve(); await flush(); await f.pelican.refresh();
  assert.equal(state(f).intervalMinutes, 5); assert.equal(state(f).model, MODEL); assert.equal(state(f).nextRunAt, f.clock.iso(300000));
});

test('120-second timeout covers preparation, stream and renderer, with no late image commit', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t, {render: () => gate.promise});
  await f.pelican.run('a', {model: MODEL}); await flush();
  await f.clock.advance(120000); assert.equal(state(f).running, false); assert.equal(state(f).lastError, 'pelican-timeout');
  assert.equal(f.rendered[0].input.signal.aborted, true); gate.resolve(PNG); await flush(); assert.equal(state(f).historyCount, 0);
});

test('pending configure/catalog also has bounded timeout and safe failure', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.catalog = () => {entered.resolve(); return gate.promise;};
  const result = assert.rejects(f.pelican.configure('a', {intervalMinutes: 5, model: MODEL}), fixedError('pelican-timeout'));
  await entered.promise; await f.clock.advance(120000); await result; gate.resolve([]); await flush();
  assert.equal(state(f).intervalMinutes, 0); assert.equal(f.calls.length, 0); assert.equal(f.clock.jobs.size, 0);
});

test('PNG history is newest-first, detached, per-account and contains no captions or SVG', async t => {
  const f = await fixture(t); await run(f); f.clock.jump(1000); await run(f);
  const history = f.pelican.history('a'); assert.equal(history.images.length, 2);
  assert.ok(history.images[0].createdAt > history.images[1].createdAt);
  assert.deepEqual(Object.keys(history.images[0]).sort(), ['id', 'createdAt', 'width', 'height', 'url'].sort());
  const {id, url} = history.images[0]; assert.match(url, /^\/api\/cpa-image\?accountId=a&imageId=/);
  const image = f.pelican.image('a', id); assert.deepEqual(image, new Uint8Array(PNG)); image.fill(0);
  assert.equal(f.pelican.image('a', id)[0], 137); assert.equal(f.pelican.image('b', id), null); assert.equal(f.pelican.image('a', 'missing'), null);
  history.images[0].width = 7; assert.equal(f.pelican.history('a').images[0].width, 1024);
});

test('renderer output is independently copied before history retention', async t => {
  const bytes = Uint8Array.from(PNG), f = await fixture(t, {render: () => bytes}); await run(f);
  const id = f.pelican.history('a').images[0].id; bytes.fill(0);
  assert.equal(f.pelican.image('a', id)[0], 137);
});

const badImages = [
  ['not bytes', '<svg>PRIVATE</svg>', 'pelican-invalid-png'], ['signature only', PNG.subarray(0, 8), 'pelican-invalid-png'],
  ['wrong dimensions', png({width: 1}), 'pelican-invalid-png'], ['SVG metadata', png({before: [pngChunk('tEXt', Buffer.from('<svg>PRIVATE</svg>'))]}), 'pelican-invalid-png'],
  ['duplicate metadata', png({before: [pngChunk('sRGB', Buffer.from([0])), pngChunk('sRGB', Buffer.from([0]))]}), 'pelican-invalid-png'],
  ['invalid metadata', png({before: [pngChunk('gAMA', Buffer.alloc(4))]}), 'pelican-invalid-png'],
  ['truncated zlib', png({data: Buffer.from([1, 2, 3])}), 'pelican-invalid-png'],
  ['truncated scanlines', png({data: deflateSync(Buffer.alloc(1))}), 'pelican-invalid-png'],
  ['decompression bomb', png({data: deflateSync(Buffer.alloc(raw.length + 1))}), 'pelican-invalid-png'],
  ['trailing zlib SVG', png({data: Buffer.concat([compressed, Buffer.from('<svg>PRIVATE</svg>')])}), 'pelican-invalid-png'],
  ['PNG over 2MiB', new Uint8Array(2 * 1024 * 1024 + 1), 'pelican-image-limit'],
];
for (const [label, output, expected] of badImages) test('does not save image history for ' + label, async t => {
  const f = await fixture(t, {render: () => output}); await run(f);
  assert.equal(state(f).historyCount, 0); assert.equal(state(f).lastError, expected); assert.equal(state(f).running, false);
});

test('renderer rejection is safe and never counted as successful image history', async t => {
  const f = await fixture(t, {render: () => Promise.reject(new Error('PRIVATE-RENDER-PATH-SVG'))}); await run(f);
  assert.equal(state(f).lastError, 'pelican-render-failed'); assert.equal(state(f).historyCount, 0);
});

test('per-account history is exactly eight images with oldest byte access revoked', async t => {
  const f = await fixture(t); await run(f); const oldest = f.pelican.history('a').images[0].id;
  for (let i = 0; i < 9; i++) {f.clock.jump(1); await run(f);}
  assert.equal(state(f).historyCount, 8); assert.equal(f.pelican.image('a', oldest), null);
});

test('global 64-image limit evicts oldest globally even when each account is within eight', async t => {
  const ids = Array.from({length: 9}, (_, i) => 'account-' + i), f = await fixture(t, {ids});
  let first;
  for (let i = 0; i < 65; i++) {const id = ids[i % ids.length]; await run(f, id); if (!i) first = f.pelican.history(id).images[0].id;}
  assert.equal(ids.reduce((sum, id) => sum + f.pelican.history(id).images.length, 0), 64);
  assert.equal(f.pelican.image(ids[0], first), null);
});

test('global 16MiB budget evicts before the count budget and still keeps valid PNG only', async t => {
  const noisy = Buffer.from(raw); let seed = 1234567, written = 0;
  for (let i = 0; i < noisy.length && written < 1800000; i++) if (i % (1024 * 4 + 1)) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noisy[i] = seed & 255; written++;
  }
  const large = png({data: deflateSync(noisy)}); assert.ok(large.length > 1024 * 1024 && large.length <= 2 * 1024 * 1024);
  const ids = ['a', 'b', 'c'], f = await fixture(t, {ids, render: () => large}); let first;
  for (let i = 0; i < 12; i++) {const id = ids[i % ids.length]; await run(f, id); if (!i) first = f.pelican.history(id).images[0].id;}
  let bytes = 0, count = 0;
  for (const id of ids) for (const item of f.pelican.history(id).images) {bytes += f.pelican.image(id, item.id).byteLength; count++;}
  assert.ok(bytes <= 16 * 1024 * 1024); assert.ok(count < 12); assert.equal(f.pelican.image('a', first), null);
});

test('identity abort clears owned PNGs and cancels an inflight renderer immediately', async t => {
  const f = await fixture(t); await run(f); const gate = Promise.withResolvers(); f.behavior.render = () => gate.promise;
  await f.pelican.run('a', {model: MODEL}); await flush(); const signal = f.rendered.at(-1).input.signal;
  f.records.get('a').life.abort(new Error('PRIVATE-ACCOUNT-REVOKED'));
  assert.equal(signal.aborted, true); assert.equal(state(f).running, false); assert.equal(state(f).historyCount, 0); assert.equal(state(f).available, false);
  gate.resolve(PNG); await flush(); assert.equal(state(f).historyCount, 0);
});

test('fresh binding identity check after render prevents committing under a changed principal', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t); await run(f); f.behavior.render = () => gate.promise;
  await f.pelican.run('a', {model: MODEL}); await flush(); f.records.get('a').principalHash = 'new-principal';
  gate.resolve(PNG); await flush(); assert.equal(state(f).historyCount, 0); assert.equal(state(f).lastError, 'pelican-account-changed');
});

test('same-principal credential rotation preserves history and allows the bound round to finish', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t); await run(f); f.behavior.render = () => gate.promise;
  await f.pelican.run('a', {model: MODEL}); await flush(); f.records.get('a').tokenVersion = 2;
  gate.resolve(PNG); await flush(); assert.equal(state(f).historyCount, 2); assert.equal(state(f).lastError, null);
});

test('account removal aborts work and images, and a stale refresh cannot resurrect the account', async t => {
  const f = await fixture(t); await run(f); const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.list = next => {const rows = next(); entered.resolve(); return gate.promise.then(() => rows);};
  const pending = f.pelican.refresh(); await entered.promise; f.pelican.removeAccount('a'); f.records.delete('a');
  gate.resolve(); await pending; assert.equal(state(f, 'a'), undefined); assert.deepEqual(f.pelican.history('a'), {images: []});
});

test('dispose synchronously aborts probes, pending refresh and saved images without disposing borrowed dependencies', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t); await run(f); f.behavior.render = () => gate.promise;
  await f.pelican.run('a', {model: MODEL}); await flush(); const signal = f.rendered.at(-1).input.signal;
  f.pelican.dispose(); f.pelican.dispose(); assert.equal(signal.aborted, true); assert.equal(f.clock.jobs.size, 0);
  assert.deepEqual(f.pelican.snapshot(), {accounts: []}); assert.deepEqual(f.pelican.history('a'), {images: []});
  assert.equal(f.metrics.borrowedDisposals, 0); assert.equal(f.metrics.off, 1);
  await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-disposed'));
  await assert.rejects(f.pelican.refresh(), fixedError('pelican-disposed'));
  gate.reject(new Error('PRIVATE-LATE-RENDER')); await flush();
});

test('only selected account is available/scheduled; inactive rejects run/config but permits persistent off', async t => {
  let active = 'a';
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}, b: {intervalMinutes: 10, model: MODEL}},
    config: {isEnabled: id => id === active}});
  assert.equal(state(f, 'a').available, true); assert.equal(state(f, 'b').available, false);
  assert.equal(state(f, 'b').intervalMinutes, 10); assert.equal(state(f, 'b').nextRunAt, null);
  const captures = f.captures.length;
  await assert.rejects(f.pelican.run('b', {model: MODEL}), fixedError('pelican-account-inactive'));
  await assert.rejects(f.pelican.configure('b', {intervalMinutes: 5, model: MODEL}), fixedError('pelican-account-inactive'));
  assert.equal(f.captures.length, captures); assert.equal(f.catalogs.length, 0); assert.equal(f.calls.length, 0);
  await f.pelican.configure('b', {intervalMinutes: 0}); assert.equal(f.preferences.b.intervalMinutes, 0);
  assert.equal(state(f, 'b').available, false); assert.equal(state(f, 'a').nextRunAt, f.clock.iso(300000));
});

test('switch pauses old work synchronously, preserves PNG/plan and resumes a full interval only', async t => {
  let active = 'a';
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}, b: {intervalMinutes: 10, model: MODEL}},
    config: {isEnabled: id => id === active}});
  await run(f, 'a'); const imageA = f.pelican.history('a').images[0].id;
  const oldTimer = [...f.clock.jobs.values()].find(job => job.delay === 300000), gate = Promise.withResolvers();
  f.behavior.render = () => gate.promise; await f.pelican.run('a', {model: MODEL}); await flush();
  const signal = f.rendered.at(-1).input.signal; active = 'b'; const refresh = f.pelican.refresh();
  assert.equal(signal.aborted, true); assert.equal(state(f, 'a').running, false); await refresh;
  assert.equal(state(f, 'a').available, false); assert.equal(state(f, 'a').intervalMinutes, 5); assert.equal(state(f, 'a').nextRunAt, null);
  assert.ok(f.pelican.image('a', imageA)); assert.equal(state(f, 'b').nextRunAt, f.clock.iso(600000));
  const before = f.calls.length; oldTimer.fn(); await f.clock.advance(300000); assert.equal(f.calls.length, before);
  active = 'a'; await f.pelican.refresh(); assert.equal(state(f, 'a').nextRunAt, f.clock.iso(300000));
  assert.equal(state(f, 'b').nextRunAt, null); gate.resolve(PNG); await flush(); assert.equal(state(f, 'a').historyCount, 1);
  f.behavior.render = () => PNG; await f.clock.advance(300000); assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1).id, 'a'); assert.equal(state(f, 'a').historyCount, 2);
});

test('a prepared catalog result cannot send a model call after selection changes even before refresh', async t => {
  let active = 'a'; const f = await fixture(t, {config: {isEnabled: id => id === active}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.catalog = () => {entered.resolve(); return gate.promise;};
  const pending = assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-account-inactive'));
  await entered.promise; active = 'b'; gate.resolve([{id: MODEL, provider: 'cpa-codex-a'}]); await pending; await flush();
  assert.equal(f.calls.length, 0); assert.equal(state(f, 'a').running, false); assert.equal(state(f, 'a').available, false);
});

test('a switch aborts pending configure; switching back cannot accept its old ACK or saved snapshot', async t => {
  let active = 'a'; const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}}, config: {isEnabled: id => id === active}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let guard;
  f.behavior.save = (id, plan, input) => {guard = input; entered.resolve(); return gate.promise;};
  const pending = assert.rejects(f.pelican.configure('a', {intervalMinutes: 10, model: NEXT_MODEL}), fixedError('pelican-account-inactive'));
  await entered.promise; active = 'b'; await f.pelican.refresh(); await pending; assert.equal(guard.isCurrent(), false);
  f.preferences.a = {intervalMinutes: 10, model: NEXT_MODEL}; active = 'a'; await f.pelican.refresh();
  gate.resolve(); await flush(); assert.equal(state(f).intervalMinutes, 5); assert.equal(state(f).model, MODEL);
  assert.equal(state(f).nextRunAt, f.clock.iso(300000)); assert.equal(f.calls.length, 0);
});

test('off persistence remains allowed and current when the account becomes inactive mid-save', async t => {
  let active = 'a'; const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}}, config: {isEnabled: id => id === active}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let guard;
  f.behavior.save = (id, plan, input, next) => {guard = input; entered.resolve(); return gate.promise.then(() => next(id, plan, input));};
  const off = f.pelican.configure('a', {intervalMinutes: 0}); await entered.promise;
  active = 'b'; await f.pelican.refresh(); assert.equal(guard.isCurrent(), true);
  gate.resolve(); await off; assert.equal(f.preferences.a.intervalMinutes, 0); assert.equal(state(f).intervalMinutes, 0); assert.equal(state(f).available, false);
});

test('empty active selection means all off without fallback; histories and saved intervals remain', async t => {
  let active = 'a'; const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}, b: {intervalMinutes: 10, model: MODEL}},
    config: {isEnabled: id => id === active}});
  await run(f); const id = f.pelican.history('a').images[0].id; active = ''; await f.pelican.refresh();
  assert.equal(state(f, 'a').available, false); assert.equal(state(f, 'b').available, false); assert.equal(f.clock.jobs.size, 0);
  assert.equal(state(f, 'a').intervalMinutes, 5); assert.equal(state(f, 'b').intervalMinutes, 10); assert.ok(f.pelican.image('a', id));
  await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-account-inactive'));
  await assert.rejects(f.pelican.run('b', {model: MODEL}), fixedError('pelican-account-inactive'));
});

test('isEnabled is strict and fail-closed for throws/nonboolean truthy values', async t => {
  let mode = true; const f = await fixture(t, {config: {isEnabled: () => {if (mode === 'throw') throw new Error('PRIVATE'); return mode;}}});
  for (const value of [1, 'true', 'throw']) {
    mode = value; await f.pelican.refresh(); assert.equal(state(f).available, false);
    await assert.rejects(f.pelican.run('a', {model: MODEL}), fixedError('pelican-account-inactive'));
  }
  assert.equal(f.calls.length, 0);
});

test('real telemetry chain records a probe exactly once, never a duplicate conversation', async t => {
  let hook; const telemetry = createTelemetry({on(name, fn) {hook = fn; return () => {};}});
  t.after(() => telemetry.dispose()); telemetry.registerProvider('cpa-codex-a');
  const f = await fixture(t, {config: {telemetry}});
  f.behavior.stream = (id, options) => hook(options, () => chunks([text(SVG), stop]));
  await run(f); const logs = telemetry.snapshot();
  assert.equal(logs.summary.total, 1); assert.equal(logs.entries.length, 1); assert.equal(logs.entries[0].source, 'pelican');
});

test('restored malformed plans stay off with a fixed settings error and no model lookup', async t => {
  const f = await fixture(t, {plans: {a: {intervalMinutes: 6, model: MODEL}, b: {intervalMinutes: 5, model: 'PRIVATE INVALID MODEL'}}});
  assert.equal(state(f, 'a').intervalMinutes, 0); assert.equal(state(f, 'b').intervalMinutes, 0);
  assert.equal(state(f, 'a').lastError, 'pelican-invalid-config'); assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.catalogs.length, 0); assert.equal(f.calls.length, 0);
});

test('registry and settings read failures are bounded and expose no raw details', async t => {
  const f = await fixture(t); f.behavior.list = () => {throw new Error('PRIVATE-REGISTRY-PATH');};
  await assert.rejects(f.pelican.refresh(), fixedError('pelican-accounts-unavailable'));
  assert.equal(state(f).available, false); assert.equal(state(f).lastError, 'pelican-accounts-unavailable');
  delete f.behavior.list; f.behavior.getPlans = () => {throw new Error('PRIVATE-SETTINGS-PATH');};
  await assert.rejects(f.pelican.refresh(), fixedError('pelican-settings-unavailable'));
  assert.equal(state(f).lastError, 'pelican-settings-unavailable'); assert.equal(f.clock.jobs.size, 0);
});

test('registry ignores malformed and duplicate routing ids rather than using display identity as authority', async t => {
  const f = await fixture(t, {noRefresh: true});
  f.behavior.list = next => [...next(), {id: '../PRIVATE', provider: 'evil', availability: 'ready', canRunProbe: true},
    {id: '__proto__', provider: 'evil', availability: 'ready', canRunProbe: true},
    {id: 'a', provider: 'evil', availability: 'ready', canRunProbe: true}];
  await f.pelican.refresh(); assert.deepEqual(f.pelican.snapshot().accounts.map(item => item.id), ['a', 'b']);
  await run(f); assert.equal(f.calls[0].binding.providerId, 'cpa-codex-a');
});

test('refresh is single flight but a stop supersedes the preferences snapshot already in flight', async t => {
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.getPlans = prefs => {const copy = structuredClone(prefs); entered.resolve(); return gate.promise.then(() => copy);};
  const first = f.pelican.refresh(); assert.equal(f.pelican.refresh(), first); await entered.promise;
  await f.pelican.configure('a', {intervalMinutes: 0}); gate.resolve(); await first;
  assert.equal(state(f).intervalMinutes, 0); assert.equal(state(f).nextRunAt, null); assert.equal(f.calls.length, 0);
});

test('dispose aborts an uncooperative refresh before its registry promise completes', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.list = () => {entered.resolve(); return gate.promise;};
  const pending = assert.rejects(f.pelican.refresh(), fixedError('pelican-disposed'));
  await entered.promise; f.pelican.dispose(); await pending; assert.equal(f.clock.jobs.size, 0);
  gate.reject(new Error('PRIVATE-LATE-REGISTRY')); await flush(); assert.deepEqual(f.pelican.snapshot(), {accounts: []});
});

test('binding fields are immutable even if the source capture object changes during catalog validation', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers(); let firstRaw;
  f.behavior.capture = (id, provider, next) => {const raw = next(id, provider); if (!firstRaw) firstRaw = raw; return raw;};
  f.behavior.catalog = () => {entered.resolve(); return gate.promise;};
  const pending = f.pelican.run('a', {model: MODEL}); await entered.promise;
  firstRaw.accountId = 'b'; firstRaw.providerId = 'cpa-codex-b'; firstRaw.principalHash = 'principal-b'; firstRaw.email = 'b@example.invalid';
  gate.resolve([{id: MODEL, provider: 'cpa-codex-a'}]); await pending; await flush();
  assert.equal(f.calls[0].binding.accountId, 'a'); assert.equal(f.calls[0].binding.principalHash, 'principal-a');
  assert.equal(f.calls[0].request.accountEmail, 'a@example.invalid'); assert.equal(state(f, 'a').historyCount, 1); assert.equal(state(f, 'b').historyCount, 0);
});

test('late renderer rejection after cancel is observed and cannot overwrite a newer success', async t => {
  const f = await fixture(t), gate = Promise.withResolvers(); let first = true;
  f.behavior.render = () => {if (first) {first = false; return gate.promise;} return PNG;};
  await f.pelican.run('a', {model: MODEL}); await flush(); f.pelican.cancel('a'); await run(f);
  gate.reject(new Error('PRIVATE-LATE-IMAGE-ERROR')); await flush();
  assert.equal(state(f).historyCount, 1); assert.equal(state(f).lastError, null);
});

test('single-enabled pause is synchronous even while an earlier refresh is still blocked', async t => {
  let active = 'a'; const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: MODEL}, b: {intervalMinutes: 10, model: MODEL}},
    config: {isEnabled: id => id === active}});
  await run(f); const image = f.pelican.history('a').images[0].id, imageGate = Promise.withResolvers();
  f.behavior.render = () => imageGate.promise; await f.pelican.run('a', {model: MODEL}); await flush();
  const prefsGate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.getPlans = prefs => {const copy = structuredClone(prefs); entered.resolve(); return prefsGate.promise.then(() => copy);};
  const first = f.pelican.refresh(); await entered.promise; active = 'b'; const second = f.pelican.refresh();
  assert.equal(first, second); assert.equal(f.rendered.at(-1).input.signal.aborted, true);
  assert.equal(state(f, 'a').running, false); assert.ok(f.pelican.image('a', image));
  prefsGate.resolve(); await first; imageGate.resolve(PNG); await flush();
  assert.equal(state(f, 'a').historyCount, 1); assert.equal(state(f, 'b').nextRunAt, f.clock.iso(600000));
});

test('a transport prepared before switching is aborted before its deferred wire-send boundary', async t => {
  let active = 'a', wireSends = 0; const f = await fixture(t, {config: {isEnabled: id => id === active}});
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.behavior.stream = (id, request) => (async function* () {
    entered.resolve(); await gate.promise; request.signal.throwIfAborted(); wireSends++; yield text(SVG); yield stop;
  })();
  await f.pelican.run('a', {model: MODEL}); await entered.promise;
  active = 'b'; await f.pelican.refresh(); assert.equal(f.calls[0].request.signal.aborted, true);
  gate.resolve(); await flush(); assert.equal(wireSends, 0); assert.equal(state(f, 'a').historyCount, 0);
  delete f.behavior.stream; await run(f, 'b'); assert.equal(state(f, 'b').historyCount, 1);
});

test('identity revocation clears only that account history even while it is inactive', async t => {
  let active = 'a'; const f = await fixture(t, {config: {isEnabled: id => id === active}});
  await run(f, 'a'); active = 'b'; await f.pelican.refresh(); await run(f, 'b');
  const b = f.pelican.history('b').images[0].id; assert.equal(f.pelican.history('a').images.length, 1);
  f.records.get('a').life.abort(); assert.equal(f.pelican.history('a').images.length, 0);
  assert.ok(f.pelican.image('b', b)); assert.equal(state(f, 'b').available, true);
});

test('stream event count is bounded even if all chunks contain no output bytes', async t => {
  let count = 0;
  const f = await fixture(t, {stream: () => ({[Symbol.asyncIterator]() {return this;},
    async next() {count++; return {done: false, value: {type: 'usage', usage: {}}};}, async return() {return {done: true};}})});
  await run(f); assert.equal(count, 100001); assert.equal(state(f).lastError, 'pelican-output-limit'); assert.equal(state(f).historyCount, 0);
});

test('identity listeners remain bounded across completed/cancelled rounds and are removed on dispose', async t => {
  const f = await fixture(t), signal = f.records.get('a').life.signal;
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  const gate = Promise.withResolvers(); f.behavior.render = () => gate.promise;
  await f.pelican.run('a', {model: MODEL}); await flush(); assert.equal(getEventListeners(signal, 'abort').length, 2);
  f.pelican.cancel('a'); assert.equal(getEventListeners(signal, 'abort').length, 1);
  delete f.behavior.render; await run(f); assert.equal(getEventListeners(signal, 'abort').length, 1);
  f.pelican.dispose(); assert.equal(getEventListeners(signal, 'abort').length, 0); gate.resolve(PNG); await flush();
});

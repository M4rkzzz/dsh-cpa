import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLogStore} from '../lib/log-store-v026.mjs';
import {createTelemetry} from '../lib/telemetry-v026.mjs';
import {createEvidence, attachEvidence} from '../lib/evidence-v026.mjs';

const errorCode = code => error => error?.code === code && error.message === code;
const row = (number = 0, extra = {}) => ({startedAt: '2026-11-08T10:00:00.000Z',
  provider: 'openai-codex', model: 'gpt-5', accountId: 'account-a', accountEmail: 'synthetic@example.invalid',
  source: 'conversation', status: 'success', finishReason: 'stop', errorCode: null, httpStatus: 200,
  usageEvidence: 'provider', inputTokens: 100, outputTokens: number, cacheReadTokens: 20, cacheWriteTokens: null,
  cacheHitRate: 0.2, ttftMs: 20, durationMs: 100, decodeMs: 80, timingOutputTokens: number, tps: number / .08,
  timingVersion: 2, timingSource: 'stream-observer', priceBasis: 'openai-standard-reference',
  priceModel: 'gpt-5', costBasis: 'estimate', estimatedCostUsd: 0.001, serviceTierRequested: 'priority',
  serviceTierReported: null, ...extra});
const fileFor = root => path.join(root, '.dsh-cpa', 'activity.ndjson');
const collect = async stream => {
  const result = [];
  for await (const bytes of stream) {
    assert.ok(bytes instanceof Uint8Array);
    for (const line of Buffer.from(bytes).toString('utf8').trim().split('\n')) if (line) result.push(JSON.parse(line));
  }
  return result;
};
async function temporary(t, beforeRemove = async () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cpa-log-test-'));
  t.after(async () => {
    await beforeRemove();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-cpa-log-test-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}
async function fixture(t, options = {}) {
  const stores = [];
  const root = await temporary(t, async () => { for (const item of stores) { try { await item.dispose(); } catch {} } });
  const open = (overrides = {}) => {
    const store = createLogStore({profileDir: root, ...options, ...overrides});
    stores.push(store); return store;
  };
  const store = open();
  await store.ready;
  return {root, file: fileFor(root), store, open};
}
function instrument({read, write, truncate, sync} = {}) {
  return {...fs, readFile() { throw new Error('whole-file-read-is-forbidden'); },
    async open(...args) {
      const handle = await fs.open(...args);
      return new Proxy(handle, {get(target, key) {
        const fn = target[key];
        if (typeof fn !== 'function') return fn;
        const hook = {read, write, truncate, sync}[key];
        return hook ? (...values) => hook(target, values) : fn.bind(target);
      }});
    }};
}
function gate() {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let enabled = false, used = false;
  return {entered: entered.promise, release: release.resolve,
    enable() { enabled = true; },
    async wait() {
      if (enabled && !used) { used = true; entered.resolve(); await release.promise; }
    }};
}
async function writeHistory(file, base, count, change = number => ({outputTokens: number})) {
  const handle = await fs.open(file, 'w');
  try {
    for (let i = 0; i < count; i++) await handle.write(JSON.stringify({...base,
      id: 'cpa-log-' + randomUUID(), ...change(i)}) + '\n');
  } finally { await handle.close(); }
}
async function normalizedSeed(t, options = {}) {
  const f = await fixture(t, options);
  await f.store.append(row());
  const base = (await f.store.page()).entries[0];
  await f.store.dispose();
  return {...f, base};
}

test('requires an explicit absolute profile and bounds all buffer/page options', () => {
  for (const profileDir of [undefined, null, '', '.', 'relative/profile', false, '/bad\0name']) {
    assert.throws(() => createLogStore({profileDir}), errorCode('invalid-log-profile-dir'));
  }
  for (const options of [{pageSize: 51}, {pageSize: 0}, {blockSize: 0}, {maxRowBytes: 1},
    {maxPending: Infinity}, {maxReaders: -1}]) {
    assert.throws(() => createLogStore({profileDir: path.resolve(os.tmpdir()), ...options}), errorCode('invalid-log-store-options'));
  }
});

test('creates only the fixed regular file and detached constant-size summary', async t => {
  const f = await fixture(t);
  assert.deepEqual(await fs.readdir(f.root), ['.dsh-cpa']);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['activity.ndjson']);
  assert.equal((await fs.lstat(f.file)).isFile(), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.dirname(f.file))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  }
  const snapshot = f.store.snapshot();
  assert.deepEqual(snapshot.storage, {available: true, error: null});
  assert.equal(snapshot.summary.total, 0);
  assert.equal(snapshot.summary.avgTtftMs, null);
  assert.equal(snapshot.summary.inputTokens, 0);
  snapshot.summary.total = 99; snapshot.summary.samples.inputTokens = 99;
  assert.equal(f.store.snapshot().summary.total, 0);
  assert.equal(f.store.snapshot().summary.samples.inputTokens, 0);
  assert.deepEqual((await f.store.page()).entries, []);
});

test('terminal whitelist drops secrets, bodies, timestamps, unsafe enums and accessors', async t => {
  const f = await fixture(t);
  let getters = 0;
  const privateData = 'NEVER-PERSIST-SYNTHETIC-SECRET';
  const input = row(5, {id: privateData, endedAt: privateData, prompt: privateData, body: privateData,
    headers: {authorization: privateData}, response: privateData, svg: '<svg>' + privateData,
    png: new Uint8Array([1, 2]), credentials: privateData, rawError: new Error(privateData),
    errorCode: privateData, finishReason: privateData, serviceTierReported: privateData,
    accountEmail: '合成@example.invalid', toJSON() { throw new Error('must-not-stringify-input'); }});
  Object.defineProperty(input, 'messages', {get() { getters++; throw new Error(privateData); }});
  Object.defineProperty(input, 'ttftMs', {get() { getters++; throw new Error(privateData); }});
  Object.defineProperty(input, 'unknownHuge', {value: 'x'.repeat(1024 * 1024)});
  await f.store.append(input);
  const text = await fs.readFile(f.file, 'utf8'), saved = JSON.parse(text);
  assert.equal(getters, 0);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes(privateData));
  assert.ok(text.length < 4096);
  assert.match(saved.id, /^cpa-log-[0-9a-f-]{36}$/);
  assert.equal(saved.startedAt, input.startedAt);
  assert.equal(saved.accountEmail, '合成@example.invalid');
  for (const key of ['endedAt', 'prompt', 'body', 'headers', 'response', 'svg', 'png', 'credentials', 'rawError', 'messages', 'unknownHuge']) {
    assert.equal(Object.hasOwn(saved, key), false);
  }
  assert.equal(saved.ttftMs, null); assert.equal(saved.errorCode, null); assert.equal(saved.finishReason, null);
  assert.equal(saved.serviceTierRequested, 'priority'); assert.equal(saved.serviceTierReported, null);
  assert.deepEqual((await f.store.page()).entries, [saved]);
});

test('rejects nonterminal rows and never coerces malformed metrics into known zero', async t => {
  const f = await fixture(t);
  for (const input of [null, {}, row(0, {status: 'running'}), row(0, {status: 'complete'})]) {
    await assert.rejects(f.store.append(input), errorCode('log-store-invalid-row'));
  }
  for (const value of [null, '', false, [], '0', -1, NaN, Infinity, 0.5]) {
    await f.store.append(row(0, {inputTokens: value, cacheReadTokens: value,
      httpStatus: value, startedAt: 'not-a-start-time', estimatedCostUsd: value,
      usageEvidence: 'unavailable'}));
  }
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.summary.inputTokens, null);
  assert.equal(snapshot.summary.samples.inputTokens, 0);
  assert.equal(snapshot.summary.unpricedRequests, 9);
  for (const saved of (await f.store.page()).entries) {
    assert.equal(saved.inputTokens, null); assert.equal(saved.cacheReadTokens, null);
    assert.equal(saved.httpStatus, null); assert.equal(saved.startedAt, null); assert.equal(saved.estimatedCostUsd, null);
  }
});

test('captures detached data at append call and preserves serialization order', async t => {
  const pause = gate(), io = instrument({async write(handle, args) { await pause.wait(); return handle.write(...args); }});
  const f = await fixture(t, {fs: io}); pause.enable();
  const input = row(1), first = f.store.append(input);
  await pause.entered;
  input.outputTokens = 999; input.model = 'mutated-model';
  const second = f.store.append(row(2));
  pause.release(); await first; await second;
  const result = (await f.store.page()).entries;
  assert.deepEqual(result.map(item => item.outputTokens), [2, 1]);
  assert.equal(result[1].model, 'gpt-5');
});

test('summary preserves known zero, unknown samples, cache totals and restart arithmetic', async t => {
  const f = await fixture(t);
  await f.store.append(row(0, {inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    outputTokens: null, estimatedCostUsd: null, ttftMs: null, tps: null, durationMs: null, decodeMs: null, timingOutputTokens: null, cacheHitRate: null}));
  assert.equal(f.store.snapshot().summary.inputTokens, null);
  await f.store.append(row(0, {inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0,
    durationMs: 0, ttftMs: 0, decodeMs: 0, tps: null, cacheHitRate: null}));
  await f.store.append(row(20, {costBasis: 'upper-bound', status: 'error', errorCode: 'RATE_LIMIT'}));
  const s = f.store.snapshot().summary;
  assert.equal(s.total, 3); assert.equal(s.running, 0); assert.equal(s.error, 1); assert.equal(s.success, 2);
  assert.equal(s.inputTokens, 100); assert.equal(s.samples.inputTokens, 2);
  assert.equal(s.outputTokens, 20); assert.equal(s.samples.outputTokens, 2);
  assert.equal(s.cacheReadTokens, 20); assert.equal(s.samples.cacheReadTokens, 2);
  assert.equal(s.cacheWriteTokens, 0); assert.equal(s.samples.cacheWriteTokens, 1);
  assert.equal(s.pricedRequests, 2); assert.equal(s.unpricedRequests, 1); assert.equal(s.upperBoundRequests, 1);
  assert.equal(s.avgTtftMs, 10); assert.equal(s.avgDurationMs, 50); assert.equal(s.avgTps, 250);
  await f.store.dispose();
  const restored = f.open(); await restored.ready;
  assert.deepEqual(restored.snapshot().summary, s);
});

test('telemetry onRecord sink and provider evidence have exactly matching terminal summary', async t => {
  const f = await fixture(t);
  let hook;
  const telemetry = createTelemetry({on(name, listener) { assert.equal(name, 'llm/stream'); hook = listener; return () => {}; }},
    {onRecord: item => f.store.append(item), now: () => 10, dateNow: () => 0});
  t.after(() => telemetry.dispose());
  const run = async chunks => { for await (const chunk of hook({provider: 'openai-codex', model: 'gpt-5'},
    () => (async function* () { yield* chunks; })())) {} };
  await run([{type: 'usage', usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}}, {type: 'finish', reason: {kind: 'stop'}}]);
  for (const tokens of [0, 100]) {
    const audit = createEvidence({accountId: 'account-a', accountEmail: 'synthetic@example.invalid', serviceTierRequested: 'priority'});
    audit.onHttpStatus(200);
    audit.onRawEvent({type: 'response.completed', response: {service_tier: 'default',
      usage: {input_tokens: tokens, output_tokens: tokens, total_tokens: tokens * 2, input_tokens_details: {cached_tokens: 0}}}});
    await run([attachEvidence({type: 'usage', usage: {inputTokens: 999, outputTokens: 999}}, audit),
      attachEvidence({type: 'finish', reason: {kind: 'stop'}}, audit)]);
  }
  await run([{type: 'finish', reason: {kind: 'error', failure: {code: 'AUTH'}}}]);
  await f.store.page(); // A barrier for synchronous onRecord calls, not a model-stream wait.
  assert.deepEqual(f.store.snapshot().summary, telemetry.snapshot().summary);
  const saved = (await f.store.page()).entries;
  assert.deepEqual(Object.keys(saved[0]).sort(), Object.keys(telemetry.snapshot().entries[0]).sort());
  assert.equal(saved[0].errorCode, 'AUTH'); assert.equal(saved[0].httpStatus, null);
  assert.equal(saved[1].serviceTierRequested, 'priority'); assert.equal(saved[1].serviceTierReported, 'default');
  assert.equal(saved[3].inputTokens, null); assert.equal(saved[3].estimatedCostUsd, null);
});

test('has no 200-row retention cap; every page survives flush and restart', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 275; i++) await f.store.append(row(i));
  const before = f.store.snapshot().summary;
  assert.equal(before.total, 275);
  const values = [], ids = new Set();
  let cursor = null;
  do {
    const result = await f.store.page({cursor});
    assert.ok(result.entries.length <= 50);
    for (const item of result.entries) { values.push(item.outputTokens); ids.add(item.id); }
    cursor = result.page.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 275);
  assert.deepEqual(values, Array.from({length: 275}, (_, i) => 274 - i));
  await f.store.dispose(); const restored = f.open(); await restored.ready;
  assert.deepEqual(restored.snapshot().summary, before);
  assert.equal((await collect(restored.export())).length, 275);
});

test('signed cursor binds a stable end snapshot, filters and server lifetime', async t => {
  const f = await normalizedSeed(t);
  await writeHistory(f.file, f.base, 150, i => i % 2 === 0 ? {outputTokens: i, status: 'error',
    source: 'pelican', model: 'gpt-5', accountId: 'target'} : {outputTokens: i, status: 'success',
    source: 'conversation', model: 'gpt-5-mini', accountId: 'other'});
  const store = f.open(); await store.ready;
  const filters = {status: 'error', source: 'pelican', model: 'gpt-5', accountId: 'target'};
  const first = await store.page(filters);
  assert.equal(first.entries.length, 50); assert.equal(first.entries[0].outputTokens, 148);
  assert.ok(first.page.nextCursor);
  await store.append(row(999, filters));
  const second = await store.page({...filters, cursor: first.page.nextCursor});
  assert.equal(second.entries.length, 25); assert.equal(second.page.nextCursor, null);
  assert.deepEqual([...first.entries, ...second.entries].map(item => item.outputTokens),
    Array.from({length: 75}, (_, i) => 148 - i * 2));
  assert.equal((await store.page(filters)).entries[0].outputTokens, 999);
  await assert.rejects(store.page({...filters, model: 'gpt-5-mini', cursor: first.page.nextCursor}), errorCode('log-store-invalid-cursor'));
  await store.dispose(); const restarted = f.open(); await restarted.ready;
  await assert.rejects(restarted.page({...filters, cursor: first.page.nextCursor}), errorCode('log-store-invalid-cursor'));
});

test('malformed cursor/filter inputs have fixed safe errors and strict page limits', async t => {
  const f = await fixture(t, {pageSize: 1});
  await f.store.append(row(1)); await f.store.append(row(2));
  const cursor = (await f.store.page()).page.nextCursor;
  for (const value of ['secret-path', 'x'.repeat(10000), {}, 1, 'e30.' + 'A'.repeat(43), cursor.slice(0, -3) + 'AAA']) {
    await assert.rejects(f.store.page({cursor: value}), errorCode('log-store-invalid-cursor'));
  }
  for (const input of [{status: 'failed'}, {source: 'secret'}, {model: '../bad?secret'}, {accountId: 'x/y'},
    {limit: 51}, {limit: 0}, {limit: '50'}, {limit: 1.5}]) {
    await assert.rejects(f.store.page(input), errorCode('log-store-invalid-filter'));
  }
  await f.store.clear();
  await assert.rejects(f.store.page({cursor}), errorCode('log-store-invalid-cursor'));
});

test('manual clear truncates the same inode and makes only the new generation visible', async t => {
  const f = await fixture(t);
  await f.store.append(row(1)); const before = await fs.stat(f.file);
  await f.store.clear(); const after = await fs.stat(f.file);
  assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.size, 0);
  assert.equal(f.store.snapshot().summary.total, 0);
  assert.deepEqual(f.store.snapshot().storage, {available: true, error: null});
  await f.store.append(row(2));
  assert.deepEqual((await f.store.page()).entries.map(item => item.outputTokens), [2]);
});

test('corrupt rows and valid-looking torn tail are never committed by a later append', async t => {
  const f = await normalizedSeed(t);
  const good = JSON.stringify(f.base), torn = JSON.stringify({...f.base, id: 'cpa-log-' + randomUUID(), outputTokens: 777});
  const prefix = good + '\nnot-json\n{}\n' + torn;
  await fs.writeFile(f.file, prefix);
  const store = f.open(); await store.ready;
  assert.equal(store.snapshot().summary.total, 1);
  assert.deepEqual(store.snapshot().storage, {available: true, error: 'log-storage-corrupt'});
  assert.equal((await store.page()).entries.length, 1); assert.equal((await collect(store.export())).length, 1);
  await store.append(row(2));
  const contents = await fs.readFile(f.file, 'utf8');
  assert.ok(contents.startsWith(prefix + '\0\n')); // Tail is preserved, not silently truncated.
  assert.equal(store.snapshot().summary.total, 2);
  assert.deepEqual((await store.page()).entries.map(item => item.outputTokens), [2, 0]);
  await store.dispose(); const restored = f.open(); await restored.ready;
  assert.equal(restored.snapshot().summary.total, 2);
  assert.equal(restored.snapshot().storage.error, 'log-storage-corrupt');
  await restored.clear(); assert.equal(restored.snapshot().storage.error, null);
});

test('multi-megabyte invalid rows use bounded fs reads during startup, reverse pages and export', async t => {
  const f = await normalizedSeed(t);
  const handle = await fs.open(f.file, 'w');
  const large = Buffer.alloc(64 * 1024, 120);
  try {
    await handle.write(JSON.stringify(f.base) + '\n');
    for (let i = 0; i < 64; i++) await handle.write(large);
    await handle.write('\n' + JSON.stringify({...f.base, id: 'cpa-log-' + randomUUID(), outputTokens: 2}) + '\n');
  } finally { await handle.close(); }
  let maxRead = 0, calls = 0;
  const io = instrument({async read(file, args) {
    maxRead = Math.max(maxRead, args[0].byteLength, args[2]); calls++; return file.read(...args);
  }});
  const store = f.open({fs: io, blockSize: 2048, maxRowBytes: 4096}); await store.ready;
  assert.ok(calls > 2048); assert.equal(maxRead, 2048);
  assert.equal(store.snapshot().summary.total, 2);
  assert.equal(store.snapshot().storage.error, 'log-storage-corrupt');
  assert.deepEqual((await store.page()).entries.map(item => item.outputTokens), [2, 0]);
  assert.deepEqual((await collect(store.export())).map(item => item.outputTokens), [0, 2]);
  assert.equal(maxRead, 2048);
});

test('reverse block scanning preserves multibyte identities and exact row boundaries', async t => {
  const f = await fixture(t, {blockSize: 13, pageSize: 1});
  await f.store.append(row(1, {accountEmail: '长名字@example.invalid'})); await f.store.append(row(2));
  const first = await f.store.page(), second = await f.store.page({cursor: first.page.nextCursor});
  assert.equal(first.entries[0].outputTokens, 2);
  assert.equal(second.entries[0].accountEmail, '长名字@example.invalid'); assert.equal(second.page.nextCursor, null);
});

test('export is lazy backpressured NDJSON, filtered and snapshot-stable without a full-history Blob', async t => {
  let reads = 0;
  const f = await fixture(t, {blockSize: 2048, fs: instrument({async read(handle, args) { reads++; return handle.read(...args); }})});
  for (let i = 0; i < 8; i++) await f.store.append(row(i, {source: i % 2 ? 'pelican' : 'conversation'}));
  reads = 0;
  const stream = f.store.export({source: 'pelican'});
  await f.store.append(row(99, {source: 'pelican'}));
  assert.equal(reads, 0);
  const reader = stream.getReader(), first = await reader.read();
  assert.ok(first.value instanceof Uint8Array); assert.ok(first.value.byteLength < 4096);
  assert.equal(JSON.parse(Buffer.from(first.value).toString()).outputTokens, 1);
  assert.ok(reads <= 2);
  const atFirst = reads;
  await Promise.resolve(); await Promise.resolve(); assert.equal(reads, atFirst);
  const values = [1];
  for (;;) { const next = await reader.read(); if (next.done) break; values.push(JSON.parse(Buffer.from(next.value).toString()).outputTokens); }
  assert.deepEqual(values, [1, 3, 5, 7]);
  const response = new Response(f.store.export({status: 'success', source: 'pelican'}));
  const ndjson = await response.text();
  assert.equal(ndjson.trim().split('\n').length, 5); assert.ok(ndjson.endsWith('\n'));
});



for (const stop of ['abort', 'cancel', 'clear', 'dispose']) {
  test('export ' + stop + ' keeps a blocked scanner charged until its read exits', async t => {
    const pause = gate(), readExited = Promise.withResolvers();
    let reads = 0;
    const f = await fixture(t, {maxReaders: 1, fs: instrument({async read(handle, args) {
      reads++; await pause.wait();
      try { return await handle.read(...args); }
      finally { readExited.resolve(); }
    }})});
    t.after(() => pause.release());
    await f.store.append(row(1)); pause.enable();
    const abort = new AbortController(), reader = f.store.export({}, {signal: abort.signal}).getReader();
    const pending = reader.read();
    const result = stop === 'cancel' ? pending : assert.rejects(pending, errorCode('log-store-' +
      (stop === 'abort' ? 'aborted' : stop === 'clear' ? 'cleared' : 'disposed')));
    await pause.entered;
    let stopping;
    if (stop === 'abort') abort.abort();
    else if (stop === 'cancel') stopping = reader.cancel();
    else stopping = f.store[stop]();
    await result;
    if (stop !== 'dispose') {
      for (let i = 0; i < 12; i++) {
        assert.throws(() => f.store.export(), errorCode('log-store-busy'));
        await assert.rejects(f.store.page(), errorCode('log-store-busy'));
      }
    }
    assert.equal(reads, 1);
    pause.release(); await readExited.promise; await stopping;
    // Drain continuations of the completed real read, not a wall-clock delay.
    await new Promise(resolve => setImmediate(resolve));
    if (stop !== 'dispose') {
      assert.equal((await f.store.page()).entries.length, stop === 'clear' ? 0 : 1);
      await f.store.export().cancel();
      assert.equal(f.store.snapshot().storage.available, true);
    }
  });
}

test('cancel stops a huge corrupt line after the in-flight block, with no further reads', async t => {
  const f = await normalizedSeed(t);
  await fs.writeFile(f.file, Buffer.concat([Buffer.alloc(4 * 1024 * 1024, 120), Buffer.from('\n')]));
  const pause = gate();
  let reads = 0, enabled = false;
  const store = f.open({maxReaders: 1, blockSize: 4096, fs: instrument({async read(handle, args) {
    if (enabled) reads++;
    await pause.wait(); return handle.read(...args);
  }})});
  await store.ready;
  t.after(() => pause.release());
  enabled = true; pause.enable();
  const reader = store.export().getReader(), pending = reader.read();
  await pause.entered;
  const cancelling = reader.cancel(new Error('PRIVATE-CANCEL-REASON'));
  assert.deepEqual(await pending, {value: undefined, done: true});
  await assert.rejects(store.page(), errorCode('log-store-busy'));
  pause.release(); await cancelling;
  assert.equal(reads, 1, 'cancel must not scan the remaining 4MiB invalid line');
  assert.equal(store.snapshot().storage.available, true);
  await store.export().cancel(); // Quota was returned only after scanner exit.
});

test('cancel before scanner creation releases quota and never starts a late scanner', async t => {
  for (const stage of ['barrier', 'verify']) {
    const pause = gate();
    let reads = 0;
    const io = instrument({async write(handle, args) {
      if (stage === 'barrier') await pause.wait();
      return handle.write(...args);
    }, async read(handle, args) { reads++; return handle.read(...args); }});
    const originalLstat = io.lstat;
    io.lstat = async (...args) => {
      if (stage === 'verify') await pause.wait();
      return originalLstat(...args);
    };
    const f = await fixture(t, {maxReaders: 1, fs: io});
    t.after(() => pause.release());
    await f.store.append(row(1)); pause.enable();
    const writing = stage === 'barrier' ? f.store.append(row(2)) : undefined;
    const reader = f.store.export().getReader(), pending = reader.read();
    await pause.entered;
    await reader.cancel();
    assert.deepEqual(await pending, {value: undefined, done: true});
    await f.store.export().cancel(); // Still-hung pre-scan work owns no buffers.
    pause.release(); await writing;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0, stage + ' must not resume a cancelled scanner');
    assert.equal((await f.store.page()).entries.length, stage === 'barrier' ? 2 : 1);
  }
});

test('export scanner and verification errors return the reader quota', async t => {
  let failRead = false, failVerify = false;
  const io = instrument({async read(handle, args) {
    if (failRead) throw new Error('PRIVATE-READ-FAILURE');
    return handle.read(...args);
  }});
  const originalLstat = io.lstat;
  io.lstat = async (...args) => {
    if (failVerify) throw new Error('PRIVATE-VERIFY-FAILURE');
    return originalLstat(...args);
  };
  const f = await fixture(t, {maxReaders: 1, fs: io});
  await f.store.append(row(1));
  for (const stage of ['read', 'verify']) {
    failRead = stage === 'read'; failVerify = stage === 'verify';
    await assert.rejects(collect(f.store.export()), errorCode('log-storage-unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    failRead = false; failVerify = false;
    await f.store.clear(); await f.store.append(row(1));
    assert.equal((await collect(f.store.export())).length, 1);
    assert.equal((await f.store.page()).entries.length, 1);
  }
});

test('idle exports and pending reads abort safely, without retaining reader slots', async t => {
  const f = await fixture(t, {maxReaders: 1}); await f.store.append(row(1));
  const abort = new AbortController(), stream = f.store.export({}, {signal: abort.signal}), reader = stream.getReader();
  await assert.rejects(f.store.page(), errorCode('log-store-busy'));
  abort.abort(new Error('PRIVATE-ABORT-REASON'));
  await assert.rejects(reader.read(), errorCode('log-store-aborted'));
  assert.equal((await f.store.page()).entries.length, 1);
  assert.throws(() => f.store.export({}, {signal: abort.signal}), errorCode('log-store-aborted'));
  const second = f.store.export().getReader(); await second.cancel();
  assert.equal((await f.store.page()).entries.length, 1);
  const idle = f.store.export().getReader(); await f.store.clear();
  await assert.rejects(idle.read(), errorCode('log-store-cleared'));
  assert.equal((await f.store.page()).entries.length, 0);
});

test('clear synchronously invalidates a page blocked in an actual filesystem read', async t => {
  const pause = gate(), io = instrument({async read(handle, args) { await pause.wait(); return handle.read(...args); }});
  const f = await fixture(t, {fs: io}); await f.store.append(row(1)); pause.enable();
  const result = assert.rejects(f.store.page(), errorCode('log-store-cleared'));
  await pause.entered; const clearing = f.store.clear();
  assert.equal(f.store.snapshot().summary.total, 0);
  pause.release(); await result; await clearing;
  await f.store.append(row(2));
  assert.deepEqual((await f.store.page()).entries.map(item => item.outputTokens), [2]);
  assert.equal(f.store.snapshot().storage.error, null);
});

test('clear invalidates active/queued appends but preserves post-clear writes in order', async t => {
  const pause = gate(), io = instrument({async write(handle, args) { await pause.wait(); return handle.write(...args); }});
  const f = await fixture(t, {fs: io}); pause.enable();
  const first = assert.rejects(f.store.append(row(1)), errorCode('log-store-cleared'));
  await pause.entered;
  const queued = assert.rejects(f.store.append(row(2)), errorCode('log-store-cleared'));
  const clearing = f.store.clear(), fresh = f.store.append(row(3));
  pause.release(); await first; await queued; await clearing; await fresh;
  assert.equal(f.store.snapshot().summary.total, 1);
  assert.deepEqual((await f.store.page()).entries.map(item => item.outputTokens), [3]);
  assert.deepEqual((await collect(f.store.export())).map(item => item.outputTokens), [3]);
});

test('clear during startup scan cannot resurrect old summary or tail records', async t => {
  const f = await normalizedSeed(t);
  const pause = gate(); pause.enable();
  const store = f.open({fs: instrument({async read(handle, args) { await pause.wait(); return handle.read(...args); }})});
  await pause.entered;
  const clearing = store.clear(), fresh = store.append(row(2));
  pause.release(); await store.ready; await clearing; await fresh;
  assert.equal(store.snapshot().summary.total, 1);
  assert.deepEqual((await store.page()).entries.map(item => item.outputTokens), [2]);
});

test('repeated clear coalesces safely even when an intermediate append was queued', async t => {
  const pause = gate(), io = instrument({async truncate(handle, args) { await pause.wait(); return handle.truncate(...args); }});
  const f = await fixture(t, {fs: io}); await f.store.append(row(1)); pause.enable();
  const first = f.store.clear(); await pause.entered;
  const old = assert.rejects(f.store.append(row(2)), errorCode('log-store-cleared'));
  const second = f.store.clear(); assert.equal(second, first);
  const fresh = f.store.append(row(3)); pause.release();
  await first; await second; await old; await fresh;
  assert.deepEqual((await f.store.page()).entries.map(item => item.outputTokens), [3]);
});

test('write queue is explicitly bounded with observable backpressure, not history eviction', async t => {
  const pause = gate(), io = instrument({async write(handle, args) { await pause.wait(); return handle.write(...args); }});
  const f = await fixture(t, {fs: io, maxPending: 2}); pause.enable();
  const first = f.store.append(row(1)); await pause.entered;
  const second = f.store.append(row(2));
  await assert.rejects(f.store.append(row(3)), errorCode('log-store-busy'));
  assert.deepEqual(f.store.snapshot().storage, {available: true, error: 'log-store-busy'});
  pause.release(); await first; await second;
  assert.equal(f.store.snapshot().summary.total, 2);
  assert.deepEqual((await f.store.page()).entries.map(item => item.outputTokens), [2, 1]);
  await f.store.clear(); assert.equal(f.store.snapshot().storage.error, null);
});

test('dispose flushes accepted writes, rejects new work and closes exports idempotently', async t => {
  const pause = gate(), io = instrument({async write(handle, args) { await pause.wait(); return handle.write(...args); }});
  const f = await fixture(t, {fs: io}); pause.enable();
  const first = f.store.append(row(1)); await pause.entered;
  const second = f.store.append(row(2)), reader = f.store.export().getReader();
  const disposing = f.store.dispose(); assert.equal(f.store.dispose(), disposing);
  await assert.rejects(f.store.append(row(3)), errorCode('log-store-disposed'));
  await assert.rejects(f.store.page(), errorCode('log-store-disposed'));
  await assert.rejects(reader.read(), errorCode('log-store-disposed'));
  pause.release(); await first; await second; await disposing;
  const restored = f.open(); await restored.ready;
  assert.equal(restored.snapshot().summary.total, 2);
  assert.deepEqual((await restored.page()).entries.map(item => item.outputTokens), [2, 1]);
});

test('unavailable root/storage resolves ready and exposes only fixed errors', async t => {
  const root = await temporary(t), nonexistent = path.join(root, 'PRIVATE-NONEXISTENT-PROFILE');
  const store = createLogStore({profileDir: nonexistent}); t.after(() => store.dispose());
  await store.ready;
  assert.deepEqual(store.snapshot().storage, {available: false, error: 'log-storage-unavailable'});
  assert.deepEqual((await store.page()).entries, []);
  await assert.rejects(store.append(row()), errorCode('log-storage-unavailable'));
  await assert.rejects(collect(store.export()), errorCode('log-storage-unavailable'));
  await assert.rejects(fs.stat(nonexistent), {code: 'ENOENT'});
});

test('filesystem write/read failures are sanitized even if their code starts with log-', async t => {
  let failWrite = false, failRead = false;
  const failure = () => Object.assign(new Error('PRIVATE-FILESYSTEM-PATH-AND-TOKEN'), {code: 'log-private-data'});
  const f = await fixture(t, {fs: instrument({async write(handle, args) {
    if (failWrite) throw failure(); return handle.write(...args);
  }, async read(handle, args) { if (failRead) throw failure(); return handle.read(...args); }})});
  failWrite = true;
  await assert.rejects(f.store.append(row(1)), errorCode('log-storage-unavailable'));
  assert.deepEqual(f.store.snapshot().storage, {available: false, error: 'log-storage-unavailable'});
  failWrite = false; await f.store.clear(); await f.store.append(row(2));
  failRead = true;
  await assert.rejects(f.store.page(), errorCode('log-storage-unavailable'));
  assert.equal(f.store.snapshot().storage.error, 'log-storage-unavailable');
  failRead = false; await f.store.clear(); assert.equal(f.store.snapshot().storage.error, null);
});

test('short filesystem writes are retried and a failed partial row is quarantined on restart', async t => {
  let calls = 0, failAfterFirst = false;
  const io = instrument({async write(handle, [bytes, offset, length]) {
    calls++;
    if (failAfterFirst && calls > 1) throw new Error('PRIVATE-DISK-FAILURE');
    return handle.write(bytes, offset, Math.min(7, length));
  }});
  const f = await fixture(t, {fs: io});
  await f.store.append(row(1)); assert.ok(calls > 1);
  assert.equal((await f.store.page()).entries[0].outputTokens, 1);
  calls = 0; failAfterFirst = true;
  await assert.rejects(f.store.append(row(2)), errorCode('log-storage-unavailable'));
  await f.store.dispose(); const restored = f.open({fs}); await restored.ready;
  assert.equal(restored.snapshot().summary.total, 1);
  assert.equal(restored.snapshot().storage.error, 'log-storage-corrupt');
  await restored.append(row(3));
  assert.deepEqual((await restored.page()).entries.map(item => item.outputTokens), [3, 1]);
  await restored.dispose(); const again = f.open({fs}); await again.ready;
  assert.equal(again.snapshot().summary.total, 2);
});

test('rejects symlink/junction log directories without creating or modifying external files', async t => {
  const root = await temporary(t), outside = await temporary(t), link = path.join(root, '.dsh-cpa');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  const store = createLogStore({profileDir: root});
  t.after(() => store.dispose());
  await store.ready;
  assert.deepEqual(store.snapshot().storage, {available: false, error: 'log-storage-unavailable'});
  await assert.rejects(store.append(row()), errorCode('log-storage-unavailable'));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('rejects hardlinked external log files', async t => {
  const root = await temporary(t), outside = await temporary(t), external = path.join(outside, 'external.ndjson');
  await fs.mkdir(path.join(root, '.dsh-cpa')); await fs.writeFile(external, 'EXTERNAL-DO-NOT-TOUCH');
  await fs.link(external, fileFor(root));
  const store = createLogStore({profileDir: root}); t.after(() => store.dispose()); await store.ready;
  assert.equal(store.snapshot().storage.available, false);
  await assert.rejects(store.clear(), errorCode('log-storage-unavailable'));
  assert.equal(await fs.readFile(external, 'utf8'), 'EXTERNAL-DO-NOT-TOUCH');
});

test('rejects a replaced pathname rather than appending or clearing another file', async t => {
  const f = await fixture(t); await f.store.append(row(1));
  const moved = path.join(f.root, '.dsh-cpa', 'original.ndjson');
  await fs.rename(f.file, moved); await fs.writeFile(f.file, 'REPLACEMENT-DO-NOT-TOUCH');
  await assert.rejects(f.store.append(row(2)), errorCode('log-storage-unavailable'));
  await assert.rejects(f.store.clear(), errorCode('log-storage-unavailable'));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'REPLACEMENT-DO-NOT-TOUCH');
  assert.equal(JSON.parse(await fs.readFile(moved, 'utf8')).outputTokens, 1);
});

test('canonicalizes real tempdir aliases before pinning paths, including Windows 8.3 names', async t => {
  const f = await fixture(t), canonical = await fs.realpath(f.root);
  assert.equal((await fs.stat(canonical)).ino, (await fs.stat(f.root)).ino);
  assert.equal(f.store.snapshot().storage.available, true);
  await f.store.append(row(1)); await f.store.dispose();
  const restored = f.open({profileDir: canonical}); await restored.ready;
  assert.deepEqual(restored.snapshot().storage, {available: true, error: null});
  assert.equal((await restored.page()).entries[0].outputTokens, 1);
  await restored.clear(); assert.equal((await fs.stat(f.file)).size, 0);
});

test('rejects actual symlink roots and linked ancestors instead of treating them as aliases', async t => {
  const root = await temporary(t), target = await temporary(t), link = path.join(root, 'profile-alias');
  await fs.mkdir(path.join(target, 'child'));
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  for (const profileDir of [link, path.join(link, 'child')]) {
    const store = createLogStore({profileDir}); await store.ready;
    assert.deepEqual(store.snapshot().storage, {available: false, error: 'log-storage-unavailable'});
    await store.dispose();
  }
  assert.deepEqual(await fs.readdir(target), ['child']); assert.deepEqual(await fs.readdir(path.join(target, 'child')), []);
});

test('running is an empty persistent filter and accepts a reduced first-page limit', async t => {
  const f = await fixture(t); await f.store.append(row(1)); await f.store.append(row(2));
  assert.deepEqual((await f.store.page({status: 'running', limit: 1})).entries, []);
  assert.deepEqual(await collect(f.store.export({status: 'running'})), []);
  const first = await f.store.page({limit: 1});
  assert.equal(first.entries.length, 1); assert.ok(first.page.nextCursor);
  assert.equal((await f.store.page({cursor: first.page.nextCursor, limit: 1})).entries[0].outputTokens, 1);
  assert.equal(f.store.snapshot().summary.total, 2);
});

test('clear errors an export blocked in filesystem read before any old bytes can escape', async t => {
  const pause = gate(), io = instrument({async read(handle, args) { await pause.wait(); return handle.read(...args); }});
  const f = await fixture(t, {fs: io}); await f.store.append(row(1)); pause.enable();
  const reader = f.store.export().getReader();
  const result = assert.rejects(reader.read(), errorCode('log-store-cleared'));
  await pause.entered; const clearing = f.store.clear(); await result;
  pause.release(); await clearing;
  await f.store.append(row(2));
  assert.deepEqual((await collect(f.store.export())).map(item => item.outputTokens), [2]);
});

test('abort errors an active export with a fixed code without disabling healthy storage', async t => {
  const pause = gate(), io = instrument({async read(handle, args) { await pause.wait(); return handle.read(...args); }});
  const f = await fixture(t, {fs: io}); await f.store.append(row(1)); pause.enable();
  const abort = new AbortController(), reader = f.store.export({}, {signal: abort.signal}).getReader();
  const result = assert.rejects(reader.read(), errorCode('log-store-aborted'));
  await pause.entered; abort.abort(new Error('PRIVATE-SIGNAL-REASON')); await result; pause.release();
  assert.equal(f.store.snapshot().storage.available, true);
  assert.equal((await f.store.page()).entries.length, 1);
});

test('keeps all recognized public SDK error enums while rejecting raw provider error text', async t => {
  const f = await fixture(t), codes = ['MISSING_CREDENTIAL', 'ACCOUNT_QUOTA', 'INVALID_ARGS', 'UNKNOWN_MODEL',
    'UNSUPPORTED_OPTION', 'UNSUPPORTED_CONTENT', 'INVALID_REPLAY_STATE', 'REQUEST_HEADERS',
    'NO_CREDENTIAL_STORE', 'UNSTORABLE_PROVIDER_ID', 'DISCOVERY_FAILED', 'DISCOVERY_UNSUPPORTED'];
  for (const code of codes) await f.store.append(row(0, {status: 'error', errorCode: code}));
  assert.deepEqual((await f.store.page()).entries.map(item => item.errorCode), [...codes].reverse());
});

test('skips invalid UTF-8 and sanitizes even syntactically valid externally altered rows', async t => {
  const f = await normalizedSeed(t);
  const changed = {...f.base, body: 'PRIVATE-EXTERNAL-BODY', endedAt: 'PRIVATE-END', headers: {cookie: 'PRIVATE-COOKIE'}};
  const invalid = Buffer.concat([Buffer.from(JSON.stringify({...f.base, id: 'cpa-log-' + randomUUID()}).slice(0, -1) + ',"extra":"'),
    Buffer.from([0xff]), Buffer.from('"}\n')]);
  await fs.writeFile(f.file, Buffer.concat([Buffer.from(JSON.stringify(changed) + '\n'), invalid]));
  const store = f.open(); await store.ready;
  assert.equal(store.snapshot().summary.total, 1); assert.equal(store.snapshot().storage.error, 'log-storage-corrupt');
  const saved = await collect(store.export()); assert.equal(saved.length, 1);
  assert.equal(Object.hasOwn(saved[0], 'body'), false); assert.equal(Object.hasOwn(saved[0], 'endedAt'), false);
  assert.equal(Object.hasOwn(saved[0], 'headers'), false);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE-'));
});

test('empty-file clear works without replacing its inode on Windows append handles', async t => {
  const f = await fixture(t), before = await fs.stat(f.file);
  await f.store.clear(); await f.store.clear();
  assert.equal((await fs.stat(f.file)).ino, before.ino);
  assert.equal(f.store.snapshot().storage.available, true);
  await f.store.append(row(1)); assert.equal(f.store.snapshot().summary.total, 1);
});


test('persists only bounded tier provenance enums and keeps legacy missing provenance unknown',async t=>{
 const f=await fixture(t);
 await f.store.append(row(0,{serviceTierSent:'priority',serviceTierSentState:'value',serviceTierReported:null,serviceTierReportedState:'missing',serviceTierReportedSource:'response.completed'}));
 await f.store.append(row(1,{serviceTierSent:'PRIVATE-TIER',serviceTierSentState:'PRIVATE-STATE',serviceTierReportedState:'PRIVATE-STATE',serviceTierReportedSource:'PRIVATE-RAW-EVENT'}));
 const saved=(await f.store.page()).entries;
 assert.equal(saved[1].serviceTierSent,'priority');assert.equal(saved[1].serviceTierSentState,'value');assert.equal(saved[1].serviceTierReportedState,'missing');assert.equal(saved[1].serviceTierReportedSource,'response.completed');
 for(const field of ['serviceTierSent','serviceTierSentState','serviceTierReportedState','serviceTierReportedSource'])assert.equal(saved[0][field],null);
 assert.equal(JSON.stringify(saved).includes('PRIVATE-'),false);
});


test('persistent TPS is sum decode output divided by sum decode time, not mean of per-row speeds',async t=>{
 const f=await fixture(t);
 await f.store.append(row(100,{timingSource:'dsh-session',ttftMs:200,durationMs:1200,decodeMs:1000,timingOutputTokens:100,tps:999999}));
 await f.store.append(row(100,{timingSource:'dsh-session',ttftMs:200,durationMs:10200,decodeMs:10000,timingOutputTokens:100,tps:999999}));
 const page=await f.store.page();assert.deepEqual(page.entries.map(r=>r.tps),[10,100]);assert.equal(f.store.snapshot().summary.avgTps,200/11);assert.equal(f.store.snapshot().summary.samples.tps,2);
 await f.store.dispose();const reopened=f.open();await reopened.ready;assert.equal(reopened.snapshot().summary.avgTps,200/11);
});
test('zero decode pairs follow native DSH totals but never invent an individual infinite speed',async t=>{
 const f=await fixture(t);
 await f.store.append(row(100,{ttftMs:200,durationMs:200,decodeMs:0,timingOutputTokens:100}));
 assert.equal((await f.store.page()).entries[0].tps,null);assert.equal(f.store.snapshot().summary.avgTps,null);
 await f.store.append(row(100,{ttftMs:200,durationMs:1200,decodeMs:1000,timingOutputTokens:100}));
 assert.equal(f.store.snapshot().summary.avgTps,200);assert.equal(f.store.snapshot().summary.samples.tps,2);
});
test('legacy disk timings are unknown without rewriting or fabricating native history',async t=>{
 const f=await fixture(t);await f.store.append(row(100));await f.store.dispose();
 const old=JSON.parse((await fs.readFile(f.file,'utf8')).trim());for(const key of ['timingVersion','timingSource','decodeMs','timingOutputTokens'])delete old[key];old.ttftMs=1;old.durationMs=2;old.tps=100000;
 const original=JSON.stringify(old)+'\n';await fs.writeFile(f.file,original);const restored=f.open();await restored.ready;
 const saved=(await restored.page()).entries[0];assert.equal(saved.timingSource,'legacy');assert.equal(saved.timingVersion,null);
 for(const key of ['ttftMs','durationMs','decodeMs','timingOutputTokens','tps'])assert.equal(saved[key],null);
 assert.equal(restored.snapshot().summary.avgTps,null);assert.equal(saved.outputTokens,100);assert.equal(await fs.readFile(f.file,'utf8'),original);
});
test('timing provenance ignores unsafe versions and unknown sources without accepting injected speed',async t=>{
 const f=await fixture(t);
 for(const extra of [{timingVersion:'2'},{timingVersion:3},{timingSource:'PRIVATE-TIMING'},{timingSource:'unavailable'},{ttftMs:null}])await f.store.append(row(100,{tps:999999,...extra}));
 const entries=(await f.store.page()).entries;for(const r of entries)assert.equal(r.tps,null);assert.equal(JSON.stringify(entries).includes('PRIVATE-TIMING'),false);assert.equal(f.store.snapshot().summary.avgTps,null);
});

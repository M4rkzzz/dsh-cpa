import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import {extractServiceTierSent, TIER_WIRE_MAX_BYTES} from '../lib/tier-wire-v0210.mjs';

const proof = (state, tier = null) => ({tier, state});
const json = tier => JSON.stringify({service_tier: tier, input: 'synthetic only'});
const priority = json('priority');
const padded = size => {
  const start = '{"service_tier":"priority","padding":"', end = '"}';
  return start + 'x'.repeat(size - start.length - end.length) + end;
};

test('final string bodies yield only safe tier scalars, not a requested-tier guess', () => {
  for (const tier of ['auto', 'default', 'flex', 'priority', 'scale']) {
    const init = Object.freeze({body: json(tier), headers: Object.freeze({'content-type': 'application/json'})});
    assert.deepEqual(extractServiceTierSent(init), proof('value', tier));
    assert.equal(init.body, json(tier));
  }
  for (const body of ['{}', '{"input":[]}', '{"__proto__":{"service_tier":"priority"}}']) {
    assert.deepEqual(extractServiceTierSent({body}), proof('omitted'));
  }
  assert.deepEqual(extractServiceTierSent({body: '{"serviceTier":"priority"}'}), proof('omitted'));
});

test('Uint8Array and Buffer views use exact offsets without changing original bytes', () => {
  const bytes = Buffer.from('prefix' + priority + 'suffix');
  const before = Buffer.from(bytes);
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, Buffer.byteLength(priority));
  assert.deepEqual(extractServiceTierSent({body: view}), proof('value', 'priority'));
  assert.deepEqual(extractServiceTierSent({body: bytes.subarray(6, -6)}), proof('value', 'priority'));
  assert.deepEqual(bytes, before);
});

test('invalid JSON, primitives, arrays, unknown tiers and invalid UTF-8 never become values', () => {
  for (const body of ['', '{', 'null', 'true', '0', '"priority"', '[]', '[{"service_tier":"priority"}]']) {
    assert.deepEqual(extractServiceTierSent({body}), proof('invalid'));
  }
  for (const tier of [null, true, 3, {}, [], 'fast', 'Priority', 'priority ', 'synthetic-private-tier']) {
    const value = extractServiceTierSent({body: json(tier)});
    assert.deepEqual(value, proof('invalid'));
    assert.equal(JSON.stringify(value).includes('synthetic-private-tier'), false);
  }
  const invalidUtf8 = Buffer.concat([Buffer.from('{"service_tier":"priority","other":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  for (const body of [invalidUtf8, Uint8Array.of(0xc0, 0xaf), Uint8Array.of(0xe2, 0x82)]) {
    assert.deepEqual(extractServiceTierSent({body}), proof('invalid'));
  }
});

test('absent and streaming or unsupported bodies are unavailable without consumption', () => {
  let consumed = 0;
  const stream = new ReadableStream({start() {}});
  Object.defineProperty(stream, 'getReader', {get() {consumed++; throw new Error('synthetic forbidden stream read');}});
  for (const init of [{}, {body: undefined}, {body: null}, {body: stream}, {body: new Blob([priority])},
    {body: new ArrayBuffer(10)}, {body: new URLSearchParams('service_tier=priority')}]) {
    assert.deepEqual(extractServiceTierSent(init), proof('unavailable'));
  }
  assert.equal(consumed, 0); assert.equal(stream.locked, false);
});

test('accessors and proxies are rejected without reading private values or running traps', () => {
  let touched = 0;
  const getter = () => {touched++; throw new Error('synthetic-private-getter');};
  const init = Object.defineProperty({}, 'body', {get: getter});
  const headersInit = Object.defineProperty({body: priority}, 'headers', {get: getter});
  const header = Object.defineProperty({}, 'content-encoding', {get: getter, enumerable: true});
  const tuple = Object.defineProperty(['content-encoding', 'zstd'], '1', {get: getter});
  const bytes = Buffer.from(priority); Object.defineProperty(bytes, 'byteLength', {get: getter});
  const handler = {get: getter, getOwnPropertyDescriptor: getter, getPrototypeOf: getter, ownKeys: getter};
  for (const value of [init, headersInit, {body: priority, headers: header}, {body: priority, headers: [tuple]},
    {body: bytes}, new Proxy({body: priority}, handler), {body: new Proxy(Buffer.from(priority), handler)},
    {body: priority, headers: new Proxy({}, handler)},
    {body: priority, headers: Object.create(new Proxy({}, handler))}]) {
    assert.deepEqual(extractServiceTierSent(value), proof('invalid'));
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.deepEqual(extractServiceTierSent(revoked.proxy), proof('invalid'));
  assert.equal(touched, 0);
});

test('headers are inspected without mutation, invoking user get methods, or fabricating a coding', () => {
  for (const headers of [new Headers(), {}, [], {'Content-Encoding': ' identity '}, [['Content-Encoding', 'identity']]]) {
    const before = headers instanceof Headers ? [...headers] : structuredClone(headers);
    assert.deepEqual(extractServiceTierSent({body: priority, headers}), proof('value', 'priority'));
    assert.deepEqual(headers instanceof Headers ? [...headers] : headers, before);
  }
  let invoked = 0;
  const headers = {get() {invoked++; throw new Error('synthetic forbidden get');}};
  assert.deepEqual(extractServiceTierSent({body: priority, headers}), proof('value', 'priority'));
  const nonenumerable = Object.defineProperty({}, 'content-encoding', {value: 'zstd'});
  assert.deepEqual(extractServiceTierSent({body: priority, headers: nonenumerable}), proof('value', 'priority'));
  for (const coding of ['gzip', 'br', 'zstd, gzip', 'zstd, zstd']) {
    assert.deepEqual(extractServiceTierSent({body: priority, headers: {'content-encoding': coding}}), proof('unavailable'));
  }
  for (const coding of [null, undefined, 3, {toString() {invoked++; return 'zstd';}}]) {
    assert.deepEqual(extractServiceTierSent({body: priority, headers: {'content-encoding': coding}}), proof('invalid'));
  }
  assert.deepEqual(extractServiceTierSent({body: priority, headers: [['Content-Encoding', 'identity'], ['content-encoding', 'zstd']]}), proof('unavailable'));
  assert.equal(invoked, 0);
});

test('the 1 MiB input limit counts UTF-8 bytes and allows the exact boundary', () => {
  const boundary = padded(TIER_WIRE_MAX_BYTES);
  assert.deepEqual(extractServiceTierSent({body: boundary}), proof('value', 'priority'));
  assert.deepEqual(extractServiceTierSent({body: Buffer.from(boundary)}), proof('value', 'priority'));
  for (const body of [boundary + ' ', Buffer.from(boundary + ' '), new Uint8Array(TIER_WIRE_MAX_BYTES + 1),
    JSON.stringify({service_tier: 'priority', padding: 'é'.repeat(TIER_WIRE_MAX_BYTES / 2)})]) {
    assert.deepEqual(extractServiceTierSent({body}), proof('unavailable'));
  }
});

const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
test('zstd final bytes support native Headers, records, and tuples without mutation', {skip: !hasZstd}, () => {
  for (const headers of [new Headers({'content-encoding': 'zstd'}), Object.freeze({'CONTENT-ENCODING': 'ZsTd'}),
    Object.freeze([Object.freeze(['Content-Encoding', 'zstd'])])]) {
    const body = new Uint8Array(zlib.zstdCompressSync(priority)), before = Buffer.from(body);
    assert.deepEqual(extractServiceTierSent({body, headers}), proof('value', 'priority'));
    assert.deepEqual(Buffer.from(body), before);
  }
  const body = zlib.zstdCompressSync('{"input":[]}');
  assert.deepEqual(extractServiceTierSent({body, headers: {'content-encoding': 'zstd'}}), proof('omitted'));
});

test('zstd invalid content remains invalid, while input and decompressed limits are unavailable', {skip: !hasZstd}, () => {
  const headers = {'content-encoding': 'zstd'};
  for (const input of ['null', 'invalid json', Buffer.from([0xff])]) {
    assert.deepEqual(extractServiceTierSent({body: zlib.zstdCompressSync(input), headers}), proof('invalid'));
  }
  assert.deepEqual(extractServiceTierSent({body: Buffer.from('not a zstd frame'), headers}), proof('invalid'));
  const exact = zlib.zstdCompressSync(padded(TIER_WIRE_MAX_BYTES));
  assert.deepEqual(extractServiceTierSent({body: exact, headers}), proof('value', 'priority'));
  const bomb = zlib.zstdCompressSync(padded(TIER_WIRE_MAX_BYTES + 1));
  assert.ok(bomb.byteLength < TIER_WIRE_MAX_BYTES);
  assert.deepEqual(extractServiceTierSent({body: bomb, headers}), proof('unavailable'));
  assert.deepEqual(extractServiceTierSent({body: new Uint8Array(TIER_WIRE_MAX_BYTES + 1), headers}), proof('unavailable'));
});

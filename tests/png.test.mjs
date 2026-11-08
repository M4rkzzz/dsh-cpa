import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import {Worker} from 'node:worker_threads';
import {deflateSync, inflateSync} from 'node:zlib';
import {createPngRenderer} from '../lib/png-v026.mjs';
import {renderSvg, sanitizeSvg} from '../lib/png-worker-v026.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = body => '<svg xmlns="' + SVG_NS + '" width="100" height="100">' + body + '</svg>';
const SIMPLE = svg('<rect width="100" height="100" fill="red"/>');
const fixedError = (...codes) => error => codes.includes(error?.code) && error.message === error.code;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const table = Uint32Array.from({length: 256}, (_, i) => {
  for (let bit = 0; bit < 8; bit++) i = i & 1 ? 0xedb88320 ^ i >>> 1 : i >>> 1;
  return i >>> 0;
});
function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const value of bytes.subarray(4, 8 + data.length)) crc = table[(crc ^ value) & 255] ^ crc >>> 8;
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4); return bytes;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const scanlines = Buffer.alloc((1024 * 4 + 1) * 1024);
const compressed = deflateSync(scanlines);
function png({width = 1024, height = 1024, depth = 8, color = 6, data = compressed, before = [], after = []} = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = color;
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...before, chunk('IDAT', data), ...after, chunk('IEND')]);
}
const VALID_PNG = png();
function rgba(bytes) {
  const data = [], input = Buffer.from(bytes);
  for (let offset = 8; offset < input.length;) {
    const length = input.readUInt32BE(offset), type = input.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') data.push(input.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = 1024 * 4, pixels = Buffer.alloc(stride * 1024);
  assert.equal(raw.length, (stride + 1) * 1024);
  for (let y = 0; y < 1024; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= 4 ? pixels[index - 4] : 0, b = y ? pixels[index - stride] : 0;
      const c = y && x >= 4 ? pixels[index - stride - 4] : 0;
      let prediction = 0;
      if (filter === 1) prediction = a;
      else if (filter === 2) prediction = b;
      else if (filter === 3) prediction = (a + b) >>> 1;
      else if (filter === 4) {
        const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
        prediction = da <= db && da <= dc ? a : db <= dc ? b : c;
      }
      pixels[index] = raw[y * (stride + 1) + x + 1] + prediction;
    }
  }
  return (x, y) => [...pixels.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)];
}
class FakeWorker extends EventEmitter {
  posts = []; terminations = 0; refs = 0; unrefs = 0;
  postMessage(message) { this.posts.push(message); }
  ref() { this.refs++; }
  unref() { this.unrefs++; }
  terminate() { this.terminations++; return this.termination ?? Promise.resolve(0); }
  success(id = this.posts.at(-1).id, bytes = VALID_PNG) { this.emit('message', {id, ok: true, png: bytes}); }
  failure(code, id = this.posts.at(-1).id) { this.emit('message', {id, ok: false, code}); }
}
function clock() {
  let now = 0, sequence = 0;
  const pending = new Map();
  const timers = {setTimeout(fn, delay) { const token = ++sequence; pending.set(token, {fn, end: now + delay}); return token; },
    clearTimeout(token) { pending.delete(token); }};
  return {timers, pending, now: () => now, jump(value) { now = value; },
    async tick(value) {
      now = value;
      for (const [token, item] of [...pending]) if (item.end <= now && pending.delete(token)) item.fn();
      await flush();
    }};
}
function fixture(t, options = {}) {
  const time = clock(), workers = [];
  const renderer = createPngRenderer({now: time.now, timers: time.timers,
    workerFactory() { const worker = new FakeWorker(); workers.push(worker); return worker; }, ...options});
  t.after(async () => { try { await renderer.dispose(); } catch {} });
  return {renderer, workers, time};
}
function engineFixture(change = {}) {
  const state = {rendererFreed: 0, imageFreed: 0, initialized: 0, options: null, input: null};
  const bytes = Uint8Array.from([1, 2, 3]);
  class Engine {
    width = 1024; height = 1024;
    constructor(input, options) { state.input = input; state.options = options; if (change.construct) change.construct(this); }
    imagesToResolve() { if (change.resources) return change.resources; return []; }
    render() {
      if (change.renderThrows) throw new Error('PRIVATE-RENDER-ERROR');
      return {width: change.imageWidth ?? 1024, height: change.imageHeight ?? 1024,
        asPng() { if (change.asPngThrows) throw new Error('PRIVATE-PNG-ERROR'); return change.bytes ?? bytes; },
        free() { state.imageFreed++; bytes.fill(99); if (change.imageFreeThrows) throw new Error('PRIVATE-FREE-ERROR'); }};
    }
    free() { state.rendererFreed++; if (change.rendererFreeThrows) throw new Error('PRIVATE-FREE-ERROR'); }
  }
  return {state, options: {Renderer: Engine, async initialize() { state.initialized++; if (change.initializeThrows) throw new Error('PRIVATE-ASSET-PATH'); }}};
}

test('renderer validates configuration and starts no worker for absent/invalid input', async t => {
  for (const config of [null, {timeoutMs: 0}, {timeoutMs: 10001}, {maxPending: 17}, {maxPending: 0},
    {workerFactory: true}, {now: 1}, {timers: null}, {timers: {setTimeout: true}}]) {
    assert.throws(() => createPngRenderer(config), fixedError('png-invalid-config'));
  }
  const f = fixture(t); assert.equal(f.workers.length, 0);
  for (const input of [null, '', {}, new Uint8Array([1]), 1]) await assert.rejects(f.renderer.render(input), fixedError('png-invalid-input'));
  await assert.rejects(f.renderer.render(SIMPLE, null), fixedError('png-invalid-input'));
  await assert.rejects(f.renderer.render(SIMPLE, {signal: {aborted: false}}), fixedError('png-invalid-input'));
  assert.equal(f.workers.length, 0);
});

test('256KiB input bound counts UTF-8 bytes rather than UTF-16 characters', async t => {
  const f = fixture(t);
  await assert.rejects(f.renderer.render('x'.repeat(256 * 1024 + 1)), fixedError('png-input-limit'));
  await assert.rejects(f.renderer.render('鹈'.repeat(100000)), fixedError('png-input-limit'));
  assert.equal(f.workers.length, 0);
  assert.throws(() => sanitizeSvg('鹈'.repeat(100000)), fixedError('png-input-limit'));
});

test('actual package WASM renders a real RGBA1024 PNG without image files or network', async t => {
  let created = 0, exited = 0;
  const renderer = createPngRenderer({workerFactory() {
    created++; const worker = new Worker(new URL('../lib/png-worker-v026.mjs', import.meta.url),
      {execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4}});
    worker.on('exit', () => exited++); return worker;
  }});
  t.after(() => renderer.dispose()); assert.equal(created, 0);
  const first = await renderer.render(SIMPLE);
  assert.ok(first instanceof Uint8Array); assert.ok(first.byteLength < 2 * 1024 * 1024);
  assert.deepEqual(rgba(first)(512, 512), [255, 0, 0, 255]);
  const second = await renderer.render(svg('<circle cx="50" cy="50" r="40" fill="blue"/>'));
  assert.deepEqual(rgba(second)(512, 512), [0, 0, 255, 255]);
  assert.equal(created, 1); await renderer.dispose(); assert.equal(exited, 1);
});

test('safe gradients, clip paths, shape geometry and basic CSS work with actual WASM', async t => {
  const renderer = createPngRenderer(); t.after(() => renderer.dispose());
  const input = svg('<style>.paint {fill:url(#paint);stroke:navy;stroke-width:1} #disc{opacity:1}</style>' +
    '<defs><linearGradient id="paint"><stop offset="0%" stop-color="red"/><stop offset="100%" stop-color="blue"/></linearGradient>' +
    '<clipPath id="clip"><rect x="10" y="10" width="80" height="80"/></clipPath></defs>' +
    '<g clip-path="url(#clip)"><rect class="paint" width="100" height="100"/>' +
    '<circle id="disc" cx="50" cy="50" r="10" fill="lime"/>' +
    '<path d="M10 80 Q 50 20 90 80" fill="none" stroke="white"/></g>');
  const result = await renderer.render(input), pixel = rgba(result);
  assert.deepEqual(pixel(512, 560), [0, 255, 0, 255]);
  assert.equal(pixel(0, 0)[3], 0); assert.ok(pixel(200, 200)[0] > pixel(200, 200)[2]);
  assert.ok(pixel(800, 200)[2] > pixel(800, 200)[0]);
});

test('sanitizer rebuilds XML, compiles CSS and discards title/desc/class/untrusted comments', () => {
  const clean = sanitizeSvg('<?xml version="1.0" encoding="UTF-8"?>' + svg('<!-- discarded -->' +
    '<title>untrusted-title</title><desc>untrusted-desc</desc><style>rect{fill:blue}.x{fill:green}#one{fill:yellow}</style>' +
    '<rect id="one" class="x" width="100" height="100" style="fill: rgb(255,0,0)"/>'));
  assert.match(clean, /width="1024"/); assert.match(clean, /height="1024"/); assert.match(clean, /viewBox="0 0 100 100"/);
  assert.match(clean, /fill="rgb\(255,0,0\)"/);
  for (const value of ['<style', 'class=', '<title', '<desc', 'untrusted-', '<!--']) assert.ok(!clean.includes(value));
});

test('normal shape/arc/transform/gradient values survive structural validation', () => {
  const input = svg('<defs><radialGradient id="a"><stop offset="0.5" stop-color="rgba(255,0,0,0.5)"/></radialGradient>' +
    '<linearGradient id="b" href="#a" gradientTransform="rotate(30)"/></defs>' +
    '<g transform="translate(1,2) rotate(10) scale(1.5)"><ellipse cx="30" cy="40" rx="10" ry="5" fill="url(#b)"/>' +
    '<polygon points="1,1 5,10 10,1" fill="hsl(120,100%,50%)"/>' +
    '<polyline points="1 2 3 4" stroke="currentColor" stroke-dasharray="1 2"/>' +
    '<path d="M10 10 A20 15 10 0 1 50 50 z" stroke-linejoin="round"/></g>');
  assert.match(sanitizeSvg(input), /transform="matrix\(/);
  assert.match(sanitizeSvg(input), /xlink:href="#a"/);
});

const attacks = [
  ['DTD entity', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///PRIVATE">]><svg>&x;</svg>'],
  ['external DTD', '<!DOCTYPE svg SYSTEM "https://invalid.example/private"><svg/>'],
  ['numeric entity', svg('<rect fill="&#x72;ed"/>')],
  ['predefined entity', svg('<title>a&amp;b</title>')],
  ['stylesheet processing instruction', '<?xml-stylesheet href="https://invalid.example/private"?><svg/>'],
  ['script', svg('<script>PRIVATE</script>')],
  ['foreignObject', svg('<foreignObject/>')], ['image https', svg('<image href="https://invalid.example/private"/>')],
  ['image file', svg('<image href="file:///PRIVATE"/>')], ['image data', svg('<image href="data:image/png;base64,PRIVATE"/>')],
  ['use expansion', svg('<use href="#x"/>')], ['filter', svg('<filter id="f"/>')], ['animation', svg('<animate attributeName="fill"/>')],
  ['event handler', svg('<rect onload="PRIVATE"/>')], ['mixed case handler', svg('<rect onLoad="PRIVATE"/>')],
  ['unknown namespace', '<svg xmlns="https://invalid.example/private"/>'],
  ['foreign namespaced attribute', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:p="https://invalid.example/private"><rect p:onload="PRIVATE"/></svg>'],
  ['xml base', '<svg xmlns="http://www.w3.org/2000/svg" xml:base="file:///PRIVATE"/>'],
  ['external paint', svg('<rect fill="url(https://invalid.example/private)"/>')],
  ['file paint', svg('<rect fill="url(file:///PRIVATE)"/>')], ['data paint', svg('<rect fill="url(data:image/svg+xml,PRIVATE)"/>')],
  ['at import', svg('<style>@import "https://invalid.example/private";</style>')],
  ['font face', svg('<style>@font-face{src:url(file:///PRIVATE)}</style>')],
  ['CSS escapes', svg('<rect style="f\\69ll:red"/>')], ['CSS comment obfuscation', svg('<rect style="fill:u/**/rl(PRIVATE)"/>')],
  ['CSS expression', svg('<rect style="fill:expression(PRIVATE)"/>')], ['CSS unknown resource', svg('<rect style="background-image:url(PRIVATE)"/>')],
  ['style important', svg('<rect style="fill:red!important"/>')], ['complex CSS selector', svg('<style>g > rect{fill:red}</style>')],
  ['external gradient href', svg('<defs><linearGradient id="a" href="https://invalid.example/private"/></defs>')],
  ['gradient loop', svg('<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>')],
  ['recursive clip', svg('<defs><clipPath id="a"><rect clip-path="url(#a)"/></clipPath></defs>')],
  ['wrong paint reference', svg('<rect id="shape"/><circle fill="url(#shape)"/>')],
  ['missing resource', svg('<rect fill="url(#missing)"/>')], ['duplicate ids', svg('<rect id="a"/><circle id="a"/>')],
  ['nested root', svg('<svg/>')], ['multiple roots', '<svg/><svg/>'], ['plain text in shape', svg('<rect>PRIVATE</rect>')],
  ['unbalanced XML', '<svg><rect></svg>'], ['bad path grammar', svg('<path d="M1 2 L3"/>')],
  ['invalid arc flags', svg('<path d="M1 1 A1 1 0 5 0 2 2"/>')], ['bad coordinate', svg('<rect x="NaN"/>')],
];
for (const [label, input] of attacks) test('rejects ' + label + ' before any renderer/resource initialization', async () => {
  const f = engineFixture();
  assert.throws(() => sanitizeSvg(input), fixedError('png-unsafe-svg', 'png-invalid-svg', 'png-complexity-limit'));
  await assert.rejects(renderSvg(input, f.options), fixedError('png-unsafe-svg', 'png-invalid-svg', 'png-complexity-limit'));
  assert.equal(f.state.initialized, 0); assert.equal(f.state.input, null);
});

const complexity = [
  ['node budget', svg('<rect/>'.repeat(2048))],
  ['nesting depth', svg('<g>'.repeat(32) + '<rect/>' + '</g>'.repeat(32))],
  ['resource count', svg('<defs>' + Array.from({length: 257}, (_, i) => '<linearGradient id="g' + i + '"/>').join('') + '</defs>')],
  ['path segments', svg('<path d="M0 0 ' + 'L1 1 '.repeat(8193) + '"/>')],
  ['path numeric budget', svg('<path d="M0 0 ' + 'C1 1 2 2 3 3 '.repeat(5500) + '"/>')],
  ['polyline budget', svg('<polyline points="' + '1 1 '.repeat(8193) + '"/>')],
  ['coordinate magnitude', svg('<rect x="1000001"/>')],
  ['transform amplification', svg('<g transform="scale(1000)"><g transform="scale(1000)"><rect transform="scale(1000)"/></g></g>')],
  ['tiny stroke dashes', svg('<path d="M0 0 L100 100" stroke="red" stroke-dasharray="0.000001 1"/>')],
  ['large inherited dashed geometry', svg('<g stroke="red" stroke-dasharray="0.1 0.1"><path d="M0 0 L1000000 1000000"/></g>')],
  ['dash pathLength amplification', svg('<path d="M0 0 L100 100" stroke="red" stroke-dasharray="1 1" pathLength="0.1"/>')],
  ['CSS dash amplification', svg('<style>line{stroke:red;stroke-dasharray:0.1 0.1}</style><line x2="1000000" y2="1000000"/>')],
  ['non-scaling stroke viewport amplification', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0.001 0.001"><path d="M0 0 L100 100" stroke="red" stroke-dasharray="0.1 0.1" vector-effect="non-scaling-stroke"/></svg>'],


  ['stylesheet rules', svg('<style>' + Array.from({length: 129}, (_, i) => '.x' + i + '{fill:red}').join('') + '</style>')],
  ['gradient chain', svg('<defs>' + Array.from({length: 17}, (_, i) => '<linearGradient id="g' + i + '"' + (i < 16 ? ' href="#g' + (i + 1) + '"' : '') + '/>').join('') + '</defs>')],
];
for (const [label, input] of complexity) test('bounds ' + label + ' before WASM initialization', async () => {
  const f = engineFixture();
  await assert.rejects(renderSvg(input, f.options), fixedError('png-complexity-limit'));
  assert.equal(f.state.initialized, 0);
});

test('renderSvg disables host fonts/resources, copies image bytes and frees image and renderer', async () => {
  const f = engineFixture(), result = await renderSvg(SIMPLE, f.options);
  assert.deepEqual([...result], [1, 2, 3]); assert.equal(f.state.imageFreed, 1); assert.equal(f.state.rendererFreed, 1);
  assert.deepEqual(f.state.options, {fitTo: {mode: 'original'}, font: {loadSystemFonts: false, fontFiles: [], fontDirs: []}});
});
for (const [label, change, expected, images] of [
  ['asset failure', {initializeThrows: true}, 'png-unavailable', 0],
  ['renderer dimensions', {construct(instance) { instance.width = 100; }}, 'png-render-failed', 0],
  ['unresolved resources', {resources: ['file:///PRIVATE']}, 'png-render-failed', 0],
  ['render failure', {renderThrows: true}, 'png-render-failed', 0],
  ['image dimensions', {imageHeight: 100}, 'png-render-failed', 1],
  ['PNG encoding failure', {asPngThrows: true}, 'png-render-failed', 1],
  ['wrong byte type', {bytes: 'PRIVATE'}, 'png-render-failed', 1],
  ['output limit', {bytes: new Uint8Array(2 * 1024 * 1024 + 1)}, 'png-output-limit', 1],
  ['image free failure', {imageFreeThrows: true}, 'png-render-failed', 1],
  ['renderer free failure', {rendererFreeThrows: true}, 'png-render-failed', 1],
]) test('releases native allocations after ' + label + ' and exposes only safe errors', async () => {
  const f = engineFixture(change);
  await assert.rejects(renderSvg(SIMPLE, f.options), fixedError(expected));
  assert.equal(f.state.imageFreed, images); assert.equal(f.state.rendererFreed, change.initializeThrows ? 0 : 1);
});

test('one worker is reused, output is detached, idle workers unref and tasks are FIFO', async t => {
  const f = fixture(t), first = f.renderer.render(SIMPLE), second = f.renderer.render(SIMPLE);
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].posts.length, 1);
  const bytes = Uint8Array.from(VALID_PNG); f.workers[0].success(undefined, bytes);
  const output = await first; assert.notEqual(output, bytes); bytes.fill(0); assert.equal(output[0], 137);
  await flush(); assert.equal(f.workers[0].posts.length, 2); f.workers[0].success(); await second;
  assert.equal(f.workers.length, 1); assert.ok(f.workers[0].unrefs > 0); assert.equal(f.time.pending.size, 0);
});

test('pending render capacity is bounded with visible rejection rather than unlimited SVG buffering', async t => {
  const f = fixture(t, {maxPending: 2}), first = f.renderer.render(SIMPLE), second = f.renderer.render(SIMPLE);
  await assert.rejects(f.renderer.render(SIMPLE), fixedError('png-busy'));
  f.workers[0].success(); await first; await flush(); f.workers[0].success(); await second;
  assert.equal(f.time.pending.size, 0);
});

test('pre-aborted signals start no worker and queued abort does not retire healthy active work', async t => {
  const f = fixture(t), aborted = new AbortController(); aborted.abort(new Error('PRIVATE'));
  await assert.rejects(f.renderer.render(SIMPLE, {signal: aborted.signal}), fixedError('png-aborted')); assert.equal(f.workers.length, 0);
  const first = f.renderer.render(SIMPLE), control = new AbortController();
  const second = assert.rejects(f.renderer.render(SIMPLE, {signal: control.signal}), fixedError('png-aborted'));
  assert.equal(getEventListeners(control.signal, 'abort').length, 1); control.abort(); await second;
  assert.equal(getEventListeners(control.signal, 'abort').length, 0); assert.equal(f.workers[0].terminations, 0);
  f.workers[0].success(); await first;
});

test('active abort waits for worker reclamation and late old messages cannot settle the replacement', async t => {
  const f = fixture(t), control = new AbortController(), reclaimed = Promise.withResolvers();
  const first = assert.rejects(f.renderer.render(SIMPLE, {signal: control.signal}), fixedError('png-aborted'));
  const old = f.workers[0]; old.termination = reclaimed.promise;
  const second = f.renderer.render(SIMPLE); let completed = false; second.then(() => { completed = true; });
  control.abort(new Error('PRIVATE-ABORT')); await first; await flush();
  assert.equal(old.terminations, 1); assert.equal(f.workers.length, 1);
  old.success(2); old.emit('error', new Error('PRIVATE-LATE')); await flush(); assert.equal(completed, false);
  reclaimed.resolve(0); await flush(); assert.equal(f.workers.length, 2);
  old.success(2); await flush(); assert.equal(completed, false);
  f.workers[1].success(); await second;
  assert.equal(old.listenerCount('message'), 0); assert.equal(getEventListeners(control.signal, 'abort').length, 0);
});

test('timeout includes queueing; delayed timer and stale worker result cannot extend the deadline', async t => {
  const f = fixture(t, {timeoutMs: 100});
  const first = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-timeout'));
  f.time.jump(20); const second = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-timeout'));
  f.time.jump(120); f.workers[0].success(); await first; await flush(); await second;
  assert.equal(f.workers[0].posts.length, 1); assert.equal(f.workers.length, 1); assert.equal(f.time.pending.size, 0);
});

test('real timer timeout rejects and terminates an unresponsive worker', async t => {
  const worker = new FakeWorker(), renderer = createPngRenderer({timeoutMs: 10, workerFactory: () => worker});
  t.after(() => renderer.dispose());
  await assert.rejects(renderer.render(SIMPLE), fixedError('png-timeout')); await flush(); assert.equal(worker.terminations, 1);
});

test('dispose rejects active and queued work, is idempotent and waits for termination', async t => {
  const f = fixture(t), gate = Promise.withResolvers(), control = new AbortController();
  const first = assert.rejects(f.renderer.render(SIMPLE, {signal: control.signal}), fixedError('png-disposed'));
  const second = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-disposed'));
  f.workers[0].termination = gate.promise;
  const disposing = f.renderer.dispose(); assert.equal(f.renderer.dispose(), disposing);
  let done = false; disposing.then(() => { done = true; }); await first; await second; await flush();
  assert.equal(done, false); assert.equal(f.time.pending.size, 0); assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  await assert.rejects(f.renderer.render(SIMPLE), fixedError('png-disposed'));
  gate.resolve(0); await disposing; assert.equal(done, true); assert.equal(f.workers.length, 1);
});

test('failed reclamation prevents a second worker and safely rejects disposal', async t => {
  const f = fixture(t), control = new AbortController();
  const first = assert.rejects(f.renderer.render(SIMPLE, {signal: control.signal}), fixedError('png-aborted'));
  const second = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-worker-error'));
  f.workers[0].terminate = () => { throw new Error('PRIVATE-TERMINATE'); };
  control.abort(); await first; await second; await flush();
  await assert.rejects(f.renderer.render(SIMPLE), fixedError('png-worker-error'));
  await assert.rejects(f.renderer.dispose(), fixedError('png-worker-error')); assert.equal(f.workers.length, 1);
});

for (const event of ['error', 'messageerror', 'exit']) test('worker ' + event + ' is sanitized and allows clean replacement after reclamation', async t => {
  const f = fixture(t), result = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-worker-error'));
  const old = f.workers[0]; old.emit(event, new Error('PRIVATE-WORKER-ERROR')); await result; await flush();
  const next = f.renderer.render(SIMPLE); assert.equal(f.workers.length, 2); f.workers[1].success(); await next;
});

test('worker availability/render failures retire it while validation failures may reuse it', async t => {
  const f = fixture(t);
  const bad = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-unsafe-svg'));
  f.workers[0].failure('png-unsafe-svg'); await bad;
  const unavailable = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-unavailable'));
  f.workers[0].failure('png-unavailable'); await unavailable; await flush();
  const good = f.renderer.render(SIMPLE); assert.equal(f.workers.length, 2); f.workers[1].success(); await good;
});

test('unknown messages/codes never echo worker strings or correlate different request ids', async t => {
  const f = fixture(t), first = f.renderer.render(SIMPLE); let resolved = false; first.then(() => { resolved = true; });
  f.workers[0].success(999); await flush(); assert.equal(resolved, false);
  f.workers[0].success(); await first;
  const bad = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-worker-error'));
  f.workers[0].failure('PRIVATE-CODE-AND-PATH'); await bad;
});

const invalidPngs = [
  ['wrong type', 'PRIVATE'], ['signature-only', signature], ['truncated', VALID_PNG.subarray(0, 50)],
  ['wrong width', png({width: 1})], ['wrong height', png({height: 1})], ['wrong bit depth', png({depth: 16})],
  ['wrong color type', png({color: 2})], ['text metadata', png({before: [chunk('tEXt', Buffer.from('PRIVATE'))]})],
  ['animation', png({before: [chunk('acTL', Buffer.alloc(8))]})],
  ['duplicate metadata', png({before: [chunk('sRGB', Buffer.from([0])), chunk('sRGB', Buffer.from([0]))]})],
  ['metadata after data', png({after: [chunk('sRGB', Buffer.from([0]))]})],
  ['invalid metadata', png({before: [chunk('gAMA', Buffer.alloc(4))]})],
  ['bad zlib', png({data: Buffer.from([1, 2, 3])})], ['truncated scanlines', png({data: deflateSync(Buffer.alloc(100))})],
  ['too many scanlines', png({data: deflateSync(Buffer.alloc(scanlines.length + 1))})],
  ['trailing zlib', png({data: Buffer.concat([compressed, Buffer.from([0])])})],
  ['trailing file data', Buffer.concat([VALID_PNG, Buffer.from('PRIVATE')])],
  ['invalid scanline filter', png({data: deflateSync(Buffer.concat([Buffer.from([5]), scanlines.subarray(1)]))})],
  ['bad CRC', (() => { const bytes = Buffer.from(VALID_PNG); bytes[30] ^= 1; return bytes; })()],
];
for (const [label, bytes] of invalidPngs) test('verifies PNG output against ' + label, async t => {
  const f = fixture(t), result = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-invalid-output'));
  f.workers[0].success(undefined, bytes); await result; assert.equal(f.workers[0].terminations, 1);
});

test('rejects PNG larger than 2MiB before decoding it', async t => {
  const f = fixture(t), result = assert.rejects(f.renderer.render(SIMPLE), fixedError('png-output-limit'));
  f.workers[0].success(undefined, new Uint8Array(2 * 1024 * 1024 + 1)); await result;
});

test('actual worker rejects malicious resources with fetch disabled and still renders safe shapes', async t => {
  const url = new URL('../lib/png-worker-v026.mjs', import.meta.url).href;
  const renderer = createPngRenderer({workerFactory: () => new Worker(
    'globalThis.fetch = () => { throw new Error("unexpected-network"); }; import(' + JSON.stringify(url) + ');',
    {eval: true, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4}})});
  t.after(() => renderer.dispose());
  for (const input of [svg('<script>PRIVATE</script>'), svg('<image href="https://invalid.example/PRIVATE"/>'),
    '<!DOCTYPE svg SYSTEM "file:///PRIVATE"><svg/>']) {
    await assert.rejects(renderer.render(input), fixedError('png-unsafe-svg', 'png-invalid-svg'));
  }
  assert.deepEqual(rgba(await renderer.render(SIMPLE))(512, 512), [255, 0, 0, 255]);
});

test('all-zero dashes become solid while safe bounded dashes remain supported', () => {
  assert.match(sanitizeSvg(svg('<line x2="50" y2="50" stroke="red" stroke-dasharray="0 0"/>')), /stroke-dasharray="none"/);
  assert.match(sanitizeSvg(svg('<line x2="50" y2="50" stroke="red" stroke-dasharray="2 3"/>')), /stroke-dasharray="2 3"/);
});

for (const mode of ['abort', 'timeout']) test('native worker is reclaimed after immediate ' + mode, async t => {
  let exits = 0, created = 0;
  const renderer = createPngRenderer({timeoutMs: mode === 'timeout' ? 1 : 10000, workerFactory() {
    created++; const worker = new Worker(new URL('../lib/png-worker-v026.mjs', import.meta.url), {execArgv: []});
    worker.on('exit', () => exits++); return worker;
  }});
  t.after(() => renderer.dispose());
  const control = new AbortController();
  const result = assert.rejects(renderer.render(SIMPLE, {signal: control.signal}), fixedError(mode === 'abort' ? 'png-aborted' : 'png-timeout'));
  if (mode === 'abort') control.abort();
  await result; await renderer.dispose(); assert.equal(created, 1); assert.equal(exits, 1);
});

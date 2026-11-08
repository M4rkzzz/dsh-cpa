import {Worker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {inflateSync} from 'node:zlib';

const MAX_SVG_BYTES = 256 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const SIZE = 1024;
const WORKER_CODES = new Set([
  'png-invalid-input', 'png-input-limit', 'png-invalid-svg', 'png-unsafe-svg',
  'png-complexity-limit', 'png-output-limit', 'png-render-failed', 'png-unavailable',
]);
const CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function failure(code) {
  const name = code === 'png-aborted' ? 'AbortError' : code === 'png-timeout' ? 'TimeoutError' : 'Error';
  return Object.assign(new Error(code), {code, name});
}
function u32(bytes, offset) {
  return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}
function verifyPng(input) {
  if (!(input instanceof Uint8Array)) throw failure('png-invalid-output');
  if (input.byteLength > MAX_PNG_BYTES) throw failure('png-output-limit');
  // Verify an owned snapshot, never a mutable/shared view supplied by a worker.
  const bytes = Uint8Array.from(input);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 57 || !signature.every((value, i) => bytes[i] === value)) throw failure('png-invalid-output');
  let offset = 8, header = false, end = false, dataBytes = 0;
  const chunks = [], metadata = new Set();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw failure('png-invalid-output');
    const length = u32(bytes, offset);
    if (length > bytes.length - offset - 12) throw failure('png-invalid-output');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    // No SVG, textual metadata, executable formats or animated PNG payloads.
    if (!['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs'].includes(type)) throw failure('png-invalid-output');
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    if (((crc ^ 0xffffffff) >>> 0) !== u32(bytes, offset + 8 + length)) throw failure('png-invalid-output');
    if (!header && type !== 'IHDR') throw failure('png-invalid-output');
    if (type === 'IHDR') {
      if (header || length !== 13 || u32(bytes, offset + 8) !== SIZE || u32(bytes, offset + 12) !== SIZE ||
          bytes[offset + 16] !== 8 || bytes[offset + 17] !== 6 || bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw failure('png-invalid-output');
      header = true;
    } else if (type === 'IDAT') {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
      dataBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0 || !dataBytes || offset + 12 !== bytes.length) throw failure('png-invalid-output');
      end = true;
    } else {
      if (chunks.length || metadata.has(type) || (type === 'sRGB' && (length !== 1 || bytes[offset + 8] > 3)) ||
          (type === 'gAMA' && (length !== 4 || u32(bytes, offset + 8) === 0)) ||
          (type === 'pHYs' && (length !== 9 || bytes[offset + 16] > 1))) throw failure('png-invalid-output');
      metadata.add(type);
    }
    offset += 12 + length;
  }
  if (!header || !dataBytes || !end) throw failure('png-invalid-output');
  // CRC/signature alone do not prove that IDAT is a decodable PNG. Bound inflate
  // to exactly the fixed RGBA canvas and reject truncated/trailing zlib payloads.
  const stride = SIZE * 4 + 1, expected = stride * SIZE;
  try {
    const {buffer, engine} = inflateSync(Buffer.concat(chunks, dataBytes), {maxOutputLength: expected, info: true});
    if (buffer.length !== expected || engine.bytesWritten !== dataBytes) throw failure('png-invalid-output');
    for (let row = 0; row < SIZE; row++) if (buffer[row * stride] > 4) throw failure('png-invalid-output');
  } catch {throw failure('png-invalid-output');}
  return bytes;
}

/** Backend-only, no browser, network, image files, or retained history. Options
 * workerFactory/timers/now are trusted test seams, never HTTP input. Bounds may
 * only be lowered: at most 10 seconds end-to-end and 16 total pending renders.
 * The timeout includes queueing and initialization. One worker is live at most;
 * replacement waits for termination, including when callers do not await abort.
 */
export function createPngRenderer(options = {}) {
  if (!options || typeof options !== 'object') throw failure('png-invalid-config');
  const {timeoutMs = 10000, maxPending = 16, workerFactory, timers = {}, now = () => performance.now()} = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 16 ||
      workerFactory !== undefined && typeof workerFactory !== 'function' || typeof now !== 'function' ||
      !timers || typeof timers !== 'object') throw failure('png-invalid-config');
  const later = timers.setTimeout ?? setTimeout, clearTimer = timers.clearTimeout ?? clearTimeout;
  if (typeof later !== 'function' || typeof clearTimer !== 'function') throw failure('png-invalid-config');
  const makeWorker = workerFactory ?? (() => new Worker(new URL('./png-worker-v026.mjs', import.meta.url), {
    execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 64, stackSizeMb: 4},
  }));
  let disposed = false, broken = false, worker = null, stopping = null, current = null, sequence = 0, disposal = null, cleanupError = null;
  const queue = [];

  function settle(task, error, png) {
    if (task.settled) return;
    task.settled = true;
    clearTimer(task.timer);
    task.signal?.removeEventListener('abort', task.onAbort);
    task.svg = null;
    if (current === task) current = null;
    else {
      const index = queue.indexOf(task);
      if (index !== -1) queue.splice(index, 1);
    }
    if (error) task.reject(error);
    else task.resolve(png);
    if (!current && queue.length === 0) worker?.instance.unref?.();
    queueMicrotask(pump);
  }
  function retire(record) {
    if (!record || worker !== record) return;
    worker = null; // Late messages/errors/exits can no longer target a task.
    const barrier = {};
    stopping = barrier;
    let terminating;
    try {terminating = record.instance.terminate();}
    catch {terminating = Promise.reject(failure('png-worker-error'));}
    barrier.promise = Promise.resolve(terminating).then(() => {
      record.instance.off('message', record.onMessage);
      record.instance.off('error', record.onError);
      record.instance.off('exit', record.onExit);
      record.instance.off('messageerror', record.onError);
      if (stopping === barrier) stopping = null;
      pump();
    }, () => {
      // If reclamation cannot be confirmed, do not start a second worker.
      broken = true;
      cleanupError = failure('png-worker-error');
      for (const task of [...queue]) settle(task, failure('png-worker-error'));
    });
  }
  function stopTask(task, code) {
    if (task.settled) return;
    if (current === task) retire(worker);
    settle(task, failure(code));
  }
  function getWorker() {
    if (worker) return worker;
    const instance = makeWorker();
    const record = {instance};
    record.onMessage = message => {
      const task = current;
      if (worker !== record || !task || message?.id !== task.id) return;
      if (task.signal?.aborted) {stopTask(task, 'png-aborted'); return;}
      if (now() >= task.deadline) {stopTask(task, 'png-timeout'); return;}
      if (message.ok === true) {
        try {
          const png = verifyPng(message.png);
          if (now() >= task.deadline) {stopTask(task, 'png-timeout'); return;}
          settle(task, null, png);
        } catch (error) {retire(record); settle(task, error);}
      } else if (message.ok === false && WORKER_CODES.has(message.code)) {
        if (message.code === 'png-unavailable' || message.code === 'png-render-failed') retire(record);
        settle(task, failure(message.code));
      } else {
        retire(record);
        settle(task, failure('png-worker-error'));
      }
    };
    record.onError = () => {
      if (worker !== record) return;
      const task = current;
      retire(record);
      if (task) settle(task, failure('png-worker-error'));
    };
    record.onExit = record.onError;
    worker = record;
    instance.on('message', record.onMessage);
    instance.on('error', record.onError);
    instance.on('messageerror', record.onError);
    instance.on('exit', record.onExit);
    return record;
  }
  function pump() {
    if (disposed || broken || current || stopping || queue.length === 0) return;
    const task = queue[0];
    // Timers can be delayed behind worker messages. Check the monotonic deadline
    // before dispatch as well, so queue time never becomes a new 10-second lease.
    if (task.signal?.aborted) {settle(task, failure('png-aborted')); return;}
    if (now() >= task.deadline) {settle(task, failure('png-timeout')); return;}
    queue.shift();
    current = task;
    try {
      const record = getWorker();
      record.instance.ref?.();
      record.instance.postMessage({id: task.id, svg: task.svg});
      task.svg = null; // The only remaining input copy is in the active worker.
    } catch {
      retire(worker);
      settle(task, failure('png-worker-error'));
    }
  }
  function render(svg, options = {}) {
    if (disposed) return Promise.reject(failure('png-disposed'));
    if (broken) return Promise.reject(failure('png-worker-error'));
    if (typeof svg !== 'string' || svg.length === 0) return Promise.reject(failure('png-invalid-input'));
    if (svg.length > MAX_SVG_BYTES || Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) return Promise.reject(failure('png-input-limit'));
    const signal = options?.signal;
    if (options === null || typeof options !== 'object' || signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(failure('png-invalid-input'));
    if (signal?.aborted) return Promise.reject(failure('png-aborted'));
    if (queue.length + Number(current !== null) >= maxPending) return Promise.reject(failure('png-busy'));
    return new Promise((resolve, reject) => {
      const task = {id: ++sequence, svg, signal, resolve, reject, settled: false, timer: null, deadline: now() + timeoutMs};
      task.onAbort = () => stopTask(task, 'png-aborted');
      queue.push(task);
      signal?.addEventListener('abort', task.onAbort, {once: true});
      task.timer = later(() => stopTask(task, 'png-timeout'), timeoutMs);
      // Deadline is deliberately ref'ed while a caller is awaiting work.
      if (signal?.aborted) task.onAbort();
      else pump();
    });
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    retire(worker);
    if (current) settle(current, failure('png-disposed'));
    for (const task of [...queue]) settle(task, failure('png-disposed'));
    disposal = (stopping?.promise ?? Promise.resolve()).then(() => {if (cleanupError) throw cleanupError;});
    return disposal;
  }
  return {render, dispose};
}

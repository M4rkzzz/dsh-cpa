import * as nativeFs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {ReadableStream} from 'node:stream/web';

const STATUSES = new Set(['success', 'error', 'cancelled']);
const FILTER_STATUSES = new Set([...STATUSES, 'running']);
const SOURCES = new Set(['conversation', 'pelican', 'unknown']);
const FINISH_REASONS = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const TIERS = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
const ERROR_CODES = new Set([
  'AUTH', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED', 'NETWORK',
  'TIMEOUT', 'CANCELLED', 'ABORTED', 'UNKNOWN', 'STREAM_CLOSED', 'EMPTY_RESPONSE',
  'QUOTA', 'INVALID_REQUEST', 'SERVER', 'TRANSPORT', 'PI_AI_ERROR', 'MALFORMED_RESPONSE',
  'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'ACCOUNT_QUOTA',
  'IMAGE_OFFLOAD_REQUIRED', 'INVALID_CONFIG', 'INVALID_ARGS', 'UNKNOWN_MODEL',
  'UNSUPPORTED_OPTION', 'UNSUPPORTED_CONTENT', 'INVALID_REPLAY_STATE', 'REQUEST_HEADERS',
  'NO_CREDENTIAL_STORE', 'UNSTORABLE_PROVIDER_ID', 'DISCOVERY_FAILED', 'DISCOVERY_UNSUPPORTED',
  'INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT', 'UNSUPPORTED_REASONING_EFFORT',
  'pelican-timeout', 'pelican-cancelled', 'pelican-output-limit', 'pelican-invalid-svg',
  'pelican-invalid-stream', 'pelican-stream-closed', 'pelican-tool-call',
  'pelican-max-tokens', 'pelican-generation-failed',
  'CPA_ACCOUNT_INACTIVE', 'CPA_BINDING_MISMATCH', 'CPA_TRANSPORT_FAILED',
]);
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const MODEL = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;
const ACCOUNT = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const ROW_ID = /^cpa-log-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX = Number.MAX_SAFE_INTEGER;
const utf8 = new TextDecoder('utf-8', {fatal: true});
class LogStoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const safeError = code => new LogStoreError(code);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const metric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX ? value : null;
const enumValue = (value, values) => typeof value === 'string' && value.length <= 80 && values.has(value) ? value : null;
function own(value, key) {
  try { return value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
  catch { return undefined; }
}
function identifier(value, pattern = MODEL) {
  return typeof value === 'string' && value.length <= 200 && pattern.test(value) ? value : null;
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

// Never stringify a caller's object or retain it in the write queue. In particular,
// getters, toJSON, raw errors, request options and unknown properties are ignored.
function displayRow(input, fromDisk = false) {
  const status = enumValue(own(input, 'status'), STATUSES);
  const id = fromDisk ? own(input, 'id') : 'cpa-log-' + randomUUID();
  if (!status || typeof id !== 'string' || !ROW_ID.test(id)) return null;
  const email = own(input, 'accountEmail');
  const usage = own(input, 'usageEvidence');
  const usageEvidence = usage === 'provider' || usage === 'host-normalized' ? usage : 'unavailable';
  const http = own(input, 'httpStatus');
  const ratio = own(input, 'cacheHitRate');
  const basis = own(input, 'costBasis');
  const priceBasis = own(input, 'priceBasis') === 'openai-standard-reference' ? 'openai-standard-reference' : null;
  const priceModel = identifier(own(input, 'priceModel'));
  const cost = usageEvidence !== 'unavailable' && priceBasis && priceModel
    && (basis === 'estimate' || basis === 'upper-bound') ? metric(own(input, 'estimatedCostUsd')) : null;
  const row = {id, startedAt: timestamp(own(input, 'startedAt')),
    accountId: identifier(own(input, 'accountId'), ACCOUNT),
    accountEmail: typeof email === 'string' && email.length <= 320
      && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/u.test(email) ? email : null,
    provider: identifier(own(input, 'provider')) ?? 'unknown', model: identifier(own(input, 'model')) ?? 'unknown',
    source: enumValue(own(input, 'source'), SOURCES) ?? 'unknown', status,
    errorCode: enumValue(own(input, 'errorCode'), ERROR_CODES),
    finishReason: enumValue(own(input, 'finishReason'), FINISH_REASONS),
    httpStatus: Number.isInteger(http) && http >= 100 && http <= 599 ? http : null,
    serviceTierRequested: enumValue(own(input, 'serviceTierRequested'), TIERS),
    serviceTierReported: enumValue(own(input, 'serviceTierReported'), TIERS), usageEvidence,
    priceBasis, priceModel, estimatedCostUsd: cost, costBasis: cost === null ? 'unknown' : basis,
    cacheHitRate: usageEvidence !== 'unavailable' && metric(ratio) !== null && ratio <= 1 ? ratio : null,
    ttftMs: metric(own(input, 'ttftMs')), durationMs: metric(own(input, 'durationMs')), tps: metric(own(input, 'tps'))};
  for (const field of TOKEN_FIELDS) row[field] = usageEvidence === 'unavailable' ? null : count(own(input, field));
  return row;
}

// Keep this DTO and unknown/sample arithmetic aligned with telemetry-v026. The
// store counts terminal records only; running is deliberately always zero.
function emptySummary() {
  return {total: 0, running: 0, success: 0, error: 0, cancelled: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    avgTtftMs: null, avgDurationMs: null, avgTps: null, avgCacheHitRate: null,
    samples: {ttft: 0, tps: 0, cacheHitRate: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0},
    estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, upperBoundRequests: 0};
}
function accumulator() {
  const summary = emptySummary();
  let durations = 0;
  return {summary, add(row) {
    summary.total++;
    summary[row.status]++;
    for (const field of TOKEN_FIELDS) {
      const value = row[field];
      if (value === null) { if (summary.samples[field] === 0) summary[field] = null; }
      else if (summary.samples[field]++ === 0) summary[field] = value;
      else if (summary[field] !== null) summary[field] = count(summary[field] + value);
    }
    for (const [field, sample, value] of [
      ['avgTtftMs', 'ttft', row.ttftMs], ['avgDurationMs', 'duration', row.durationMs],
      ['avgTps', 'tps', row.tps], ['avgCacheHitRate', 'cacheHitRate', row.cacheHitRate],
    ]) {
      if (value === null) continue;
      const n = sample === 'duration' ? ++durations : ++summary.samples[sample];
      summary[field] = n === 1 ? value : summary[field] + (value - summary[field]) / n;
    }
    if (row.estimatedCostUsd === null) summary.unpricedRequests++;
    else {
      const sum = (summary.estimatedCostUsd ?? 0) + row.estimatedCostUsd;
      summary.estimatedCostUsd = summary.estimatedCostUsd !== null && Number.isFinite(sum) ? sum : null;
      summary.pricedRequests++;
      if (row.costBasis === 'upper-bound') summary.upperBoundRequests++;
    }
  }};
}
function normalizeFilters(input = {}) {
  const result = {};
  for (const key of ['status', 'model', 'source', 'accountId']) {
    const value = own(input, key);
    if (value === undefined || value === null || value === '') continue;
    const valid = key === 'status' ? enumValue(value, FILTER_STATUSES) : key === 'source'
      ? enumValue(value, SOURCES) : identifier(value, key === 'accountId' ? ACCOUNT : MODEL);
    if (!valid) throw safeError('log-store-invalid-filter');
    result[key] = valid;
  }
  return result;
}
const matches = (row, filters) => Object.entries(filters).every(([key, value]) => row[key] === value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * A single append-only file, no retention policy or index proportional to history.
 * Test options can shrink blockSize and inject fs; production callers only need
 * an explicit absolute profileDir. No environment or current-directory fallback.
 */
export function createLogStore({profileDir, pageSize = 50, blockSize = 64 * 1024,
  maxRowBytes = 16 * 1024, maxPending = 256, maxReaders = 16, fs = nativeFs} = {}) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || profileDir.includes('\0')) throw safeError('invalid-log-profile-dir');
  for (const [value, low, high] of [[pageSize, 1, 50], [blockSize, 8, 256 * 1024],
    [maxRowBytes, 4096, 64 * 1024], [maxPending, 1, 4096], [maxReaders, 1, 128]]) {
    if (!Number.isSafeInteger(value) || value < low || value > high) throw safeError('invalid-log-store-options');
  }
  let root = path.resolve(profileDir), directory = path.join(root, '.dsh-cpa');
  let filename = path.join(directory, 'activity.ndjson');
  const secret = randomBytes(32);
  let handle, rootStat, directoryStat, identity, generation = 0, knownSize = 0, committedEnd = 0;
  let available = false, corrupt = false, overloaded = false, closing = false;
  let pending = 0, readers = 0, aggregate = accumulator(), clearPending = null, disposePending;
  const exports = new Set();
  const storage = () => ({available: available && !closing,
    error: closing ? 'log-store-disposed' : !available ? 'log-storage-unavailable'
      : corrupt ? 'log-storage-corrupt' : overloaded ? 'log-store-busy' : null});
  function failStorage() { available = false; return safeError('log-storage-unavailable'); }
  function check(g, signal, allowClosing = false) {
    if (g !== generation) throw safeError('log-store-cleared');
    if (!allowClosing && closing) throw safeError('log-store-disposed');
    if (signal?.aborted) throw safeError('log-store-aborted');
  }
  function warning(g) { if (g === generation) corrupt = true; }
  async function verifyFile() {
    try {
      const [a, b, file, opened] = await Promise.all([
        fs.lstat(root), fs.lstat(directory), fs.lstat(filename), handle.stat(),
      ]);
      if (!a.isDirectory() || a.isSymbolicLink() || !sameFile(a, rootStat)
        || !b.isDirectory() || b.isSymbolicLink() || !sameFile(b, directoryStat)
        || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1
        || !opened.isFile() || opened.nlink !== 1 || !sameFile(file, identity) || !sameFile(opened, identity)
        || !samePath(await fs.realpath(directory), directory)) throw new Error();
    } catch { throw failStorage(); }
  }
  async function readAt(buffer, length, position, g, signal, allowClosing = false) {
    let offset = 0;
    while (offset < length) {
      check(g, signal, allowClosing);
      let bytesRead;
      try { ({bytesRead} = await handle.read(buffer, offset, length - offset, position + offset)); }
      catch { throw failStorage(); }
      check(g, signal, allowClosing);
      if (!bytesRead) throw failStorage();
      offset += bytesRead;
    }
  }
  function parse(bytes, g) {
    if (!bytes.length) { warning(g); return null; }
    try {
      const row = displayRow(JSON.parse(utf8.decode(bytes)), true);
      if (!row) warning(g);
      return row;
    } catch { warning(g); return null; }
  }
  // Both scanners hold at most one block and one bounded line. A many-gigabyte
  // invalid line is skipped, never concatenated or passed to JSON.parse.
  async function* forward(end, g, signal, allowClosing = false) {
    const block = Buffer.allocUnsafe(blockSize), line = Buffer.allocUnsafe(maxRowBytes);
    let used = 0, overflow = false, lineStart = 0;
    for (let position = 0; position < end;) {
      const length = Math.min(blockSize, end - position);
      await readAt(block, length, position, g, signal, allowClosing);
      for (let i = 0; i < length; i++) {
        if (block[i] === 10) {
          const boundary = position + i + 1;
          const row = overflow ? (warning(g), null) : parse(line.subarray(0, used), g);
          yield {row, start: lineStart, end: boundary};
          lineStart = boundary; used = 0; overflow = false;
          check(g, signal, allowClosing);
        } else if (used < maxRowBytes) line[used++] = block[i];
        else overflow = true;
      }
      position += length;
    }
    if (used || overflow) warning(g); // A final newline is the commit marker.
  }
  async function* reverse(end, g) {
    if (!end) return;
    const block = Buffer.allocUnsafe(blockSize), line = Buffer.allocUnsafe(maxRowBytes);
    let used = 0, overflow = false, position = end - 1; // Skip final committed LF.
    while (position > 0) {
      const start = Math.max(0, position - blockSize), length = position - start;
      await readAt(block, length, start, g);
      for (let i = length - 1; i >= 0; i--) {
        if (block[i] === 10) {
          const row = overflow ? (warning(g), null) : parse(line.subarray(maxRowBytes - used), g);
          yield {row, start: start + i + 1};
          used = 0; overflow = false; check(g);
        } else if (used < maxRowBytes) line[maxRowBytes - 1 - used++] = block[i];
        else overflow = true;
      }
      position = start;
    }
    const row = overflow ? (warning(g), null) : parse(line.subarray(maxRowBytes - used), g);
    yield {row, start: 0};
  }
  async function initialize() {
    let opened;
    try {
      rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
      // A Windows 8.3 alias is not a symlink. Reject actual links in the supplied
      // ancestry before canonicalizing aliases, then pin the canonical identity.
      for (let ancestor = root;; ancestor = path.dirname(ancestor)) {
        const stat = await fs.lstat(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        if (path.dirname(ancestor) === ancestor) break;
      }
      const canonical = await fs.realpath(root);
      if (!sameFile(await fs.lstat(canonical), rootStat)) throw new Error();
      root = canonical; directory = path.join(root, '.dsh-cpa');
      filename = path.join(directory, 'activity.ndjson');
      try { await fs.mkdir(directory, {mode: 0o700}); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw new Error();
      let before;
      try { before = await fs.lstat(filename); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error();
      const flags = constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
        | (before ? 0 : constants.O_CREAT | constants.O_EXCL);
      opened = await fs.open(filename, flags, 0o600);
      identity = await opened.stat(); handle = opened;
      if (!identity.isFile() || identity.nlink !== 1 || before && !sameFile(before, identity)) throw new Error();
      await verifyFile();
      if (process.platform !== 'win32') {
        // Only the owned directory/file, never the profile directory.
        const dirHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (!sameFile(await dirHandle.stat(), directoryStat)) throw new Error();
          await dirHandle.chmod(0o700);
        } finally { await dirHandle.close(); }
        await handle.chmod(0o600);
        await verifyFile();
      }
      if (!Number.isSafeInteger(identity.size) || identity.size < 0) throw new Error();
      knownSize = identity.size;
      const g = generation, rebuilt = accumulator();
      // Startup is allowed to finish during dispose so accepted appends can flush.
      for await (const item of forward(knownSize, g, undefined, true)) {
        committedEnd = item.end;
        if (item.row) rebuilt.add(item.row);
      }
      const after = await handle.stat();
      if (after.size !== knownSize) throw new Error();
      if (g === generation && !clearPending) aggregate = rebuilt;
      available = true;
    } catch (error) {
      if (error?.code === 'log-store-cleared' && handle) {
        // clear() was called during startup; its queued truncate owns the new era.
        available = true;
      } else {
        available = false;
        if (opened) { try { await opened.close(); } catch {} }
        handle = undefined;
      }
    }
  }
  const ready = initialize();
  let queue = ready;
  function enqueue(work) {
    const task = queue.then(work);
    queue = task.catch(() => {}); // A failed write cannot poison the serial queue.
    return task;
  }
  async function writeBytes(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      let bytesWritten;
      try { ({bytesWritten} = await handle.write(bytes, offset, bytes.length - offset)); }
      catch { throw failStorage(); }
      if (!bytesWritten) throw failStorage();
      offset += bytesWritten; knownSize += bytesWritten;
    }
  }
  async function sync() {
    try { await handle.sync(); } catch { throw failStorage(); }
  }
  function append(input) {
    if (closing) return Promise.reject(safeError('log-store-disposed'));
    if (pending >= maxPending) { overloaded = true; return Promise.reject(safeError('log-store-busy')); }
    const row = displayRow(input);
    if (!row) return Promise.reject(safeError('log-store-invalid-row'));
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    if (bytes.length > maxRowBytes) return Promise.reject(safeError('log-store-invalid-row'));
    const g = generation;
    pending++;
    return enqueue(async () => {
      try {
        check(g, undefined, true);
        if (!available || !handle) throw safeError('log-storage-unavailable');
        await verifyFile(); check(g, undefined, true);
        if ((await handle.stat()).size !== knownSize) throw failStorage();
        check(g, undefined, true);
        if (knownSize !== committedEnd) {
          // Never truncate an uncommitted tail or accidentally commit valid JSON
          // from a crashed write. A NUL makes that entire tail unparseable.
          warning(g); await writeBytes(Buffer.from('\0\n'));
          committedEnd = knownSize;
        }
        check(g, undefined, true);
        await writeBytes(bytes); await sync();
        committedEnd = knownSize;
        check(g, undefined, true);
        aggregate.add(row);
      } catch (error) {
        if (error instanceof LogStoreError) throw error;
        throw failStorage();
      } finally { pending--; }
    });
  }
  function signCursor(offset, end, filters, g) {
    const payload = Buffer.from(JSON.stringify({v: 1, g, o: offset, e: end,
      f: createHash('sha256').update(JSON.stringify(filters)).digest('base64url')})).toString('base64url');
    return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  }
  function decodeCursor(value, filters, g) {
    try {
      if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
      const [payload, signature] = value.split('.');
      const expected = createHmac('sha256', secret).update(payload).digest();
      const received = Buffer.from(signature, 'base64url');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.g !== g || !Number.isSafeInteger(cursor.o) || !Number.isSafeInteger(cursor.e)
        || cursor.o < 0 || cursor.o > cursor.e || cursor.e > committedEnd
        || cursor.f !== createHash('sha256').update(JSON.stringify(filters)).digest('base64url')) throw new Error();
      return cursor;
    } catch { throw safeError('log-store-invalid-cursor'); }
  }
  function reserveReader() {
    if (readers >= maxReaders) throw safeError('log-store-busy');
    readers++;
    let released = false;
    return () => { if (!released) { released = true; readers--; } };
  }
  async function page(input = {}) {
    const g = generation, barrier = queue, filters = normalizeFilters(input);
    const value = own(input, 'cursor');
    if (value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || value.length > 512)) throw safeError('log-store-invalid-cursor');
    const limit = own(input, 'limit') ?? pageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw safeError('log-store-invalid-filter');
    check(g);
    const release = reserveReader();
    try {
      await barrier; check(g);
      const cursor = value === undefined || value === null || value === '' ? null : decodeCursor(value, filters, g);
      if (!available || !handle) return {entries: [], page: {nextCursor: null}, storage: storage()};
      const end = cursor?.e ?? committedEnd, offset = cursor?.o ?? end;
      await verifyFile(); check(g);
      if (filters.status === 'running') return {entries: [], page: {nextCursor: null}, storage: storage()};
      const entries = [];
      let nextCursor = null, before = offset;
      for await (const item of reverse(offset, g)) {
        if (!item.row || !matches(item.row, filters)) continue;
        if (entries.length === limit) { nextCursor = signCursor(before, end, filters, g); break; }
        entries.push(item.row); before = item.start;
      }
      check(g);
      return {entries, page: {nextCursor}, storage: storage()};
    } finally { release(); }
  }
  function exportRows(input = {}, {signal} = {}) {
    const filters = normalizeFilters(input), g = generation, barrier = queue;
    check(g, signal);
    const release = reserveReader();
    const snapshotEnd = barrier.then(() => { check(g, signal); return filters.status === 'running' ? 0 : committedEnd; });
    snapshotEnd.catch(() => {}); // An abandoned/cleared stream must not reject unhandled.
    let iterator, controller, finished = false;
    function finish(error) {
      if (finished) return;
      finished = true; exports.delete(state); signal?.removeEventListener('abort', aborted); release();
      if (error) { try { controller.error(error); } catch {} }
      try { iterator?.return().catch(() => {}); } catch {}
    }
    const state = {stop: code => finish(safeError(code))};
    const aborted = () => state.stop('log-store-aborted');
    const stream = new ReadableStream({
      start(value) {
        controller = value; exports.add(state);
        signal?.addEventListener('abort', aborted, {once: true});
        if (signal?.aborted) aborted();
      },
      async pull() {
        if (finished) return;
        try {
          if (!iterator) {
            const end = await snapshotEnd; check(g, signal);
            if (!available || !handle) throw safeError('log-storage-unavailable');
            await verifyFile(); check(g, signal);
            iterator = forward(end, g, signal)[Symbol.asyncIterator]();
          }
          while (!finished) {
            const item = await iterator.next(); check(g, signal);
            if (finished) return;
            if (item.done) { finish(); controller.close(); return; }
            if (!item.value.row || !matches(item.value.row, filters)) continue;
            controller.enqueue(Buffer.from(JSON.stringify(item.value.row) + '\n'));
            return;
          }
        } catch (error) {
          finish(error instanceof LogStoreError ? error : failStorage());
        }
      },
      async cancel() { finish(); try { await iterator?.return(); } catch {} },
    }, {highWaterMark: 0}); // No prefetch/whole-history buffering for idle downloads.
    return stream;
  }
  function stopExports(code) { for (const state of exports) state.stop(code); }
  function clear() {
    if (closing) return Promise.reject(safeError('log-store-disposed'));
    generation++; aggregate = accumulator(); stopExports('log-store-cleared');
    // Coalesce repeated clear calls, rather than building an unbounded clear queue.
    if (clearPending) return clearPending;
    const task = enqueue(async () => {
      if (!handle) throw safeError('log-storage-unavailable');
      await verifyFile();
      // Windows grants FILE_APPEND_DATA (not truncate permission) to O_APPEND
      // handles. Reopen without O_APPEND, verify the SAME pinned regular file,
      // and only then truncate; never unlink or open with O_TRUNC before checks.
      let truncateHandle;
      try {
        truncateHandle = await fs.open(filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        const opened = await truncateHandle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, identity)) throw failStorage();
        await verifyFile();
        await truncateHandle.truncate(0);
      } catch (error) {
        if (error instanceof LogStoreError) throw error;
        throw failStorage();
      } finally {
        if (truncateHandle) { try { await truncateHandle.close(); } catch { throw failStorage(); } }
      }
      knownSize = 0; committedEnd = 0; aggregate = accumulator();
      await sync(); available = true; corrupt = false; overloaded = false;
    });
    clearPending = task.finally(() => { clearPending = null; });
    return clearPending;
  }
  function dispose() {
    if (disposePending) return disposePending;
    closing = true; stopExports('log-store-disposed');
    disposePending = queue.then(async () => {
      let failure;
      try { if (handle) await sync(); } catch { failure = safeError('log-storage-unavailable'); }
      try { if (handle) await handle.close(); } catch { failure = safeError('log-storage-unavailable'); }
      finally { handle = undefined; available = false; }
      if (failure) throw failure;
    });
    return disposePending;
  }
  return {ready, append, page, export: exportRows, clear, dispose,
    snapshot: () => ({summary: {...aggregate.summary, samples: {...aggregate.summary.samples}}, storage: storage()})};
}

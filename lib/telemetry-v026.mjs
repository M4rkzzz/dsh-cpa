import {AsyncLocalStorage} from 'node:async_hooks';
import {estimateCost, PRICING_INFO} from './pricing-v024.mjs';
import {readEvidence} from './evidence-v026.mjs';

// Observe the public llm/stream waterfall without changing transport, requests,
// backpressure or cancellation. Only detached, bounded numeric metadata survives.
const MAX_LIMIT = 1000;
const ERROR_CODES = new Set([
  'AUTH', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED', 'NETWORK',
  'TIMEOUT', 'CANCELLED', 'ABORTED', 'UNKNOWN', 'STREAM_CLOSED', 'EMPTY_RESPONSE',
  'QUOTA', 'INVALID_REQUEST', 'SERVER', 'TRANSPORT', 'PI_AI_ERROR', 'MALFORMED_RESPONSE',
  // Public dsh-llm / PiAiAdapter codes, not arbitrary provider error text.
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
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const nonempty = value => typeof value === 'string' && value.length > 0;
const safeModel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(value) ? value : 'unknown';
const emptySummary = () => ({total: 0, running: 0, success: 0, error: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, avgTtftMs: null, avgDurationMs: null,
  avgTps: null, avgCacheHitRate: null, samples: {ttft: 0, tps: 0, cacheHitRate: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0},
  estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, upperBoundRequests: 0});

function safeErrorCode(error, fallback = 'UNKNOWN') {
  for (const candidate of [error?.failure?.code, error?.code]) if (ERROR_CODES.has(candidate)) return candidate;
  if (error?.name === 'AbortError') return 'CANCELLED';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  return fallback;
}
function tokenDelta(chunk) {
  const type = ownValue(chunk, 'type');
  // The bundled public adapter emits `text`; accept `delta` from compatible
  // Host stream producers too, without rewriting or retaining their chunks.
  if (type === 'text-delta' || type === 'reasoning-delta') {
    return nonempty(ownValue(chunk, 'text')) || nonempty(ownValue(chunk, 'delta'));
  }
  // dsh-llm.isTokenDelta counts an argumentsDelta fragment or a supplied tool
  // name, not the correlation id. pi-ai supplies name only when nonempty.
  return type === 'tool-call-delta' && (nonempty(ownValue(chunk, 'argumentsDelta')) || nonempty(ownValue(chunk, 'name')));
}

const metricFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const missingMetrics = () => ({inputTokens: null, outputTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, cacheHitRate: null, usageEvidence: 'unavailable'});
function ownValue(value, key) {
  try { return object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
  catch { return undefined; }
}

// Legacy Host input excludes cache. Its native parser already replaced missing
// fields with zero before the Host omitted zero cache fields. Totals therefore
// cannot prove those zeroes: only positive normalized counters are evidence.
function usageMetrics(usage) {
  const positive = value => count(value) > 0 ? value : null;
  const input = positive(ownValue(usage, 'inputTokens')), output = positive(ownValue(usage, 'outputTokens'));
  const total = positive(ownValue(usage, 'totalTokens'));
  const read = positive(ownValue(usage, 'cacheReadTokens')), write = positive(ownValue(usage, 'cacheWriteTokens'));
  const invalid = [...metricFields, 'totalTokens'].some(field => {
    const value = ownValue(usage, field);
    return value !== undefined && value !== null && count(value) === null;
  });
  if ([input, output, total, read, write].every(value => value === null)) return {values: missingMetrics(), invalid};
  let prompt = null;
  // Even total === output cannot prove zero input: Host totals were themselves
  // computed after missing raw counters had already become zero.
  if (total !== null && output !== null && total > output) prompt = total - output;
  else if (input !== null && read !== null && write !== null) prompt = count(input + read + write);
  if (prompt !== null) {
    const minimum = (input ?? 0) + (read ?? 0) + (write ?? 0);
    if (!Number.isSafeInteger(minimum) || minimum > prompt
      || (input !== null && read !== null && write !== null && minimum !== prompt)) prompt = null;
  }
  return {values: {inputTokens: prompt, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
    cacheHitRate: !invalid && prompt !== null && prompt > 0 && read !== null && read <= prompt ? read / prompt : null,
    usageEvidence: 'host-normalized'}, invalid};
}

// A raw-provider input count is already the full prompt. Preserve known zeros
// and missing field presence, and never fall back to normalized Host defaults.
function providerMetrics(proof) {
  if (!proof.usageReported) return {values: missingMetrics(), invalid: false};
  const input = proof.inputTokens, output = proof.outputTokens, read = proof.cacheReadTokens, write = proof.cacheWriteTokens;
  let invalid = [...metricFields, 'totalTokens'].some(field => proof.fields[field] === 'invalid');
  if (input !== null && output !== null) {
    const sum = input + output;
    if (!Number.isSafeInteger(sum) || proof.totalTokens !== null && proof.totalTokens !== sum) invalid = true;
  }
  if (input !== null && ((read ?? 0) > input || (write ?? 0) > input - (read ?? 0))) invalid = true;
  return {values: {inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
    cacheHitRate: !invalid && input !== null && input > 0 && read !== null ? read / input : null,
    usageEvidence: 'provider'}, invalid};
}

// Node 22/24 require the Performance receiver; a detached performance.now throws
// ERR_INVALID_THIS and would silently turn every elapsed metric into null.
export function createTelemetry(ctx, {limit = 200, now = () => performance.now(), dateNow = Date.now, onRecord} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('invalid-telemetry-limit');
  if (typeof now !== 'function' || typeof dateNow !== 'function') throw new TypeError('invalid-telemetry-clock');
  if (onRecord !== undefined && typeof onRecord !== 'function') throw new TypeError('invalid-telemetry-sink');
  let entries = [], summary = emptySummary(), durationSamples = 0, generation = 0, sequence = 0;
  let disposed = false, available = false, unhook;
  // A probe's actual dispatch/iterator context identifies its SDK chain. A
  // shared signal, model, or reused options object never identifies a request.
  const probes = new AsyncLocalStorage(), listeners = new Map();
  const providers = new Map([['openai-codex', 1]]);
  // Policy counters are scalar-only and independent of display retention/clear.
  // No options, signals, credentials or request objects are retained here.
  const conversations = new Map();
  const recording = {pending: 0, failed: 0, error: null};
  const timestamp = () => {
    try { return new Date(dateNow()).toISOString(); } catch { return null; }
  };
  const monotonic = () => {
    try { const value = now(); return typeof value === 'number' && Number.isFinite(value) ? value : null; } catch { return null; }
  };
  let since = timestamp();
  const elapsed = (start, end) => {
    const value = start !== null && end !== null ? end - start : NaN;
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  function mean(field, sample, value) {
    if (value === null || !Number.isFinite(value)) return;
    const n = sample === 'duration' ? ++durationSamples : ++summary.samples[sample];
    summary[field] = n === 1 ? value : summary[field] + (value - summary[field]) / n;
  }
  function addTokens(field, value) {
    if (value === null) { if (summary.samples[field] === 0) summary[field] = null; return; }
    const samples = summary.samples[field]++;
    if (samples === 0) summary[field] = value;
    else if (summary[field] !== null) summary[field] = count(summary[field] + value);
  }
  function record(entry) {
    if (!onRecord) return;
    recording.pending++;
    const failed = () => { recording.pending--; recording.failed++; recording.error = 'record-write-failed'; };
    try {
      // Invoke now so a store can capture its clear generation, but never await
      // its disk work. Observe both synchronous throws and promise rejections.
      Promise.resolve(onRecord({...entry})).then(() => { recording.pending--; }, failed);
    } catch { failed(); }
  }
  function price(request, invalid = false) {
    const cost = invalid || request.entry.usageEvidence === 'unavailable'
      ? {usd: null, kind: 'unknown', priceModel: null} : estimateCost(request.entry);
    request.entry.estimatedCostUsd = cost.usd;
    request.entry.costBasis = cost.kind;
    request.entry.priceModel = cost.priceModel;
  }
  function applyEvidence(request, value) {
    const proof = readEvidence(value);
    if (!proof) return;
    request.hasEvidence = true;
    if (request.evidenceConflict || request.evidenceId && request.evidenceId !== proof.evidenceId) {
      request.evidenceConflict = true;
      Object.assign(request.entry, missingMetrics(), {accountId: null, accountEmail: null, httpStatus: null,
        serviceTierRequested: null, serviceTierReported: null});
      price(request, true);
      return;
    }
    request.evidenceId = proof.evidenceId;
    Object.assign(request.entry, {accountId: proof.accountId, accountEmail: proof.accountEmail,
      httpStatus: proof.httpStatus, serviceTierRequested: proof.serviceTierRequested, serviceTierReported: proof.serviceTierReported});
    const metrics = providerMetrics(proof);
    Object.assign(request.entry, metrics.values);
    price(request, metrics.invalid);
  }
  function metadata(options, source) {
    // Do not retain options/messages, session identity, headers or the raw error.
    try {
      const accountId = source === 'pelican' && typeof options?.accountId === 'string'
        && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(options.accountId) ? options.accountId : null;
      const email = source === 'pelican' ? options?.accountEmail : null;
      const accountEmail = typeof email === 'string' && email.length <= 320 && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/u.test(email) ? email : null;
      return {model: safeModel(options?.model), provider: safeModel(options?.provider), signal: options?.signal, accountId, accountEmail};
    }
    catch { return {model: 'unknown', provider: 'unknown', signal: undefined}; }
  }
  function watching(request) { return !disposed && request.generation === generation && !request.ended; }
  function begin(meta, source) {
    if (disposed) return null;
    const entry = {id: 'cpa-' + (++sequence), source, startedAt: timestamp(),
      provider: meta.provider, model: meta.model, accountId: meta.accountId ?? null, accountEmail: meta.accountEmail ?? null,
      status: 'running', finishReason: null, httpStatus: null, errorCode: null,
      serviceTierRequested: null, serviceTierReported: null, usageEvidence: 'unavailable',
      priceBasis: 'openai-standard-reference', priceModel: null,
      cacheHitRate: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      estimatedCostUsd: null, costBasis: 'unknown', ttftMs: null, durationMs: null, tps: null};
    const request = {entry, generation, ended: false, start: monotonic(), firstSeen: false, firstToken: null};
    entries.unshift(entry);
    if (entries.length > limit) {
      const removed = entries.pop();
      detach(removed.id);
    }
    summary.total++;
    summary.running++;
    // Abort listeners are bounded by the same ring as retained rows. Evicted
    // streams still account their eventual terminal result through their caller's
    // iterator, without a global registry retaining all in-flight requests.
    try {
      if (typeof meta.signal?.addEventListener === 'function') {
        const onAbort = () => {
          try { cancelled(request, meta.signal); } catch { finish(request, 'cancelled', 'CANCELLED'); }
        };
        listeners.set(entry.id, () => meta.signal.removeEventListener('abort', onAbort));
        meta.signal.addEventListener('abort', onAbort, {once: true});
        if (meta.signal.aborted) onAbort();
      }
    } catch { detach(entry.id); }
    return request;
  }
  function detach(id) {
    const cleanup = listeners.get(id);
    listeners.delete(id);
    try { cleanup?.(); } catch {}
  }
  function cancelled(request, signal) {
    const reason = signal?.reason;
    const errorStop = ['Error', 'TypeError', 'RangeError', 'TimeoutError'].includes(reason?.name);
    const code = safeErrorCode(reason, errorStop ? 'UNKNOWN' : 'CANCELLED');
    const failed = errorStop || code === 'TIMEOUT' || (code.startsWith('pelican-') && code !== 'pelican-cancelled');
    finish(request, failed ? 'error' : 'cancelled', code);
  }
  function finish(request, status, errorCode = null, httpStatus = null) {
    if (!request || !watching(request)) return;
    request.ended = true;
    detach(request.entry.id);
    const entry = request.entry, end = monotonic();
    entry.status = status;
    entry.errorCode = errorCode;
    if (entry.httpStatus === null) entry.httpStatus = httpStatus;
    entry.durationMs = elapsed(request.start, end);
    const generating = entry.durationMs !== null && entry.ttftMs !== null ? entry.durationMs - entry.ttftMs : null;
    entry.tps = generating !== null && generating > 0 && entry.outputTokens !== null
      ? entry.outputTokens / (generating / 1000) : null;
    if (!Number.isFinite(entry.tps)) entry.tps = null;
    summary.running--;
    summary[status]++;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) addTokens(field, entry[field]);
    if (entry.estimatedCostUsd !== null) {
      summary.estimatedCostUsd += entry.estimatedCostUsd;
      summary.pricedRequests++;
      if (entry.costBasis === 'upper-bound') summary.upperBoundRequests++;
    } else summary.unpricedRequests++;
    mean('avgTtftMs', 'ttft', entry.ttftMs);
    mean('avgDurationMs', 'duration', entry.durationMs);
    mean('avgTps', 'tps', entry.tps);
    mean('avgCacheHitRate', 'cacheHitRate', entry.cacheHitRate);
    record(entry);
  }
  function failed(request, error, signal) {
    if (request && watching(request)) applyEvidence(request, error);
    if (signal?.aborted === true) return cancelled(request, signal);
    const aborted = error?.name === 'AbortError';
    finish(request, aborted ? 'cancelled' : 'error', safeErrorCode(error, aborted ? 'CANCELLED' : 'UNKNOWN'),
      statusCode(error?.failure?.status));
  }
  function observe(request, chunk, signal) {
    if (!request || !watching(request)) return;
    applyEvidence(request, chunk);
    if (!request.firstSeen && tokenDelta(chunk)) {
      request.firstSeen = true;
      request.firstToken = monotonic();
      request.entry.ttftMs = elapsed(request.start, request.firstToken);
    }
    if (chunk?.type === 'usage' && !request.hasEvidence) {
      const metrics = usageMetrics(chunk.usage);
      Object.assign(request.entry, metrics.values);
      price(request, metrics.invalid);
    }
    if (chunk?.type !== 'finish') return;
    const reason = chunk.reason;
    if (['stop', 'tool-calls', 'max-tokens', 'error', 'aborted'].includes(reason?.kind)) request.entry.finishReason = reason.kind;
    if (signal?.aborted === true) cancelled(request, signal);
    else if (reason?.kind === 'aborted') {
      finish(request, 'cancelled', safeErrorCode(reason?.failure, 'CANCELLED'), statusCode(reason?.failure?.status));
    } else if (reason?.kind === 'error') {
      finish(request, 'error', safeErrorCode(reason?.failure), statusCode(reason?.failure?.status));
    } else if (['stop', 'tool-calls', 'max-tokens'].includes(reason?.kind)) finish(request, 'success');
    else finish(request, 'error', 'STREAM_CLOSED');
  }
  function tracked(meta, factory, source) {
    return (async function* () {
      const counted = !disposed && source === 'conversation';
      if (counted) conversations.set(meta.provider, (conversations.get(meta.provider) ?? 0) + 1);
      const request = begin(meta, source);
      let exhausted = false;
      try {
        for await (const chunk of factory()) {
          // Instrumentation is non-authoritative: malformed metadata must not
          // change chunk identity, throw into the consumer or stall the model.
          try { observe(request, chunk, meta.signal); } catch {}
          yield chunk;
        }
        exhausted = true;
      } catch (error) {
        try { failed(request, error, meta.signal); } catch { finish(request, 'error', 'UNKNOWN'); }
        throw error;
      } finally {
        if (counted) {
          const remaining = (conversations.get(meta.provider) ?? 1) - 1;
          if (remaining > 0) conversations.set(meta.provider, remaining); else conversations.delete(meta.provider);
        }
        if (request && watching(request)) {
          let aborted = false;
          try { aborted = meta.signal?.aborted === true; } catch {}
          if (aborted) {
            try { cancelled(request, meta.signal); } catch { finish(request, 'cancelled', 'CANCELLED'); }
          } else finish(request, exhausted ? 'error' : 'cancelled', exhausted ? 'STREAM_CLOSED' : 'CANCELLED');
        }
      }
    })();
  }
  function probeChain(factory, mark) {
    // Async generators execute on next(), not construction. Enter the private
    // call context for every iterator operation, including delayed SDK dispatch.
    return {
      [Symbol.asyncIterator]() {
        const iterable = probes.run(mark, factory);
        const iterator = probes.run(mark, () => iterable[Symbol.asyncIterator]());
        const wrapped = {[Symbol.asyncIterator]() { return this; },
          next(value) { return probes.run(mark, () => iterator.next(value)); }};
        if (typeof iterator.return === 'function') wrapped.return = value => probes.run(mark, () => iterator.return(value));
        if (typeof iterator.throw === 'function') wrapped.throw = error => probes.run(mark, () => iterator.throw(error));
        return wrapped;
      },
    };
  }
  try {
    if (typeof ctx?.on === 'function') {
      unhook = ctx.on('llm/stream', (options, next) => {
        if (disposed || !providers.has(ownValue(options, 'provider')) || probes.getStore()?.active) return next();
        const meta = metadata(options);
        // Preserve synchronous waterfall dispatch/adapter capture; only iteration
        // is lazy. Deferring next() could bind a different reconfigured adapter.
        let upstream;
        try { upstream = next(); } catch (error) {
          const request = begin(meta, 'conversation');
          try { failed(request, error, meta.signal); } catch { finish(request, 'error', 'UNKNOWN'); }
          throw error;
        }
        return tracked(meta, () => upstream, 'conversation');
      });
      available = true;
    }
  } catch { available = false; }
  function clear() {
    for (const id of listeners.keys()) detach(id);
    generation++;
    entries = [];
    summary = emptySummary();
    durationSamples = 0;
    since = timestamp();
  }
  return {
    snapshot() {
      return {available: available && !disposed, limit, since, pricing: structuredClone(PRICING_INFO),
        entries: entries.map(entry => ({...entry})), summary: {...summary, samples: {...summary.samples}}, recording: {...recording}};
    },
    clear,
    hasRunningConversation(provider) {return !disposed && typeof provider === 'string' && (conversations.get(provider) ?? 0) > 0;},
    registerProvider(providerId) {
      if (typeof providerId !== 'string' || !/^cpa-codex-[a-z0-9][a-z0-9._:-]{0,159}$/i.test(providerId)) throw new TypeError('invalid-telemetry-provider');
      if (disposed) return () => {};
      providers.set(providerId, (providers.get(providerId) ?? 0) + 1);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const remaining = (providers.get(providerId) ?? 0) - 1;
        if (remaining > 0) providers.set(providerId, remaining); else providers.delete(providerId);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      providers.clear();
      conversations.clear();
      try { if (typeof unhook === 'function') unhook(); } catch {} finally { unhook = undefined; clear(); }
    },
    observeProbe(options, factory) {
      const meta = metadata(options, 'pelican');
      if (disposed || !providers.has(meta.provider)) return (async function* () { yield* factory(); })();
      const mark = {active: true};
      const stream = tracked(meta, () => probeChain(factory, mark), 'pelican');
      return (async function* () {
        try { yield* stream; } finally { mark.active = false; }
      })();
    },
  };
}

import {estimateCost, PRICING_INFO} from './pricing-v024.mjs';

// Observe the public llm/stream waterfall without changing transport, requests,
// backpressure or cancellation. Only detached, bounded numeric metadata survives.
const MAX_LIMIT = 1000;
const ERROR_CODES = new Set([
  'AUTH', 'RATE_LIMIT', 'QUOTA_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED', 'NETWORK',
  'TIMEOUT', 'CANCELLED', 'UNKNOWN', 'STREAM_CLOSED', 'EMPTY_RESPONSE',
  'NO_ADAPTER', 'INVALID_CREDENTIAL', 'IMAGE_OFFLOAD_REQUIRED', 'INVALID_CONFIG',
  'INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT', 'UNSUPPORTED_REASONING_EFFORT',
  'pelican-timeout', 'pelican-cancelled', 'pelican-output-limit', 'pelican-invalid-svg',
  'pelican-invalid-stream', 'pelican-stream-closed', 'pelican-tool-call',
  'pelican-max-tokens', 'pelican-generation-failed',
]);
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const nonempty = value => typeof value === 'string' && value.length > 0;
const safeModel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(value) ? value : 'unknown';
const emptySummary = () => ({total: 0, running: 0, success: 0, error: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, avgTtftMs: null, avgDurationMs: null,
  avgTps: null, avgCacheHitRate: null, samples: {ttft: 0, tps: 0, cacheHitRate: 0},
  estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, upperBoundRequests: 0});

function safeErrorCode(error, fallback = 'UNKNOWN') {
  for (const candidate of [error?.failure?.code, error?.code]) if (ERROR_CODES.has(candidate)) return candidate;
  if (error?.name === 'AbortError') return 'CANCELLED';
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  return fallback;
}
function tokenDelta(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return nonempty(chunk.text);
  // dsh-llm.isTokenDelta counts an argumentsDelta fragment or a supplied tool
  // name, not the correlation id. pi-ai supplies name only when nonempty.
  return chunk?.type === 'tool-call-delta' && (nonempty(chunk.argumentsDelta) || nonempty(chunk.name));
}

// Codex/pi-ai reports inputTokens EXCLUDING cached reads/writes. totalTokens is
// the upstream total (including cache and output), not inputTokens+outputTokens.
// Missing cache fields are not automatically zero: the adapter suppresses zeros
// and the seam cannot distinguish them from unexposed upstream accounting.
function usageMetrics(usage) {
  const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
  const total = count(usage?.totalTokens), read = count(usage?.cacheReadTokens), write = count(usage?.cacheWriteTokens);
  const badCache = (usage?.cacheReadTokens !== undefined && read === null)
    || (usage?.cacheWriteTokens !== undefined && write === null);
  let prompt = null;
  if (total !== null && output !== null) {
    if (total >= output) prompt = total - output;
  } else if (input !== null && read !== null && write !== null) {
    prompt = count(input + read + write);
  }
  if (prompt !== null) {
    const knownMinimum = (input ?? 0) + (read ?? 0) + (write ?? 0);
    if (knownMinimum > prompt || (input !== null && read !== null && write !== null && knownMinimum !== prompt)) prompt = null;
  }
  let cacheRead = read, cacheWrite = write;
  // Prove a missing read count is zero only when cumulative total accounting
  // leaves no tokens for it. Never assign an unexplained gap to cache reads.
  if (!badCache && cacheRead === null && prompt !== null && input !== null
    && prompt === input + (write ?? 0)) cacheRead = 0;
  if (!badCache && cacheWrite === null && prompt !== null && input !== null
    && prompt === input + (read ?? 0)) cacheWrite = 0;
  return {inputTokens: prompt, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    cacheHitRate: !badCache && prompt !== null && prompt > 0 && cacheRead !== null && cacheRead <= prompt ? cacheRead / prompt : null};
}

export function createTelemetry(ctx, {limit = 200, now = performance.now, dateNow = Date.now} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('invalid-telemetry-limit');
  if (typeof now !== 'function' || typeof dateNow !== 'function') throw new TypeError('invalid-telemetry-clock');
  let entries = [], summary = emptySummary(), durationSamples = 0, generation = 0, sequence = 0;
  let disposed = false, available = false, unhook;
  const probeOptions = new WeakSet(), probeSignals = new WeakSet(), listeners = new Map();
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
  function metadata(options) {
    // Do not retain options/messages, session identity, headers or the raw error.
    try { return {model: safeModel(options?.model), signal: options?.signal}; }
    catch { return {model: 'unknown', signal: undefined}; }
  }
  function watching(request) { return !disposed && request.generation === generation && !request.ended; }
  function begin(meta, source) {
    if (disposed) return null;
    const entry = {id: 'cpa-' + (++sequence), source, startedAt: timestamp(), endedAt: null,
      model: meta.model, status: 'running', httpStatus: null, errorCode: null,
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
    entry.httpStatus = httpStatus;
    entry.endedAt = timestamp();
    entry.durationMs = elapsed(request.start, end);
    const generating = entry.durationMs !== null && entry.ttftMs !== null ? entry.durationMs - entry.ttftMs : null;
    entry.tps = generating !== null && generating > 0 && entry.outputTokens !== null
      ? entry.outputTokens / (generating / 1000) : null;
    if (!Number.isFinite(entry.tps)) entry.tps = null;
    summary.running--;
    summary[status]++;
    if (entry.inputTokens !== null) summary.inputTokens += entry.inputTokens;
    if (entry.outputTokens !== null) summary.outputTokens += entry.outputTokens;
    if (entry.estimatedCostUsd !== null) {
      summary.estimatedCostUsd += entry.estimatedCostUsd;
      summary.pricedRequests++;
      if (entry.costBasis === 'upper-bound') summary.upperBoundRequests++;
    } else summary.unpricedRequests++;
    mean('avgTtftMs', 'ttft', entry.ttftMs);
    mean('avgDurationMs', 'duration', entry.durationMs);
    mean('avgTps', 'tps', entry.tps);
    mean('avgCacheHitRate', 'cacheHitRate', entry.cacheHitRate);
  }
  function failed(request, error, signal) {
    if (signal?.aborted === true) return cancelled(request, signal);
    const aborted = error?.name === 'AbortError';
    finish(request, aborted ? 'cancelled' : 'error', safeErrorCode(error, aborted ? 'CANCELLED' : 'UNKNOWN'),
      statusCode(error?.failure?.status));
  }
  function observe(request, chunk, signal) {
    if (!request || !watching(request)) return;
    if (!request.firstSeen && tokenDelta(chunk)) {
      request.firstSeen = true;
      request.firstToken = monotonic();
      request.entry.ttftMs = elapsed(request.start, request.firstToken);
    }
    if (chunk?.type === 'usage') {
      Object.assign(request.entry, usageMetrics(chunk.usage));
      const cost = estimateCost(request.entry);
      request.entry.estimatedCostUsd = cost.usd;
      request.entry.costBasis = cost.kind;
    }
    if (chunk?.type !== 'finish') return;
    const reason = chunk.reason;
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
  function marked(options) {
    return object(options) && (probeOptions.has(options) || (object(options.signal) && probeSignals.has(options.signal)));
  }
  try {
    if (typeof ctx?.on === 'function') {
      unhook = ctx.on('llm/stream', (options, next) => {
        if (disposed || options?.provider !== 'openai-codex' || marked(options)) return next();
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
        entries: entries.map(entry => ({...entry})), summary: {...summary, samples: {...summary.samples}}};
    },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (typeof unhook === 'function') unhook(); } catch {} finally { unhook = undefined; clear(); }
    },
    observeProbe(options, factory) {
      if (object(options)) probeOptions.add(options);
      const meta = metadata(options);
      if (object(meta.signal)) probeSignals.add(meta.signal);
      return tracked(meta, factory, 'pelican');
    },
  };
}

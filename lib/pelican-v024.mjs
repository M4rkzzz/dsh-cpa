import {randomUUID} from 'node:crypto';

const PROMPT = '生成一张鹈鹕骑自行车的SVG';
const MAX_OUTPUT_BYTES = 256 * 1024;
const OWN_ERROR = Symbol('pelican-error');

function failure(code, name = 'Error') {
  return Object.assign(new Error(code), {code, name, [OWN_ERROR]: true});
}

function safeFailure(error, fallback) {
  return error?.[OWN_ERROR] ? error : failure(fallback);
}

// Settles even when a catalog lookup or iterator ignores cancellation. The losing
// promise remains observed, so a late provider rejection is never unhandled.
function interruptible(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => {cleanup(); reject(signal.reason);};
    signal.addEventListener('abort', aborted, {once: true});
    Promise.resolve(promise).then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {cleanup(); reject(error);});
    if (signal.aborted) aborted();
  });
}

function extractSvg(text) {
  // This is extraction, not sanitization. The result is untrusted text only and
  // must never be executed, mounted as HTML, or handed to an attachment service.
  const match = text.match(/<svg\b[^>]*>[\s\S]*<\/svg\s*>/i) ?? text.match(/<svg\b[^>]*\/\s*>/i);
  return match?.[0] ?? null;
}

export function createPelican({llm, telemetry, now = Date.now, timers = {}, timeoutMs = 120000, maxOutputBytes = MAX_OUTPUT_BYTES} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw failure('pelican-invalid-config');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) throw failure('pelican-invalid-config');
  const later = timers.setTimeout ?? setTimeout;
  const clearTimer = timers.clearTimeout ?? clearTimeout;
  const supported = typeof llm?.stream === 'function' && typeof llm?.listModels === 'function' && typeof telemetry?.observeProbe === 'function';
  let disposed = false, enabled = false, intervalMinutes = 60, model = null;
  let scheduleTimer = null, nextRunAt = null, current = null, lastResult = null;
  let configuring = null, scheduleVersion = 0;
  const timestamp = () => new Date(now()).toISOString();
  const snapshot = () => ({
    available: supported && !disposed, enabled, intervalMinutes, model, prompt: PROMPT,
    running: current !== null, nextRunAt, lastResult: lastResult ? {...lastResult} : null,
  });
  const live = attempt => !disposed && current === attempt && !attempt.controller.signal.aborted;
  function assertAvailable() {
    if (disposed) throw failure('pelican-disposed');
    if (!supported) throw failure('pelican-unavailable');
  }
  function assertLive(attempt) {
    if (disposed) throw failure('pelican-disposed');
    if (!live(attempt)) throw attempt.controller.signal.reason ?? failure('pelican-cancelled', 'AbortError');
  }
  function stopSchedule() {
    scheduleVersion++;
    if (scheduleTimer !== null) clearTimer(scheduleTimer);
    scheduleTimer = null;
    nextRunAt = null;
  }
  function scheduleNext() {
    stopSchedule();
    if (disposed || !enabled || current) return;
    const delay = intervalMinutes * 60000;
    nextRunAt = new Date(now() + delay).toISOString();
    const version = scheduleVersion;
    scheduleTimer = later(() => {
      if (version !== scheduleVersion) return;
      scheduleTimer = null;
      nextRunAt = null;
      if (disposed || !enabled || current) return;
      // run records operational failures and schedules the following interval.
      void run({model}).catch(() => {});
    }, delay);
    scheduleTimer?.unref?.();
  }
  function finish(attempt, status, errorCode = null, svg = null) {
    if (current !== attempt) return;
    current = null;
    clearTimer(attempt.timer);
    lastResult = {status, startedAt: attempt.startedAt, endedAt: timestamp(), model: attempt.model, svg, errorCode};
    if (status !== 'success') attempt.controller.abort(failure(
      errorCode ?? 'pelican-cancelled', status === 'cancelled' ? 'AbortError' : errorCode === 'pelican-timeout' ? 'TimeoutError' : 'Error'));
    // Aborting may synchronously reenter cancel/dispose/run through a listener.
    if (!disposed && current === null) scheduleNext();
  }
  async function validateModel(selected, signal) {
    if (typeof selected !== 'string' || !selected.length) throw failure('pelican-invalid-model');
    const models = await interruptible(Promise.resolve().then(() => {
      signal.throwIfAborted();
      assertAvailable();
      return llm.listModels('openai-codex');
    }), signal);
    signal.throwIfAborted();
    assertAvailable();
    if (!Array.isArray(models) || !models.some(entry => entry?.id === selected && (entry.provider === undefined || entry.provider === 'openai-codex'))) {
      throw failure('pelican-invalid-model');
    }
  }
  function stopConfigure(reason = failure('pelican-cancelled', 'AbortError')) {
    const pending = configuring;
    configuring = null;
    pending?.controller.abort(reason);
  }
  async function configure(input = {}) {
    // Disabling must remain unconditional, including malformed stale form fields.
    if (input?.enabled === false) {
      enabled = false;
      stopConfigure();
      stopSchedule();
      cancel();
      return snapshot();
    }
    assertAvailable();
    if (input?.enabled !== true) throw failure('pelican-invalid-config');
    const selected = input.model === undefined ? model : input.model;
    const minutes = input.intervalMinutes === undefined ? intervalMinutes : input.intervalMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw failure('pelican-invalid-interval');
    stopConfigure();
    const pending = {controller: new AbortController()};
    configuring = pending;
    const timer = later(() => pending.controller.abort(failure('pelican-timeout', 'TimeoutError')), timeoutMs);
    try {
      await validateModel(selected, pending.controller.signal);
      pending.controller.signal.throwIfAborted();
      assertAvailable();
      if (configuring !== pending) throw failure('pelican-cancelled', 'AbortError');
      enabled = true;
      model = selected;
      intervalMinutes = minutes;
      scheduleNext();
      return snapshot();
    } catch (error) {
      throw safeFailure(error, 'pelican-models-unavailable');
    } finally {
      clearTimer(timer);
      if (configuring === pending) configuring = null;
    }
  }
  async function consume(attempt, options) {
    let iterator;
    const parts = new Map();
    let retainedBytes = 0, streamedBytes = 0, chunks = 0;
    const storeText = (index, text, append) => {
      if (typeof text !== 'string') throw failure('pelican-invalid-stream');
      const key = Number.isSafeInteger(index) && index >= 0 ? index : 0;
      const previous = parts.get(key) ?? '';
      const bytes = Buffer.byteLength(text, 'utf8');
      const nextBytes = append ? retainedBytes + bytes : retainedBytes - Buffer.byteLength(previous, 'utf8') + bytes;
      if (nextBytes > maxOutputBytes || !parts.has(key) && parts.size >= 1024) throw failure('pelican-output-limit');
      parts.set(key, append ? previous + text : text);
      retainedBytes = nextBytes;
    };
    try {
      assertLive(attempt);
      const stream = telemetry.observeProbe(options, () => {
        assertLive(attempt);
        const source = llm.stream(options);
        assertLive(attempt);
        return source;
      });
      iterator = stream[Symbol.asyncIterator]();
      while (live(attempt)) {
        const item = await interruptible(Promise.resolve().then(() => {
          assertLive(attempt);
          return iterator.next();
        }), attempt.controller.signal);
        assertLive(attempt);
        if (item.done) throw failure('pelican-stream-closed');
        const chunk = item.value;
        if (++chunks > 100000) throw failure('pelican-output-limit');
        if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
          if (typeof chunk.text !== 'string') throw failure('pelican-invalid-stream');
          streamedBytes += Buffer.byteLength(chunk.text, 'utf8');
          if (streamedBytes > maxOutputBytes) throw failure('pelican-output-limit');
          if (chunk.type === 'text-delta') storeText(chunk.index, chunk.text, true);
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
          storeText(chunk.index, chunk.block.text, false);
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
          if (typeof chunk.block.text !== 'string') throw failure('pelican-invalid-stream');
          if (Buffer.byteLength(chunk.block.text, 'utf8') > maxOutputBytes) throw failure('pelican-output-limit');
        } else if (chunk?.type === 'tool-call-delta' || chunk?.type === 'block-start' && chunk.blockType === 'tool-call' || chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
          throw failure('pelican-tool-call');
        } else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'aborted') finish(attempt, 'cancelled');
          else if (kind === 'stop') {
            const svg = extractSvg([...parts].sort(([left], [right]) => left - right).map(([, text]) => text).join(''));
            if (svg === null) throw failure('pelican-invalid-svg');
            finish(attempt, 'success', null, svg);
          } else throw failure(kind === 'max-tokens' ? 'pelican-max-tokens' : kind === 'tool-calls' ? 'pelican-tool-call' : 'pelican-generation-failed');
          return;
        }
      }
    } catch (error) {
      if (live(attempt)) finish(attempt, 'error', safeFailure(error, 'pelican-generation-failed').code);
    } finally {
      parts.clear();
      // Never await untrusted iterator cleanup: a provider can ignore abort or
      // keep return() pending. Native adapters receive the signal independently.
      if (iterator) void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
    }
  }
  async function run(input = {}) {
    assertAvailable();
    if (current) throw failure('pelican-busy');
    const selected = input?.model === undefined ? model : input.model;
    const attempt = {model: typeof selected === 'string' ? selected : null, startedAt: timestamp(), controller: new AbortController(), timer: null};
    current = attempt;
    stopSchedule();
    attempt.timer = later(() => finish(attempt, 'error', 'pelican-timeout'), timeoutMs);
    try {
      await validateModel(selected, attempt.controller.signal);
      assertLive(attempt);
    } catch (error) {
      const safe = safeFailure(error, 'pelican-models-unavailable');
      if (live(attempt)) finish(attempt, 'error', safe.code);
      throw safe;
    }
    const options = {
      provider: 'openai-codex', model: selected, maxTokens: 4096,
      messages: [{id: randomUUID(), role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: PROMPT}]}],
      tools: [], signal: attempt.controller.signal,
    };
    void consume(attempt, options);
    return snapshot();
  }
  function cancel() {
    if (current) finish(current, 'cancelled');
    return snapshot();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    stopConfigure(failure('pelican-disposed'));
    stopSchedule();
    cancel();
    lastResult = null;
  }
  return {snapshot, configure, run, cancel, dispose};
}

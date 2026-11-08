import {randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';

const PROMPT = '生成一张鹈鹕骑自行车的SVG';
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const INTERVALS = new Set([0, 5, 10, 20, 30]);
const OWN_ERROR = Symbol('pelican-error');
const modelKey = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(value);
const accountKey = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,149}$/i.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function failure(code, name = 'Error') {
  return Object.assign(new Error(code), {code, name, [OWN_ERROR]: true});
}
const safeFailure = (error, fallback) => error?.[OWN_ERROR] ? error : failure(fallback);
const cancelled = () => failure('pelican-cancelled', 'AbortError');

// Cancellation never waits for an uncooperative catalog, renderer or iterator.
// Both outcomes of the abandoned promise remain observed.
function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {cleanup(); reject(signal.reason ?? cancelled());};
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason ?? cancelled());
      else resolve(value);
    }, error => {cleanup(); reject(signal.aborted ? signal.reason ?? cancelled() : error);});
    if (signal.aborted) abort();
  });
}
const CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const u32 = (bytes, offset) => (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16)
  + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;

// The renderer contract is fixed 1024x1024 RGBA8 PNG. Check the independent RAM
// boundary too: no textual metadata, corrupt chunks, truncated/bomb IDAT, or SVG
// disguised by a signature may enter history. Decoded scanlines are temporary.
function pngInfo(bytes) {
  const bad = () => {throw failure('pelican-invalid-png');};
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) bad();
  let offset = 8, header = false, end = false, dataEnded = false, dataBytes = 0;
  const data = [], metadata = new Set();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) bad();
    const length = u32(bytes, offset);
    if (length > bytes.length - offset - 12) bad();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs'].includes(type)) bad();
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    if ((crc ^ 0xffffffff) >>> 0 !== u32(bytes, offset + 8 + length)) bad();
    if (!header && type !== 'IHDR') bad();
    if (type === 'IHDR') {
      if (header || length !== 13 || u32(bytes, offset + 8) !== 1024 || u32(bytes, offset + 12) !== 1024
        || bytes[offset + 16] !== 8 || bytes[offset + 17] !== 6 || bytes[offset + 18] !== 0
        || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) bad();
      header = true;
    } else if (type === 'IDAT') {
      if (dataEnded) bad();
      data.push(bytes.subarray(offset + 8, offset + 8 + length)); dataBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0 || data.length === 0 || offset + 12 !== bytes.length) bad();
      end = true;
    } else {
      if (data.length || metadata.has(type) || type === 'sRGB' && (length !== 1 || bytes[offset + 8] > 3)
        || type === 'gAMA' && (length !== 4 || u32(bytes, offset + 8) === 0)
        || type === 'pHYs' && (length !== 9 || bytes[offset + 16] > 1)) bad();
      metadata.add(type);
    }
    if (data.length && type !== 'IDAT') dataEnded = true;
    offset += 12 + length;
  }
  if (!header || !end) bad();
  let raw;
  try {
    const decoded = inflateSync(Buffer.concat(data, dataBytes), {maxOutputLength: 1024 * (1 + 1024 * 4), info: true});
    if (decoded.engine.bytesWritten !== dataBytes) bad();
    raw = decoded.buffer;
  } catch {bad();}
  if (raw.length !== 1024 * (1 + 1024 * 4)) bad();
  for (let i = 0; i < raw.length; i += 1 + 1024 * 4) if (raw[i] > 4) bad();
  return {width: 1024, height: 1024};
}
function extractSvg(text) {
  // Extraction only. Sanitization belongs to the worker; this text never enters
  // a DTO, DOM, attachment service, filesystem or retained history.
  return (text.match(/<svg\b[^>]*>[\s\S]*<\/svg\s*>/i) ?? text.match(/<svg\b[^>]*\/\s*>/i))?.[0] ?? null;
}

/** Per-account probes. All dependencies are borrowed, not disposed here.
 * Call await refresh()/restore() before reading the first account snapshot.
 * getPlans returns the id -> {intervalMinutes,model} dictionary. savePlan must
 * honor its isCurrent guard while serializing persistent writes.
 * isEnabled(id) is a live, strict boolean selection guard (default true for
 * compatibility). Deactivation pauses plans/probes without dropping PNG history;
 * reactivation waits a full interval. Selection alone never clears images.
 */
export function createPelican({accounts, transport, telemetry, renderer, getPlans, savePlan,
  now = Date.now, timers = {}, timeoutMs = 120000, maxOutputBytes = MAX_OUTPUT_BYTES, isEnabled = () => true} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES
    || typeof now !== 'function' || typeof isEnabled !== 'function' || !timers || typeof timers !== 'object') throw failure('pelican-invalid-config');
  const later = timers.setTimeout ?? setTimeout, clearTimer = timers.clearTimeout ?? clearTimeout;
  if (typeof later !== 'function' || typeof clearTimer !== 'function') throw failure('pelican-invalid-config');
  const supported = typeof accounts?.list === 'function' && typeof accounts?.capture === 'function'
    && ['providerFor', 'stream', 'listModels'].every(key => typeof transport?.[key] === 'function')
    && typeof telemetry?.observeProbe === 'function' && typeof renderer?.render === 'function';
  const states = new Map(), removed = new Set(), images = new Map();
  const lifetime = new AbortController();
  let disposed = false, registryVersion = 0, refreshFlight = null, historyBytes = 0, off;
  const timestamp = () => new Date(now()).toISOString();
  const enabledNow = id => {try {return isEnabled(id) === true;} catch {return false;}};
  const available = state => supported && !disposed && state.ready && state.enabled && enabledNow(state.id);
  const snapshot = () => {
    if (!disposed) for (const state of states.values()) reconcileEnabled(state);
    return {accounts: [...states.values()].map(state => ({id: state.id, pelican: {
      available: available(state), running: state.current !== null, intervalMinutes: state.intervalMinutes,
      model: state.model, nextRunAt: state.nextRunAt, lastError: state.lastError, historyCount: state.history.length,
    }}))};
  };
  function active() {if (disposed) throw failure('pelican-disposed');}
  function find(id) {
    active();
    const state = states.get(id);
    if (!state) throw failure('pelican-account-not-found');
    return state;
  }
  function requireAvailable(state) {
    active(); reconcileEnabled(state);
    if (!enabledNow(state.id)) throw failure('pelican-account-inactive');
    if (!available(state)) throw failure('pelican-unavailable');
  }
  function disarm(state) {
    state.scheduleVersion++;
    if (state.timer !== null) clearTimer(state.timer);
    state.timer = null; state.nextRunAt = null;
  }
  function schedule(state) {
    disarm(state);
    if (!available(state) || state.current || state.intervalMinutes === 0 || states.get(state.id) !== state) return;
    const delay = state.intervalMinutes * 60000, version = state.scheduleVersion;
    state.nextRunAt = new Date(now() + delay).toISOString();
    state.timer = later(() => {
      if (disposed || states.get(state.id) !== state || version !== state.scheduleVersion) return;
      state.timer = null; state.nextRunAt = null;
      reconcileEnabled(state);
      if (!available(state) || !state.intervalMinutes || state.current) return;
      void run(state.id, {model: state.model}).catch(() => {});
    }, delay);
    state.timer?.unref?.();
  }
  function evict(id) {
    const image = images.get(id);
    if (!image) return;
    images.delete(id); historyBytes -= image.png.byteLength;
    const index = image.state.history.indexOf(id);
    if (index !== -1) image.state.history.splice(index, 1);
  }
  function clearImages(state) {for (const id of [...state.history]) evict(id);}
  function finish(state, attempt, error = null, abort = false) {
    if (state.current !== attempt) return;
    state.current = null; state.workEpoch++;
    clearTimer(attempt.timer);
    for (const cleanup of attempt.cleanups.splice(0)) cleanup();
    attempt.releaseText?.(); attempt.releaseText = null;
    state.lastError = error?.code === 'pelican-cancelled' ? null : error?.code ?? null;
    // Retire ownership before abort listeners can synchronously reenter us.
    if (abort && !attempt.controller.signal.aborted) attempt.controller.abort(error ?? cancelled());
    if (!disposed && states.get(state.id) === state && !state.current) schedule(state);
  }
  function stopConfigure(state, reason = cancelled()) {
    const pending = state.configuring;
    state.configuring = null;
    if (pending) {clearTimer(pending.timer); pending.controller.abort(reason);}
  }
  // Selection pauses work, not identity/history. Its own epoch prevents an old
  // config ACK or render result from reviving work after a deactivate/reactivate.
  function pause(state) {
    state.enabled = false;
    const reason = failure('pelican-account-inactive', 'AbortError');
    if (!state.configuring?.stopping) {
      state.planVersion++;
      if (state.configuring) state.localOverride = true;
      stopConfigure(state, reason);
    }
    disarm(state);
    const previousError = state.lastError;
    if (state.current) finish(state, state.current, reason, true);
    else state.workEpoch++;
    state.lastError = previousError;
  }
  function reconcileEnabled(state) {
    const enabled = enabledNow(state.id);
    if (!enabled) {
      if (state.enabled || state.current || state.configuring && !state.configuring.stopping) pause(state);
    } else if (!state.enabled) {state.enabled = true; schedule(state);}
  }
  function detachIdentity(state) {state.offIdentity?.(); state.offIdentity = null; state.identitySignal = null;}
  function invalidate(state, code = 'pelican-account-changed') {
    state.ready = false; state.identityEpoch++; state.planVersion++;
    detachIdentity(state); disarm(state); clearImages(state);
    stopConfigure(state, failure(code));
    if (state.current) finish(state, state.current, failure(code), true);
    state.lastError = code;
  }
  function bindingSnapshot(raw, state) {
    if (!raw || raw.accountId !== state.id || raw.providerId !== state.provider
      || typeof raw.principalHash !== 'string' || !raw.principalHash || raw.principalHash.length > 256
      || !raw.signal || typeof raw.signal.addEventListener !== 'function' || typeof raw.signal.removeEventListener !== 'function'
      || typeof raw.assertCurrent !== 'function' || raw.signal.aborted
      || typeof raw.credentials?.read !== 'function' || typeof raw.credentials?.modify !== 'function') {
      throw failure('pelican-account-changed');
    }
    const check = raw.assertCurrent.bind(raw);
    return Object.freeze({accountId: state.id, providerId: state.provider, principalHash: raw.principalHash,
      email: typeof raw.email === 'string' ? raw.email : null, signal: raw.signal, credentials: raw.credentials,
      assertCurrent: () => check()});
  }
  function adopt(state, binding) {
    if (state.principalHash !== null && state.principalHash !== binding.principalHash) invalidate(state);
    if (state.identitySignal !== binding.signal) {
      detachIdentity(state);
      const abort = () => {if (!disposed && states.get(state.id) === state) invalidate(state);};
      binding.signal.addEventListener('abort', abort, {once: true});
      state.offIdentity = () => binding.signal.removeEventListener('abort', abort);
      state.identitySignal = binding.signal;
    }
    state.principalHash = binding.principalHash;
    if (binding.signal.aborted) {invalidate(state); return false;}
    state.ready = true;
    return true;
  }
  function live(state, attempt) {
    return !disposed && states.get(state.id) === state && state.current === attempt
      && state.workEpoch === attempt.workEpoch && state.identityEpoch === attempt.identityEpoch
      && !attempt.controller.signal.aborted;
  }
  function assertLive(state, attempt) {
    active(); reconcileEnabled(state);
    if (!live(state, attempt)) throw attempt.controller.signal.reason ?? cancelled();
  }
  function watchBinding(state, attempt, binding) {
    if (attempt.signals.has(binding.signal)) return;
    attempt.signals.add(binding.signal);
    const abort = () => {if (live(state, attempt)) invalidate(state);};
    binding.signal.addEventListener('abort', abort, {once: true});
    attempt.cleanups.push(() => binding.signal.removeEventListener('abort', abort));
    if (binding.signal.aborted) abort();
  }
  async function capture(state, signal) {
    try {
      signal.throwIfAborted();
      const raw = await wait(Promise.resolve().then(() => {
        signal.throwIfAborted(); return accounts.capture(state.id, state.provider);
      }), signal);
      const binding = bindingSnapshot(raw, state);
      await wait(Promise.resolve().then(() => {signal.throwIfAborted(); return binding.assertCurrent();}), signal);
      signal.throwIfAborted();
      return binding;
    } catch (error) {throw safeFailure(error, 'pelican-account-changed');}
  }
  async function verify(state, attempt, outer) {
    assertLive(state, attempt);
    try {
      await wait(Promise.resolve().then(() => {assertLive(state, attempt); return outer.assertCurrent();}), attempt.controller.signal);
      assertLive(state, attempt);
      const fresh = await capture(state, attempt.controller.signal);
      assertLive(state, attempt);
      if (fresh.accountId !== outer.accountId || fresh.providerId !== outer.providerId
        || fresh.principalHash !== outer.principalHash || state.principalHash !== outer.principalHash) {
        throw failure('pelican-account-changed');
      }
      watchBinding(state, attempt, fresh);
    } catch (error) {
      if (live(state, attempt)) invalidate(state);
      throw safeFailure(error, 'pelican-account-changed');
    }
    assertLive(state, attempt);
  }
  async function validateModel(state, selected, signal) {
    if (!modelKey(selected)) throw failure('pelican-invalid-model');
    let models;
    try {models = await wait(Promise.resolve().then(() => {
      signal.throwIfAborted(); requireAvailable(state); return transport.listModels(state.id);
    }), signal);} catch (error) {throw safeFailure(error, 'pelican-models-unavailable');}
    signal.throwIfAborted(); requireAvailable(state);
    if (!Array.isArray(models) || !models.some(model => model?.id === selected
      && (model.provider === undefined || model.provider === state.provider))) throw failure('pelican-invalid-model');
  }
  function makeState(id, provider) {
    return {id, provider, ready: false, enabled: enabledNow(id), principalHash: null, identitySignal: null, offIdentity: null,
      identityEpoch: 0, workEpoch: 0, planVersion: 0, configuring: null, localOverride: false,
      intervalMinutes: 0, model: '', timer: null, nextRunAt: null, scheduleVersion: 0,
      current: null, lastError: null, history: []};
  }
  function normalizePlan(value) {
    if (value === undefined) return {intervalMinutes: 0, model: ''};
    if (!plain(value) || !INTERVALS.has(value.intervalMinutes)
      || !(value.model === undefined || value.model === '' || modelKey(value.model))
      || value.intervalMinutes !== 0 && !modelKey(value.model)) throw failure('pelican-invalid-config');
    return {intervalMinutes: value.intervalMinutes, model: value.model ?? ''};
  }
  function applyPlan(state, plan) {
    if (state.intervalMinutes === plan.intervalMinutes && state.model === plan.model) return;
    state.intervalMinutes = plan.intervalMinutes; state.model = plan.model;
    disarm(state);
    if (plan.intervalMinutes === 0 && state.current) finish(state, state.current, cancelled(), true);
    else if (!state.current) schedule(state);
  }
  function drop(state) {
    state.ready = false; state.identityEpoch++; state.planVersion++;
    disarm(state); detachIdentity(state); clearImages(state); stopConfigure(state);
    if (state.current) finish(state, state.current, cancelled(), true);
    states.delete(state.id);
  }
  function refresh() {
    if (disposed) return Promise.reject(failure('pelican-disposed'));
    // Do this before any asynchronous list/preferences read, even if another
    // refresh is stuck: a selection change must synchronously stop charged work.
    for (const state of states.values()) reconcileEnabled(state);
    if (refreshFlight) return refreshFlight;
    if (typeof accounts?.list !== 'function') return Promise.reject(failure('pelican-unavailable'));
    const version = registryVersion;
    const revisions = new Map([...states].map(([id, state]) => [id, {
      state, version: state.planVersion, blocked: !!state.configuring || state.localOverride,
    }]));
    const controller = new AbortController();
    const onAbort = () => controller.abort(failure('pelican-disposed'));
    lifetime.signal.addEventListener('abort', onAbort, {once: true});
    const timer = later(() => controller.abort(failure('pelican-timeout', 'TimeoutError')), timeoutMs);
    const result = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
    refreshFlight = (async () => {
      const [listed, saved] = await wait(Promise.all([
        result(Promise.resolve().then(() => accounts.list())),
        result(Promise.resolve().then(() => typeof getPlans === 'function' ? getPlans() : {})),
      ]), controller.signal);
      active();
      if (version !== registryVersion) return snapshot();
      if (listed.error || !Array.isArray(listed.value)) {
        for (const state of states.values()) invalidate(state, 'pelican-accounts-unavailable');
        throw failure('pelican-accounts-unavailable');
      }
      const rows = new Map();
      for (const row of listed.value) if (accountKey(row?.id) && !rows.has(row.id)) rows.set(row.id, row);
      for (const id of [...removed]) if (!rows.has(id)) removed.delete(id);
      for (const state of [...states.values()]) if (!rows.has(state.id)) drop(state);
      const plansValid = !saved.error && plain(saved.value);
      for (const [id, row] of rows) {
        if (removed.has(id)) continue;
        let provider;
        try {provider = transport?.providerFor(id);} catch {provider = null;}
        let state = states.get(id);
        if (!state) {state = makeState(id, provider); states.set(id, state);}
        const wasReady = state.ready;
        const revision = revisions.get(id);
        const mayApply = !state.configuring && !state.localOverride && (!revision
          || revision.state === state && revision.version === state.planVersion && !revision.blocked);
        if (state.provider !== provider) {invalidate(state); state.provider = provider;}
        if (!supported || typeof provider !== 'string' || row.provider !== provider
          || row.availability !== 'ready' || row.canRunProbe !== true) {
          if (state.ready || state.current || state.history.length) invalidate(state, 'pelican-unavailable');
          state.ready = false; disarm(state);
        } else {
          try {
            const binding = await capture(state, controller.signal);
            active();
            if (version !== registryVersion || states.get(id) !== state) return snapshot();
            adopt(state, binding);
          } catch (error) {
            if (disposed) throw failure('pelican-disposed');
            if (version !== registryVersion || states.get(id) !== state) return snapshot();
            invalidate(state, safeFailure(error, 'pelican-account-changed').code);
          }
        }
        // A configure/stop can arrive during capture or during the preferences
        // read. Never let that older read restore its pre-stop plan.
        const stillCurrent = !state.configuring && !state.localOverride && (!revision
          ? state.planVersion === 0 : revision.state === state && revision.version === state.planVersion);
        if (plansValid && mayApply && stillCurrent) {
          try {applyPlan(state, normalizePlan(Object.hasOwn(saved.value, id) ? saved.value[id] : undefined));}
          catch {applyPlan(state, {intervalMinutes: 0, model: state.model}); state.lastError = 'pelican-invalid-config';}
        } else if (!plansValid) state.lastError = 'pelican-settings-unavailable';
        if (!wasReady && available(state) && !state.current && state.timer === null) schedule(state);
      }
      if (!plansValid) throw failure('pelican-settings-unavailable');
      return snapshot();
    })().finally(() => {
      clearTimer(timer); lifetime.signal.removeEventListener('abort', onAbort); refreshFlight = null;
    });
    return refreshFlight;
  }
  async function configure(id, input = {}) {
    const state = find(id);
    if (!plain(input) || !INTERVALS.has(input.intervalMinutes)) throw failure('pelican-invalid-interval');
    const stopping = input.intervalMinutes === 0;
    const selected = stopping ? (modelKey(input.model) ? input.model : state.model)
      : input.model === undefined ? state.model : input.model;
    if (!stopping) {requireAvailable(state); if (!modelKey(selected)) throw failure('pelican-invalid-model');}
    state.planVersion++;
    stopConfigure(state);
    const version = state.planVersion, identityEpoch = state.identityEpoch;
    const pending = {controller: new AbortController(), timer: null, stopping};
    state.configuring = pending;
    const isCurrent = () => !disposed && states.get(id) === state && state.planVersion === version
      && state.identityEpoch === identityEpoch && !pending.controller.signal.aborted
      && (stopping || state.enabled && enabledNow(id));
    if (stopping) {
      // Deliberately before the first await (and before savePlan): a failed or
      // delayed persistence operation must never leave charged work running.
      state.localOverride = true;
      state.intervalMinutes = 0; state.model = selected; state.lastError = null;
      disarm(state);
      if (state.current) finish(state, state.current, cancelled(), true);
      else state.workEpoch++;
    }
    pending.timer = later(() => pending.controller.abort(failure('pelican-timeout', 'TimeoutError')), timeoutMs);
    try {
      if (!stopping) {
        await validateModel(state, selected, pending.controller.signal);
        const binding = await capture(state, pending.controller.signal);
        if (binding.principalHash !== state.principalHash) {invalidate(state); throw failure('pelican-account-changed');}
      }
      if (!isCurrent()) throw cancelled();
      if (typeof savePlan !== 'function') throw failure('pelican-settings-unavailable');
      const plan = {intervalMinutes: input.intervalMinutes, model: selected};
      try {await wait(savePlan(id, {...plan}, {isCurrent}), pending.controller.signal);}
      catch (error) {
        if (!isCurrent()) throw pending.controller.signal.reason ?? cancelled();
        throw safeFailure(error, error?.code === 'settings-unavailable' ? 'pelican-settings-unavailable' : 'pelican-save-failed');
      }
      if (!isCurrent()) throw cancelled();
      state.localOverride = false; state.lastError = null;
      applyPlan(state, plan);
      // Even a user reschedule to the same plan waits a complete interval.
      if (!state.current) schedule(state);
      return snapshot();
    } catch (error) {
      const safe = safeFailure(error, 'pelican-save-failed');
      if (states.get(id) === state && state.planVersion === version && !disposed) state.lastError = safe.code;
      throw safe;
    } finally {
      clearTimer(pending.timer);
      if (state.configuring === pending) {state.configuring = null; state.planVersion++;}
    }
  }
  async function consume(state, attempt, options) {
    const parts = new Map();
    let retainedBytes = 0, streamedBytes = 0, count = 0, iterator;
    attempt.releaseText = () => parts.clear();
    const store = (index, kind, value, final) => {
      if (typeof value !== 'string') throw failure('pelican-invalid-stream');
      const key = index === undefined ? 0 : index;
      if (!Number.isSafeInteger(key) || key < 0) throw failure('pelican-invalid-stream');
      const previous = parts.get(key);
      if (previous && (previous.kind !== kind || previous.closed)) throw failure('pelican-invalid-stream');
      const bytes = Buffer.byteLength(value, 'utf8');
      const next = final ? bytes : (previous?.bytes ?? 0) + bytes;
      streamedBytes += final ? Math.max(0, next - (previous?.bytes ?? 0)) : bytes;
      retainedBytes += next - (previous?.bytes ?? 0);
      if (retainedBytes > maxOutputBytes || streamedBytes > maxOutputBytes
        || !previous && parts.size >= 1024) throw failure('pelican-output-limit');
      parts.set(key, {kind, bytes: next, closed: final,
        text: kind === 'text' ? (final ? value : (previous?.text ?? '') + value) : null});
    };
    try {
      assertLive(state, attempt);
      const stream = telemetry.observeProbe(options, () => {
        assertLive(state, attempt);
        return transport.stream(state.id, options, attempt.binding);
      });
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const item = await wait(Promise.resolve().then(() => {
          assertLive(state, attempt); return iterator.next();
        }), attempt.controller.signal);
        assertLive(state, attempt);
        if (item.done) throw failure('pelican-stream-closed');
        if (++count > 100000) throw failure('pelican-output-limit');
        const chunk = item.value;
        if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
          store(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning', chunk.text, false);
        } else if (chunk?.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type)) {
          store(chunk.index, chunk.block.type, chunk.block.text, true);
        } else if (chunk?.type === 'tool-call-delta' || chunk?.type === 'block-start' && chunk.blockType === 'tool-call'
          || chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') throw failure('pelican-tool-call');
        else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'aborted') throw cancelled();
          if (kind !== 'stop') throw failure(kind === 'max-tokens' ? 'pelican-max-tokens'
            : kind === 'tool-calls' ? 'pelican-tool-call' : 'pelican-generation-failed');
          const svg = extractSvg([...parts].sort(([a], [b]) => a - b).map(([, block]) => block.text ?? '').join(''));
          if (svg === null) throw failure('pelican-invalid-svg');
          return svg;
        }
      }
    } finally {
      parts.clear(); attempt.releaseText = null;
      // return() is not a trusted cancellation boundary; observe but never await.
      if (iterator) void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
    }
  }
  function commitImage(state, attempt, png, info) {
    assertLive(state, attempt);
    const id = randomUUID(), meta = {id, createdAt: timestamp(), ...info};
    images.set(id, {state, png, meta}); historyBytes += png.byteLength; state.history.push(id);
    while (state.history.length > 8) evict(state.history[0]);
    while (images.size > 64 || historyBytes > MAX_HISTORY_BYTES) evict(images.keys().next().value);
  }
  async function execute(state, attempt, options) {
    try {
      let svg = await consume(state, attempt, options);
      assertLive(state, attempt);
      let rendering;
      try {rendering = renderer.render(svg, {signal: attempt.controller.signal});}
      catch {throw failure('pelican-render-failed');}
      finally {svg = null;}
      let rendered;
      try {rendered = await wait(rendering, attempt.controller.signal);}
      catch (error) {throw safeFailure(error, 'pelican-render-failed');}
      assertLive(state, attempt);
      if (!(rendered instanceof Uint8Array)) throw failure('pelican-invalid-png');
      if (rendered.byteLength > MAX_PNG_BYTES) throw failure('pelican-image-limit');
      const png = new Uint8Array(rendered); rendered = null;
      const info = pngInfo(png);
      await verify(state, attempt, attempt.binding);
      commitImage(state, attempt, png, info);
      finish(state, attempt);
    } catch (error) {
      if (live(state, attempt)) finish(state, attempt, safeFailure(error, 'pelican-generation-failed'), true);
    }
  }
  async function run(id, input = {}) {
    const state = find(id); requireAvailable(state);
    if (state.current) throw failure('pelican-busy');
    const selected = input?.model === undefined ? state.model : input.model;
    if (!modelKey(selected)) throw failure('pelican-invalid-model');
    const attempt = {model: selected, controller: new AbortController(), timer: null, binding: null,
      identityEpoch: state.identityEpoch, workEpoch: ++state.workEpoch, cleanups: [], signals: new Set(), releaseText: null};
    state.current = attempt; state.lastError = null; disarm(state);
    attempt.timer = later(() => {
      reconcileEnabled(state);
      if (live(state, attempt)) finish(state, attempt, failure('pelican-timeout', 'TimeoutError'), true);
    }, timeoutMs);
    try {
      const outer = await capture(state, attempt.controller.signal);
      assertLive(state, attempt);
      if (outer.principalHash !== state.principalHash) {invalidate(state); throw failure('pelican-account-changed');}
      attempt.binding = outer; watchBinding(state, attempt, outer);
      await validateModel(state, selected, attempt.controller.signal);
      await verify(state, attempt, outer);
      assertLive(state, attempt);
    } catch (error) {
      const safe = safeFailure(error, 'pelican-models-unavailable');
      if (live(state, attempt)) finish(state, attempt, safe, true);
      throw safe;
    }
    const options = {
      provider: state.provider, model: selected, maxTokens: 4096, accountId: state.id, accountEmail: attempt.binding.email,
      messages: [{id: randomUUID(), role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: PROMPT}]}],
      tools: [], signal: attempt.controller.signal,
    };
    void execute(state, attempt, options);
    return snapshot();
  }
  function cancel(id) {
    if (disposed) return snapshot();
    const state = states.get(id);
    if (state) {
      state.planVersion++;
      if (state.configuring) {state.localOverride = true; stopConfigure(state);}
      disarm(state);
      if (state.current) finish(state, state.current, cancelled(), true);
      else {state.workEpoch++; schedule(state);}
    }
    return snapshot();
  }
  function removeAccount(id) {
    if (disposed) return snapshot();
    registryVersion++; removed.add(id);
    const state = states.get(id);
    if (state) drop(state);
    return snapshot();
  }
  function history(id) {
    const state = !disposed && states.get(id);
    return {images: state ? [...state.history].reverse().map(key => {
      const {meta} = images.get(key);
      return {...meta, url: '/api/cpa-image?accountId=' + encodeURIComponent(id) + '&imageId=' + encodeURIComponent(meta.id)};
    }) : []};
  }
  function image(id, imageId) {
    const entry = !disposed && images.get(imageId);
    return entry && entry.state === states.get(id) ? new Uint8Array(entry.png) : null;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; registryVersion++;
    lifetime.abort(failure('pelican-disposed'));
    try {if (typeof off === 'function') off();} catch { /* borrowed listener cleanup is best-effort */ }
    for (const state of [...states.values()]) drop(state);
    images.clear(); historyBytes = 0; removed.clear();
  }
  if (typeof accounts?.onChange === 'function') off = accounts.onChange(() => {
    if (!disposed) void refresh().catch(() => {});
  });
  return Object.freeze({refresh, restore: refresh, snapshot, configure, run, cancel, removeAccount, history, image, dispose});
}

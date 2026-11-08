import {isProxy} from 'node:util/types';
import {assistantStreamFirstTokenTime, isTokenDelta} from '@deepseek-ai/dsh-llm';

const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const safe = value => object(value) && !isProxy(value);
const own = (value, key) => {
  try { return safe(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; } catch { return undefined; }
};
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const index = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
export const unavailableTiming = () => ({timingVersion: 2, timingSource: 'unavailable',
  ttftMs: null, durationMs: null, decodeMs: null, timingOutputTokens: null, tps: null});

// Session.id is a PUBLIC prototype getter, not necessarily an own data field.
// Reject proxies before that single public read; never inspect logs or seed data.
function sessionId(session) {
  if (!safe(session)) return null;
  try { const id = session.id; if (identity(id)) return id; } catch {}
  const id = own(own(session, 'header'), 'id');
  return identity(id) ? id : null;
}

// Scan compact records directly (time0 + dt), stopping at F. Do not expand a
// stream, retain content, run foreign getters, or consume a producer iterator.
// Delegate the actual token predicate to the public SDK on detached safe data.
function firstTokenTime(stream) {
  if (!safe(stream) || !Array.isArray(stream)) return null;
  const length = own(stream, 'length');
  for (let i = 0; i < length; i++) {
    const record = own(stream, String(i)), type = own(record, 'type');
    if (type === 'chunk') {
      const chunk = own(record, 'chunk'), kind = own(chunk, 'type');
      let detached;
      if (kind === 'text-delta' || kind === 'reasoning-delta') {
        const text = own(chunk, 'text');
        if (typeof text !== 'string') return null;
        detached = {type: kind, text};
      } else if (kind === 'tool-call-delta') {
        const argumentsDelta = own(chunk, 'argumentsDelta'), name = own(chunk, 'name');
        if (name !== undefined && typeof name !== 'string' || name === undefined && typeof argumentsDelta !== 'string') return null;
        detached = {type: kind, argumentsDelta: typeof argumentsDelta === 'string' ? argumentsDelta : '',
          ...(name === undefined ? {} : {name})};
      } else continue;
      if (isTokenDelta(detached)) return time(assistantStreamFirstTokenTime([{type: 'chunk', time: own(record, 'time'), chunk: detached}]));
      continue;
    }
    if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(type)) return null;
    const fragments = own(record, type === 'tool-call-chunks' ? 'args' : 'texts');
    const deltas = own(record, 'dt');
    let at = time(own(record, 'time0'));
    if (at === null) return null;
    const name = own(record, 'name');
    if (type === 'tool-call-chunks' && name !== undefined) {
      if (typeof name !== 'string') return null;
      return time(assistantStreamFirstTokenTime([{type, time0: at, name, args: [''], dt: []}]));
    }
    if (!safe(fragments) || !Array.isArray(fragments) || !safe(deltas) || !Array.isArray(deltas)) return null;
    for (let j = 0; j < own(fragments, 'length'); j++) {
      if (j > 0) {
        const dt = own(deltas, String(j - 1));
        if (typeof dt !== 'number' || !Number.isFinite(dt)) return null;
        at = time(at + dt);
        if (at === null) return null;
      }
      const fragment = own(fragments, String(j));
      if (typeof fragment !== 'string') return null;
      if (fragment !== '') return time(assistantStreamFirstTokenTime([{type, time0: at, dt: [],
        ...(type === 'tool-call-chunks' ? {args: [fragment]} : {texts: [fragment]})}]));
    }
  }
  return null;
}

/** Live-only step authority. All retained state is bounded scalar data or safe
 * terminal callbacks; no Session, event, compact stream, options or signal lives here. */
export function createSessionTiming(ctx, {maxSessions = 256, maxPending = 512} = {}) {
  for (const size of [maxSessions, maxPending]) if (!Number.isSafeInteger(size) || size < 1 || size > 4096) throw new RangeError('invalid-session-timing-limit');
  const sessions = new Map(), pending = new Set(), unhooks = [];
  let disposed = false;
  function resolve(handle, result, notify = true) {
    pending.delete(handle);
    handle.state?.handles.delete(handle);
    handle.state = null;
    handle.result = result;
    const callback = handle.callback;
    handle.callback = null;
    if (notify) { try { callback?.(result); } catch {} }
  }
  function retire(id, notify = true) {
    const state = sessions.get(id);
    if (!state) return;
    sessions.delete(id);
    for (const handle of state.handles) resolve(handle, unavailableTiming(), notify);
  }
  function matches(state, data) { return state && state.turn === own(data, 'turn') && state.step === own(data, 'step'); }
  function event(session, event) {
    if (disposed) return;
    const id = sessionId(session), type = own(event, 'type'), data = own(event, 'data');
    if (!id) return;
    if (type === 'step/start') {
      retire(id);
      const start = time(own(event, 'time')), turn = own(data, 'turn'), step = own(data, 'step');
      if (start === null || !index(turn) || !index(step)) return;
      sessions.set(id, {id, turn, step, start, first: null, ambiguous: false, handles: new Set()});
      while (sessions.size > maxSessions) retire(sessions.keys().next().value);
      return;
    }
    const state = sessions.get(id);
    if (!matches(state, data)) return;
    if (type === 'step/end') { retire(id); return; }
    if (type !== 'assistant/attempt' && type !== 'assistant/message') return;
    const first = state.first ?? firstTokenTime(own(data, 'stream'));
    if (type === 'assistant/attempt') {
      state.first = first;
      // A failed attempt itself has no native time sample. Keep F for retry,
      // including backoff, but close this failed request's row with unknown time.
      for (const handle of state.handles) resolve(handle, unavailableTiming());
      return;
    }
    const completed = time(own(event, 'time'));
    const result = completed === null || state.ambiguous ? unavailableTiming() : {
      timingVersion: 2, timingSource: 'dsh-session',
      ttftMs: first === null ? null : Math.max(0, first - state.start),
      durationMs: Math.max(0, completed - state.start),
      decodeMs: first === null ? null : Math.max(0, completed - first),
      timingOutputTokens: time(own(own(data, 'usage'), 'outputTokens')), tps: null,
    };
    sessions.delete(id);
    for (const handle of state.handles) resolve(handle, result);
  }
  for (const [name, callback] of [['session/event', event], ['session/disposed', session => {const id = sessionId(session); if (id) retire(id);}]]) {
    try { if (typeof ctx?.on === 'function') unhooks.push(ctx.on(name, callback)); } catch {}
  }
  return {
    // No WeakSet provenance requirement: independent SDK copies do not share it.
    // A valid sid + an observed live step is authority; purpose means auxiliary.
    claim(options, eligible = true) {
      if (!safe(options)) return {state: null, result: unavailableTiming(), callback: null};
      const sid = own(options, 'sessionId');
      let descriptor;
      try { descriptor = safe(options) ? Object.getOwnPropertyDescriptor(options, 'sessionId') : null; } catch {}
      if (sid === undefined && !descriptor?.get && !descriptor?.set) return null; // explicitly local observer
      const unknown = () => ({state: null, result: unavailableTiming(), callback: null});
      if (disposed || !eligible || !identity(sid) || own(options, 'purpose') !== undefined) return unknown();
      // An accessor purpose is not evidence of an ordinary loop request either.
      try { if (Object.getOwnPropertyDescriptor(options, 'purpose')?.get) return unknown(); } catch { return unknown(); }
      const state = sessions.get(sid);
      if (!state || state.ambiguous) return unknown();
      if (state.handles.size) {
        state.ambiguous = true;
        for (const handle of state.handles) resolve(handle, unavailableTiming());
        return unknown();
      }
      const handle = {state, result: null, callback: null};
      state.handles.add(handle); pending.add(handle);
      while (pending.size > maxPending) retire(pending.values().next().value.state.id);
      return handle;
    },
    settle(handle, callback) {
      if (handle.result) { try { callback(handle.result); } catch {} }
      else handle.callback = callback;
    },
    clear() { for (const id of sessions.keys()) retire(id, false); },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Finished rows waiting on a missing durable message are safely settled.
      for (const id of sessions.keys()) retire(id);
      for (const unhook of unhooks) { try { if (typeof unhook === 'function') unhook(); } catch {} }
      unhooks.length = 0;
    },
    // Counts only, useful to verify the retention contract without exposing ids.
    snapshot() { return {sessions: sessions.size, pending: pending.size, maxSessions, maxPending}; },
  };
}

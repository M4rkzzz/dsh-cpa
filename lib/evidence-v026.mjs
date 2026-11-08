import {randomUUID} from 'node:crypto';
import {isProxy} from 'node:util/types';

// Only this module can create trusted audits. Neither chunks nor errors are
// mutated; their weak tags disappear with the corresponding request objects.
const readers = new WeakMap();
const tags = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value);
const keyable = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const count = value => Number.isSafeInteger(value) && value >= 0;
const tiers = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
const terminalEvents = new Set(['response.done', 'response.completed', 'response.incomplete', 'response.failed']);
const responseEvents = new Set(['response.created', 'response.in_progress', ...terminalEvents]);
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

// Accessors/proxies are not evidence. Do not invoke untrusted field getters or
// stringify objects, including errors, headers, and response output blocks.
function own(value, key) {
  if (!object(value)) return {kind: 'missing'};
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property) return {kind: 'missing'};
    if (!Object.hasOwn(property, 'value')) return {kind: 'invalid'};
    if (property.value === null) return {kind: 'null'};
    if (property.value === undefined) return {kind: 'missing'};
    return {kind: 'value', value: property.value};
  } catch { return {kind: 'invalid'}; }
}
function read(value, key) { return own(value, key).value; }
function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,199}$/i.test(value) ? value : null;
}
function safeEmail(value) {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/u.test(value) ? value : null;
}

export function createEvidence(options = {}) {
  const requested = read(options, 'serviceTierRequested');
  const state = {evidenceId: randomUUID(), accountId: safeId(read(options, 'accountId')),
    accountEmail: safeEmail(read(options, 'accountEmail')), httpStatus: null,
    serviceTierRequested: tiers.has(requested) ? requested : null,
    serviceTierSent: null, serviceTierSentState: 'not-sent',
    serviceTierReported: null, serviceTierReportedState: null, serviceTierReportedSource: null,
    usageReported: false, inputTokens: null, outputTokens: null, totalTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    fields: {usage: 'missing', serviceTierReported: 'missing', ...Object.fromEntries(tokenFields.map(key => [key, 'missing']))}};
  function capture(target, source, key, parentState = 'missing') {
    const field = object(source) ? own(source, key) : {kind: parentState};
    state[target] = field.kind === 'value' && count(field.value) ? field.value : null;
    state.fields[target] = field.kind === 'value' && !count(field.value) ? 'invalid' : field.kind;
  }
  let dispatchSeen = false, terminalSeen = false, terminalTier = null, terminalConflict = false;
  const snapshot = () => ({...state, fields: {...state.fields}});
  const audit = Object.freeze({
    onRequestDispatch(observation) {
      // Preference is not wire evidence. Only the final fetch boundary calls this;
      // retain safe scalars, never the request, its body, or property accessors.
      const sentState = read(observation, 'state'), tier = own(observation, 'tier');
      let nextState = 'invalid', nextTier = null;
      if (sentState === 'value') {
        if (tier.kind === 'missing') nextState = 'omitted';
        else if (tier.kind === 'value' && tiers.has(tier.value)) { nextState = 'value'; nextTier = tier.value; }
      } else if (sentState === 'omitted') {
        if (tier.kind === 'missing' || tier.kind === 'null') nextState = 'omitted';
      } else if (sentState === 'unavailable' || sentState === 'invalid') nextState = sentState;
      if (state.serviceTierSentState === 'conflict' ||
          (dispatchSeen && (state.serviceTierSentState !== nextState || state.serviceTierSent !== nextTier))) {
        state.serviceTierSent = null; state.serviceTierSentState = 'conflict';
      } else { state.serviceTierSent = nextTier; state.serviceTierSentState = nextState; }
      dispatchSeen = true;
    },
    onHttpStatus(status) {
      if (Number.isInteger(status) && status >= 100 && status <= 599) state.httpStatus = status;
    },
    onRawEvent(event) {
      const type = read(event, 'type');
      if (!responseEvents.has(type)) return;
      const responseField = own(event, 'response'), response = responseField.value;
      const terminal = terminalEvents.has(type);
      if (!terminalSeen || terminal) {
        const responseState = responseField.kind === 'value' && !object(response) ? 'invalid' : responseField.kind;
        const tier = object(response) ? own(response, 'service_tier') : {kind: responseState};
        const value = tier.kind === 'value' && tiers.has(tier.value) ? tier.value : null;
        if (terminal) {
          terminalSeen = true;
          if (value !== null) {
            if (terminalTier !== null && terminalTier !== value) terminalConflict = true;
            else terminalTier = value;
          }
        }
        // A terminal omission explicitly clears an interim tier. Later interim
        // events cannot replace terminal provenance; contradictory terminal
        // values are ambiguous even if a missing/null event lies between them.
        state.serviceTierReported = terminalConflict ? null : value;
        state.serviceTierReportedState = terminalConflict ? 'conflict' :
          tier.kind === 'value' && value === null ? 'invalid' : tier.kind;
        state.serviceTierReportedSource = type;
        state.fields.serviceTierReported = state.serviceTierReportedState;
      }
      if (!object(response)) return;
      const usageField = own(response, 'usage');
      if (usageField.kind === 'missing') return;
      const usage = usageField.value;
      state.usageReported = object(usage);
      state.fields.usage = usageField.kind === 'value' && !object(usage) ? 'invalid' : usageField.kind;
      for (const key of tokenFields) { state[key] = null; state.fields[key] = state.usageReported ? 'missing' : state.fields.usage; }
      if (!state.usageReported) return;
      capture('inputTokens', usage, 'input_tokens'); // Already includes reads/writes.
      capture('outputTokens', usage, 'output_tokens');
      capture('totalTokens', usage, 'total_tokens');
      const input = own(usage, 'input_tokens_details'), output = own(usage, 'output_tokens_details');
      const inputState = input.kind === 'value' && !object(input.value) ? 'invalid' : input.kind;
      const outputState = output.kind === 'value' && !object(output.value) ? 'invalid' : output.kind;
      capture('cacheReadTokens', input.value, 'cached_tokens', inputState);
      capture('cacheWriteTokens', input.value, 'cache_write_tokens', inputState);
      capture('reasoningTokens', output.value, 'reasoning_tokens', outputState);
    },
    snapshot,
  });
  readers.set(audit, snapshot);
  return audit;
}

export function attachEvidence(value, audit) {
  if (!keyable(value) || !keyable(audit) || !readers.has(audit)) return value;
  // A shared object tagged by two requests is ambiguous, never the first/last
  // account's proof. Transport must supply request-owned chunk/error objects.
  if (tags.has(value) && tags.get(value) !== audit) tags.set(value, null);
  else tags.set(value, audit);
  return value;
}

export function readEvidence(value) {
  if (!keyable(value)) return null;
  const audit = tags.get(value);
  return audit ? readers.get(audit)() : null;
}

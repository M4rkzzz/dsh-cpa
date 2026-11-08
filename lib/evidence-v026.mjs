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
const responseEvents = new Set(['response.created', 'response.in_progress', 'response.done',
  'response.completed', 'response.incomplete', 'response.failed']);
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
    serviceTierRequested: tiers.has(requested) ? requested : null, serviceTierReported: null,
    usageReported: false, inputTokens: null, outputTokens: null, totalTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    fields: {usage: 'missing', serviceTierReported: 'missing', ...Object.fromEntries(tokenFields.map(key => [key, 'missing']))}};
  function capture(target, source, key, parentState = 'missing') {
    const field = object(source) ? own(source, key) : {kind: parentState};
    state[target] = field.kind === 'value' && count(field.value) ? field.value : null;
    state.fields[target] = field.kind === 'value' && !count(field.value) ? 'invalid' : field.kind;
  }
  const snapshot = () => ({...state, fields: {...state.fields}});
  const audit = Object.freeze({
    onHttpStatus(status) {
      if (Number.isInteger(status) && status >= 100 && status <= 599) state.httpStatus = status;
    },
    onRawEvent(event) {
      if (!responseEvents.has(read(event, 'type'))) return;
      const response = read(event, 'response');
      if (!object(response)) return;
      const tier = own(response, 'service_tier');
      if (tier.kind !== 'missing') {
        state.serviceTierReported = tier.kind === 'value' && tiers.has(tier.value) ? tier.value : null;
        state.fields.serviceTierReported = tier.kind === 'value' && !tiers.has(tier.value) ? 'invalid' : tier.kind;
      }
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

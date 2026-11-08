import * as zlib from 'node:zlib';
import {isProxy, isUint8Array} from 'node:util/types';

export const TIER_WIRE_MAX_BYTES = 1024 * 1024;
const tiers = new Set(['auto', 'default', 'flex', 'priority', 'scale']);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength').get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset').get;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer').get;
const nativeHeadersPrototype = Headers.prototype;
const nativeHeaderGet = nativeHeadersPrototype.get;
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const result = (state, tier = null) => ({tier, state});

// Reading a descriptor never invokes an accessor. Proxies and accessor-backed
// input are not wire evidence, even when a getter might return a valid tier.
function own(value, key) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return {kind: 'invalid'};
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return {kind: 'missing'};
  return Object.hasOwn(descriptor, 'value') ? {kind: 'value', value: descriptor.value} : {kind: 'invalid'};
}
function encodingValue(value) {
  if (typeof value !== 'string') return {state: 'invalid'};
  const encoding = value.trim().toLowerCase();
  return !encoding || encoding === 'identity' ? {encoding: 'identity'}
    : encoding === 'zstd' ? {encoding: 'zstd'} : {state: 'unavailable'};
}
function nativeHeaders(value) {
  // instanceof would run getPrototypeOf traps in a caller-controlled chain.
  for (let depth = 0; value !== null && depth < 64; depth++) {
    if (isProxy(value)) return null;
    if (value === nativeHeadersPrototype) return true;
    value = Object.getPrototypeOf(value);
  }
  return value === null ? false : null;
}
function contentEncoding(headers) {
  if (headers === undefined || headers === null) return {encoding: 'identity'};
  if (typeof headers !== 'object' || isProxy(headers)) return {state: 'invalid'};
  const native = nativeHeaders(headers);
  if (native === null) return {state: 'invalid'};
  if (native) {
    const value = nativeHeaderGet.call(headers, 'content-encoding');
    return value === null ? {encoding: 'identity'} : encodingValue(value);
  }
  const encodings = [];
  if (Array.isArray(headers)) {
    const length = own(headers, 'length');
    if (length.kind !== 'value' || length.value > 1024) return {state: 'unavailable'};
    for (let index = 0; index < length.value; index++) {
      const entry = own(headers, String(index));
      if (entry.kind !== 'value' || !Array.isArray(entry.value) || isProxy(entry.value)) return {state: 'invalid'};
      const size = own(entry.value, 'length'), name = own(entry.value, '0'), value = own(entry.value, '1');
      if (size.value !== 2 || name.kind !== 'value' || typeof name.value !== 'string' || value.kind !== 'value') return {state: 'invalid'};
      if (name.value.toLowerCase() === 'content-encoding') encodings.push(value.value);
    }
  } else {
    const names = Object.getOwnPropertyNames(headers);
    if (names.length > 1024) return {state: 'unavailable'};
    for (const name of names) if (name.toLowerCase() === 'content-encoding') {
      if (!Object.getOwnPropertyDescriptor(headers, name).enumerable) continue;
      const value = own(headers, name);
      if (value.kind !== 'value') return {state: 'invalid'};
      encodings.push(value.value);
    }
  }
  // Multiple encodings form a coding chain, not evidence of a single zstd body.
  return encodings.length === 0 ? {encoding: 'identity'}
    : encodings.length > 1 ? {state: 'unavailable'} : encodingValue(encodings[0]);
}

/**
 * Inspect only the final fetch init in memory. Never consume a stream, stringify
 * a caller object, retain raw bytes/headers, or alter what fetch will receive.
 * Both compressed input and decompressed output are bounded independently.
 */
export function extractServiceTierSent(init) {
  try {
    const body = own(init, 'body');
    if (body.kind === 'invalid') return result('invalid');
    if (body.kind === 'missing' || body.value === undefined || body.value === null) return result('unavailable');
    let bytes;
    if (typeof body.value === 'string') {
      if (body.value.length > TIER_WIRE_MAX_BYTES || Buffer.byteLength(body.value, 'utf8') > TIER_WIRE_MAX_BYTES) return result('unavailable');
      bytes = Buffer.from(body.value, 'utf8');
    } else if (typeof body.value === 'object' && isProxy(body.value)) {
      return result('invalid');
    } else if (isUint8Array(body.value)) {
      for (const key of ['byteLength', 'byteOffset', 'buffer']) if (own(body.value, key).kind === 'invalid') return result('invalid');
      const length = byteLength.call(body.value);
      if (length > TIER_WIRE_MAX_BYTES) return result('unavailable');
      // Use intrinsic typed-array accessors, not overridable instance getters.
      bytes = Buffer.from(new Uint8Array(arrayBuffer.call(body.value), byteOffset.call(body.value), length));
    } else {
      return result('unavailable');
    }
    const headers = own(init, 'headers');
    if (headers.kind === 'invalid') return result('invalid');
    const coding = contentEncoding(headers.value);
    if (coding.state) return result(coding.state);
    if (coding.encoding === 'zstd') {
      if (typeof zlib.zstdDecompressSync !== 'function') return result('unavailable');
      try {bytes = zlib.zstdDecompressSync(bytes, {maxOutputLength: TIER_WIRE_MAX_BYTES});}
      catch (error) {return result(own(error, 'code').value === 'ERR_BUFFER_TOO_LARGE' ? 'unavailable' : 'invalid');}
      if (bytes.byteLength > TIER_WIRE_MAX_BYTES) return result('unavailable');
    }
    const payload = JSON.parse(decoder.decode(bytes));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return result('invalid');
    const tier = own(payload, 'service_tier');
    if (tier.kind === 'missing') return result('omitted');
    return tier.kind === 'value' && tiers.has(tier.value) ? result('value', tier.value) : result('invalid');
  } catch {
    // Invalid UTF-8/JSON and hostile input cannot change request success/failure.
    return result('invalid');
  }
}

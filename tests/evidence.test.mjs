import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidence, attachEvidence, readEvidence} from '../lib/evidence-v026.mjs';

const event = (usage, extra = {}, type = 'response.completed') => ({type, response: {usage, ...extra}});
const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const known = {input_tokens: 100, output_tokens: 30, total_tokens: 130,
  input_tokens_details: {cached_tokens: 60, cache_write_tokens: 10}, output_tokens_details: {reasoning_tokens: 20}};

test('audit starts unknown and captures only safe account/request metadata', () => {
  const audit = createEvidence({accountId: 'account-a', accountEmail: 'a@example.test', serviceTierRequested: 'priority',
    headers: {authorization: 'private-token'}, messages: ['private-prompt']});
  assert.equal(Object.isFrozen(audit), true);
  const proof = audit.snapshot();
  assert.match(proof.evidenceId, /^[a-f0-9-]{36}$/);
  assert.equal(proof.accountId, 'account-a'); assert.equal(proof.accountEmail, 'a@example.test');
  assert.equal(proof.httpStatus, null); assert.equal(proof.usageReported, false);
  assert.equal(proof.serviceTierRequested, 'priority'); assert.equal(proof.serviceTierReported, null);
  for (const field of tokenFields) { assert.equal(proof[field], null); assert.equal(proof.fields[field], 'missing'); }
  assert.equal(JSON.stringify(proof).includes('private'), false);
  assert.notEqual(createEvidence().snapshot().evidenceId, proof.evidenceId);
});

test('invalid, inherited, and accessor account metadata is not coerced', () => {
  let calls = 0;
  const options = Object.create({accountId: 'inherited'});
  Object.defineProperty(options, 'accountEmail', {get() { calls++; throw Error('must not read'); }});
  options.serviceTierRequested = {toString() { calls++; return 'priority'; }};
  const proof = createEvidence(options).snapshot();
  assert.equal(proof.accountId, null); assert.equal(proof.accountEmail, null);
  assert.equal(proof.serviceTierRequested, null); assert.equal(calls, 0);
  for (const value of [null, false, 0, '', [], {accountId: '../escape', accountEmail: 'not an email', serviceTierRequested: 'unknown'}]) {
    const invalid = createEvidence(value).snapshot();
    assert.equal(invalid.accountId, null); assert.equal(invalid.accountEmail, null); assert.equal(invalid.serviceTierRequested, null);
  }
});

test('only real numeric HTTP status is accepted, and success is never guessed', () => {
  for (const status of [undefined, null, true, '200', 0, 99, 600, 200.5, NaN, Infinity]) {
    const audit = createEvidence(); audit.onHttpStatus(status); assert.equal(audit.snapshot().httpStatus, null);
  }
  for (const status of [100, 200, 401, 429, 503, 599]) {
    const audit = createEvidence(); audit.onHttpStatus(status); assert.equal(audit.snapshot().httpStatus, status);
    audit.onHttpStatus(undefined); assert.equal(audit.snapshot().httpStatus, status);
  }
});

test('provider input already includes cache and reasoning is not added to output', () => {
  const audit = createEvidence(); audit.onRawEvent(event(known));
  const proof = audit.snapshot();
  assert.equal(proof.usageReported, true);
  assert.deepEqual(tokenFields.map(field => proof[field]), [100, 30, 130, 60, 10, 20]);
  for (const field of tokenFields) assert.equal(proof.fields[field], 'value');
});

test('raw field absence, null, malformed values, and explicit zero remain distinct', () => {
  const cases = [[undefined, 'missing'], [null, 'null'], ['0', 'invalid'], [false, 'invalid'],
    [-1, 'invalid'], [1.2, 'invalid'], [NaN, 'invalid'], [Infinity, 'invalid'], [Number.MAX_SAFE_INTEGER + 1, 'invalid'],
    [[], 'invalid'], [{}, 'invalid'], [0, 'value'], [7, 'value']];
  for (const [value, kind] of cases) {
    const audit = createEvidence();
    audit.onRawEvent(event({input_tokens: value, output_tokens: value, total_tokens: value,
      input_tokens_details: {cached_tokens: value, cache_write_tokens: value}, output_tokens_details: {reasoning_tokens: value}}));
    const proof = audit.snapshot();
    for (const field of tokenFields) {
      assert.equal(proof[field], kind === 'value' ? value : null, field);
      assert.equal(proof.fields[field], kind, field);
    }
  }
});

test('missing/malformed parent cache objects never become zero', () => {
  for (const [details, kind] of [[undefined, 'missing'], [null, 'null'], [[], 'invalid'], [false, 'invalid'], ['private', 'invalid'], [{}, 'missing']]) {
    const audit = createEvidence();
    audit.onRawEvent(event({input_tokens: 20, output_tokens: 10, input_tokens_details: details, output_tokens_details: details}));
    const proof = audit.snapshot();
    for (const field of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      assert.equal(proof[field], null); assert.equal(proof.fields[field], kind);
    }
  }
});

test('raw absent and malformed usage are never authoritative default usage', () => {
  for (const [value, kind] of [[undefined, 'missing'], [null, 'null'], [false, 'invalid'], [[], 'invalid'], ['private', 'invalid']]) {
    const audit = createEvidence(); audit.onRawEvent(event(value));
    const proof = audit.snapshot();
    assert.equal(proof.usageReported, false); assert.equal(proof.fields.usage, kind);
    for (const field of tokenFields) assert.equal(proof[field], null);
  }
});

test('latest cumulative usage replaces, does not merge or add prior cache counts', () => {
  const audit = createEvidence(); audit.onRawEvent(event(known));
  audit.onRawEvent(event({input_tokens: 120, output_tokens: 40}));
  const proof = audit.snapshot();
  assert.equal(proof.inputTokens, 120); assert.equal(proof.outputTokens, 40);
  assert.equal(proof.totalTokens, null); assert.equal(proof.cacheReadTokens, null); assert.equal(proof.cacheWriteTokens, null);
  audit.onRawEvent({type: 'response.done', response: {}});
  assert.equal(audit.snapshot().inputTokens, 120);
  audit.onRawEvent(event(null));
  assert.equal(audit.snapshot().usageReported, false); assert.equal(audit.snapshot().inputTokens, null);
});

test('tier requested is not proof of tier served and reported tier is separately validated', () => {
  const audit = createEvidence({serviceTierRequested: 'priority'});
  audit.onRawEvent(event(undefined, {}, 'response.created'));
  assert.equal(audit.snapshot().serviceTierReported, null);
  audit.onRawEvent(event(undefined, {service_tier: 'default'}, 'response.in_progress'));
  assert.equal(audit.snapshot().serviceTierRequested, 'priority'); assert.equal(audit.snapshot().serviceTierReported, 'default');
  audit.onRawEvent(event(undefined, {service_tier: 'private-arbitrary-tier'}));
  assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().fields.serviceTierReported, 'invalid');
  for (const tier of ['auto', 'default', 'flex', 'priority', 'scale']) {
    audit.onRawEvent(event(undefined, {service_tier: tier})); assert.equal(audit.snapshot().serviceTierReported, tier);
  }
});

test('response lifecycle events are whitelisted; unrelated output/error objects are ignored', () => {
  for (const type of ['response.created', 'response.in_progress', 'response.completed', 'response.done', 'response.incomplete', 'response.failed']) {
    const audit = createEvidence(); audit.onRawEvent(event(known, {}, type)); assert.equal(audit.snapshot().inputTokens, 100);
  }
  const audit = createEvidence(), before = audit.snapshot();
  for (const value of [null, 'private', [], event(known, {}, 'response.output_text.delta'), {usage: known},
    {type: 'error', response: {usage: known}, error: {message: 'private'}}]) audit.onRawEvent(value);
  assert.deepEqual(audit.snapshot(), before);
});

test('audit never reads getters, inherited fields, output, headers, or serializes unknown objects', () => {
  let calls = 0;
  const hostile = {toJSON() { calls++; throw Error('private'); }};
  Object.defineProperty(hostile, 'cached_tokens', {get() { calls++; throw Error('private'); }});
  const usage = Object.assign(Object.create({input_tokens: 777}), {output_tokens: 3, input_tokens_details: hostile});
  const response = {usage};
  for (const key of ['output', 'headers', 'error']) Object.defineProperty(response, key, {get() { calls++; throw Error('private'); }});
  const audit = createEvidence(); audit.onRawEvent({type: 'response.completed', response});
  const proof = audit.snapshot();
  assert.equal(proof.inputTokens, null); assert.equal(proof.outputTokens, 3);
  assert.equal(proof.cacheReadTokens, null); assert.equal(proof.fields.cacheReadTokens, 'invalid');
  JSON.stringify(proof); assert.equal(calls, 0);
});

test('proxies, including revoked proxies, cannot supply evidence or disrupt capture', () => {
  let calls = 0;
  const proxy = new Proxy(event(known), {getOwnPropertyDescriptor() { calls++; throw Error('private'); }});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const audit = createEvidence(), before = audit.snapshot();
  assert.doesNotThrow(() => audit.onRawEvent(proxy)); assert.doesNotThrow(() => audit.onRawEvent(revoked.proxy));
  assert.deepEqual(audit.snapshot(), before); assert.equal(calls, 0);
  audit.onRawEvent(event(new Proxy(known, {})));
  assert.equal(audit.snapshot().usageReported, false); assert.equal(audit.snapshot().fields.usage, 'invalid');
  assert.doesNotThrow(() => createEvidence(revoked.proxy));
});

test('weak tagging preserves frozen chunk/error identity without adding properties', () => {
  const audit = createEvidence({accountId: 'account-a'});
  for (const value of [Object.freeze({type: 'usage'}), Object.freeze(Error('private-error')), () => {}]) {
    const keys = Reflect.ownKeys(value);
    assert.equal(attachEvidence(value, audit), value); assert.deepEqual(Reflect.ownKeys(value), keys);
    assert.equal(readEvidence(value).accountId, 'account-a');
    const copy = readEvidence(value); copy.accountId = 'fake'; copy.fields.inputTokens = 'invalid';
    assert.equal(readEvidence(value).accountId, 'account-a'); assert.equal(readEvidence(value).fields.inputTokens, 'missing');
  }
});

test('tags stay per call, cannot be forged, and shared-object conflicts fail closed', () => {
  const a = createEvidence({accountId: 'a'}), b = createEvidence({accountId: 'b'});
  const first = {}, second = {}; attachEvidence(first, a); attachEvidence(second, b);
  assert.equal(readEvidence(first).accountId, 'a'); assert.equal(readEvidence(second).accountId, 'b');
  attachEvidence(first, {snapshot() { throw Error('forged'); }}); assert.equal(readEvidence(first).accountId, 'a');
  const fake = {evidence: a.snapshot(), audit: a}; assert.equal(readEvidence(fake), null);
  attachEvidence(first, b); assert.equal(readEvidence(first), null);
  attachEvidence(first, a); assert.equal(readEvidence(first), null);
  for (const value of [undefined, null, true, false, 0, '', 'private']) {
    assert.equal(attachEvidence(value, a), value); assert.equal(readEvidence(value), null);
  }
});

test('tagged snapshots refresh from their audit but previous detached snapshots stay unchanged', () => {
  const audit = createEvidence(), frame = {}; attachEvidence(frame, audit);
  const before = readEvidence(frame); audit.onHttpStatus(200); audit.onRawEvent(event(known));
  assert.equal(before.httpStatus, null); assert.equal(before.inputTokens, null);
  assert.equal(readEvidence(frame).httpStatus, 200); assert.equal(readEvidence(frame).inputTokens, 100);
  const detached = audit.snapshot(); detached.fields.usage = 'invalid'; detached.inputTokens = 999;
  assert.equal(audit.snapshot().fields.usage, 'value'); assert.equal(audit.snapshot().inputTokens, 100);
  assert.deepEqual(Object.keys(readEvidence(frame)).sort(), ['evidenceId', 'accountId', 'accountEmail', 'httpStatus',
    'serviceTierRequested', 'serviceTierReported', 'usageReported', ...tokenFields, 'fields'].sort());
});

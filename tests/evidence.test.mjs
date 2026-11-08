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
  assert.equal(proof.serviceTierSent, null); assert.equal(proof.serviceTierSentState, 'not-sent');
  assert.equal(proof.serviceTierReportedState, null); assert.equal(proof.serviceTierReportedSource, null);
  assert.equal(proof.fields.serviceTierReported, 'missing');
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
    const independent = createEvidence(); independent.onRawEvent(event(undefined, {service_tier: tier}));
    assert.equal(independent.snapshot().serviceTierReported, tier);
    assert.equal(independent.snapshot().serviceTierReportedState, 'value');
    assert.equal(independent.snapshot().serviceTierReportedSource, 'response.completed');
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
    'serviceTierRequested', 'serviceTierSent', 'serviceTierSentState', 'serviceTierReported',
    'serviceTierReportedState', 'serviceTierReportedSource', 'usageReported', ...tokenFields, 'fields'].sort());
});

test('request preference, HTTP status, and reported tier cannot stand in for dispatch evidence', () => {
  const audit = createEvidence({serviceTierRequested: 'priority', serviceTierSent: 'priority', serviceTierSentState: 'value'});
  audit.onHttpStatus(200); audit.onRawEvent(event(known, {service_tier: 'priority'}));
  const proof = audit.snapshot();
  assert.equal(proof.serviceTierRequested, 'priority'); assert.equal(proof.serviceTierReported, 'priority');
  assert.equal(proof.serviceTierSent, null); assert.equal(proof.serviceTierSentState, 'not-sent');
});

test('only safe final dispatch observations establish a sent tier, independently of preference', () => {
  for (const tier of ['auto', 'default', 'flex', 'priority', 'scale']) {
    const audit = createEvidence({serviceTierRequested: 'flex'});
    audit.onRequestDispatch({tier, state: 'value'});
    assert.equal(audit.snapshot().serviceTierSent, tier); assert.equal(audit.snapshot().serviceTierSentState, 'value');
    assert.equal(audit.snapshot().serviceTierRequested, 'flex'); assert.equal(audit.snapshot().serviceTierReported, null);
  }
  const cases = [[{state: 'value'}, 'omitted'], [{state: 'value', tier: undefined}, 'omitted'],
    [{state: 'omitted'}, 'omitted'], [{tier: null, state: 'omitted'}, 'omitted'],
    [{tier: null, state: 'unavailable'}, 'unavailable'], [{tier: null, state: 'invalid'}, 'invalid']];
  for (const [observation, expected] of cases) {
    const audit = createEvidence({serviceTierRequested: 'priority'}); audit.onRequestDispatch(observation);
    assert.equal(audit.snapshot().serviceTierSent, null); assert.equal(audit.snapshot().serviceTierSentState, expected);
  }
});

test('dispatch rejects malformed states and tiers without coercion or raw retention', () => {
  let calls = 0;
  const hostile = {toJSON() { calls++; throw Error('private-raw'); }, toString() { calls++; return 'priority'; }};
  const malformed = [null, undefined, false, [], {}, {tier: 'priority'},
    {tier: 'priority', state: null}, {tier: 'priority', state: 'private-state'},
    {tier: 'priority', state: 'not-sent'}, {tier: 'priority', state: 'omitted'},
    {tier: null, state: 'value'}, {tier: '', state: 'value'}, {tier: 'private-tier', state: 'value'},
    {tier: hostile, state: 'value'}, {tier: 0, state: 'value'}, {tier: false, state: 'value'},
    {tier: [], state: 'value'}, {tier: 'priority', state: hostile}, Object.create({tier: 'priority', state: 'value'})];
  for (const observation of malformed) {
    const audit = createEvidence(); assert.doesNotThrow(() => audit.onRequestDispatch(observation));
    const proof = audit.snapshot();
    assert.equal(proof.serviceTierSent, null); assert.equal(proof.serviceTierSentState, 'invalid');
    assert.equal(JSON.stringify(proof).includes('private'), false);
  }
  assert.equal(calls, 0);
  const inheritedTier = Object.assign(Object.create({tier: 'priority'}), {state: 'value'});
  const audit = createEvidence(); audit.onRequestDispatch(inheritedTier);
  assert.equal(audit.snapshot().serviceTierSentState, 'omitted');
});

test('repeated matching dispatches are stable and any different observation permanently conflicts', () => {
  const observations = [{tier: 'priority', state: 'value'}, {tier: 'default', state: 'value'},
    {tier: null, state: 'omitted'}, {tier: null, state: 'unavailable'}, {tier: null, state: 'invalid'}];
  for (const first of observations) for (const second of observations) {
    const audit = createEvidence(); audit.onRequestDispatch(first);
    const before = audit.snapshot(); audit.onRequestDispatch({...first}); assert.deepEqual(audit.snapshot(), before);
    audit.onRequestDispatch(second);
    if (first === second) assert.deepEqual(audit.snapshot(), before);
    else {
      assert.equal(audit.snapshot().serviceTierSent, null); assert.equal(audit.snapshot().serviceTierSentState, 'conflict');
      audit.onRequestDispatch(first); audit.onRequestDispatch(second);
      audit.onRawEvent(event(known, {service_tier: 'priority'}));
      assert.equal(audit.snapshot().serviceTierSent, null); assert.equal(audit.snapshot().serviceTierSentState, 'conflict');
    }
  }
  const audit = createEvidence(); audit.onRequestDispatch({state: 'value'}); audit.onRequestDispatch({tier: null, state: 'omitted'});
  assert.equal(audit.snapshot().serviceTierSentState, 'omitted');
});

test('dispatch accessors and proxies never run and request objects are never retained', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('private-request'); };
  const hostile = {toJSON: getter, toString: getter};
  const withTierGetter = {state: 'value'}, withStateGetter = {tier: 'priority'};
  Object.defineProperty(withTierGetter, 'tier', {get: getter});
  Object.defineProperty(withStateGetter, 'state', {get: getter});
  const proxy = new Proxy({tier: 'priority', state: 'value'}, {get: getter, getOwnPropertyDescriptor: getter});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const observation of [withTierGetter, withStateGetter, proxy, revoked.proxy, {state: 'value', tier: proxy}]) {
    const audit = createEvidence(); assert.doesNotThrow(() => audit.onRequestDispatch(observation));
    assert.equal(audit.snapshot().serviceTierSentState, 'invalid'); JSON.stringify(audit.snapshot());
  }
  const observation = {tier: 'priority', state: 'value', raw: hostile};
  for (const key of ['body', 'headers', 'request']) Object.defineProperty(observation, key, {get: getter});
  const audit = createEvidence(); audit.onRequestDispatch(observation);
  observation.tier = 'default'; observation.state = 'private-state';
  assert.equal(audit.snapshot().serviceTierSent, 'priority'); assert.equal(audit.snapshot().serviceTierSentState, 'value');
  assert.equal(JSON.stringify(audit.snapshot()).includes('private'), false); assert.equal(calls, 0);
});

test('created default followed by completed missing is distinct from completed default', () => {
  for (const reported of [undefined, 'default']) {
    const audit = createEvidence({serviceTierRequested: 'priority'});
    audit.onRequestDispatch({tier: 'priority', state: 'value'});
    audit.onRawEvent(event(undefined, {service_tier: 'default'}, 'response.created'));
    const created = audit.snapshot();
    assert.equal(created.serviceTierReported, 'default'); assert.equal(created.serviceTierReportedState, 'value');
    assert.equal(created.serviceTierReportedSource, 'response.created');
    audit.onRawEvent(event(known, reported === undefined ? {} : {service_tier: reported}));
    const completed = audit.snapshot();
    assert.equal(completed.serviceTierReported, reported ?? null);
    assert.equal(completed.serviceTierReportedState, reported === undefined ? 'missing' : 'value');
    assert.equal(completed.fields.serviceTierReported, completed.serviceTierReportedState);
    assert.equal(completed.serviceTierReportedSource, 'response.completed');
    assert.equal(completed.serviceTierSent, 'priority'); assert.equal(completed.inputTokens, 100);
    assert.equal(created.serviceTierReported, 'default'); assert.equal(created.serviceTierReportedSource, 'response.created');
  }
});

test('each whitelisted lifecycle records safe tier presence and its exact source', () => {
  const cases = [[undefined, 'missing'], [null, 'null'], ['priority', 'value'], ['private-tier', 'invalid'],
    [0, 'invalid'], [false, 'invalid'], [[], 'invalid'], [{}, 'invalid']];
  for (const type of ['response.created', 'response.in_progress', 'response.done', 'response.completed', 'response.incomplete', 'response.failed']) {
    for (const [tier, expected] of cases) {
      const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: tier}, type));
      const proof = audit.snapshot();
      assert.equal(proof.serviceTierReported, expected === 'value' ? tier : null);
      assert.equal(proof.serviceTierReportedState, expected); assert.equal(proof.fields.serviceTierReported, expected);
      assert.equal(proof.serviceTierReportedSource, type); assert.equal(proof.inputTokens, 100);
      assert.equal(JSON.stringify(proof).includes('private-tier'), false);
    }
  }
});

test('all terminal omissions clear interim tiers without resetting cumulative usage', () => {
  for (const type of ['response.done', 'response.completed', 'response.incomplete', 'response.failed']) {
    const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: 'default'}, 'response.created'));
    audit.onRawEvent({type, response: {}});
    const proof = audit.snapshot();
    assert.equal(proof.serviceTierReported, null); assert.equal(proof.serviceTierReportedState, 'missing');
    assert.equal(proof.fields.serviceTierReported, 'missing'); assert.equal(proof.serviceTierReportedSource, type);
    assert.equal(proof.usageReported, true); assert.equal(proof.inputTokens, 100); assert.equal(proof.cacheReadTokens, 60);
  }
});

test('terminal tier provenance cannot be overwritten by any subsequent interim observation', () => {
  for (const type of ['response.done', 'response.completed', 'response.incomplete', 'response.failed']) {
    for (const tier of [undefined, null, 'priority', 'private-tier']) {
      const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: tier}, type));
      const terminal = audit.snapshot();
      for (const interim of ['response.created', 'response.in_progress']) for (const later of [undefined, null, 'default']) {
        audit.onRawEvent(event(undefined, {service_tier: later}, interim));
        const proof = audit.snapshot();
        for (const key of ['serviceTierReported', 'serviceTierReportedState', 'serviceTierReportedSource']) assert.equal(proof[key], terminal[key]);
        assert.equal(proof.fields.serviceTierReported, terminal.fields.serviceTierReported);
      }
      audit.onRawEvent(event({input_tokens: 120, output_tokens: 40}, {service_tier: 'default'}, 'response.in_progress'));
      assert.equal(audit.snapshot().inputTokens, 120); assert.equal(audit.snapshot().outputTokens, 40);
      assert.equal(audit.snapshot().cacheReadTokens, null); assert.equal(audit.snapshot().serviceTierReportedSource, type);
    }
  }
});

test('matching terminal values stay usable and contradictory terminal values fail closed permanently', () => {
  const audit = createEvidence();
  audit.onRawEvent(event(undefined, {service_tier: 'default'}, 'response.created'));
  audit.onRawEvent(event(known, {service_tier: 'priority'}, 'response.completed'));
  audit.onRawEvent(event(undefined, {service_tier: 'priority'}, 'response.done'));
  assert.equal(audit.snapshot().serviceTierReported, 'priority'); assert.equal(audit.snapshot().serviceTierReportedState, 'value');
  assert.equal(audit.snapshot().serviceTierReportedSource, 'response.done');
  audit.onRawEvent({type: 'response.failed', response: {}});
  assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().serviceTierReportedState, 'missing');
  audit.onRawEvent(event(undefined, {service_tier: 'default'}, 'response.incomplete'));
  assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().serviceTierReportedState, 'conflict');
  assert.equal(audit.snapshot().fields.serviceTierReported, 'conflict'); assert.equal(audit.snapshot().serviceTierReportedSource, 'response.incomplete');
  for (const tier of [undefined, null, 'priority', 'private-tier']) {
    audit.onRawEvent(event(undefined, {service_tier: tier}, 'response.completed'));
    audit.onRawEvent(event(undefined, {service_tier: 'default'}, 'response.in_progress'));
    assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().serviceTierReportedState, 'conflict');
    assert.equal(audit.snapshot().serviceTierReportedSource, 'response.completed');
  }
  assert.equal(audit.snapshot().inputTokens, 100); assert.equal(audit.snapshot().cacheReadTokens, 60);
});

test('a later terminal missing, null, or invalid tier never retains a prior terminal value', () => {
  for (const [tier, expected] of [[undefined, 'missing'], [null, 'null'], ['private-tier', 'invalid']]) {
    const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: 'priority'}));
    audit.onRawEvent(event(undefined, {service_tier: tier}, 'response.done'));
    assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().serviceTierReportedState, expected);
    assert.equal(audit.snapshot().serviceTierReportedSource, 'response.done');
    audit.onRawEvent(event(undefined, {service_tier: 'priority'}, 'response.completed'));
    assert.equal(audit.snapshot().serviceTierReported, 'priority'); assert.equal(audit.snapshot().serviceTierReportedState, 'value');
  }
});

test('missing, null, accessor, and proxy terminal response parents clear interim tier safely', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('private-response'); };
  const proxy = new Proxy({}, {get: getter, getOwnPropertyDescriptor: getter});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessor = {type: 'response.completed'}; Object.defineProperty(accessor, 'response', {get: getter});
  const cases = [[{type: 'response.completed'}, 'missing'], [{type: 'response.completed', response: null}, 'null'],
    [{type: 'response.completed', response: []}, 'invalid'], [{type: 'response.completed', response: false}, 'invalid'],
    [{type: 'response.completed', response: proxy}, 'invalid'], [{type: 'response.completed', response: revoked.proxy}, 'invalid'], [accessor, 'invalid']];
  for (const [raw, expected] of cases) {
    const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: 'default'}, 'response.created'));
    assert.doesNotThrow(() => audit.onRawEvent(raw));
    assert.equal(audit.snapshot().serviceTierReported, null); assert.equal(audit.snapshot().serviceTierReportedState, expected);
    assert.equal(audit.snapshot().fields.serviceTierReported, expected); assert.equal(audit.snapshot().serviceTierReportedSource, 'response.completed');
    assert.equal(audit.snapshot().inputTokens, 100); JSON.stringify(audit.snapshot());
  }
  assert.equal(calls, 0);
});

test('tier accessors, inherited values, and proxies cannot supply reported values or leak raw data', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('private-tier'); };
  const hostile = {toJSON: getter, toString: getter};
  const proxy = new Proxy({private: 'raw'}, {get: getter, getOwnPropertyDescriptor: getter});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessor = {}; Object.defineProperty(accessor, 'service_tier', {get: getter});
  const cases = [[accessor, 'invalid'], [Object.create({service_tier: 'priority'}), 'missing'],
    [{service_tier: hostile}, 'invalid'], [{service_tier: proxy}, 'invalid'], [{service_tier: revoked.proxy}, 'invalid']];
  for (const [response, expected] of cases) {
    const audit = createEvidence(); audit.onRawEvent({type: 'response.completed', response});
    const proof = audit.snapshot();
    assert.equal(proof.serviceTierReported, null); assert.equal(proof.serviceTierReportedState, expected);
    assert.equal(proof.serviceTierReportedSource, 'response.completed'); assert.equal(JSON.stringify(proof).includes('private'), false);
  }
  assert.equal(calls, 0);
});

test('tier sources reject unrelated, inherited, getter, and proxy event types', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('private-event'); };
  const accessor = {response: {service_tier: 'default'}}; Object.defineProperty(accessor, 'type', {get: getter});
  const proxy = new Proxy({type: 'response.completed'}, {get: getter, getOwnPropertyDescriptor: getter});
  const audit = createEvidence(); audit.onRawEvent(event(known, {service_tier: 'priority'})); const before = audit.snapshot();
  for (const raw of [accessor, proxy, Object.assign(Object.create({type: 'response.completed'}), {response: {service_tier: 'default'}}),
    event(known, {service_tier: 'default'}, 'response.output_text.delta'), event(known, {service_tier: 'default'}, 'private-event')]) {
    assert.doesNotThrow(() => audit.onRawEvent(raw)); assert.deepEqual(audit.snapshot(), before);
  }
  assert.equal(calls, 0);
});

test('new tier scalars refresh weak-tagged reads while detached snapshots remain independent', () => {
  const audit = createEvidence({serviceTierRequested: 'priority'}), frame = Object.freeze({}); attachEvidence(frame, audit);
  const before = readEvidence(frame); audit.onRequestDispatch({tier: 'priority', state: 'value'});
  audit.onRawEvent(event(known, {service_tier: 'default'}, 'response.created')); const created = readEvidence(frame);
  audit.onRawEvent({type: 'response.completed', response: {}}); const completed = readEvidence(frame);
  assert.equal(before.serviceTierSent, null); assert.equal(before.serviceTierSentState, 'not-sent');
  assert.equal(before.serviceTierReportedState, null); assert.equal(before.serviceTierReportedSource, null);
  assert.equal(created.serviceTierSent, 'priority'); assert.equal(created.serviceTierReported, 'default');
  assert.equal(created.serviceTierReportedState, 'value'); assert.equal(created.serviceTierReportedSource, 'response.created');
  assert.equal(completed.serviceTierReported, null); assert.equal(completed.serviceTierReportedState, 'missing');
  assert.equal(completed.serviceTierReportedSource, 'response.completed');
  completed.serviceTierSent = 'flex'; completed.serviceTierSentState = 'conflict'; completed.serviceTierReported = 'priority';
  completed.serviceTierReportedState = 'value'; completed.serviceTierReportedSource = 'response.created'; completed.fields.serviceTierReported = 'invalid';
  const refreshed = readEvidence(frame);
  assert.equal(refreshed.serviceTierSent, 'priority'); assert.equal(refreshed.serviceTierSentState, 'value');
  assert.equal(refreshed.serviceTierReported, null); assert.equal(refreshed.serviceTierReportedState, 'missing');
  assert.equal(refreshed.serviceTierReportedSource, 'response.completed'); assert.equal(refreshed.fields.serviceTierReported, 'missing');
});

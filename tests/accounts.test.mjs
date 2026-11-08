import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {AuthorizationService} from '@deepseek-ai/dsh-authorization';
import {createAccounts} from '../lib/accounts-v026.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NATIVE = 'llm-pi-ai/openai-codex';
const keyFor = id => 'cpa-codex/' + id;
const providerFor = id => 'cpa-codex-' + id;
const NOW = 1700000000000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function token(person = 'alice', {email = person + '@example.test', subject = 'subject-' + person, user = 'user-' + person, account = 'upstream-' + person, version = 1} = {}) {
  return 'synthetic.' + Buffer.from(JSON.stringify({sub: subject, ...(email === undefined ? {} : {email}), version,
    'https://api.openai.com/auth': {chatgpt_account_id: account, ...(user === undefined ? {} : {chatgpt_user_id: user})}})).toString('base64url') + '.signature';
}
const principalHash = (person = 'alice') => createHash('sha256').update(JSON.stringify(['upstream-' + person, 'user-' + person])).digest('hex');
const grant = (person = 'alice', overrides = {}) => ({type: 'oauth', access: token(person), refresh: 'synthetic-refresh-' + person,
  expires: NOW + 3600000, accountId: 'upstream-' + person, ...overrides});
const record = (id = A, person = 'alice', overrides = {}) => ({kind: 'grant', payload: {...grant(person, overrides),
  ...(id === null ? {} : {cpaBinding: {version: 1, id, principalHash: principalHash(person)}})}});
function memoryContext(initial) {
  const ctx = new Context(), records = new Map(initial ?? [[keyFor(A), record()], [NATIVE, record(null, 'native')]]);
  const locks = new Map(), reads = [], writes = [], deletions = [], hooks = {}, diagnostics = [];
  function locked(key, action) {
    const previous = locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    locks.set(key, task.catch(() => {}));
    return task;
  }
  const credentials = {
    async listRecords() {if (hooks.list) return hooks.list(); return [...records].map(([key, value]) => ({key, kind: value.kind}));},
    async readRecord(key) {reads.push(key); if (hooks.read) return hooks.read(key); return records.get(key);},
    async describeRecord(key) {return {configured: records.has(key), writable: true, ...(records.has(key) ? {kind: records.get(key).kind} : {})};},
    modifyRecord(key, mutate) {
      const task = locked(key, async () => {
        await hooks.beforeMutation?.(key);
        const next = await mutate(records.get(key));
        if (next !== undefined) {records.set(key, structuredClone(next)); writes.push(key); ctx.emit('credentials/record-updated', key);}
        return records.get(key);
      });
      return task.then(async value => {await hooks.ack?.(key, value); return value;});
    },
    deleteRecord(key) {return locked(key, async () => {await hooks.delete?.(key); deletions.push(key); const deleted = records.delete(key);
      if (deleted) ctx.emit('credentials/record-updated', key);});},
    resolve() {throw new Error('ambient references must never be consulted');},
    set() {throw new Error('the global credential reference must never be changed');},
    unset() {throw new Error('the global credential reference must never be removed');},
  };
  const off = ctx.provide('credentials', credentials);
  const authorization = new AuthorizationService(ctx);
  return {ctx, credentials, authorization, records, reads, writes, deletions, hooks, diagnostics, off};
}
async function fixture(t, {records, options = {}} = {}) {
  const memory = memoryContext(records);
  let clock = NOW;
  const manager = createAccounts(memory.ctx, {now: () => clock, onError: code => memory.diagnostics.push(code), ...options});
  t.after(async () => {await manager.dispose(); memory.off();});
  return {...memory, manager, setNow: value => {clock = value;}};
}

test('registry enumerates only owned UUID records and the bound native reference with detached safe DTOs', async t => {
  const f = await fixture(t, {records: [[keyFor(A), record()], [keyFor(B), record(B, 'bob')], [NATIVE, record(null, 'native')],
    ['another-plugin/record', record(null, 'foreign')], ['cpa-codex/not-a-uuid', record(null, 'foreign')], ['cpa-codex/' + A + '/path', record()]]});
  const rows = await f.manager.list();
  assert.equal(rows.length, 3); assert.ok(rows.some(row => row.id === A && row.owned));
  assert.ok(rows.some(row => row.id === 'native-' + principalHash('native').slice(0, 32) && !row.owned));
  for (const row of rows) {assert.equal(row.provider, providerFor(row.id)); assert.equal(row.availability, 'ready'); assert.equal(row.canRunProbe, true);}
  const json = JSON.stringify(rows);
  for (const secret of ['synthetic-refresh', '.signature', 'principalHash', 'cpaBinding', NATIVE, 'access']) assert.ok(!json.includes(secret), secret);
  assert.ok(f.reads.every(key => key === NATIVE || key === keyFor(A) || key === keyFor(B)));
  rows[0].email = 'mutated@example.test'; assert.notEqual((await f.manager.list())[0].email, rows[0].email);
});

test('native account remains a reference to its one original key and cannot be deleted', async t => {
  const f = await fixture(t), native = (await f.manager.list()).find(row => !row.owned);
  const binding = await f.manager.capture(native.id, native.provider);
  const value = await binding.credentials.read(native.provider);
  assert.equal(value.refresh, 'synthetic-refresh-native');
  await binding.credentials.modify(native.provider, current => ({...current, access: token('native', {version: 2})}));
  assert.deepEqual(f.writes, [NATIVE]); assert.equal(f.records.size, 2);
  await assert.rejects(f.manager.remove(native.id), {code: 'account-delete-forbidden'});
  await assert.rejects(binding.credentials.delete(native.provider), {code: 'account-delete-forbidden'});
  assert.equal(f.deletions.length, 0);
});

test('captures accept only stable account IDs and scoped stores reject every foreign provider before mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.capture('alice@example.test', providerFor(A)), {code: 'account-provider-mismatch'});
  await assert.rejects(f.manager.capture(A, 'openai-codex'), {code: 'account-provider-mismatch'});
  await assert.rejects(f.manager.capture('missing', providerFor('missing')), {code: 'account-not-found'});
  await assert.rejects(f.manager.capture(null, ''), {code: 'account-not-found'});
  const binding = await f.manager.capture(A, providerFor(A));
  let invoked = 0;
  for (const foreign of ['openai-codex', providerFor(B), keyFor(A), '../' + A, '', null]) {
    await assert.rejects(binding.credentials.read(foreign), {code: 'account-provider-mismatch'});
    await assert.rejects(binding.credentials.modify(foreign, () => {invoked++;}), {code: 'account-provider-mismatch'});
    await assert.rejects(binding.credentials.delete(foreign), {code: 'account-provider-mismatch'});
  }
  assert.equal(invoked, 0); assert.equal(f.writes.length, 0);
  assert.deepEqual(await binding.credentials.list(), [{providerId: providerFor(A), type: 'oauth'}]);
});

test('binding identity and returned credential snapshots are immutable and never expose binding metadata', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A));
  assert.equal(Object.isFrozen(binding), true); assert.equal(Object.isFrozen(binding.credentials), true);
  assert.throws(() => {binding.accountId = B;}, TypeError);
  const value = await binding.credentials.read(providerFor(A));
  value.access = 'mutated'; value.accountId = 'wrong';
  const next = await binding.credentials.read(providerFor(A)); assert.equal(next.accountId, 'upstream-alice'); assert.notEqual(next.access, 'mutated');
  const bridge = await binding.readCredentialRecord();
  assert.equal(bridge.kind, 'grant'); assert.equal(Object.hasOwn(bridge.payload, 'cpaBinding'), false);
  bridge.payload.refresh = 'mutated'; assert.equal((await binding.readCredentialRecord()).payload.refresh, 'synthetic-refresh-alice');
});

test('malformed owned grants are visibly unavailable and cannot fall back to the valid native account', async t => {
  const malformed = [
    {kind: 'api-key', key: 'synthetic'}, {kind: 'grant', payload: null},
    record(A, 'alice', {type: 'api_key'}), record(A, 'alice', {access: 'not-a-token'}),
    record(A, 'alice', {expires: null}), record(A, 'alice', {expires: '1700000000001'}),
    record(A, 'alice', {refresh: ''}), record(A, 'alice', {accountId: 'wrong-account'}),
    record(A, 'alice', {access: token('alice', {user: null})}),
    {...record(), payload: {...record().payload, cpaBinding: {version: 1, id: B, principalHash: principalHash()}}},
    {...record(), payload: {...record().payload, cpaBinding: {version: 1, id: A, principalHash: 'wrong'}}},
    {...record(), payload: {...record().payload, cpaBinding: {version: 2, id: A, principalHash: principalHash()}}},
  ];
  for (const value of malformed) {
    const f = await fixture(t, {records: [[keyFor(A), value], [NATIVE, record(null, 'native')]]});
    const row = (await f.manager.list()).find(row => row.id === A);
    assert.equal(row.availability, 'unavailable'); assert.equal(row.canRunProbe, false); assert.equal(row.email, null);
    await assert.rejects(f.manager.capture(A, row.provider), {code: 'account-unavailable'});
    assert.equal(f.writes.length, 0);
  }
});

test('expiry without a refresh grant invalidates work while an expired refreshable grant stays configured', async t => {
  const f = await fixture(t, {records: [[keyFor(A), record(A, 'alice', {refresh: undefined, expires: NOW + 10})],
    [keyFor(B), record(B, 'bob', {expires: NOW - 10})]]});
  const binding = await f.manager.capture(A, providerFor(A));
  f.setNow(NOW + 20);
  await assert.rejects(binding.assertCurrent(), {code: 'account-unavailable'}); assert.equal(binding.signal.aborted, true);
  const rows = await f.manager.list();
  assert.equal(rows.find(row => row.id === A).canRunProbe, false); assert.equal(rows.find(row => row.id === B).canRunProbe, true);
});

test('missing email is null and same-principal email or token rotation does not change ownership', async t => {
  const f = await fixture(t, {records: [[keyFor(A), record(A, 'alice', {access: token('alice', {email: null})})]]});
  assert.equal((await f.manager.list())[0].email, null);
  const binding = await f.manager.capture(A, providerFor(A));
  f.records.set(keyFor(A), record(A, 'alice', {access: token('alice', {email: 'new@example.test', version: 2})}));
  f.ctx.emit('credentials/record-updated', keyFor(A));
  const rows = await f.manager.list();
  assert.equal(rows[0].email, 'new@example.test'); assert.equal(binding.email, null);
  assert.equal(binding.signal.aborted, false); await binding.assertCurrent();
});

test('native identity replacement gets a new stable opaque route and revokes old captures without token copying', async t => {
  const f = await fixture(t), old = (await f.manager.list()).find(row => !row.owned);
  const binding = await f.manager.capture(old.id, old.provider);
  f.records.set(NATIVE, record(null, 'replacement')); f.ctx.emit('credentials/record-updated', NATIVE);
  const next = (await f.manager.list()).find(row => !row.owned);
  assert.notEqual(next.id, old.id); assert.equal(next.id, 'native-' + principalHash('replacement').slice(0, 32));
  assert.equal(binding.signal.aborted, true); await assert.rejects(binding.assertCurrent(), {code: 'account-changed'});
  await assert.rejects(f.manager.capture(old.id, old.provider), {code: 'account-not-found'});
  assert.equal(f.writes.length, 0); assert.equal(f.deletions.length, 0);
});

test('external removal or malformed identity revokes captures and never returns another account grant', async t => {
  for (const change of ['delete', 'principal', 'metadata']) {
    const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A));
    if (change === 'delete') f.records.delete(keyFor(A));
    if (change === 'principal') f.records.set(keyFor(A), record(A, 'bob'));
    if (change === 'metadata') f.records.set(keyFor(A), {...record(), payload: {...record().payload, cpaBinding: null}});
    await assert.rejects(binding.credentials.read(providerFor(A)), {code: 'account-changed'});
    assert.equal(binding.signal.aborted, true);
    assert.equal(f.records.get(NATIVE).payload.accountId, 'upstream-native');
  }
});

test('owned refresh preserves immutable principal metadata and native refresh preserves host-owned payload fields', async t => {
  const f = await fixture(t);
  f.records.get(NATIVE).payload.hostMetadata = {keep: true};
  const native = (await f.manager.list()).find(row => !row.owned);
  for (const row of [{id: A, provider: providerFor(A), person: 'alice', key: keyFor(A)}, {...native, person: 'native', key: NATIVE}]) {
    const binding = await f.manager.capture(row.id, row.provider);
    const rotated = await binding.credentials.modify(row.provider, current => ({...current, access: token(row.person, {version: 2}),
      refresh: 'rotated-' + row.person, cpaBinding: {id: 'untrusted'}}));
    assert.equal(rotated.refresh, 'rotated-' + row.person); assert.equal(binding.signal.aborted, false);
    const saved = f.records.get(row.key).payload;
    if (row.key === NATIVE) assert.deepEqual(saved.hostMetadata, {keep: true});
    else assert.deepEqual(saved.cpaBinding, {version: 1, id: A, principalHash: principalHash()});
    assert.equal(Object.hasOwn(rotated, 'cpaBinding'), false);
  }
});

test('concurrent refresh mutations share one exact host key lock and see the prior committed token', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A)), gate = deferred(), entered = deferred();
  const seen = [];
  const first = binding.credentials.modify(providerFor(A), async current => {seen.push(current.refresh); entered.resolve(); await gate.promise;
    return {...current, refresh: 'rotation-one', access: token('alice', {version: 2})};});
  await entered.promise;
  const second = binding.credentials.modify(providerFor(A), current => {seen.push(current.refresh); return {...current, refresh: 'rotation-two', access: token('alice', {version: 3})};});
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(seen, ['synthetic-refresh-alice', 'rotation-one']);
  assert.equal(f.records.get(keyFor(A)).payload.refresh, 'rotation-two');
  assert.ok(f.writes.every(key => key === keyFor(A)));
});

test('identity is rechecked under the lock instead of trusting an optimistic credential read', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A)), entered = deferred(), gate = deferred();
  f.hooks.beforeMutation = async key => {if (key === keyFor(A)) {entered.resolve(); await gate.promise;}};
  let ran = false;
  const mutation = binding.credentials.modify(providerFor(A), current => {ran = true; return current;});
  const rejected = assert.rejects(mutation, {code: 'account-changed'});
  await entered.promise; f.records.set(keyFor(A), record(A, 'bob')); gate.resolve(); await rejected;
  assert.equal(ran, false); assert.equal(binding.signal.aborted, true); assert.equal(f.writes.length, 0);
});

test('invalid or different-principal refresh results fail closed before overwriting the bound grant', async t => {
  for (const next of [grant('bob'), {...grant(), accountId: 'wrong'}, {...grant(), type: 'api_key'}, {...grant(), refresh: ''}]) {
    const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A));
    await assert.rejects(binding.credentials.modify(providerFor(A), () => next), error => ['account-changed', 'account-invalid-grant'].includes(error.code));
    assert.equal(binding.signal.aborted, true); assert.equal(f.writes.length, 0);
    assert.equal(f.records.get(keyFor(A)).payload.refresh, 'synthetic-refresh-alice');
  }
});

test('a provider mutation failure is propagated unchanged and does not destroy a valid credential', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A)), sentinel = new Error('synthetic provider error');
  await assert.rejects(binding.credentials.modify(providerFor(A), () => {throw sentinel;}), error => error === sentinel);
  assert.equal(binding.signal.aborted, false); await binding.assertCurrent(); assert.equal(f.writes.length, 0);
});

test('post-lock acknowledgement and fresh reads detect replacement by another writer', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A));
  f.hooks.ack = async key => {if (key === keyFor(A)) f.records.set(key, record(A, 'bob'));};
  await assert.rejects(binding.credentials.modify(providerFor(A), current => ({...current, refresh: 'rotation-one'})), {code: 'account-changed'});
  assert.equal(binding.signal.aborted, true); assert.equal(f.records.get(keyFor(A)).payload.accountId, 'upstream-bob');
});

test('once refresh starts, caller cancellation or disposal cannot discard its same-principal rotating token', async t => {
  for (const stop of ['caller', 'dispose']) {
    const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A)), gate = deferred(), entered = deferred(), caller = new AbortController();
    const mutation = binding.credentials.modify(providerFor(A), async current => {entered.resolve(); await gate.promise;
      return {...current, refresh: 'rotation-after-stop', access: token('alice', {version: 4})};}, {signal: caller.signal});
    const checked = stop === 'dispose' ? assert.rejects(mutation, {code: 'accounts-disposed'}) : mutation;
    await entered.promise;
    if (stop === 'caller') caller.abort(); else await f.manager.dispose();
    gate.resolve(); await checked;
    assert.equal(f.records.get(keyFor(A)).payload.refresh, 'rotation-after-stop');
  }
});

test('account removal aborts prepared work, serializes after in-progress refresh and deletes only its owned key', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A)), gate = deferred(), entered = deferred();
  const mutation = binding.credentials.modify(providerFor(A), async current => {entered.resolve(); await gate.promise; return {...current, refresh: 'late-rotation'};});
  const rejected = assert.rejects(mutation, error => ['account-changed', 'account-not-found'].includes(error.code));
  await entered.promise;
  const removal = f.manager.remove(A); await tick(); assert.equal(binding.signal.aborted, true);
  gate.resolve(); await Promise.all([rejected, removal]);
  assert.equal(f.records.has(keyFor(A)), false); assert.equal(f.records.has(NATIVE), true); assert.deepEqual(f.deletions, [keyFor(A)]);
  assert.ok(!(await f.manager.list()).some(row => row.id === A));
});

test('store failures invalidate work and expose fixed diagnostics, never original error text', async t => {
  const f = await fixture(t), binding = await f.manager.capture(A, providerFor(A));
  f.hooks.read = () => {throw new Error('synthetic-private-token-and-path');};
  await assert.rejects(binding.assertCurrent(), {message: 'accounts-unavailable', code: 'accounts-unavailable'});
  assert.equal(binding.signal.aborted, true);
  await assert.rejects(f.manager.list(), {message: 'accounts-unavailable'});
  assert.ok(!JSON.stringify(f.diagnostics).includes('synthetic-private-token-and-path'));
});

test('registry restarts restore the same opaque identities without a second credential custodian', async t => {
  const f = await fixture(t), before = await f.manager.list();
  const binding = await f.manager.capture(A, providerFor(A));
  await f.manager.dispose(); assert.equal(binding.signal.aborted, true);
  const restored = createAccounts(f.ctx, {now: () => NOW}); t.after(() => restored.dispose());
  assert.deepEqual(await restored.list(), before); assert.equal(f.writes.length, 0); assert.equal(f.records.size, 2);
  await assert.rejects(f.manager.list(), {code: 'accounts-disposed'});
});

test('unrelated credential updates are ignored and failing onChange listeners are observed safely', async t => {
  const f = await fixture(t), changed = [];
  const off = f.manager.onChange(() => {changed.push(true); return Promise.reject(new Error('synthetic listener detail'));});
  await f.manager.list(); await tick(); assert.ok(f.diagnostics.includes('accounts-unavailable'));
  const count = f.reads.length;
  f.ctx.emit('credentials/record-updated', 'another-plugin/record'); await tick();
  assert.equal(f.reads.length, count);
  off(); f.records.delete(keyFor(A)); f.ctx.emit('credentials/record-updated', keyFor(A)); await f.manager.list();
  assert.equal(changed.length, 1);
});

test('durable pending markers always fail closed until explicitly removed by successful activation', async t => {
  for (const marker of [true, false, null, 'ready']) {
    const staged = record(); staged.payload.cpaBinding.pending = marker;
    const f = await fixture(t, {records: [[keyFor(A), staged]]});
    assert.equal((await f.manager.list())[0].canRunProbe, false);
    await assert.rejects(f.manager.capture(A, providerFor(A)), {code: 'account-unavailable'});
    await f.manager.remove(A); assert.equal(f.records.size, 0);
  }
});

test('asynchronously rejected account diagnostics are contained without leaking listener details', async t => {
  const codes = [], f = await fixture(t, {options: {onError: code => {codes.push(code); return Promise.reject(new Error('synthetic private reporter failure'));}}});
  f.manager.onChange(() => Promise.reject(new Error('synthetic private listener failure')));
  await f.manager.list(); await tick(); assert.deepEqual(codes, ['accounts-unavailable']);
});

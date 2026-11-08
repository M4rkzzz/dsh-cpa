import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {Context} from '@deepseek-ai/cordis';
import {AuthorizationService} from '@deepseek-ai/dsh-authorization';
import {createAccountLogin} from '../lib/auth-v026.mjs';
import {createAccounts} from '../lib/accounts-v026.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const NATIVE = 'llm-pi-ai/openai-codex', keyFor = id => 'cpa-codex/' + id;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const REDIRECT = 'http://localhost:1455/auth/callback';
function authURL(state = 'state-1', redirect = REDIRECT) {const url = new URL('https://auth.openai.com/oauth/authorize');
  url.searchParams.set('state', state); url.searchParams.set('redirect_uri', redirect); return url.href;}
function callbackURL(state = 'state-1', base = REDIRECT) {const url = new URL(base); url.searchParams.set('state', state); url.searchParams.set('code', 'synthetic-code'); return url.href;}
function grant(person = 'alice') {return {type: 'oauth', access: 'synthetic.' + Buffer.from(JSON.stringify({sub: 'user-' + person,
  email: person + '@example.test', 'https://api.openai.com/auth': {chatgpt_account_id: 'upstream-' + person, chatgpt_user_id: 'user-' + person}})).toString('base64url') + '.signature',
  refresh: 'synthetic-refresh-' + person, expires: Date.now() + 3600000, accountId: 'upstream-' + person};}
function makeRecord(value, id) {
  if (!value || value.type !== 'oauth' || typeof value.access !== 'string' || !Number.isFinite(value.expires)) throw Object.assign(Error('account-invalid-grant'), {code: 'account-invalid-grant'});
  let claims; try {claims = JSON.parse(Buffer.from(value.access.split('.')[1], 'base64url').toString('utf8'));} catch {throw Object.assign(Error('account-invalid-grant'), {code: 'account-invalid-grant'});}
  const auth = claims['https://api.openai.com/auth'];
  if (!auth?.chatgpt_account_id || !auth.chatgpt_user_id || auth.chatgpt_account_id !== value.accountId) throw Object.assign(Error('account-invalid-grant'), {code: 'account-invalid-grant'});
  const principalHash = createHash('sha256').update(JSON.stringify([auth.chatgpt_account_id, auth.chatgpt_user_id])).digest('hex');
  return {kind: 'grant', payload: {...structuredClone(value), cpaBinding: {version: 1, id, principalHash}}};
}
function fixture(t, options = {}) {
  const ctx = new Context(), records = new Map(options.records ?? [[NATIVE, {kind: 'grant', payload: grant('native')}]]);
  const locks = new Map(), writes = [], deletions = [], runs = [], diagnostics = [], hooks = {}, notices = [], prompts = [];
  const locked = (key, action) => {const previous = locks.get(key) ?? Promise.resolve(); const task = previous.catch(() => {}).then(action); locks.set(key, task.catch(() => {})); return task;};
  const credentials = {
    async listRecords() {return [...records].map(([key, value]) => ({key, kind: value.kind}));},
    async readRecord(key) {return records.get(key);},
    async describeRecord(key) {return {configured: records.has(key), writable: true, ...(records.has(key) ? {kind: records.get(key).kind} : {})};},
    modifyRecord(key, mutate) {const committed = locked(key, async () => {await hooks.beforeMutation?.(key); const next = await mutate(records.get(key));
      if (next !== undefined) {records.set(key, structuredClone(next)); writes.push(key); ctx.emit('credentials/record-updated', key);} return records.get(key);});
      return committed.then(async value => {await hooks.ack?.(key, value); return value;});},
    deleteRecord(key) {return locked(key, async () => {await hooks.delete?.(key); deletions.push(key); if (records.delete(key)) ctx.emit('credentials/record-updated', key);});},
    resolve() {throw new Error('ambient credentials are forbidden');},
  };
  const offCredentials = ctx.provide('credentials', credentials), authorization = new AuthorizationService(ctx);
  const begin = authorization.begin.bind(authorization);
  authorization.begin = request => begin({...request, interaction: {
    notify(notice) {notices.push(notice); request.interaction.notify(notice);},
    prompt(prompt) {prompts.push(prompt); return request.interaction.prompt(prompt);},
  }});
  let uuid = 0;
  const oauthOptions = {randomUUID: options.randomUUID ?? (() => [A, B][uuid++]),
    loginOptions: options.loginOptions,
    onError: options.onError ?? (code => diagnostics.push(code)),
    loadOAuth: options.loadOAuth ?? (async () => ({login(callbacks) {
      const run = {callbacks, done: deferred(), number: runs.length + 1}; runs.push(run);
      if (options.notify !== false) callbacks.notify({type: 'auth_url', url: options.url ?? authURL('state-' + run.number)});
      return options.login ? options.login(run) : run.done.promise;
    }}))};
  const object = options.manager ? createAccounts(ctx, oauthOptions) : createAccountLogin(ctx, {...oauthOptions, makeRecord: options.makeRecord ?? makeRecord});
  const api = options.manager ? {begin: () => object.beginLogin(), status: () => object.loginStatus(), answer: value => object.answerLogin(value), cancel: () => object.cancelLogin(), dispose: () => object.dispose()}
    : object;
  t.after(async () => {await api.dispose(); offCredentials();});
  return {ctx, credentials, authorization, records, writes, deletions, runs, diagnostics, hooks, notices, prompts, api, manager: options.manager ? object : null};
}

test('real public AuthorizationService commits an independent account flow and never invokes the host flow', async t => {
  const f = fixture(t, {manager: true}); let hostRuns = 0;
  const offHost = f.authorization.registerFlow({key: NATIVE, label: 'host', methods: [{id: 'oauth', label: 'host'}], async run() {hostRuns++; throw new Error('host must not run');}});
  t.after(offHost);
  const native = structuredClone(f.records.get(NATIVE));
  assert.deepEqual(await f.api.begin(), {url: authURL()});
  assert.deepEqual(f.authorization.list().map(row => row.key).sort(), [NATIVE, keyFor(A)].sort());
  f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().state, 'authorized'); assert.equal(hostRuns, 0);
  assert.deepEqual(f.records.get(NATIVE), native); assert.deepEqual(f.writes, [keyFor(A), keyFor(A)]);
  assert.equal(Object.hasOwn(f.records.get(keyFor(A)).payload.cpaBinding, 'pending'), false);
  assert.equal(f.records.get(keyFor(A)).payload.cpaBinding.id, A);
  assert.ok((await f.manager.list()).some(row => row.id === A && row.canRunProbe));
  assert.deepEqual(f.authorization.list().map(row => row.key), [NATIVE]);
  const safe = JSON.stringify(f.api.status()); for (const secret of ['refresh', '.signature', 'principalHash', keyFor(A)]) assert.ok(!safe.includes(secret));
});

test('sequential logins allocate separate UUID keys without copying a rotating refresh token', async t => {
  const f = fixture(t, {manager: true});
  await f.api.begin(); f.runs[0].done.resolve(grant('alice')); await tick();
  await f.api.begin(); f.runs[1].done.resolve(grant('bob')); await tick();
  assert.deepEqual(f.writes, [keyFor(A), keyFor(A), keyFor(B), keyFor(B)]);
  assert.equal(f.records.get(keyFor(A)).payload.refresh, 'synthetic-refresh-alice');
  assert.equal(f.records.get(keyFor(B)).payload.refresh, 'synthetic-refresh-bob');
  assert.equal((await f.manager.list()).filter(row => row.owned).length, 2);
  await f.api.cancel(); assert.equal(f.records.has(keyFor(A)), true); assert.equal(f.records.has(keyFor(B)), true);
});

test('invalid UUIDs and existing-key collisions cannot overwrite or delete any preexisting grant', async t => {
  for (const id of ['../native', 'llm-pi-ai/openai-codex', '', 'not-a-uuid']) {
    const f = fixture(t, {randomUUID: () => id});
    await assert.rejects(f.api.begin(), {code: 'account-invalid-grant'}); assert.equal(f.writes.length, 0); assert.equal(f.authorization.list().length, 0);
  }
  const existing = makeRecord(grant('existing'), A), f = fixture(t, {records: [[NATIVE, {kind: 'grant', payload: grant('native')}], [keyFor(A), existing]]});
  await assert.rejects(f.api.begin(), {code: 'account-key-conflict'});
  assert.deepEqual(f.records.get(keyFor(A)), existing); assert.equal(f.runs.length, 0); assert.equal(f.deletions.length, 0);
  assert.equal(f.authorization.list().length, 0);
});

test('a retired UUID is never reused by another attempt in the same manager', async t => {
  const f = fixture(t, {randomUUID: () => A}); await f.api.begin(); await f.api.cancel();
  await assert.rejects(f.api.begin(), {code: 'account-key-conflict'}); assert.equal(f.runs.length, 1);
});

test('cancel before an OAuth URL promptly rejects begin and unregisters an uncooperative flow', {timeout: 3000}, async t => {
  const f = fixture(t, {notify: false}), started = deferred();
  const original = f.authorization.begin; f.authorization.begin = request => {started.resolve(); return original(request);};
  const rejected = assert.rejects(f.api.begin(), {code: 'account-login-failed'});
  await started.promise; await tick(); assert.equal(f.runs.length, 1);
  await f.api.cancel(); await rejected;
  assert.equal(f.api.status().state, 'idle'); assert.equal(f.authorization.list().length, 0);
  f.runs[0].callbacks.notify({type: 'auth_url', url: authURL()}); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.records.has(keyFor(A)), false); assert.equal(f.api.status().state, 'idle');
});

test('cancel rejects a pending callback prompt, cleans listeners and allows a fresh isolated attempt', async t => {
  const f = fixture(t); await f.api.begin();
  const external = new AbortController(), old = f.runs[0];
  const prompt = old.callbacks.prompt({type: 'manual_code', message: 'synthetic callback', signal: external.signal});
  const rejected = assert.rejects(prompt, {name: 'AbortError'});
  await f.api.cancel(); await rejected;
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  assert.equal(old.callbacks.signal.aborted, true); assert.equal(f.api.status().state, 'idle');
  await f.api.begin(); assert.equal(f.api.status().state, 'waiting');
  old.done.resolve(grant('old')); await tick(); assert.equal(f.records.has(keyFor(A)), false);
});

test('old completion, notification and rejection cannot revive or overwrite a newer flow', async t => {
  for (const late of ['resolve', 'reject']) {
    const f = fixture(t); await f.api.begin(); const old = f.runs[0]; await f.api.cancel();
    await f.api.begin();
    old.callbacks.notify({type: 'auth_url', url: 'https://example.invalid/private'});
    if (late === 'resolve') old.done.resolve(grant('old')); else old.done.reject(new Error('synthetic-private-token'));
    await tick(); assert.equal(f.api.status().state, 'waiting'); assert.equal(f.api.status().url, authURL('state-2'));
    f.runs[1].done.resolve(grant('new')); await tick();
    assert.equal(f.api.status().state, 'authorized'); assert.equal(f.records.has(keyFor(A)), false);
    assert.equal(f.records.get(keyFor(B)).payload.accountId, 'upstream-new');
  }
});

test('the OAuth callback is bound to the exact state and redirect without consuming invalid answers', async t => {
  const f = fixture(t); await f.api.begin();
  const prompt = f.runs[0].callbacks.prompt({type: 'manual_code', message: 'synthetic callback'});
  for (const invalid of [callbackURL('wrong'), callbackURL('state-1', 'https://localhost:1455/auth/callback'),
    callbackURL('state-1', 'http://127.0.0.1:1455/auth/callback'), callbackURL('state-1', 'http://localhost:1555/auth/callback'),
    callbackURL('state-1', 'http://localhost:1455/other'), callbackURL() + '&state=again', callbackURL() + '&code=again',
    callbackURL() + '&error=denied', 'https://example.invalid/?state=state-1&code=x']) {
    assert.throws(() => f.api.answer(invalid), /invalid-callback/); assert.equal(f.api.status().state, 'waiting');
  }
  f.api.answer(callbackURL()); assert.equal(await prompt, callbackURL());
  f.runs[0].done.resolve(grant()); await tick(); assert.equal(f.api.status().state, 'authorized');
});

test('unsupported provider prompts and unsafe authorization URLs fail safely with no credential write', async t => {
  for (const type of ['text', 'secret', 'device_code']) {
    const f = fixture(t, {login: run => run.callbacks.prompt({type, message: 'synthetic-private-detail'})});
    await f.api.begin(); await tick(); assert.equal(f.api.status().state, 'error');
    assert.equal(f.api.status().error, 'account-login-unavailable'); assert.equal(f.writes.length, 0); assert.equal(f.authorization.list().length, 0);
  }
  for (const url of ['http://auth.openai.com/oauth', 'https://example.invalid/oauth', 'https://user@auth.openai.com/oauth']) {
    const f = fixture(t, {url});
    await assert.rejects(f.api.begin(), {code: 'invalid-auth-url'}); assert.equal(f.writes.length, 0); assert.equal(f.authorization.list().length, 0);
  }
});

test('public OAuth select and manual-code prompts map to the official authorization vocabulary', async t => {
  const f = fixture(t); await f.api.begin();
  assert.equal(await f.runs[0].callbacks.prompt({type: 'select', message: 'mode', options: [{id: 'browser', label: 'browser'}]}), 'browser');
  const pending = f.runs[0].callbacks.prompt({type: 'manual_code', message: 'callback'});
  assert.equal(f.prompts.at(-1).kind, 'text');
  assert.equal(typeof f.notices[0].message, 'string');
  f.api.answer(callbackURL()); assert.equal(await pending, callbackURL());
});

test('prompt-only cancellation does not retire the account flow and a replacement prompt still works', async t => {
  const f = fixture(t); await f.api.begin();
  const external = new AbortController();
  const rejected = assert.rejects(f.runs[0].callbacks.prompt({type: 'manual_code', message: 'callback', signal: external.signal}), {name: 'AbortError'});
  external.abort(); await rejected; assert.equal(f.api.status().state, 'waiting');
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  const replacement = f.runs[0].callbacks.prompt({type: 'manual_code', message: 'callback'});
  f.api.answer(callbackURL()); await replacement;
});

test('provider and loader exceptions are sanitized and cannot become authorization success', async t => {
  const first = fixture(t, {loadOAuth: async () => {throw new Error('synthetic-secret-and-filesystem-path');}});
  await assert.rejects(first.api.begin(), {code: 'account-login-failed'});
  assert.ok(!JSON.stringify(first.api.status()).includes('synthetic-secret'));
  const second = fixture(t); await second.api.begin(); second.runs[0].done.reject(new Error('synthetic-secret-and-filesystem-path')); await tick();
  assert.equal(second.api.status().state, 'error'); assert.equal(second.api.status().error, 'account-login-failed'); assert.equal(second.writes.length, 0);
});

test('invalid grants and under-lock key conflicts do not write or delete another writer credential', async t => {
  const invalid = fixture(t); await invalid.api.begin(); invalid.runs[0].done.resolve({type: 'oauth', access: 'broken'}); await tick();
  assert.equal(invalid.api.status().error, 'account-invalid-grant'); assert.equal(invalid.writes.length, 0);
  const collision = fixture(t), other = makeRecord(grant('other'), A);
  collision.hooks.beforeMutation = async key => {if (key === keyFor(A)) collision.records.set(key, other);};
  await collision.api.begin(); collision.runs[0].done.resolve(grant()); await tick();
  assert.equal(collision.api.status().error, 'account-key-conflict'); assert.deepEqual(collision.records.get(keyFor(A)), other);
  assert.equal(collision.deletions.length, 0);
});

test('cancel during an admitted write waits for that write then cleans only its exact key, not the new attempt', async t => {
  const f = fixture(t, {manager: true}), admitted = deferred(), gate = deferred();
  f.hooks.ack = async key => {if (key === keyFor(A)) {admitted.resolve(); await gate.promise;}};
  await f.api.begin(); f.runs[0].done.resolve(grant('old')); await admitted.promise;
  assert.equal(f.records.has(keyFor(A)), true); assert.ok(!(await f.manager.list()).some(row => row.id === A));
  const cancelling = f.api.cancel(); assert.equal(f.api.status().state, 'idle');
  await f.api.begin(); f.runs[1].done.resolve(grant('new')); await tick(); assert.equal(f.api.status().state, 'authorized');
  gate.resolve(); await cancelling; await tick();
  assert.equal(f.records.has(keyFor(A)), false); assert.equal(f.records.get(keyFor(B)).payload.accountId, 'upstream-new');
  assert.ok((await f.manager.list()).some(row => row.id === B)); assert.deepEqual(f.deletions, [keyFor(A)]);
});

test('failed acknowledgement of a committed write is cleaned without exposing raw storage errors', async t => {
  const f = fixture(t);
  f.hooks.ack = async () => {throw new Error('synthetic-private-disk-path');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().state, 'error'); assert.equal(f.api.status().error, 'account-login-failed');
  assert.equal(f.records.has(keyFor(A)), false); assert.equal(f.records.has(NATIVE), true);
  assert.ok(!JSON.stringify(f.api.status()).includes('synthetic-private'));
});

test('a changed post-lock record is never blindly deleted by stale OAuth cleanup', async t => {
  const f = fixture(t), other = makeRecord(grant('other'), A);
  f.hooks.ack = async key => {if (key === keyFor(A)) f.records.set(key, other);};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().state, 'error'); assert.equal(f.api.status().error, 'account-login-cleanup-failed');
  assert.deepEqual(f.records.get(keyFor(A)), other); assert.equal(f.deletions.length, 0); assert.ok(f.diagnostics.includes('account-login-cleanup-failed'));
});

test('cleanup failure remains visible and a cancelled grant is never exposed as runnable in this registry', async t => {
  const f = fixture(t, {manager: true}), admitted = deferred(), gate = deferred();
  f.hooks.ack = async key => {if (key === keyFor(A)) {admitted.resolve(); await gate.promise;}};
  f.hooks.delete = async () => {throw new Error('synthetic-private-delete-path');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await admitted.promise;
  const cancelling = f.api.cancel(); gate.resolve(); await cancelling; await tick();
  assert.equal(f.api.status().error, 'account-login-cleanup-failed');
  assert.ok(!(await f.manager.list()).some(row => row.id === A));
  assert.ok(!JSON.stringify(f.api.status()).includes('synthetic-private'));
});

test('dispose promptly retires uncooperative OAuth work and late grants cannot write any account', {timeout: 3000}, async t => {
  const f = fixture(t); await f.api.begin(); const old = f.runs[0];
  await f.api.dispose(); assert.equal(old.callbacks.signal.aborted, true); assert.equal(f.authorization.list().length, 0);
  old.done.resolve(grant()); await tick(); assert.equal(f.records.has(keyFor(A)), false);
  await assert.rejects(f.api.begin(), {code: 'accounts-disposed'});
});

test('startup and completion deadlines retire the independent flow and prevent late credential commits', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const startup = fixture(t, {notify: false, loginOptions: {startTimeoutMs: 7, completionTimeoutMs: 13}});
  const begun = startup.api.begin(), rejected = assert.rejects(begun, {code: 'authorization-start-timeout'});
  await tick(); t.mock.timers.tick(7); await rejected; await tick();
  assert.equal(startup.authorization.list().length, 0); startup.runs[0].done.resolve(grant()); await tick(); assert.equal(startup.writes.length, 0);
  const completion = fixture(t, {loginOptions: {startTimeoutMs: 7, completionTimeoutMs: 13}});
  await completion.api.begin(); t.mock.timers.tick(13); await tick();
  assert.equal(completion.api.status().state, 'error'); assert.equal(completion.api.status().error, 'authorization-completion-timeout');
  assert.equal(completion.authorization.list().length, 0); completion.runs[0].done.resolve(grant()); await tick(); assert.equal(completion.writes.length, 0);
});

test('a cancelled grant whose deletion failed remains unavailable after a fresh registry restart', async t => {
  const f = fixture(t, {manager: true}), admitted = deferred(), gate = deferred();
  f.hooks.ack = async key => {if (key === keyFor(A)) {admitted.resolve(); await gate.promise;}};
  f.hooks.delete = async () => {throw new Error('synthetic deletion unavailable');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await admitted.promise;
  const cancelling = f.api.cancel(); gate.resolve(); await cancelling; await tick();
  await f.manager.dispose();
  const restarted = createAccounts(f.ctx); t.after(() => restarted.dispose());
  const row = (await restarted.list()).find(row => row.id === A);
  assert.equal(row?.canRunProbe, false);
  await assert.rejects(restarted.capture(A, 'cpa-codex-' + A), {code: 'account-unavailable'});
});

test('cancel before final activation admission leaves no ready record, even when the lock is delayed', async t => {
  const f = fixture(t, {manager: true}), entering = deferred(), gate = deferred(); let blocked = false;
  f.hooks.beforeMutation = async key => {if (key === keyFor(A) && f.writes.length === 1 && !blocked) {blocked = true; entering.resolve(); await gate.promise;}};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await entering.promise;
  assert.equal(f.records.get(keyFor(A)).payload.cpaBinding.pending, true);
  const cancelling = f.api.cancel(); gate.resolve(); await cancelling; await tick();
  assert.equal(f.records.has(keyFor(A)), false); assert.equal(f.api.status().state, 'idle');
});

test('once exact-key final activation is admitted, cancellation cannot redirect or discard its accepted grant', async t => {
  const f = fixture(t, {manager: true}), admitted = deferred(), gate = deferred();
  f.hooks.ack = async (key, value) => {if (key === keyFor(A) && !Object.hasOwn(value.payload.cpaBinding, 'pending')) {admitted.resolve(); await gate.promise;}};
  await f.api.begin(); f.runs[0].done.resolve(grant('accepted')); await admitted.promise;
  const cancelling = f.api.cancel();
  await f.api.begin(); f.runs[1].done.resolve(grant('newer')); await tick();
  assert.equal(f.api.status().state, 'authorized');
  gate.resolve(); await cancelling; await tick();
  assert.equal(f.records.get(keyFor(A)).payload.accountId, 'upstream-accepted');
  assert.equal(f.records.get(keyFor(B)).payload.accountId, 'upstream-newer');
  assert.equal(f.deletions.length, 0);
  assert.equal((await f.manager.list()).filter(row => row.owned && row.canRunProbe).length, 2);
});

test('a failed final activation cannot make its pending grant usable after restart', async t => {
  const f = fixture(t, {manager: true});
  f.hooks.beforeMutation = async key => {if (key === keyFor(A) && f.writes.length === 1) throw new Error('synthetic-private-activation-path');};
  f.hooks.delete = async () => {throw new Error('synthetic-private-delete-path');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().error, 'account-login-cleanup-failed');
  assert.equal(f.records.get(keyFor(A)).payload.cpaBinding.pending, true);
  await f.manager.dispose();
  const restarted = createAccounts(f.ctx); t.after(() => restarted.dispose());
  assert.equal((await restarted.list()).find(row => row.id === A).canRunProbe, false);
});

test('a fresh exact ready record witnesses final activation when its acknowledgement is lost', async t => {
  const f = fixture(t, {manager: true});
  f.hooks.ack = async (_key, value) => {if (!Object.hasOwn(value.payload.cpaBinding, 'pending')) throw new Error('synthetic lost acknowledgement');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().state, 'authorized');
  assert.equal(Object.hasOwn(f.records.get(keyFor(A)).payload.cpaBinding, 'pending'), false);
  assert.ok((await f.manager.list()).some(row => row.id === A && row.canRunProbe));
});

test('stale metadata cannot authorize deletion of another principal access token during cleanup', async t => {
  const f = fixture(t);
  f.hooks.ack = async (key, value) => {if (key === keyFor(A)) f.records.set(key,
    {kind: 'grant', payload: {...grant('different'), cpaBinding: value.payload.cpaBinding}});};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().error, 'account-login-cleanup-failed');
  assert.equal(f.records.get(keyFor(A)).payload.accountId, 'upstream-different'); assert.equal(f.deletions.length, 0);
});

test('provider completion without a valid OAuth URL cannot silently save a credential', async t => {
  const f = fixture(t, {notify: false, login: () => grant()});
  await assert.rejects(f.api.begin(), {code: 'account-login-unavailable'});
  assert.equal(f.writes.length, 0); assert.equal(f.authorization.list().length, 0);
});

test('invalid lifecycle options and throwing UUID sources do not leak state or private errors', async t => {
  const badClock = fixture(t, {loginOptions: {startTimeoutMs: 0}});
  await assert.rejects(badClock.api.begin(), {code: 'account-login-failed'});
  assert.equal(badClock.api.status().state, 'idle'); assert.equal(badClock.authorization.list().length, 0);
  await badClock.api.cancel(); assert.throws(() => badClock.api.answer(callbackURL()), {code: 'no-prompt'});
  const badUUID = fixture(t, {randomUUID: () => {throw new Error('synthetic-private-random-path');}});
  await assert.rejects(badUUID.api.begin(), {message: 'account-invalid-grant', code: 'account-invalid-grant'});
  assert.equal(badUUID.writes.length, 0);
});

test('an authorization service success claim without the owned exact-key commit cannot authorize this account', async t => {
  const f = fixture(t);
  f.authorization.begin = async request => {request.interaction.notify({message: 'synthetic', url: authURL()}); return {status: 'authorized'};};
  await f.api.begin(); await tick();
  assert.equal(f.api.status().state, 'error'); assert.equal(f.api.status().error, 'account-login-failed'); assert.equal(f.writes.length, 0);
});

test('an abort listener may start a new independent flow synchronously without stale cancellation touching it', async t => {
  const f = fixture(t); await f.api.begin(); const old = f.runs[0]; let restarted;
  old.callbacks.signal.addEventListener('abort', () => {restarted = f.api.begin();}, {once: true});
  await f.api.cancel(); assert.deepEqual(await restarted, {url: authURL('state-2')});
  old.done.resolve(grant('old')); await tick(); assert.equal(f.api.status().state, 'waiting');
  f.runs[1].done.resolve(grant('new')); await tick();
  assert.equal(f.api.status().state, 'authorized'); assert.equal(f.records.has(keyFor(A)), false);
  assert.equal(f.records.get(keyFor(B)).payload.accountId, 'upstream-new');
});

test('rejected diagnostic callbacks cannot become unhandled rejections during OAuth cleanup failures', async t => {
  const codes = [], f = fixture(t, {onError: code => {codes.push(code); return Promise.reject(new Error('synthetic reporter failure'));}});
  f.hooks.ack = async () => {throw new Error('synthetic acknowledgement failure');};
  f.hooks.delete = async () => {throw new Error('synthetic deletion failure');};
  await f.api.begin(); f.runs[0].done.resolve(grant()); await tick();
  assert.equal(f.api.status().error, 'account-login-cleanup-failed'); assert.ok(codes.includes('account-login-cleanup-failed'));
});

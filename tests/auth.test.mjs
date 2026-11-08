import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createDirectLogin} from '../lib/auth-v022.mjs';
test('direct OAuth starts only the registered Codex flow and returns URL, then observes completion',async()=>{
 let requested;const authorization={begin:async r=>{requested=r;assert.equal(await r.interaction.prompt({kind:'select',options:[{id:'browser'}]}),'browser');r.interaction.notify({url:'https://auth.openai.com/oauth/authorize?state=synthetic'});return {status:'authorized'}}};
 const login=createDirectLogin(authorization);const url=await login.begin();assert.match(url,/auth\.openai\.com/);await new Promise(r=>setTimeout(r,0));assert.equal(login.status().state,'authorized');assert.equal(requested.key,'llm-pi-ai/openai-codex');
});
test('non-OpenAI login destinations are rejected',async()=>{
 const login=createDirectLogin({begin:async r=>{await r.interaction.prompt({kind:'select',options:[{id:'browser'}]});r.interaction.notify({url:'https://example.invalid'});return {status:'cancelled'}}});
 await assert.rejects(login.begin(),/invalid-auth-url/);
});

const SYNTHETIC_STATE = 'synthetic-state';
const CODEX_REDIRECT = 'http://localhost:1455/auth/callback';
const flush = () => new Promise(resolve => setImmediate(resolve));
const abort = {name: 'AbortError', message: 'cancelled'};

function authURL(state = SYNTHETIC_STATE, redirect) {
  const url = new URL('https://auth.openai.com/oauth/authorize');
  if (state !== null) url.searchParams.set('state', state);
  if (redirect !== undefined) url.searchParams.set('redirect_uri', redirect);
  return url.href;
}

function callbackURL(base = CODEX_REDIRECT, state = SYNTHETIC_STATE, code = 'synthetic-code') {
  const url = new URL(base);
  if (state !== null) url.searchParams.set('state', state);
  if (code !== null) url.searchParams.set('code', code);
  return url.href;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

// The fake provider deliberately ignores abort, so adapter settlement cannot rely on it.
function fixture(t, {url = authURL(), options} = {}) {
  const runs = [];
  const login = createDirectLogin({begin(request) {
    const done = deferred();
    runs.push({...request, done});
    if (url !== null) request.interaction.notify({url});
    return done.promise;
  }}, options);
  t.after(() => login.cancel());
  return {login, runs};
}

function assertListeners(signal, count) {
  assert.equal(getEventListeners(signal, 'abort').length, count);
}

test('cancel before a URL immediately rejects begin even when the provider ignores abort', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {login, runs} = fixture(t, {url: null});
  const pending = login.begin();
  const rejected = assert.rejects(pending, abort);
  assert.equal(login.status().state, 'waiting');
  login.cancel();
  await rejected;
  assert.deepEqual(login.status(), {state: 'idle'});
  assert.equal(runs[0].signal.aborted, true);
  runs[0].interaction.notify({url: authURL()});
  runs[0].done.resolve({status: 'authorized'});
  await flush();
  t.mock.timers.tick(600000);
  assert.deepEqual(login.status(), {state: 'idle'});
  login.cancel();
});

test('cancel before a URL also rejects an early callback prompt and removes both listeners', async t => {
  const {login, runs} = fixture(t, {url: null});
  const begin = assert.rejects(login.begin(), abort);
  const external = new AbortController();
  const prompt = runs[0].interaction.prompt({kind: 'input', signal: external.signal});
  const rejected = assert.rejects(prompt, abort);
  assertListeners(runs[0].signal, 1);
  assertListeners(external.signal, 1);
  login.cancel();
  await Promise.all([begin, rejected]);
  assertListeners(runs[0].signal, 0);
  assertListeners(external.signal, 0);
  assert.throws(() => login.answer(callbackURL()), /no-prompt/);
});

test('cancel while waiting for callback rejects its promise and permits a fresh attempt', async t => {
  const {login, runs} = fixture(t);
  await login.begin();
  const external = new AbortController();
  const prompt = runs[0].interaction.prompt({kind: 'input', signal: external.signal});
  const rejected = assert.rejects(prompt, abort);
  login.cancel();
  await rejected;
  assertListeners(runs[0].signal, 0);
  assertListeners(external.signal, 0);
  assert.equal(runs[0].signal.aborted, true);
  await login.begin();
  assert.equal(login.status().state, 'waiting');
  assert.equal(runs[1].signal.aborted, false);
});

test('old notify, prompt, resolution and rejection cannot mutate a newer attempt', async t => {
  for (const outcome of ['authorized', 'cancelled', 'rejected']) {
    await t.test(outcome, async t => {
      const {login, runs} = fixture(t, {url: null});
      const first = assert.rejects(login.begin(), abort);
      const old = runs[0];
      login.cancel();
      await first;
      const second = login.begin();
      const current = runs[1];
      const nextURL = authURL('next-synthetic-state', CODEX_REDIRECT);
      current.interaction.notify({url: nextURL});
      assert.equal(await second, nextURL);
      const prompt = current.interaction.prompt({kind: 'input'});
      old.interaction.notify({url: authURL('old-state')});
      old.interaction.notify({url: 'https://example.invalid'});
      await assert.rejects(old.interaction.prompt({kind: 'input'}), abort);
      await assert.rejects(old.interaction.prompt({kind: 'select', options: [{id: 'browser'}]}), abort);
      if (outcome === 'rejected') old.done.reject(Object.assign(Error('synthetic'), {code: 'old-failure'}));
      else old.done.resolve({status: outcome});
      await flush();
      assert.deepEqual(login.status(), {state: 'waiting', url: nextURL, error: null});
      assert.equal(current.signal.aborted, false);
      const callback = callbackURL(CODEX_REDIRECT, 'next-synthetic-state');
      login.answer(callback);
      assert.equal(await prompt, callback);
      current.done.resolve({status: 'authorized'});
      await flush();
      assert.equal(login.status().state, 'authorized');
    });
  }
});

test('a synchronous authorization.begin throw retires the attempt and permits retry', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const requests = [];
  const login = createDirectLogin({begin(request) {
    requests.push(request);
    if (requests.length === 1) throw Object.assign(Error('do not expose provider detail'), {code: 'synthetic-failure'});
    request.interaction.notify({url: authURL()});
    return {status: 'authorized'};
  }});
  t.after(() => login.cancel());
  await assert.rejects(login.begin(), /synthetic-failure/);
  assert.deepEqual(login.status(), {state: 'error', url: null, error: 'synthetic-failure'});
  assert.equal(requests[0].signal.aborted, true);
  await login.begin();
  await flush();
  assert.equal(login.status().state, 'authorized');
  t.mock.timers.tick(600000);
  assert.equal(login.status().state, 'authorized');
});

test('provider failures are sanitized and late success cannot revive an error', async t => {
  for (const failure of [null, Error('synthetic private detail'), {code: 'NOT A SAFE CODE'}]) {
    const {login, runs} = fixture(t, {url: null});
    const pending = assert.rejects(login.begin(), /authorization-failed/);
    runs[0].done.reject(failure);
    await pending;
    assert.deepEqual(login.status(), {state: 'error', url: null, error: 'authorization-failed'});
    runs[0].interaction.notify({url: authURL()});
    assert.equal(login.status().url, null);
    login.cancel();
  }
});

test('the startup deadline remains 15 seconds and settles begin and prompt independently of provider', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {login, runs} = fixture(t, {url: null});
  const pending = assert.rejects(login.begin(), /authorization-start-timeout/);
  const external = new AbortController();
  const prompt = assert.rejects(runs[0].interaction.prompt({kind: 'input', signal: external.signal}), /authorization-start-timeout/);
  t.mock.timers.tick(14999);
  assert.equal(login.status().state, 'waiting');
  assert.equal(runs[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await Promise.all([pending, prompt]);
  assert.deepEqual(login.status(), {state: 'error', url: null, error: 'authorization-start-timeout'});
  assert.equal(runs[0].signal.aborted, true);
  assertListeners(runs[0].signal, 0);
  assertListeners(external.signal, 0);
  runs[0].interaction.notify({url: authURL()});
  runs[0].done.resolve({status: 'authorized'});
  await flush();
  assert.equal(login.status().error, 'authorization-start-timeout');
});

test('the ten-minute completion deadline retires waiting prompts and is not extended by notify', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {login, runs} = fixture(t);
  const original = await login.begin();
  const external = new AbortController();
  const prompt = assert.rejects(runs[0].interaction.prompt({kind: 'input', signal: external.signal}), /authorization-completion-timeout/);
  t.mock.timers.tick(15000);
  assert.equal(login.status().state, 'waiting');
  t.mock.timers.tick(600000 - 15000 - 1);
  runs[0].interaction.notify({url: authURL('replacement-state')});
  assert.deepEqual(login.status(), {state: 'waiting', url: original, error: null});
  t.mock.timers.tick(1);
  await prompt;
  assert.deepEqual(login.status(), {state: 'error', url: original, error: 'authorization-completion-timeout'});
  assert.equal(runs[0].signal.aborted, true);
  assertListeners(runs[0].signal, 0);
  assertListeners(external.signal, 0);
  assert.throws(() => login.answer(callbackURL()), /no-prompt/);
  runs[0].done.resolve({status: 'authorized'});
  await flush();
  assert.equal(login.status().error, 'authorization-completion-timeout');
});

test('short injectable deadlines start completion timing at the first valid URL', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {login, runs} = fixture(t, {url: null, options: {startTimeoutMs: 7, completionTimeoutMs: 13}});
  const pending = login.begin();
  t.mock.timers.tick(6);
  runs[0].interaction.notify({url: authURL()});
  await pending;
  t.mock.timers.tick(1);
  assert.equal(login.status().state, 'waiting');
  t.mock.timers.tick(11);
  assert.equal(login.status().state, 'waiting');
  t.mock.timers.tick(1);
  assert.equal(login.status().error, 'authorization-completion-timeout');
});

test('timeout options cannot silently disable or overflow the bounded deadlines', () => {
  for (const key of ['startTimeoutMs', 'completionTimeoutMs']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '5', null, 0x80000000]) {
      assert.throws(() => createDirectLogin({}, {[key]: value}), /invalid-timeout/);
    }
  }
});

test('active attempts reject duplicate begin calls without replacing their prompt', async t => {
  const {login, runs} = fixture(t);
  await login.begin();
  const prompt = runs[0].interaction.prompt({kind: 'input'});
  await assert.rejects(login.begin(), /already-running/);
  await assert.rejects(runs[0].interaction.prompt({kind: 'input'}), /already-prompting/);
  assert.equal(runs.length, 1);
  login.answer(callbackURL());
  assert.equal(await prompt, callbackURL());
  assert.throws(() => login.answer(callbackURL()), /no-prompt/);
});

test('answering or independently aborting a prompt removes both listeners', async t => {
  const {login, runs} = fixture(t);
  await login.begin();
  const run = runs[0];
  const firstSignal = new AbortController();
  const first = run.interaction.prompt({kind: 'input', signal: firstSignal.signal});
  const rejected = assert.rejects(first, abort);
  firstSignal.abort();
  await rejected;
  assertListeners(firstSignal.signal, 0);
  assertListeners(run.signal, 0);
  assert.throws(() => login.answer(callbackURL()), /no-prompt/);
  await assert.rejects(run.interaction.prompt({kind: 'input', signal: firstSignal.signal}), abort);
  await assert.rejects(run.interaction.prompt({kind: 'select', options: [{id: 'browser'}], signal: firstSignal.signal}), abort);
  assertListeners(run.signal, 0);
  const nextSignal = new AbortController();
  const next = run.interaction.prompt({kind: 'input', signal: nextSignal.signal});
  assertListeners(run.signal, 1);
  assertListeners(nextSignal.signal, 1);
  login.answer(callbackURL());
  assert.equal(await next, callbackURL());
  assertListeners(run.signal, 0);
  assertListeners(nextSignal.signal, 0);
  nextSignal.abort();
  assert.equal(login.status().state, 'waiting');
});

test('provider completion clears an unanswered prompt and ignores later interactions', async t => {
  for (const state of ['authorized', 'cancelled']) {
    await t.test(state, async t => {
      t.mock.timers.enable({apis: ['setTimeout']});
      const {login, runs} = fixture(t);
      const url = await login.begin();
      const external = new AbortController();
      const prompt = runs[0].interaction.prompt({kind: 'input', signal: external.signal});
      const rejected = assert.rejects(prompt, state === 'authorized' ? /login-ended/ : abort);
      runs[0].done.resolve({status: state});
      await rejected;
      assert.deepEqual(login.status(), {state, url, error: null});
      assertListeners(runs[0].signal, 0);
      assertListeners(external.signal, 0);
      runs[0].interaction.notify({url: 'https://example.invalid'});
      await assert.rejects(runs[0].interaction.prompt({kind: 'input'}), abort);
      t.mock.timers.tick(600000);
      assert.deepEqual(login.status(), {state, url, error: null});
    });
  }
});

test('authorization destinations reject userinfo, non-HTTPS schemes and non-OpenAI origins', async t => {
  const invalid = [
    'https://example.invalid/oauth/authorize',
    'http://auth.openai.com/oauth/authorize',
    'ftp://auth.openai.com/oauth/authorize',
    'javascript://auth.openai.com/oauth/authorize',
    'https://synthetic-user:synthetic-password@auth.openai.com/oauth/authorize',
    'https://@auth.openai.com/oauth/authorize',
    'https://auth.openai.com:444/oauth/authorize',
    'https://auth.openai.com.example.invalid/oauth/authorize',
    'https:auth.openai.com/oauth/authorize',
    'not-a-url',
  ];
  for (const url of invalid) {
    await t.test(url, async t => {
      const {login, runs} = fixture(t, {url});
      await assert.rejects(login.begin(), /invalid-auth-url/);
      assert.equal(login.status().error, 'invalid-auth-url');
      assert.equal(runs[0].signal.aborted, true);
      runs[0].done.resolve({status: 'authorized'});
      await flush();
      assert.equal(login.status().error, 'invalid-auth-url');
    });
  }
});

test('unsafe or ambiguous redirect_uri values cannot disable callback binding', async t => {
  const invalid = [
    '', 'not-a-url', 'https://example.invalid/auth/callback',
    'javascript://localhost/auth/callback', 'file://localhost/auth/callback',
    'ftp://localhost/auth/callback', 'http://synthetic-user@localhost:1455/auth/callback',
    'http://@localhost:1455/auth/callback',
  ].map(redirect => authURL(SYNTHETIC_STATE, redirect));
  const duplicate = new URL(authURL(SYNTHETIC_STATE, CODEX_REDIRECT));
  duplicate.searchParams.append('redirect_uri', CODEX_REDIRECT);
  invalid.push(duplicate.href);
  for (const url of invalid) {
    const {login, runs} = fixture(t, {url});
    await assert.rejects(login.begin(), /invalid-auth-url/);
    assert.equal(runs[0].signal.aborted, true);
    assert.equal(login.status().state, 'error');
    login.cancel();
  }
});

test('callback validates scheme, loopback host, userinfo, unique state and nonempty code without consuming the prompt', async t => {
  const {login, runs} = fixture(t);
  await login.begin();
  const prompt = runs[0].interaction.prompt({kind: 'input'});
  const valid = callbackURL();
  const invalid = [
    callbackURL('https://example.invalid/auth/callback'),
    callbackURL('ftp://localhost:1455/auth/callback'),
    callbackURL('javascript://localhost:1455/auth/callback'),
    callbackURL('file://localhost/auth/callback'),
    callbackURL('http://synthetic-user:synthetic-password@localhost:1455/auth/callback'),
    valid.replace('http://localhost', 'http://@localhost'),
    callbackURL(CODEX_REDIRECT, 'wrong-synthetic-state'),
    callbackURL(CODEX_REDIRECT, null),
    callbackURL(CODEX_REDIRECT, ''),
    callbackURL(CODEX_REDIRECT, SYNTHETIC_STATE, null),
    callbackURL(CODEX_REDIRECT, SYNTHETIC_STATE, ''),
    callbackURL(CODEX_REDIRECT, SYNTHETIC_STATE, '  '),
    valid + '&state=' + SYNTHETIC_STATE,
    valid + '&code=second-synthetic-code',
    valid + '&error=access_denied',
    valid.replace('http://', 'http:'),
    'not-a-url',
  ];
  for (const url of invalid) {
    assert.throws(() => login.answer(url), /invalid-callback/, url);
    assert.equal(login.status().state, 'waiting');
    assertListeners(runs[0].signal, 1);
  }
  login.answer(valid);
  assert.equal(await prompt, valid);
  assertListeners(runs[0].signal, 0);
});

test('callback binds exactly to redirect_uri scheme, hostname, port and path', async t => {
  const {login, runs} = fixture(t, {url: authURL(SYNTHETIC_STATE, CODEX_REDIRECT)});
  await login.begin();
  const prompt = runs[0].interaction.prompt({kind: 'input'});
  for (const base of [
    'https://localhost:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback',
    'http://[::1]:1455/auth/callback',
    'http://localhost:1456/auth/callback',
    'http://localhost:1455/other/callback',
    'http://localhost:1455/auth/callback/',
  ]) assert.throws(() => login.answer(callbackURL(base)), /invalid-callback/);
  const valid = callbackURL() + '&scope=openid+profile&session_state=synthetic-session';
  login.answer(valid);
  assert.equal(await prompt, valid);
  runs[0].done.resolve({status: 'authorized'});
  await flush();
  assert.equal(login.status().state, 'authorized');
});

test('valid Codex and normalized HTTP(S) loopback redirects remain accepted', async t => {
  for (const redirect of [
    CODEX_REDIRECT,
    'http://127.0.0.1:1455/auth/callback',
    'http://[::1]:1455/auth/callback',
    'http://LOCALHOST:80/auth/callback',
    'https://localhost:443/auth/callback',
    'https://[::1]:8443/auth/callback',
  ]) {
    await t.test(redirect, async t => {
      const state = 'synthetic +/=_state';
      const url = authURL(state, redirect).replace('https://auth.openai.com', 'https://AUTH.OPENAI.COM:443');
      const {login, runs} = fixture(t, {url});
      assert.equal(await login.begin(), new URL(url).href);
      const prompt = runs[0].interaction.prompt({kind: 'input'});
      const valid = callbackURL(redirect, state);
      login.answer(valid);
      assert.equal(await prompt, valid);
    });
  }
});

test('without redirect_uri legacy HTTP(S) loopback callbacks are still supported', async t => {
  for (const base of [
    CODEX_REDIRECT, 'http://127.0.0.1:8765/callback', 'https://[::1]:8443/oauth/callback',
  ]) {
    const {login, runs} = fixture(t);
    await login.begin();
    const prompt = runs[0].interaction.prompt({kind: 'input'});
    const valid = callbackURL(base);
    login.answer(valid);
    assert.equal(await prompt, valid);
    login.cancel();
  }
});

test('a missing, empty or ambiguous authorization state can never validate a callback', async t => {
  const ambiguous = new URL(authURL());
  ambiguous.searchParams.append('state', 'second-synthetic-state');
  for (const url of [authURL(null), authURL(''), authURL(' '), ambiguous.href]) {
    const {login, runs} = fixture(t, {url});
    await login.begin();
    const prompt = assert.rejects(runs[0].interaction.prompt({kind: 'input'}), abort);
    assert.throws(() => login.answer(callbackURL()), /invalid-callback/);
    login.cancel();
    await prompt;
  }
});

test('submitting the callback does not remove the completion deadline while exchange is pending', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {login, runs} = fixture(t, {options: {completionTimeoutMs: 11}});
  await login.begin();
  const prompt = runs[0].interaction.prompt({kind: 'input'});
  login.answer(callbackURL());
  await prompt;
  assert.equal(login.status().state, 'waiting');
  t.mock.timers.tick(11);
  assert.equal(login.status().error, 'authorization-completion-timeout');
  assert.equal(runs[0].signal.aborted, true);
  runs[0].done.reject(Object.assign(Error('late exchange failure'), {code: 'old-failure'}));
  await flush();
  assert.equal(login.status().error, 'authorization-completion-timeout');
});

test('cancel after synchronous notify but before begin returns cannot deliver a stale URL', async t => {
  const {login, runs} = fixture(t);
  const pending = assert.rejects(login.begin(), abort);
  login.cancel();
  await pending;
  assert.deepEqual(login.status(), {state: 'idle'});
  assert.equal(runs[0].signal.aborted, true);
});

test('a synchronous provider failure after notify rejects begin instead of delivering its URL', async t => {
  const login = createDirectLogin({begin(request) {
    request.interaction.notify({url: authURL()});
    throw Error('synthetic failure after notify');
  }});
  t.after(() => login.cancel());
  await assert.rejects(login.begin(), /authorization-failed/);
  assert.equal(login.status().state, 'error');
});

test('cancel does not erase a new attempt started synchronously by an abort listener', async t => {
  const {login, runs} = fixture(t, {url: null});
  const first = assert.rejects(login.begin(), abort);
  let second;
  runs[0].signal.addEventListener('abort', () => {second = login.begin();}, {once: true});
  login.cancel();
  await first;
  assert.equal(runs.length, 2);
  runs[1].interaction.notify({url: authURL('next-synthetic-state')});
  assert.equal(await second, authURL('next-synthetic-state'));
  assert.equal(login.status().state, 'waiting');
  assert.equal(runs[1].signal.aborted, false);
});

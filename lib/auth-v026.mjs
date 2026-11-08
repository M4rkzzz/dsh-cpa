import {randomUUID} from 'node:crypto';
import {createDirectLogin} from './auth-v024.mjs';

const SCOPE = 'cpa-codex/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ACCOUNT_LOGIN_ERROR_CODES = Object.freeze([
  'account-login-unavailable', 'account-login-failed', 'account-login-cleanup-failed',
  'account-invalid-grant', 'account-key-conflict', 'already-running', 'no-prompt',
  'invalid-callback', 'invalid-auth-url', 'authorization-failed',
  'authorization-start-timeout', 'authorization-completion-timeout',
]);
const safeErrors = new Set(ACCOUNT_LOGIN_ERROR_CODES);
const fail = code => Object.assign(Error(code), {code});
const safeCode = error => safeErrors.has(error?.code) ? error.code
  : safeErrors.has(error?.message) ? error.message : 'account-login-failed';
const copy = value => structuredClone(value);

async function defaultOAuth() {
  const {openaiCodexProvider} = await import('@earendil-works/pi-ai/providers/openai-codex');
  return openaiCodexProvider().auth.oauth;
}

/** One independent public authorization flow per newly allocated key. Never authorizes the host's key. */
export function createAccountLogin(ctx, options) {
  const credentials = ctx.credentials, authorization = ctx.authorization;
  const uuid = options.randomUUID ?? randomUUID, loadOAuth = options.loadOAuth ?? defaultOAuth;
  const hidden = new Set(), reserved = new Set(), attempts = new Set();
  let current = null, disposed = false, generation = 0, terminalError = null;
  const active = () => {if (disposed) throw fail('accounts-disposed');};
  const report = code => {try {Promise.resolve(options.onError?.(code)).catch(() => {});} catch { /* diagnostics are not credential operations */ }};
  function changed() {
    try {Promise.resolve(options.onChange?.()).catch(() => report('account-login-failed'));}
    catch {report('account-login-failed');}
  }
  function status() {
    if (terminalError) return {state: 'error', error: terminalError};
    if (current?.authorized) return {state: 'authorized'};
    const value = current?.surface?.status();
    if (!value || value.state === 'cancelled') return {state: 'idle'};
    return {state: value.state, ...(value.url ? {url: value.url} : {}),
      ...(value.error ? {error: safeCode({message: value.error})} : {})};
  }
  function unregister(attempt) {
    const off = attempt.off;
    attempt.off = null;
    try {off?.();} catch {report('account-login-failed');}
  }
  function valid(attempt, signal) {
    if (disposed || current !== attempt || attempt.cancelled || attempt.controller.signal.aborted || signal?.aborted) {
      throw fail('account-login-failed');
    }
  }
  function sameBinding(record, attempt) {
    const meta = record?.kind === 'grant' && record.payload?.cpaBinding;
    return meta?.version === 1 && meta.id === attempt.id && meta.principalHash === attempt.record?.payload.cpaBinding.principalHash;
  }
  function unhide(attempt) {
    if (hidden.delete(attempt.key)) changed();
  }
  // A cancellation can beat the acknowledgement of an already admitted write. Wait for that
  // exact write before removing its new key. A UUID is never reused by another local attempt.
  function cleanup(attempt) {
    if (attempt.cleanup) return attempt.cleanup;
    attempt.cleanup = Promise.resolve().then(async () => {
      try {
        try {await attempt.activation;} catch { /* an admitted final activation must settle before cleanup */ }
        try {await attempt.write;} catch { /* a failed acknowledgement may still have committed */ }
        if (!attempt.authorized && attempt.admitted) {
          const record = await credentials.readRecord(attempt.key);
          if (record !== undefined) {
            const verified = options.makeRecord(record?.payload, attempt.id);
            if (!sameBinding(record, attempt) || !sameBinding(verified, attempt)) throw fail('account-login-cleanup-failed');
            await credentials.deleteRecord(attempt.key);
          }
          attempt.admitted = false;
        }
        unhide(attempt);
      } catch {
        // Do not make a cancelled/failed grant runnable after a failed cleanup.
        if (!disposed && generation === attempt.generation) terminalError = 'account-login-cleanup-failed';
        report('account-login-cleanup-failed'); changed();
      }
    }).finally(() => {attempts.delete(attempt);});
    return attempt.cleanup;
  }
  function retire(attempt) {
    if (attempt.authorized || attempt.sealed) return;
    attempt.cancelled = true;
    attempt.controller.abort(fail('account-login-failed'));
    unregister(attempt);
  }
  async function run(attempt, session) {
    const signal = AbortSignal.any([session.signal, attempt.controller.signal]);
    const check = () => valid(attempt, signal);
    try {
      check();
      if (session.method !== 'oauth') throw fail('account-login-unavailable');
      if (await credentials.readRecord(attempt.key) !== undefined) throw fail('account-key-conflict');
      check();
      const oauth = await loadOAuth();
      check();
      if (typeof oauth?.login !== 'function') throw fail('account-login-unavailable');
      const grant = await oauth.login({signal,
        notify(notice) {
          // Uncooperative providers may notify after cancellation. Never revive the old surface.
          if (disposed || current !== attempt || signal.aborted || attempt.cancelled) return;
          if (notice?.type === 'auth_url') session.notify({message: 'Continue with ChatGPT', url: notice.url});
        },
        async prompt(prompt) {
          check();
          if (!['select', 'manual_code'].includes(prompt?.type)) throw fail('account-login-unavailable');
          const answer = await session.prompt({kind: prompt.type === 'select' ? 'select' : 'text',
            message: prompt.message, ...(prompt.options ? {options: prompt.options} : {}),
            ...(prompt.placeholder ? {placeholder: prompt.placeholder} : {}),
            signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal});
          check();
          return answer;
        },
      });
      check();
      if (!attempt.surface?.status().url) throw fail('account-login-unavailable');
      attempt.record = copy(options.makeRecord(grant, attempt.id));
      // Until the public authorization flow acknowledges success, a durable
      // staged grant must remain unusable even if cleanup fails and DSH restarts.
      attempt.record.payload.cpaBinding.pending = true;
      attempt.write = credentials.modifyRecord(attempt.key, async stored => {
        check();
        if (stored !== undefined) throw fail('account-key-conflict');
        attempt.admitted = true;
        return copy(attempt.record);
      });
      const stored = await attempt.write;
      check();
      // Check the actual post-lock record, not merely the provider's returned grant.
      const fresh = await credentials.readRecord(attempt.key);
      check();
      const verified = options.makeRecord(fresh?.payload, attempt.id);
      if (!sameBinding(stored, attempt) || !sameBinding(fresh, attempt) || !sameBinding(verified, attempt)) throw fail('account-invalid-grant');
      attempt.committed = true;
    } catch (error) {
      await cleanup(attempt);
      throw fail(safeCode(error));
    }
  }
  async function activate(attempt, signal) {
    valid(attempt, signal);
    let writeFailure;
    attempt.write = credentials.modifyRecord(attempt.key, stored => {
      valid(attempt, signal);
      const verified = options.makeRecord(stored?.payload, attempt.id);
      if (!sameBinding(stored, attempt) || !sameBinding(verified, attempt) || stored.payload.cpaBinding.pending !== true) {
        throw fail('account-invalid-grant');
      }
      const ready = copy(stored);
      delete ready.payload.cpaBinding.pending;
      // Final activation is the commit boundary. Once admitted, cancellation
      // cannot throw away this already accepted grant; it still belongs only to
      // this UUID key and cannot complete or overwrite a newer login surface.
      attempt.sealed = true;
      return ready;
    });
    try {await attempt.write;} catch (error) {writeFailure = error;}
    const fresh = await credentials.readRecord(attempt.key);
    const verified = options.makeRecord(fresh?.payload, attempt.id);
    if (!attempt.sealed || !sameBinding(fresh, attempt) || !sameBinding(verified, attempt) ||
        Object.hasOwn(fresh.payload.cpaBinding, 'pending')) throw writeFailure ?? fail('account-invalid-grant');
    // The exact post-lock read is also a commit witness if acknowledgement was
    // lost after the credential service stored the ready record successfully.
    attempt.authorized = true;
    unhide(attempt);
    attempts.delete(attempt);
  }
  async function begin() {
    active();
    if (status().state === 'waiting') throw fail('already-running');
    if (typeof authorization?.registerFlow !== 'function' || typeof authorization?.begin !== 'function' ||
        !['readRecord', 'modifyRecord', 'deleteRecord'].every(name => typeof credentials?.[name] === 'function')) {
      throw fail('account-login-unavailable');
    }
    let id;
    try {id = uuid();} catch {throw fail('account-invalid-grant');}
    if (typeof id !== 'string' || !UUID.test(id)) throw fail('account-invalid-grant');
    const key = SCOPE + id;
    if (reserved.has(key)) throw fail('account-key-conflict');
    reserved.add(key); hidden.add(key); terminalError = null;
    const attempt = {id, key, generation: ++generation, controller: new AbortController(), off: null,
      cancelled: false, admitted: false, committed: false, authorized: false, sealed: false,
      record: null, write: null, activation: null, cleanup: null, surface: null};
    attempts.add(attempt); current = attempt;
    try {
      attempt.surface = createDirectLogin({begin(request) {
        const signal = AbortSignal.any([request.signal, attempt.controller.signal]);
        return Promise.resolve().then(() => {
          valid(attempt, signal);
          return authorization.begin({...request, key, signal});
        }).then(async result => {
          if (result?.status !== 'authorized') {
            retire(attempt);
            return cleanup(attempt).then(() => ({status: 'cancelled'}));
          }
          valid(attempt, signal);
          if (!attempt.committed) throw fail('account-login-failed');
          attempt.activation = activate(attempt, signal);
          await attempt.activation;
          return {status: 'authorized'};
        }).catch(async error => {
          if (!attempt.authorized) attempt.sealed = false;
          retire(attempt);
          await cleanup(attempt);
          throw fail(safeCode(error));
        }).finally(() => unregister(attempt));
      }}, options.loginOptions);
      attempt.off = authorization.registerFlow({key, label: 'CPA ChatGPT',
        methods: [{id: 'oauth', label: 'ChatGPT'}], run: session => run(attempt, session)});
      const url = await attempt.surface.begin();
      valid(attempt);
      return {url};
    } catch (error) {
      retire(attempt);
      await cleanup(attempt);
      throw fail(safeCode(error));
    }
  }
  function answer(url) {active(); if (!current?.surface) throw fail('no-prompt'); current.surface.answer(url);}
  function cancel() {
    const attempt = current;
    if (!attempt) return Promise.resolve();
    // Detach before aborting, because an abort handler may synchronously start a new attempt.
    current = null;
    attempt.surface?.cancel();
    retire(attempt);
    return cleanup(attempt);
  }
  function dispose() {
    if (disposed) return Promise.resolve();
    disposed = true;
    const stopped = cancel();
    for (const attempt of attempts) {retire(attempt); void cleanup(attempt);}
    // Never await an uncooperative provider; its late completion is guarded before every write.
    return Promise.all([stopped, ...[...attempts].map(attempt => cleanup(attempt))]).then(() => {});
  }
  return {begin, status, answer, cancel, dispose, isPendingKey: key => hidden.has(key)};
}

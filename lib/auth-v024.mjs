const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function abortError(message = 'cancelled') {
  return Object.assign(new Error(message), {name: 'AbortError'});
}

function timeoutOption(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) throw Error('invalid-timeout');
  return value;
}

function httpURL(value) {
  const text = typeof value === 'string' ? value.trim() : value instanceof URL ? value.href : '';
  const authority = text.match(/^https?:\/\/([^/?#\\]*)/i)?.[1];
  const url = new URL(text);
  // Check the original authority too: URL normalizes empty userinfo ("@") away.
  if (authority === undefined || authority.includes('@') || url.username || url.password ||
      !['http:', 'https:'].includes(url.protocol)) throw Error('invalid-url');
  return url;
}

function callbackURL(value) {
  const url = httpURL(value);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw Error('invalid-callback');
  return url;
}

function singleValue(params, name) {
  const values = params.getAll(name);
  return values.length === 1 && values[0].trim() ? values[0] : null;
}

export function createDirectLogin(authorization, options = {}) {
  const startTimeoutMs = timeoutOption(options.startTimeoutMs, 15000);
  const completionTimeoutMs = timeoutOption(options.completionTimeoutMs, 10 * 60 * 1000);
  let attempt = null;
  const status = () => attempt ? {state: attempt.state, url: attempt.url, error: attempt.error} : {state: 'idle'};
  const active = current => attempt === current && current.state === 'waiting';

  function finish(current, state, error = null) {
    if (!active(current)) return;
    // Retire the attempt before aborting: abort handlers may synchronously call back.
    current.state = state;
    current.error = error;
    clearTimeout(current.startTimer);
    clearTimeout(current.completionTimer);
    const reason = state === 'cancelled' ? abortError() : Error(error ?? 'login-ended');
    current.readyReject(reason);
    current.prompt?.reject(reason);
    if (state !== 'authorized') current.controller.abort(reason);
  }

  function waitForCallback(current, p) {
    if (!active(current) || current.controller.signal.aborted || p.signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (current.prompt) return Promise.reject(Error('already-prompting'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        current.controller.signal.removeEventListener('abort', onAbort);
        p.signal?.removeEventListener('abort', onAbort);
        if (current.prompt === pending) current.prompt = null;
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const pending = {
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      };
      const onAbort = () => pending.reject(abortError());
      current.prompt = pending;
      current.controller.signal.addEventListener('abort', onAbort, {once: true});
      p.signal?.addEventListener('abort', onAbort, {once: true});
    });
  }

  async function begin() {
    if (attempt?.state === 'waiting') throw Error('already-running');
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
    const current = {
      state: 'waiting', url: null, error: null, controller: new AbortController(),
      prompt: null, readyReject, startTimer: null, completionTimer: null,
      expectedState: null, redirect: null,
    };
    attempt = current;
    current.startTimer = setTimeout(() => finish(current, 'error', 'authorization-start-timeout'), startTimeoutMs);

    const interaction = {
      notify(n) {
        if (!active(current) || !n?.url) return;
        try {
          const url = httpURL(n.url);
          if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port) {
            throw Error('invalid-auth-url');
          }
          const redirects = url.searchParams.getAll('redirect_uri');
          if (redirects.length > 1) throw Error('invalid-auth-url');
          const redirect = redirects.length ? callbackURL(redirects[0]) : null;
          // Keep the first URL's state and callback binding; repeat notifications cannot
          // replace the challenge or extend the completion deadline.
          if (current.url) return;
          current.url = url.href;
          current.expectedState = singleValue(url.searchParams, 'state');
          current.redirect = redirect;
          clearTimeout(current.startTimer);
          current.completionTimer = setTimeout(() => finish(current, 'error', 'authorization-completion-timeout'), completionTimeoutMs);
          current.completionTimer.unref?.();
          readyResolve(current.url);
        } catch {
          finish(current, 'error', 'invalid-auth-url');
        }
      },
      prompt(p) {
        if (!active(current) || current.controller.signal.aborted || p?.signal?.aborted) {
          return Promise.reject(abortError());
        }
        if (p?.kind === 'select') {
          return p.options?.some(x => x.id === 'browser')
            ? Promise.resolve('browser')
            : Promise.reject(Error('unsupported-login-method'));
        }
        return waitForCallback(current, p ?? {});
      },
    };
    const failed = error => finish(current, error?.name === 'AbortError' ? 'cancelled' : 'error',
      typeof error?.code === 'string' && /^[a-z][a-z0-9-]*$/.test(error.code) ? error.code : 'authorization-failed');
    try {
      // Also handle a synchronous throw (or a synchronous result) from begin.
      Promise.resolve(authorization.begin({
        key: 'llm-pi-ai/openai-codex', method: 'oauth', interaction, signal: current.controller.signal,
      })).then(result => finish(current, result?.status === 'authorized' ? 'authorized' : 'cancelled'), failed);
    } catch (error) {
      failed(error);
    }
    const url = await ready;
    // A synchronous notification can win the ready promise just before cancellation.
    // Do not hand its URL to the caller once this attempt has already been retired.
    if (attempt !== current || current.state === 'cancelled') throw abortError();
    if (current.state === 'error') throw Error(current.error);
    return url;
  }

  function answer(value) {
    const current = attempt;
    if (!current || !active(current) || !current.prompt) throw Error('no-prompt');
    let url;
    try {
      url = callbackURL(value);
      if (!current.expectedState || singleValue(url.searchParams, 'state') !== current.expectedState ||
          !singleValue(url.searchParams, 'code') || url.searchParams.has('error')) throw Error('invalid-callback');
      const redirect = current.redirect;
      if (redirect && ['protocol', 'hostname', 'port', 'pathname'].some(key => url[key] !== redirect[key])) {
        throw Error('invalid-callback');
      }
    } catch {
      throw Error('invalid-callback');
    }
    current.prompt.resolve(url.href);
  }

  function cancel() {
    const current = attempt;
    if (!current) return;
    finish(current, 'cancelled');
    // Do not discard a newer attempt created synchronously by an abort listener.
    if (attempt === current) attempt = null;
  }
  return {begin, status, answer, cancel};
}

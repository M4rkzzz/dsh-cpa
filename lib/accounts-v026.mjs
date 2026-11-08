import {createHash} from 'node:crypto';
import {ACCOUNT_LOGIN_ERROR_CODES, createAccountLogin} from './auth-v026.mjs';

const SCOPE = 'cpa-codex/';
const NATIVE_KEY = 'llm-pi-ai/openai-codex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
export const ACCOUNT_ERROR_CODES = Object.freeze([
  'accounts-disposed', 'accounts-unavailable', 'account-not-found', 'account-unavailable',
  'account-changed', 'account-provider-mismatch', 'account-delete-forbidden', 'account-invalid-grant',
  ...ACCOUNT_LOGIN_ERROR_CODES,
]);
const fail = code => Object.assign(Error(code), {code});
const copy = value => structuredClone(value);
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const providerFor = id => 'cpa-codex-' + id;

// Claims are identity/display metadata from a host-managed OAuth grant, not authorization from a browser.
// The upstream still authenticates the bearer; no browser field is trusted to select a key or principal.
function principal(payload) {
  if (!payload || payload.type !== 'oauth' || !text(payload.access, 32768) ||
      !Number.isFinite(payload.expires) || payload.expires <= 0 ||
      payload.refresh !== undefined && !text(payload.refresh, 32768)) throw fail('account-invalid-grant');
  const parts = payload.access.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw fail('account-invalid-grant');
  let claims;
  try {claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));}
  catch {throw fail('account-invalid-grant');}
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw fail('account-invalid-grant');
  const auth = claims[AUTH_CLAIM];
  const account = text(auth?.chatgpt_account_id);
  const subject = auth?.chatgpt_user_id === undefined ? text(claims.sub) : text(auth.chatgpt_user_id);
  if (!account || !subject || payload.accountId !== account) throw fail('account-invalid-grant');
  const email = [claims?.email, claims?.[PROFILE_CLAIM]?.email].find(value =>
    text(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ?? null;
  return {hash: createHash('sha256').update(JSON.stringify([account, subject])).digest('hex'), email};
}
function nativeCredential(payload) {
  return {type: 'oauth', access: payload.access, expires: payload.expires, accountId: payload.accountId,
    ...(text(payload.refresh, 32768) ? {refresh: payload.refresh} : {})};
}
function ownedId(key) {
  if (typeof key !== 'string' || !key.startsWith(SCOPE)) return null;
  const id = key.slice(SCOPE.length);
  return UUID.test(id) ? id : null;
}
function describeRecord(record, id, owned, now) {
  try {
    if (record?.kind !== 'grant') return null;
    const identity = principal(record.payload), meta = record.payload.cpaBinding;
    if (owned && (meta?.version !== 1 || meta.id !== id || meta.principalHash !== identity.hash || Object.hasOwn(meta, 'pending'))) return null;
    return {...identity, ready: record.payload.expires > now || Boolean(text(record.payload.refresh, 32768))};
  } catch {return null;}
}
/** All durable data stays in the public host credential service. No credential files or global grant swaps. */
export function createAccounts(ctx, options = {}) {
  const credentials = ctx.credentials, now = options.now ?? Date.now;
  let disposed = false, epoch = 0, flight = null;
  let entries = new Map();
  const listeners = new Set(), removing = new Set();
  const active = () => {if (disposed) throw fail('accounts-disposed');};
  const report = code => {try {Promise.resolve(options.onError?.(code)).catch(() => {});} catch { /* reporting must not break credential operations */ }};
  function changed() {
    for (const listener of [...listeners]) try {Promise.resolve(listener()).catch(() => report('accounts-unavailable'));}
    catch {report('accounts-unavailable');}
  }
  function invalidate(entry, code = 'account-changed') {
    if (!entry.controller.signal.aborted) entry.controller.abort(fail(code));
  }
  function dto(entry) {
    return {id: entry.id, provider: providerFor(entry.id), email: entry.email,
      availability: entry.ready ? 'ready' : 'unavailable', canRunProbe: entry.ready,
      owned: entry.owned, quota: null, quotaStale: true, quotaError: null};
  }
  function ensureStore() {
    if (!credentials || !['listRecords', 'readRecord', 'modifyRecord', 'deleteRecord'].every(name => typeof credentials[name] === 'function')) {
      throw fail('accounts-unavailable');
    }
  }
  async function refresh() {
    active(); ensureStore();
    if (flight) return flight;
    flight = (async () => {
      try {
        for (let retry = 0; retry < 4; retry++) {
          const version = epoch, listed = await credentials.listRecords();
          active();
          if (!Array.isArray(listed)) throw fail('accounts-unavailable');
          const keys = new Set([NATIVE_KEY, ...listed.map(row => row?.key).filter(key => ownedId(key))]);
          const rows = [];
          for (const key of keys) {
            if (login.isPendingKey(key)) continue;
            const record = await credentials.readRecord(key);
            active();
            if (!record) continue;
            const owned = key !== NATIVE_KEY;
            let id = owned ? ownedId(key) : null;
            const identity = describeRecord(record, id, owned, now());
            if (!owned) {
              if (!identity) continue;
              id = 'native-' + identity.hash.slice(0, 32);
            }
            if (removing.has(id)) continue;
            rows.push({id, key, owned, principalHash: identity?.hash ?? null,
              email: identity?.email ?? null, ready: identity?.ready === true});
          }
          if (version !== epoch) continue;
          const next = new Map();
          let notify = false;
          for (const row of rows) {
            let entry = entries.get(row.id);
            if (!entry || entry.key !== row.key || entry.principalHash !== row.principalHash ||
                entry.controller.signal.aborted && row.ready) {
              if (entry) invalidate(entry);
              entry = {...row, controller: new AbortController()};
              notify = true;
            } else {
              if (entry.ready !== row.ready || entry.email !== row.email) notify = true;
              if (entry.ready && !row.ready) invalidate(entry, 'account-unavailable');
              Object.assign(entry, row);
            }
            next.set(row.id, entry);
          }
          for (const [id, entry] of entries) if (!next.has(id)) {invalidate(entry); notify = true;}
          entries = next;
          if (notify) changed();
          return;
        }
        throw fail('accounts-unavailable');
      } catch (error) {
        for (const entry of entries.values()) invalidate(entry, disposed ? 'accounts-disposed' : 'accounts-unavailable');
        throw fail(disposed ? 'accounts-disposed' : 'accounts-unavailable');
      }
    })().finally(() => {flight = null;});
    return flight;
  }
  function queueRefresh() {
    if (disposed) return;
    epoch++;
    Promise.resolve().then(refresh).catch(() => report('accounts-unavailable'));
  }
  function observeChange(key) {
    if (key === NATIVE_KEY || ownedId(key)) queueRefresh();
  }
  const login = createAccountLogin(ctx, {randomUUID: options.randomUUID, loadOAuth: options.loadOAuth,
    loginOptions: options.loginOptions, onError: report, onChange: queueRefresh,
    makeRecord(grant, id) {
      const identity = principal(grant);
      return {kind: 'grant', payload: {...nativeCredential(grant),
        cpaBinding: {version: 1, id, principalHash: identity.hash}}};
    },
  });
  const off = typeof ctx.on === 'function' ? ctx.on('credentials/record-updated', observeChange) : null;

  async function list() {await refresh(); active(); return [...entries.values()].map(dto);}
  async function capture(accountId, providerId) {
    active();
    if (typeof accountId !== 'string') throw fail('account-not-found');
    if (providerId !== providerFor(accountId)) throw fail('account-provider-mismatch');
    await refresh(); active();
    const entry = entries.get(accountId);
    if (!entry) throw fail('account-not-found');
    if (!entry.ready || !entry.principalHash || entry.controller.signal.aborted) throw fail('account-unavailable');
    const signal = entry.controller.signal, expectedHash = entry.principalHash;
    function guard() {
      active();
      if (signal.aborted || entries.get(accountId) !== entry || removing.has(accountId)) throw fail('account-changed');
    }
    function rejectBinding(code) {
      const wasActive = !signal.aborted;
      invalidate(entry, code);
      if (wasActive) changed();
      throw fail(code);
    }
    function check(record, requireActive = true) {
      if (requireActive) guard();
      const identity = describeRecord(record, accountId, entry.owned, now());
      if (!identity || identity.hash !== expectedHash) return rejectBinding('account-changed');
      if (!identity.ready) return rejectBinding('account-unavailable');
      return nativeCredential(record.payload);
    }
    async function read(operation) {
      guard(); operation?.signal?.throwIfAborted();
      let record;
      try {record = await credentials.readRecord(entry.key);}
      catch {return rejectBinding('accounts-unavailable');}
      const result = check(record);
      operation?.signal?.throwIfAborted();
      return result;
    }
    function route(provider) {if (provider !== providerId) throw fail('account-provider-mismatch'); guard();}
    const store = Object.freeze({
      async read(provider, operation) {route(provider); return copy(await read(operation));},
      async list(operation) {await read(operation); return [{providerId, type: 'oauth'}];},
      async modify(provider, mutate, operation) {
        route(provider);
        if (typeof mutate !== 'function') throw fail('account-invalid-grant');
        // An optimistic read cannot authorize a later lock owner. Recheck under the host lock.
        await read(operation);
        let stored, mutationError;
        try {
          stored = await credentials.modifyRecord(entry.key, async current => {
            guard(); operation?.signal?.throwIfAborted();
            const original = check(current);
            let next;
            try {next = await mutate(copy(original));} catch (error) {mutationError = error; throw error;}
            // A refresh may already have rotated its token. Caller cancellation/disposal must not
            // discard a same-principal replacement. Identity is still checked before committing;
            // a retired binding is rejected after persistence, and deletion holds the same lock.
            check(current, false);
            if (next === undefined) return undefined;
            let identity;
            try {identity = principal(next);} catch {return rejectBinding('account-invalid-grant');}
            if (identity.hash !== expectedHash) return rejectBinding('account-changed');
            const payload = entry.owned ? nativeCredential(next) : {...copy(current.payload), ...nativeCredential(next)};
            if (next.refresh === undefined) delete payload.refresh;
            if (entry.owned) payload.cpaBinding = {version: 1, id: accountId, principalHash: expectedHash};
            return {kind: 'grant', payload};
          });
        } catch (error) {
          if (error === mutationError || ACCOUNT_ERROR_CODES.includes(error?.code)) throw error;
          if (operation?.signal?.aborted) throw operation.signal.reason;
          return rejectBinding('accounts-unavailable');
        }
        check(stored);
        // A different writer may have acquired the lock before our acknowledgement arrived.
        return copy(await read());
      },
      async delete(provider) {route(provider); throw fail('account-delete-forbidden');},
    });
    await read();
    return Object.freeze({accountId, providerId, email: entry.email, principalHash: expectedHash,
      signal, credentials: store, assertCurrent: async () => {await read();},
      readCredentialRecord: async () => ({kind: 'grant', payload: copy(await read())})});
  }

  const loginStatus = () => login.status();
  async function beginLogin() {active(); ensureStore(); return login.begin();}
  function answerLogin(url) {active(); return login.answer(url);}
  function cancelLogin() {return login.cancel();}
  async function remove(accountId) {
    active();
    await refresh(); active();
    const entry = entries.get(accountId);
    if (!entry) throw fail('account-not-found');
    if (!entry.owned) throw fail('account-delete-forbidden');
    removing.add(accountId); epoch++; invalidate(entry); changed();
    try {await credentials.deleteRecord(entry.key);}
    catch {throw fail('accounts-unavailable');}
    finally {removing.delete(accountId); epoch++; if (!disposed) await refresh();}
  }
  function onChange(callback) {active(); if (typeof callback !== 'function') throw TypeError('invalid-listener'); listeners.add(callback); return () => listeners.delete(callback);}
  function dispose() {
    if (disposed) return;
    disposed = true; epoch++;
    const cleanup = login.dispose();
    try {if (typeof off === 'function') off();} catch {report('accounts-unavailable');}
    for (const entry of entries.values()) invalidate(entry, 'accounts-disposed');
    entries.clear(); listeners.clear();
    return cleanup;
  }
  return {list, capture, beginLogin, loginStatus, answerLogin, cancelLogin, remove, onChange, dispose};
}

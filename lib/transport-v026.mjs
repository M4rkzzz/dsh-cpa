import {AsyncLocalStorage} from 'node:async_hooks';
import {LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy} from '@deepseek-ai/dsh-llm';
import {PiAiAdapter} from '@deepseek-ai/dsh-llm-pi-ai';
import {clampThinkingLevel, createProvider} from '@earendil-works/pi-ai';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {stream as streamCodex} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {buildBaseOptions} from '@earendil-works/pi-ai/api/simple-options';
import {attachEvidence, createEvidence} from './evidence-v026.mjs';

const noAmbientAuth = Object.freeze({env: async () => undefined, fileExists: async () => false});
const retryPolicy = resolveRetryPolicy(undefined, 'cpa-codex');
const fail = (code, message = code) => new LlmError(message, code);
const abortError = () => fail('ABORTED', 'CPA request cancelled');
const combined = (...signals) => AbortSignal.any(signals.filter(Boolean));
const checkSignal = signal => {if (signal?.aborted) throw abortError();};
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function providerFor(accountId) {
  if (typeof accountId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,149}$/.test(accountId)) throw fail('CPA_ACCOUNT_INVALID');
  return 'cpa-codex-' + accountId;
}
function bindingSnapshot(binding, accountId, providerId) {
  if (!binding || binding.accountId !== accountId || binding.providerId !== providerId ||
      typeof binding.principalHash !== 'string' || !binding.principalHash ||
      !binding.signal || typeof binding.signal.addEventListener !== 'function' ||
      typeof binding.assertCurrent !== 'function' || !binding.credentials ||
      typeof binding.credentials.read !== 'function' || typeof binding.credentials.modify !== 'function') {
    throw fail('CPA_BINDING_MISMATCH');
  }
  // Retain only this capture's immutable authority; never consult a mutable account row during dispatch.
  return Object.freeze({accountId, providerId, principalHash: binding.principalHash, email: binding.email ?? null,
    signal: binding.signal, credentials: binding.credentials, assertCurrent: binding.assertCurrent.bind(binding)});
}
function sameBinding(outer, fresh) {
  if (outer.accountId !== fresh.accountId || outer.providerId !== fresh.providerId ||
      outer.principalHash !== fresh.principalHash) throw fail('CPA_BINDING_MISMATCH');
}
function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {cleanup(); reject(abortError());};
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => {cleanup(); try {checkSignal(signal); resolve(value);} catch (error) {reject(error);}},
      error => {cleanup(); reject(signal?.aborted ? abortError() : error);});
    if (signal?.aborted) abort();
  });
}

/**
 * An owned transport, not a hook around the host's openai-codex route. Each stable
 * wrapper belongs to one account; each prepareCall builds a new public SDK delegate.
 */
export function createCpaTransport(ctx, {accounts, getFast = () => false, isEnabled = () => true, telemetry, fetchImpl = globalThis.fetch} = {}) {
  if (!accounts || typeof accounts.capture !== 'function' || typeof accounts.list !== 'function' ||
      typeof ctx?.llm?.registerAdapter !== 'function' || typeof ctx.llm.prepareCall !== 'function' ||
      typeof fetchImpl !== 'function' || typeof isEnabled !== 'function') throw fail('CPA_TRANSPORT_UNAVAILABLE');
  const lifetime = new AbortController(), routes = new Map();
  // This is a lexical, request-local preparation argument, NOT correlation by model or AbortSignal.
  // It lets probes keep the official core prepare/dispatch chain and its middleware intact.
  const preparation = new AsyncLocalStorage();
  let disposed = false, refreshFlight = null, refreshAgain = false;
  const active = () => {if (disposed) throw fail('CPA_TRANSPORT_DISPOSED');};
  function enabledGuard(route) {
    let enabled = false;
    try {
      const result = isEnabled(route.accountId);
      enabled = result === true;
      // Permission selection is synchronous. Observe, but never trust or await,
      // an accidentally asynchronous predicate; a stale result cannot authorize I/O.
      if (!enabled && result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* policy failures never expose caller details or permit inference */ }
    if (!enabled) throw fail('CPA_ACCOUNT_INACTIVE');
  }

  function delegateFor(route, catalog, binding, tier, audit, guard = async () => {}) {
    const native = openaiCodexProvider();
    const dispatch = (model, context, options = {}) => {
      // pi-ai 1.3.0 Codex streamSimple is this conversion (including model clamp),
      // but loses serviceTier. Override ONLY this public provider's simple entry;
      // all message/tool/image/replay conversion remains in the public PiAiAdapter.
      const apiKey = options.apiKey;
      if (!apiKey) throw fail('MISSING_CREDENTIAL', 'CPA account has no usable grant');
      const base = {...buildBaseOptions(model, context, options, apiKey), toolChoice: options.toolChoice};
      const clampedReasoning = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
      const reasoningEffort = clampedReasoning === 'off' ? undefined : clampedReasoning;
      return streamCodex(model, context, {...base, reasoningEffort, transport: 'sse',
        ...(tier === 'priority' ? {serviceTier: tier} : {}),
        fetch: async (input, init) => {
          const signal = combined(init?.signal, binding?.signal, route.controller.signal, lifetime.signal);
          await guard(signal); checkSignal(signal);
          const discard = response => {try {Promise.resolve(response.body?.cancel()).catch(() => {});} catch {}};
          enabledGuard(route); // No await may separate this final check from model I/O.
          const pending = Promise.resolve(fetchImpl(input, {...init, signal, redirect: 'error'}));
          // A synthetic/custom fetch may ignore abort. Reclaim any late response
          // without awaiting its possibly stalled body cancellation.
          pending.then(response => {if (signal.aborted) discard(response);}, () => {});
          const response = await wait(pending, signal);
          try {await guard(signal); checkSignal(signal);} catch (error) {discard(response); throw error;}
          return response;
        },
        onResponse: response => audit?.onHttpStatus(response.status),
        onProviderStreamEvent: event => audit?.onRawEvent(event)});
    };
    const piProvider = createProvider({id: route.providerId, name: route.displayName,
      baseUrl: native.baseUrl, auth: native.auth, models: catalog, api: {stream: dispatch, streamSimple: dispatch}});
    /** @type {import('@deepseek-ai/dsh-llm-pi-ai').ResolvedPiAiProviderProfile} */
    const profile = Object.freeze({provider: route.providerId, displayName: route.displayName,
      api: 'openai-codex-responses', baseURL: native.baseUrl, transport: 'sse',
      streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, maxRequestImages: 50,
      imageOffloadCountQuantum: 10, requestImagePixelBudget: 2048 * 2048, requestImageMaxBytes: 1024 * 1024,
      retryPolicy, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map()});
    const profiles = new Map([[route.providerId, profile]]);
    return new PiAiAdapter({profiles: () => profiles,
      resolveApiKey: async provider => {if (provider !== route.providerId) throw fail('CPA_BINDING_MISMATCH'); await guard(); return undefined;},
      auth: {credentials: binding?.credentials ?? {read: async () => {throw fail('MISSING_CREDENTIAL');}}, authContext: noAmbientAuth},
      resolveAttachments: () => ctx.get?.('attachments') ?? ctx.attachments,
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
        hostPath => (ctx.get?.('fs') ?? ctx.fs)?.processPathFromHostPath(hostPath), ref)});
  }
  function catalogFor(route) {
    return route.catalog ?? Object.freeze({principalHash: null,
      models: freeze(openaiCodexProvider().getModels().map(model => ({...structuredClone(model), provider: route.providerId})))});
  }
  function assertCatalog(catalog, binding) {
    if (catalog.principalHash !== null && catalog.principalHash !== binding.principalHash) throw fail('CPA_BINDING_MISMATCH');
    checkSignal(catalog.signal);
  }
  function modelsFromDescriptors(route, descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length > 1000) throw fail('CPA_CATALOG_INVALID');
    const native = openaiCodexProvider(), builtins = new Map(native.getModels().map(model => [model.id, model]));
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], seen = new Set();
    return freeze(descriptors.map(row => {
      if (!row || typeof row.id !== 'string' || !/^gpt-[0-9][a-zA-Z0-9_.-]{0,95}$/.test(row.id) || seen.has(row.id) ||
          typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || /[\x00-\x1f\x7f]/.test(row.name) ||
          !Number.isSafeInteger(row.contextWindow) || row.contextWindow <= 0 ||
          !Number.isSafeInteger(row.maxTokens) || row.maxTokens <= 0 ||
          !Array.isArray(row.input) || row.input.length < 1 || row.input.length > 2 || !row.input.includes('text') ||
          row.input.some(mode => mode !== 'text' && mode !== 'image') || new Set(row.input).size !== row.input.length ||
          !row.reasoningEfforts || typeof row.reasoningEfforts !== 'object' || Array.isArray(row.reasoningEfforts)) throw fail('CPA_CATALOG_INVALID');
      seen.add(row.id);
      const efforts = Object.entries(row.reasoningEfforts);
      if (efforts.some(([key, value]) => !levels.includes(key) || (key === 'off'
        ? !['off', 'none', null, ''].includes(value) : !levels.slice(1).includes(value)))) throw fail('CPA_CATALOG_INVALID');
      // Missing native map keys mean implicit support; fill unsupported levels explicitly with null.
      const thinkingLevelMap = Object.fromEntries(levels.map(level => [level, null]));
      for (const [key, value] of efforts) thinkingLevelMap[key] = key === 'off' ? 'none' : value;
      const builtin = builtins.get(row.id);
      // Model.cost is mandatory SDK metadata. Never use these placeholder zeros as
      // provider usage, subscription billing, or a Fast quote; CPA telemetry does not.
      const cost = builtin ? structuredClone(builtin.cost) : {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
      return {...(builtin ? structuredClone(builtin) : {}), id: row.id, name: row.name,
        api: 'openai-codex-responses', provider: route.providerId, baseUrl: native.baseUrl,
        input: [...row.input], contextWindow: row.contextWindow, maxTokens: Math.min(row.maxTokens, row.contextWindow),
        reasoning: efforts.length > 0, thinkingLevelMap, cost};
    }));
  }
  function routeGuard(route) {
    active();
    if (routes.get(route.accountId) !== route || route.controller.signal.aborted) throw fail('CPA_ACCOUNT_REMOVED');
  }
  async function capture(route, signal, expected) {
    routeGuard(route); checkSignal(signal);
    const outer = expected === undefined ? null : bindingSnapshot(expected, route.accountId, route.providerId);
    const pendingSignal = combined(signal, outer?.signal, route.controller.signal, lifetime.signal);
    if (outer) await wait(outer.assertCurrent(), pendingSignal);
    const binding = bindingSnapshot(await wait(accounts.capture(route.accountId, route.providerId), pendingSignal), route.accountId, route.providerId);
    if (outer) sameBinding(outer, binding);
    const boundSignal = combined(pendingSignal, binding.signal);
    const guard = async extraSignal => {
      const currentSignal = extraSignal ? combined(boundSignal, extraSignal) : boundSignal;
      routeGuard(route); checkSignal(currentSignal);
      if (outer) await wait(outer.assertCurrent(), currentSignal);
      await wait(binding.assertCurrent(), currentSignal);
      routeGuard(route); checkSignal(currentSignal);
    };
    await guard();
    return {binding, signal: boundSignal, guard};
  }
  class AccountAdapter extends LlmAdapter {
    constructor(route) {super(); this.route = route;}
    owns(provider) {if (provider !== this.route.providerId) throw fail('NO_ADAPTER'); routeGuard(this.route);}
    providerInfo(provider) {this.owns(provider); return {id: provider, name: this.route.displayName};}
    providerRetryPolicy(provider) {this.owns(provider); return retryPolicy;}
    imageRequestTarget(provider, model, image) {
      this.owns(provider);
      return delegateFor(this.route, catalogFor(this.route).models).imageRequestTarget(provider, model, image);
    }
    async listModels(provider) {
      this.owns(provider);
      const catalog = catalogFor(this.route);
      const {binding, guard} = await capture(this.route);
      assertCatalog(catalog, binding);
      return delegateFor(this.route, catalog.models, binding, null, null, guard).listModels(provider);
    }
    async resolveModel(provider, model, signal) {
      this.owns(provider);
      const catalog = catalogFor(this.route);
      const {binding, guard} = await capture(this.route, signal);
      assertCatalog(catalog, binding);
      const result = await delegateFor(this.route, catalog.models, binding, null, null, guard).resolveModel(provider, model, signal);
      await guard(); return result;
    }
    async prepareCall(provider, model, callerSignal) {
      this.owns(provider); enabledGuard(this.route);
      // Freeze all request facts before the first account/credential await.
      const tier = getFast(this.route.accountId) === true ? 'priority' : null;
      const catalog = catalogFor(this.route);
      const expected = preparation.getStore();
      const {binding, signal, guard} = await capture(this.route, callerSignal,
        expected?.route === this.route ? expected.binding : undefined);
      assertCatalog(catalog, binding); enabledGuard(this.route);
      const audit = createEvidence({accountId: binding.accountId, accountEmail: binding.email, serviceTierRequested: tier});
      let requestSignal = signal;
      const requestGuard = async extraSignal => {
        enabledGuard(this.route);
        await guard(extraSignal ? combined(requestSignal, extraSignal) : requestSignal);
        enabledGuard(this.route);
      };
      const delegate = delegateFor(this.route, catalog.models, binding, tier, audit, requestGuard);
      const prepared = await delegate.prepareCall(provider, model, signal);
      await requestGuard();
      let consumed = false;
      return Object.freeze({model: prepared.model, stream: options => {
        if (consumed || options.provider !== provider || options.model !== model) throw fail('INVALID_PREPARED_CALL');
        consumed = true;
        const dispatchSignal = combined(signal, options.signal);
        requestSignal = dispatchSignal;
        const failed = error => {
          attachEvidence(error, audit);
          // The core rebuilds thrown adapter errors; emit a terminal SDK failure
          // here so HTTP/principal evidence is not lost at that boundary.
          const aborted = dispatchSignal.aborted;
          const failure = error instanceof LlmError ? error.failure : fail('CPA_TRANSPORT_FAILED', 'CPA transport failed').failure;
          return attachEvidence({type: 'finish', reason: {kind: aborted ? 'aborted' : 'error',
            failure: aborted ? abortError().failure : failure}}, audit);
        };
        return (async function* () {
          let iterator, exhausted = false;
          try {
            try {
              await requestGuard(); checkSignal(dispatchSignal);
              iterator = prepared.stream({...options, signal: dispatchSignal})[Symbol.asyncIterator]();
            } catch (error) {yield failed(error); return;}
            while (true) {
              let next;
              try {
                next = await iterator.next();
                if (next.done) {exhausted = true; return;}
                await requestGuard(); checkSignal(dispatchSignal);
              } catch (error) {yield failed(error); return;}
              // Consumer-injected throws must not be misclassified as provider errors.
              yield attachEvidence(next.value, audit);
            }
          } finally {
            if (!exhausted) await iterator?.return?.();
          }
        })();
      }});
    }
    async *stream(options) {
      const prepared = await this.prepareCall(options.provider, options.model, options.signal);
      yield* prepared.stream(options);
    }
  }

  async function reconcile() {
    do {
      refreshAgain = false; active();
      const rows = await wait(accounts.list(), lifetime.signal); active();
      const next = new Map();
      for (const row of rows) {
        const providerId = providerFor(row.id);
        if (row.provider !== providerId || next.has(row.id)) throw fail('CPA_BINDING_MISMATCH');
        next.set(row.id, row);
      }
      for (const [id, route] of routes) if (!next.has(id)) {
        route.controller.abort(); route.unregister(); route.unobserve?.(); routes.delete(id);
      }
      for (const [id, row] of next) {
        if (routes.has(id)) continue; // Stable wrapper identity preserves same-account replay across requests.
        const route = {accountId: id, providerId: row.provider, displayName: 'CPA Codex', controller: new AbortController()};
        const adapter = new AccountAdapter(route);
        routes.set(id, route);
        try {
          route.unregister = ctx.llm.registerAdapter([route.providerId], adapter);
          route.unobserve = telemetry?.registerProvider(route.providerId);
        } catch (error) {
          route.controller.abort(); route.unregister?.(); routes.delete(id); throw error;
        }
      }
    } while (refreshAgain);
  }
  function refresh() {
    if (disposed) return Promise.reject(fail('CPA_TRANSPORT_DISPOSED'));
    if (refreshFlight) {refreshAgain = true; return refreshFlight;}
    refreshFlight = reconcile().finally(() => {refreshFlight = null;});
    return refreshFlight;
  }
  const off = accounts.onChange?.(() => {if (!disposed) void refresh().catch(() => {});});
  return Object.freeze({providerFor, refresh,
    async setCatalog(accountId, descriptors, expectedBinding) {
      active(); providerFor(accountId);
      if (!routes.has(accountId)) await refresh();
      const route = routes.get(accountId);
      if (!route) throw fail('CPA_ACCOUNT_REMOVED');
      const models = modelsFromDescriptors(route, descriptors);
      const version = (route.catalogVersion ?? 0) + 1;
      route.catalogVersion = version;
      const {binding, guard} = await capture(route, undefined, expectedBinding);
      await guard();
      if (route.catalogVersion !== version) throw fail('CPA_CATALOG_SUPERSEDED');
      const previous = catalogFor(route);
      const base = previous.principalHash === null || previous.principalHash === binding.principalHash && !previous.signal.aborted
        ? previous.models : freeze(openaiCodexProvider().getModels().map(model => ({...structuredClone(model), provider: route.providerId})));
      const merged = new Map(base.map(model => [model.id, model]));
      for (const model of models) merged.set(model.id, model);
      // A remote refresh augments/overrides capabilities; it is not authority to
      // delete native or previously usable models from the account's selector.
      route.catalog = Object.freeze({models: freeze([...merged.values()]), principalHash: binding.principalHash, signal: binding.signal});
      try {Promise.resolve(ctx.emit?.('llm/models-updated', route.providerId)).catch(() => {});} catch {}
    },
    async *stream(accountId, options, expectedBinding) {
      active();
      const provider = providerFor(accountId);
      if (options?.provider !== undefined && options.provider !== provider) throw fail('CPA_BINDING_MISMATCH');
      if (!routes.has(accountId)) await refresh();
      const route = routes.get(accountId);
      if (!route) throw fail('CPA_ACCOUNT_REMOVED');
      const outer = expectedBinding === undefined ? undefined : bindingSnapshot(expectedBinding, accountId, provider);
      const signal = combined(options?.signal, outer?.signal, route.controller.signal, lifetime.signal);
      const config = {provider, model: options?.model};
      for (const key of ['reasoningEffort', 'temperature', 'maxTokens', 'stop']) if (options?.[key] !== undefined) config[key] = options[key];
      const prepared = await preparation.run({route, binding: outer}, () => ctx.llm.prepareCall(config, signal));
      checkSignal(signal);
      yield* prepared.stream({...options, ...prepared.config, signal});
    },
    async listModels(accountId) {
      active(); if (!routes.has(accountId)) await refresh();
      const route = routes.get(accountId);
      if (!route) return [];
      return ctx.llm.listModels(route.providerId);
    },
    dispose() {
      if (disposed) return;
      disposed = true; lifetime.abort(); off?.();
      for (const route of routes.values()) {route.controller.abort(); route.unregister(); route.unobserve?.();}
      routes.clear();
    }});
}

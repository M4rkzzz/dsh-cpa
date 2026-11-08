import z from '@deepseek-ai/schemastery';

// "volatile" is the official live-editable Config reference. The settings
// service still commits these fields to the profile document on disk.
export const INTERVAL_MINUTES = Object.freeze([0, 5, 10, 20, 30]);
const interval = z.union(INTERVAL_MINUTES.map(value => z.const(value))).default(0);
const planSchema = z.object({intervalMinutes: interval, model: z.string().default('')});
export const Config = z.object({
  fastEnabled: z.boolean().default(false).volatile(),
  // Preserve the host's pre-existing current account until the first explicit selection.
  // An explicitly saved empty string means no CPA account is enabled.
  activeAccountId: z.string().default('host-current').volatile(),
  plans: z.dict(planSchema).default({}).volatile(),
});

const accountKey = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const modelKey = value => typeof value === 'string' && (value === '' || /^[a-z0-9][a-z0-9._:/-]{0,199}$/i.test(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const valueOf = value => value && typeof value.get === 'function' ? value.get() : value;
const fail = code => Object.assign(new Error(code), {code});

export function validPlan(value) {
  return plain(value) && Object.keys(value).every(key => ['intervalMinutes', 'model'].includes(key))
    && INTERVAL_MINUTES.includes(value.intervalMinutes) && modelKey(value.model ?? '');
}

// No tokens, account grants, image buffers or request rows enter this module.
export function createPreferences(ctx, config = Config({})) {
  const ns = ctx?.fiber?.entry?.options?.id ?? 'cpa-settings';
  let closed = false, pending = 0, error = null, queue = Promise.resolve();
  function active() { if (closed) throw fail('plugin-disposed'); }
  function snapshot() {
    const rawPlans = valueOf(config.plans), plans = {};
    if (plain(rawPlans)) for (const [id, plan] of Object.entries(rawPlans)) {
      if (accountKey(id) && validPlan(plan)) Object.defineProperty(plans, id, {
        value: {intervalMinutes: plan.intervalMinutes, model: plan.model ?? ''}, enumerable: true,
      });
    }
    const id = valueOf(config.activeAccountId);
    return {fastEnabled: valueOf(config.fastEnabled) === true,
      activeAccountId: accountKey(id) ? id : '', plans};
  }
  function guard(isCurrent) {
    active();
    if (isCurrent && !isCurrent()) throw fail('settings-superseded');
  }
  function commit(makeOps, {isCurrent} = {}) {
    active();
    pending++;
    const task = queue.then(async () => {
      guard(isCurrent);
      if (typeof ctx?.settings?.describe !== 'function' || typeof ctx?.settings?.mutate !== 'function') {
        throw fail('settings-unavailable');
      }
      // The CAS protects other settings writers too. Retry only a real revision
      // conflict; a failed disk write must never be reported as a saved preference.
      for (let attempt = 0; attempt < 3; attempt++) {
        guard(isCurrent);
        const forms = await ctx.settings.describe({redactSecrets: true});
        guard(isCurrent);
        const form = forms.find(item => item.ns === ns);
        if (!form || !Number.isSafeInteger(form.revision)) throw fail('settings-unavailable');
        const ops = makeOps(snapshot());
        guard(isCurrent);
        try {
          await ctx.settings.mutate(ns, ops, form.revision);
          // A newer stop may arrive while the host owns its document lock. Its
          // serialized write wins next; do not let this late ACK restart a job.
          guard(isCurrent);
          error = null;
          return snapshot();
        } catch (caught) {
          guard(isCurrent);
          if (caught?.name === 'SettingsConflictError' && attempt < 2) continue;
          throw caught;
        }
      }
    }).catch(caught => {
      if (['settings-superseded', 'plugin-disposed'].includes(caught?.code)) throw caught;
      error = caught?.code === 'settings-unavailable' ? 'settings-unavailable' : 'settings-save-failed';
      throw fail(error);
    }).finally(() => { pending--; });
    // Keep later independent writes usable, and observe all queue rejections.
    queue = task.catch(() => {});
    return task;
  }
  return {
    snapshot,
    status: () => ({pending, error}),
    setFast(enabled, options) {
      if (typeof enabled !== 'boolean') throw fail('invalid-fast-setting');
      return commit(() => [{op: 'set', path: ['fastEnabled'], value: enabled}], options);
    },
    selectAccount(id, options) {
      if (id !== '' && !accountKey(id)) throw fail('invalid-account');
      return commit(() => [{op: 'set', path: ['activeAccountId'], value: id}], options);
    },
    savePlan(id, plan, options) {
      if (!accountKey(id) || !validPlan(plan)) throw fail('pelican-invalid-config');
      const saved = {intervalMinutes: plan.intervalMinutes, model: plan.model ?? ''};
      return commit(() => [{op: 'set', path: ['plans', id], value: saved}], options);
    },
    removeAccount(id, options) {
      if (!accountKey(id)) throw fail('invalid-account');
      return commit(current => [{op: 'unset', path: ['plans', id]},
        ...(current.activeAccountId === id ? [{op: 'set', path: ['activeAccountId'], value: ''}] : [])], options);
    },
    async flush() { await queue; },
    dispose() { closed = true; },
  };
}

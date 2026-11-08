import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config, createPreferences, validPlan} from '../lib/settings-v026.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
async function fixture(t, initial = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cpa-preferences-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'synthetic-profile.json');
  let raw = structuredClone(initial), revision = 0, beforeWrite = options.beforeWrite, writes = [];
  const config = Config(raw), ns = options.ns ?? 'cpa-settings';
  const ctx = {fiber: {entry: {options: {id: ns}}}, settings: {
    describe: options.describe ?? (() => [{ns, revision, value: structuredClone(raw)}]),
    async mutate(targetNs, ops, expected) {
      assert.equal(targetNs, ns);
      if (beforeWrite) await beforeWrite({ops, expected});
      if (expected !== revision) throw Object.assign(new Error('synthetic conflict'), {name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT'});
      const next = structuredClone(raw);
      for (const op of ops) {
        let target = next;
        for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
        if (op.op === 'unset') delete target[op.path.at(-1)];
        else target[op.path.at(-1)] = structuredClone(op.value);
      }
      const candidate = Config(next);
      await writeFile(file, JSON.stringify(next));
      raw = next;
      Object.assign(config, candidate);
      revision++;
      writes.push(structuredClone(ops));
    },
  }};
  const preferences = createPreferences(ctx, config);
  t.after(() => preferences.dispose());
  return {ctx, config, preferences, writes, file,
    setBeforeWrite: fn => { beforeWrite = fn; },
    externalChange: change => { raw = {...raw, ...change}; Object.assign(config, Config(raw)); revision++; },
  };
}

test('official Config exports live-editable defaults and no image/log/credential fields', () => {
  const config = Config({});
  assert.equal(config.fastEnabled.get(), false);
  assert.equal(config.activeAccountId.get(), 'host-current');
  assert.deepEqual(config.plans.get(), {});
  for (const key of ['fastEnabled', 'activeAccountId', 'plans']) assert.equal(Config.dict[key].meta.volatile, true);
  assert.deepEqual(Object.keys(Config.dict), ['fastEnabled', 'activeAccountId', 'plans']);
  assert.throws(() => Config({plans: {a: {intervalMinutes: 6}}}));
  assert.throws(() => Config({fastEnabled: 'true'}));
});

test('Fast, account selection and per-account interval survive a real disk round trip', async t => {
  const f = await fixture(t);
  await f.preferences.setFast(true);
  await f.preferences.selectAccount('account-a');
  await f.preferences.savePlan('account-a', {intervalMinutes: 20, model: 'gpt-5.4'});
  const raw = JSON.parse(await readFile(f.file, 'utf8'));
  const restored = createPreferences(f.ctx, Config(raw));
  t.after(() => restored.dispose());
  assert.deepEqual(restored.snapshot(), {fastEnabled: true, activeAccountId: 'account-a',
    plans: {'account-a': {intervalMinutes: 20, model: 'gpt-5.4'}}});
  assert.deepEqual(restored.status(), {pending: 0, error: null});
});

test('only the actual Loader entry namespace is written', async t => {
  const f = await fixture(t, {}, {ns: 'custom-cpa-instance'});
  await f.preferences.setFast(true);
  assert.equal(f.preferences.snapshot().fastEnabled, true);
});

test('plan writes are serialized without clobbering other account preferences', async t => {
  const f = await fixture(t, {plans: {retained: {intervalMinutes: 10, model: 'gpt-retained'}}});
  await Promise.all([
    f.preferences.savePlan('a', {intervalMinutes: 5, model: 'gpt-a'}),
    f.preferences.savePlan('b', {intervalMinutes: 30, model: 'gpt-b'}),
    f.preferences.setFast(true),
  ]);
  assert.equal(f.writes.length, 3);
  assert.deepEqual(f.preferences.snapshot().plans, {
    retained: {intervalMinutes: 10, model: 'gpt-retained'}, a: {intervalMinutes: 5, model: 'gpt-a'},
    b: {intervalMinutes: 30, model: 'gpt-b'},
  });
});

test('a real revision conflict retries against the latest config, preserving an external edit', async t => {
  const f = await fixture(t);
  let first = true;
  f.setBeforeWrite(() => { if (first) { first = false; f.externalChange({activeAccountId: 'external-account'}); } });
  await f.preferences.setFast(true);
  assert.deepEqual(f.preferences.snapshot(), {fastEnabled: true, activeAccountId: 'external-account', plans: {}});
  assert.equal(f.writes.length, 1);
});

test('persistent conflict is bounded and exposed as a safe save failure', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.setBeforeWrite(() => { attempts++; f.externalChange({activeAccountId: 'external-' + attempts}); });
  await assert.rejects(f.preferences.setFast(true), {message: 'settings-save-failed'});
  assert.equal(attempts, 3);
  assert.equal(f.preferences.snapshot().fastEnabled, false);
  assert.deepEqual(f.preferences.status(), {pending: 0, error: 'settings-save-failed'});
});

test('a disk failure never changes the effective value or returns a raw error', async t => {
  const f = await fixture(t, {}, {beforeWrite: () => { throw Error('secret credential/path must not escape'); }});
  await assert.rejects(f.preferences.setFast(true), {message: 'settings-save-failed', code: 'settings-save-failed'});
  assert.equal(f.preferences.snapshot().fastEnabled, false);
  assert.deepEqual(f.preferences.status(), {pending: 0, error: 'settings-save-failed'});
  f.setBeforeWrite(null);
  await f.preferences.setFast(true);
  assert.equal(f.preferences.status().error, null);
});

test('queued outdated configure is discarded before persistence', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {}, {beforeWrite: async () => { entered.resolve(); await gate.promise; }});
  const first = f.preferences.setFast(true);
  await entered.promise;
  let current = true;
  const stale = f.preferences.savePlan('a', {intervalMinutes: 5, model: 'gpt-a'}, {isCurrent: () => current});
  current = false;
  gate.resolve();
  await first;
  await assert.rejects(stale, {message: 'settings-superseded'});
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.preferences.snapshot().plans, {});
  assert.equal(f.preferences.status().error, null);
});

test('a late host ACK cannot defeat a newer serialized off preference', async t => {
  const gate = deferred(), entered = deferred();
  let block = true, current = true;
  const f = await fixture(t, {}, {beforeWrite: async () => { if (block) { block = false; entered.resolve(); await gate.promise; } }});
  const old = f.preferences.savePlan('a', {intervalMinutes: 5, model: 'gpt-a'}, {isCurrent: () => current});
  await entered.promise;
  current = false;
  const stopped = f.preferences.savePlan('a', {intervalMinutes: 0, model: 'gpt-a'});
  gate.resolve();
  await assert.rejects(old, {message: 'settings-superseded'});
  await stopped;
  assert.equal(f.preferences.snapshot().plans.a.intervalMinutes, 0);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).plans.a.intervalMinutes, 0);
});

test('removing an account erases only its plan and active selection', async t => {
  const f = await fixture(t, {activeAccountId: 'a', fastEnabled: true,
    plans: {a: {intervalMinutes: 5, model: 'gpt-a'}, b: {intervalMinutes: 30, model: 'gpt-b'}}});
  await f.preferences.removeAccount('a');
  assert.deepEqual(f.preferences.snapshot(), {fastEnabled: true, activeAccountId: '', plans: {b: {intervalMinutes: 30, model: 'gpt-b'}}});
});

test('invalid interval, identity, model, or extra sensitive fields cannot be persisted', async t => {
  const f = await fixture(t);
  for (const intervalMinutes of [1, 6, 60, -1, '5', NaN]) {
    assert.throws(() => f.preferences.savePlan('a', {intervalMinutes, model: 'gpt-a'}), {message: 'pelican-invalid-config'});
  }
  for (const id of ['__proto__', 'constructor', '../a', 'a/b', 'a@example.test', '']) {
    assert.throws(() => f.preferences.savePlan(id, {intervalMinutes: 5, model: 'gpt-a'}));
  }
  assert.throws(() => f.preferences.setFast('true'));
  assert.throws(() => f.preferences.savePlan('a', {intervalMinutes: 5, model: 'gpt-a', token: 'secret'}));
  assert.throws(() => f.preferences.savePlan('a', {intervalMinutes: 5, model: 'a\nsecret'}));
  assert.equal(validPlan({intervalMinutes: 0}), true);
  assert.equal(f.writes.length, 0);
});

test('snapshots are detached and ignore malformed nonsecret persisted fields', async t => {
  const f = await fixture(t, {plans: {a: {intervalMinutes: 5, model: 'gpt-a'}}});
  const view = f.preferences.snapshot();
  view.plans.a.intervalMinutes = 30;
  assert.equal(f.preferences.snapshot().plans.a.intervalMinutes, 5);
  const malformed = createPreferences(f.ctx, {fastEnabled: 'true', activeAccountId: '../bad',
    plans: {a: {intervalMinutes: 7}, b: {intervalMinutes: 0, model: 'gpt-b', token: 'bad'}}});
  t.after(() => malformed.dispose());
  assert.deepEqual(malformed.snapshot(), {fastEnabled: false, activeAccountId: '', plans: {}});
});

test('unavailable settings namespace fails closed instead of local-only success', async t => {
  const f = await fixture(t, {}, {describe: () => []});
  await assert.rejects(f.preferences.setFast(true), {message: 'settings-unavailable'});
  assert.equal(f.preferences.snapshot().fastEnabled, false);
  assert.equal(f.preferences.status().error, 'settings-unavailable');
});

test('dispose rejects queued work and future changes without resurrecting preferences', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {}, {beforeWrite: async () => { entered.resolve(); await gate.promise; }});
  const started = f.preferences.setFast(true);
  await entered.promise;
  const queued = f.preferences.selectAccount('a');
  f.preferences.dispose();
  gate.resolve();
  await assert.rejects(started, {message: 'plugin-disposed'});
  await assert.rejects(queued, {message: 'plugin-disposed'});
  await f.preferences.flush();
  assert.throws(() => f.preferences.setFast(false), {message: 'plugin-disposed'});
  assert.equal(f.preferences.snapshot().activeAccountId, 'host-current');
});

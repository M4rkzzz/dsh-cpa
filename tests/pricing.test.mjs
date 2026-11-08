import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCost, PRICING_INFO} from '../lib/pricing-v024.mjs';

const UNKNOWN = {usd: null, kind: 'unknown', priceModel: null};
const usage = extra => ({model: 'gpt-5.4', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, ...extra});
const close = (actual, expected) => {
  assert.equal(typeof actual, 'number');
  assert.ok(Number.isFinite(actual));
  assert.ok(Math.abs(actual - expected) <= Number.EPSILON * 4 * Math.max(1, expected), actual + ' != ' + expected);
};

// Offline fixtures transcribed from the official Standard table and model pages,
// not from the host model catalog or synthetic models in other test suites.
const STANDARD = [
  ['gpt-5.5', 5, 0.5, 30],
  ['gpt-5.4', 2.5, 0.25, 15],
  ['gpt-5.4-mini', 0.75, 0.075, 4.5],
  ['gpt-5.4-nano', 0.2, 0.02, 1.25],
  ['gpt-5.2', 1.75, 0.175, 14],
  ['gpt-5.1', 1.25, 0.125, 10],
  ['gpt-5', 1.25, 0.125, 10],
  ['gpt-5-mini', 0.25, 0.025, 2],
  ['gpt-5-nano', 0.05, 0.005, 0.4],
  ['gpt-4.1', 2, 0.5, 8],
  ['gpt-4.1-mini', 0.4, 0.1, 1.6],
  ['gpt-4.1-nano', 0.1, 0.025, 0.4],
  ['gpt-4o', 2.5, 1.25, 10],
  ['gpt-4o-mini', 0.15, 0.075, 0.6],
  ['gpt-5.3-codex', 1.75, 0.175, 14],
  ['gpt-5.2-codex', 1.75, 0.175, 14],
  ['gpt-5.1-codex-max', 1.25, 0.125, 10],
  ['gpt-5.1-codex', 1.25, 0.125, 10],
  ['gpt-5.1-codex-mini', 0.25, 0.025, 2],
  ['gpt-5-codex', 1.25, 0.125, 10],
  ['codex-mini-latest', 1.5, 0.375, 6],
];
const WRITE_PRICED = [
  ['gpt-6-astra', 10, 1, 50, 25],
  ['gpt-6.1-sol', 2, 0.1, 10, 5],
  ['gpt-6.1-terra', 1, 0.05, 5, 2.5],
  ['gpt-6-sol', 2, 0.2, 10, 5],
  ['gpt-6-luna', 0.1, 0.01, 0.5, 0.25],
  ['gpt-5.6-terra', 2, 0.2, 12, 5],
  ['gpt-5.6-luna', 0.2, 0.02, 1.2, 0.5],
];
const SNAPSHOTS = [
  ['gpt-5.5-2026-04-23', 'gpt-5.5'],
  ['gpt-5.4-2026-03-05', 'gpt-5.4'],
  ['gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'],
  ['gpt-5.4-nano-2026-03-17', 'gpt-5.4-nano'],
  ['gpt-5.2-2025-12-11', 'gpt-5.2'],
  ['gpt-5.1-2025-11-13', 'gpt-5.1'],
  ['gpt-5-2025-08-07', 'gpt-5'],
  ['gpt-5-mini-2025-08-07', 'gpt-5-mini'],
  ['gpt-5-nano-2025-08-07', 'gpt-5-nano'],
  ['gpt-4.1-2025-04-14', 'gpt-4.1'],
  ['gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'],
  ['gpt-4.1-nano-2025-04-14', 'gpt-4.1-nano'],
  ['gpt-4o-2024-08-06', 'gpt-4o'],
  ['gpt-4o-mini-2024-07-18', 'gpt-4o-mini'],
];

test('price metadata fixes USD, Standard basis, audit date and official evidence', () => {
  assert.equal(PRICING_INFO.currency, 'USD');
  assert.equal(PRICING_INFO.basis, 'OpenAI Standard API');
  assert.equal(PRICING_INFO.checkedAt, '2026-11-08');
  assert.ok(Object.isFrozen(PRICING_INFO));
  assert.ok(Object.isFrozen(PRICING_INFO.sources));
  assert.equal(new Set(PRICING_INFO.sources).size, PRICING_INFO.sources.length);
  assert.ok(PRICING_INFO.sources.includes('https://developers.openai.com/api/docs/pricing.md'));
  assert.ok(PRICING_INFO.sources.includes('https://developers.openai.com/api/docs/guides/prompt-caching.md'));
  for (const url of PRICING_INFO.sources) {
    assert.equal(new URL(url).protocol, 'https:');
    assert.equal(new URL(url).hostname, 'developers.openai.com');
  }
  for (const [model] of [...STANDARD, ...WRITE_PRICED]) {
    assert.ok(PRICING_INFO.sources.includes('https://developers.openai.com/api/docs/models/' + model + '.md'), model);
  }
});

for (const [model, rateIn, cachedRate, rateOut] of [...STANDARD, ...WRITE_PRICED]) {
  test('verified Standard rates: ' + model, () => {
    for (const [inputTokens, outputTokens, cacheReadTokens] of [[100000, 0, 0], [100000, 0, 100000], [0, 100000, 0], [100000, 10000, 25000]]) {
      const result = estimateCost({model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0});
      close(result.usd, ((inputTokens - cacheReadTokens) * rateIn + cacheReadTokens * cachedRate + outputTokens * rateOut) / 1e6);
      assert.equal(result.kind, 'estimate');
      assert.equal(result.priceModel, model);
    }
  });
}

test('full prompt includes cache reads, which are discounted but never free', () => {
  assert.deepEqual(estimateCost(usage()), {usd: 0.0037, kind: 'estimate', priceModel: 'gpt-5.4'});
  assert.deepEqual(estimateCost(usage({cacheReadTokens: 1000, outputTokens: 0})),
    {usd: 0.00025, kind: 'estimate', priceModel: 'gpt-5.4'});
});

test('output already includes reasoning and unrelated reasoning metadata is not added twice', () => {
  assert.deepEqual(estimateCost(usage({outputTokens: 300, reasoningTokens: 100})),
    {usd: 0.0052, kind: 'estimate', priceModel: 'gpt-5.4'});
});

test('unknown cache reads produce a labelled uncached-input upper bound', () => {
  for (const cacheReadTokens of [undefined, null]) {
    const bound = estimateCost(usage({cacheReadTokens}));
    assert.deepEqual(bound, {usd: 0.0055, kind: 'upper-bound', priceModel: 'gpt-5.4'});
    for (const read of [0, 100, 800, 1000]) assert.ok(bound.usd >= estimateCost(usage({cacheReadTokens: read})).usd);
  }
  assert.equal(estimateCost({model: 'gpt-5.4', inputTokens: 1000, outputTokens: 200}).kind, 'upper-bound');
});

test('only explicitly documented default dated snapshots resolve to the same SKU', () => {
  for (const [model, canonical] of SNAPSHOTS) {
    for (const inputTokens of [1000, 272001]) {
      assert.deepEqual(estimateCost(usage({model, inputTokens})), estimateCost(usage({model: canonical, inputTokens})), model);
      assert.equal(estimateCost(usage({model})).priceModel, canonical);
    }
  }
});

const LONG_CONTEXT = [
  ['gpt-5.5', [5, 0.5, 30], [10, 1, 45]],
  ['gpt-5.4', [2.5, 0.25, 15], [5, 0.5, 22.5]],
  ['gpt-6-astra', [10, 1, 50, 25], [20, 2, 75, 50]],
  ['gpt-6.1-sol', [2, 0.1, 10, 5], [4, 0.2, 15, 10]],
  ['gpt-6.1-terra', [1, 0.05, 5, 2.5], [2, 0.1, 7.5, 5]],
  ['gpt-6-sol', [2, 0.2, 10, 5], [4, 0.4, 15, 10]],
  ['gpt-6-luna', [0.1, 0.01, 0.5, 0.25], [0.2, 0.02, 0.75, 0.5]],
  ['gpt-5.6-terra', [2, 0.2, 12, 5], [4, 0.4, 18, 10]],
  ['gpt-5.6-luna', [0.2, 0.02, 1.2, 0.5], [0.4, 0.04, 1.8, 1]],
];
for (const [model, short, long] of LONG_CONTEXT) {
  test('whole-request long-context threshold includes cache for ' + model, () => {
    for (const inputTokens of [271999, 272000, 272001]) {
      const outputTokens = 1001; // Total input+output exceeds threshold even at 272000.
      const [rateIn, cachedRate, rateOut, writeRate] = inputTokens > 272000 ? long : short;
      for (const cacheWriteTokens of [0, 250]) {
        const cacheReadTokens = inputTokens - 1000;
        const result = estimateCost({model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens});
        const write = writeRate === undefined ? 0 : cacheWriteTokens;
        close(result.usd, ((1000 - write) * rateIn + cacheReadTokens * cachedRate + write * (writeRate ?? 0) + outputTokens * rateOut) / 1e6);
        assert.equal(result.kind, write ? 'upper-bound' : 'estimate');
        assert.equal(result.priceModel, model);
      }
      const allCached = estimateCost({model, inputTokens, outputTokens: 0, cacheReadTokens: inputTokens, cacheWriteTokens: 0});
      close(allCached.usd, inputTokens * cachedRate / 1e6);
      const noRead = estimateCost({model, inputTokens, outputTokens, cacheWriteTokens: 0});
      close(noRead.usd, (inputTokens * rateIn + outputTokens * rateOut) / 1e6);
      assert.equal(noRead.kind, 'upper-bound');
    }
  });
}

test('long-context premiums do not leak into other verified SKUs', () => {
  assert.deepEqual(estimateCost({model: 'gpt-4.1', inputTokens: 300000, outputTokens: 1000, cacheReadTokens: 100000}),
    {usd: 0.458, kind: 'estimate', priceModel: 'gpt-4.1'});
});

for (const [model, rateIn, cachedRate, rateOut, writeRate] of WRITE_PRICED) {
  test('known writes use exclusive 12h upper-bound rates for ' + model, () => {
    const base = {model, inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 6000, cacheWriteTokens: 2000};
    const result = estimateCost(base);
    const expected = (2000 * rateIn + 6000 * cachedRate + 2000 * writeRate + 1000 * rateOut) / 1e6;
    close(result.usd, expected);
    assert.equal(result.kind, 'upper-bound');
    assert.equal(result.priceModel, model);
    // Both permitted TTLs, and every mixed-TTL split, are <= all-writes-at-12h.
    for (const longWrites of [0, 500, 1000, 2000]) {
      const actual = (2000 * rateIn + 6000 * cachedRate + (2000 - longWrites) * rateIn * 1.25 + longWrites * writeRate + 1000 * rateOut) / 1e6;
      assert.ok(result.usd >= actual);
    }
    for (const cacheReadTokens of [undefined, null]) {
      const bound = estimateCost({...base, cacheReadTokens});
      close(bound.usd, (8000 * rateIn + 2000 * writeRate + 1000 * rateOut) / 1e6);
      assert.equal(bound.kind, 'upper-bound');
      assert.ok(bound.usd >= result.usd);
    }
    for (const cacheWriteTokens of [undefined, null]) assert.deepEqual(estimateCost({...base, cacheWriteTokens}), UNKNOWN);
  });
}

test('new SKUs require explicit writes, while old SKUs need no write surcharge', () => {
  assert.deepEqual(estimateCost(usage({model: 'gpt-6.1-sol'})), UNKNOWN);
  assert.deepEqual(estimateCost(usage({model: 'gpt-6.1-sol', cacheWriteTokens: 0})),
    {usd: 0.00248, kind: 'estimate', priceModel: 'gpt-6.1-sol'});
  for (const cacheWriteTokens of [undefined, null, 0, 200]) {
    assert.deepEqual(estimateCost(usage({cacheWriteTokens})), estimateCost(usage()));
  }
});

test('unknown names, unavailable cache prices and promotional prices never borrow rates', () => {
  const names = ['unknown', '', 'gpt-7', 'gpt-6.2-sol', 'gpt-6.1-sol-2026-11-08', 'gpt-5.6-sol',
    'gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5.2-pro', 'gpt-5-pro', 'gpt-5.4-codex', 'gpt-5.3-codex-spark',
    'gpt-5.4-fast', 'gpt-5.4-priority', 'gpt-5.4-2026-03-06', 'gpt-5.3-codex-2026-02-05',
    'gpt-4o-2024-05-13', 'gpt-4o-2099-01-01', 'openai/gpt-5.4', 'openai-codex/gpt-5.4',
    'ft:gpt-5.4:example', 'GPT-5.4', ' gpt-5.4', 'gpt-5.4 ', '__proto__', 'constructor', 'toString'];
  for (const model of names) {
    assert.deepEqual(estimateCost(usage({model, cacheWriteTokens: 0})), UNKNOWN, model);
    assert.deepEqual(estimateCost({model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}), UNKNOWN, model);
  }
});

test('malformed token fields cannot coerce to zero or masquerade as missing cache', () => {
  const invalid = [-1, -0.5, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '', '0', '1000', '  ', true, false, [], [0], {}, new Number(0), 0n, Symbol('token'),
    {valueOf() { throw Error('must not coerce'); }}];
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    for (const value of invalid) {
      for (const model of ['gpt-5.4', 'gpt-6.1-sol']) {
        assert.deepEqual(estimateCost(usage({model, cacheWriteTokens: 0, [field]: value})), UNKNOWN, field);
      }
    }
  }
});

test('missing prompt or output remains unknown even when other counters are valid', () => {
  for (const field of ['inputTokens', 'outputTokens']) {
    for (const value of [null, undefined]) assert.deepEqual(estimateCost(usage({[field]: value})), UNKNOWN);
    const omitted = usage();
    delete omitted[field];
    assert.deepEqual(estimateCost(omitted), UNKNOWN);
  }
});

test('impossible cache totals and unsafe combined token totals are rejected', () => {
  for (const model of ['gpt-5.4', 'gpt-6.1-sol']) {
    for (const extra of [{cacheReadTokens: 1001, cacheWriteTokens: 0}, {cacheWriteTokens: 201},
      {cacheReadTokens: null, cacheWriteTokens: 1001}, {inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1},
      {inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0}]) {
      assert.deepEqual(estimateCost(usage({model, ...extra})), UNKNOWN);
    }
  }
  const safe = estimateCost({model: 'gpt-5-nano', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 0});
  assert.equal(safe.kind, 'estimate');
  assert.ok(Number.isFinite(safe.usd));
});

test('empty requests and malformed model identifiers return unknown without coercion', () => {
  for (const value of [undefined, null, '', 0, false, [], {}, () => usage()]) assert.deepEqual(estimateCost(value), UNKNOWN);
  for (const model of [undefined, null, 0, false, [], {}, new String('gpt-5.4'), Symbol('model'),
    {toString() { throw Error('must not stringify'); }}]) assert.deepEqual(estimateCost(usage({model})), UNKNOWN);
});

test('known zero usage stays zero, but missing usage is never a false free request', () => {
  assert.deepEqual(estimateCost(usage({inputTokens: 0, outputTokens: 0, cacheReadTokens: 0})),
    {usd: 0, kind: 'estimate', priceModel: 'gpt-5.4'});
  assert.deepEqual(estimateCost(usage({inputTokens: 0, outputTokens: 0, cacheReadTokens: null})),
    {usd: 0, kind: 'upper-bound', priceModel: 'gpt-5.4'});
  assert.deepEqual(estimateCost({model: 'gpt-5.4'}), UNKNOWN);
});

test('small amounts retain precision instead of rounding to display dollars', () => {
  const result = estimateCost({model: 'gpt-5-nano', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0});
  assert.equal(result.usd, (0.05 + 0.4) / 1e6);
  assert.ok(result.usd > 0 && result.usd < 0.000001);
});

test('estimates are deterministic, do not mutate usage and return isolated results', () => {
  const input = Object.freeze(usage());
  const first = estimateCost(input);
  first.usd = 99;
  assert.deepEqual(estimateCost(input), {usd: 0.0037, kind: 'estimate', priceModel: 'gpt-5.4'});
  const absent = estimateCost(null);
  absent.kind = 'estimate';
  assert.deepEqual(estimateCost(null), UNKNOWN);
  assert.deepEqual(input, usage());
});

// Manually checked against the official sources below on 2026-11-08.
// USD per 1,000,000 text tokens: [uncached input, cached input, output,
// optional 12h cache-write rate]. The last rate is a conservative TTL bound.
// Standard API reference prices only, not Codex subscription/credit charges,
// Batch/Flex/Fast/Priority, regional uplifts, fine-tuning, or tool-call fees.
// Published prices for retired models remain useful for usage records; inclusion
// is not a statement that the model is currently available.
const PRICES = {
  'gpt-6-astra': [10, 1, 50, 25],
  'gpt-6.1-sol': [2, 0.1, 10, 5],
  'gpt-6.1-terra': [1, 0.05, 5, 2.5],
  'gpt-6-sol': [2, 0.2, 10, 5],
  'gpt-6-luna': [0.1, 0.01, 0.5, 0.25],
  'gpt-5.6-terra': [2, 0.2, 12, 5],
  'gpt-5.6-luna': [0.2, 0.02, 1.2, 0.5],
  'gpt-5.5': [5, 0.5, 30],
  'gpt-5.4': [2.5, 0.25, 15],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
  'gpt-5.2': [1.75, 0.175, 14],
  'gpt-5.1': [1.25, 0.125, 10],
  'gpt-5': [1.25, 0.125, 10],
  'gpt-5-mini': [0.25, 0.025, 2],
  'gpt-5-nano': [0.05, 0.005, 0.4],
  'gpt-4.1': [2, 0.5, 8],
  'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4.1-nano': [0.1, 0.025, 0.4],
  'gpt-4o': [2.5, 1.25, 10],
  'gpt-4o-mini': [0.15, 0.075, 0.6],
  'gpt-5.3-codex': [1.75, 0.175, 14],
  'gpt-5.2-codex': [1.75, 0.175, 14],
  'gpt-5.1-codex-max': [1.25, 0.125, 10],
  'gpt-5.1-codex': [1.25, 0.125, 10],
  'gpt-5.1-codex-mini': [0.25, 0.025, 2],
  'gpt-5-codex': [1.25, 0.125, 10],
  'codex-mini-latest': [1.5, 0.375, 6],
};

// Only the Default snapshot explicitly named on each official model page.
// Never strip an arbitrary date, provider prefix, or model suffix: e.g. the
// older gpt-4o-2024-05-13 is NOT the same pricing SKU as today's gpt-4o.
const ALIASES = new Map([
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
]);

// Official Standard table + model pages: <=272K is short; >272K is long.
// Full input (including reads/writes), cached input, cache writes AND full output
// change rates, not just the tokens in excess of the threshold.
const LONG_CONTEXT_PRICES = {
  'gpt-6-astra': [20, 2, 75, 50],
  'gpt-6.1-sol': [4, 0.2, 15, 10],
  'gpt-6.1-terra': [2, 0.1, 7.5, 5],
  'gpt-6-sol': [4, 0.4, 15, 10],
  'gpt-6-luna': [0.2, 0.02, 0.75, 0.5],
  'gpt-5.6-terra': [4, 0.4, 18, 10],
  'gpt-5.6-luna': [0.4, 0.04, 1.8, 1],
  'gpt-5.5': [10, 1, 45],
  'gpt-5.4': [5, 0.5, 22.5],
};
const LONG_CONTEXT_THRESHOLD = 272_000;
const DOCS = 'https://developers.openai.com/api/docs';

export const PRICING_INFO = Object.freeze({
  currency: 'USD',
  basis: 'OpenAI Standard API',
  checkedAt: '2026-11-08',
  sources: Object.freeze([
    DOCS + '/pricing',
    DOCS + '/pricing.md',
    DOCS + '/guides/prompt-caching.md',
    ...Object.keys(PRICES).map(model => DOCS + '/models/' + model + '.md'),
  ]),
});

// The official prompt-caching guide confirms exclusive input classes (writes
// REPLACE ordinary input pricing), only 30m/12h lifetimes, and each input token
// billed once at the longest selected lifetime. Without TTL breakdown, all
// reported writes use the verified 12h maximum and the result is upper-bound.
// A missing write count on GPT-5.6/6 is unknown, NEVER an ordinary-input bound.
// gpt-5.6-sol is omitted: its promotional price expires on 2026-11-30 and this
// API has no request date. Models lacking verified cache prices (Pro) are omitted.
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const unknown = () => ({usd: null, kind: 'unknown', priceModel: null});

/**
 * Estimate one request, never aggregated token counts across multiple requests.
 * inputTokens is the COMPLETE prompt, including cache reads/writes. outputTokens
 * must include billed reasoning tokens; do not add reasoning to it a second time.
 * Only null/undefined cache counters mean unknown; malformed values are not zero.
 * Optional cacheWriteTokens is required for models with separate write pricing.
 * Positive writes on those models use the higher 12h price, including mixed TTLs.
 * Unknown reads use the ordinary-input price for all remaining non-write input.
 * These bounds concern Standard API token costs, NOT actual bills/subscriptions.
 * No currency rounding, network, filesystem, runtime clock, or persistent cache.
 * @returns {{usd: number|null, kind: 'estimate'|'upper-bound'|'unknown', priceModel: string|null}}
 */
export function estimateCost(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return unknown();
  const {model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens} = usage;
  if (typeof model !== 'string') return unknown();
  const priceModel = Object.hasOwn(PRICES, model) ? model : ALIASES.get(model);
  if (!priceModel || !validCount(inputTokens) || !validCount(outputTokens)
    || !Number.isSafeInteger(inputTokens + outputTokens)) return unknown();

  const missingRead = cacheReadTokens === null || cacheReadTokens === undefined;
  if (!missingRead && (!validCount(cacheReadTokens) || cacheReadTokens > inputTokens)) return unknown();
  const read = missingRead ? 0 : cacheReadTokens;
  const missingWrite = cacheWriteTokens === null || cacheWriteTokens === undefined;
  if (!missingWrite && (!validCount(cacheWriteTokens) || cacheWriteTokens > inputTokens - read)) return unknown();
  const rates = inputTokens > LONG_CONTEXT_THRESHOLD && Object.hasOwn(LONG_CONTEXT_PRICES, priceModel)
    ? LONG_CONTEXT_PRICES[priceModel] : PRICES[priceModel];
  const [rateIn, cachedRate, rateOut, writeRate] = rates;
  const separateWrites = writeRate !== undefined;
  if (separateWrites && missingWrite) return unknown();
  // Earlier models' writes are already covered by ordinary uncached input.
  const write = separateWrites ? cacheWriteTokens : 0;
  const usd = ((inputTokens - read - write) * rateIn + read * cachedRate
    + write * (writeRate ?? 0) + outputTokens * rateOut) / 1_000_000;
  if (!Number.isFinite(usd)) return unknown();
  return {usd, kind: missingRead || write > 0 ? 'upper-bound' : 'estimate', priceModel};
}

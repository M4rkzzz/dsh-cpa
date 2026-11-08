# DSH ChatGPT Direct

DSH plugin for in-process ChatGPT Codex authorization, model discovery, account quota, request telemetry and lightweight scheduled SVG checks. It uses the built-in `llm-pi-ai/openai-codex` transport and DSH credential store. No CLIProxyAPI process is needed for direct sessions.

Install from the [GitHub repository](https://github.com/M4rkzzz/dsh-cpa) through DSH Market, or install the packaged archive. GitHub-source Market installs can detect version bumps on the default branch; a GitHub Release is not required for that channel. In Settings → CPA, choose **Add ChatGPT account**. Model sync adds account-listed models while retaining existing models and the default selection. Choose an `openai-codex` conversation model to use direct transport. Existing `chatgpt-cpa` sessions keep their original route until switched.

## 0.2.4: request activity

The CPA page observes **new `openai-codex` LLM requests after this plugin loads**, including pelican tests. Other providers, historical sessions, and account quota/catalog HTTP calls are not request-log entries. It does not replay or scan conversations.

- Recent 200 requests: timestamp, source, outcome, **actual HTTP status when exposed**, model, cache-hit rate, input/output tokens, TTFT, elapsed time, observed TPS and estimated USD.
- Summary since load or clear: request/outcome counts, token totals, mean TTFT/elapsed/TPS/cache-hit rate, and USD estimates with priced/unpriced coverage. Clearing logs resets this window; it does not cancel a request.
- The bounded log and scalar aggregates are kept in memory, reset on plugin reload, and do not create log files. Unknown measurements are shown as `—`, never fabricated as zero or HTTP 200. Aggregates exclude unknown metric samples and display their coverage. Activity polling is visible-only every 3 seconds and does not refresh the quota endpoint.

### Metric definitions

`inputTokens` is the full prompt including cached reads/writes; the host's pi-ai uncached-input field is normalized rather than mistaken for the full input. Cache hit is cached-read tokens / full prompt tokens. Missing cache details are unknown unless cumulative accounting can prove a zero count. The displayed average cache hit is the arithmetic mean of known per-request rates, not a token-weighted account rate.

TTFT runs from local stream iteration start to the first nonempty text, reasoning or tool-call token delta. Elapsed time ends at the terminal event or cancellation. TPS = reported output tokens / seconds between first token and completion, only when both tokens and a positive interval exist. These are **client-observed** stream metrics, not server-side decoding benchmarks. Output includes reasoning tokens when the provider reports them. Repeated usage chunks are cumulative snapshots, not additional tokens.

The installed DSH pi-ai adapter does not normally expose HTTP response status, so the status-code column often remains `—` even on success. Outcome and HTTP code are separate. Only explicit structured response/failure codes may be shown; error text is never parsed to guess a code.

### Estimated USD, not a subscription bill

Known model prices are a bundled snapshot of [OpenAI's official Standard API price table](https://developers.openai.com/api/docs/pricing), checked **2026-11-08**, with verified model-page references included in the pricing metadata. Input, cached input and output are priced separately; supported long-context thresholds are applied to the whole request. Model names and verified snapshots are matched explicitly, not by guessing that similarly named models share a price.

This is an API-price equivalent, **not a ChatGPT subscription bill or actual quota charge**. Fast/Priority, Batch/Flex, regional uplifts, special contracts, tools, images and other non-token charges are not included. Missing model prices or token data remain unpriced; the total explicitly shows its coverage. If an upper-bound estimate is available despite incomplete cache details, it is labeled `≤` and is not presented as an exact estimate. Refresh the bundled price table when official prices change; there is no background pricing download or on-disk pricing cache.

## Pelican SVG check

Choose an account-listed model in Settings → CPA, then use **Run once** or explicitly enable a recurring plan with an integer interval of **1–10080 minutes**. The exact prompt is:

> 生成一张鹈鹕骑自行车的SVG

Plans are **off by default** and are not persisted across reloads. Enabling a plan waits one full interval before the first request; the next interval begins after completion. Only one validation/generation runs at once. Cancel stops the current test; disabling stops both the current test and the plan. Requests consume your real model quota only after an explicit run/enable action.

The check calls the host LLM service directly with a plain text message: **no session, tools, attachments, SVG files, output files or cache files are created by the test**. Only the latest result is kept in memory. A 120-second overall deadline and 256-KiB output limit bound a run; cancellation/disposal reject late results. The SVG is displayed as escaped text, never executed or injected into the document. A test result is not a visual-quality or model-availability guarantee.

This no-artifact guarantee applies to the pelican feature. It does not prevent normal DSH credential refresh persistence, independent host tracing/middleware, OS/browser behavior or upstream provider retention. The plugin does not enable tracing or modify those host policies.

## Fast compatibility

A **Fast** switch is placed immediately to the left of weekly quota. It is explicitly disabled in this release: the verified DSH `0.2.2-rc.1` public Codex adapter does not forward `service_tier`. This plugin does not pretend a UI toggle changes routing, replace the global network stack, or modify an installed DSH. Actual Fast mode needs a supported host adapter interface first.

## Quota and authorization

Quota is an account-level observation, refreshed while the settings page or a direct conversation is visible, not a per-model guarantee. Credentials never leave DSH's credential store except in authorized calls to ChatGPT. Write routes require the host's authenticated connection and same-origin validation; responses use `Cache-Control: no-store`.

Model discovery uses a minimum tested Codex catalog compatibility version of `0.165.0`. When a local Codex model cache is available, only its newer stable `client_version` is read; no cached models, identity or credentials are imported. Machines without Codex use the bundled compatibility baseline.

The interface uses layout patterns from the MIT-licensed DSH OpenCode Go plugin; see [third-party notices](<THIRD_PARTY_NOTICES.md>). See [security notes](<SECURITY.md>) and the [Chinese guide](<README.zh-CN.md>).

# DSH ChatGPT Direct

Isolated ChatGPT Codex accounts, quota, real Fast, persistent request metadata and memory-only pelican PNG history. No CLIProxyAPI process is required. Requires **DSH 0.2.2-rc.1+** and **Node 22.19.0+**.

Install from the [GitHub repository](https://github.com/M4rkzzz/dsh-cpa) through DSH Market, or install the packaged archive. The GitHub channel detects version bumps on the default branch without requiring a GitHub Release.

## 0.2.11

- Ordinary conversations use **native DSH step events and first-token timestamps**, not observer-side timing presented as host metrics. Preparation/retry semantics follow DSH, and timing is persisted only after durable assistant settlement.
- Aggregate TPS is **total output tokens / total decode seconds**, never an arithmetic mean of per-row rates. Reasoning and tool deltas use the native first-token definition without double-counting output.
- **TTFT and elapsed time display seconds (s)**; TPS remains token/s. Independent pelican probes explicitly identify local stream timing.
- Legacy timing has no native evidence: it is not backfilled or included in new speed statistics. Other logs, usage and PNGs are preserved; missing boundaries/tokens remain unknown.
- Verification uses isolated synthetic streams compared event-by-event with the actual public DSH sessionStats projection, without production configuration changes or real model probes.

## 0.2.10

- Separate Fast **preference / dispatched tier / raw response field**. Dispatch evidence is captured at the final local transport boundary, never inferred from the toggle preference.
- Preserve response-event source and presence. A terminal event without a tier no longer inherits an interim default/auto value. Legacy provenance remains unknown.
- **Codex response `service_tier=default` does not prove Fast was ignored**; it is not an end-to-end routing receipt. A short latency comparison is not such proof either. See the [upstream repository contributor explanation](https://github.com/openai/codex/issues/14204#issuecomment-4033184620).
- Fast ON/OFF is tested in isolated configurations, not by changing production settings or inventing mandatory headers/feature flags.

## 0.2.9

- Fast is a native checkbox switch with a visible track/thumb, keyboard interaction, pending feedback and actionable unavailable messages.
- Fast targets the single enabled CPA account independently of the displayed host quota. A valid ACK survives stale quota polls; late shared model catalogs no longer block a supported current model.
- Fix the unbound default monotonic clock that made TTFT, duration and TPS unknown. New requests receive measured values; old rows cannot be reconstructed and are not backfilled.
- Clarify requested/reported service tier separately from model reasoning effort: `priority / default` is unrelated to `max`.

## 0.2.8

- Fix desktop updates rejected with `ERR_PNPM_IGNORED_BUILDS`: public PiAiAdapter/Codex SDK code is prebuilt before publishing, so consumers do not install the complete provider dependency graph. No dependency build approval or desktop policy change is needed.
- CI validates clean pnpm 11.28.5 strict-build installs and post-install integration tests. An npm install with scripts disabled is not evidence that desktop updates work.
- Release version: **0.2.8**; Git tag: **v0.2.8**, never a commit hash. Market 1.70.2 may still display its internal commit identifier for a GitHub source; that is Market presentation, not this package version.

## 0.2.7

- Extract untrusted SVG text in linear time, with an absolute deadline covering synchronous processing.
- Cancel the underlying log scan and retain its reader quota until it actually exits.
- Recover from temporary credential-store failures by dropping invalidated remote catalogs for new calls; old prepared calls stay invalid.
- Revalidate activation model choices against the acknowledged catalog without overwriting newer session/model choices.
- Keep every retired backend entry and shipped client asset.

## 0.2.6

- The composer toolbar contains **Fast / weekly quota**, matched to the adjacent model control's font, line-height and height.
- Account entries use the email when available. **Save multiple accounts, but enable only one CPA account at a time.** The single green selected control means enabled with valid identity-bound credentials, not that a charged availability test has succeeded.
- Enable an account with its radio control. If a session exists and its model is supported, select that account's **CPA Codex** provider through the normal model selector; otherwise choose a supported model explicitly. Activation also persists without an open session. The plugin never redirects an already-prepared request or replaces the original `openai-codex`/legacy proxy routes.
- On the owned CPA channel, Fast sends `service_tier: "priority"`. Off keeps the same channel without requesting priority. Changes affect future prepared calls, not work already in progress. **Fast may consume quota faster.** Requested and provider-reported tiers remain separate.
- Preferences persist through official Config/settings; account grants remain in the official credential service. Each added account has its own OAuth flow and key. The host's current grant is referenced without copying its rotating refresh token.

## Per-account pelican checks

Click **鹈鹕测试** to run once; the running control can stop the attempt. The dropdown is limited to **Off / 5 / 10 / 20 / 30 minutes**. Selecting an interval saves the plan but **does not run immediately**. Restoring/rescheduling waits a full interval with no catch-up. Each account is single-flight; the next interval starts after completion.

Switching pauses the former account while keeping its PNG history and saved plan. Re-enabling waits a full interval. Inactive accounts cannot start CPA model calls or tests; there is no round-robin switching. Stop an existing ordinary CPA conversation before switching or removing its active account.

The exact prompt is:

> 生成一张鹈鹕骑自行车的SVG

A test consumes real model quota on the explicitly chosen account/model. It creates no session, tools or attachments. Validation, generation and rendering have a 120-second overall deadline and a 256-KiB output cap. A controlled background WASM worker converts restricted SVG into PNG, then discards the SVG; only PNG buffers and small image metadata remain.

History opens authenticated PNG images for that account. Limits are 8 images per account, 64 images / 16 MiB globally, and 2 MiB per image. Reload clears images, not preferences or logs. No image or test-transcript files are written. Scripts, entities, external/local resources, embedded images and excessive complexity are rejected; failed rasterization never creates a successful history item.

## Request logs

Only new owned CPA Codex and original `openai-codex` model calls are observed after loading. No historical session scanning/replay; quota and catalog HTTP reads are not model-log entries.

Terminal display metadata is appended as NDJSON under the active profile's `.dsh-cpa/activity.ndjson`, with **no automatic count/size retention limit**. Fields are start time, account email, source, model/provider, outcome/finish reason, fixed safe error, real HTTP status, cache/token metrics, TTFT/duration/TPS, Standard-price reference and tier evidence. No end timestamp, prompts, output/reasoning, tool arguments, session ids, credentials or raw errors are retained.

The UI keeps one 50-row page, supports filters, streaming export and explicit clear; resident memory does not grow with history. Rows are typically hundreds of bytes to roughly 1 KB, but unlimited accumulation still consumes disk. Logs survive reloads. Clear does not delete accounts/images or cancel ordinary conversations.

Only start time is shown: local-today `HH:mm`, otherwise `MM-DD`, with a full start-date tooltip. There is no end-time column.

### Metrics and reference prices

Input is the complete prompt including cache. Missing provider fields remain unknown; normalized host defaults cannot prove a true zero cache count or a free request. Aggregates show known-sample coverage. TTFT is locally observed time to the first text/reasoning/tool delta; TPS is reported output tokens divided by seconds after the first token until termination, not an upstream decoding benchmark.

The owned channel deliberately uses SSE for real HTTP response status and raw usage evidence. Original host requests keep unknown values where the host does not expose them; success never implies HTTP 200.

USD uses the bundled [official OpenAI Standard API price table](https://developers.openai.com/api/docs/pricing), checked **2026-11-08**. It is **not a ChatGPT subscription bill or actual quota charge**, and excludes Fast/Priority uplifts and non-token charges. Requested priority does not prove served priority. Unknown models/incomplete usage are not valued at zero; reliable upper bounds are labeled `≤`.

## Updates and security

Every retired backend entry directly forwards to the current implementation to tolerate cached package resolution; old client assets remain available for pages awaiting refresh. After upgrading, verify actual authenticated routes and refresh the page rather than relying on a Market activation label. Do not delete credentials or unrelated plugins to repair an update.

Routes retain host authentication and strict Host Connection origin checks without trusting forwarded headers. JSON and PNG responses are not cached. The browser never receives grants or executable SVG.

Model sync adds reliable account catalog entries without overwriting host defaults or other routes. Its compatibility baseline is `0.165.0`; only a newer public `client_version` may be read from an optional local Codex cache, never cached identity/models/credentials.

See [security notes](<SECURITY.md>), [third-party notices](<THIRD_PARTY_NOTICES.md>) and the [Chinese guide](<README.zh-CN.md>).

# CPA 0.2.6 implementation contract

User approved: independent public-SDK CPA Codex transport AND true multi-account management. LATEST CORRECTION: save multiple accounts but enable only ONE CPA account at a time; no concurrent or round-robin account use. This overrides earlier parallel-account scheduling assumptions. Inactive accounts keep PNG history/settings but cannot run; enabling resumes a saved plan only after a full interval. Ordinary active CPA conversations make switching fail safely until stopped. Metadata/credential isolation APIs remain per-account. Do not follow older research messages limiting scope to the current account. Do not modify the installed host/profile during development, replace a host adapter, redirect prepared requests, patch global fetch, read credential files, or make real model calls in tests.

## Ownership

- Lead: integration entry, Config/preferences, append-only log store, package/lock/docs/release.
- pelican-runner: per-account scheduler and bounded PNG history + tests.
- direct-fix: owned transport + tests.
- auth-fix: account registry/scoped credential store/OAuth + tests.
- pricing-usage: request evidence + telemetry + tests.
- client-fix: new client + client tests.
- png-render: safe WASM renderer/worker + tests.

Retain old backend entry paths and old client assets. New implementations use v026; do not edit v024/v025 implementations unless explicitly owned as forwarding entry shims.

## Common identity

Account rows use stable opaque id, never email or user-supplied credential keys as routing authority. Owned ids are UUID-based; provider ids are deterministic cpa-codex-<id>. Credentials stay exclusively in the host credential service under a fixed owned prefix. Per-account stores accept only their exact native provider id, map to one fixed key, validate immutable principal identity before and after refresh, and have no env/file/global-account fallback. Missing or changed identity fails closed. Do not copy a rotating refresh token into two independent custodians. The existing native account may be exposed as a clearly bound reference to its original key (not duplicated), with stable identity-derived id and no deletion of the host-owned credential.

All new accounts get separate OAuth flows/keys; adding an account must not overwrite the global host grant. Credentials are long-lived through the official credential service; nonsecret preferences through official Config. Account removal cancels its prepared/probe work and clears its images. Identity change invalidates old work/history commits; token rotation within the same principal does not change account ownership.

Account DTO:

~~~js
{id, provider, email: string|null, enabled:boolean, availability:'ready'|'unavailable'|'unknown',
 canRunProbe:boolean, owned:boolean, quota, quotaStale, quotaError}
~~~

Green means configured, valid bound credentials / can use this channel, not a claim of a successful charged probe. Missing email is explicitly unknown, never invented. Keep the current host account usable without copying its refresh token.

## Module APIs (report any necessary adjustment before callers depend on it)

~~~js
// accounts-v026.mjs
createAccounts(ctx, options?) -> manager
manager.list() -> Promise<AccountDTO[]>
manager.capture(accountId, providerId) -> Promise<Binding>
// Binding: accountId, providerId, email, principalHash, signal,
// credentials (native store for this exact provider), assertCurrent():Promise<void>.
manager.beginLogin() -> Promise<{url:string}>
manager.loginStatus() -> {state:'idle'|'waiting'|'authorized'|'error', ...safe fields}
manager.answerLogin(redirectURL); manager.cancelLogin()
manager.remove(accountId) -> Promise<void> // owned keys only
manager.onChange(callback) -> disposer
manager.dispose()

// transport-v026.mjs: publicly declared SDK imports, own PiAiAdapter delegates
createCpaTransport(ctx, {accounts, getFast, telemetry, fetchImpl?}) -> transport
transport.refresh() -> Promise<void> // owned route registration/reconciliation
transport.providerFor(accountId) -> string
transport.stream(accountId, options, expectedBinding?) -> AsyncIterable // own registered route; probe passes captured binding; fresh capture must agree on principal/account/provider and combine lifecycle signals
transport.listModels(accountId) -> Promise<ModelInfo[]>
transport.dispose()
// Each prepareCall captures binding, fast, catalog and request evidence independently.
// Owned channel uses SSE intentionally for real HTTP status; OFF omits service_tier,
// ON sends priority. Reuse public PiAiAdapter for tools/images/replay/errors.
// UI changes selection before preparation via official model-selection service.
// Host openai-codex remains untouched; its unavailable metadata stays unknown.

// evidence-v026.mjs, owned by pricing-usage
createEvidence({accountId?,accountEmail?,serviceTierRequested?}) -> audit
// audit.onHttpStatus(status), audit.onRawEvent(event), audit.snapshot() detached whitelist.
attachEvidence(object, audit) // weak association to yielded chunk/error; no mutation
readEvidence(object) -> detached safe evidence|null
// Transport tags yielded chunks from its per-request delegate with this audit.
// Do not correlate different requests by model or AbortSignal.

// telemetry-v026.mjs
createTelemetry(ctx,{onRecord?,limit?:200,...test clocks}) -> telemetry
telemetry.registerProvider(providerId) -> disposer
telemetry.observeProbe(options,next) // marks probe; exactly one record through SDK chain
telemetry.snapshot(); telemetry.clear(); telemetry.dispose()
// Existing observer passthrough/cancellation/backpressure contract remains.
// onRecord(detached terminal row) once; never block the model stream on disk IO.
// onRecord rejection is observed/reported, not an unhandled rejection.
// Limit is RAM cache only; it NEVER evicts persisted log history.

// png-v026.mjs
createPngRenderer(options?) -> renderer
renderer.render(svg,{signal}?) -> Promise<Uint8Array> // verified PNG, no retained SVG
renderer.dispose() -> cleanup/terminate worker
~~~

## Preferences (Lead)

Export a real Config using public @deepseek-ai/schemastery. Volatile/live-editable fields are persisted via ctx.settings namespace for this plugin entry, revision CAS. Hidden automatic settings page is fine; custom page owns controls. Intended fields: fastEnabled=false, activeAccountId='', plans: dict(id -> {intervalMinutes:0|5|10|20|30, model:string}). No tokens/images/log rows in Config. Serialize writes, merge only owned fields, and prevent stale writes/results from undoing stop. Persist failures remain visible, never pretend saved. After restore/reschedule wait the full interval, no startup catch-up request.

## HTTP / UI DTO (Lead router and client)

Existing authenticated exact routes remain. SameOrigin must continue the v025 real Host Connection bridge fix (trusted protocol + Host).

~~~js
GET /api/cpa-settings -> {
 online, management:true, accounts:[AccountDTO], models:[string],
 authorizationPending, sync,
 fast:{available:boolean,enabled:boolean,reason:null|string,providers:[string]},
 preferences:{fastEnabled,activeAccountId,plans}
}
POST /api/cpa-settings:
 {action:'fast', enabled:boolean} -> settings DTO
 {action:'start'} -> {url}; {action:'status'} -> {status:'wait'|'ok'|'error'}
 {action:'callback',redirectURL}; {action:'cancel'}
 {action:'account-remove',accountId}; {action:'account-select',accountId}
 {action:'sync',accountId?}

GET /api/cpa-activity?cursor=&status=&model=&source=&accountId= -> {
 logs:{available,entries,summary,pricing,page:{nextCursor:null|string},storage:{available,error}},
 accounts:[{id,pelican:{available,running,intervalMinutes,model,nextRunAt,lastError,historyCount}}]
}
POST /api/cpa-activity -> same activity DTO:
 {action:'pelican-run',accountId,model}
 {action:'pelican-configure',accountId,intervalMinutes:0|5|10|20|30,model?}
 {action:'pelican-cancel',accountId}
 {action:'logs-clear'}
GET /api/cpa-history?accountId= -> {images:[{id,createdAt,width,height,url}]}
GET /api/cpa-image?accountId=&imageId= -> authenticated image/png, no-store, nosniff
GET /api/cpa-logs-export?[same filters] -> streamed NDJSON attachment
~~~

Client uses one page (50 rows) at a time. Poll only the newest page, never jump away from older pages; stale GETs/filter generations/clears cannot repopulate old data. Export is a direct authenticated download, not full-history fetch-to-Blob. Clear confirms because history is unlimited persistent. Filters minimum status/model/source/account. No endedAt display or persistence; local-today HH:mm else MM-DD, full START timestamp in accessible title.

Toolbar only Fast and weekly quota. Match host model control: height 28px, font-size 13px, weight 400, line-height 20px, inline-flex/align-items:center, padding 0 6px. No CPA brand trigger. Quota button alone opens full quota popover. Fast reflects acknowledged effective CPA selection, not a fake local flag; selection changes use public model-selection APIs before preparation. Clicking an account email may select that account's CPA provider normally; preserve current model if supported, otherwise require/choose an explicitly communicated valid model. No silent active-session transport replacement.

Account row: green dot (ready only), email; second row [鹈鹕测试 / 停止] [不自动执行 | 5分钟 | 10分钟 | 20分钟 | 30分钟] [历史]. Dropdown configures only; word button runs once; pending/running supports stop. Keep labels accessible but avoid repeated secondary labels. Existing model selection can serve as the probe model; where none is valid, ask to select a Codex model rather than silently making a charged arbitrary choice.

## Logs

Durable append NDJSON at a fixed filename under validated absolute ctx.profileContext.dir/.dsh-cpa. No automatic retention/count limit. Bounded scan buffers and 50-row cursor pages; no whole-file array. Serialize terminal appends, safe clear generation, flush/close on dispose. Persist whitelist display data only: start timestamp, account display identity, model/provider/source, status/error/finish reason, real HTTP status, token/cache counts and rates, TTFT/duration/TPS, standard-reference cost/tier evidence. No endedAt, prompt, output text, headers, raw errors, secrets, SVG or PNG. Internal row/cursor identifiers may be added as needed for paging but are not user content. Startup summary rebuild is streaming; unavailable storage is visible. Recent in-memory cache is not a retention policy.

Telemetry must fix host/native missing->zero circular inference. Raw provider input_tokens already includes cache. Missing/malformed raw cache values remain null. Host-only default all-zero usage is not free billing evidence. Add actual SDK error enums, finishReason, priceModel, priceBasis='openai-standard-reference', serviceTierRequested/Reported separately, usageEvidence='provider'|'host-normalized'|'unavailable'. A requested priority is not confirmation that priority was served. Standard-reference estimates are never actual Fast/subscription bills. Preserve true unknowns and token sample coverage.

## PNG / probes

Fixed user prompt remains exactly 生成一张鹈鹕骑自行车的SVG. No session, attachments, or filesystem image output. Use background @resvg/resvg-wasm@2.6.2 in one worker, lazy init once, no network-loaded WASM. Input <=256KiB, constrained sanitized SVG, no DTD/entities/script/foreignObject/events/external href/CSS resources; limit node/depth/path complexity and fixed 1024x1024/pixel output. External/file/data images must not resolve. Timeout terminates/reclaims worker; explicitly free renderer/output. Support safe ordinary SVG shapes/gradients and basic internal styling where feasible. No inline untrusted SVG in DOM.

Each successful run keeps PNG only (not SVG/prompt/transcript); delete temporary SVG once render succeeds/fails. Limit per-account to 8 images, globally <=64 and <=16MiB; each PNG <=2MiB. Abort/dispose/identity change removes pending work and prevents late images from being committed under another account. Renderer failure is not successful image history. History only returns safe PNG endpoints and small metadata. No model calls in tests.

## Verification

Use real declared npm imports, pinned compatible SDK/native versions, isolated package installation and Node22/24. Test actual serialized Fast bodies under per-request fake fetch, tools/images/replay/abort, immutable prepared binding, concurrent accounts and refresh identity checks. Test renderer with actual WASM and adversarial SVG without network/files, durable log restart/pagination/clear/corruption/torn tail, settings CAS and stop races, client midnight/UTC boundaries and stale polls. Preserve old cached entry regression. No live install until user confirms.

## Single-enabled-account integration (final)

- Config defaults activeAccountId to host-current to preserve the pre-existing native reference on first load. A deliberately saved empty string disables every CPA account, without falling back. Explicit selections persist their stable account id.
- transport and pelican accept isEnabled(id), synchronously strict true only. Root supplies the one acknowledged account plus a closed-during-transition gate. Inactive account metadata can still be inspected; no paid request is permitted. The original host provider is not replaced or redirected.
- Account selection and active removal close the gate before async work. Existing ordinary CPA conversations make the operation fail safely until stopped. telemetry.hasRunningConversation(provider) uses scalar counts independent of log clear or display-ring eviction; no request objects are retained in that map.
- Enabling, stopping, deletion and delayed HTTP bodies use account/control generations. Inactive automatic plans pause without erasing PNG; re-enable waits a full interval. Identity change/removal invalidates PNG. Settings snapshots use one selection generation and identity view, and retries reject a mixed result.
- A Fast ACK must still identify exactly the originating enabled account, matching preferences and provider, before the client selects a channel. Root rechecks the response epoch as well. Public directory.select results must have ok=true. Requests already prepared are never relabeled or redirected.
- Credential/cache metadata must still match captured principal hashes even when an inactive account retains old quota observations; unavailable identity cannot be shown as fresh.

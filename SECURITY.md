# Security

Do not publish grants, OAuth callbacks, account/profile files or conversation content. Tests and examples use synthetic identities and mocked network responses; they must not send real model requests.

## Credentials and transport

Accounts use official DSH credential and authorization services. Each new account owns a UUID-scoped key and independent OAuth flow. New grants are durably staged as pending under the same key and are unavailable to the registry until authorization is committed; cancellation before activation cannot become runnable after a restart even if deletion fails. The existing host grant may be referenced under its original key; its rotating refresh token is never duplicated into a second custodian, and CPA cannot delete that host-owned key. No additional credential file/vault is created, and no claim is made that every host credential backend encrypts its storage.

Multiple grants may be saved, but only one CPA account is enabled. Policy checks apply before preparation and immediately before model IO; inactive metadata may still be read. Account switching and active removal close the gate before asynchronous writes and reject ordinary calls still in progress. Scalar running counters survive log clear/eviction without retaining request objects. State snapshots cannot mix selection generations. Pausing an account preserves its PNG history; identity loss/removal does not. The original host provider is not replaced or redirected.

Each prepared request captures one immutable account/principal/tier/catalog binding. Scoped native stores accept only that exact provider/key, check principal identity before reads and inside refresh modification locks, and reject principal changes or unavailable identity. Same-principal refresh persistence is preserved even if caller cancellation arrives after token rotation; cancelled/retired work cannot continue using the refreshed grant. There is no ambient environment/file/global-account fallback or temporary global credential switch.

The owned adapter uses pinned public PiAiAdapter and Codex SDK exports, prebuilt from declared development dependencies with source provenance, SHA-256 and third-party notices. The release contains its actual SDK runtime bytes, not an optional-peer fallback to private host modules. No consumer prepare/install/postinstall hook is used; no build approval, ignored-script exemption or desktop policy change is required. The SDK-provided static OAuth loader is registered without authorization IO so lazy flows work without the full pi-ai package installed. It preserves the host's tool/image/replay boundary and registers its own routes, without replacing an existing adapter, mutating private provider objects, redirecting prepared calls, or patching global fetch. Fast requests priority on future CPA calls. The preference, the tier observed at the final local fetch boundary, and the raw response field are distinct evidence. The observer only decodes bodies up to 1 MiB (also bounded after zstd decompression), retains fixed tier enums/presence/source, and never persists raw bytes or headers. Terminal omissions do not inherit interim tiers. A local dispatch is not upstream acceptance, and a Codex response default is not proof that Fast routing was ignored. Original host routes remain available.

## HTTP boundary

All routes use the authenticated Host Connection registry. POST checks use the trusted HTTP(S) service protocol and validated Host only for the exact synthetic `http://dsh.internal` bridge origin. Forwarded headers are not authority. Missing-Origin writes are restricted to loopback JSON without cross-site fetch metadata. Desktop uses the official forwarding transport; CPA does not extract authentication cookies.

Write bodies are bounded UTF-8 JSON. OAuth callbacks retain native state/redirect validation. Unknown errors become fixed safe codes, never raw response bodies, stacks or credential messages. JSON, image and export responses are no-store and nosniff.

## Logs

Only new owned CPA Codex and original Codex calls are observed. Weak request-local audit associations extract allowlisted numeric metadata and tier/field-presence evidence; raw provider events/headers are not retained. Observation preserves stream identity, backpressure and cancellation. Clearing/unloading an observer does not abort ordinary host conversations.

Only terminal display metadata is appended to the active profile's fixed `.dsh-cpa/activity.ndjson` path. It includes account email, model/provider and measurements, so treat it as private account metadata. No automatic retention limit applies; users control clear/export and disk growth. It excludes end timestamps, prompts, generated text/reasoning, tool arguments, replay state, session identifiers, grants and raw errors.

Startup aggregation, reverse pagination and export use bounded buffers; no index or array grows with history. A bounded recent/running RAM buffer and bounded I/O admission queue are not a disk retention limit. Failed writes are visible, not reported as persisted. Cursors are instance/generation/filter-bound; clear invalidates queued old writes/readers/exports. Only fixed profile-relative paths are used, with pinned regular-file identity and symlink/hardlink checks. POSIX modes are restricted where supported; Windows relies on the surrounding profile's ACL. Corrupt/overlong/torn rows are skipped with a visible storage warning, not trusted as arbitrary JSON or silently allowed to merge with a later row.

## Pelican images and plans

Tests are explicit, quota-consuming operations. Each account is single-flight, bound to its own captured principal; cancellation, removal, identity change and disposal abort work and reject late output. The exact fixed prompt uses no session, tools or attachments. Plans persist separately through official Config, default off, and restore only after a full interval with no catch-up. Choosing an interval never triggers an immediate run.

Generated SVG is untrusted and remains temporary process/worker memory only. A SAX-parsed, reserialized allowlist rejects DTD/entities, scripts, foreignObject, event attributes, external/file/data resources and excessive complexity. A single background resvg WASM worker has a bounded queue, fixed pixels, output-byte cap and timeout with worker reclamation. No untrusted inline SVG/HTML/iframe is served. Only validated PNG is returned through authenticated, account-bound endpoints.

History retains PNG plus small metadata, never SVG/prompt/transcript: 8 images per account, 64 / 16 MiB globally, 2 MiB per image. Images are not written to filesystem, attachments, sessions, browser storage or cache. Reload/disposal frees history; renderer failures do not count as successful image history.

The image no-artifact guarantee does not prohibit explicitly requested metadata logs, preference persistence, normal credential refresh, independently enabled host tracing, OS/browser behavior or upstream retention. CPA does not enable other tracing or alter host policies.

## Metrics and reference estimates

Raw missing/malformed usage and cache fields remain unknown. Native/host defaults are not evidence of real zero usage. HTTP status requires an actual response/structured failure, never guessed text or success. Requested and reported service tiers are separate. USD is a dated OpenAI Standard API reference, not actual subscription/Fast billing; unknowns are not zero and conservative bounds are labeled. No pricing service receives account or request data.

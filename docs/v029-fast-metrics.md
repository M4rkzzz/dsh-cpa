# 0.2.9 — Fast switch and timing measurements

## Confirmed defects

- Fast was visually a text button with `role="switch"`, with no track or thumb. An unavailable state used both `disabled` and no click handler, so the control could not explain why it did nothing.
- On the native Codex route the quota reference was also used as the Fast target. If a different saved CPA account was the uniquely enabled account, the valid target was ignored and the control was disabled.
- Provider changes after a successful Fast ACK cleared settings and waited for an older, possibly stalled quota GET. A successful toggle could therefore appear off and unavailable.
- The shared model directory could lag the account DTO. Fast must use the acknowledged account model set rather than incorrectly reject a newly supported current model, while still checking session/model guards and never choosing another model automatically.
- The default telemetry clock captured `performance.now` as a bare function. Calling it without its Performance receiver throws on the real runtime; the instrumentation safely swallowed the error and recorded null for duration, TTFT and TPS. Fake-clock tests concealed the default-path defect. Read-only inspection of displayed terminal metadata showed known provider output tokens alongside all three null timing fields. No content or credentials were read.

## Repair and semantics

The new client asset uses a native checkbox switch with a visible track/thumb, a real change handler, controlled checked state, focus-visible styling and pending feedback. The unavailable control remains focusable and announces a concrete reason without issuing a request or changing its checked state. Quota identity and Fast target identity are separate; only the acknowledged enabled account can be targeted. Fast ACK state survives obsolete quota reads, and model support is revalidated after the ACK.

The default clock uses a bound invocation. Tests must exercise a real default-clock stream through the bundled SDK and verify finite TTFT/duration/TPS in summaries and persisted display rows, in addition to deterministic fake-clock math and raw-usage presence. Old log rows have no recoverable timing evidence and must not be backfilled. Missing usage still means unknown TPS, not zero.

The log column is now “服务等级：请求 / 返回”. `priority / default` means the request asked for accelerated service while the response reported the default service tier. It does not prove Priority was delivered. `max` is a separate model reasoning-effort setting, not a service-tier name and not a prerequisite for timing measurements.

## Verification

- Full regression suite: **873 passed, 0 failed, 0 skipped** on Node **22.20.0** and **24.21.0**.
- Client suite: **89 passed**, covering the native switch markup/change handler/style injection, pending and failure feedback, native-to-active-owned-account routing, stalled old GET, stale model metadata, late ACK, and max reasoning preservation.
- Real bundled SDK + synthetic SSE: deterministic TTFT **100 ms**, duration **1100 ms**, TPS **20** with output **20 tokens**; text, reasoning and tool streams are all covered. The default-clock test does not inject now.
- Root integration verifies finite metrics and exact TPS formula in API summaries and persisted display metadata. No real model call is used.
- Packed installation under pnpm **11.28.5**, an empty build allowlist, strict dependency builds and scripts not globally ignored: **304/304 installed integration tests** on each Node major, including the client suite. No dependency-build approvals are needed.

## Scope boundary

Only repository sources, synthetic tests and temporary consumer installs are changed. No current plugin installation, Host archive, credentials, account settings, real model request or OAuth operation is modified. Existing shipped clients remain byte-for-byte available; retired backend entries point directly to the new implementation. The running GUI has not undergone pixel-level or live interaction acceptance in this work.

# 0.2.11 — Native DSH timing parity

## Confirmed defects

The older observer sampled time when CPA pulled a stream, not when DSH started and settled its step. It therefore excluded preparation/used a different end boundary, and could not reproduce DSH retry/backoff semantics. Aggregate TPS was an arithmetic mean of per-request rates. Fixing a detached clock receiver in 0.2.9 made numbers non-null but did not establish native metric accuracy. Synthetic high speeds were never evidence of real model performance.

## Native definition used

The installed DSH version and public development reference are both 0.2.2-rc.1. Through public `session/event`, S is `step/start.time`, F is the first token timestamp in the durable compact stream (or an earlier failed attempt in the same step), and C is `assistant/message.time`.

- TTFT seconds = max(0, F − S) / 1000.
- Elapsed seconds = max(0, C − S) / 1000.
- Decode seconds = max(0, C − F) / 1000.
- Per-row TPS = normalized final-message outputTokens / decode seconds, only for a positive denominator. Do not add reasoning tokens again or subtract a first token.
- Aggregate TPS = sum of paired outputTokens / sum of decode seconds, not mean(per-row TPS). Native zero-decode pairs contribute tokens but never an individual infinite rate; zero total decode remains unknown.

Text/reasoning whitespace is a token delta; a tool name present even as an empty string qualifies. Block/usage/finish chunks do not establish F. An earlier failed attempt can establish F; a retry keeps it and includes the intervening wait in final decode. Attempts with no committed assistant message have no native timing sample. Interrupted assistant messages count when actually committed; usage still gates output speed.

## Public ABI, correlation and bounds

Use public DSH Session events and public `assistantStreamFirstTokenTime` / `isTokenDelta`; no private Host runtime import, session-file scan or content persistence. Ordinary requests correlate by session + observed turn/step. The real Session identity is a public prototype getter. WeakSet provenance in a different SDK copy is not used as an identity gate. Concurrent ambiguous requests fail closed, and absent step boundaries never fall back to local clocks while being labelled DSH.

Native rows wait for durable assistant settlement before a one-time log write. Pending/session state is bounded and holds only scalar data and safe terminal callbacks, not streams, prompts, options, credentials or signals. Clear invalidates prior generations; disposal and bounds safely settle missing messages as unknown. Existing independent conversation-lock counters are unchanged. One-shot/pelican streams have explicitly labelled local observer timing, not a claimed DSH step.

Metrics carry timingVersion=2, source, decodeMs and normalized timingOutputTokens. Internal ABI fields retain milliseconds for compatibility; every UI time value converts to seconds once. Raw usage/cost fields remain separate from normalized timing output. A normalized default zero is not promoted to a known provider zero without evidence. Old timing rows are rendered/aggregated as unverified, without rewriting history, deleting usage/PNG data or manufacturing timestamps.

## Verified results

- Node **22.20.0** and **24.21.0**: each **978/978** full-suite tests pass, no skipped/cancelled cases. Global external fetch was forbidden, and both report **OFFLINE_NETWORK_ATTEMPTS=0**.
- Actual public native projection/telemetry parity suites: **136/136** on each Node major, including 50 native-session cases.
- Strict pnpm **11.28.5** cold consumers with empty allowBuilds, strictDepBuilds=true and ignoreScripts=false: each **498/498** installed integration tests pass. The native projection oracle is dev-only and not needed by consumers.
- All **82** packed files match current source; all prior released client assets remain byte-exact. No production install/reload or configuration change was performed.

## Verification design

The actual public `@deepseek-ai/dsh-session-stats` plugin is a pinned development-only reference. Its `apply` registers the real projection through a test registry, and identical synthetic events feed both native and CPA folds. No copied private formula stands in for the oracle. Coverage includes reasoning/tool/compact streams, retry, cancellation prefixes, preparation/backpressure boundaries, zero/missing data, real Session getter, independent SDK provenance, ambiguous sessions, clear/dispose/eviction, and bounded retention. Root integration runs the actual bundled public SDK and synthetic SSE into authenticated activity/persistence routes, verifying 100 tokens / 1s and 100 / 10s aggregate to 200 / 11, not 55.

Seconds UI tests assert 200ms displays 0.200s, zero remains known, long times stay seconds, and old/unknown rows do not acquire fabricated metrics. All testing is isolated; production configuration and installation remain unchanged and no real model probe is sent.

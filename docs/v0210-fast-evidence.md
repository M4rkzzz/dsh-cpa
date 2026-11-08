# 0.2.10 — Fast diagnosis and isolated ON/OFF test

## Corrected conclusion

The old answer “response default means Fast was not used; only priority confirms it” was too strong. In the public openai/codex repository, contributor pash-openai explains that ChatGPT-authenticated Fast is handled by server-side routing, and `response.service_tier=default` does **not** mean Fast was ignored: [exact comment](https://github.com/openai/codex/issues/14204#issuecomment-4033184620). This is a scoped contributor explanation, not proof of this particular account’s backend routing or an API performance guarantee.

The public Codex configuration maps Fast to wire value `priority`: [config_types.rs](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/config_types.rs). CPA’s existing native-stream option and serialized value agree with that mapping. Replacing it with literal `fast` or inventing a Fast beta header is not a supported fix. Newer official clients also send a routing hint and gate tiers on model capability, but the observed response default does not establish that this header difference is a fault. This repair does not claim otherwise or alter those behaviors speculatively.

## Confirmed local defects

1. `serviceTierRequested` represented the captured Fast preference, not bytes sent. Even a request rejected before transport could say priority.
2. An initial created/in-progress default or auto survived when a terminal event omitted the tier. The displayed row did not identify this provenance. Terminal versus interim values could not be distinguished from existing logs.
3. The column and explanatory wording invited treating the response field as a Fast acceptance receipt. That interpretation is invalid for Codex subscription routing.

## Repair

- Keep the preference separately. Inspect only the final local fetch request body for a safe tier scalar, with a 1 MiB input/decompression bound, no mutation and no body/header/credential persistence. No dispatch means not-sent; omission, unavailability, invalidity and conflict remain distinct. This is local dispatch evidence, not proof of remote acceptance.
- Record terminal response source and field presence; never inherit an interim tier into a missing terminal field, and never let a later interim event overwrite terminal evidence. Conflicting terminal data is not resolved into a false known value.
- Propagate only fixed safe fields through telemetry, append-only storage and the UI. Show preference / dispatched tier / raw response field. Legacy provenance stays unknown; old records are not backfilled.

## Verification

- Full suite with global network fetch forbidden: **912/912** on Node **22.20.0** and **24.21.0**, no skips, and **OFFLINE_NETWORK_ATTEMPTS=0** on each.
- Packed consumers under pnpm **11.28.5** with an empty build allowlist, strictDepBuilds enabled and ignoreScripts disabled: **355/355 installed integration tests** on each Node major.
- Fast ON/OFF tests use in-memory configuration closures and synthetic fetch/SSE; the dispatched body is checked after serialization/zstd compression. Unavailable/oversized observations do not block the original request or falsely confirm a tier.
- Production configuration and installed plugin are not modified or reloaded. No additional real probe is sent after the user clarified isolation-only testing.

## Isolation and authorized live-test boundary

A single minimal real probe was sent through the already registered CPA route after the user initially allowed real requests; it returned OK. The associated metadata did not request priority, so it was **not** an ON-mode control and cannot prove or disprove Fast routing. The user then clarified that production must stay as it is and Fast ON should be simulated in the test environment. No further real probe is sent, no production toggle is changed, and no credential file is read.

All subsequent ON/OFF comparisons use independent in-memory Config/account fixtures, the actual bundled public SDK serializer and synthetic fetch/SSE responses, with ambient network access forbidden. ON must dispatch `service_tier=priority`; OFF must omit it; original options, tools/images/replay and the account-enable gate must remain unchanged. These tests establish local implementation behavior, **not** upstream Fast acceptance or speed.

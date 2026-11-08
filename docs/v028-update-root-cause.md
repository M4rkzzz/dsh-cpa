# 0.2.8 desktop update repair

## Observed failure

The desktop operation log recorded completed resolution/download/linking and the attempted change from CPA 0.2.5 to 0.2.7, followed by `ERR_PNPM_IGNORED_BUILDS` for `@google/genai@2.21.0` and `protobufjs@7.6.6`. The installed package manifest could already read 0.2.7 while the Market card still showed 0.2.5: files having been linked is not evidence of a completed install/activation transaction. No credential, OAuth or paid model operation was involved.

0.2.6 introduced two paths to the full pi-ai dependency graph: direct `@earendil-works/pi-ai` and `@deepseek-ai/dsh-llm-pi-ai` → pi-ai. The graph pulls Google GenAI (preinstall hook) → protobufjs (postinstall hook). Removing just one direct dependency or changing imports alone cannot repair this. Earlier npm `--ignore-scripts` verification missed pnpm 11 strict dependency-build enforcement.

## Repair

The same pinned public SDK code is prebuilt into [sdk.mjs](<../lib/vendor/sdk.mjs>) before publishing. Both full-provider SDK packages are development-only dependencies. Runtime code imports the shipped artifact; no consumer build/prepare hook, optional-peer fallback, private Host import, approve-builds step or security-policy exemption is introduced. The public SDK static OAuth loader is included and tested without authorization IO. Bundle provenance/hash and license texts are shipped alongside the code. Ordinary public LLM/Cordis seams remain declared dependencies.

[verify-install.mjs](<../scripts/verify-install.mjs>) uses pinned pnpm 11.28.5 with `allowBuilds: {}`, `strictDepBuilds: true`, and `ignoreScripts: false` in a new temporary consumer. It checks the resolved graph excludes runtime pi-ai/Google/protobuf packages and exercises installed router, transport, tools/images/replay, Fast, PNG WASM, bundle/OAuth and retired-entry integration suites. Host AuthorizationService tests remain development tests, not a reason to install that Host service into consumers.

## Version label is a separate Market issue

Market 1.70.2 stores GitHub update identities as commits and its `displayLatest` checks a leading digit before checking a SHA. A numeric-leading SHA therefore appears as `v` plus the full commit. Its GitHub path does not choose the latest release tag for ordinary updates. A CPA semver tag alone cannot change another plugin’s UI implementation. CPA publishes package version `0.2.8`, immutable tag `v0.2.8` and a semver-named archive; it never names a release after a SHA. Market was not modified or source-migrated.

## Verified results

- Desktop pnpm **11.28.5**, empty build allowlist, strictDepBuilds enabled, ignoreScripts disabled: old **0.2.7** reproduces the exact ignored-builds failure; fixed **0.2.8** installs successfully. The resolved consumer graph shrinks from 111 to 22 packages and excludes runtime pi-ai/GenAI/protobufjs.
- The same failed 0.2.7 temporary consumer upgrades to **0.2.8** successfully without approving a script (727 ms, 90 obsolete packages removed).
- Full repository regression suite: **842/842** on Node **22.20.0** and **24.21.0**, no skips.
- New, production-only strict-pnpm consumers: **213/213 installed integration tests** on each Node major, no skips, including real PNG WASM conversion and lazy OAuth-module loading without a real authorization request.
- All six retired backend entry paths remain direct shims to v028; every shipped client asset remains present and unchanged.

## Operational boundary

Actual logs and the installed package manifest were inspected read-only. Tests use new temporary consumers and synthetic model/credential data. No live profile manifest, credentials, Market plugin, Host archive or running CPA files are changed by this repair. No real OAuth/model request is sent. Installation/reload of the running environment needs user confirmation; a passing isolated update is not live GUI acceptance.

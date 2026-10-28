# DSH CPA

A DSH settings page for an existing local CLIProxyAPI installation. It shows the local model catalog, Codex authorization status, and the latest quota observed by CPA, and starts the CPA-owned ChatGPT OAuth flow. The existing `chatgpt-cpa` provider route remains the inference provider; this plugin does not replace it or modify your default model. Quota is a cached observation, which can be stale and is not an independently refreshed balance.

## Requirements

- DSH 0.2.1-rc.2 or newer and Node.js 22.19 or newer.
- Windows with an existing CPA installation at `%LOCALAPPDATA%/Programs/CLIProxyAPI`.
- A running CPA service and its existing same-user DPAPI-protected `metrics-key.dpapi` for management operations.
- An already configured `chatgpt-cpa` route in DSH. The plugin does not create a provider route, manage the CPA process, or create the DPAPI file.

Install the package as a DSH plugin and open **Settings → CPA**. Starting authorization is an explicit action; open the displayed OpenAI URL and check the result. A local callback URL can be submitted if browser redirection fails.

All management calls are restricted to loopback and an allowlist of CPA endpoints. OAuth tokens remain managed by CPA. The UI never receives the CPA management key or model API key. The account list is reduced to display labels and status. The OAuth authorization URL and optional callback are transient.

The model catalog sync runs at startup, every five minutes, and after successful authorization; it can also be requested from the page. It appends newly advertised CPA models only when the local Codex model cache contains the required metadata. Existing models and the default model are preserved, and unavailable metadata is reported rather than guessed. The current DSH adapter supports reasoning levels through `max`; an advertised `ultra` level is omitted. It does not enable OpenAI cloud compaction. Restarting or replacing CPA is outside the plugin's scope.

The settings layout adapts the MIT-licensed dsh-opencode-go stylesheet; see [third-party notices](THIRD_PARTY_NOTICES.md).

Run `npm test` to check endpoint restrictions, sanitization, and origin handling.

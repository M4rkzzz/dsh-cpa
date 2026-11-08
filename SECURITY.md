# Security

Do not include credentials, OAuth callback URLs, account identifiers, profile files or conversation content in public issues. Use synthetic data in tests and examples.

The plugin uses DSH native ChatGPT Codex OAuth and credential storage. It reads the resulting grant in process for fixed ChatGPT quota and model catalog requests; credentials are never returned to the browser. Local write actions require DSH authentication and same-origin checks. API responses are `Cache-Control: no-store`. The plugin does not launch a local proxy or read CLIProxyAPI credentials.

Host Connection may expose a synthetic `http://dsh.internal` request URL. For this bridge only, write checks derive the public origin from the already-validated Host header and the injected web server's trusted HTTP(S) protocol. They do not trust `Forwarded` or `X-Forwarded-*`. Requests without Origin remain limited to loopback JSON clients without cross-site fetch metadata. Desktop requests continue through its official cookie-forwarding transport; the plugin does not extract or replace authentication cookies.

## Request activity

The public `llm/stream` observer records only bounded metadata for new `openai-codex` requests. It does not retain prompts, generated text, reasoning, tool arguments, replay state, session identifiers, headers, access tokens or raw provider errors. The recent-request buffer is limited to 200 entries; since-clear statistics are scalar aggregates. Reload or clear resets this data. Observing, clearing or unloading the observer must not abort ordinary host conversations or replace global fetch. Only explicitly supplied structured HTTP status is accepted; successful requests are not labeled HTTP 200 by inference.

## Pelican checks

A pelican check is an explicitly requested, quota-consuming LLM operation, disabled by default. It uses a fixed plain-text prompt without a session, tools or attachments. The interval and last SVG are kept in memory only. No test transcript, SVG, attachment, output or cache file is written. One check may run at a time, with a 120-second overall deadline and a 256-KiB output cap. Disabling or unloading stops the schedule and aborts its current request; late results cannot re-enable the plan.

Generated SVG is untrusted model output. It is returned as a bounded JSON string and displayed through normal escaped text rendering, never HTML injection, inline SVG execution, iframe, image preview, automatic download or browser storage. A valid SVG-shaped response is not a safety or visual-quality certification.

This is a plugin-level no-artifact guarantee, not a claim about all host or upstream behavior. DSH may persist refreshed credentials, and independently enabled middleware or inspectors may record requests. The plugin does not enable those facilities or alter retention policies.

## Estimates and unsupported features

USD figures are estimates from a dated, bundled OpenAI Standard API table, not billing records. Unknown models, incomplete token accounting and unverified pricing conditions are not silently valued at zero. Upper bounds are labeled separately, and totals report priced coverage. No credentials or request content are sent to a pricing service.

The Fast control is unavailable until the host exposes a supported service-tier interface. This release does not patch installed DSH code, change a private provider object, or intercept network traffic to force a tier.

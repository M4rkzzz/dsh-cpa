# Security

Do not include credentials, OAuth callback URLs, account identifiers, profile files or conversation content in public issues. Use synthetic data in tests and examples.

The plugin uses DSH native ChatGPT Codex OAuth and credential storage. It reads the resulting grant in process for fixed ChatGPT quota and model catalog requests; credentials are never returned to the browser. Local write actions require DSH authentication and same-origin checks. The plugin does not launch a local proxy or read CLIProxyAPI credentials.

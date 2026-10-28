# Security

Do not include credentials, OAuth callback URLs, profile files, account identifiers or conversation content in public issues. Report sensitive security issues privately where possible. Tests and examples must use synthetic data.

The plugin reads the existing CPA configuration and same-user Windows DPAPI-protected management secret; it never returns those credentials to the browser. CPA itself owns OAuth token storage. The plugin's management requests are restricted to a small allowlist of loopback endpoints. Model synchronization only adds models reported by CPA for which local metadata exists and leaves existing routes and defaults intact.

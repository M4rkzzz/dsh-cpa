# DSH ChatGPT Direct

DSH plugin for in-process ChatGPT Codex authorization, model discovery, and account quota. It uses the built-in `llm-pi-ai/openai-codex` transport and DSH credential store. No CLIProxyAPI process is needed for direct sessions.

Install the release package through DSH plugin manager. In Settings → CPA, choose **Add ChatGPT account** to authorize. The plugin adds account-listed models while retaining existing models and the default selection. Select an `openai-codex` model for a conversation to use direct transport. Existing `chatgpt-cpa` sessions remain on their original route until switched.

Quota is an account-level observation, refreshed while the settings page or a direct conversation is visible; it is not a per-model guarantee. Credentials never leave DSH’s credential store except in authorized calls to ChatGPT.

The interface uses layout patterns from the MIT-licensed DSH OpenCode Go plugin; see THIRD_PARTY_NOTICES.md.

Model discovery uses the account endpoint with a minimum tested Codex catalog compatibility version of `0.165.0`. When a local Codex model cache is available, only its newer stable `client_version` is used; no cached models, identity or credentials are imported. Machines without Codex use the bundled compatibility baseline.

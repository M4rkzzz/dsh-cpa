# DSH ChatGPT 直连插件

在 DSH 进程内完成 ChatGPT Codex 授权、模型同步和额度展示。直接会话使用 DSH 自带的 `llm-pi-ai/openai-codex`，无需本地 CLIProxyAPI 服务。

在「设置 → CPA」添加 ChatGPT 账号。模型同步只增补可靠的账号目录条目，保留现有模型与默认选择。会话选择 `openai-codex` 模型后走直连；原 `chatgpt-cpa` 会话在主动切换前维持原路由。

额度是账号级最近观测值，不保证各模型有独立额度。授权由 DSH 凭据服务保管。

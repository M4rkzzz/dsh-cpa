# DSH CPA

为已有本机 CLIProxyAPI 提供 DSH 设置页面：查看 ChatGPT 账号状态、CPA 最近一次观测到的额度、模型目录，并通过 CPA 启动 ChatGPT 授权。模型请求继续使用已有的 `chatgpt-cpa` 路由，插件不改变默认模型。

当前版本面向 Windows，要求 CPA 安装在 `%LOCALAPPDATA%/Programs/CLIProxyAPI`，其配置文件和当前用户可解密的 `metrics-key.dpapi` 已存在。服务须在本机运行。模型同步依赖 `~/.codex/models_cache.json` 里的模型资料；没有可靠资料的模型不会自动添加。模型和原有权限不会被删除。

在 DSH 的「设置 → CPA」中查看连接、额度和模型；选择「添加 ChatGPT 账号」并在授权页面完成登录。CPA 管理授权；插件不会向页面返回管理密钥或访问令牌。账号额度来自 CPA 最近期记录，可能已过期；不同模型记录可能属于同一额度池。

插件只访问本机 CPA 固定接口。它不提供 OpenAI 云端压缩，不启停 CPA。执行 `npm test` 可以运行合成测试。界面部分样式参考了 MIT 许可的 dsh-opencode-go，详见第三方声明。

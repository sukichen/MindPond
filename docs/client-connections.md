# 客户端接入与身份核对

Agent 使用两个独立 MCP，但身份一致：Office 管角色和通信，Memory 管角色私有与办公室共享记忆。人类通过记忆工作台管理全部知识。公开 MCP 不提供人类默认身份或 full/work 管理目录。

## 推荐：生成 Office 与 Memory 配套配置

在工作台的“宿主连接”登记 Codex / OpenCode，下载该宿主的完整配置。也可使用：

```sh
mindpond-connect office-prepare --client codex --directory /absolute/connections/office --remote-url https://pond.example/mcp --token-env MINDPOND_TOKEN
mindpond-connect office-run --directory /absolute/connections/office
```

凭据放在宿主环境，不发给模型。OpenCode 需安装生成的会话插件。Codex 使用原生 `threadId`。申请或激活角色后，分别调用 Office 的 `role_sync` 和 Memory 的 `memory_identity`，两者的角色 ID 与 binding ID 必须一致。Memory 身份响应包含 `identity.protocol = mindpond.role-memory.v1`、`humanFallback = false`。

没有真实聊天标识时，使用工作台生成的角色专用凭据。不能通过个人域、固定标签或模型参数指定角色。详见[角色记忆](role-memory.md)。

## 本机独立 Memory

本机 stdio 可用同一数据库中的 Office 绑定：

```sh
mindpond-connect prepare --client codex --directory /absolute/connections/memory --db /absolute/data/mindpond.db
mindpond-connect inspect --directory /absolute/connections/memory
mindpond-connect run --directory /absolute/connections/memory --dry-run
mindpond-connect run --directory /absolute/connections/memory
```

生成器也支持 `claude`、`opencode`。它不覆盖全局配置，不包含模型凭据。OpenCode 本机适配器使用实际 sessionID，通过 Node worker 调用同一套角色 Memory；不会自动采集对话或把知识写入个人默认域。

本机数据库必须与 Office 指向同一文件。跨机器不能用本机 stdio 猜测中心角色，需使用中心的 `/memory/mcp`。客户端缺少原生聊天 ID 时，调用返回 `identity_required`；Claude 等客户端应使用明确的角色专用 HTTP 配置。

## 远程 Memory 桥接

```sh
mindpond-connect prepare --client codex --directory /absolute/connections/remote-memory --remote-url https://pond.example/memory/mcp --token-file /absolute/private/host.token
```

桥接保留宿主原生聊天元数据。普通宿主凭据仍需聊天 ID；固定安装标签不足以识别聊天。角色专用凭据明确固定角色，并在同时提供聊天 ID 时核对绑定。OpenCode 优先使用完整配套配置的签名插件。

## 更新与移除

`prepare` 同配置重试复用目录；不同配置拒绝覆盖。`remove` 只删除校验通过的受管理文件，保留数据库与其它文件。升级后重新生成接入配置，更新实际可执行路径并重连 MCP；网页刷新不能更新常驻 stdio 进程。

`--personal`、Memory 的 `--session`、`--tools work|full` 不再是接入方式。已有记忆不会按姓名自动移动；人类可在工作台阅读来源并添加独立副本给角色。

MCP 边界不能隔离具有相同文件系统权限的恶意本地程序。数据库、配置和令牌应留在专用账户的私有目录。

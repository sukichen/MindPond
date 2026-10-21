# 中心服务与角色 MCP

中心服务持有数据库，客户端通过独立的 Streamable HTTP 端口连接。一个实例按一个人类用户管理，宿主凭据识别获批准的连接；每个真实聊天再绑定一个 Office 角色。机器名、IP、个人域和固定安装标签都不能代替角色身份。

## 服务端

优先在工作台登记宿主并下载配套配置。CLI 也可登记宿主，命令只打印路径，令牌留在私有文件：

```sh
node dist/mcp-http.js grant --config /absolute/private/access.accounts.json --db /absolute/data/mindpond.db --principal human --agent codex-work --token-file /absolute/private/codex-work.token
node dist/mcp-http.js serve --config /absolute/private/access.accounts.json --db /absolute/data/mindpond.db --host 127.0.0.1 --port 7904
```

Web、HTTP MCP、本机 stdio 必须指向同一中心数据库。新程序初始化可能迁移数据库，先按[迁移手册](history.md)在一致副本演练。

网络部署使用 TLS 或可信反向代理，并设置 `--allowed-host pond.example`（含非默认端口时填写 host:port）。直接 TLS 可设置 `--tls-cert`、`--tls-key`。不要关闭证书验证。可信明文内网需显式 `--allow-http`；令牌及内容不会被加密。数据库只放中心机器本地磁盘，不供客户端通过网络文件系统直接打开。

## 两个入口，同一身份

- `/mcp` 仅提供 Office 的角色、消息与办公室工具。
- `/memory/mcp` 仅提供角色 Memory 工具。
- 同一宿主凭据、同一原生聊天 ID，查询同一角色绑定。
- 角色专用凭据可用于两个入口；没有聊天元数据时仍明确固定该角色，同时有聊天元数据时必须匹配该角色。
- 缺少角色身份返回 `identity_required`，不读取或写入 `personal:default`。没有宿主绑定的账户域凭据也被拒绝；不能通过 full/work profile 重新暴露个人记忆工具。

Codex 的 `threadId` 与 OpenCode 的真实 sessionID 由宿主传递，模型参数不能选择身份。OpenCode 配套配置包含签名插件。推荐生成双 MCP 配置：

```sh
mindpond-connect office-prepare --client codex --directory /absolute/connections/office --remote-url https://pond.example/mcp --token-env MINDPOND_TOKEN
```

需要 stdio 桥接时，`mindpond-mcp-remote` 保留每次调用的原生聊天元数据；令牌可来自普通宿主或角色专用私有文件。具体见[客户端接入](client-connections.md)。

## 检查、恢复与撤权

```sh
node dist/mcp-http.js check-auth --config /absolute/private/access.accounts.json --db /absolute/data/mindpond.db --token-file /absolute/private/codex-work.token
```

检查只读本机配置与 SQLite，不初始化或迁移数据库，不验证真实聊天元数据或代理路由。没有宿主注册的账户凭据会报告 `account_requires_host_registration`；哈希匹配本身不代表可使用角色 MCP。

默认连接容量为全局128、每账户64，Office 与 Memory 分别占连接；可用 `MINDPOND_MCP_MAX_CONNECTIONS`、`MINDPOND_MCP_MAX_PER_ACCOUNT` 设置1–4096。空闲30分钟回收，执行中的请求不按空闲清理。持久角色绑定与知识不会随临时连接回收而删除；原生聊天 ID 或角色凭据可以重建。

普通凭据每次请求检查，撤销/轮换无需重启；角色凭据也检查角色状态、绑定与当前宿主权限。切换角色连接会撤销原角色专用凭据。`Mcp-Session-Id` 仅为传输状态，不能作为认证凭据。HTTP 端口不暴露人类 REST 管理接口；人类在独立工作台管理全部记忆。

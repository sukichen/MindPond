# 中心账户与局域网 MCP

MindPond 可以由一个中心账户运行数据库和本地模型，通过独立的 Streamable HTTP MCP 端口服务多个账户。账户不绑定机器或 IP：同一个账户可从不同机器连接。不同账户使用独立的可撤销凭据；管理员可让它们指向同一个 `personal/default`，也可为它们指定不同个人域。客户端不需要共享目录、SQLite、模型文件或数据库操作权限。

`mindpond-mcp-http` 是独立入口，不暴露 Web 工作台、REST 或 operator 能力。原来的 `mindpond-mcp` stdio 和 `mindpond-server` 工作台仍可使用。

## 1. 中心账户准备

在中心账户安装源码并构建：

```bash
npm ci
npm run build
mkdir -p "$HOME/.local/share/mindpond/network"
chmod 700 "$HOME/.local/share/mindpond/network"

# 每个工作账户单独签发。命令只打印文件路径，不打印令牌。
node dist/mcp-http.js grant \
  --config "$HOME/.local/share/mindpond/network/access.accounts.json" \
  --principal suki001 --personal default \
  --token-file "$HOME/.local/share/mindpond/network/suki001.token"
node dist/mcp-http.js grant \
  --config "$HOME/.local/share/mindpond/network/access.accounts.json" \
  --principal suki002 --personal default \
  --token-file "$HOME/.local/share/mindpond/network/suki002.token"
```

服务器配置只保存 SHA-256 令牌摘要、账户名、域授权和目录 profile。签发的随机令牌有 256 位熵，权限为 600。以安全渠道分别交给对应账户；同机复制时设置目标所有者，不要把文件改成所有账户可读。不要发送到聊天、提示词或 Git。

这里两账户的长期记忆共享 `personal/default`。若项目资料必须互不读取，为账户使用不同的 `--personal`，例如 `project-one` / `project-two`。一个账户也可由管理员在服务器配置的 `domains` 中授予多个 personal/team 读取域。team 修改仍需要独立的用户授权，不因为获得网络凭据而自动允许发布。账户配置不支持 operator，也不支持人为指定 session 域。

## 2. 启动中心服务

推荐 TLS（可由此入口直接提供，也可通过可信的反向代理）：

```bash
node dist/mcp-http.js serve \
  --config "$HOME/.local/share/mindpond/network/access.accounts.json" \
  --db "$HOME/.local/share/mindpond/central.db" \
  --host 0.0.0.0 --port 7904 \
  --allowed-host memory.internal:7904 \
  --tls-cert /absolute/path/to/server-cert.pem \
  --tls-key /absolute/path/to/server-key.pem
```

`memory.internal` 是部署占位域名，需替换为局域网中实际可解析的主机名或中心 IP；`--allowed-host` 与客户端 URL 的 Host/端口精确一致，可重复指定。数据库可显式指向中心已有库，不进行自动迁移。模型沿用中心实例的 embedding 配置。

受信内网也可省略 TLS 两项，用 `http://`；令牌和记忆届时不加密，客户端需显式使用 `--allow-http`。TLS 客户端需信任证书链，不要关闭证书验证。默认仅监听 loopback，监听所有接口必须明确配置 allowed-host。Origin 默认为拒绝，非浏览器 agent 无需 CORS。服务每次请求重新读取账户配置，撤销/轮换无需重启。

数据库只在中心机器本地磁盘上；不要放在 NFS/SMB 上给多个客户端直接访问。前台命令可由管理员配置为系统服务，数据库与模型的文件权限仍属于中心账户。需要 Web 工作台时在中心另起 loopback 工作台进程，指向同一 DB，不直接开放工作台维护接口给这些账户。

## 3. 各账户接入 Codex / Claude Code / OpenCode

客户端安装 MindPond 包或源码并构建。客户端执行的桥接程序只需要 MCP SDK，不创建数据库或加载模型；整个记忆服务由中心负责。

```bash
chmod 600 /absolute/private/suki001.token
node dist/connect.js prepare \
  --client opencode \
  --directory /absolute/path/to/new-connection-bundle \
  --remote-url https://memory.internal:7904/mcp \
  --token-file /absolute/private/suki001.token \
  --session project-one-conversation-42
node dist/connect.js run --directory /absolute/path/to/new-connection-bundle
```

`--client` 可替换为 `codex` 或 `claude`。在明确的明文内网环境，把 URL 改为 HTTP 并加 `--allow-http`。生成的是这些客户端已经支持的本地 stdio 配置，由 `mindpond-mcp-remote` 桥接到中心，避免要求客户端使用特定远程认证 UI。配置文件只含 URL、令牌文件路径和可选宿主 session，不含令牌正文。也可在支持 Streamable HTTP 和静态 Authorization 的客户端直接配置中心 `/mcp`：每次请求携带对应 `Authorization: Bearer <文件中的令牌>`，使用宿主选择的 `X-MindPond-Session`（可选）。这里是管理员签发的静态凭据方案，不是 OAuth 登录服务。

同一账户在另一台机器部署时使用该账户令牌及同样的中心 URL，不传客户端 DB 路径。远程模式不接受本地模型、personal 授权或 native 插件选项；这些由中心控制。OpenCode 此模式使用 MCP 工具，不宣称具备本地 native adapter 的自动生命周期捕获。

## 4. 账户、项目与 session

- 账户：用于鉴权、审计和域授权，跟着账户走；IP 不代表身份。
- personal：长期知识归属。多个账户是否共享，取决于中心配置的域授权。
- space：项目/上下文组织与涟漪边界，不是安全 ACL。同一 personal 域的其它项目记忆可被显式检索；不同项目须使用不同 space。
- session：由受信宿主通过连接头选择，而不是由工具参数中的 LLM 文本选择。中心将账户名与宿主 session 做散列和命名隔离。相同账户 + 相同逻辑 session 可重连/跨机器继续；不同账户即使给出相同逻辑名字也不是同一 session。
- 未指定逻辑 session 时，每次连接创建随机 session；同账户同时从多机连接也相互独立。重启服务器后须重新初始化 MCP，长期记忆保留；有明确逻辑 session 的会话可重新绑定自己的记录，未指定的临时会话不自动恢复。

一个 host 进程复用一个 MCP 连接时，不能据此区分进程内的多个聊天。并行项目/会话应分别启动连接 bundle 并传不同的 `--session`。宿主仍负责逻辑 session 的结束、压缩与检查点，网络断开不会擅自清空、结束或晋升 session 记忆。网络连接默认空闲 30 分钟回收，每账户最多 8 个连接，全服务最多 128 个。MCP transport session ID 不是身份凭据；所有 POST/GET/DELETE 都必须有当前有效账户令牌。相同逻辑 session 的多个 agent 是显式共享选择。

## 5. 撤销、轮换与验证

撤销：在中心私有配置中移除对应 grant。后续请求会被拒绝。轮换：

```bash
node dist/mcp-http.js grant \
  --config "$HOME/.local/share/mindpond/network/access.accounts.json" \
  --principal suki001 --personal default --rotate \
  --token-file /absolute/private/new-suki001.token
```

轮换使用新的令牌文件，不覆写旧文件；客户端更新路径并重新连接。旧令牌和旧传输 session 均不能继续访问。服务器配置/令牌文件在 Unix 上要求私有权限。Windows 下需管理员设置相应 ACL。

`npm run verify:network-mcp` 使用隔离临时库和真实 SDK HTTP/stdio 客户端，验证跨账户共享、幂等、域/session/项目边界、Host/Origin 拒绝、会话劫持拒绝、凭据轮换、桥接和三类客户端 bundle。测试使用合成向量，不证明真实模型效果，也不代表已在你的工作机器或真实系统账户下部署。

网络协议实现依据锁定的 TypeScript MCP SDK 和 [2025-11-25 Streamable HTTP 规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx)；后续 draft 的传输变更需单独迁移。

## Automation hosts with background work

Ordinary interactive clients keep the default `work` profile. A host that also drains organization work and extraction can receive a domain-scoped `full` account:

```sh
mindpond-mcp-http grant --config /private/accounts.json \
  --principal automation-worker --personal default --profile full \
  --token-file /private/worker.token
```

`--profile` is validated and preserved during credential rotation unless explicitly changed. A full catalog does not grant operator authority: global deduplication and legacy aggregation remain denied on network accounts. Work transitions resolve the persisted work domain before accepting its ID.

The full host contract includes `memory_message_save` (stable host message ID), `memory_work_scopes` (scoped restart recovery), `memory_host_recall` (complete typed result metadata without vectors), `memory_host_read`, and `memory_host_snapshot` (scoped counts or a bounded graph). `memory_host_create` retains explicit L0/L1 legacy snapshot semantics without vector upload, verified assertions or L2/L3 aggregation. Prefer ordinary idempotent saves and organization for new knowledge. These tools are optional for general MCP clients; background hosts must negotiate their presence and must not substitute an empty success or local database on failure. Classification presets are exported as library constants for hosts that customize only an untouched installation template.

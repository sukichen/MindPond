# 部署、升级与恢复

使用 Node.js 22 或更新版本。先运行 `npm ci`、`npm run check`，再运行 `npm start` 或 `npm run mcp`。没有本地模型时可使用明确报告降级的文本检索；模型文件由管理员按其自身许可准备。

默认新安装的数据与缓存位于用户目录。明确设置 `MEMORY_DB_PATH` 可让 HTTP、MCP 和 SDK 共用一个数据库。数据库、WAL/SHM、连接配置、模型缓存、运行日志、捕获 outbox 和备份均放在公开仓库外；这些材料可能含私人正文和凭据。

本机服务优先绑定 loopback。网络监听需要 `MEMORY_API_KEY`，并在部署边界提供 TLS 和限制访问；`MEMORY_ALLOW_UNAUTHENTICATED_NETWORK=1` 仅用于明确的开发环境。共享 API key 本身不提供用户身份隔离。旧式受限 HTTP API 可另设可信上下文签名密钥；角色 Memory 以批准的角色绑定身份。管理与签名能力不得交给模型。CORS 仅允许明确的可信来源。

`/health` 检查进程存活，`/ready` 检查就绪及完整性。使用以下命令只读审计数据库：

```sh
mindpond-maintenance --db /absolute/private/mindpond.db --check
```

升级前停止所有写入宿主，制作 SQLite 一致备份并验证可恢复，保留对应程序版本、配置和文件权限。不要在写入期间只复制主 DB 文件而遗漏 WAL。先用独立备份副本启动新程序并检查迁移、检索、域隔离和恢复，再切换运行实例。修复命令须先阅读 `mindpond-maintenance --help`，在备份副本确认影响后执行。

回退需要匹配旧程序的数据备份，不能假定任意新 schema 都能由旧程序读取。重启后先恢复 outbox 和持久队列，以原幂等 ID 重试；不要通过重新生成 ID 把已提交操作再执行一次。

生产部署应在目标环境验证权限、备份恢复、磁盘容量、服务退出、并发和延迟。仓库测试不宣称这些运营条件或真实 LLM 效果已在所有机器验收。

## 建议的生产拓扑（单个人类用户）

Web 管理和 HTTP MCP 使用独立进程、同一私有 SQLite 数据库。外部只开放 HTTPS；7903/7904 监听 loopback。注册宿主的 Office 入口为 `/mcp`，角色 Memory 入口为 `/memory/mcp`。人类 Memory stdio 拥有全部知识，只配置给用户自己的可信宿主，不能把它当成角色受限连接。

这套身份模型服务一个人类用户及其已授权宿主；不提供多个人类租户之间的隔离，也不是面向任意第三方的 OAuth 服务。网络 MCP CLI 面向服务端宿主客户端：默认拒绝带 `Origin` 的浏览器直连，未提供跨域浏览器 MCP 接入；不要通过清空 Origin 校验绕过这一边界。Web 管理页的浏览器访问由7903提供。当前 SDK 路径按 MCP 2025-11-25 协商与回归；不要把已验证的客户端版本当成对所有后续协议或客户端的支持承诺。

### 1. 保存私有配置，启动两个进程

Web 的环境文件示例（真实密钥用独立随机值替换，文件权限设为600）：

```dotenv
MEMORY_DB_PATH=/var/lib/mindpond/graph.db
MEMORY_HOST=127.0.0.1
MEMORY_PORT=7903
MEMORY_API_KEY=<生成独立随机服务密钥>
MEMORY_OPERATOR_KEY=<生成另一个随机管理密钥>
MINDPOND_MCP_ACCOUNTS=/var/lib/mindpond/accounts.json
MEMORY_TRUST_PROXY=loopback
```

`MEMORY_TRUST_PROXY=loopback` 只用于同机可信反向代理，默认不信任转发头。这样 HTTPS 代理后的同源检查、Secure 管理 Cookie 和客户端地址才能正确工作；不能直接开启“信任所有代理”。配置必须与实际网络路径一致，见 [Express 代理设置](https://expressjs.com/en/guide/behind-proxies/)。

在服务管理器中，Web 启动 `node /opt/mindpond/dist/server.js`，MCP 启动：

```sh
node /opt/mindpond/dist/mcp-http.js serve \
  --config /var/lib/mindpond/accounts.json \
  --db /var/lib/mindpond/graph.db --host 127.0.0.1 --port 7904
```

将 `/opt/mindpond` 替换为已构建或安装的实际程序目录。进程使用专用普通系统用户，数据目录仅该用户可写；设置进程退出后重启、日志轮转和至少35秒的优雅退出窗口。不要给 agent 服务器配置文件、管理密钥或数据库的文件访问权。宿主连接由管理页登记并生成专用凭据。

### 2. HTTPS 反向代理示例

以下片段放进已有证书配置的 Nginx HTTPS `server` 中，示例公共前缀为 `/mindpond/`。所有中间代理都要保留超过6分钟的调用期限。

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Host $host;
proxy_http_version 1.1;
proxy_buffering off;
proxy_read_timeout 370s;
proxy_send_timeout 370s;
client_max_body_size 2m;

location = /mindpond { return 301 /mindpond/; }
location = /mindpond/mcp {
    proxy_pass http://127.0.0.1:7904/mcp;
}
location = /mindpond/memory/mcp {
    proxy_pass http://127.0.0.1:7904/memory/mcp;
}
location /mindpond/ {
    proxy_pass http://127.0.0.1:7903/;
}
```

转发头由代理覆盖；不要透传客户端自带的同名值。公共 Host 还要加入 MCP 监听器的 `--allowed-host` 白名单，例如 `--allowed-host pond.example`；带非默认端口时填写完整 host:port。具体缓存、流式转发与超时含义见 [Nginx proxy 模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。

在管理页保存 `https://pond.example/mindpond/mcp`。Memory 配置将使用 `https://pond.example/mindpond/memory/mcp`；未设置有效公共地址时页面不会猜测127.0.0.1或签发专用配置。

### 3. 切换生产流量前的验收

在数据库备份副本与实际域名、代理、宿主上依次核对：

1. `/mindpond/health` 返回200；`/mindpond/ready` 返回200。未认证的管理操作被拒绝。
2. Web 登录、退出、重启恢复和 `/mindpond/` Cookie 路径正确；HTTPS 下 Cookie 带 Secure/HttpOnly/SameSite。
3. 服务密钥不能代替已设置的管理密钥；角色 MCP 凭据不能登录管理页面。
4. 新宿主配置包含 Office 和 Memory 两个入口。OpenCode 的两个聊天能绑定不同角色；同一聊天重连恢复。
5. 角色只能读自己的知识。人类搜索并分配副本后，角色修改副本不改变原文。角色停用或宿主停用后，旧凭据及仍在准备的写入被拒绝。
6. 生成角色专用配置前核对地址与角色；替换旧配置必须明确确认。新聊天的激活编号与前端一致，激活后旧聊天失去角色访问权。
7. 实际等待超过60秒、消息到达提前返回、5分钟超时可恢复；代理不中途断开。审批不会唤醒已停止的模型。
8. 使用一份升级前一致备份，实际执行恢复到新文件并读取；确认磁盘容量、WAL和备份权限，以及程序/配置/备份的对应版本。

仓库的 `npm run check`、`npm run verify:standalone-package`、`npm run verify:production-role-memory` 和页面回归覆盖工程契约；生产域名证书、网络、容量和恢复演练仍须在目标环境确认。不要把隔离测试通过写成目标机器已经部署验收。

### MCP 输入边界

MCP SDK 锁定在1.32.1。Office、角色 Memory 与维护 MCP 都设置 `maxToolInputElements=10000`，在工具 schema 校验之前限制参数中的对象键和数组元素总数；HTTP 解析器另有1MB正文限制。超过预算的工作应拆成有界批次。

这是针对 [SDK 工具参数校验资源耗尽问题](https://github.com/advisories/GHSA-46jr-4wx8-v453) 的完整配置：仅升级 SDK 不会自动启用元素上限。MindPond 使用自己签发并逐次校验的 Bearer 凭据，不使用 SDK 的 OAuth `requireBearerAuth` / `verifyBearerToken` 验证器。

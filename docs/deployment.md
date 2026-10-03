# 部署、升级与恢复

使用 Node.js 22 或更新版本。先运行 `npm ci`、`npm run check`，再运行 `npm start` 或 `npm run mcp`。没有本地模型时可使用明确报告降级的文本检索；模型文件由管理员按其自身许可准备。

默认新安装的数据与缓存位于用户目录。明确设置 `MEMORY_DB_PATH` 可让 HTTP、MCP 和 SDK 共用一个数据库。数据库、WAL/SHM、连接配置、模型缓存、运行日志、捕获 outbox 和备份均放在公开仓库外；这些材料可能含私人正文和凭据。

本机服务优先绑定 loopback。网络监听需要 `MEMORY_API_KEY`，并在部署边界提供 TLS 和限制访问；`MEMORY_ALLOW_UNAUTHENTICATED_NETWORK=1` 仅用于明确的开发环境。共享 API key 本身不提供用户身份隔离。严格域部署需设置可信上下文签名密钥，宿主绑定身份、可读域和当前会话；operator 与 team 签名能力不得交给模型。CORS 仅允许明确的可信来源。

`/health` 检查进程存活，`/ready` 检查就绪及完整性。使用以下命令只读审计数据库：

```sh
mindpond-maintenance --db /absolute/private/mindpond.db --check
```

升级前停止所有写入宿主，制作 SQLite 一致备份并验证可恢复，保留对应程序版本、配置和文件权限。不要在写入期间只复制主 DB 文件而遗漏 WAL。先用独立备份副本启动新程序并检查迁移、检索、域隔离和恢复，再切换运行实例。修复命令须先阅读 `mindpond-maintenance --help`，在备份副本确认影响后执行。

回退需要匹配旧程序的数据备份，不能假定任意新 schema 都能由旧程序读取。重启后先恢复 outbox 和持久队列，以原幂等 ID 重试；不要通过重新生成 ID 把已提交操作再执行一次。

生产部署应在目标环境验证权限、备份恢复、磁盘容量、服务退出、并发和延迟。仓库测试不宣称这些运营条件或真实 LLM 效果已在所有机器验收。

# 通用协作附件与制品

此能力保存任意文件的原始字节和不可变引用，不解析文件、不调用模型，也不替宿主运行文件。Office MCP 负责身份、引用和消息关系；宿主通过同一 HTTP MCP 服务上的鉴权接口传输字节。无需新增 npm 依赖。

## 最短使用路径

宿主先在本地计算文件大小与 SHA-256，再调用 `office_artifact`：

```json
{
  "action": "prepare",
  "filename": "report.pdf",
  "mime": "application/pdf",
  "size": 12345,
  "sha256": "<本地文件的64位小写SHA-256>",
  "scope": "recipients",
  "recipients": ["<已获准的接收角色ID>"],
  "key": "report-2026-10-27-v1"
}
```

响应中 `artifact` 包含 `artifactId`、`filename`、`mime`、`size`、`sha256`、归属、状态和到期时间；`transfer.path` 给出 `/artifacts/<artifactId>/content`。宿主对该路径 `PUT` 原始文件，校验通过后状态从 `pending` 变为 `ready`。路径不含凭据，不是公开下载链接。

发送消息只传引用：

```json
{
  "action": "send",
  "recipient": "<接收角色ID>",
  "body": "请检查附件中的报告。",
  "artifactIds": ["<artifactId>"],
  "key": "report-message-v1"
}
```

`office_receive` 的消息包含 `artifactIds`，`office_message get` 包含附件元数据。接收方调用 `office_artifact get` 查询当前可用状态，再由宿主 `GET` 同一路径下载。`HEAD` 可查询已授权文件的传输头；下载返回原始字节、Content-Length、SHA-256 和强 ETag，始终作为附件，不在浏览器中执行。当前不支持 Range 或断点拼接；上传中断后重传整份文件。模型无需计算哈希、复制 Base64 或拼接二进制片段。

## 宿主命令行工具

安装包提供 `mindpond-artifact`；源码构建后可使用 `node dist/artifact-client.js`。它使用 Node 标准库和项目现有 MCP SDK，在本地流式计算哈希、上传和下载，只输出元数据。凭据从宿主私有文件读取。

```sh
mindpond-artifact upload \
  --url https://mindpond.example/mcp \
  --token-file ./private/host.token \
  --file ./report.pdf --mime application/pdf \
  --recipient '<角色ID>' --key report-v1

mindpond-artifact download \
  --url https://mindpond.example/mcp \
  --token-file ./private/host.token \
  --artifact '<artifactId>' --out ./downloaded-report.pdf
```

默认使用现有配置式连接身份，即 `X-MindPond-Identity: connection`。逐聊天接入时，增加 `--meta-file <宿主提供的当前聊天MCP元数据JSON文件>`；程序同时用于 MCP 调用和字节传输，不从模型参数选择角色。角色更换宿主或聊天后，私有制品仍跟随角色 ID。

上传默认角色私有；`--recipient` 可重复，表示指定接收者；`--office <officeId>` 表示办公室共享，不能与 `--recipient` 混用。`--retention` 为保留秒数。相同 key、文件及权限用于重试；新版本使用新 key。下载写入私有临时文件，核对完整大小和 SHA-256 后才发布目标文件，拒绝覆盖已有目标。

反向代理使用路径前缀时，Office MCP 和 `/artifacts/` 必须转发到同一 HTTP MCP 服务。命令行工具会保留 `/prefix/mcp` 的 `/prefix/`；自行集成的宿主也应保留此前缀，并设置足够的请求体积和传输超时。

## 身份与权限

| 范围 | 创建参数 | 可下载者 |
| --- | --- | --- |
| 角色私有 | `scope: role`，默认 | 当前绑定到上传角色的获授权宿主 |
| 指定接收者 | `scope: recipients` 和 `recipients` | 上传角色和明确列出的当前有效角色 |
| 办公室共享 | `scope: office` 和 `officeId` | 当前具有该办公室权限的角色，包含宿主工位/项目授权检查 |

消息附件最多八个不同编号，发送者和接收者都必须有读取权，且上传已完成。转发再次检查当前授权，不会给新收件人添加权限。私有文件发给其他角色会拒绝；应准备指定接收者或办公室范围的新制品。附件权限在创建时确定，不能原地扩大范围。

指定接收者许可独立于办公室成员资格。跨账户建立附件接收者范围还需要既有的人类角色通信授权；联系人授权用于准许建立共享范围，已经创建的明确接收者范围持续至到期或删除。退出办公室后不能继续下载办公室附件；原上传者仍可删除自己上传的版本。会议室焦点不改变制品归属；会议室对普通消息的发送限制仍然生效。

每个字节请求都检查 Bearer。宿主应同时携带其现有身份方式：

- 配置式连接：`X-MindPond-Identity: connection`。
- 原生逐聊天元数据：`X-MindPond-Meta` 为对应 MCP `_meta` 的小型 JSON。身份由宿主提供，不由模型挑选。
- 需要签名的宿主：使用现有 `signHostSession`，工具名 `office_artifact_transfer`、参数 `{method,artifactId}`，通过 `X-MindPond-Host-Context` 传输证明；绑定具体方法和制品。
- 纯 transport 连接身份：可携带同一 Bearer 与 `Mcp-Session-Id`；共享 transport 的逐聊天客户端仍须提供当前聊天元数据，不能沿用最后一次调用的角色。
- 已签发的角色专用凭据也可使用，仍检查有效连接和撤销状态。

连接编号或文件编号本身不提供访问权。共用宿主凭据的客户端属于同一信任边界，与现有 MCP 身份规则一致。不要把 Bearer、签名证明或文件内容发给模型，也不要把下载当作执行许可。

## 版本、限制和生命周期

每个 `artifactId` 就是一份不可变版本，固定文件名、MIME、大小、SHA-256 和权限范围。相同文件名可有不同编号；更改内容必须创建新版本，旧消息不会跟随新内容变化。服务不按哈希跨角色去重，也不暴露其他范围的文件是否存在。

| 设置 | 默认值 |
| --- | --- |
| `MINDPOND_ARTIFACT_MAX_FILE_BYTES` | 67108864，单文件64 MiB |
| `MINDPOND_ARTIFACT_MAX_TOTAL_BYTES` | 2147483648，单数据库2 GiB，包含上传预留 |
| `MINDPOND_ARTIFACT_RETENTION_SECONDS` | 2592000，30天，从预留时开始 |
| `MINDPOND_ARTIFACT_MAX_RETENTION_SECONDS` | 31536000，最长365天 |
| `MINDPOND_ARTIFACT_DIR` | 数据库完整路径追加 `.artifacts` |

大小配置必须是正整数，单文件上限不能超过总配额。每角色最多1024份有效记录、16份待上传预留；整个数据库最多四份正在上传。HTTP 进程同时最多八路文件传输，每次最长五分钟。首次上传须在预留后一小时内开始并完成；超时后的旧编号不重新激活。宿主可查询 `office_artifact list` 返回的实际限制。

同一角色的相同 prepare key 与相同规范化参数返回同一编号。改变内容、权限、保留期或文件名复用 key，会返回 `idempotency_conflict`。上传会逐字节统计大小和校验 SHA-256，失败的半文件不可读；同一编号并发上传只允许一个写入者。重试已完成的 PUT 仍校验字节，不能覆盖原版。

到期或删除后，新下载立即拒绝；已经获准并开始的下载可能完成。消息取走、处理完或归档不改变附件保留期。普通附件也不随临时会议关闭而删除；需要临时文件时选择较短保留期，或用完调用 `delete`。

服务每分钟运行一次分批清理，移除到期/删除版本的字节；办公室已删除或私有上传角色已删除的版本会过期。中断上传留下的孤立临时文件及提交失败留下的未引用文件，在无有效上传租约时分批清理；进程崩溃的上传租约最长约六分钟到期，过期尝试可由重试或下一轮清理回收。清理器只删除该数据库明确记录的文件路径，不扫描删除目录中的未知文件。跨进程上传租约使旧尝试不能覆盖新尝试。清理不复用文件编号，不删除原消息；保留小型元数据及幂等墓碑，防止延迟重试复活已删除内容。不要手动改写制品目录内的文件。

错误携带稳定原因和下一步，包括 `payload_too_large`（413）、`checksum_mismatch`（422）、`artifact_not_ready`（409）、`artifact_unavailable`（410）、权限或身份错误。下载不可见编号返回404；知道编号不能枚举文件元数据。MIME 为宿主声明，不是服务对文件格式或安全性的认证；接收宿主应核对哈希和适用的本地文件策略。

## 生产升级、备份与恢复

新增三张元数据表，以及 `role_messages.artifact_refs` 字段，启动时幂等创建；不改变现有消息、角色或记忆归属。所有共用数据库的进程升级到同一版本，并使用相同存储目录和限制配置。宿主重新连接以刷新工具目录。新增 CLI 使用既有依赖，离线环境无需补充新包。

**有附件时用整套备份。** 先停止共享该数据库的 Web、MCP、stdio 和维护写入者，等上传和清理退出。已有的网页备份和演练只检查数据库。

```sh
mindpond-maintenance --db /private/live/graph.db \
  --backup-set /private/backups/pond-20261105 --writers-stopped
mindpond-maintenance --verify-set /private/backups/pond-20261105
mindpond-maintenance --restore-set /private/backups/pond-20261105 \
  --to /private/rehearsal/pond-20261105
```

`--writers-stopped` 是操作者对停写的确认。跨节点停写和旧节点隔离由现有调度或部署工具保证。使用自定义制品目录时，备份命令加 `--artifact-dir /private/actual-artifacts`，也可用与运行服务一致的 `MINDPOND_ARTIFACT_DIR` 环境变量。备份和恢复目的目录都必须是未使用的新路径，父目录需预先存在。若源数据库位于已识别的网络文件系统，命令会拒绝打开。先按 [Farm 迁移步骤](deployment.md#farm-生产存储预检) 停写，将同一时点的数据库和 WAL 拷到本地盘，再用 `--artifact-dir` 指定对应附件位置。

备份从 SQLite 生成一致快照，按其中的已提交文件记录复制原始字节。每份文件都核对大小与 SHA-256。待上传记录及到期/删除的墓碑仍留在数据库里，未完成的上传字节和无关文件不会打包。备份输出清单的 SHA-256，另行记录该值，传输后核对。角色绑定及数据库内的授权数据随库保留，外部账户配置、宿主凭据、TLS 密钥和模型需独立保管。

恢复会校验数据库、清单和附件，写出新目录里的 `graph.db` 与 `graph.db.artifacts/`。测试时让隔离服务使用恢复副本，设置相同的数据库和制品路径，再用真实的授权连接核对附件下载。使用默认目录时让 `MINDPOND_ARTIFACT_DIR` 保持未设置。正式切换前先停写，并保留原位置以便回退。损坏、缺失、异常文件或路径已存在都会拒绝，普通失败清理本次输出。进程若被强制终止，遗留目录需检查后再清理或重跑。仅将验证通过的备份用于恢复。

POSIX 备份及恢复目录权限为 0700，文件为 0600。Windows 需通过私有目录 ACL 保证访问边界。附件和备份放在程序发布目录之外。

升级前没有附件时，原有数据库备份方式继续适用。程序回滚应同时恢复升级前数据库和对应文件快照。公开 GitHub 或 npm 包只发布源码与说明，不包含真实附件、数据库、凭据或备份。

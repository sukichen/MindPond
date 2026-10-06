# MindPond

跨 agent 的独立记忆系统。核心是**多个并行入口的涟漪搜索**，以及**保留原始情境依据的关联与整理**。

一条完整记忆正文可以放入多个独立空间。关联只连接同一空间、同一类型里的两个成员，并且能从任一端带出另一端。路径分数等于入口分数乘以沿途权重；直接命中的记忆互相平行。L0–L3 是内容层级，不是传播深度。

通过 HTTP、MCP 或 TypeScript 库接入。MindPond 的服务端不调用 LLM、不持有模型 key；宿主 agent 负责判断和生成，MindPond 负责存储、范围限制、版本校验和审计。

## 快速开始

```bash
npm ci
npm run build
npm start                  # 工作台与 HTTP API，默认 http://127.0.0.1:7903
npm run mcp                # MCP stdio，供宿主启动
npm run check              # 构建、契约、传播、整理与真实 HTTP/MCP 回归
```

新安装默认使用用户数据目录，HTTP/MCP 可共享该库；已有安装保留各自旧库，不自动迁移。共享既有库时显式设置相同的 MEMORY_DB_PATH。独立打包、可信身份与缺模型降级见 [独立安装与最小宿主](docs/standalone-installation.md)。Codex、Claude Code、OpenCode 的连接配置、移除与实际验收边界见 [客户端接入](docs/client-connections.md)。整理质量对照及独立评分见 [质量评估手册](docs/quality-evaluation.md)。公开验证范围和部署边界见 [部署指南](docs/deployment.md)。

服务根地址提供搜索、记忆库、人工整理、空间图谱和 action log。搜索直接调用 agent 使用的 GraphMemory.search，支持仅直接命中的对照、传播路径与逐段关联依据。高级参数与原始 JSON 可展开；详情支持正文编辑、关联理由、适用场景、逐条复核与停用/恢复。

## 中心账户与局域网

可由中心账户运行 `mindpond-mcp-http`，其它系统/工作账户使用各自凭据通过局域网接入。账户与机器/IP 解耦；支持多个账户共用个人域、独立 session 和项目空间。`mindpond-connect --remote-url ... --token-file ...` 可为 Codex、Claude Code、OpenCode 生成 stdio 桥接配置，客户端无需共享数据库或模型。部署、逻辑 session 和权限边界见 [网络 MCP](docs/network-mcp.md)。

## 默认维度与自定义

新库默认优先使用 `profile`（人物与偏好）、`commitment`（约定与目标）、`environment`（工具与环境）、`work`（项目与工作知识）、`practice`（方法与经验），缺省身份为 `work`。旧四维明确标为历史兼容，保留显式旧身份与旧计划重放；新知识优先使用这五个视角。定义、数量、颜色和提示词均可在工作台自定义，多个身份可以落在同一记忆上。项目使用 space，子主题使用 tags。已有数据库配置不会随升级覆盖，也不会自动迁移已有记忆。见 [维度与提示词](docs/custom-dimensions.md)。

## 给 agent 的标准提示词

- [首次连接提示](docs/memory-bootstrap-prompt.md)：初始化时给出检索、代码审查期间保存、阶段核对与信任边界；完整规则按需读取。
- [写入规范](docs/memory-save-prompt.md)：何时保存、如何形成完整且可复用的记忆、稳定分类、事实与不确定性、关联场景、提交前检查及完整示例。
- [整理规范 organization.v2](docs/memory-organization-prompt.md)：完整来源、条件保留、去重整合、关联依据和逐条复核。
- [生命周期捕获规则](docs/memory-lifecycle-prompt.md)：里程碑、压缩、结束和恢复；待处理发现原子保存在 session，保留项目与来源。
- [宿主生长规则](docs/memory-host-prompt.md)：工作期间的记忆检查、可靠捕获、整理恢复与来源复核。
- [跨 agent 生长契约](docs/host-growth-contract.md)：生命周期、接口字段与迁移边界；旧宿主专用章节按通用协议逐步迁移。
- [工作台与宿主接入](docs/workbench-and-host.md)：人工操作与 host 协作流程。

这些提示词直接从运行时代码和新安装默认配置导出；运行时以当前数据库的维度与自定义提示词为准。npm run check 会检查是否漂移。MCP 工具只保留简短规则，完整写入规范通过 memory_save_policy 按需读取。阶段改进可用 memory_finish 批量保存、修订与反馈；memory_directory / memory_event_search / memory_history 分别提供目录、原始场景和动作历史。HTTP 使用 GET /api/memory/save-policy。

一条记忆建议按“对象与范围 → 事实/决策/操作 → 条件与方法 → 结果与依据 → 例外与限制 → 来源与时间”组织。只写有依据的部分，也可以用包含相同信息的连贯段落；不强迫填满模板，不为固定字数省掉条件，也不把操作过程拆成大量碎片。

## 带情境的关联

保存关联必须同时记录：

| 字段 | 含义 |
| --- | --- |
| score / weight | 一起回想的潜在价值，范围 0–1；不是事实置信度 |
| reason | 为什么这两条记忆一起回想有帮助，以及观察依据 |
| context | 在什么任务、环境、对象/版本或时间条件下成立；包括已知例外 |

同一对记忆可以有多个场景依据，重复依据不会叠加权重。正文被编辑或整合后，原始依据保留并标记待复核；外部关联随整合迁移，权重取最大值，避免重复累加。来源内部的自关联归入历史记录。

整理者必须在原始场景下判断关系，不能因今天的任务不同而否定历史价值。逐条确认或停用依据；全部依据被停用后，这条边暂停传播，可以恢复。搜索返回 associationPath 及证据状态，让 agent 判断是否适用于当前问题。

**当前检索仍按静态权重传播**，场景适用性由宿主判断；这版没有宣称自动完成自然语言条件推理。设计、边界与模型质量评估方案见 [情境关联说明](docs/contextual-associations.md)。

## HTTP 示例

如设置 MEMORY_API_KEY，下列请求需添加 x-api-key 头。

```bash
# 多入口涟漪检索；maxDepth=0 可对照仅直接命中
curl -s localhost:7903/api/memory/search -H 'Content-Type: application/json' \
  -d '{"query":"本地调试端口","spaceId":"project-P","memoryType":"environment","maxDepth":2}'

# 保存完整正文；新接入应显式使用稳定的空间和类型
curl -s localhost:7903/api/memory/save -H 'Content-Type: application/json' \
  -d '{"content":"项目 P 本地开发服务监听 127.0.0.1:7903；远程访问通过代理。修改端口后同步核对启动脚本和代理目标，不直接开放公网监听。",
       "dimensions":["environment"],"source":"conversation","importance":5,"tags":["本地调试"],
       "memberships":[{"spaceId":"project-P","memoryType":"environment"}]}'

# 关联必须有理由和场景；成员 ID 必须来自实际读过的记忆
curl -s localhost:7903/api/memory/association -H 'Content-Type: application/json' \
  -d '{"memberAId":"<member-a>","memberBId":"<member-b>",
       "spaceId":"project-P","memoryType":"environment","weight":0.9,
       "reason":"代理曾因仍指向旧端口导致远程调试失败，两个配置需一起检查。",
       "context":"项目 P 本地开发与远程代理访问，修改本地端口后适用；不推断生产配置。"}'
```

也可以直接在 memory_save 的 related 数组中提交 membershipId、score、reason、context。无已读关联时省略 related；无效关联会拒绝整次写入，不留下孤立正文。内容最多 100000 字符，标签最多 16 个、每个 64 字符，空间放置最多 16 个；边界空格、重复标签与重复放置会被规范化。省略 memberships 只保留 legacy:<dimension> 的兼容行为。

memory_save 支持 idempotencyKey；同 key 同规范化请求返回原回执，改动请求会被拒绝。网络结果不确定时使用原请求和原 key 重试；无 key 时先核查。整理提交可用相同 jobId 和完全相同计划重试。

## 整理工作流

```text
memory_organization_claim     -> 不可变正文、成员版本、关联依据、完整 prompt
memory_organization_validate  -> 校验计划，预览替换和关联迁移
memory_organization_commit    -> 同一事务提交计划，返回可重试的 receipt
memory_organization_renew     -> 延长仍有效的租约
memory_organization_release   -> 放弃当前任务，让其他 agent 可继续整理
```

操作包括 keep、defer、associate、consolidate、synthesize。synthesize 形成或修订有来源支持的画像，保留所有细节成员，记录实际覆盖、未知范围、逐来源支持理由与版本。整合保留原正文和来源链，只替换当前空间中明确选中的成员，不影响同一本体的其他空间。不同 session 可见范围不能合并。正文或关联变化会使旧快照失效。

复核关联依据用 memory_association_review；HTTP 对应 POST /api/memory/association/review。复核会修改关联版本，已有整理任务应先完成/释放，或在复核后重新领取。

## 从知识形成画像

正常工作中先保存职责、约束、证据和未知范围等完整知识；整理时将互补材料合成为流程/子系统画像。支持关系独立于涟漪关联，可以逐层生长、多处复用，但不能跨空间、跨类型或成环。搜索命中画像后，用 memory_profile_get 按需展开依据，不增加隐藏的涟漪跳数。

sourceRefs 与 memory_source_observe 记录实际来源版本和内容指纹。来源或支持发生变化，相关上层画像进入 needs_review；没有核查依据则为 unknown。checked 只代表记录版本一致，不代表结论已经正确。人工工作台支持画像创建、修订历史、来源编辑、待复核召回筛选，以及宿主工作队列。

宿主用 memory_checkpoint 报告 saved/no_change/deferred，用带租约的 memory_work_* 领取、续期、完成或恢复整理。MCP 本身不会强制 agent 保存或启动维护，需要宿主接入生命周期事件。详见 [完整契约](docs/host-growth-contract.md)。

## 接口速查

| 用途 | MCP | HTTP |
| --- | --- | --- |
| 写入规范 | memory_save_policy | GET /api/memory/save-policy |
| 搜索 / 写入 | memory_search / memory_save | POST /api/memory/search、/save |
| 任务简报 / 使用反馈 | memory_brief / memory_use_report | POST /api/host/brief、/api/host/use-report |
| 正文 / 详情 | memory_get / memory_expand | GET /api/memory/node/:id；POST /api/memory/expand |
| 空间 / 放置 | memory_spaces / memory_membership_add | GET /api/memory/spaces；POST /api/memory/membership |
| 建立关联 | memory_association_upsert | POST /api/memory/association |
| 复核依据 | memory_association_review | POST /api/memory/association/review |
| 整理规则 | memory_organization_policy | GET /api/organization/policy |
| 整理流程 | memory_organization_* | POST /api/organization/claim、/validate、/commit、/renew、/release |
| 操作日志 | 通过 HTTP 查询 | GET /api/memory/actionlog |
| 原始导入 | memory_ingest | POST /api/memory/ingest（L0 + 抽取任务原子写入，支持幂等） |
| 宿主能力 | memory_capabilities | GET /api/host/capabilities |
| 画像与历史 | memory_profile_get / memory_profile_history | POST /api/memory/profile/get、/history |
| 来源观察 | memory_source_get / memory_source_observe | POST /api/memory/source/get、/observe |
| 检查点与恢复 | memory_checkpoint / memory_work_* | POST /api/host/checkpoint、/work/* |

历史 L1 抽取与 L2/L3 聚合接口仍可用；旧 scene/persona 自动聚合默认关闭，但不等同于替换式整理。旧 score-only 边复评现已暂缓，避免没有情境的 LLM 盲目降权。旧 weave 入口也要求理由与场景，不再把表面矛盾自动当作旧事实失效。

## 运行与架构

SQLite 存储本体、空间成员、无向关联、关联依据、持久整理快照/回执与 action log。混合检索使用本地 ONNX 向量和 FTS5/短查询文本回退；没有本地模型时降级为关键词检索，不自动下载模型。默认向量索引为精确余弦扫描，可选 HNSW 加速；多进程通过数据库 generation 刷新索引。模型、前缀、池化和实际文件版本使用独立向量空间，正文与锚点一起分批构建，完成后启用并保留回退。CPU 是默认执行设备，GPU 按配置尝试并报告实际设备。使用方法见 [可选向量模型与设备](docs/embedding-profiles.md)。

| 配置 | 默认 / 用途 |
| --- | --- |
| MEMORY_DB_PATH | 显式指定共享 SQLite 文件 |
| MEMORY_HOST / MEMORY_PORT | 127.0.0.1 / 7903 |
| MEMORY_API_KEY | 设置后 /api/* 要求 x-api-key |
| MEMORY_CORS_ORIGINS | 默认不开放跨域；可填写允许的 origin |
| EMBEDDING_MODEL_DIR | 本地 models 目录 |
| EMBEDDING_MODEL / EMBEDDING_DIMS | Xenova/all-MiniLM-L6-v2 / 384 |
| EMBEDDING_ZH_ENABLED | 默认关闭；可选中文向量通道 |
| MINDPOND_EMBEDDING_CONFIG | 模型 / 设备 / 索引 / 重排 JSON 配置路径；不设置保持原行为 |

spaceId 是检索隔离维度，不是认证或租户隔离。当前共享 API key / SQLite 的部署是受信任宿主协作模式，不能把它当作面向互不信任用户的完整多租户服务。

## 验证与产品边界

npm run check 覆盖规范化写入、上下文依据、复核停用/恢复、跨重启迁移、整理快照/幂等、空间与类型边界、涟漪传播及真实 HTTP/MCP 交互。所有测试使用临时数据库；有模型和无模型两种环境均可运行同一检查集。

- [架构与涟漪边界](docs/architecture.md)
- [验证与发布](docs/releasing.md)
- [情境关联与反馈迭代](docs/contextual-associations.md)
- [整理规范](docs/memory-organization-prompt.md)

自动化检查证明接口与内核行为，不能证明真实 LLM 的记忆质量已经达标。下一阶段需在固定召回/token 预算下验证多 agent 保存与反复整理的条件保留率、错误停用率、场景适用精确率与回答质量。

实时图谱：启动 HTTP 服务后访问 `/graph`，查看 agent 读写记忆的节点动画与正文卡片。渲染、权限和断线行为见 [实时空间图谱](docs/live-graph.md)。

用户可在工作台「维度与提示词」定义分类数量、含义、默认值、节点颜色和 agent 规则。原四维只是默认模板；详见 [自定义维度](docs/custom-dimensions.md)。

日常 MCP 工作连接与多 agent 能力边界见 [OpenCode 工作接入](docs/opencode-work-integration.md) 和 [架构说明](docs/architecture.md)。新连接默认精简 work 目录，完整保存规则按需读取。

最新机制与实际基线：[任务记忆循环](docs/task-memory-loop.md)。OpenCode 原生 session 接入见 [工作环境接入](docs/opencode-work-integration.md)。

生产部署及升级见 [部署与恢复流程](docs/deployment.md)。严格 HTTP 域认证默认拒绝匿名调用；使用 `/ready` 检查数据库完整性，`/health` 仅检查进程存活。数据库审计可运行 `mindpond-maintenance --db /absolute/graph.db --check`；修复前停止宿主写入并保留一致备份。

## 开源与许可

本项目采用 [MIT](LICENSE)。第三方代码、依赖和模型的许可各自独立，见 [第三方声明](THIRD_PARTY_NOTICES.md)。公开仓库只含程序、通用文档和合成测试夹具，不含用户记忆、运行日志、模型权重或私人评估报告。

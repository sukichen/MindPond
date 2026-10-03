# 跨 agent 记忆生长契约 v1

本契约对应 `memory_capabilities.version = mindpond.host.v1`、`organization.v2`、`memory-save.v2.3`、`domain-memory.v1` 和 `work-coordination.v1`。MindPond 提供持久状态和校验，宿主提供观察、LLM 判断与任务调度。完整模型指令见 [宿主提示词](memory-host-prompt.md)、[写入提示词](memory-save-prompt.md)、[整理提示词](memory-organization-prompt.md)。这些文件由源码生成，不能单独修改。

## Domain 是归属边界，不是图维度

每条记忆具有 `domain: {kind: session|personal|team, id}`。它与 `spaceId/memoryType` 正交：前者决定归属、生命周期与可读范围，后者决定独立涟漪图。默认读取 personal/default，外加宿主提供的当前 session；没有 sessionId 时绝不读取 session。关闭的 session 从搜索、列表、候选和任务板消失，只有恢复原 session 或显式 purge 才能处理它。

个人长期知识写入 personal/default；当前任务过程默认写入当前 session。team 是用户主动发布：宿主在真实用户事件中以私有 `MEMORY_TEAM_AUTH_SECRET` 签发短期 `teamAuthorization`，并随每次 team 语义写入传递。保存、编辑、删除、membership、association、association review/delete、team 整理提交和 team WorkContext 创建都会验证该 grant。签名密钥不得暴露给 LLM、MCP 或浏览器；MindPond 不替代团队身份和成员权限系统。

## 两种关系，分别承担职责

涟漪关联仍是同一 spaceId / memoryType 内的无向加权关系，必须保留 reason 和 context。一次查询的直接命中是多个并行入口，分数只沿各自路径相乘。

画像使用独立的有向支持关系：画像由哪些记忆、哪些版本、在什么条件下支持。它可以有多层，也允许同一记忆支持多个画像，但不能成环，不能跨空间、类型或 session 可见范围。画像和细节通常都属于 knowledge 类型；不要用不同类型表示上下级。画像层数与 L0–L3、涟漪跳数没有对应关系。

`synthesize` 保留有独立价值的来源；`consolidate` 处理真正的重复或应共同使用的冗余内容。搜索命中画像后，用 `memory_profile_get` 按需展开支持记忆；支持关系不自动参与涟漪传播。关联权重高、关键词相似、同属一个目录，都不能单独证明应建立上层画像。

## 宿主适配器的接入位置

| 宿主事件 | 必须执行的职责 | 失败处理 |
| --- | --- | --- |
| 一次工作开始 | 获取/缓存 capabilities，明确稳定空间与可见范围，按任务搜索；将提示词交给主 agent | 区分不可用与零命中，不声称已查无结果 |
| 收到/完成一条消息 | 如启用原始捕获，用宿主稳定 messageId 幂等摄取 | 将同一 ID 和完整原请求保存在宿主 outbox，恢复后重试 |
| 有可复用发现的里程碑 | 保存有内容、有条件、有依据的知识；报告 checkpoint | 不以存了几条代替质量判断；无新增可报告 no_change |
| 长任务 / 压缩前 / 任务结束 | 提供一次显式记忆检查机会 | 默认每 8 次非记忆工具调用检查，单轮最多 2 次中间检查；结束和压缩另检查 |
| 维护工作者启动 / 恢复 | claim host work → 找候选 → claim organization → LLM 提案 → validate → commit → finish | 默认一批 8 个成员、任务后 30 秒预算；超时 deferred；需要宿主持续排队调度 |
| 取消 / 进程崩溃 | 停止新 LLM 判断、保留已提交回执与本地待办 | 不补写“完成”；已领取工作到期后可由其他工作者接手 |
| 文件版本改变 | 报告实际观察的版本/指纹，再核查受影响知识和画像 | 只标记 needs_review，不自动判定旧知识为假 |

记忆工具和维护工作者自身的调用不计入检查触发器，防止递归自触发。runId、checkpointId、保存 ID 要持久化，不能在重试时重新生成。主任务的成功与记忆维护成功分开记录。

MCP 工具描述能指导模型，但不能拦截宿主生命周期、保证调用或唤醒模型。宿主需要在运行器中落实上述事件，并把三份规则注入主 agent 和整理工作者。MindPond 不接收宿主模型 key。

## 可移植接口

以下新增 HTTP 接口均支持 POST，返回值与同名 MCP 工具的 JSON **完全同形**，包括数组与 null；失败 HTTP 为非 2xx `{ok:false,error}`，MCP 为工具错误。旧接口保留既有包装，例如搜索 HTTP 为 `{ok,results}`、MCP 为数组。capabilities 同时支持 GET。

| MCP | HTTP | 关键输入 / 返回 |
| --- | --- | --- |
| memory_capabilities | /api/host/capabilities | 无输入；版本、features、hostPolicy、默认预算 |
| memory_organization_candidates | /api/organization/candidates | spaceId、memoryType、可选 query、limit 2–24；返回 candidates、leased:false |
| memory_profile_get | /api/memory/profile/get | membershipId，可选 offset、limit、sourceContext；返回完整画像、coverage、unknowns、freshness、分页 supports、parents |
| memory_profile_history | /api/memory/profile/history | membershipId；最近 100 个不可变修订，包含内容和来源版本 |
| memory_source_get | /api/memory/source/get | uri、context；无记录 version:0，否则当前版本和观察 |
| memory_source_observe | /api/memory/source/observe | uri、context、revision、可选 fingerprint、status、expectedVersion；返回 version、changed、affectedProfileIds |
| memory_checkpoint | /api/host/checkpoint | hostId、runId、checkpointId、spaceId、memoryType、outcome、reason、可选 memoryIds、requestOrganization；返回 workId 或 null |
| memory_work_claim | /api/host/work/claim | spaceId、memoryType；返回 id、leaseToken、leaseUntil、attempts、checkpoint，或 null |
| memory_work_renew | /api/host/work/renew | workId、leaseToken；续期 5 分钟 |
| memory_work_finish | /api/host/work/finish | workId、leaseToken、outcome、reason，可选 organizationJobId；返回 status |
| memory_work_list | /api/host/work/list | spaceId、memoryType；最新 100 项，包含 status、attempts、payload、receipt，不暴露租约令牌 |
| memory_work_retry | /api/host/work/retry | workId、reason；仅允许人工/宿主明确重试 failed 工作 |
| memory_session_state | /api/session/state | sessionId、active/paused/closed；关闭后退出正常读取 |
| memory_session_purge | /api/session/purge | sessionId；只允许关闭后的显式永久清理 |
| work_context_create/list | /api/work/context/create、/list | domain、目标、参与者；协作状态，不写入知识图 |
| work_task_create/list/claim/transition | /api/work/task/* | 显式 domains、依赖、租约、revision、提交与验收；不能访问关闭 session 的任务 |

TypeScript 使用 `pond.graph` 的对应方法，例如 `saveMemory`、`getProfile`、`observeSource`、`checkpoint`、`claimHostWork`、`finishHostWork`、`claimOrganizationJob`、`commitOrganizationPlan`。`pond.search` 支持 spaceId、memoryType、sourceContext；`pond.update` 支持 sourceRefs 与 expectedUpdatedAt，原子更新。

### 保存与来源

```json
{
  "content": "对象：某项目提交路径。已观察：入口完成参数验证后才写入队列。条件：本次审查的版本与正常入参路径。未验证：队列写入失败后的恢复行为。",
  "domain": {"kind":"personal","id":"default"},
  "memberships": [{"spaceId":"project/runtime","memoryType":"knowledge"}],
  "sourceRefs": [{"uri":"repo:project/src/entry.ts","context":"checkout/main","revision":"实际提交或快照 ID","fingerprint":"实际文件 SHA-256","locator":"实际函数名或行范围"}],
  "idempotencyKey": "host/run/observation-1"
}
```

示例里的项目、版本、指纹和 ID 都需要用实际值替换。sourceRefs 最多 64 项；uri 稳定标识源文件/文档，context 区分 checkout/ref，revision 标识实际快照；locator 只用于定位，不单独充当版本。建议用文件内容指纹，避免同仓库其他文件的提交让所有知识失效。

`memory_save` 的同 key 同规范化请求返回原回执，不同请求报 idempotency_conflict。默认字段在 HTTP/MCP 之间一致。回执不会因后来编辑或删除而改写，也不会复活已删除记忆。无 key 的保存不保证幂等。

`memory_ingest` 使用 transcript、可选 sessionId 和 idempotencyKey，将 L0 与抽取任务放在同一事务，返回 l0Id、extractionJobId。抽取提交携带 expectedAttempt=job.attempts；结果、来源关系与回执原子提交。精确重试返回原回执，旧租约晚到响应不能写入新一轮任务。首次领取省略 expectedAttempt 兼容为 1，重领后必须显式提供。由宿主完成抽取。库调用 `graph.saveMessage(sessionId,content,role,messageId)` 也按 session + messageId 幂等；无 messageId 仅有旧的短时间内容去重，不能作为可靠捕获方式。不要同时让多个捕获通道用不同身份写同一消息。

### 形成和修订画像

先领取同空间、同类型成员的 organization job，再提交如下操作。所有 ID 必须来自 `job.members`。

```json
{
  "operations": [{
    "kind": "synthesize",
    "membershipIds": ["来源成员 A", "来源成员 B"],
    "content": "根据这两个来源形成的完整流程认识，保留限制和未知范围。",
    "profile": {"title":"提交路径画像","coverage":["已审查的入口与队列写入路径"],"unknowns":["失败恢复尚未验证"]},
    "supports": [
      {"membershipId":"来源成员 A","claim":"支持入口约束的描述","context":"实际审查版本与适用条件"},
      {"membershipId":"来源成员 B","claim":"支持队列写入行为的描述","context":"同一审查快照；恢复行为未知"}
    ],
    "reason": "两个来源共同解释提交流程，单独的细节仍应保留。"
  }]
}
```

修订时额外传 targetMembershipId，并把目标作为单独成员一起领取；至少还需两个来源。提交完整正文和完整支持集合。快照的 profileDetails 保留当前支持依据，避免盲目重写。引用但未领取的支持只可作为阅读上下文，不能直接作为修改源。移除支持时说明理由并调整 coverage；历史保留。

同一本体若有多个活跃空间成员，不能通过修订一个画像悄悄改写其他空间；此时创建新的独立画像。新建回执使用 createdMemoryIds，修订使用 updatedMemoryIds。支持子项保留并且可以继续单独被搜索。

### 新鲜度与复核

- `unknown`：尚无来源观察，或某个来源分支没有可核查依据。
- `checked`：支持链的版本与已记录来源观察一致，**不代表语义正确或测试通过**。
- `needs_review`：来源变更/消失、支持成员被编辑/替换/删除，或画像正文绕过 synthesis 被修改。

source_observe 的 expectedVersion 来自 source_get；冲突后先重新读和实际核查，不要机械换版本覆盖其他 agent。相同观察可安全重试。两个 fingerprint 都存在时按指纹判断，否则按 revision；不同 context 互不覆盖。搜索/展开传 sourceContext 时按指定 checkout 的观察核对，缺失则 unknown。

变化会沿支持链影响上层画像；普通涟漪关联仍按其原始情境独立复核。先重读代码、更新具体知识及 sourceRefs（要求 expectedUpdatedAt），再从下向上修订相关画像。单改时间戳或来源字段不能让已过期画像重新有效。affectedProfileIds 返回原始 sourceRefs context 对应的影响范围，其他 context 的按需 freshness 检查独立计算。

### 工作与整理是两种租约

host_work 表示某次 checkpoint 带来的维护义务；organization job 锁定一批供 LLM 判断的具体材料。两者分别续期和完成。checkpoint 默认 saved/deferred 入队，no_change 不入队，可显式 requestOrganization 覆盖。saved 必须引用当前范围的有效 memoryIds。

work_finish 的 completed 必须引用同范围已提交的 organizationJobId；no_change 允许诚实报告无可执行变更。deferred 延后 60 秒，最多 5 次领取，耗尽后 failed；崩溃租约同样有限重试。failed 只有显式 retry 才重新安排。旧工作者不能用过期/被替换的 leaseToken 完成新工作者的任务。同一次完成请求可精确重试。

工作完成回执验证已提交任务存在，但不评判它是否充分解决 checkpoint；宿主仍需审计对应关系与语义质量。源观察、成员和画像变化会保守地使现有 organization 快照失效，包括无关变化；遇到 stale_snapshot 释放并重新领取。当前采用安全保守策略，后续可在真实负载证明有必要时缩小失效范围。

## 操作台与兼容性

工作台可人工形成/修订画像、填写逐来源支持理由、查看上层画像和修订历史、编辑结构化来源、查看/重试失败的宿主工作，以及筛选 action log。搜索显示新鲜度，并可只显示本次召回中待复核的结果；这不是全库待办列表。

SQLite 初始化增加新表和触发器；旧数据保留，缺来源的旧知识为 unknown。升级前复制数据库（WAL 模式使用 SQLite backup，不能只复制正在写入的主文件）。旧 scene/persona 自动聚合默认关闭；显式旧 consolidate/聚合接口仍是兼容配方，不用于通用画像。注入 LLM 的 programmatic extract 与 HTTP/MCP 共用持久抽取队列；每次最多处理 maxL0BatchSize 个任务，更多积压需宿主继续调度。抽取不再自动启动 LLM 整理，整理走明确的宿主工作和预算。

单 API key / SQLite 仍面向受信任宿主协作。spaceId 不承担用户授权。图的依赖检查有 1000 个成员的保护预算，超预算返回 unknown 并带原因；不是无限规模或分布式调度的承诺。

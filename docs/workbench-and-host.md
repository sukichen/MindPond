# MindPond 工作台与主 agent 接入

> 新的宿主生长协议与非破坏画像扩展见 [host-growth-contract.md](host-growth-contract.md)。本文保留已有工作台/整理基础契约；版本以运行时 capabilities 和导出提示词为准。

打开运行中的 MindPond 服务根地址（默认 http://127.0.0.1:7903）。代码变更后需重新运行 npm run build 并重启该服务。已有 API key 的部署，在工作台右上角输入同一个服务密钥；页面不会持久保存它。

关联的场景依据、迁移与逐条复核见 [contextual-associations.md](contextual-associations.md)。

## 用户工作台

- **搜索记忆**：调用 POST /api/memory/search，正文、评分、结果顺序与 agent 共用 GraphMemory.search。可以设置空间、类型、会话、返回条数、最低得分、深度与 L0。深度 0 是相同查询的直接检索；开启对照可同时比较。路径逐点可点击展开，不依赖图谱已加载的节点集合。score 是混合检索得分，可能大于 1，不是概率。
- **记忆库**：分页查看活跃成员或整合来源；新增记忆，编辑正文、重要度、标签。正文编辑影响同一本体在所有空间中的成员；保存检查打开时的版本以避免覆盖其他编辑。原子编辑会记录前后内容。
- **人工整理**：先筛选到一个空间、类型，勾选 2–24 条记忆后进入整理，或自动领取一批未复查/较久未复查成员。人工填写完整结果及说明，预览后提交。可选择整合、建立双向关联、保持原样或暂缓。未选来源不变。需要更长编辑时间时续期；离开任务前可释放。
- **关联管理**：详情页展示参与涟漪的真实无向关联，可补充理由与适用场景、调整权重、逐条确认/停用/恢复依据、移除关系、查看对端正文；创建关联通过人工整理选择恰好两条来源完成。
- **空间图谱**：使用空间成员作为节点；同一本体在不同空间分别展示，不用一条节点跨空间串边。显示范围内的真实无向关联。图谱最多加载最近 500 条本体，并标出截断数量。
- **操作日志**：按操作类型、记忆或成员 ID 筛选，游标加载更早记录。展开查看编辑前后内容、整理来源、理由与关联变更。删除了的记忆仍有日志；查看其正文会明确显示已找不到。
- **与 agent 协作**：整理页可复制完整任务给主 agent，导入主 agent 返回的计划 JSON，使用相同校验和预览提交。工作台本身不调用 LLM。

## 给主 agent 的接入提示词

你正在使用 MindPond 的跨 agent 记忆服务。

1. 调用 memory_spaces 找到与当前任务相关的 spaceId、memoryType。空间与类型约束要由调用者明确维护；不要为建边而随意复制或混合空间。
2. 日常检索用 memory_search。多个直接命中分别是涟漪入口，score 乘路径权重得到关联带出得分。需要原文时 memory_get；不要把结果数或分数当成事实可信度。
3. 写入用 memory_save，related 每项必须包括 score、reason（具体共同召回价值及观察依据）、context（脱离当前对话可理解的适用场景、条件与例外），以及实际读过的目标 ID。不因相同主题建边。详细规则取 GET /api/memory/save-policy 或 memory_organization_policy.savePolicy。
4. 记忆整理用 memory_organization_claim。可传 membershipIds 精确选择材料；否则按范围领取轮转批次。完整回复包含 job、policy、prompt。把 prompt 交给你自己的推理过程或模型，不向 MindPond 发送模型 key。
4. 只引用 job.members[].membership.id，不能用 memory.id 冒充成员 ID。阅读完整正文、来源、条件、否定、版本、数值和例外。重复信息用 consolidate 生成规范正文；互补且共同使用的信息可整合。仅同主题不合并，关联用 associate。不确定用 defer。
5. 输出格式严格遵从 policy.operations 与工具 schema。返回 {"operations":[...]}；不要调用旧 memory_dedupe_resolve 删除有独有信息或多空间成员的本体。
6. 调用 memory_organization_validate(jobId, plan)，检查替换范围、待迁移或归档的关联及警告。模型自己写的“信息已保留”不是事实验证；逐项核对正文。如果不适合整合，改 keep/defer 或释放任务。
7. 在租约有效期间调用 memory_organization_commit(jobId, plan)。相同 job 与完全相同计划可安全重试以取回 receipt；不重复生成新 job 来重试已经完成的提交。
8. 推理较久时先 memory_organization_renew；失败或不再使用时 memory_organization_release。收到 stale_snapshot 后重新领取并重读材料，不复用旧正文。
10. 整合后外部关联和原始依据迁移到新成员，标记待复核。读完双方完整正文后，通过 memory_association_review 逐条确认；只在明确失效时停用。原始场景缺失不等于无关。其他空间成员与来源记录保持可追溯。

HTTP 同名流程：/api/memory/spaces、/api/organization/policy、/claim、/validate、/renew、/release、/commit；操作 schema 和示例见 memory-organization-contract.md。

## 验证

- npm run verify:context：多场景依据、版本复核、关联迁移、停用与恢复传播。
- npm run verify:workbench：不可变快照、编辑版本、排他领取、预览不写入、坏计划/重叠替换拒绝、同请求重试、来源/其他空间保留、重启与日志游标。
- npm run verify:agent-api：启动独立临时 HTTP 和真实 MCP 进程，对照同一搜索请求，跨进程领取、预览、提交与重试，验证 API key 和静态页面。
- npm run verify:space-ripple、npm run eval:ripple、npm run smoke：图传播和已有功能回归。

所有自动化测试使用临时 SQLite。它们验证接口与系统行为，不代表真实 LLM 的语义整理质量已经达标。

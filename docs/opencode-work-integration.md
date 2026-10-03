# 在工作环境接入 OpenCode

MindPond 核心保持通用和无内置 LLM。标准 MCP 提供显式工具；独立 OpenCode 文件插件负责绑定真实 session、准备阶段信息和压缩前的公开场景捕获。

## 原生模式（新工作接入）

```sh
mindpond-connect prepare --client opencode \
  --directory /absolute/connections/work \
  --db /absolute/work-memory/mindpond.db --personal work --native
mindpond-connect inspect --directory /absolute/connections/work
# 在实际源码项目目录启动，配置与既有 inline 配置合并：
mindpond-connect run --directory /absolute/connections/work
```

省略 --session 时默认使用此模式；--native 是显式声明。源码 checkout 未加入 PATH 时，把 mindpond-connect 替换成 node /absolute/mindpond/dist/connect.js。需要禁用公开正文捕获时，prepare 加 --no-capture。

生成目录包括 opencode.json、mindpond-plugin.mjs、instructions.md 和校验 manifest，不修改全局客户端配置。DB 必须在可移除连接目录之外。生成插件导入本安装的编译产物，安装位置移动后应生成新连接目录。

原生插件取 OpenCode 实际 sessionID，映射为带工作空间前缀的 MindPond session。共享 personal/work 供跨 agent 长期读取；session 原文只供同一 active/paused session。模型不能填写 native 工具的 session/domain 参数；高级 memory_action 只能缩小宿主绑定，不能获取 operator 或擅自发表 team 记忆。

工具核心入口：memory_brief、memory_directory、memory_search、memory_event_search、memory_get、memory_trace、memory_history、memory_save_policy、memory_finish。小批整理、提取、画像、来源和协作接口通过 memory_action 的 canonical name 调用，先读 memory_protocol_rules / memory_capabilities。memory_capabilities 的 hostConnection 标明 native 绑定。用户配置维度应通过 memory_dimension_policy 读取，不假定固定四类。

chat.message 自动准备有预算的候选，system transform 注入候选和短规则。候选注入不算采用。idle / before_compact 只保存公开 user/assistant text；reasoning、工具输出、合成消息、压缩摘要不自动保存。长消息完整分块，常见凭据模式先遮盖；这不是通用秘密识别器，可按工作环境使用 --no-capture。

未交付场景先进入 DB 同目录的私有 .mindpond-opencode-outbox；收到 L0+extraction 回执后移除正文并留小确认记录。压缩摘要、工具结果和消息 stream delta 不当作新长期知识。模型整理须由宿主执行；调用接口成功只证明保存/队列状态，不证明语义整理完成。

idle 保持 session active。显式删除产生持久关闭标记；关闭失败后重试先恢复 pending capture/关闭，再允许读取，不会在重启后自动重新激活旧 session。一次 Node worker 共享一个 DB/索引，同 session 的捕获与关闭串行；不同 session 仍由核心域规则隔离。

## 静态 MCP 模式（兼容已有接入）

```sh
mindpond-connect prepare --client opencode \
  --directory /absolute/connections/work-review-001 \
  --db /absolute/work-memory/mindpond.db \
  --personal work --session work-review-001 --tools work
mindpond-connect run --directory /absolute/connections/work-review-001 -- mcp list
```

显式 --session 且未选 --native 保留静态 MCP。宿主提供的是逻辑 ID；它不会被自动替换成 OpenCode 原生 ID。这种模式需要 agent/宿主显式调用 lifecycle_prepare 和 session_state，MCP 不会自动拦截压缩或删除。

新 prepare 默认 work 工具目录，批量 request 和旧维护流程使用另一条 --tools full 连接；full 不增加 operator 权限。原生模式默认禁用这条静态 MCP，避免一套工具误用静态 session；需要静态管理连接时应使用独立受限目录。

## 保存和多 agent 工作

多轮排障、源码认识、纠错和意图澄清后检查是否有值得保存的增量。读取完整 memory_save_policy，保留条件、观察、推断和未知事项。有用的未验证解释与失败路径可以长期保存；不要把 transient 进度或每条工具日志放入 personal。

memory_finish 一次可以保存、带 expectedUpdatedAt 修订、报告实际采用；每项独立回执，部分失败不会丢弃成功项。精确重试保持 stageId 和完整载荷；修复失败项用新 stageId，避免重新创建成功记忆。native runtime 自动填 hostId/runId，模型不自造身份。

多个 agent 可以共享同一长期 DB 和 personal ID，同时使用各自 session；共享任务使用 work_context/task，租约、提交与验收证据独立于记忆。它是协作约定，不能隔离恶意的同权限本地进程。只读角色应在 OpenCode permission 中限制写工具，并防止绕过 memory_action；工具名称权限与其内部 operation 都需要宿主正确管理。

跨机器不直接共享普通网络盘上的 SQLite。当前 HTTP 是 REST，不是 remote MCP；可信服务部署、团队身份和授权仍由宿主负责。

## 验证与观察

目标环境应验证插件加载、消息召回和删除事件的 session 关闭。verify:opencode-native 还覆盖真实 Node worker/SQLite 的 outbox 恢复、压缩前捕获、隔离、遮盖和幂等。实验钩子仍需随 OpenCode 版本回归。OpenCode 首次启动可能安装自己的插件 SDK；可复用实际安装缓存，不能用 --pure 验插件（--pure 会禁用外部插件）。

首周使用真实环境问题、代码任务、用户纠正和并行任务观察：是否减少重复探索，来源变化是否复核，纠错是否改原记忆，原始场景能否找回，任务过期/取消是否正确恢复。通过 action log、recallId、使用报告与修订留痕；未反馈是未评估，调用次数不是正确率。

流程和验证边界见 [任务记忆循环](task-memory-loop.md)。官方参考：[插件](https://opencode.ai/docs/plugins/)、[MCP](https://opencode.ai/docs/mcp-servers/)、[配置](https://opencode.ai/docs/config/)、[agents](https://opencode.ai/docs/agents/)。

高级原生操作通过 memory_action 按需发现：先调用 tool:"memory_capabilities" 获取允许名称，再用 tool:"work_task_create"（或整理工具名称）、describe:true 读取一个真实参数 schema；该调用不执行写入，不把全目录常驻注入。

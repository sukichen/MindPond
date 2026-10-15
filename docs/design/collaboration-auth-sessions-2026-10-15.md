# HTTP MCP 接入、凭据与会话角色设计

实现进度：HTTP MCP 独立身份、显式工作会话/受限分工、MCP 内指南、项目与办公室、定向问答、负责权移交、文本包、精确轮次验收及前端向导已实现，参见[当前使用说明](../collaboration-offices.md)。以下保留原设计与完整验收目标；OAuth、浏览器 SSE 观察及各实际宿主的逐聊天隔离验收不作为已完成能力。

日期：2026-10-15。状态：设计提案，尚未实现。补充[任务办公室方案](collaboration-office-2026-10-15.md)。本文的新注册、会话、角色、OAuth 和引导接口不能当作当前版本已具备的能力。

## 1. 先回答：谁持有 token，谁知道自己的身份

**用户授权接入，宿主 MCP 客户端持有凭据，MindPond 认证身份，模型只看到身份结果和工作上下文。**

```text
用户在管理页面注册 Codex 并授权协作项目
  → 用户在 Codex 的 MCP 设置中完成凭据配置
  → Codex MCP 客户端自动为 HTTP 请求附加认证
  → MindPond 从凭据得到可信账户和 agent 身份
  → 模型调用 bootstrap / session 工具，得到不含秘密的角色与任务
```

LLM 不负责领取、保存、复制或选择 token。不提供 `get_token` 工具，不将 token 放入 instructions、工具参数、URL、启动提示词、协作材料或动作日志。认证发生在普通 MCP 工具调用之前，不能依赖模型先调用一个未认证工具领取认证凭据。

当前 v1 只有静态 Bearer，grant 绑定 principal，且同 principal 只能有一个 grant；尚不能表达本文的独立 agent 和多角色会话。实现时先升级服务端身份模型，不靠客户端昵称模拟权限。

## 2. 页面接入流程

1. 用户添加注册 agent，例如“我的 Codex”，选择所属账户和允许参与的项目。
2. 页面询问宿主类型及版本，展示已验证的原生 HTTP MCP 配置；没有原生 HTTP 的客户端明确不支持，不生成 stdio 桥。
3. 用户在宿主凭据设置中授权。推荐路径是宿主支持的 OAuth 登录/安全凭据存储；MindPond OAuth 服务本身属于后续实现。静态 token 路径由用户配置秘密来源，模板只引用秘密名称。
4. 页面分别显示“认证成功”“MCP 初始化成功”“协作身份已发现”。仅创建数据库记录或下载配置不算接入成功。
5. 用户为某段工作会话安排办公室和角色，生成只含公开编号的启动提示词。模型通过 MCP 校验并领取这个分工。

静态凭据只展示给管理用户一次；未保存则撤销并重发。服务端仅保存摘要，日志和诊断脱敏。轮换可有短暂明确的重叠窗口，旧凭据最终撤销；撤销同时影响既有连接和悬挂等待，不只阻止下次初始化。

### Codex 的具体配置示例

以下是宿主配置示例，不是发给模型的提示词，不含真实秘密：

```toml
[mcp_servers.mindpond]
url = "https://memory.example/mcp"
bearer_token_env_var = "MINDPOND_CODEX_TOKEN"
```

由用户或宿主的秘密配置系统设置这个环境变量；`bearer_token_env_var` 只告诉 Codex 去哪里读取，配置文件不会凭空创建它。缺失时接入向导应提示用户修复宿主认证配置，不能让模型去 shell 查找 key。地址由部署实例生成；示例域名不可直接使用。

Codex 官方支持 Streamable HTTP MCP、Bearer 环境变量引用以及服务端支持时的 OAuth 登录；初始化 instructions 也会被提供给 Codex。[官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)，[配置字段参考](https://learn.chatgpt.com/docs/config-file/config-reference)。实施验收必须记录实际宿主版本，不能把 Codex 的配置语法直接发给其它宿主。

**环境变量引用不等于完全秘密隔离。** 若 agent 的 shell 继承该环境，或能读取同一用户下的秘密文件，模型仍可能经工具访问它。0600 文件和“不要读”提示词不能防住同权限进程。优先使用宿主凭据管理，并验证秘密不会暴露到模型工具执行环境；需要强隔离时，认证传输组件和 agent 工具环境必须有真实权限边界。即使采用 OAuth，也要检查凭据存储与工具可读范围。

不要求普通用户掌握这些细节：页面以“推荐的宿主授权”“静态凭据高级配置”呈现，并按实际能力标注“凭据保存在宿主，是否与工具环境隔离已验证/未验证”。不能无依据宣称绝对安全。

## 3. Agent 与工作会话必须分开

| 对象 | 含义 | 生命周期 |
|---|---|---|
| Account / principal | 用户的授权与数据归属 | 长期 |
| RegisteredAgent | 一个可管理、可撤销的宿主接入身份，例如“我的 Codex” | 长期 |
| Credential | 对该 agent 或其受限分工的认证凭据 | 可轮换/撤销 |
| Connection | 一次 MCP 传输连接 | 可重连，不决定聊天身份 |
| WorkSession | 一段明确分开的工作上下文，例如“Codex 会话 A” | 可恢复，有结束状态 |
| RoleAssignment / seat | 某工作会话在某办公室的分工及权限 | 有修订号，可撤销/转移 |

“Codex·开发”是页面中 **Codex + 会话 A + 开发分工** 的组合显示；同一 Codex 可同时出现“会话 B·验收”。角色不是整个 agent 的一个可变全局字段，禁止 `agent.currentRole` / `currentOffice` 这种后写覆盖先写的设计。

办公室工位对应具体工作会话和分工。两个工位可属于同一注册 agent，以关联标识显示；工位上的文件访问报告也绑定本次会话/运行，不能因同属 Codex 就认定读取同一目录。

### MCP 连接不能替代聊天会话

MCP 的 `Mcp-Session-Id` 是协议会话标识，不能自动当作宿主聊天 ID。[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。由此推论：宿主可能复用连接，也可能在一次聊天中重连，MindPond 不能仅靠连接或 `clientInfo` 自动识别聊天及角色。

已有 `x-mindpond-session` 可以帮助宿主声明逻辑范围，但只有客户端确实提供独立、稳定的值时才有意义；静态全局 header 不会自动变成逐聊天标识。模型填写的角色或 sessionId 都不能成为新的授权依据。

## 4. 两种绑定保证，不能混为一谈

### 4.1 通用模式：显式工作上下文

面向只有标准 HTTP MCP 的宿主，不要求插件：

1. 用户在页面给办公室中的一个分工授权可用 agent，并生成 `assignmentId`。
2. 用户把无秘密的启动提示词发给目标聊天；模型调用候选 `work_session_open`，提交这个分工编号和可选恢复编号。
3. 服务端依据已认证 agent、用户预先授权的分工和当前修订号校验，建立/恢复 `workSessionId`。返回实际角色、可做操作和下一步。
4. 后续协作调用显式携带 `workSessionId` / `assignmentId`。响应重复简短身份徽标，防止模型在长上下文中忘记。
5. 上下文压缩后可重新 bootstrap 查询；若存在多份候选且无法确定当前聊天是哪一个，应返回 `context_required`，让用户选择，不恢复“最后活跃的角色”。

这些编号**不是秘密，也不是凭据**；仅有编号不能越过账户/agent/分工授权。模型不能通过填写 `role:"reviewer"` 获得验收权。

此模式能避免正常工作的会话混淆，但同一个广泛授权的 credential 可能有权选择该 agent 的多个分工，因此不能声称阻止同凭据的另一聊天故意选择它们。页面明确标注“显式上下文绑定”，不要称其为安全隔离或独立评审。

### 4.2 隔离模式：分工受限的接入身份

需要开发/独立验收互相不可冒用时，为不同分工使用受限 credential 或独立接入 agent；宿主只向对应聊天/进程暴露相应 MCP 连接。它们可以归属同一账户，在页面归组显示。

服务端将 credential 限制到对应分工/办公室，任何工具参数都不能扩大范围。若客户端支持可靠的逐聊天绑定，可将它作为额外约束；不能仅因请求带一个可任意填写的 header 就认定可信。

如果宿主不能给不同聊天分开配置连接，可用分别配置的宿主实例/进程。**如果两个聊天都看得到两套接入，仍不算隔离。** 同一模型承担开发和验证也不因此具有方法上的独立性，页面应如实显示。

不承诺所有宿主都能“配置一次后自动识别所有聊天角色”。接入向导必须展示该客户端已验证的等级：原生 HTTP / 显式工作上下文 / 逐会话受限接入。后两个等级不能用 SDK 测试替代真实客户端验证。

## 5. 只有 MCP、没有本地文档时怎么学会使用

协议必须在 MCP 自身可发现，不能要求读取 MindPond 安装目录、AGENTS.md 或某个本地文件。

- `initialize.instructions`：前部自包含的短规则，说明任务开始先 bootstrap、按服务端身份操作、不传 token、通过 MCP 发送自包含材料、需要回复则等待匹配结果。普通记忆能力仍保留简短入口，避免协作规则淹没它。
- `tools/list`：核心工具描述写清触发条件和关键错误处理，而不是只有工具名。
- 候选 `work_bootstrap`：一个调用返回认证身份、协议能力、当前可确认的会话/分工、办公室和未读摘要。多个候选只要求选择，不猜。
- 候选 `work_guide_get(section)`：按需返回当前版本的完整规则/字段与示例，**正文直接在 MCP 响应中**。MCP resources 可以作为补充，不能成为唯一入口，因为部分宿主不将 resources 提供给模型。
- 业务结果附短 `nextAction`：告诉模型当前应该取材料、补充证据、续租、提交还是等待。返回结果中不夹带隐式授权，也不把协作正文当可信系统指令。

bootstrap 的候选响应形状：

```json
{
  "protocolVersion": 2,
  "identity": {"principal": "account-a", "agentId": "ag_codex"},
  "context": {
    "workSessionId": "ws_a",
    "officeId": "office_login_fix",
    "assignmentId": "seat_development",
    "bindingRevision": 3,
    "role": "worker",
    "bindingMode": "explicit_context"
  },
  "allowedActions": ["read_material", "submit_iteration", "wait"],
  "nextAction": {"action": "read_inbox", "reason": "有一条待处理的复现报告"}
}
```

示例所有 ID 均为非秘密定位符；实际身份和权限由服务端计算。没有确定上下文时 `context` 应为 null，并返回经授权过滤的选择，而不是返回示例里的默认开发身份。

给模型的启动提示词可以仅为：

> 使用已配置的 MindPond MCP，先 bootstrap 确认身份。在办公室 office_login_fix 领取我已分配给你的 seat_development，建立本聊天的工作上下文。后续调用始终使用服务端返回的会话和分工编号；不要切换到其它会话的角色。按 MCP 返回的指南、材料和下一步执行；需要验收时发出匹配本轮版本的请求并等待回复。若身份或分工不匹配，报告问题，不寻找凭据或自行提升权限。

向导直接生成实际公开编号；用户不必自己抄内部字段。模型上下文里可以出现身份、分工和公开编号，不能出现认证秘密。

## 6. 路由、租约、记忆及角色变更

- 消息指定目标分工/工作会话；尚未启动的分工有持久收件箱。发给整个 agent 的通知与发给具体工位的任务必须不同，不让两个角色争抢同一条待验收消息。
- ack、request/reply、等待、幂等回执、材料读取回执、租约和提交均绑定真实 agent + 工作会话 + 分工修订。不同分工使用相同客户端幂等 key 不能命中对方回执。
- actor 由服务端从 credential 和有效分工计算；传入的 actor/name/role 不能决定发送者。审计保留用户、agent、会话、分工、连接和凭据 ID，不保存秘密。
- 角色撤销/转移在事务内更新 bindingRevision / assignmentEpoch，fence 旧租约；旧等待被终止或返回明确上下文失效。历史事件不改署名，新连接不能拿旧回执复活权限。
- session 记忆与协作分工是不同概念。可用可信 principal + agentId + 稳定逻辑会话建立默认隔离；逻辑范围只缩小 credential 允许的权限。不能使用 officeId 自动合并所有人的临时记忆。
- 旧 principal/session 命名空间迁移要明确映射，保留读取与恢复入口，不能一次升级让既有 session 记忆失联，或意外跨 agent 共享。memory 工具也必须遵守同一可信上下文规则，不能只改 work 工具。
- 重连可恢复同一工作会话，不把新 transport sessionId 当新角色；结束工作会话不会自动撤销长期 agent，但不再接受新的会话业务提交。

## 7. 落地顺序与新增验收

先实现多 agent grants/registry 与服务端可信上下文，再做 WorkSession/RoleAssignment 和 bootstrap/guide，随后联动所有路由及 memory 上下文，最后做向导、办公室工位和实际宿主验证。OAuth 独立验收，静态凭据阶段也必须能完整接入；页面不提前展示未实现的 OAuth 登录按钮。

| 用例 | 必须保证 |
|---|---|
| 相同账户的两个 agent | 权限、收件箱、回执、撤销与日志归因独立 |
| 同一 agent 的两个不同角色聊天并发 | 没有全局 currentRole 覆盖，消息和租约按分工定位 |
| 两聊天共用一条 MCP 连接 | 可显式选上下文；不错误宣称协议 session 就是聊天身份 |
| 一个聊天重连/上下文压缩 | 可明确恢复；多候选返回 context_required，不猜最后活跃身份 |
| 隔离模式伪造其它分工编号 | 服务端拒绝，改 role/header/目标 ID 均不能越权 |
| 宿主把两套凭据同时暴露给两个聊天 | 向导/验收不把这个配置报告为角色隔离 |
| 角色撤销时正在 wait 或准备提交 | 旧 revision/epoch 失效，不能借旧 lease/receipt 继续 |
| agent 只有 HTTP MCP，无文件及 resources 入口 | 仅凭 instructions、tool 描述、bootstrap 和 guide 完成第一轮协作 |
| token 缺失、撤销或轮换 | 宿主/页面给用户可执行提示，模型不被要求读取配置或索取秘密 |
| 凭据泄露检查 | instructions、工具 schema/结果、提示词、事件、错误、诊断和前端导出不含 token |
| 秘密来源是环境变量 | 检查工具进程继承及文件可读性；未验证隔离不得标注已隔离 |
| v1 → v2 升级 | 旧 grant 不扩大权限、旧 session 可定位、旧任务 actor 可回查 |

协议确定性验证用临时库和真实 HTTP MCP 客户端；逐聊天语义、工具可见范围和秘密存储必须用实际宿主确认。前端没有观察依据时显示“未知/待验证”，不由动画补成成功。

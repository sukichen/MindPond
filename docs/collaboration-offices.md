> 默认协作已采用[办公大楼基础设施](office-building.md)：空办公室、自由通信、可选文本材料和自定义容器。下文为旧 v2 工作流兼容说明，固定开发验收流程不属于默认要求。

# 新角色入口

Codex CLI / OpenCode CLI 现可在聊天中申请角色、由用户在页面批准，再以取信命令继续工作。配置生成、绑定边界和已实现能力见[CLI 角色说明](role-cli.md)。以下 v2 工位流程继续兼容；新角色调用办公室工具时可省略 workSessionId，由服务器解析其已授权分工。

# Task offices: HTTP MCP agents and session roles

The collaboration page (`/collaboration`) provides guided setup, independent agents, optional reusable collaboration projects, per-chat seats, text material delivery and an office timeline. The previous account-to-account frontend and mixed inbox compatibility have been removed. Operational records do not become memory graph nodes.

The [role-centered successor design](design/role-offices-2026-10-16.md) describes persistent characters, session enrollment approval, portable role knowledge and cross-office messaging. The basic character application/sync/mailbox flow is now implemented; full knowledge portability, takeover and automatic host continuation remain planned.

## Setup in the UI

1. Log into **user management**. On protected deployments use the operator credential and, if configured, API key. Agent MCP tokens cannot log in here. The browser uses an HttpOnly, SameSite=Strict session; secrets are not saved in localStorage.
2. Save the central Streamable HTTP `/mcp` URL. Other machines cannot reach your `127.0.0.1`; use an appropriate LAN address or HTTPS hostname. Web and MCP processes must use the same database. The displayed instance ID also appears in `work_bootstrap`.
3. Add an agent's display name, account and host. This creates a pending record, not a running agent. Generate its credential, download it once, and move it into the host's secret settings. Downloaded credentials are sensitive files; remove unnecessary copies after setup.
4. Install the generated native HTTP MCP template in the host. Templates contain only secret references. Set the referenced variable through the user's host environment/secret configuration; the template does not create its value. Never paste the token into a chat or ask the model to find it. No stdio proxy is generated.
5. Create an optional collaboration project to reuse allowed agent membership, or create a standalone office. Choose a goal, acceptance criteria, deadline, whole-office iteration budget and seats. A seat is one chat's role; the same registered agent can occupy separate seats in different chats.
6. Click each seat and give its **non-secret startup instruction** to that chat. `work_bootstrap` confirms the authenticated agent; `work_session_open` opens its authorized assignment. The UI separately reports pending configuration, observed MCP initialization and observed bootstrap. An old handshake does not prove the host is still running.

Current authentication is static Bearer. MindPond does **not** implement an OAuth authorization server yet. A template verified against official documentation is not a claim that every client/version has been tested. Templates use a 360-second tool deadline for the default office_wait five-minute window. The optional legacy work_office_wait path below retains its shorter window.

The browser management server can issue credentials only when `MINDPOND_MCP_ACCOUNTS` points to the same private grant file as the HTTP MCP gateway. Configure the same `MEMORY_DB_PATH`/`--db` for both. Without that setting the UI explains offline provisioning instead of pretending it issued a credential.

For example, an operator can provision a v2 agent offline:

```sh
mindpond-mcp-http grant --config /private/accounts.json \
  --db /private/mindpond.db --principal account-a --agent codex-work \
  --personal account-a --token-file /private/codex-work.token
```

Use `--assignments seat-id` to restrict that credential to specific preauthorized office seats. `--rotate` replaces the old credential while preserving existing domain and assignment restrictions unless explicitly changed; use a new token output path. `--unrestricted-assignments` explicitly removes seat restrictions. In the UI, current policy is prefilled and clearing an existing restriction requires confirmation. CLI output contains paths/identity, never the bearer value. Provisioning and file permissions remain operator operations, not MCP tools. The grant file is mode 600 and contains only token digests.

## Identity and isolation

`principal` is the account. `agentId` is the registered host identity. `workSessionId` is a recoverable working context. `assignmentId` is an office seat with a role and binding revision. A transport `Mcp-Session-Id` is neither an authentication credential nor a reliable host chat identifier.

Pass this chat's returned `workSessionId` on office calls and on memory calls made in that working context. Session memory is namespaced by account, agent and work session and survives transport reconnection. It is not shared simply because agents joined the same office. Existing personal/team domain grants remain separate.

The default mode is **explicit context binding**. It prevents normal mixups, but a broad credential can select that agent's other authorized seats. For stronger separation, create separately restricted agent credentials and configure the host so each chat/process sees only its intended connection. Exposing both credentials to both chats does not isolate them. Different seats on one model are not proof of independent review.

Environment-variable references keep token literals out of templates and prompts; they do not protect a token from shell tools that inherit or can read it. A genuine secret boundary requires host credential storage and separate permissions from the model's tool execution environment. The UI does not claim that this boundary was verified automatically.

A seat already in use must be explicitly resumed using its existing workSessionId. Bootstrap lists authorized current candidates but does not guess the most recently active chat. `work_session_open {assignmentId,workSessionId,end:true}` ends a context and fences its active claims; the next chat may open a new one. User changes to seat assignments invalidate previous bindings and leases. Old actors/events are never relabeled.

## MCP-only discovery and workflow

No MindPond local documentation or MCP resources support is required. HTTP MCP initialization includes short instructions; `work_guide_get` returns complete versioned instructions directly in tool responses.

| Tool | Use |
|---|---|
| `work_bootstrap` | Confirm authenticated agent, instance, seats and recoverable context candidates |
| `work_guide_get` | Read identity/workflow/materials/waiting rules on demand |
| `work_session_open` | Open, explicitly resume or end this chat's assignment |
| `work_office_get` | Read paginated office events, item/material summaries; itemId reads full acceptance, roundId/eventSeq read complete JSON via offset chunks |
| `work_office_exchange` | Send inform/request/final reply, read seat inbox, explicitly ack |
| `work_material` | Publish text atomically with server-calculated size/digest, or use precomputed manifest/chunk/finalize; read finalized chunks |
| `work_office_item` | Create/delegate, claim/renew, submit, verify, propose/accept/reject transfer, cancel |
| `work_office_progress` | Report brief public action/reason and file access observations |
| `work_office_wait` | Bounded wait for inbox, exact request reply or matching iteration |

Workspace membership and seat creation are user management actions, unavailable to agent credentials. v2 agents cannot fall back to v1 account-wide task tools to bypass seat restrictions. Existing v1 accounts keep their legacy tools and exact old session namespace after grant-file migration; active transports may require reconnection when their grant representation changes. No historical memory or task is moved automatically.

A request is satisfied only by its designated recipient's final correlated reply. An informational message does not create a response obligation. Read and accepted receipts do not mean completed work. Responsibility transfer changes the owner only when the target accepts the current proposal; until then the original owner remains responsible. Epoch/revision/lease checks fence previous claims after acceptance. Submitting a round invalidates outstanding transfer proposals; a late transfer cannot interrupt pending verification.

Worker submission requires a live lease, exact code version and finalized material. The designated reviewer reports the exact round/version with actual evidence. `passed` completes, `changes_requested` allows another claim, `blocked` needs prerequisites. The iteration budget is shared by all work items in the office, including delegated children; new items cannot reset it. Deadlines and paused/cancelled/completed offices prevent further work. Cancellation cannot kill a remote host process.

Without an item/request filter, `work_office_wait` receives incoming messages and relevant work-item changes, including a newly assigned task before the recipient knows its ID. Read the returned item ID, then a reviewer can wait for its submission. A request-specific wait returns the durable final reply even if the general event cursor has already advanced past it. Completed reviewer tasks return `terminal`, not an endless timeout.

Waits last 25 seconds by default, at most 55 seconds. Timeout is pending, not failure or verification. Continue with returned resume only within the user's task/runtime budget. Cancellation, revoked credentials, disabled agents/projects and stale assignments end/reject waiting. Both hosts must already be running: MindPond cannot launch or wake an exited agent.

## Files, uniforms and observer behavior

Shared-file conditions are explicitly reported by each work session, never inferred from account, IP or path. Uniform colors summarize a declared shared working-copy group; text-only and unknown conditions are distinct. Reports are labeled as self-reports and become unknown after a day in the overview. Compare the actual version/dirty patch before verification; declarations are not filesystem proofs.

When files are not shared, send necessary UTF-8 text through MCP: reproduction, environment, code/patch, commands and output. For MCP-only agents, use `work_material {action:"publish",label,version,content,key,workSessionId}`. The server computes bytes/SHA-256, splits Unicode safely and publishes atomically in one call; the model need not calculate a digest. This accepts up to 128000 characters / 512KB. Where a host can calculate a whole-document digest, the existing begin/chunk/finalize flow remains available. Receivers read all chunks; a server digest identifies content and does not prove that the agent ran a local checksum or verified its claims. Draft/incomplete/digest-mismatched materials cannot be read as published. Limits: 16KB per chunk, 512KB per material, 16MB and 500 materials per office. Binary/base64 file transport is not implemented.

The user can inspect published material text in the frontend without acknowledging it for an agent. Every business event has a durable sequence and actor; the office view animates only new observed events, suppresses historical replay, pauses while hidden and respects reduced motion. Event summaries explicitly advertise detailAvailable for large records; read all offset chunks for their complete JSON, never treat a preview as complete. Items and material manifests have separate cursors. `itemIds`/`materialIds` can refresh up to 500 already-loaded records; an incremental event page also includes the current records changed by those events. Old browser responses cannot overwrite another office or move a task to an earlier revision. Non-advancing detail pagination stops with an error. The view polls in a bounded shared browser loop; the agent interface remains HTTP MCP. Agent-local edits/tests are visible only when reported, not automatically observed. Private memory content is never broadcast into the office.

## Verification

```sh
npm run build
npm run verify:office
npm run verify:network-mcp
npm run verify:collaboration
npm run verify:collaboration-wait
npm run verify:trusted-context
```

`verify:office` uses a temporary database, real native HTTP MCP clients and an isolated browser management server. It covers distinct agents on one account, role/context selection, scoped credentials, message correlation, text completeness, exact round validation, responsibility transfer, scoped session memory/reconnection, revocation, secret-free projections and provisioning failure recovery. Additional regression tests exercise transfer/submission ordering, request cursor recovery, idle-reviewer notification, completed waits, long browser reports, privilege-preserving rotation, MCP-only Unicode publication and frontend response races. v2 initialization, capabilities, protocol rules/resources and timeout instructions consistently describe office tools; legacy connections retain their own rules and cache identity. Real host model behavior and per-chat secret isolation require host-specific acceptance; SDK success is not reported as that acceptance.

Official template references checked 2026-10-15: [Codex](https://learn.chatgpt.com/docs/extend/mcp), [OpenCode](https://opencode.ai/docs/mcp-servers/), [Claude Code](https://code.claude.com/docs/en/mcp).

## 新手使用说明与永久删除

协作页面顶部的“使用说明”打开独立的 `/collaboration/guide` 页面，无需登录阅读。它包含接入、申请与批准角色、创建办公室、可复制的双角色协作示例，以及消息、材料、容器和日常管理的说明。操作以真实页面截图、编号红框和简短图注展示，支持点击放大。截图由 `verify-office-deletion.ts --preview` 的隔离虚构数据环境拍摄（2026-10-17），未签发真实凭据；截图资产逐项列入发布清单，更新时需重新检查无秘密和真实用户数据。使用示例中的名字不替代实际角色编号；由 agent 查询真实身份和办公室。

角色资料中有“永久删除角色”，办公室（含已归档办公室）有“永久删除办公室”。两者均先显示影响范围并要求确认。删除通过仅用户管理可用、同源 Cookie 认证的接口完成，不作为 MCP agent 工具开放：

- `POST /api/office-admin/role/delete`：`{id, expectedRevision}`。硬删除角色及绑定、申请、通信授权、角色收发私信和相关回执，撤销工位并取消其参与的未完成任务。保留办公室历史材料和删除审计。
- `POST /api/office-admin/office/delete`：`{id, expectedRevision}`。硬删除目标办公室及其消息、材料、容器、任务轮次、事件、工位、会话和相关回执。角色本身、其他办公室、项目和独立记忆不受影响；角色的主要工位会改为其余可用工位或空值。

版本必须匹配当前记录，否则返回 `stale_version`；全部依赖清理在单一事务内完成，异常会回滚。旧会话与进行中的等待会重新检查权限，不能利用删除前的绑定或回执恢复权限或内容。删除记录保存在独立的管理审计中；归档仍是保留内容的终结操作，暂停则可再开放。

## 办公室场景与事件（2026-10-17）

`web/office-scene.js` 独立负责场景动作，`web/office.js` 负责数据与界面。地板、桌椅、屏幕、门、休息区和人物为原生 DOM/SVG；没有额外图像模型依赖。新近 15 秒内的消息触发人物到接收者桌边再返回，材料读取/发布、容器修改显示相应动作与标签。首次打开和翻页历史不会重播；重复 seq 不重播，队列最多 8 个。切房、退出、后台、减少动态效果、暂停动态或列表模式会取消进行中的动作。静态/未知状态不能推断宿主离线或正在工作。植物摆动为装饰，独立于业务状态。

“预览人物动作”仅本地演示，不发消息、不写事件、不启动宿主。场景中的纸张上限 12 份，数字显示该办公室精确的未归档消息总数（含已读）；不统计其它办公室的私信。`office_receive` 现在只有角色邮箱与单一数值 `nextCursor`，下一页传 `afterSeq`；不再合并 `office:` 历史信封或使用 `officeAfterSeq`。旧版协作页面脚本和样式已删除。任务/轮次数据仍可由当前工作记录读取，移除兼容不删除已有业务记录。

验收：`node scripts/verify-office-scene.mjs`、`npm run verify:office-building` 与浏览器实际动作验证。

人物导航在 `web/office-navigation.js` 中：以完整人物矩形（非点或脚底）加 12px 安全间距膨胀桌椅、显示器、入口、休息区与其他人物障碍；在场景坐标中搜索可通行路线，平滑时逐段检查，禁止斜线切角。交接停靠点位于接收者旁边，不占据接收者位置。场景同时只放行一个行走动作，空间不足就原地等待；窗口导致桌位重排、切换办公室或关闭动态时撤销路径。与缩放/平移后的屏幕坐标分开计算，返回也沿安全路径。

## 同状态动作与历史回放（2026-10-17）

每个阅读/处理/等待/休息/通信状态有三种有区别的姿态（翻书/对照屏幕/摘记、键入/便签/思考、喝水/看时间/活动肩膀等）。同一角色连续相同状态切换动作；长事件每两秒换一次。等待窗口仍有效时可用等待动作，不把未知宿主画成正在执行；休息预览明确标为演示。姿态保持在已预留的完整人物碰撞体内，行走仍走碰撞导航。

办公室中的“历史回放 / Replay”支持起止事件编号（包含端点），时间线也能直接设起终点。载入时固定结束编号，后来新增的事件不插入此次回放。每个角色可设 0.5–60 秒的每条事件展示时长，留空继承默认；速度 0.5×/1×/2×/4×/8×立即生效，角色时长从下一事件生效。这是回放展示时间，不是对宿主实际耗时的测量。支持暂停/继续、上一/下一、进度跳转、重播与回到实时。减少动态效果时仍按时序显示记录，不强制移动。后台暂停，切换办公室/退出会取消未完成读取和播放。

`POST /api/office-admin/replay` 为管理员只读投影，严格校验 `{action:'index'|'page',officeId,fromSeq?,toSeq?,afterSeq?,limit?}`；同源 Cookie 权限不变。分页最多100条/约64KB，长正文标记为预览，可通过已有完整事件分块读取。前端载入最多5000事件，过长时要求缩小区间，不静默截断。名称使用当前角色资料或事件历史署名，缺失身份标为历史角色；不推测旧桌位或没有记录的状态。历史视图使用当前场景布局，隐藏当前待处理纸堆以免混作历史数量。

`web/office-replay.js` 控制只读载入、时序和失效隔离，`web/office-scene.js` 提供独立的 replayEvent/pause/rate 和姿态目录，`src/core/office-replay.ts` 投影受限办公室历史。回放期间暂停实时办公室快照替换，用户管理目录继续检查办公室删除；回到实时从原游标继续同步。回放不写消息、已读、任务、容器、记忆或审计事件。`verify:office-replay` 验证只读零写入、范围与分页、旧身份、每角色时长、暂停跳转及迟到响应失效。截图说明页增加了对应的真实页面示例。

### 应用式工作区

`/collaboration` 使用独立的 `office.css`，不再加载记忆页面的 `app.css`，避免全局页头、表单和移动断点互相覆盖。

- 固定导航切换办公室、角色与申请、协作项目、宿主连接、连接设置；URL hash 支持刷新和浏览器前进后退。
- 办公室列表和当前工作区并列显示。工作区按办公室场景、材料、工作项、通信、时间线分标签，键盘左右方向键、Home / End 可切换。
- 创建和编辑办公室使用原生弹窗；编辑、暂停、归档与永久删除集中在右上角“办公室设置”。原有管理员身份、版本检查和删除确认保持生效。
- 回放从标签栏打开设置抽屉，播放时收起设置，场景与控制栏同时可见。切换到其它功能或内容标签会暂停回放，返回时由用户继续；离开工作区会隔离尚未完成的打开办公室请求。
- 小屏显示横向功能导航和办公室列表，各内容区域独立滚动。场景按完整人物布局取景，保留手动缩放、拖动、列表和展开功能。
- 使用说明的 12 张真实演示截图与新界面同步；截图不含真实用户内容或凭据。

协作管理登录支持反向代理挂载路径：浏览器在登录请求中携带当前页面解析出的 `cookiePath`，例如 `/mindpond/api/office-admin`；服务端只接受规范的、以 `/api/office-admin` 结束的限定路径。直连默认仍为 `/api/office-admin`。Cookie 保持 HttpOnly / SameSite=Strict，管理员凭据与同源验证不变；不能把路径统一改为 `/` 来绕过挂载问题。

归档或已结束办公室在列表右侧提供“删除”入口，无需先载入历史内容；仍需确认，并校验当前版本。场景默认人物就座，交接消息时起身离座、绕开家具与人物、停步交流并返回落座。椅子在自己离座时收进桌下，其他椅子始终作为障碍；桌子碰撞范围包含桌腿，台灯也参与避让。动作展示不代表宿主正在执行。相关截图于 2026-10-18 使用隔离虚构数据更新。

### 卡通人物与动作库

人物采用原创 SVG Q 版造型：圆脸、大眼、短四肢，按身份固定发型、眼镜/发饰与衣服颜色。空闲人物转向房间，自动错峰轮换喝水、舒展、听音乐、看时间、靠椅、打盹六段休息动作；每段 4.8–6.6 秒，之间留有停顿，不表示宿主真的正在休息。工作/阅读事件立即接管朝向与动作，结束后恢复；有已领取任务报告时保持面向电脑。

动作库按唯一 clip ID 计数，共 6 系列 / 18 段动作；每段含准备、执行、收尾关键帧，头、手臂、身体、道具和表情共同变化。阅读：翻资料、对照屏幕、摘记；工作：敲键盘、写本子、思考；等待：喝水、看表、舒展；休息：打盹、听音乐、靠椅；交流：挥手、递信、点头；庆祝：欢呼、鼓掌、点赞。行走/起身/落座另计，不充当新的动作条目。六段休息动作来自等待与休息系列，复用原动作库，不重复计数。庆祝仍仅由明确标注的预览或事件触发，不据此推测真实任务成功。

“动作预览”可以选择整个系列轮播，也可单独选择任意一段。关节关键帧使用同一回放时钟采样，暂停、倍速、跳转/取消一致；减少动态效果时固定关节姿势。所有造型和道具保持在已有 66×94 体积内，保留桌椅碰撞约束。

设计参考（2026-10-18）：[Kenney Mini Characters](https://kenney.nl/assets/mini-characters) 的简化头身与轮廓；[WorkAdventure Wokas](https://docs.workadventu.re/admin/custom-wokas/) 的分层角色与四方向组织；[Phaser Animations](https://docs.phaser.io/phaser/concepts/animations) 的序列/时长组织。采用现有 SVG 结构实现原创造型与动作，不引入第三方人物素材、运行时脚本或真实用户数据。

工位按显示器、键盘、人物与椅子的共同中心线布置。人物坐在桌前，工作与阅读时背朝观察者、正对屏幕，双手前伸到键盘；椅背在人物背后。交流和休息可转身，起身先将椅子收向桌下，再从前方过道走出，返回后落座。屏幕与支架仍是同一 SVG 结构，不用人物手中的第二台电脑替代桌上电脑。

### 空闲节奏与记忆提醒

参考实际开源实现，而非照搬截图：[Pixel Office](https://github.com/basriayaz/pixel-office) 展示闲逛、喝咖啡、聊天等空闲行为；[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents/blob/main/webview-ui/src/office/engine/characters.ts) 用独立空闲/行走/工作状态及停顿计时；[Pixel Agents ESP32](https://github.com/underactive/pixel-agents-esp32) 区分社交区休息与返回工位工作。本项目采用已有原创矢量人物与六段坐姿休息动作，增加独立的空闲时钟、错峰、停顿和事件抢占，不引入这些项目的素材或代码。

空闲时钟全场共用一个 80ms 定时器；等待窗口保留文字报告，已删除单独循环播放等待姿态的旧定时器，避免装饰动作占用真实交互队列。离开办公室、隐藏页面、列表视图、关闭动态、减少动态和进入回放均停止，返回可见实时场景后恢复。休息不移动人物或椅子的碰撞矩形，回放只遵循历史时钟；不生成虚构消息、宿主状态或业务事件。

协作记忆提醒共用 `src/core/collaboration-learning.ts`，由 MCP 初始化、显式 `role_sync` 身份介绍、生成的 Codex 收件箱 Skill 与 OpenCode 收件箱命令提供，不附加在每次取信/等待返回中。费力调查后的环境发现、问题原因和方法，在交接、长时间等待或结束前评估复用价值，按 `memory_save_policy` 用 `memory_finish` 更新/保存适用范围、证据、步骤、坑点与不确定性；跳过重复和日常聊天，办公室成员身份不授予共享私人记忆的权限。测试验证提示送达，不能据此宣称所有模型都会自发遵循。

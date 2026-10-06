# 通用客户端接入与能力边界

MindPond 提供 `mindpond-connect`，生成独立目录中的连接配置，并在本次客户端启动时加载。它不覆盖用户的全局配置，也不保存模型凭证。需先安装 MindPond 与相应客户端，Node.js >= 22。

## 基础用法

下面的绝对路径仅为示例，替换为本机路径。数据库必须在连接目录外；三个客户端指向相同数据库、使用相同 personal ID 时可共享长期记忆。

```sh
mindpond-connect prepare --client codex --directory /absolute/connections/codex --db /absolute/data/mindpond.db --personal default
mindpond-connect inspect --directory /absolute/connections/codex
mindpond-connect run --directory /absolute/connections/codex --dry-run
mindpond-connect run --directory /absolute/connections/codex
```

`--client` 也支持 `claude`、`opencode`，各自使用独立连接目录。运行参数放在 `--` 后。`prepare` 同配置重复执行无副作用；配置不同会拒绝覆盖。`inspect` 核对受管理文件，`run` 使用 argv 启动客户端，不经过 shell。

不传 `--session` 时仅绑定指定 personal 域，不猜测客户端 session。需要过程记忆时，宿主或用户在 prepare 时提供稳定的 `--session logical-work-id`；同一逻辑工作换 agent 可沿用，新的工作必须换 ID 与连接目录。当前工具不会自动获取客户端内部 session ID，也不会在客户端退出时自动关闭该域。

基础连接不授予 operator 或 team。team 发布仍需可信宿主绑定域并提供真实用户授权凭据，不能通过模型生成参数自我授权。MCP 是本地进程边界，不能用它隔离拥有同一文件系统权限的恶意本地程序。

## 规则如何加载

- 所有 MCP 连接在初始化时提供短启动规则；512 字节内的启动规则包含限定范围检索、多轮探索/代码环境理解/长期用户意图的保存时机、反馈入口和信任边界。
- Codex 使用本次启动的 `mcp_servers` 配置覆盖；规则通过 MCP instructions 提供。
- Claude 使用 `--mcp-config`，并通过 `--append-system-prompt` 加载短规则。
- OpenCode 使用 `OPENCODE_CONFIG_CONTENT` 与 `instructions.md`。已有 inline 配置中的其他连接和规则会合并；同名 MCP 冲突会拒绝。其他配置层仍按客户端自身的合并规则处理。

首次接入后的工作流程：先按当前域检索并核对命中的源码版本。审查中一旦形成可复用的模块职责、调用流程或经验证的缺陷，读取一次 `memory_protocol_rules`，记录条件、证据、未知范围和源码引用，不确定分类/关联时先调用 `memory_save_validate`，再调用 `memory_save` 放入对应项目空间。首次阶段核对前读取 `memory_lifecycle_policy`；之后在阶段节点和任务结束时按真实写入回执调用 `memory_checkpoint`，没有新知识时报告 `no_change`。完整规范按需读取，避免每次连接重复装入。这套提示帮助 agent 发现流程，模型是否执行仍需用真实任务验收。

依据：[Codex MCP](https://developers.openai.com/codex/mcp)、[Claude MCP](https://code.claude.com/docs/en/mcp)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)、[OpenCode 配置](https://opencode.ai/docs/config/)。客户端能力须按实际安装版本验证。

## 移除与升级

```sh
mindpond-connect remove --directory /absolute/connections/codex
```

仅删除 manifest 声明且内容未改的配置文件；用户修改过则拒绝，数据库与其他文件保留。升级后若 Node 或 MindPond 安装路径改变，使用新目录重新 prepare，验证后移除旧目录。不要手工移动含绝对路径的连接目录。

## 客户端验证

`npm run verify:client-bundles` 使用隔离库核验连接契约。实际 CLI 检查需要本机安装对应客户端；传输通过不代表 LLM 已正确使用记忆。客户端版本、权限提示和生命周期钩子必须在目标环境重新验证。

## 有界检索

HTTP `/api/memory/search`、MCP `memory_search` 和 SDK `pond.recall` 可传 `contextBudgetBytes`（32–2,000,000）。按规范记忆 ID 去重，优先高分结果，仅放入完整记录；放不下的一条会跳过，后面较短的合格记录仍有机会进入。

返回的 `contextBudget` 明确记录已用 UTF-8 字节数和省略 ID。预算覆盖 `JSON.stringify({results})`，不包含回执、预算说明或协议信封；它不是精确 tokenizer 计数。宿主应按自己的模型窗口留出余量。正文、条件、末尾例外不会为了凑预算被截断。`pond.search` 是原始搜索接口，不执行此装配。

采用反馈只允许针对本次实际返回的记忆；被预算省略的不进入采用率分母。回执保存内容哈希和版本时间，整批反馈原子提交。没有反馈不等于采用，也不据此自动改边权或删除知识。

## 工具目录

新 prepare 默认 `--tools work`（具体数量以 memory_capabilities 返回为准），省去全库请求和旧维护目录；需要完整工具目录时显式 `--tools full`。直接运行 mindpond-mcp 未设置 MINDPOND_TOOL_PROFILE 时仍保留 full 兼容。目录配置不授予额外访问权。memory_capabilities 的 mcpConnection 返回本连接实际目录与域/session；完整保存规范从 memory_save_policy 按需读取。

生成配置 MCP timeout 为 15 秒，其他 inline 配置合并保留。宿主要求的连接批准由用户在对应客户端完成。详细步骤见 [工作环境接入](opencode-work-integration.md)。


### OpenCode 原生模式

新 OpenCode 连接省略 --session 时默认生成文件插件，使用宿主实际 sessionID。配置中的静态 MCP 被禁用，原生工具供日常工作，memory_action 供高级接口。已有静态 session 配置保留兼容；使用 --native 可显式切换。--no-capture 禁用公开正文自动留存。

插件、MCP 和目录不增加 operator 权限，不自带 LLM。完整使用反馈和语义整理仍需宿主模型执行。流程见 [任务记忆循环](task-memory-loop.md)。

## 局域网中心账户

需要由其它账户/机器访问中心库时，使用 `prepare --remote-url <中心 /mcp URL> --token-file <私有令牌文件>`；不传 `--db`。可用 `--session <宿主真实逻辑会话>` 继续同一会话，未提供则每次连接独立。三个客户端均生成 stdio 桥接配置；OpenCode 远程模式不使用本地 native adapter。详见 [网络 MCP](network-mcp.md)。

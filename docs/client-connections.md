# 客户端接入与身份核对

通用客户端可使用无需插件的**通用连接身份**：在网页生成完整双 MCP 配置，分别配置的连接可绑定不同角色。共享配置的聊天共享角色。步骤及范围见[通用接入与生产验收](production-acceptance.md)。

所有普通连接模板默认使用**通用连接身份**，不会因为宿主叫 Codex/OpenCode 就推定版本或公司封装提供聊天标识。下面的详细示例属于可选的**逐聊天增强模式**；已有逐聊天连接继续使用该模式，服务不会自动改绑。


Agent 使用两个独立 MCP，但身份一致：Office 管角色和通信，Memory 管角色私有与办公室共享记忆。未绑定角色的已识别聊天按人类身份访问全部知识，已绑定角色只访问自身和当前办公室知识。公开 MCP 不暴露 full/work 管理目录。

## 最简单的通用连接配置

在“宿主连接”登记一条连接，保留“通用连接身份”，下载双 MCP 配置并合并到宿主实际使用的设置。两个入口使用同一凭据，并都发送配置头 `X-MindPond-Identity: connection`。客户端只支持 stdio 时，可使用[已有的标准桥接](production-acceptance.md#客户端只支持-stdio)。这不要求改宿主、装会话插件或用指定启动脚本。

一个连接代表一个身份：共享这份配置的聊天共享角色。需要不同角色时分别登记连接并使用各自配置。HTTP 重连不产生新角色，明确未绑定的连接使用人类记忆；绑定后收窄为角色和当前有权访问的办公室。不要让模型填写角色 ID 或伪造聊天标识。

下面的步骤只用于需要同一份宿主配置区分多个聊天、并已验证宿主支持的情况。

## 首次配置完成后，直接启动 Codex / OpenCode

启动脚本不是必需条件。它们通常只是选择配置文件、加载凭据并启动客户端。把下列设置放进宿主实际加载的配置位置后，日常可直接运行 `codex` / `opencode`；新建聊天不需要再生成配置，也不需要预先申请角色。

### 先在 MindPond 准备地址与宿主凭据

1. 在网页“连接设置”保存 **HTTP MCP 的 Office 地址**。下文用 `https://mindpond.example/mcp` 占位，必须换成你的实际地址；有反向代理前缀时保留前缀。Web 管理页面地址不一定就是 MCP 地址。
2. 在“宿主连接”分别登记 Codex 和 OpenCode，保存对应宿主凭据。这里使用的是宿主 Bearer token，不是网页管理密钥，也不是固定角色专用 token。
3. 在宿主连接卡片展开接入配置，复制配置模板。OpenCode 同时点击“下载 OpenCode 会话插件”。网页生成的环境变量名和服务名可能与下列示例不同，以同一份模板为准。
4. 两个入口必须连接同一 MindPond 实例/数据库：Office 为 `/mcp`，Memory 为 `/memory/mcp`。例如 Office 为 `https://host/mindpond/mcp`，Memory 就是 `https://host/mindpond/memory/mcp`。

### Codex：两个 MCP，无需额外会话插件

默认用户配置文件是 `~/.codex/config.toml`。将以下两个表合并进去，保留现有模型和其它 MCP 设置；已经存在同名表时修改该表，不能重复追加。项目级配置可放在项目 `.codex/config.toml`，项目必须受到客户端信任才会加载。自定义 `CODEX_HOME` 时使用该目录内的配置文件。

```toml
[mcp_servers.mindpond_office]
url = "https://mindpond.example/mcp"
bearer_token_env_var = "MINDPOND_CODEX_TOKEN"
tool_timeout_sec = 360

[mcp_servers.mindpond_memory]
url = "https://mindpond.example/memory/mcp"
bearer_token_env_var = "MINDPOND_CODEX_TOKEN"
tool_timeout_sec = 360
```

- 把两个示例 URL 改成你的实际 Office 和 Memory 地址。
- 让启动 Codex 的进程获得 `MINDPOND_CODEX_TOKEN`，其值是网页登记的 **Codex 宿主凭据**。`bearer_token_env_var` 中填写变量名，不填 token 本身。
- 支持该接入的 Codex 会在每次工具调用中提供真实 `threadId`。无需为每个聊天配置角色ID、workspace、固定 session header 或额外插件。
- `tool_timeout_sec = 360` 给五分钟 `office_wait` 留出传输余量。

[Codex 官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

### OpenCode：两个 MCP，加一个本地会话插件

默认用户配置文件是 `~/.config/opencode/opencode.json`。将下面的 `mcp` 项合并进去；项目级也可放在项目根目录 `opencode.json`。保留已有 provider、model、command、plugin 等设置。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mindpond_office": {
      "type": "remote",
      "url": "https://mindpond.example/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:MINDPOND_OPENCODE_TOKEN}"
      },
      "timeout": 360000
    },
    "mindpond_memory": {
      "type": "remote",
      "url": "https://mindpond.example/memory/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:MINDPOND_OPENCODE_TOKEN}"
      },
      "timeout": 360000
    }
  }
}
```

然后完成三件事：

1. 把 URL 改成同一实例的实际 Office / Memory 地址，让 OpenCode 进程获得 `MINDPOND_OPENCODE_TOKEN`，其值是该 **OpenCode 宿主凭据**。
2. 把网页下载的 `mindpond-session-<连接编号>.js` 放进 **`~/.config/opencode/plugins/`**，或项目 **`.opencode/plugins/`**。例如全局文件为 `~/.config/opencode/plugins/mindpond-session-office.js`。全局和项目安装选一处，文件内容使用下载的完整版本。这个 JS 插件只使用宿主和内置加密接口，本身不需要另装 npm 包或模型。
3. 重新启动 OpenCode，确保配置和插件都被加载。插件使用真实 `sessionID` 为 Office 与 Memory 调用签名；**只复制 JSON、漏装插件，不算完成逐聊天身份接入**。不要手写一个共享的 sessionId 替代它。

示例的 `timeout = 360000` 单位是毫秒，`oauth = false` 表示这里使用已配置的 Bearer 凭据。MCP 发现成功不代表五分钟等待已通过实际客户端/代理验证。

[OpenCode 配置位置与优先级](https://opencode.ai/docs/config/)、[本地插件自动加载目录](https://opencode.ai/docs/plugins/#from-local-files)。自定义 `XDG_CONFIG_HOME` 或 `OPENCODE_CONFIG_DIR` 时，以实际宿主配置目录为准；`OPENCODE_CONFIG`、项目配置和 `OPENCODE_CONFIG_CONTENT` 也可能覆盖全局同名项。

### 客户端版本

当前逐聊天身份接入已在 Codex CLI `0.163.0-alpha.10.2`、OpenCode `1.18.34` 验证。这是已验证版本记录，不代表最低版本要求；其它版本必须完成下列身份验收，不能仅凭服务显示“已连接”判断通过。

### 凭据由谁加载？为什么脚本启动成功，直接启动失败？

配置中的环境变量引用不会自动创建变量。下面是在 Bash 当前终端中由用户输入凭据的方式，输入值不回显，也不写成一条含 token 的历史命令：

```bash
read -rsp 'Codex 的 MindPond 宿主凭据：' MINDPOND_CODEX_TOKEN
printf '\n'
export MINDPOND_CODEX_TOKEN
codex
```

OpenCode 对应使用 `MINDPOND_OPENCODE_TOKEN` 并运行 `opencode`。这只影响当前终端及其子进程；要在新终端或桌面启动方式中直接使用，需要把变量接入该机器已有的环境/凭据加载方式。不要让 agent 搜索、读取或打印凭据。

如果原脚本独占地设置了 `CODEX_HOME`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_CONTENT`、插件目录或 token，普通启动就可能加载另一套配置。先把必要设置迁到实际使用的全局/项目位置，保留其它配置；再完整退出并重启相关客户端。已经运行的桌面进程或常驻服务不会因为另一个终端执行了 `export` 就获得新变量。

### 逐项验收，完成后再绑定角色

1. 在自己的终端运行 `codex mcp list` / `opencode mcp list`，确认 Office 和 Memory 两个服务可发现。这一步只验证服务，不证明角色绑定。
2. 在一个**未绑定角色**的聊天调用 `memory_identity`，应返回 `owner.kind = user`、`identity.mode = unbound_chat`，以及该聊天的真实 `identity.chat.id`。可以正常访问人类、角色和办公室的全部知识。
3. 需要角色协作时，在该聊天调用 `role_application`，或 `role_sync` 后在网页激活已有角色。批准/激活后再调用 `role_sync` 与 `memory_identity`，核对两者 `pondId` 一致，角色ID和绑定ID一致，Memory 返回 `owner.kind = agent`。
4. 在同一个 Codex/OpenCode 中新建另一个聊天，再查询身份；未绑定的新聊天应为人类，不能继承前一个聊天的角色。重新打开原聊天应恢复原角色。
5. 网页“角色与申请 → 角色目录 → 点击角色 → 当前连接”应显示对应宿主和真实聊天ID。调换办公室后，Memory 的可访问办公室立即跟随。

`identity_required` 表示缺少可靠聊天身份，需要排查元数据或插件；它不表示普通聊天必须先申请角色。若 `pondId` 不一致，先修正两个 MCP 的地址/数据库。若协议不是 `mindpond.layered-memory.v2`，先核对实际运行的 MCP 程序版本并重连。

## 可选：使用 CLI 配置包启动

CLI 配置包用于隔离配置、暂时加载凭据和提供取信快捷命令。以下方式不是普通启动的前置条件：

在工作台的“宿主连接”登记 Codex / OpenCode，下载该宿主的完整配置。也可使用：

```sh
mindpond-connect office-prepare --client codex --directory /absolute/connections/office --remote-url https://pond.example/mcp --token-env MINDPOND_TOKEN
mindpond-connect office-run --directory /absolute/connections/office
```

凭据放在宿主环境，不发给模型。OpenCode 需安装生成的会话插件。Codex 使用原生 `threadId`。申请或激活角色后，分别调用 Office 的 `role_sync` 和 Memory 的 `memory_identity`，两者的角色 ID 与 binding ID 必须一致。Memory 身份响应包含 `identity.protocol = mindpond.layered-memory.v2`、`identity.mode = role`；未绑定聊天返回 `owner.kind = user`、`identity.mode = unbound_chat`。

没有真实聊天标识时，使用工作台生成的角色专用凭据。不能通过个人域、固定标签或模型参数指定角色。详见[角色记忆](role-memory.md)。

## 本机独立 Memory

本机 stdio 可用同一数据库中的 Office 绑定：

```sh
mindpond-connect prepare --client codex --directory /absolute/connections/memory --db /absolute/data/mindpond.db
mindpond-connect inspect --directory /absolute/connections/memory
mindpond-connect run --directory /absolute/connections/memory --dry-run
mindpond-connect run --directory /absolute/connections/memory
```

生成器也支持 `claude`、`opencode`。它不覆盖全局配置，不包含模型凭据。OpenCode 本机适配器使用实际 sessionID，通过 Node worker 调用同一套角色 Memory；不会自动采集对话；保存归属由当前聊天是否绑定角色决定。

本机数据库必须与 Office 指向同一文件。跨机器不能用本机 stdio 猜测中心角色，需使用中心的 `/memory/mcp`。客户端缺少原生聊天 ID 时，调用返回 `identity_required`；Claude 等客户端应使用明确的角色专用 HTTP 配置。

## 远程 Memory 桥接

```sh
mindpond-connect prepare --client codex --directory /absolute/connections/remote-memory --remote-url https://pond.example/memory/mcp --token-file /absolute/private/host.token
```

桥接保留宿主原生聊天元数据。普通宿主凭据仍需聊天 ID；固定安装标签不足以识别聊天。角色专用凭据明确固定角色，并在同时提供聊天 ID 时核对绑定。OpenCode 优先使用完整配套配置的签名插件。

## 更新与移除

`prepare` 同配置重试复用目录；不同配置拒绝覆盖。`remove` 只删除校验通过的受管理文件，保留数据库与其它文件。升级后重新生成接入配置，更新实际可执行路径并重连 MCP；网页刷新不能更新常驻 stdio 进程。

`--personal`、Memory 的 `--session`、`--tools work|full` 不再是接入方式。已有记忆不会按姓名自动移动；人类可在工作台阅读来源并添加独立副本给角色。

MCP 边界不能隔离具有相同文件系统权限的恶意本地程序。数据库、配置和令牌应留在专用账户的私有目录。

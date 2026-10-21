# 生产依赖、认证排障与许可证边界

## 1. 三类阻塞要分别处理

| 现象 | 已能确定什么 | 如何处理 |
| --- | --- | --- |
| `Invalid account credential` | HTTP MCP 的认证/宿主授权未通过；不是 SQLite 迁移失败的同义词 | 核对候选进程实际使用的账户文件、数据库和宿主凭据；使用下方只读诊断 |
| 离线缓存缺少某个包 | 安装依赖不完整；服务能启动不代表新目录完整、可重复安装 | 使用目标版本的基础锁文件准备运行目录；基础安装不再要求 Transformers/ONNX/Sharp |
| 要求匹配平台原生模块 | SQLite 和明确选装的推理运行库存在本机二进制 | 在与目标 OS、架构、libc、Node 匹配的环境构建；不能用忽略安装脚本掩盖缺失 |

不要通过停用认证、重签所有角色凭据或打开生产库试迁移来定位第一类错误。SDK 版本一致也不代表 token、账户文件和宿主记录一致。

### 只读核对账户、宿主与 token

在已有 token 文件所在的可信宿主执行；不要把 token 内容发到聊天、命令行参数或日志。token 文件只允许当前用户读取。候选服务使用迁移副本时，`--db` 也指该副本，`--config` 指候选进程实际使用的账户文件。

```sh
node /absolute/new-release/dist/mcp-http.js check-auth \
  --config /absolute/private/accounts.json \
  --db /absolute/private/staging-copy.db \
  --token-file /absolute/private/host.token
```

npm 安装形态将程序路径替换成 `node_modules/mindpond/dist/mcp-http.js`。本命令直接以只读 SQLite 打开已有文件，不调用 GraphMemory 初始化，不迁移数据库、不轮换凭据；只输出检查结果，不输出 token 或 tokenHash。失败退出码为2，调用/文件配置错误为1。

| `reason` | 意义 |
| --- | --- |
| `credential_not_in_account_file` | token 与这份账户文件不匹配；先核对配置路径、宿主秘密设置与凭据版本 |
| `host_not_in_this_database` / `host_registry_missing` | 账户关联的宿主不在该库；检查是否指错数据库或副本 |
| `host_account_mismatch` | 宿主记录与账户中的人类身份不一致 |
| `host_not_active` / `host_deleted` | 宿主未启用或已删除；核对后由人类决定是否调整 |
| `role_credential_revoked_or_unknown` / `role_has_no_active_chat` / `role_disabled` | 专用角色凭据被撤销、缺少有效聊天绑定或角色停用 |
| `credential_and_host_match` | 当前本地账户/宿主授权条件匹配；还需验证真实 URL、代理与宿主握手 |

诊断不能读取另一台机器的实际环境，也不证明 native chat identity 正确。只有拿到生产本机的结果后才能判断具体根因。常规宿主认证与角色专用凭据、管理密钥是不同用途，不能互换。

## 2. 基础安装与向量运行库分开

此前 Hugging Face 运行库虽被动态加载，却列在必装 dependencies 中，导致文本模式也必须准备整个模型依赖链。本次将它移出基础/开发默认安装，作为明确选装的本地功能。

| 基础运行能力 | 明确选装能力 |
| --- | --- |
| Web、Office/Memory MCP、角色与办公室管理 | 本地 ONNX embedding |
| SQLite 持久化、正文与权限、消息闭环 | 本地 cross-encoder 重排、CPU/GPU 推理 |
| 文本匹配检索、既有图结构与来源记录 | 依赖模型生成查询向量的语义召回 |

基础直接依赖保留 MCP SDK、Express、dotenv、SQLite、Markdown 和图谱 UI 等必要组件。基础安装不自动安装 `@huggingface/*`、`onnxruntime-*`、Sharp、`@img/*`，不附带或自动下载模型。SQLite 仍是本机原生依赖，因此基础包也不能声称跨任意平台免验收或“零依赖”。

- `auto`（默认）：显式提供的本地运行库和模型可用时继续向量检索；未安装时明确报告不可用，文本检索仍可用。
- `MINDPOND_EMBEDDING_MODE=text`：明确停用本地推理，保留数据，但不提供等效语义召回。
- 已有向量生产环境应提前准备选装运行库，保持模型参数，验证后再切换；不要把正文未丢失当作检索质量未变化。

默认源码 `npm ci` 保留构建工具，但也不安装模型运行库；`npm ci --omit=dev` 用于已有构建产物的基础生产安装。发布包的干净消费测试验证默认安装没有该重依赖链。依赖版本来自各自 shrinkwrap；不要为了离线而删除锁文件。

选装方式与完整平台目录的准备见 [examples/local-inference](../examples/local-inference/README.md)。它有独立 package.json 与锁文件；`MINDPOND_LOCAL_INFERENCE_ROOT` 指向该安装目录。不需要本地向量能力的部署不准备它。

### 当前安装体积

2026-10-21 在 Linux x64 / Node.js 22.23.3 上使用锁文件实装，统计 `node_modules` 中的普通文件大小：

| 目录 | 实测体积 | 范围 |
| --- | --- | --- |
| 干净的基础发布包安装 | 约150 MiB | 程序、Web 资源与运行依赖；8项直接依赖 |
| 独立本地推理选装目录 | 约490 MiB | Transformers、ONNX、Sharp 及该平台实际安装的依赖；不含模型 |

两项均不含 Node.js 自身、模型权重和开发工具；不同平台、原生模块的安装方式会改变结果。基础包仍包含图谱可视化库、MCP SDK 和 SQLite 等组件，当前并非极小或零依赖包。发布检查用真实安装验证依赖范围；增加新的基础依赖时，需要说明必要性、体积与许可证影响。

## 3. Hugging Face 在这里做什么

Transformers.js 用本地模型将文本转换成向量，以便“措辞不同但含义相近”的检索。它不负责 agent 对话、思考或调用外部 LLM。MindPond 的模型加载器禁止远程模型下载；使用 Hugging Face 名称不代表记忆被发送到该网站。

重量来自传递依赖：Transformers 的通用能力同时带入 ONNX Node/Web 运行库、Sharp 及平台图像库，纯文本记忆服务也会承担这些安装成本。把它明确选装，是缩小默认交付与合规范围；不是声称去掉向量模型后检索质量完全相同。

## 4. 许可证控制与验证边界

- `licenses/policy.json` 对基础锁文件采用精确审阅过的许可证表达式列表，未识别声明或不允许的表达式使发布检查失败；同时拒绝重推理包进入基础树。
- `licenses/inventory.json` 区分基础/开发记录与 `optionalLocalInference`；不能只看最外层包的 MIT/Apache 声明。
- `licenses/dependencies.txt` 保留已安装基础组件及浏览器分发资源的版权/许可证文本；选装包原始 notices、二进制及权重的额外条件仍需随实际分发核对。
- npm audit 检查安全漏洞，不证明许可证合规、源码权属或专利等全部风险。声明扫描与白名单是工程门槛，不是“任何分发场景零法律风险”的认证。

上游依据：[Transformers.js Apache-2.0](https://github.com/huggingface/transformers.js/blob/main/LICENSE)、[ONNX Runtime MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)、[Sharp 预编译依赖](https://github.com/lovell/sharp-libvips)、[MiniLM 模型说明](https://huggingface.co/Xenova/all-MiniLM-L6-v2)。libvips 基础源码许可证与包含额外 codec 的平台组合包可能不同，以实际交付版本的全部组件为准。

验证入口：`npm run verify:lightweight` 检查纯文本模式保留正文/向量与只读认证排障；`npm run verify:standalone-package` 检查干净基础安装；`npm run verify:local-inference-package` 对明确选装目录执行锁定离线安装和实际 CPU 后端加载（要求构建机已缓存对应平台依赖，不下载模型）；`npm run verify:licenses` 检查清单与基础门槛。

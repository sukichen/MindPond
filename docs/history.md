# 升级历史与离线迁移手册

本文面向已有 MindPond 实例的维护者，记录程序基线 **`3b83221`（2026-10-21）** 及之前几轮变化，并补充轻量化与生产复核修订。仅修改文档的提交不改变程序基线；这些修订涉及运行库拆分、认证和数据保护，需同时更新程序和配置。

这次应按**身份、记忆权限和数据库结构升级**安排维护窗口。页面改动之外，还包含会撤销部分聊天绑定、删除表/列的迁移，不能只替换前端文件。

## 生产复核修订（轻量化版本之后）

在 `ae23d61` 上继续复核，修正数据库/备份权限、本地 REST 浏览器访问边界、账户配置转换误报401、缺少推理库时的后台重试、MCP 连接容量、记忆域冲突与删除办公室后的定向读取，以及请求解析的结构化错误。该轮不增加第三方依赖或数据库表。

- POSIX 数据库及 WAL/SHM 收紧至0600，新建目录0700。Web、MCP、stdio 使用同一专用系统账户；依赖多个系统用户共享数据库的部署需先调整运行账户，历史备份权限另行核对。
- 预迁移恢复备份从创建时即为私有文件，重试拒绝覆盖已有同名快照。如果遇到此项拒绝，保留原快照，在新的候选数据库路径上演练；不要为继续升级删除唯一恢复副本。
- 账户配置转换后，既有账户凭据重新连接仍保留原作用域，不会因此获得 Office 角色或人类 Memory 权限。该修正不能代替生产本机的 `check-auth` 诊断。
- HTTP MCP 连接上限现在可配置，默认全局128、每账户64；Office 与 Memory 各占一个 transport session，与 `office_wait` 的等待容量分开。详见[生产依赖说明](production-dependencies.md#5-生产复核后的运行约束)。

## 本轮轻量化修订

本页同批程序将本地推理改为明确选装，基础源码/npm 安装不再依赖 Hugging Face、ONNX、Sharp 及其图像平台库。需要保留已有语义检索时，另行准备 `examples/local-inference` 的独立锁定运行目录和原有模型；不准备时会使用明确报告的文本检索，不能按“搜索质量等效”验收。新增 `mcp-http check-auth` 只读排查账户/宿主/专用角色凭据，不触发数据库迁移。原有 SDK 1.32.1 输入防护及角色迁移仍保留。

本轮认证、选装步骤、许可证边界见[生产依赖说明](production-dependencies.md)。基础完整运行目录的制作仍可沿用下文；无需把明确选装目录打进去。源码构建/测试不要求默认安装本地模型运行库，CI 对模型相关回归单独明确选装。

## 1. 先确认实际起点

当前 `package.json` 仍为 `0.1.0`，同名 npm 包可能来自不同提交。“第十版”等人工编号不能唯一确定程序、依赖或数据库结构。每次交付至少记录：

- 源码完整 commit SHA、程序包 SHA-256、`npm-shrinkwrap.json` SHA-256。
- Node.js/npm 版本、操作系统、CPU 架构、libc，以及实际安装的依赖清单。
- Web、HTTP MCP、各宿主 stdio 进程实际使用的程序路径和数据库路径。
- 对应的私有配置、模型版本、升级前一致备份及恢复演练结果。

源码部署可运行 `git rev-parse HEAD`；npm 安装部署应查看交付清单。不要仅凭源码目录的版本推断正在运行的进程已更新。无法确认生产起点时，先取得这些信息，再在备份副本演练。

## 2. 变化历史

以下是仓库提交边界，不是人为部署编号；生产可从其实际提交直接演练升级，不要求每一行都单独上线。

| 提交 | 主要变化 | 维护者需要处理的事项 |
| --- | --- | --- |
| `478900a` | 协作恢复、消息查询、经验记录、实时数量与回放改进 | 客户端和代理需要支持较长等待；消息读取、处理中与完成是不同状态 |
| `3a1511d` | Office 与 Memory MCP 分离；引入角色记忆和独立副本 | 同时配置 `/mcp` 与 `/memory/mcp`；角色不能再从 Office MCP 调用记忆读写 |
| `2741312` | 角色记忆权限、管理登录、并发写入撤权和部署检查加强 | 核对独立管理密钥、可信代理、公共前缀和 Cookie 路径 |
| `e9b0c34` | Codex 按真实 `threadId` 识别聊天 | 安装级固定标签不能代表不同聊天；需要可靠宿主元数据 |
| `e4094a3` | 单一角色模型迁移；移除重复接口；SDK 安全更新与输入预算 | 部分绑定需要人类重新激活；**SDK 1.31.0 → 1.32.1**，须提前准备离线依赖 |
| `3b83221` | 角色可跨宿主切换；本机 stdio 角色身份修复；办公室分层记忆与只读权限 | 重连 stdio；核对角色归属、办公室成员授权与只读规范；角色切换后专用凭据失效 |

### 依赖究竟变了什么

已逐项比较 `478900a → 3a1511d → 2741312 → e9b0c34 → e4094a3 → 3b83221` 的 `package.json` 与 shrinkwrap：

- 在这个区间内，锁文件中发生版本变化的依赖是 `@modelcontextprotocol/sdk`：`1.31.0 → 1.32.1`，发生在 `e4094a3`。
- SDK 声明由 `^1.0.4` 改为精确 `1.32.1`；`3b83221` 没有进一步改变依赖版本。
- `marked@18.1.1`、`zod@4.5.4` 等在上述区间起点已存在。若生产更早，仍可能缺少它们或其它依赖，必须比较实际起点与目标完整锁文件。
- SDK 更新与工具参数元素上限共同构成当前输入防护。不要为通过离线安装而改回 1.31.0、删改 shrinkwrap，或将新源码接到已有的 1.31.0 `node_modules`。

这不是“新增一个纯前端包即可”。普通 MindPond `.tgz` 包不包含依赖目录、模型或 Node.js。只执行 `npm pack @modelcontextprotocol/sdk@1.32.1`，不能保证离线机器已具备完整运行环境。

## 3. 离线交付：推荐准备完整运行目录

**联网构建机与生产机使用相同的 OS、架构、libc 和经过验证的 Node.js 版本。** `sqlite3`、推理运行库等含原生模块；不能把 macOS、另一架构或不匹配的 Linux 构建目录直接搬入生产。生产缺少对应 Node.js 时，其运行时及系统依赖也需通过组织允许的离线渠道准备。

### 3.1 联网构建机

以下命令在**没有私有数据和配置的干净源码检出**中执行；保留失败退出状态，不带病生成交付包。建议在与生产一致的构建镜像中操作。

```sh
set -eu
mp_sha=$(git rev-parse HEAD)
mp_output=$(mktemp -d)
mp_stage=$(mktemp -d)

npm ci
npm run check
npm run verify:standalone-package
npm pack --pack-destination "$mp_output"

# 当前版本的包名；版本变动后以 npm pack 实际输出为准。
mp_package="$mp_output/mindpond-0.1.0.tgz"
sha256sum npm-shrinkwrap.json > "$mp_stage/SOURCE-LOCK.sha256"
printf '%s\n' "$mp_sha" > "$mp_stage/SOURCE-COMMIT.txt"

# 创建干净消费目录，实际安装全部运行依赖及所需原生模块。
(
  cd "$mp_stage"
  node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("package.json", JSON.stringify({name:"mindpond-offline-runtime",version:"1.0.0",private:true}));'
  npm install --omit=dev --no-audit --no-fund "$mp_package"
  npm ls --omit=dev --all --json > DEPENDENCIES.json
  node -e 'console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules,napi:process.versions.napi},null,2))' > RUNTIME.json
  node --version > NODE-VERSION.txt
  npm --version > NPM-VERSION.txt
  sha256sum "$mp_package" | sed 's#  .*/#  #' > PROGRAM.sha256
)
cp "$mp_package" "$mp_stage/"

# node_modules 包含依赖、原生模块和许可文件；保留符号链接。
mp_runtime="mindpond-runtime-$mp_sha.tar.gz"
tar -C "$mp_stage" -czf "$mp_output/$mp_runtime" .
(cd "$mp_output" && sha256sum "$mp_runtime" > "$mp_runtime.sha256")
printf '交付目录：%s\n' "$mp_output"
```

另行记录发行版/libc 信息。包哈希用于检查传输损坏，可信来源还须按组织的软件交付流程核验。此运行目录的 `package-lock.json` 由实际消费方安装产生，应用包内保留发布时的 shrinkwrap。

交付前，在**真正禁网**的相同环境解压运行目录并验证两个进程、SQLite、模型及实际宿主接入；用数据库备份副本，不连接生产库。`npm --offline` 只限制 npm 的网络请求，不能证明安装脚本、原生预编译下载器等都不会联网。

### 3.2 离线生产机

1. 导入完整运行目录压缩包、校验文件和运行环境清单，先执行 `sha256sum -c <压缩包名>.sha256`。
2. 解压到新的、按 commit 区分的程序目录，例如 `/opt/mindpond/releases/<commit>/`。保持目录内 `node_modules` 的布局与符号链接。
3. **不需要在生产目录再次运行 npm install / npm ci / npm run build。** 包中已有 `dist` 和运行依赖；Node.js 不包含在上述压缩包中。
4. 启动路径相对于上述解压根目录为：

   ```text
   Web:        node node_modules/mindpond/dist/server.js
   HTTP MCP:   node node_modules/mindpond/dist/mcp-http.js serve ...
   stdio:      node node_modules/mindpond/dist/mcp.js
   维护检查:   node node_modules/mindpond/dist/maintenance.js --db <副本路径> --check
   ```

5. `.env`、账户凭据、数据库、模型和日志留在独立私有目录。显式设置 Web/MCP 相同的 `MEMORY_DB_PATH`，配置既有模型路径。不要把它们打进程序包或提交 GitHub。

如果组织必须采用 npm 缓存交付，应准备**目标完整锁文件所需缓存**，以及安装脚本涉及的原生二进制、编译工具链和系统库，并在真正禁网的干净目录完整安装验收。仅提供 SDK tarball 或 npm 缓存校验成功都不足以代替这一步。依赖不齐时继续运行当前生产实例，暂缓切换；不要先覆盖运行目录再尝试补包。

## 4. 数据库与行为迁移

迁移随新版本初始化自动执行。**新程序首次打开数据库就可能改变结构**；仅启动看看也算迁移，因此先演练副本。各迁移使用 writer 事务，但整个初始化过程不是一个覆盖所有步骤的全局事务；某后续步骤失败时，不能假定所有先前迁移都已撤回。

### 4.1 单一角色模型

- 已有明确的角色与工位对应关系保留。
- 无角色关联的办公室工位会分别创建角色；不会按同名或同一宿主猜测合并。角色数量可能因此增加，人类应核对身份和分工。
- 无法可靠对应真实聊天的显式上下文绑定会撤销。角色及知识保留；回到聊天调用 `role_sync`，在前端按激活编号绑定已有角色，不必为恢复身份重新申请人物。
- 相关工作会话会关闭，领取租约释放；不能把迁移后的空闲动画理解为任务已完成。恢复处理中消息与实际任务现场后再继续。
- 删除身份缓存表 `role_office_contexts`，清除临时响应页；`role-model.v1` 标记避免同一迁移反复执行。
- 不再使用 `roleContext`、重复的 `role_receive` / `role_exchange`；注册 Office 连接的工具目录不再暴露 `work_*`。自动化脚本需改用当前 Office 工具契约，内部存储实现不等于公开接入协议。

### 4.2 稳定角色与当前连接

- 删除 `character_roles.connector_id`；当前连接由有效 `role_bindings` 决定，一个角色最多一个有效绑定。
- 角色目录显示当前宿主类型和连接名称。切换到另一个 Codex / OpenCode 聊天，须核对目标激活编号、同账户及项目授权。
- 显式切换会撤销原聊天和已签发的角色专用凭据，关闭相关工作会话并释放租约；角色 ID、知识、消息、材料和办公室分工保留。需要专用凭据时重新下载；普通宿主凭据不会因此轮换。
- 同一个真实聊天的普通 MCP 重连无需重新激活。连接回收与持久角色寿命不同。

### 4.3 人类、角色和办公室记忆

| 层级 | 角色权限 | 人类权限 |
| --- | --- | --- |
| 人类记忆 | 不因角色批准自动获得读取权限 | 可查看和管理全部归属 |
| 角色私有记忆 | 读写自己保存的知识与明确分配的独立副本 | 可查看、编辑与分配 |
| 办公室共享记忆 | 当前授权成员直接读取；开放办公室中可修改未锁定条目 | 可维护、逐条设为角色只读 |

- 增加办公室命名空间和只读策略表，已有知识不会被批量复制进办公室。
- 历史未分配知识仍由人类管理，不会从标签、内容或宿主名字猜测角色归属。以前误写到人类名下的条目，需要人类在卡片/详情选择“添加给角色”，创建保留来源和版本的独立副本。
- 角色默认检索私有知识及所属办公室知识。`memory_save` 不带 `officeId` 时保存私有知识，带所属办公室 ID 才发布共享知识；它不是选择角色身份的参数。
- 规范可设为角色只读，角色不能修改或删除；人类编辑不自动解锁。暂停/归档办公室对成员只读；退出或撤权后停止访问。
- 永久删除办公室后，相关知识保留给人类查看，角色失去访问；禁止重建相同办公室 ID 来开放保留知识。

### 4.4 客户端与代理

- Office `/mcp` 和 Memory `/memory/mcp` 是独立入口；同时更新 Web 和 HTTP MCP，不能长期混用不同程序版本。
- Codex 原生 `threadId`、OpenCode 原生聊天元数据或会话插件提供身份。OpenCode 的配置 JSON 本身不会安装插件，按生成的连接包同时安装。
- 本机 stdio 有可信聊天元数据时按有效角色绑定解析身份；无匹配或有歧义会拒绝，不降级成人类。没有聊天元数据的可信本机管理调用为人类，仍应限制其配置与文件访问。
- 已启动的 stdio 不会因更新源码或网页而热更新。修改其可执行路径，并在宿主重连 MCP 或重启宿主，随后用 `memory_identity` 核对角色。
- Office 等待最大5分钟，生成的宿主工具期限360秒；反向代理需支持超过6分钟。Web 的 `/ready` 用于就绪检查，HTTP MCP 的端口没有同名健康路由。
- 服务启用管理密钥后，服务密钥不能代替管理密钥。正确配置公开前缀、同源检查和可信代理；升级/重启后可能需要重新登录管理。

## 5. 维护窗口：按这个顺序执行

### A. 切换前

1. 确认依赖、Node.js、模型、完整程序包均在离线环境准备完毕；未完成时不动生产。
2. 用独立备份副本演练启动迁移和恢复，验证角色归属、消息、材料与检索。旧 schema 的检查脚本也须使用对应版本，不把新表不存在误当成数据丢失。
3. 暂停 agent，停止 Web、HTTP MCP、stdio、维护进程等所有数据库写入者；确认无仍指向该库的服务。
4. 保存程序路径、commit、启动配置、账户文件和模型信息，制作 SQLite 一致备份，权限设为600，并实际恢复到另一个新文件核对。

如已安装 Python 3，可用 SQLite backup API 创建一致备份。命令目标必须是新文件；失败就停止升级。也可使用组织现有的等效 SQLite 备份工具。

```sh
python3 - /var/lib/mindpond/graph.db /var/lib/mindpond/backups/pre-upgrade.db <<'PY'
import os, pathlib, sqlite3, sys
source, target = map(pathlib.Path, sys.argv[1:])
fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert not dst.execute('PRAGMA foreign_key_check').fetchall()
print('一致备份完成；仍须演练恢复。')
PY
```

不要在写入时只 `cp graph.db` 而遗漏 WAL。私有配置和凭据需单独备份，不放入公开程序归档。

### B. 迁移与切换

1. 将新程序目录配置为使用原数据库的**完整绝对路径**，不要意外创建一个空库。
2. 保持其它写入者停止，先启动一个新进程完成初始化迁移，检查日志；成功后启动同版本的另一个服务。迁移失败时停止，保存日志与当前库，按回退计划处理。
3. 更新 Web/MCP 的服务启动路径、相关 stdio 路径；按现有 HTTPS 前缀保持两个 MCP 路由。
4. 先由维护者登录、恢复必要角色绑定并完成下表验证，再让 agent 继续工作。

### C. 验收表

| 检查 | 通过条件 |
| --- | --- |
| 程序与依赖 | 两个服务使用同一发布目录；SDK 实际为1.32.1；交付与锁文件哈希可核对 |
| 数据库 | 指向预期库；正文/归属和关键对象 ID 保留，结构完整性与外键检查通过 |
| 健康 | Web 的 `/health`、`/ready` 为200；Office/Memory MCP 真实认证与调用通过，不能只测端口监听 |
| 管理权限 | 服务密钥、角色凭据不能代替管理密钥；前缀登录、退出与 HTTPS Cookie 正确 |
| 聊天身份 | 两个真实聊天可绑定不同角色；同一聊天重连恢复；原聊天在显式切换后失去访问 |
| 角色写入 | `memory_identity` 显示预期角色；保存后其私有库出现新条目，其他角色不可读取 |
| 分层记忆 | 办公室成员可读共享条目，非成员不可读，角色不可修改/删除人类锁定条目 |
| 副本 | 从人类管理页分配后角色库可见；来源、版本保留，修改副本不改变原文 |
| 消息 | 待处理→处理中→完成反馈可恢复；观察不自动领取；等待超过60秒且代理不提前切断 |
| 模型 | 使用原有匹配模型；缺失时明确报告文本降级，空结果不等于没有记忆 |

首次迁移检查允许增加迁移生成的角色和新表，不能要求所有对象数量与迁移前完全相同。应核对**原有对象的身份、正文和归属保留**，并单列新增及预期撤销项。

## 6. 回退

**回退单位是“升级前程序＋匹配依赖＋私有配置＋升级前数据库备份”。** 不只是切换一个 Git 分支。

1. 停止全部写入者，保留当前新库及配置供排查；不要直接在运行中覆盖数据库或删除 WAL。
2. 将升级前一致备份恢复到一个新的私有文件，核对完整性。旧程序指向这个恢复文件，不打开已经迁移的新库。
3. 恢复匹配的程序目录、原生依赖、启动配置与账户文件，再验证 Web/MCP 与宿主。
4. 若升级后已有新消息、记忆或权限变动，恢复备份不会自动包含它们。先保留这些数据，按来源和幂等键评估人工补回；不要直接拼接两个数据库，也不要为了重试重新生成业务 ID。

## 7. 已验证范围与后续记录

`3b83221` 已在开发侧完成完整工程回归、收尾定向回归、独立 npm 安装、已安装 Codex/OpenCode 的真实聊天协议验证以及本机备份恢复核对。它们不代表任意离线生产机器已具备匹配原生库、模型、证书或容量；完整运行目录的目标环境禁网验收仍是交付条件。

以后每次涉及依赖、schema、身份或公开工具变化，都在本文最上方更新程序基线与历史表，并附上对应离线物料和迁移/回退影响。通用启动与 HTTPS 配置见[部署指南](deployment.md)，角色操作见[分层记忆与会话接入](role-memory.md)，程序分发边界见[验证与发布](releasing.md)。

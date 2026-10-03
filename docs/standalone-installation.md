# 独立安装与最小宿主

MindPond 可通过 npm 安装产物、HTTP、MCP 或进程内 SDK 使用，不要求安装某个特定宿主。模型由宿主提供；这里不配置 LLM API key。

本文描述本地打包验证方式，不表示新版本已经发布到 npm。当前验证环境为 Node.js 22；其他操作系统的 SQLite 原生依赖安装仍须单独验证。

## 从源码制作安装包

```bash
npm ci
npm run check
npm pack
```

`npm pack` 会先构建，打包编译产物、工作台、使用文档和示例；不包含数据库、模型、日志、开发源码或 `.env`。`zod` 是直接依赖，不再借用 MCP SDK 的传递依赖。

在另一个目录安装生成的实际 tgz 文件：

```bash
npm install /absolute/path/to/mindpond-0.1.0.tgz
npx mindpond-server
```

工作台默认在 `http://127.0.0.1:7903`。MCP 宿主启动 `mindpond-mcp`，stdout 仅用于协议，日志走 stderr。

## 数据和模型位置

- 显式 `MEMORY_DB_PATH` 优先；SDK 的 `new MindPond({dbPath})` 优先于环境变量，不改写进程环境，不会改变另一实例的数据库。
- 设置 `MINDPOND_DATA_DIR` 时使用其中的 `mindpond.db`。
- 新安装默认使用 `$XDG_DATA_HOME/mindpond/mindpond.db`，未设置时使用用户家目录下 `.local/share/mindpond/mindpond.db`。
- HTTP/MCP 在包内发现旧默认数据库时继续使用旧库，避免升级后看似丢失记忆。两个入口若各有旧库，仍须显式设置相同 `MEMORY_DB_PATH` 才会共享；不会自动合并或移动。
- 模型优先用 `EMBEDDING_MODEL_DIR`，然后兼容既有包内 `models`；新安装默认在 `$XDG_CACHE_HOME/mindpond/models` 或用户 `.cache/mindpond/models` 查找。
- 模型文件不会自动下载。缺失时保留文本检索，通过 `memory_retrieval_status` 或 SDK `retrievalStatus()` 读取 `uninitialized / ready / unavailable / disabled`。未加载不代表已经验证不可用。

模型缺失下的空搜索结果，不足以证明没有相关记忆。需要语义检索时，由操作者准备匹配模型文件并重启；模型名称和目录结构参照现有 embedding 配置。

## 最小 SDK 接入

```js
import { MindPond, driveOrganizationRequest, protocolRulesResponse } from 'mindpond';

const pond = new MindPond({ dbPath: '/absolute/path/to/my-memory.db' });
await pond.init();
try {
  const rules = protocolRulesResponse(); // 将规则交给主 agent；保存其版本。
  const input = {
    content: '本地开发代理监听 localhost:7903；生产部署尚未验证。',
    domain: { kind: 'personal', id: 'default' },
    memberships: [{ spaceId: 'project/local-proxy', memoryType: 'fact' }],
    idempotencyKey: 'host/run/observation-1',
  };
  const { content, ...options } = input;
  const preview = await pond.validateSave(content, options);
  if (!preview.valid) throw new Error(JSON.stringify(preview));
  await pond.save(content, options);
  // 预校验不预占资源，也不产生幂等回执；save 会重新检查当前状态。
} finally {
  await pond.close();
}
```

SDK 是受信宿主接口。将工具交给不受信调用者时，应通过有身份绑定的 MCP/HTTP 边界，而不是把整个 GraphMemory 对象直接暴露给模型。不同 logical session 的标识由宿主决定，不能从模型文本产生。

## 整理驱动器

创建请求后，由宿主决定何时执行；没有执行者不会自动调用模型。

```js
const request = await pond.graph.organizationRequests.createRequest({
  domain: { kind: 'personal', id: 'default' },
  spaceId: 'project/local-proxy', memoryType: 'fact', batchSize: 2,
  idempotencyKey: 'host/user-request/organization-1',
});
const progress = await driveOrganizationRequest(pond.graph, {
  requestId: request.requestId,
  budgetMs: 120000,
  maxAttempts: 2,
  signal: hostAbortController.signal,
  llm: {
    supportsCancel: true, // 仅在真实宿主实现支持时声明。
    async generate(prompt, context) {
      return hostModel.generate({
        prompt,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        timeoutMs: context.remainingBudgetMs,
      });
    },
  },
});
```

示例中的 `hostModel` 和 `hostAbortController` 由宿主实现，MindPond 不接收其 key。模型的限频等待、退避、HTTP 请求和响应读取均须服从同一截止时间，禁止再套独立的完整超时重试。

当前驱动器默认总预算 120 秒、最多两次提案尝试；错误重试携带具体校验反馈。它不等待无限长的模型 Promise；超时后未检查成员在 partial 回执中列出。不支持取消的模型可能继续在提供商处运行，但迟到回复不会提交。外部请求取消会在核心作废所持批次，直接调用旧 jobId 也不能提交。

驱动器只返回当前可执行范围的结果；等待其他执行者时可能返回 waiting。显式短租约也限制本轮模型时间，驱动器不承诺任意长任务无限续租。创建请求使用稳定 idempotencyKey；同 scope 同 key 同载荷返回原 requestId，不同载荷明确冲突。恢复时 next 会核对已持久化的批次提交，补交丢失的报告；已过期且未提交的批次才重新领取，仍有效的其他执行者返回 waiting。不能把回执丢失当作新的模型任务重做。

## 工作期间的记忆形成

读取 `memory_lifecycle_policy` 或[生成的生命周期提示词](memory-lifecycle-prompt.md)，让宿主把真实事件映射到 `memory_lifecycle_prepare`（HTTP `POST /api/host/lifecycle/prepare`；SDK 导出 `prepareLifecycleEvent`）。这不会自动安装宿主 hook。

| 事件/输入 | 返回与下一步 |
| --- | --- |
| start / resume，无待处理发现 | search_required；使用返回的当前项目/session 检索参数 |
| milestone / before_compact / finish，无发现 | review_required；先判断增量，再用原 checkpoint 协议报告实际 saved / no_change / deferred |
| 有完整 observations | deferred；同一事务保存 session 原始证据、来源上下文及持久提取任务 |
| origin=memory / maintenance，或 memory 工具触发 | ignored；不写库、不调用模型，避免递归 |

```js
import { prepareLifecycleEvent, MemoryPipelineManager } from 'mindpond';

const event = {
  kind: 'before_compact', hostId: 'my-host', runId: 'review-1',
  checkpointId: 'module-review-1', sessionId: 'logical-session-1',
  spaceId: 'project/demo', memoryType: 'fact',
  observations: [{
    id: 'storage-module',
    content: '本地存储写入使用事务；只审阅了该模块，跨进程竞态尚未验证。',
    sourceRefs: [{ uri: 'repo:storage.ts', context: 'main', revision: 'actual-source-revision' }],
  }],
};
const captured = await prepareLifecycleEvent(pond.graph, event);
const pipeline = new MemoryPipelineManager(pond.graph); // 不注入 key，也不自动启动模型。
const job = await pipeline.getExtractionJob({
  sessionId: event.sessionId, domains: [{ kind: 'session', id: event.sessionId }],
});
// 将 job.prompt 交给宿主模型；用 job.id、job.attempts 和原始 reply 调用 commitExtraction。
// MCP 对应 memory_extraction_job / memory_extraction_commit。
```

来源版本必须来自宿主实际观察，示例占位值不能照抄。任务材料包含签发的观察 ID；提取回复必须通过 `source_observation_ids` 引用支持它的观察，并保留 `source_message_ids`。核心从任务元数据绑定项目空间和来源，模型文本不能替换它们；无效引用使整批拒绝。提取出的 dimension 可为 fact/decision/lesson/skill，仍留在当前 session。之后通过同一整理服务 synthesize 画像，不自动晋升为 personal/team。

重启或换 agent 重放同一事件时保留原 hostId/runId/checkpointId、sessionId 和 observations；同 key 不同内容拒绝。已保存的发现应引用原 memoryIds 报 checkpoint，不再作为新原文重复投递。相似内容的不同事件不会擅自去重，需要整理判断。

HTTP 开启可信上下文、MCP 绑定启动身份时，省略 sessionId 会使用宿主绑定的当前 session；提取任务领取与提交也按该范围核验。session 关闭后不能继续提交未完成提取。未配置可信身份的历史单用户入口仍保留兼容行为，不提供多用户隔离保证。

没有真实 hook 的客户端使用显式工作流；MCP 无法知道宿主即将压缩或结束。若 MindPond 服务本身不可用，尚未收到持久化回执的观察仍需宿主保留并重投。完整模型预算策略和三种实际客户端的自动事件接线仍在 A04/A05 后续验收范围。

## 标准保存纠错

`memory_save_validate` / HTTP `POST /api/memory/save/validate` / SDK `validateSave`：

- 不写节点、成员、关联、任务、日志或来源观察。
- 返回实际解析的域与位置；完全相同的来源去重，不同来源版本冲突明确拒绝。
- 锚点和关联问题包含数组索引、field、constraint、fix/nextAction；保留合法项，只修正报告项。
- 预校验和最终保存共用锚点规则及关联目标解析；同空间但跨域的目标不能通过。
- 预校验不是幂等回执查询，不保证随后保存时来源、目标或会话状态没有变化。

规则要求同一逻辑保存最多两次修正；无副作用预校验本身不持久化尝试次数，宿主须落实该上限。不能把提示词约定说成服务已强制执行。

## 验证与当前边界

```bash
npm run verify:save-preview
npm run verify:organization-driver
npm run verify:lifecycle
npm run verify:standalone-package
```

最后一项会构建真实 tgz，在临时目录实际 npm 安装依赖，测试 SDK 保存/检索/整理、HTTP 可执行入口和工作台依赖、MCP 启动与规则发现；完成后清理临时库。缺失本地缓存时 npm 安装可能需要网络。

`examples/minimal-host/run.mjs --smoke` 使用合成的 no_change 回复，只证明安装与契约，不证明整理质量或真实 agent 能自行选择正确工具。

Codex、Claude Code、OpenCode 的实际客户端版本、基础接入和增强 hook 仍需单独验收。当前参考宿主测试不能替代三种客户端的兼容性报告，也不能替代语义盲测。

## 可选模型与 GPU 依赖

默认 CPU / 精确索引。作为 npm 包安装时，可用 `ONNXRUNTIME_NODE_INSTALL=skip npm install mindpond` 跳过 ONNX Runtime 额外 CUDA 二进制下载；仓库 `.npmrc` 已设置同样默认。需要 GPU 的管理员再显式选择后端与安装对应运行库，见 [模型、设备与索引](embedding-profiles.md)。若 npm 镜像尚未同步 shrinkwrap 中钉住的版本，可只为本次命令指定 `--registry=https://registry.npmjs.org`，不必修改全局 registry。

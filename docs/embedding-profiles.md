# 可选向量模型、设备与索引

MindPond 不拥有 LLM 凭据。本地 ONNX embedding / cross-encoder 只是检索组件；记忆判断、整理与关联仍由宿主执行。不设置新配置时继续使用现有 MiniLM 和可选中文通道，默认 CPU、精确余弦检索。

配置把三个选择分开：

| 层次 | 选择 | 影响 |
| --- | --- | --- |
| 向量语义 | 模型、版本、池化、维数、前缀、量化、分块参数 | 必须重建独立向量空间 |
| 推理设备 | cpu / auto / cuda / webgpu | 同一语义空间可在不同设备运行 |
| 索引 | exact / hnsw | 同一模型向量的不同查找算法 |

宿主只能选择已配置、正文与活跃锚点全部构建完成的 profile；不能通过工具参数指定模型文件路径、安装模型或替换权重。管理员用配置、CLI 或受 operator 权限保护的 HTTP 接口管理构建与切换。

## 配置与本地模型

复制 `examples/embedding-profiles.json`，设置绝对路径：

```sh
export MINDPOND_EMBEDDING_CONFIG=/path/to/embedding-profiles.json
export EMBEDDING_MODEL_DIR=/path/to/models
```

示例配置：

```json
{
  "defaultProfile": "legacy",
  "buildOnStartup": false,
  "profiles": [{
    "profile": {
      "id": "bge-small-zh-cls",
      "label": "中文 BGE · CLS",
      "model": "Xenova/bge-small-zh-v1.5",
      "revision": "local",
      "dimensions": 512,
      "pooling": "cls",
      "dtype": "q8",
      "queryPrefix": "为这个句子生成表示以用于检索相关文章：",
      "documentPrefix": "",
      "anchorInput": "query",
      "maxLength": 512,
      "maxChunks": 64,
      "chunkOverlap": 32
    },
    "runtime": {
      "device": "cpu",
      "fallbackToCpu": true,
      "timeoutMs": 60000,
      "algorithm": "exact",
      "efSearch": 128
    }
  }],
  "rerankers": []
}
```

最多 8 个 embedding profiles、2 个可选 rerankers。配置不合法会明确拒绝启动。配置路径、模型安装与文件修改由管理员负责；HTTP 与 MCP 使用同一配置、模型目录和数据库才能共享新索引。配置变更后重启相关进程，现有 stdio MCP 需要宿主重新连接。

模型目录结构是 `models/<组织>/<模型>/`，包含该模型的 tokenizer/config 文件和 ONNX 导出：q8 使用 `onnx/model_quantized.onnx`，fp32 使用 `onnx/model.onnx`，q4/fp16 分别使用对应后缀；有外部权重分片时也要完整安装。MindPond 不在启动、检索或构建时下载文件。仓库 `.npmrc` 默认跳过 ONNX Runtime 额外 CUDA 二进制下载，CPU / WebGPU 已捆绑；作为 npm 包安装时使用 `ONNXRUNTIME_NODE_INSTALL=skip npm install mindpond`。需要 CUDA 的管理员可显式设置 `ONNXRUNTIME_NODE_INSTALL=cuda12`，再按官方要求安装匹配的运行库。`revision` 是管理员版本标签，真正隔离依赖已安装 tokenizer / config / ONNX / 外部权重文件的 SHA-256。新 worker 加载前再次核对摘要，避免运行期间替换文件后仍写入旧空间。模型目录应只由管理员写入；版本变化应换目录/配置并重新启动，不要热覆盖正在使用的文件。

导出的预设是候选参数，不表示模型已安装或该硬件已支持它：

| profile | 模型 | 维数 / 池化 | 用途 |
| --- | --- | --- | --- |
| minilm | Xenova/all-MiniLM-L6-v2 | 384 / mean | 保守的小模型选择 |
| bge-small-zh-cls | Xenova/bge-small-zh-v1.5 | 512 / cls | 中文查询，采用查询指令 |
| bge-base-zh | Xenova/bge-base-zh-v1.5 | 768 / cls | 更大中文候选，需实测 |
| multilingual-e5-small | Xenova/multilingual-e5-small | 384 / mean | 多语言，query: / passage: 前缀 |
| multilingual-e5-base | Xenova/multilingual-e5-base | 768 / mean | 更大多语言候选，需实测 |
| bge-m3 | Xenova/bge-m3 | 1024 / cls | 较大多语言候选，需实测内存/延迟 |

可以自定义符合上述 schema 的 ONNX feature-extraction 模型。必须核对真实维数和该模型官方池化/前缀规范；错误维数、非有限值或零向量不会落库。预设窗口默认 512；模型支持更长窗口时，可由管理员调大 `maxLength`，最多 8192，仍需模型与设备实际支持。

长正文按 token 窗口重叠分块，保留多个向量，命中任一块即可回到完整记忆。超过 `maxChunks` 的正文返回 `document_exceeds_chunk_budget`，保留待构建状态，不能以截断后的向量冒充完整覆盖。过长查询明确失败，混合检索的文本通道仍可工作并返回降级状态。分块不会改变原文或增加记忆节点。top-K 按记忆本体去重，使用最佳匹配块；HNSW 会逐步扩大候选窗口，避免一条长记忆的多个块挤掉其他记忆。

## 分批构建、启用与回退

```sh
mindpond-models status --db /path/to/graph.db
mindpond-models devices --db /path/to/graph.db
mindpond-models build --db /path/to/graph.db --profile bge-small-zh-cls --max-items 64 --batches 100
mindpond-models activate --db /path/to/graph.db --profile bge-small-zh-cls
mindpond-models activate --db /path/to/graph.db --profile legacy
```

仓库源码运行时可使用 `node dist/models.js` 替代已安装的命令。每批 1–256 项；正文与锚点都计入覆盖率。完整启用前旧索引不变，原文、来源、关联和 legacy 向量不删除。构建过程中编辑正文或锚点会使旧结果失效，提交时再次核对版本；正文编辑还会删除对应 profile 的旧向量。

启用 profile 后服务按小批量持续补齐新增/修改的知识记忆，重启后恢复已激活 profile 的维护；切回 legacy 后停止该维护，除非配置要求启动构建。相同语义空间的 CPU / GPU 别名只安排一个维护任务，后台无实际变更时不刷 action log。未激活的 profile 默认由管理员显式构建；若要持续维护所有配置空间，使用 buildOnStartup。启用的索引暂时不完整时，默认搜索回到 legacy，并返回 `profile_build_pending`；显式指定未完成 profile 则返回 `temporarily_unavailable`，不会悄悄改用另一个模型。`buildOnStartup: true` 会在每个启动的服务进程为所有配置 profile 安排后台构建；多 MCP 宿主通常只让一个 HTTP 服务承担构建，其他进程保持 false。数据库提交有版本检查，但跨进程推理不会统一调度，重复构建可能浪费算力。

`defaultProfile` 只定义没有持久激活选择时的偏好。管理员显式激活的选择保存在 DB 中并跨重启保留；`activate legacy` 明确退回兼容索引，即使配置默认指向新模型也保留这个回退。

HTTP：

- `GET /api/memory/retrieval/profiles`：配置、覆盖率、实际设备、构建错误与预设。
- `GET /api/memory/retrieval/devices`：后端是否捆绑、NVIDIA 名称与显存。硬件存在不代表推理通过。
- `POST /api/memory/retrieval/build`：`{"profileId":"bge-small-zh-cls","maxItems":64}`，operator 权限。
- `POST /api/memory/retrieval/activate`：`{"profileId":"bge-small-zh-cls"}`，operator 权限。

前端「搜索 → 调整召回参数」可选择模型、算法与重排器；「模型与计算设备」显示覆盖率、分批构建、启用与回退按钮。严格模式需要管理凭据；agent token 不能代替 operator。所有构建/切换均记录 action log。

## 宿主使用

MCP / 原生宿主接口新增 `memory_retrieval_profiles`、`memory_retrieval_devices`，不要求每次任务都探测。宿主或用户选择后，可在 `memory_search` / `memory_brief` 中传递：

```json
{
  "query": "本地服务如何从手机访问",
  "retrievalProfile": "bge-small-zh-cls",
  "vectorAlgorithm": "exact",
  "spaceId": "project-A",
  "memoryType": "knowledge"
}
```

`retrievalProfile: "legacy"` 显式使用兼容检索。客户端连接包可把同一模型配置与目录明确传给 Codex、Claude 和 OpenCode（包括原生插件）：

```sh
mindpond-connect prepare --client opencode --directory /path/to/new-bundle \
  --db /path/to/graph.db --embedding-config /path/to/embedding-profiles.json \
  --model-dir /path/to/models
```

这些路径必须绝对化，并由用户准备；不会把宿主的全部环境或凭据复制到连接包。OpenCode 原生工具也暴露模型、算法和重排参数，高级 `memory_action` 可发现 profile 与设备。

SDK 的 `search`、`recall`、`brief` 支持同样的参数；SDK 构造参数 `retrieval` 接受配置对象。`retrievalDependencies.encoder` 可提供宿主本地编码适配器，但必须与定义一致、输出有限且非零的相同维数向量。依赖注入是受信任程序扩展，不对模型工具开放。无身份标记的预计算向量不能指定新 profile。

检索响应包含实际 profile、设备、算法和降级状态。正文向量与锚点向量在同一个模型空间中生成；文本入口仍独立参与混合融合，涟漪继续使用原关联权重。session / personal / team、space 与类型过滤在精确与 HNSW 两种检索中都在 top-K 之前执行。

## GPU 与可选 HNSW

`cpu` 默认；`auto` 在捆绑的 CUDA、WebGPU、CPU 后端中依次尝试，加载和预热成功后才报告 actualDevice。显式 `cuda` / `webgpu` 失败时，`fallbackToCpu: true` 尝试 CPU；false 则返回可观察的失败，文本通道可继续检索。推理放在 worker，队列有界、有超时；一个进程只驻留一个新 profile / reranker，减少小显卡同时加载多个模型的压力。

有 NVIDIA 显卡并不等于 ONNX Runtime 的 CUDA 后端已安装。CUDA/cuDNN 依赖与版本必须按 ONNX Runtime 官方文档配置，MindPond 不自动安装驱动。WebGPU 由运行环境选择适配器，`actualDevice: webgpu` 本身不能证明使用了 NVIDIA 独立显卡。GPU 渲染与向量推理是两条不同路径。

HNSW 为可选原生插件：

```sh
npm install --no-save --package-lock=false hnswlib-node@3.0.0
```

持久部署应在宿主项目依赖中钉版，而不是依赖临时 node_modules。未安装或不支持该平台时自动使用 exact，并在响应说明。索引由 DB 中的向量构建，不依赖可移植性较差的原生索引文件。过滤先于 top-K；HNSW 是近似检索，不能保证每次都与 exact 同序。需要最稳定结果或记忆规模较小时保留 exact。

## 可选 cross-encoder 重排

配置 `rerankers` 后，通过查询参数 `reranker` 选择；默认关闭。例如：

```json
{
  "profile": {
    "id": "my-reranker",
    "label": "本地查询正文重排",
    "model": "my-org/my-onnx-sequence-classifier",
    "dtype": "q8",
    "maxLength": 512,
    "maxCandidates": 32
  },
  "runtime": { "device": "cpu", "timeoutMs": 60000 }
}
```

它必须是支持成对输入的 ONNX sequence-classification 导出，单 logit 或两个相关性 logits；不是任意 embedding 模型。只重排已在合法范围内召回的前 N 个候选，保留其余候选与原始涟漪分数，再应用输出数量 / 上下文预算。重排异常保留原候选顺序并说明失败。`maxLength` 对成对输入进行截断，结果只是排序参考，原文、锚点与关联不会被重写。本轮已验证排序契约、失败回退与预算装配；未安装和实测更大的真实 cross-encoder，因此不默认推荐它。

## 本机验证与边界

运行 `npm run verify:embedding-profiles` 检查模型隔离、未完成启用拒绝、正文/锚点覆盖、构建编辑竞争、域过滤、回退、HNSW 与重排契约。`npm run eval:embedding-profiles` 仅使用 8 条公开人工样例，本地真实模型对比，无私人记忆和远程服务调用。报告保存在 `evals/results/embedding-profiles-local-2026-10-02.json`。

模型与执行设备必须在目标机器上单独评估；公开样例只验证管线，不证明真实任务质量或独显加速收益。模型权重不随仓库或 npm 包分发，授权与来源见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

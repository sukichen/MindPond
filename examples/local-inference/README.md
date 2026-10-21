# 明确选装的本地向量运行库

基础 MindPond 不安装此目录的依赖。只有需要本地 ONNX 语义检索、向量重排时才准备它；办公室通信、记忆正文读写和文本检索不需要它。

在匹配目标 OS/架构/libc/Node 的联网构建环境中：

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci --prefix /absolute/path/to/local-inference
```

`/absolute/path/to/local-inference` 指本目录的副本，内有本文件旁的 package.json 与 npm-shrinkwrap.json。离线机器使用构建好的完整目录，或提前备好该锁文件的缓存、原生二进制及系统库；只复制 manifest 不能代替完整安装。不要把该目录复制进 MindPond 默认 node_modules。

在 Web/MCP/stdio 的宿主环境设置：

```dotenv
MINDPOND_LOCAL_INFERENCE_ROOT=/absolute/path/to/local-inference
MINDPOND_EMBEDDING_MODE=auto
EMBEDDING_MODEL_DIR=/absolute/private/models
```

运行目录由受信管理员配置，模型工具参数不能改变路径。安装/移除运行库后重启服务。已有模型名称、维数、池化及权重保持一致，原有向量和正文不因拆包而删除。

要明确使用纯文本模式，设置 `MINDPOND_EMBEDDING_MODE=text`；它不加载本地推理运行库，语义向量召回不会工作，但正文、归属、消息和图结构保留。这是能力变化，不应作为与原向量搜索等效的静默生产升级。

本目录锁定 Transformers.js 4.3.0，及其 ONNX、Sharp 和平台库。它包含与基础包不同的许可证范围：Transformers.js 为 Apache-2.0，部分 Sharp/libvips 组合二进制声明 LGPL；实际分发还需保留对应库、codec 与模型权重的许可证、通知及适用的源码/替换义务。不是“只有一个 Apache 包”。清单见根目录 `licenses/inventory.json` 的 `optionalLocalInference`，该清单不等于已完成所有二进制和模型的合规审核。

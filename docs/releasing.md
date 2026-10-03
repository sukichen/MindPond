# 验证与发布

此仓库只分发程序、通用文档和人工编写的合成 fixtures。私人使用记录、线上基线、数据库、截图中的个人内容和模型权重不属于公开测试材料。

```sh
npm ci
npm run check
npm run verify:standalone-package
npm run verify:client-bundles
npm pack --dry-run --json
```

核心 `check` 使用隔离数据库、确定性向量及协议回归。`verify:standalone-package` 创建真实 tarball，在干净消费目录安装并验证 SDK、HTTP、MCP 和依赖。客户端契约测试需要对应 CLI；真实模型自主使用和语义整理仍需单独评估。GitHub CI 使用可公开安装的 CLI 检查配置，不使用个人账号或生产库。

`verify:release` 扫描拟发布源码、编译结果和 npm 清单，拒绝常见私人文件、硬编码凭据、本机路径、私人评估目录和未列入白名单的材料。测试伪密钥只按少量明确路径和值放行。检查不是通用秘密识别器；每次发布仍应审查 diff、文件清单、fixtures 的内容和截图。不要对原始用户资料只替换姓名后声称匿名。

新增公共文档时更新 package.json 的明确文件列表，并审查其数据来源。`npm run verify:licenses` 核对锁文件和第三方许可清单；依赖变化后运行 `node scripts/generate-license-notices.mjs` 更新声明，并人工核查新许可及实际捆绑代码。

真实模型评估只接入明确的宿主适配器，凭证留在宿主；运行材料与回复保存到仓库外。使用相同任务、代码快照、模型与上下文预算比较直接检索、涟漪、锚点和整理，同时保留失败与无须记忆的任务。评价事实和条件保留、误用、实际采用、维护成本及最终任务结果，不能只看记忆条数或合法 JSON。

项目使用 MIT；第三方依赖与模型维持其自身许可。当前源码/npm 包不捆绑原生依赖和模型权重。若发布 Docker、离线依赖包或单文件可执行程序，须额外核查所含二进制、codec、模型的通知、源码和用户修改/替换条件。

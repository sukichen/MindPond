# 整理质量实验与独立评分

MindPond 提供隔离数据库中的整理实验驱动器。核心不读取宿主私有设置，也不保存模型 key。宿主以 ES 模块提供 `generate(prompt, context)`，并准确回报实际模型 ID、参数和用量。没有适配器时，命令输出 `not_run`，退出码为 2；不会把无模型的结构检查伪装成效果结论。

## 运行

先复制 [9 组起步样例](../evals/datasets/organization-quality-seed.json) 的结构，构建至少 120 个**独立来源组**，开发集和保留集按组切分。种子样例仅用于检查实验管线，不能满足发布门槛。每组提供原始记忆、原有关系与当时的 reason/context、必要事实、禁止推断和期望是否克制/补关系。标签不进入整理模型的任务材料。

宿主适配器应导出如下对象；`context.signal`、`context.turnDeadlineAt` 必须传入真实模型调用。模型凭证只留在宿主进程。下面是接口形状，`hostModel` 由接入方自己实现：

```js
export default {
  id: 'my-host-eval',
  modelId: 'provider-returned-exact-id',
  kind: 'live',
  parameters: { temperature: 0, maxOutputTokens: 2048 },
  supportsCancel: true,
  async generate(prompt, context) {
    const reply = await hostModel.generate({
      prompt, signal: context.signal,
      deadlineAt: context.turnDeadlineAt,
      temperature: 0, maxOutputTokens: 2048
    });
    return {
      text: reply.text,
      modelId: reply.modelId,
      usage: {
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cost: reply.cost,
        currency: reply.currency
      }
    };
  }
};
```

```sh
npm run eval:organization-quality -- \
  --dataset /absolute/organization-dataset.json \
  --adapter /absolute/host-adapter.mjs \
  --output /absolute/results/organization-run.json
```

运行记录含完整提示词、模型回复、校验/提交进度、最终活跃记忆、关系、重试、耗时与用量。输出文件以 0600 权限创建，路径已存在会拒绝覆盖。临时数据库运行后删除。若提供的模型 ID 与实际回复不一致，该批次失败。宿主若不能回报用量，报告会明确列出 `callsWithoutUsage`；不能据此声称成本已测准。

## 独立评审

整理模型的回复和运行结果本身不构成语义真值。第二位评审者读取报告，逐项填写每个案例的事实是否仍可由最终活跃记忆和可追溯来源取得、是否直接出现在可用正文中；逐项核对禁止结论、关系条件、该保持不变的案例，以及严重错误。不能只看合法 JSON、提交成功或记忆数量。

评审 JSON 的顶层字段为：

```json
{
  "runDigest": "复制运行报告的 reviewDigest",
  "reviewerId": "独立评审者标识",
  "independent": true,
  "cases": [
    {
      "caseId": "dev-proxy",
      "severeErrors": [],
      "facts": [{"id":"port","preserved":true,"direct":true,"evidence":"最终正文或可追溯来源的位置"}],
      "forbidden": [{"claim":"禁止推出的完整结论","absent":true,"evidence":"检查过的最终正文"}],
      "restraintCorrect": null,
      "validOutcome": false,
      "associations": [{"id":"最终关系 ID","valid":true,"evidence":"原场景及当前限制"}],
      "requiredAssociationIds": [],
      "notes": "差异与裁决"
    }
  ]
}
```

`requiredAssociationIds` 只填本轮新增、在最终结果中仍有效、且确实满足该案例目标的关系 ID；预存关系或其他无关新关系不得填入。需要补关系却没有形成时填空数组，计为漏关联。`validOutcome` 要按案例的目标判断整理结论是否正确：重复记忆被无条件判为 `no_change`，即使接口合法，也不能算任务正确。每个事实、禁止结论和最终关系都必须有记录；`cases` 中要包含运行报告的全部案例。`runDigest` 绑定具体运行文件，篡改或混用版本会拒绝评分。提交时使用新输出路径：

```sh
npm run eval:organization-quality -- \
  --run /absolute/results/organization-run.json \
  --judgments /absolute/results/independent-judgments.json \
  --output /absolute/results/organization-grade.json
```

当前实验驱动器的评分门槛为：保留集严重错误为零、关键事实保留至少 98%、应克制案例至少 95%、关系 precision 至少 95%、工程完成至少 95%。另要求至少 120 个独立来源组、保留集至少 40 组、主要类别各至少 5 例；需要新建关系的案例只计整理后新增且被独立评审认可的关系；预存的关联只参与保留和精度检查，不能充当新关系的召回。保留集至少 5 例明确需要补关系，不能全部不建边取得高 precision。任何未评审、样本不足、合成模型或门槛失败均不会得到 `releasePassed:true`。

这个门禁只衡量整理。涟漪检索、多锚点与真实下游任务仍应在冻结查询、相同上下文预算、相同模型设置下做单独消融和对照。起步数据没有覆盖完整类别，也没有真实模型运行记录；当前不能以它证明 MindPond 已提高个人事务准确率。


## 办公室协作与 code review 的真实效果验收

接口回归能证明领取、归档、权限、恢复和字节预算，不能证明模型找 bug 的能力变强。对实际宿主采用以下对照，报告不得把 NOT_RUN 写成通过：

| 条件 | 交给同一宿主的材料 | 需要观察的行为 |
| --- | --- | --- |
| 首次接入 | 冻结代码与相同的任务说明，无额外记忆 | 是否自主发现可用工具、领取并完成消息，在困难问题后保存有来源的经验 |
| 重连恢复 | 中途断开后重连到同一角色 | 是否找回 processing，不重复已完成的外部操作，不丢失消息与结果 |
| 无记忆对照 | 全新隔离记忆域，同一代码版本、模型及预算 | 独立裁定真阳性、漏报、误报，记录用时与实际 token 用量 |
| 记忆复用 | 新会话读取前次真实沉淀的记忆，同一代码与预算 | 是否实际检索、核验当前源码、减少重复探索；调用成功或提示词中出现不能当作已使用 |
| 过时记忆 | 改动代码版本，保留明确较旧的真实记忆 | 是否识别失效前提、回到当前代码验证，更新来源或报告不确定性 |

固定至少三个独立缺陷案例及三个无缺陷案例，交替运行条件顺序，每个条件重复多次。预先冻结已知缺陷、可接受证据和评审标准，标签不进入执行提示。人工独立核对输出；测得的提升只限于实际测试的模型、宿主版本、预算和数据集。角色的消息、材料编号、正文 get 返回的 sourceRef、memory_brief 的 recallId 与实际使用报告可组成证据链。报告和运行记录写在仓库外的私有目录，不能带本地数据库、会话内容或凭据发布。

verify:office-message-cycle / verify:office-connection 及真实 HTTP、浏览器回归验收工程契约。MCP Tasks 已在固定认证会话中接入并验证 SDK 协商，其他宿主仍须实际协商；任务句柄不等于唤醒已停止的模型。真实模型部分结果与尚未完成的范围见下文，不给出未经证实的收益百分比。


### 可执行的办公室对照驱动器

`eval:office-collaboration` 使用真实隔离 SQLite + MCP，宿主模块提供 `chat(messages,tools,signal)`，回报实际 modelId 与 inputTokens/outputTokens。核心不读取模型密钥。每轮包含3个缺陷、3个正确代码案例，以及首次接入、经验复用、收件后重启、并发冲突、误导消息5个场景。三组 none / recall / recall_save 分别不给记忆工具、只检索、检索并保存；新会话使用前一真实模型在虚构环境中实际保存的经验。每轮交替条件顺序；生产者没有成功保存则比较无效。只读代码与环境检查器是虚构夹具，不能声称执行了真实项目测试。

```sh
npm run eval:office-collaboration -- --adapter /private/host-adapter.mjs \
  --output /private/new-office-run.json --repetitions 2
npm run eval:office-judge -- --report /private/new-office-run.json \
  --template --output /private/new-judgment-template.json
```

适配器接口见 `src/eval/office-collaboration.ts` 的 OfficeEvalAdapter。逐次模型调用、工具请求/回执、消息和容器结果、耗时与用量写入私有报告，旁边的 `.runs.jsonl` 每完成一例同步保存，推理服务失败后停止后续消耗。评审者核对原始证据后填写模板中的每例结论和 notes，再运行：

```sh
npm run eval:office-judge -- --report /private/new-office-run.json \
  --judgments /private/completed-judgments.json --output /private/new-office-grade.json
```

报告/每例的 SHA-256 防止混用或修改评审对象；缺项、重复、篡改会拒绝。汇总真阳性/误报/漏报/真阴性、完成质量、源码读取、时间和用量；不以合法工具调用或多存记忆自动判好。67例（含生产者）的小型夹具只支持描述性比较，不支持统计显著性或生产收益结论。原生 CLI 提示词开销应包含在实测用量中，生产者成本单列。无需模型的默认 check 不执行付费推理，真实宿主报告不进入开源仓库。

### 2026-10-19 的实际运行与限制

使用已安装 Codex CLI 的 `gpt-6.1-sol` 别名、low 推理设置执行真实推理；后端精确快照未公开。独立原生 MCP 长调用实测等待 300018ms，并收到客户端确认。它证明该测试宿主允许五分钟调用，不代表所有聊天的配置均正确，也不证明后台唤醒。

最新对照运行保存了25条运行记录：24条完成推理，第25条遇到原生 CLI 用量上限而停止；完整67例未完成。源码哈希、逐次用量、工具回执与独立逐例评审保存在本机私有目录，没有发布到仓库。已完成的18次代码 review（3个缺陷、3个正确案例，各跑三组一次）结果如下：

| 条件 | 真阳性 / 真阴性 | 误报 / 漏报 | 源码读取次数 | 原生输入 / 输出 token |
| -- | -- | -- | -- | -- |
| 不使用记忆 | 3 / 3 | 0 / 0 | 24 | 543501 / 2349 |
| 只检索记忆 | 3 / 3 | 0 / 0 | 24 | 619835 / 2799 |
| 检索并沉淀 | 3 / 3 | 0 / 0 | 24 | 770590 / 4058 |

这些简单案例没有显示缺陷发现或源码读取的改善；输入 token 包含原生 CLI 包装和每轮传入的工具契约，不能单独归因于 MindPond 的生产开销。经验复用场景中，已完成的只读记忆组读取2份当前环境来源，无记忆组读取3份；第三组未完成，不能据此宣称整体节省。另一轮不完整运行不与本轮拼接成完整对照。

首次接入评测还暴露夹具问题：管理员已批准角色，却仅把旧的 pending 工具回执交给模型，遗漏了外部审批通知。两次接入因此停在待批准，不能当作记忆效果差异。当前夹具在实际审批提交后明确投递并记录该通知；默认工程回归已验证三组都能接到通知、领取并完成消息，但此项使用脚本推理，只证明夹具契约。修正后的真实模型接入、其余协作场景和第二轮对照仍需额度恢复后重新验证。当前独立评审保持 `comparisonValid=false`、`releasePassed=false`，不把工程回归或部分结果写成效果验收通过。

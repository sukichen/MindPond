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

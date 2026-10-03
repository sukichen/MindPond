# 用户定义维度与提示词

工作台的「维度与提示词」可以新增、编辑和停用维度。新安装默认优先使用五个复用视角：`profile`（人物与偏好）、`commitment`（约定与目标）、`environment`（工具与环境）、`work`（项目与工作知识）、`practice`（方法与经验），默认身份为 `work`。原来的 fact / decision / lesson / skill 标注为历史兼容，保留启用以允许旧宿主的显式身份和旧计划重放；不是新知识的推荐分类。它们可以由用户停用或在没有历史引用时移除。没有四种或十六种维度数量上限。一个记忆可有多个配置身份；多维桥梁仍只在同一空间和 domain 内生效。

每份配置包含：
- `definitions`：稳定 `id`、显示名称 `label`、含义 `description`、维度专用提示词 `instructions`、节点颜色 `color`、允许新记忆使用的 `enabled`。
- `defaultDimension`：必须指向一个启用维度，用于没有显式选择身份的知识保存。
- `prompt`：通用分类规则，和各维度的提示词一起交付 agent。
- `revision`：修改时提交 `expectedRevision`；冲突时重新读取，避免覆盖另一用户的编辑。

至少保留一个启用维度。ID 可含中英文、数字、点、下划线、冒号和连字符，最长 128 字符。定义、提示词及请求仍有字节/字符资源预算；这些预算不是固定分类数量限制。单次最多 16 个显式项目空间和最多 6 个锚点的既有限制继续生效，维度自动展开的成员不再受 16 个限制。

## 默认与已有实例

默认定义、颜色和分类提示词来自 `src/core/dimension-config.ts`，不依赖任何宿主或私人数据库。初始化只对没有配置的新数据库插入默认模板，已有数据库（包括 revision=1 的旧四维模板和用户自定义配置）均原样保留。升级代码不等于迁移已有实例；用户可在「维度与提示词」编辑、预览自己的配置后保存。已有记忆的分类迁移必须另行执行。

导出的保存、宿主、整理和协议提示词展示当前的新安装默认配置，并注明静态模板的范围。运行时 `memory_brief`、`memory_save_policy`、整理任务和提炼任务以该数据库的实际配置为准。新知识的 membership memoryType 应使用当前配置中的 dimension ID；项目放入 space，子主题放入 tags，不另造一套分类。

## 历史与生命周期

已有记忆不会因配置变化而自动重分类、合并或建边。改显示名称不改变身份；改 ID 等同创建新身份。被历史记忆引用的 ID 不能直接移除，可设置 `enabled:false` 停用。停用后仍可检索旧记忆、保留原身份进行修订；新记忆不能再选择它。需要重新分类时，通过普通的版本校验编辑功能处理记忆，再移除没有引用的定义。

`event` 仍是原始证据类型，而不是用户知识维度；不能拿它创建知识身份。Domain 与空间隔离、来源核验、团队写入授权不受分类提示词影响。

## 接口与 agent 发现

- 用户配置：`GET /api/memory/dimensions`；`POST /api/memory/dimensions` 提交完整配置和 `expectedRevision`。严格权限模式下写入必须有 operator 能力。MCP 不暴露修改配置的工具，宿主不应把 operator 身份交给普通 agent。
- agent 读取：`memory_dimension_policy` 返回定义、原始自定义提示词、组装后的分类说明及 revision。
- `memory_protocol_rules` 和对应 MCP resource / HTTP 规则接口注入当前分类说明。保存策略、提炼提示、整理任务也注入真实配置，不能只靠更新一份静态 Markdown。
- `memory_brief` 同时交付当前分类策略。支持 `sinceDimensionRevision`：agent 已缓存相同版本时只收到 revision，不重复发送长提示词。协议规则版本和用户分类版本分别缓存；分类规则变了也会交付新策略。
- 配置改变后，未完成的整理快照提交会被拒绝；提炼租约回到待领取状态，新领取会增加 attempt 并拿到新规则。应答丢失的已提交回执保持原有幂等语义。

示例配置（可以完全替换默认模板；若默认 ID 已被引用，应先停用保留）：

```json
{
  "expectedRevision": 1,
  "defaultDimension": "profile",
  "prompt": "只选择正文已有证据支持的身份；保留适用范围和不确定性。",
  "definitions": [
    {"id":"profile","label":"人物画像","description":"用户明确说明的长期特征或偏好。","instructions":"不可从一次行为推断稳定偏好；记录确认来源与适用场景。","color":"#55b8ff","enabled":true},
    {"id":"procedure","label":"操作方法","description":"可以重用的操作步骤。","instructions":"保留触发条件、先决要求、步骤、结果检查与失败处理。","color":"#5af0bc","enabled":true}
  ]
}
```

配置绑定一个 MindPond 数据库，不绑定 rpbot；多个 agent 共享同库就读同一份规则，不同数据库互不影响。直接使用 npm 库的宿主也可调用 `getDimensionConfiguration`、`getDimensionPolicy`、`configureDimensions`。配置变更不会自动重分类已有记忆；迁移须单独预览和确认。

验证：`npm run verify:custom-dimensions` 使用隔离 SQLite 库，覆盖 20 个身份、中英文 ID、动态默认、旧 SQLite 标量兼容、提示注入、停用和删除保护、规则变化后的租约/快照拒绝及重启恢复。

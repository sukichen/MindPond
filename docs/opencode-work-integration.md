# OpenCode 角色记忆接入

推荐在“宿主连接”下载 Office 与 Memory 配套配置，并安装随配置生成的签名会话插件。每个真实 OpenCode sessionID 独立绑定角色，同一聊天重连恢复原角色。[完整步骤与权限规则](role-memory.md)。

本机单独 Memory 可生成原生适配器：

```sh
mindpond-connect prepare --client opencode --directory /absolute/connections/memory --db /absolute/data/mindpond.db
mindpond-connect run --directory /absolute/connections/memory
```

Office 必须使用同一数据库。插件把宿主给出的真实 sessionID 交给 Node worker；worker 调用与 HTTP/stdio 相同的分层 Memory：未绑定聊天为人类，绑定后使用角色和当前办公室知识。不能通过 personal/work 域或模型参数选择身份。

可直接调用 `memory_identity`、`memory_brief`、`memory_search`、`memory_get`、`memory_directory`、`memory_save_policy`、`memory_capabilities`。`memory_capabilities` 返回实际高级目录，包含图维护、历史、画像、反馈、批处理和整理恢复。`memory_action` 的 `describe:true` 返回某个记忆操作的实际 schema；例如先查看 `memory_save` 的 schema，再保存验证过的知识。工具参数没有身份选择权。

已识别但未绑定角色的聊天（包括待批准申请）为人类，可以访问全部知识；角色获批后立即按角色隔离。宿主停用、已绑定角色停用、身份缺失或冲突时拒绝。必须核对同一数据库，另一数据库无法知道这里的绑定。绑定后 Office 的 `role_sync` 和 Memory 的 `memory_identity` 应显示同一角色及绑定编号。

这套适配器不再自动保存聊天原文，也不运行 session/domain 提取与维护入口。已保存资料保留，由人类工作台管理。曾使用个人域插件的部署应重新生成目录并重启 OpenCode；保留已有 outbox 文件供人类核对，不自动将其发布到角色或办公室。

# OpenCode 角色记忆接入

推荐在“宿主连接”下载 Office 与 Memory 配套配置，并安装随配置生成的签名会话插件。每个真实 OpenCode sessionID 独立绑定角色，同一聊天重连恢复原角色。[完整步骤与权限规则](role-memory.md)。

本机单独 Memory 可生成原生适配器：

```sh
mindpond-connect prepare --client opencode --directory /absolute/connections/memory --db /absolute/data/mindpond.db
mindpond-connect run --directory /absolute/connections/memory
```

Office 必须使用同一数据库。插件把宿主给出的真实 sessionID 交给 Node worker；worker 调用与 HTTP/stdio 相同的角色 Memory，不能另设 personal/work 域或模型指定身份。

可直接调用 `memory_identity`、`memory_brief`、`memory_search`、`memory_get`、`memory_directory`、`memory_save_policy`。`memory_action` 的 `describe:true` 返回某个角色记忆工具的实际 schema；例如先查看 `memory_save` 的 schema，再保存验证过的知识。工具参数没有身份选择权。

角色未批准、聊天未绑定、宿主停用、数据库不匹配时拒绝访问；不会回退成人类。Office 的 `role_sync` 和 Memory 的 `memory_identity` 应显示同一角色及绑定编号。

这套适配器不再自动保存聊天原文，也不运行 session/domain 提取与维护入口。已保存资料保留，由人类工作台管理。曾使用个人域插件的部署应重新生成目录并重启 OpenCode；保留已有 outbox 文件供人类核对，不自动将其发布到角色或办公室。

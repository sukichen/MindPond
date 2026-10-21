# CLI 角色接入

默认入口是网页“宿主连接”，配置独立的 Office 与 Memory HTTP MCP。CLI 配置包提供启动与取信快捷命令，不是另一套身份模型。

## 准备配置包

先在网页登记宿主连接，签发凭据并由用户存入宿主秘密设置。不要把凭据发送到聊天。

```sh
mindpond-connect office-prepare --client codex \
  --directory /absolute/mindpond-client \
  --remote-url https://memory.example/mcp \
  --token-env MINDPOND_TOKEN
mindpond-connect office-run --directory /absolute/mindpond-client
```

目录必须是新的绝对路径。准备命令只记录环境变量名字；启动时由用户或秘密管理工具注入变量值。OpenCode 把 `--client codex` 改为 `--client opencode`，配置包同时生成会话插件。

Codex 配置原生 HTTP MCP 和 `$mindpond-inbox` Skill。OpenCode 配置原生远程 MCP、会话插件和 `/mindpond_office_get_message` 命令。配置包不调用模型、不打开中心数据库、不读取聊天库，也不能唤醒停止的聊天。

## 申请与使用

在聊天中说：“去 MindPond 申请一个角色，名字自己取，介绍由你自己写。”聊天调用 `role_application`，用户在网页“角色与申请”批准。回到该聊天调用 `role_sync` 同步；等待审批时不要循环调用模型。

取信命令先同步身份、恢复处理中消息，再调用 `office_receive` 携带稳定 key 领取待处理消息。处理后用 `office_message finish` 反馈并归档。纯查看使用 `action=list`，查看或超时都不代表处理完成。

## 同一宿主的多个聊天

Codex 使用每次调用的真实 `threadId`；OpenCode 通过会话插件传递已验证聊天标识。两个聊天可以共用一个宿主配置并分别申请角色。同一真实聊天重新连接恢复同一角色；HTTP 传输连接和配置包编号不代替聊天 ID。角色详情中的“切换连接”可将同一个角色迁到另一宿主的目标聊天，知识、消息和办公室分工保留；账户及项目授权边界仍然有效。

没有可靠聊天标识时，`role_sync` 返回激活编号。用户在网页核对编号后将已有角色连接到当前聊天；也可以为独立宿主配置角色专用凭据。工具参数不能自选角色，未绑定角色的 agent 不能读取人类记忆。共享凭据不构成对恶意客户端的密码学隔离。

## 办公室与知识

创建办公室时选择已批准角色，称呼和职责可自由填写；可以先建空房间。角色可参加多个办公室，但只能访问明确分配的办公室。角色停用、换聊天或撤权会使对应访问失效，重新启用不会恢复已失效的绑定版本。

角色消息、资料和记忆随稳定角色保留。Memory 使用独立 MCP，角色可读写自己的知识，并读取所属办公室的共享知识；共享条目由人类决定是否允许角色修改；用户可搜索记忆并给指定角色创建带来源和版本的独立副本。

## 验证边界

`npm run verify:roles` 验证 HTTP MCP、审批、重连、消息闭环、权限、数据迁移与配置生成。`verify:codex-role-session` 使用本机 Codex app-server 的两个真实线程及工具直接调用，验证原生元数据、角色隔离和 MCP 重载，不启动模型轮次。`verify:opencode-role-session` 使用本机 OpenCode 两个真实聊天和无回复请求验证插件身份，模型推理另需目标环境验收。

详见[协作办公室](collaboration-offices.md)、[角色记忆](role-memory.md)、[部署说明](deployment.md)。

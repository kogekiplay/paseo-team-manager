Paseo 团队管理（Paseo Team Manager）为 Paseo 顶层对话自动注入团队指挥编排规范、角色预设与团队状态视图，让每个项目会话开箱即可按团队分工调度子智能体协作。

## 工作方式

当智能体会话打开时，插件在 `agent.open.before` 钩子中检查会话标签与元数据，自动跳过历史回放（`purpose === "history"`）与后台辅助会话（`background === true`）：

- 顶层会话（不含 `paseo.parent-agent-id` 标签）按以下优先级判定是否启用指挥模式：单会话元数据覆盖 > 工作区或目录覆盖 > 排除目录规则 > 全局默认开关。启用时，插件向该会话追加结构化指挥系统指令，并挂载只读工具 `team_get_roster`。
- 角色子智能体（含 `paseo.parent-agent-id` 且带 `paseo-team-manager.role` 标签或元数据）不会收到指挥指令，仅追加对应角色的专属职责与回报规范。

指挥始终通过 Paseo 原生 MCP 工具 `create_agent` 与 `send_agent_prompt` 调度子智能体，从而完整保留 Paseo 内置的 Subagents 轨道、`notifyOnFinish` 完成自动唤醒与消息队列机制。开启参数兜底后，插件还会通过 `agent.create.before` 钩子为新建角色子智能体补齐未显式传入的模型、会话模式、思考深度与 Provider 特性选项。

## 配置与环境要求

需要 Paseo 0.17.1 及以上版本。所有界面组件基于跨平台 React Native 原语构建，支持桌面端、网页端、iOS 与 Android，并适配明暗主题与中英文界面。

可从左侧边栏顶部的「团队管理」入口、打开「设置 > 插件 > 团队管理」，或在输入框运行 `/team settings` 进入管理界面，查看内置的全栈开发团队模板、从当前宿主机实时拉取的 Provider 与模型目录中调整成员配置，以及添加需要跳过的目录（如 `~/Downloads`）。

内置的全栈开发团队模板基于 Codex GPT 路由组与 Antigravity 原生 Gemini 4 系列模型配置，包含两个默认启用的核心角色与三个可选扩展角色：

- `backend`（默认启用）：`codex/auto/gpt-6.2-sol`，思考深度 `xhigh`，模式 `full-access`，`service_tier: "default"`。
- `frontend`（默认启用）：`antigravity/gemini-4-neon`，思考深度 `high`，模式 `full-access`。
- `reviewer`（可选）：`codex/auto/gpt-6.2-astra`，思考深度 `xhigh`，模式 `auto`，`service_tier: "default"`。
- `qa`（可选）：`codex/auto/gpt-6.2-sol`，思考深度 `xhigh`，模式 `full-access`，`service_tier: "default"`。
- `explorer`（可选）：`antigravity/gemini-4-hydrogen`，思考深度 `medium`，模式 `plan`。

## 功能与设置项

- 通用开关：控制团队管理总开关、新顶层会话自动启用指挥模式、输入框团队模式切换控件显示，以及创建子智能体时自动补齐角色默认参数。
- 排除目录：支持 `~/...` 与绝对路径，位于排除目录中的顶层会话默认关闭指挥模式；提供 `~/Downloads` 一键快捷排除。
- 团队模板管理：支持多套团队预设的创建、复制、删除与默认切换，支持配置「指挥禁止直接修改业务代码」开关和自定义指挥补充指令。
- 团队成员管理：支持角色启停、新增与删除自定义角色，直接从宿主机真实目录选择 Provider、模型、思考深度、会话模式及动态 Provider 选项（如 Codex 的 `service_tier` 与 `plan_mode`）。
- 注入指令实时预览：在设置页随时展开查看并一键复制最终会注入给指挥的完整系统指令。
- 多入口快捷控制：保持 Paseo 原生子智能体胶囊结构不变，支持通过输入框工具栏选择器随时切换单会话模式（跟随默认、关闭或指定模板），通过 `/team` 斜杠命令（`status`、`on`、`off`、`auto`、`preset 模板ID`、`settings`）、命令面板（`⌘K`）和团队状态面板查看名册、跳转子智能体或一键重载空闲会话使配置立即生效。

## 数据流向与限制

插件设置、Provider 目录查询与工作区会话状态均仅在 Paseo 客户端与已连接的宿主机守护进程之间本地通信，不会向任何外部服务上传对话内容、代码或配置。

修改插件设置或单会话元数据后，新配置会在会话下次打开或重开时生效。已有空闲会话会在下次发送消息前自动重开，也可在团队状态面板中手动重载以立即应用；正在运行的轮次不会被自动中断。

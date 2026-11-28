# Paseo Team Manager (`paseo-team-manager`) 设计文档

## 1. 背景与目标

让 Paseo 新开的顶层对话（「指挥 / Commander」）**自动知道**自己需要统筹当前工作区项目、如何组建并调度子智能体团队，同时坚持**指挥只负责规划、拆解、派发与验收，不直接修改业务代码**。

本插件面向 Paseo `>=0.17.1`，需要同时兼容桌面端、Web 与移动端（iOS/Android）及明暗主题、中英文界面。

---

## 2. 已验证的 Paseo 0.17.1 技术可行性与关键约束

以下结论均已针对 Paseo 源码与 CLI 验证：

1. **所有已启用 Provider 均原生支持 `agent.open.before` 的 `appendSystemPrompt`**：
   - **Antigravity (`agy 1.5.14`)**：实测 `agy acp --disable-telemetry` 的 `initialize` 响应明确返回 `_meta.antigravity.systemPrompt.append: true`；Paseo 内置 `plugins/antigravity-provider/server/provider.ts` 会将组合后的 `systemPrompt`（含 `appendSystemPrompt`）透传给 Antigravity ACP。
   - **Codex (`codex-cli 0.171.0`)**：版本远高于最低要求 `0.121.0`，Paseo 会将 `pluginAppendSystemPrompt` 写入 `developerInstructions` 并支持会话更新。
   - **Claude**：原生支持 `systemPrompt` 追加，且不污染持久化配置。
2. **顶层指挥 vs 子智能体的精确识别**：
   - Paseo 内部给所有子智能体自动写入标签 `PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id"`（见 `packages/protocol/src/agent-labels.ts`）。
   - 在 `agent.open.before` 钩子中：
     - `request.purpose === "history"` 时应跳过（Paseo 本身也忽略 history 打开的指令与工具）。
     - `request.background === true` 时应跳过（后台 helper 不应被当成指挥）。
     - `!request.labels["paseo.parent-agent-id"]` → **顶层会话（指挥候选）**。
     - `Boolean(request.labels["paseo.parent-agent-id"])` → **子智能体**；若带有本插件标签 `request.labels["paseo-team-manager.role"]`（或 `request.metadata["paseo-team-manager.role"]`），则为其注入对应角色专属指令，而**不要**把指挥指令注入子智能体。
3. **关键避坑：`notifyOnFinish` 自动唤醒机制**：
   - 在 `packages/server/src/server/agent/create-agent/create.ts` 中，只有通过 Paseo 原生 MCP 工具 `create_agent`（`input.kind === "mcp"`）创建子智能体时，Paseo 才会自动注册 `finishSubscriptions` 实现子智能体完成后自动唤醒父指挥。
   - **架构结论**：
     - **主链路必须让指挥使用 Paseo 原生 MCP 工具 `create_agent` / `send_agent_prompt`** 建小弟与派发任务（从而完整复用原生 `notifyOnFinish`、Subagents 轨道、消息队列 `steer`/`interrupt`）。
     - 插件在 `agent.open.before` 中：
       1. 向指挥注入清晰、精确的团队编排 `appendSystemPrompt`（含精确的 `provider`、`settings.modeId`、`settings.thinkingOptionId`、`settings.features` 与 `labels` 模板）。
       2. 向指挥挂载 `team_get_roster` 和 `team_update_member_model`，分别用于查询实时名册与同步计划，以及按用户要求保存当前指挥会话的成员模型覆盖。
       3. 通过 `agent.create.before`，在启用范围内根据新会话自身的显式角色 metadata 补齐缺省参数。父会话的覆盖由指挥从实时名册读取，并通过原生 `create_agent` 参数传递。
       4. 在 `agent.open.before` 中识别到子智能体带有 `paseo-team-manager.role` 标签时，自动追加该角色的专属开发规范与回报格式。
4. **插件热更新与防卡死约束**：
   - 在 `agent.open.before` 中**禁止** `await` 对当前正在打开的 agent 执行 `setMetadata` / `setLabels` / 修改配置（会导致死锁超时）；如需写入必须 fire-and-forget（`void ...catch(...)`）。
   - 修改 `agent.open.before` 或重载插件后，已有会话自动标记 stale，下次空闲发消息前自动重开生效；**绝对不要重启 Paseo daemon**。

---

## 3. 本机实测 Provider 与模型目录（2026-11-23）

### 3.1 Codex（3 个 Magpie 路由组模型）

- 可用 Modes：`auto`（Default Permissions）、`auto-review`（Auto-review）、`full-access`（Full Access）
- 可用 Features：
  - `service_tier`（Speed）：`default`（Normal / 普通，默认）、`flex`（Flex）、`priority`（Fast）、`ultrafast`（Ultrafast，仅部分模型如 `auto/gpt-6.2-sol` 支持）
  - `plan_mode`（boolean）
- 可用 Models（均支持 `low` / `medium` / `high` / `xhigh` / `max`，除 Luna 外支持 `ultra`）：
  - `auto/gpt-6.2-sol`（默认，GPT-6.2 Sol · routing group）
  - `auto/gpt-6.1-terra`（GPT-6.1 Terra · routing group）
  - `auto/gpt-6-luna`（GPT-6 Luna · routing group）

> 自动匹配到 Codex 时，后端成员的 `create_agent` 配置示例
> - `provider`: `"codex/auto/gpt-6.2-sol"`
> - `settings`: `{ "thinkingOptionId": "xhigh", "features": { "service_tier": "default" } }`

### 3.2 Antigravity（8 个模型）

- 可用 Modes：`default`、`accept-edits`、`auto`、`plan`、`full-access`（Full access，`isUnattended: true`）
- 可用 Thinking Options：`low`、`medium`、`high`（默认）、`xhigh`（Extra）
- 可用 Models：
  - `gemini-4-neon`（默认，Gemini 4 Neon）
  - `gemini-4-carbon`（Gemini 4 Carbon）
  - `gemini-4-argon`（Gemini 4 Argon）
  - `gemini-4-hydrogen`（Gemini 4 Hydrogen）
  - `gemini-pro-orchestrator-neon`（Orchestrator (Neon)）
  - `gemini-pro-orchestrator`（Orchestrator (Carbon)）
  - `gemini-pro-orchestrator-argon`（Orchestrator (Argon)）
  - `gpt-oss-120b-medium`（GPT-OSS 120B (Medium)）

> 自动匹配到 Antigravity 时，前端成员的 `create_agent` 配置示例
> - `provider`: `"antigravity/gemini-4-neon"`
> - `settings`: `{ "thinkingOptionId": "high" }`

---

## 4. 默认团队预设与推荐角色

### 4.1 指挥（Commander / 顶层对话本身）

- **职责**：统筹当前工作区项目；理解需求、调研范围、拆解模块、制定接口契约、派发任务给子智能体、验收测试与 diff、向用户汇报。
- **红线（可配置）**：**指挥默认不直接修改项目业务代码**（允许只读检查、查看 diff/日志、跑只读诊断或验收命令），所有代码编写与修改交由对应小弟完成。
- **协作约定**：
  - 建小弟时必须传入 `labels: { "paseo-team-manager.role": "<roleId>" }`，方便插件识别角色与追踪状态。
  - 派发前查询 `team_get_roster`。若本指挥已有同角色健康子智能体，先按同步计划处理配置差异，再用 `send_agent_prompt` 复用。
  - 若任务并行且存在文件写冲突，可为子智能体规划清晰的文件边界或按需使用独立 worktree。

### 4.2 默认核心启用成员

| 角色 ID | 名称 | 默认启用 | Provider / Model | Thinking | Mode | Features | 职责 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `backend` | 后端开发 | 是 | `auto`（宿主机自适应） | 宿主机自适应 | 继承默认权限 | 宿主机自适应 | 服务端/daemon/API/数据层/算法逻辑/单元测试 |
| `frontend` | 前端开发 | 是 | `auto`（宿主机自适应） | 宿主机自适应 | 继承默认权限 | 宿主机自适应 | UI 组件、交互体验、样式主题、跨端响应式适配 |
| `advisor` | 架构顾问 | 是 | `auto`（优先 Antigravity，其次 Codex） | 优先 `xhigh`，其次 `high`、`medium` | 继承默认权限 | 宿主机自适应 | 只读提供架构方案、技术取舍、根因定位与独立第二意见 |

架构顾问的角色指令要求独立分析、给出推荐和风险依据，全程只读。自动匹配优先选择 Antigravity 原生 Gemini 的 `gemini-4-neon`、`gemini-4-carbon`，其次尝试 Codex 的 `auto/gpt-6.2-sol` 或符合条件的宿主机默认模型，再尝试 Claude 或其他就绪提供方。`architect`、`consultant`、`second-opinion` 共用这组匹配偏好。

### 4.3 内置可选扩展成员（预设中预置，可一键开关）

| 角色 ID | 名称 | 默认启用 | 推荐 Provider / Model | Thinking | Mode | Features | 定位 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reviewer` | 代码审查官 | 否（按需开启） | `auto`（宿主机自适应） | 宿主机自适应 | 继承默认权限 | 宿主机自适应 | 深度 Code Review、架构风险/边界条件/安全审计，只审查提意见不改代码 |
| `qa` | 测试与验收 | 否（按需开启） | `auto`（宿主机自适应） | 宿主机自适应 | 继承默认权限 | 宿主机自适应 | 编写单元/集成/E2E 测试、复现 Bug、跑回归验证 |
| `explorer` | 代码库侦察员 | 否（按需开启） | `auto`（宿主机自适应） | 宿主机自适应 | 继承默认权限 | 宿主机自适应 | 极速代码库检索、依赖梳理、日志定位、文档整理，节省主指挥上下文 |

---

## 5. 插件架构设计

### 5.1 共享契约（`shared/`）

- `shared/settings.ts`：
  - 使用 `defineSettings`（`scope: "host"`, `version: 3`）和 Zod schema 定义持久化配置。
    - v1 先执行既有的高成本模型迁移，替换为 `auto/gpt-6.2-sol`。
    - v2 → v3 仅在已保存的 `default-fullstack` 缺少 `advisor` 时补齐角色，优先插在 `frontend` 后，无 `frontend` 时追加到末尾。已有顾问、其他成员配置和自定义预设均保留。
    - `enabled`: 全局是否启用团队指挥模式（默认 `true`）
    - `autoApplyToNewTopLevelAgents`: 是否对新开的顶层会话自动注入（默认 `true`）
    - `excludedDirectories`: 排除目录列表（如 `~/Downloads` 默认可配置跳过，避免闲聊目录也被当成开发项目，默认可留空或提供快捷排除提示，按设置开关决定）
    - `defaultPresetId`: 当前默认团队模板 ID
    - `presets`: 团队模板数组，每个模板包含：
      - `id`, `name`, `description`
      - `commanderNoDirectEdit`: boolean（默认 `true`，指挥不直接改代码）
      - `commanderExtraInstructions`: string（自定义补充指挥规范）
      - `members`: 成员配置数组（`id`, `roleId`, `name`, `enabled`, `provider`, `model`, `thinkingOptionId`, `modeId`, `features`, `responsibilities`, `rolePrompt`）
    - `workspaceOverrides`: `Record<string, { enabled?: boolean; presetId?: string }>`（按项目/工作区路径或 ID 覆盖默认行为）
    - 内置成员使用 `provider: "auto"` 和空模型字段。服务端从宿主机实时目录解析提供方、模型、思考等级与支持的提供方选项。自动匹配和跨提供方回退均省略会话权限模式，继承 Paseo 默认权限。插件仅在用户为实际使用的提供方显式选择权限模式时应用预设值。
  - 常量定义：
    - `METADATA_KEYS`:
      - `teamEnabled`: `"paseo-team-manager.enabled"`（`boolean`，单会话显式覆盖）
      - `presetId`: `"paseo-team-manager.presetId"`（`string`，单会话显式指定模板）
      - `roleId`: `"paseo-team-manager.role"`（`string`，子智能体角色标识）
      - `memberOverrides`: `"paseo-team-manager.memberOverrides"`（指挥会话的角色模型覆盖，按小写 `roleId` 存储）
    - `LABEL_KEYS`:
      - `role`: `"paseo-team-manager.role"`
      - `preset`: `"paseo-team-manager.preset"`
- `shared/contracts.ts`：
  - 插件 RPC 契约（`defineRpc`）：
    - `getProviderCatalogRpc`：读取当前 host 可用 providers / models / modes / features，供设置页下拉选择，避免手写 model ID。
    - `getWorkspaceTeamStateRpc`：查询指定工作区的有效预设、当前指挥会话的覆盖以及现有团队子智能体的同步状态。
    - `previewCommanderPromptRpc`：实时预览当前配置会注入给指挥的完整系统指令，方便用户调试。
- `shared/prompt-builder.ts`：
  - 纯函数，生成：
    - 指挥 `appendSystemPrompt`（结构化 Markdown：身份定位、核心纪律、当前启用团队名册、标准 `create_agent` 参数速查、复用与协作规则）。
    - 子智能体角色 `appendSystemPrompt`（角色定位、负责范围、与指挥汇报格式）。
  - 附完整单元测试。

### 5.2 服务端（`index.server.ts` + `server/`）

- `server.registerSettings(teamSettings)` 订阅并缓存最新配置。
- `server/provider-catalog-cache.ts` 维护宿主机 Provider 目录的轻量内存缓存，首次使用最多等待 2 秒，Provider 目录变化时通过 `paseo.providers.subscribe` 失效并刷新。
- `shared/catalog-defaults.ts` 根据角色偏好解析 `auto` 成员。解析会跳过高成本模型和 Antigravity 中的非 Gemini 模型，只有宿主机确实没有其他模型时才使用高成本候选，并为无法解析的角色保留清晰回退状态。
- `server.addHook("agent.create.before", ...)`:
  - 仅当全局团队开关和当前目录或工作区均处于启用范围，且新创建会话显式携带 `paseo-team-manager.role` metadata 时，补齐/规范化关键默认参数（如 Codex `service_tier`、`modeId`、`thinkingOptionId`），不从标题推断角色，也不破坏显式覆盖。
- `server.addHook("agent.open.before", ...)`:
  - 跳过 `purpose === "history"` 与 `background === true`。
  - 判断是否为子智能体：`Boolean(request.labels["paseo.parent-agent-id"])`。
    - **若是子智能体**：读取 `request.labels["paseo-team-manager.role"]` 或 `request.metadata["paseo-team-manager.role"]`，若匹配到角色则追加角色专属 `appendSystemPrompt`。
    - **若是顶层指挥**：全局 `enabled: false` 是硬总闸。全局开启时再按优先级计算生效状态（会话 `metadata["paseo-team-manager.enabled"]` > 工作区/目录覆盖 > 排除目录规则 > 全局 `autoApplyToNewTopLevelAgents`）。
      - 若生效，追加指挥团队编排 `appendSystemPrompt` 并挂载两个工具。
        - `team_get_roster` 返回生效预设、成员创建参数、会话覆盖标记和工作区存活子智能体。同步计划仅针对当前指挥的子智能体。
        - `team_update_member_model` 根据用户要求更新一个角色，或清除一个或全部角色的会话覆盖。覆盖保存到当前指挥的 metadata，重开会话后继续生效。全局预设和其他会话保留各自设置。
- 注册 RPC handlers（`getProviderCatalogRpc`、`getWorkspaceTeamStateRpc`、`previewCommanderPromptRpc`）。

#### v0.3.0 子智能体同步

- `in-sync` 表示现有模型、思考等级及可比较的目标特性已经匹配。
- `update-in-place` 返回原生 `update_agent` 参数。指挥仅同步有差异的模型、思考等级和特性，保留会话上下文和当前权限模式。
- `replace-provider` 返回原生 `create_agent` 参数。没有可复用的目标提供方会话时，指挥新建替代会话并交接摘要，保留旧会话。归档须经用户明确要求。
- `unresolved` 表示当前角色没有可用的目标配置，需要先确认模型再同步。

更新工具的输入仅允许模型、提供方、思考等级、特性和重置选项。覆盖仍使用基础预设的显式提供方时，新建参数可以继承该提供方的预设模式。覆盖改用其他提供方或 Auto 时，新会话权限由 Paseo 处理。若宿主要求显式权限模式，由用户为目标提供方选择。

#### v0.3.1 设置变更与派发前同步

- 新会话覆盖记录基础成员的模型配置指纹。设置页修改或恢复默认后，当前基础配置指纹与记录不符的覆盖从生效预设中剔除。v0.3.0 中没有指纹的旧覆盖继续有效，直到重置或重新写入。
- 指挥每次派发前通过 `team_get_roster` 获取修改后的设置和同步计划。指挥打开或恢复时，钩子以最多 1 秒的预算读取归属该指挥的存活子智能体，并把偏移计划写入当次打开的指令。查询期间若运行时配置再次变化，指挥使用实时名册重新取得计划。
- Paseo 0.17.1 的 `reload()` 能取消运行轮次。空闲检查和重载之间也可能开始新轮次。静默重载需要宿主提供原子的空闲检查与重载能力，现有会话通过每次派发前的实时查询获取更新。

### 5.3 客户端（`index.client.tsx` + `client/`）

严格遵守 Paseo 插件跨端规范（仅用 React Native 原语、`theme.colors`、`layout.compact`，无 DOM/HTML/CSS/`onClick`，桌面与移动端均可用，内置中英文 i18n）：

1. **Composer 控件 (`client.addComposerItem`)**：
   - 在 `new-workspace`、`draft` 和 `agent` 的输入框工具栏显示紧凑的 **团队模式选择/开关**（例如 `Select`：`关闭` / 各个团队模板，或一键 `Toggle`），直接读写 `composer.agent.metadata["paseo-team-manager.enabled"]` 与 `["paseo-team-manager.presetId"]`。
   - 新开对话时默认按设置自动生效，用户也可在发消息前一键切换模板或临时关闭（比如在 Downloads 随手聊个问题时顺手关掉）。
2. **设置页面 (`client.addSettingsScreen`)**：
   - 全局总开关 & 新顶层会话默认启用开关。
   - 排除目录管理（例如一键添加 `~/Downloads` 排除，避免非项目目录触发指挥模式）。
   - 团队模板管理：切换默认模板、编辑「指挥不直接改代码」开关与自定义指挥补充指令。
   - 成员列表管理：启用/停用角色、新增/删除自定义角色、从 host 实时目录选择 Provider / Model / Thinking / Mode / Codex Speed (`service_tier`)、编辑职责描述。
   - **注入指令实时预览**：可折叠查看最终注入给指挥的 `appendSystemPrompt` 原文。
3. **团队状态工作区/Agent 面板 (`client.addAgentPanel` / `client.addWorkspacePanel`)**：
   - 在当前会话显示团队成员名册、已派发子智能体的实时状态、一键跳转到对应子智能体或打开团队设置。
   - 输入框上方沿用 Paseo 原生 Subagents 胶囊结构，团队状态通过原生子智能体轨道和团队面板展示。
4. **快捷入口**：
   - Slash 命令 `/team`（支持 `/team` 打开面板、`/team on`、`/team off`、`/team settings`）。
   - Command Center (`⌘K`) 入口：打开团队管理设置、切换当前会话团队模式、打开团队面板。

---

## 6. 验收标准

- [ ] `npm run typecheck` 零错误。
- [ ] `npm test` 单元测试全绿（覆盖 prompt 生成、顶层/子智能体判定、排除目录/metadata 优先级、配置校验与默认值、工具返回结构）。
- [ ] `rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/` 无任何违规命中。
- [ ] 本地路径安装到 Paseo daemon：`paseo plugin install /path/to/paseo-team-manager`，`paseo plugin ls` 显示 `paseo-team-manager` 状态为 `running` 且无报错。
- [ ] 新开顶层会话，确认指挥能识别自己的职责并调用 `team_get_roster`。在具备 Magpie Codex 和 Antigravity 的环境中，确认示例包含后端的 `auto/gpt-6.2-sol`、`xhigh`、`service_tier: default` 和前端的 `gemini-4-neon`、`high`，两者均继承 Paseo 默认权限。确认创建的子智能体获得角色专属指令。
- [ ] 完整撰写 `OVERVIEW.md` 与 `OVERVIEW.zh-CN.md`（遵循 Paseo 官方 listing 规范）。
- [ ] 不重启 Paseo daemon。

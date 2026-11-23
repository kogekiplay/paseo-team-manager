import type { ResolvedTeamMember } from "./catalog-defaults.ts";
import { AUTO_PROVIDER, LABEL_KEYS, formatProviderModel, type TeamMember, type TeamPreset } from "./settings.ts";

export function buildMemberCreateAgentParams(member: TeamMember, presetId: string) {
  const { modeId, thinkingOptionId, features, roleId } = member;
  return {
    provider: member.provider === AUTO_PROVIDER
      ? "<请先调用 list_providers / list_models 选择当前宿主机可用模型>"
      : formatProviderModel(member.provider, member.model),
    settings: {
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(features).length > 0 ? { features } : {}),
    },
    labels: { [LABEL_KEYS.role]: roleId, [LABEL_KEYS.preset]: presetId },
    recommendedTitlePrefix: `[${roleId}] `,
  };
}

export function buildCommanderPrompt({ preset, cwd, workspaceId, resolvedMembers }: {
  preset: TeamPreset;
  cwd?: string | null;
  workspaceId?: string | null;
  resolvedMembers?: readonly ResolvedTeamMember[];
}): string {
  const lines = [
    "## 当前工作区项目指挥（Commander）",
    "",
    `你负责统筹当前工作区项目。团队预设为 ${preset.name}（\`${preset.id}\`）。`,
    ...(cwd ? [`- 工作目录 \`${cwd}\``] : []),
    ...(workspaceId ? [`- 工作区 ID \`${workspaceId}\``] : []),
    "",
    "### 工作纪律",
    "",
    preset.commanderNoDirectEdit
      ? "**严格红线——禁止直接修改项目业务源码文件。** 负责理解需求、只读调研代码库、确定架构与接口契约、规划互不冲突的文件边界、拆解并派发任务、审查 diff 与测试结果，以及向用户汇报。业务代码的编写与修改由子智能体完成。"
      : "优先把工作拆解并委派给团队成员，必要时可自行处理小型修改。负责确认接口和文件边界、审查 diff 与测试结果，以及向用户汇报。",
    "",
    "### 已启用的团队成员",
  ];

  const active = (resolvedMembers ?? preset.members.map((member) => ({
    member,
    configured: member,
    status: "explicit" as const,
    fallbackReason: null,
  }))).filter(({ member }) => member.enabled);
  if (active.length === 0) lines.push("", "当前预设没有已启用成员。");
  for (const resolved of active) {
    const member = resolved.member;
    const { provider, settings, labels, recommendedTitlePrefix } = buildMemberCreateAgentParams(member, preset.id);
    const params = {
      provider, settings, labels, title: `${recommendedTitlePrefix}任务标题`,
      initialPrompt: "填写任务目标、文件边界、接口契约与验收要求。", notifyOnFinish: true,
    };
    lines.push("", `#### ${member.name}（\`${member.roleId}\`）`);
    if (member.responsibilities.trim()) lines.push("", member.responsibilities.trim());
    if (resolved.fallbackReason) lines.push("", `> 配置解析状态：${resolved.status}。${resolved.fallbackReason}`);
    lines.push("", "```json", JSON.stringify(params, null, 2), "```");
  }

  const optional = preset.members.filter((member) => !member.enabled);
  if (optional.length > 0) {
    lines.push("", "### 可选扩展角色", "", "以下角色默认未启用，可按需或经用户要求调用。");
    for (const member of optional) {
      const description = member.responsibilities.trim();
      lines.push(`- ${member.name}（\`${member.roleId}\`）${description ? ` · ${description}` : ""}`);
    }
  }

  lines.push(
    "", "### 调度与协作", "",
    "1. 通过 Paseo 原生 MCP 工具 `create_agent` / `send_agent_prompt` 调度子智能体，保留 Subagents 轨道和完成唤醒机制。创建时将示例 `title` 和 `initialPrompt` 替换为实际任务标题与指令。",
    `2. 调用 \`create_agent\` 时务必传入 \`labels: { "${LABEL_KEYS.role}": "<roleId>", "${LABEL_KEYS.preset}": "${preset.id}" }\`，建议用 \`[<roleId>] \` 开头的标题，例如 \`[backend] 实现接口\`。`,
    "3. 新建子智能体前调用只读工具 `team_get_roster` 查看最新配置和当前工作区的团队子智能体。同一角色已有健康存活的子智能体时，优先通过 `send_agent_prompt` 复用。",
    "4. 多成员并行修改代码时，先划清各自可写文件边界，必要时使用独立 worktree。",
    "5. 派发时设置 `notifyOnFinish: true`，等待完成回调唤醒，避免循环轮询。",
    "6. 严格按照名册中的 `provider/model` 派发，禁止擅自升级或切换为 `astra`、`fable` 等高成本模型，除非用户明确要求。",
  );

  const extraInstructions = preset.commanderExtraInstructions.trim();
  if (extraInstructions) lines.push("", "### 补充指令", "", extraInstructions);
  return lines.join("\n");
}

export function buildSubagentRolePrompt({ preset, member, cwd }: {
  preset: TeamPreset;
  member: TeamMember;
  cwd?: string | null;
}): string {
  const responsibilities = member.responsibilities.trim();
  const instructions = member.rolePrompt.trim();
  return [
    `## 团队子智能体 · ${member.name}（\`${member.roleId}\`）`,
    "",
    `你是 ${preset.name}（\`${preset.id}\`）的受派成员，接受当前工作区项目指挥调度。指挥由分派任务的上级会话担任。`,
    ...(cwd ? [`- 工作目录 \`${cwd}\``] : []),
    ...(responsibilities ? ["", "### 角色职责", "", responsibilities] : []),
    ...(instructions ? ["", "### 角色指令", "", instructions] : []),
    "", "### 执行与回报", "",
    "- 按任务给定的接口契约与文件边界开展工作。需要扩大范围时，先向指挥说明依赖和影响。",
    "- 完成职责范围内的自测或只读验证，记录执行命令及结果。",
    "- 回报时列出完成事项、涉及文件、验证结果和仍需协调的事项。",
  ].join("\n");
}

import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { WorkspaceTeamAgent } from "../shared/contracts.ts";
import type { ProviderCatalogEntry } from "../shared/contracts.ts";
import { resolvePresetMembers, summarizeResolvedMember } from "../shared/catalog-defaults.ts";
import { isSubagentLabels, normalizeDirectoryPath, resolveEffectiveTeamConfig, resolveSubagentRoleId } from "../shared/policy.ts";
import { buildMemberCreateAgentParams } from "../shared/prompt-builder.ts";
import { LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL, type TeamSettingsValues } from "../shared/settings.ts";

export async function listWorkspaceAgents(
  paseo: PaseoApi,
  { workspaceId, cwd, homeDir, includeBackground = false }: {
    workspaceId: string | null;
    cwd?: string;
    homeDir: string;
    includeBackground?: boolean;
  },
): Promise<PaseoAgent[]> {
  const directory = cwd && normalizeDirectoryPath(cwd, homeDir);
  const agents = new Map<string, PaseoAgent>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.agents.list({ includeBackground, page: { limit: 200, cursor } });
    for (const { agent } of entries) {
      const inWorkspace = workspaceId
        ? agent.workspaceId === workspaceId
        : directory && normalizeDirectoryPath(agent.cwd, homeDir) === directory;
      if (inWorkspace && !agent.archivedAt && (includeBackground || !agent.background)) agents.set(agent.id, agent);
    }
    cursor = pageInfo.nextCursor ?? undefined;
    if (cursor && !seenCursors.has(cursor)) seenCursors.add(cursor);
    else break;
  } while (cursor);
  return [...agents.values()];
}

export function toWorkspaceTeamAgent(agent: PaseoAgent): WorkspaceTeamAgent {
  const isSubagent = isSubagentLabels(agent.labels);
  const background = agent.background === true;
  const metadataPreset = agent.metadata?.[METADATA_KEYS.presetId];
  const labeledPreset = agent.labels?.[LABEL_KEYS.preset]?.trim();
  const storedPreset = typeof metadataPreset === "string" ? metadataPreset.trim() : undefined;
  const presetId = (isSubagent && labeledPreset) || storedPreset || labeledPreset || null;
  return {
    agentId: agent.id,
    title: agent.title,
    roleId: isSubagent ? resolveSubagentRoleId(agent) : null,
    presetId,
    parentAgentId: agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || null,
    provider: agent.provider,
    model: agent.model,
    modeId: agent.currentModeId,
    thinkingOptionId: agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? null,
    status: agent.status,
    isCommander: !background && !isSubagent,
    background,
    updatedAt: agent.updatedAt,
  };
}

export function createRosterTool(
  getSettings: () => TeamSettingsValues,
  homeDir: string,
  catalogCache?: { ensureFresh(paseo: PaseoApi, options?: { cwd?: string; timeoutMs?: number }): Promise<readonly ProviderCatalogEntry[]> },
) {
  return defineAgentTool({
    name: "team_get_roster",
    title: "当前工作区团队名册",
    description: "只读查询当前团队预设、成员的 create_agent 参数及工作区已有的团队子智能体。新建前可据此复用同角色会话。",
    input: z.object({}),
    async execute(_input, { agent, paseo }) {
      const settings = getSettings();
      const { workspaceId, cwd } = agent;
      const catalogProviders = catalogCache ? await catalogCache.ensureFresh(paseo, { cwd }) : [];
      const { preset, presetId, enabled, source, excludedByDirectory } = resolveEffectiveTeamConfig({
        settings, workspaceId, cwd, metadata: agent.metadata, homeDir,
      });
      const { resolved } = resolvePresetMembers(preset, catalogProviders, agent.provider);
      const members = resolved.map((item) => ({
        ...summarizeResolvedMember(item),
        name: item.member.name,
        enabled: item.member.enabled,
        responsibilities: item.member.responsibilities,
        createAgentParams: buildMemberCreateAgentParams(item.member, presetId),
      }));

      const listing = await listWorkspaceAgents(paseo, { workspaceId, cwd, homeDir })
        .then((agents) => ({
          agents: agents.map(toWorkspaceTeamAgent).filter((item) => item.roleId && item.status !== "closed"),
          agentListError: null,
        }))
        .catch((error: unknown) => ({ agents: [], agentListError: error instanceof Error ? error.message : String(error) }));
      const { agents, agentListError } = listing;
      const text = [
        `## ${preset.name}（\`${presetId}\`）`,
        "",
        `团队模式 ${enabled ? "已开启" : "已关闭"}。`,
        "",
        "### 团队成员",
        ...members.map(({ name, roleId, enabled: memberEnabled, responsibilities, createAgentParams, status, fallbackReason }) =>
          `- ${name}（\`${roleId}\`，${memberEnabled ? "已启用" : "可选"}，${status}）${responsibilities ? ` · ${responsibilities}` : ""}\n  \`${JSON.stringify(createAgentParams)}\`${fallbackReason ? `\n  提示：${fallbackReason}` : ""}`),
        "",
        "### 工作区团队子智能体",
        ...(agentListError !== null
          ? [`读取子智能体列表失败（${agentListError}）。`]
          : agents.length
            ? agents.map(({ agentId, roleId, title, status }) => `- \`${agentId}\` · \`${roleId}\` · ${title ?? agentId} · ${status}`)
            : ["当前没有可复用的团队子智能体。"]),
      ].join("\n");
      return {
        text,
        structuredContent: { workspaceId, cwd, enabled, source, excludedByDirectory, presetId, preset, members, resolvedMembers: members, agents, agentListError },
      };
    },
  });
}

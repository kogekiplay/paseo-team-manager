import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ProviderCatalogEntry, WorkspaceTeamAgent } from "../shared/contracts.ts";
import { evaluateSubagentSync, resolvePresetMembers, resolveTeamMember, summarizeResolvedMember, type ResolvedTeamMember } from "../shared/catalog-defaults.ts";
import { isSubagentLabels, normalizeDirectoryPath, resolveEffectiveTeamConfig, resolveSubagentRoleId } from "../shared/policy.ts";
import { buildMemberCreateAgentParams } from "../shared/prompt-builder.ts";
import {
  AUTO_PROVIDER, FeatureValueSchema, formatProviderModel, LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL,
  SessionMemberOverrideSchema, type SessionMemberOverridesMap, type TeamMember, type TeamSettingsValues,
} from "../shared/settings.ts";
import type { HostAgent, HostPaseoApi } from "./paseo-types.ts";

type PaseoAgent = HostAgent;
type PaseoApi = HostPaseoApi;
type CatalogCache = Pick<import("./provider-catalog-cache.ts").ProviderCatalogCache, "ensureFresh">;

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

export function planWorkspaceAgentSync(
  agent: PaseoAgent,
  view: WorkspaceTeamAgent,
  commanderId: string,
  resolved: readonly ResolvedTeamMember[],
  presetId: string,
) {
  const { roleId, parentAgentId, background, status } = view;
  if (!roleId || parentAgentId !== commanderId || background || status === "closed" || agent.archivedAt) return null;
  const target = resolved.find(({ member }) => member.roleId.toLowerCase() === roleId);
  return evaluateSubagentSync({ ...view, options: agent.options }, target, presetId);
}

async function listTeamAgents(
  paseo: PaseoApi,
  commander: { id: string; workspaceId: string | null; cwd: string },
  homeDir: string,
  resolved: readonly ResolvedTeamMember[],
  presetId: string,
  { enabled, affectedRoles }: { enabled: boolean; affectedRoles?: ReadonlySet<string> },
) {
  try {
    const agents = await listWorkspaceAgents(paseo, { ...commander, homeDir });
    return {
      agents: agents.flatMap((agent) => {
        const view = toWorkspaceTeamAgent(agent);
        if (!view.roleId || view.status === "closed") return [];
        const plan = enabled ? planWorkspaceAgentSync(agent, view, commander.id, resolved, presetId) : null;
        if (affectedRoles && (!plan || !affectedRoles.has(view.roleId))) return [];
        return [{ ...view, ...plan }];
      }),
      agentListError: null,
    };
  } catch (error) {
    return { agents: [], agentListError: error instanceof Error ? error.message : String(error) };
  }
}

type TeamAgentListing = Awaited<ReturnType<typeof listTeamAgents>>;

function formatTeamAgents({ agents, agentListError }: TeamAgentListing): string[] {
  if (agentListError !== null) return [`读取子智能体列表失败（${agentListError}）。`];
  if (agents.length === 0) return ["当前没有匹配的存活团队子智能体。"];
  return agents.map((agent) => {
    const { agentId, roleId, title, provider, model, status, syncStatus, syncReason, targetProviderModel, updateAgentParams, createAgentParams } = agent;
    return [
      `- \`${agentId}\` · \`${roleId}\` · ${title ?? agentId} · ${status} · 当前 \`${formatProviderModel(provider, model ?? "")}\``,
      ...(syncStatus ? [`  同步 \`${syncStatus}\`${targetProviderModel ? ` · 目标 \`${targetProviderModel}\`` : ""}${syncReason ? ` · ${syncReason}` : ""}`] : []),
      ...(updateAgentParams ? [`  \`update_agent\` 参数 \`${JSON.stringify(updateAgentParams)}\``] : []),
      ...(createAgentParams ? [`  \`create_agent\` 参数 \`${JSON.stringify(createAgentParams)}\``] : []),
    ].join("\n");
  });
}

export function createRosterTool(
  getSettings: () => TeamSettingsValues,
  homeDir: string,
  catalogCache?: CatalogCache,
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
      const current = await Promise.resolve().then(() => paseo.agents.ref(agent.id).refresh()).then((result) => result?.agent).catch(() => undefined);
      const { preset, presetId, enabled, source, excludedByDirectory, sessionMemberOverrides } = resolveEffectiveTeamConfig({
        settings, workspaceId, cwd, metadata: current ? current.metadata : agent.metadata, labels: current?.labels, homeDir,
      });
      const { resolved } = resolvePresetMembers(preset, catalogProviders, agent.provider);
      const members = resolved.map((item) => ({
        ...summarizeResolvedMember(item, Object.hasOwn(sessionMemberOverrides, item.member.roleId.toLowerCase())),
        name: item.member.name,
        enabled: item.member.enabled,
        responsibilities: item.member.responsibilities,
        createAgentParams: buildMemberCreateAgentParams(item.member, presetId),
      }));

      const listing = await listTeamAgents(paseo, agent, homeDir, resolved, presetId, { enabled });
      const text = [
        `## ${preset.name}（\`${presetId}\`）`,
        "",
        `团队模式 ${enabled ? "已开启" : "已关闭"}。`,
        "",
        "### 团队成员",
        ...members.map(({ name, roleId, enabled: memberEnabled, responsibilities, createAgentParams, status, fallbackReason, overriddenInSession }) =>
          `- ${name}（\`${roleId}\`，${memberEnabled ? "已启用" : "可选"}，${status}）${overriddenInSession ? " · 当前会话覆盖" : ""}${responsibilities ? ` · ${responsibilities}` : ""}\n  \`${JSON.stringify(createAgentParams)}\`${fallbackReason ? `\n  提示：${fallbackReason}` : ""}`),
        "",
        "### 工作区团队子智能体",
        ...formatTeamAgents(listing),
      ].join("\n");
      return {
        text,
        structuredContent: { workspaceId, cwd, enabled, source, excludedByDirectory, presetId, preset, members, resolvedMembers: members, sessionMemberOverrides, ...listing },
      };
    },
  });
}

const updateMemberModelInput = z.strictObject({
  roleId: z.string().trim().min(1).max(48).optional(),
  provider: z.string().trim().min(1).max(193).optional(),
  model: z.string().trim().max(128).optional(),
  thinkingOptionId: z.string().trim().max(64).nullable().optional(),
  features: z.record(z.string(), FeatureValueSchema).nullable().optional(),
  clear: z.boolean().optional(),
  clearAll: z.boolean().optional(),
});
type UpdateMemberModelInput = z.infer<typeof updateMemberModelInput>;

function resolveModelOverride(
  input: UpdateMemberModelInput,
  current: TeamMember,
  previous: SessionMemberOverridesMap[string] | undefined,
  providers: readonly ProviderCatalogEntry[],
) {
  let { provider, model } = input;
  if (provider?.includes("/") && model === undefined) {
    const separator = provider.indexOf("/");
    model = provider.slice(separator + 1).trim();
    provider = provider.slice(0, separator).trim();
  }
  if (provider?.toLowerCase() === AUTO_PROVIDER) {
    provider = AUTO_PROVIDER;
    model = "";
  }

  const ready = providers.filter((entry) => entry.enabled && entry.status === "ready");
  if (provider === undefined && model) {
    if (current.provider !== AUTO_PROVIDER) {
      provider = current.provider;
    } else {
      const candidates = ready.filter((entry) => entry.models.some(({ id, isSelectable }) => id === model && isSelectable !== false));
      if (candidates.length !== 1) return { error: `无法为模型 \`${model}\` 确定唯一的提供方，请指定 \`provider/model\`。` };
      provider = candidates[0].provider;
    }
  }
  if (!provider || provider.includes("/") || (provider !== AUTO_PROVIDER && !model)) {
    return { error: "请指定 `provider/model`、具体 `model` 或 `provider: auto`。" };
  }

  if (provider !== AUTO_PROVIDER && providers.length > 0) {
    const entry = ready.find((item) => item.provider.toLowerCase() === provider?.toLowerCase());
    if (!entry) {
      return { error: `提供方 \`${provider}\` 不可用。当前可用提供方：${ready.map((item) => item.provider).join("、") || "无"}。` };
    }
    provider = entry.provider;
    const selectable = entry.models.filter(({ isSelectable }) => isSelectable !== false);
    const catalogModel = selectable.find(({ id }) => id === model);
    if (entry.models.length > 0 && !catalogModel) {
      return { error: `模型 \`${model}\` 不可用。\`${provider}\` 可用模型：${selectable.map(({ id }) => id).join("、") || "无"}。` };
    }
    if (input.thinkingOptionId) {
      const options = new Set(catalogModel?.thinkingOptions.map(({ id }) => id));
      if (catalogModel?.defaultThinkingOptionId) options.add(catalogModel.defaultThinkingOptionId);
      if (!options.has(input.thinkingOptionId)) {
        return { error: `思考选项 \`${input.thinkingOptionId}\` 不可用。该模型列出的选项：${[...options].join("、") || "无"}。` };
      }
    }
  }

  const prior = previous?.provider.toLowerCase() === provider.toLowerCase() ? previous : undefined;
  const thinkingOptionId = input.thinkingOptionId === undefined ? prior?.thinkingOptionId : input.thinkingOptionId ?? undefined;
  const features = input.features === undefined ? prior?.features : input.features ?? undefined;
  const parsed = SessionMemberOverrideSchema.safeParse({
    provider, model, updatedAt: new Date().toISOString(),
    ...(thinkingOptionId !== undefined ? { thinkingOptionId } : {}),
    ...(features !== undefined ? { features } : {}),
  });
  return parsed.success ? { override: parsed.data } : { error: "提供方、模型或成员配置的格式无效。" };
}

export function createUpdateMemberModelTool(
  getSettings: () => TeamSettingsValues,
  homeDir: string,
  catalogCache?: CatalogCache,
) {
  const pending = new Map<string, Promise<unknown>>();
  return defineAgentTool({
    name: "team_update_member_model",
    title: "更新当前会话的成员模型",
    description: "按用户要求更新或重置当前指挥会话的成员模型，并返回子智能体同步计划。支持 clear 清除单角色，或 clearAll 恢复全部默认。",
    input: updateMemberModelInput,
    async execute(input, { agent, paseo }) {
      const fail = (text: string) => ({ isError: true, text });
      const request = updateMemberModelInput.safeParse(input);
      if (!request.success) return fail(`成员模型更新参数无效。${request.error.issues.map(({ message }) => message).join(" ")}`);
      if (agent.background || agent.parentAgentId?.trim()) return fail("只有团队指挥会话可以更新成员模型。");
      // Serialize read-modify-write for each commander, using fresh metadata inside the queue.
      const operation = (pending.get(agent.id) ?? Promise.resolve()).then(async () => {
        const handle = paseo.agents.ref(agent.id);
        const current = (await handle.refresh())?.agent;
        if (!current || current.background || current.archivedAt || current.status === "closed" || isSubagentLabels(current.labels)) {
          return fail("当前团队指挥会话不可用。");
        }
        const { cwd, workspaceId } = current;
        const providers = catalogCache ? await catalogCache.ensureFresh(paseo, { cwd }) : [];
        const context = { settings: getSettings(), cwd, workspaceId, homeDir, labels: current.labels };
        const effective = resolveEffectiveTeamConfig({ ...context, metadata: current.metadata });
        if (!effective.enabled) return fail("当前会话的团队模式已关闭。");

        const { clear, clearAll } = request.data;
        const roleId = request.data.roleId?.toLowerCase() ?? "";
        const nextOverrides = { ...effective.sessionMemberOverrides };
        let affectedRoles: Set<string>;
        if (clearAll) {
          affectedRoles = new Set(Object.keys(nextOverrides));
          for (const role of affectedRoles) delete nextOverrides[role];
        } else {
          const member = effective.preset.members.find((item) => item.roleId.toLowerCase() === roleId);
          if (!member) {
            return fail(`当前预设中的可用角色：${effective.preset.members.map((item) => item.roleId).join("、") || "无"}。请指定有效的 \`roleId\`。`);
          }
          affectedRoles = new Set([roleId]);
          if (clear) {
            delete nextOverrides[roleId];
          } else {
            // An offline caller fallback is useful only when there is no catalog to validate against.
            const resolved = resolveTeamMember(member, providers, providers.length === 0 ? current.provider : undefined);
            const previous = Object.hasOwn(nextOverrides, roleId) ? nextOverrides[roleId] : undefined;
            const choice = resolveModelOverride(request.data, resolved.member, previous, providers);
            if (!choice.override) return fail(choice.error);
            nextOverrides[roleId] = choice.override;
          }
        }

        const patch = { [METADATA_KEYS.memberOverrides]: Object.keys(nextOverrides).length ? nextOverrides : null };
        await handle.setMetadata(patch);
        const { preset, presetId, sessionMemberOverrides } = resolveEffectiveTeamConfig({
          ...context, metadata: { ...current.metadata, ...patch },
        });
        const { resolved } = resolvePresetMembers(preset, providers, current.provider);
        const listing = await listTeamAgents(paseo, { id: current.id, cwd, workspaceId: workspaceId ?? null }, homeDir, resolved, presetId, { enabled: true, affectedRoles });
        return {
          text: [
            clearAll ? "已清除当前指挥会话的全部成员模型覆盖。" : clear ? `已清除 \`${roleId}\` 的会话覆盖。` : `已保存 \`${roleId}\` 的会话模型覆盖。`,
            "", "### 子智能体同步计划", "", ...formatTeamAgents(listing),
          ].join("\n"),
          structuredContent: {
            presetId, sessionMemberOverrides, affectedAgents: listing.agents, agentListError: listing.agentListError,
            resolvedMembers: resolved.map((item) => summarizeResolvedMember(item, Object.hasOwn(sessionMemberOverrides, item.member.roleId.toLowerCase()))),
          },
        };
      }).catch((error: unknown) => fail(`无法更新会话成员模型。${error instanceof Error ? error.message : String(error)}`));
      pending.set(agent.id, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(agent.id) === operation) pending.delete(agent.id);
      }
    },
  });
}

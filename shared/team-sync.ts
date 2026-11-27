import type { ResolvedTeamMember } from "./catalog-defaults.ts";
import type { AgentSyncStatus } from "./contracts.ts";
import { buildMemberCreateAgentParams } from "./prompt-builder.ts";
import { AUTO_PROVIDER, formatProviderModel, type FeatureValue } from "./settings.ts";

interface SubagentSnapshot {
  agentId: string;
  roleId: string | null;
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  options?: Readonly<Record<string, unknown>> | null;
}

interface SyncSettings {
  model?: string;
  thinkingOptionId?: string;
  features?: Record<string, FeatureValue>;
}

export interface SubagentSyncPlan {
  syncStatus: AgentSyncStatus;
  syncReason: string | null;
  targetProviderModel: string | null;
  updateAgentParams: { agentId: string; settings: SyncSettings } | null;
  createAgentParams: ReturnType<typeof buildMemberCreateAgentParams> | null;
}

export function evaluateSubagentSync(
  agent: SubagentSnapshot,
  target: ResolvedTeamMember | undefined,
  presetId: string,
): SubagentSyncPlan {
  const emptyPlan = { updateAgentParams: null, createAgentParams: null };
  if (!target || target.status === "unresolved" || target.member.provider === AUTO_PROVIDER) {
    return { ...emptyPlan, syncStatus: "unresolved", syncReason: target?.fallbackReason ?? "当前预设没有可用的角色目标配置。", targetProviderModel: null };
  }

  const { member } = target;
  const targetProviderModel = formatProviderModel(member.provider, member.model);
  if (agent.provider.trim().toLowerCase() !== member.provider.trim().toLowerCase()) {
    if (!member.model) {
      return { ...emptyPlan, syncStatus: "unresolved", syncReason: "请先确认目标提供方的可用模型，再创建替代会话。", targetProviderModel: null };
    }
    return {
      ...emptyPlan,
      syncStatus: "replace-provider",
      syncReason: "提供方已变更，Paseo 无法原地切换。若目标提供方没有可复用的同角色会话，请新建替代会话，交接上下文摘要，并保留旧会话。若 Paseo 要求显式权限模式，请由用户为目标提供方选择。",
      targetProviderModel,
      createAgentParams: buildMemberCreateAgentParams({ ...member, modeId: "" }, presetId),
    };
  }

  const settings: SyncSettings = {};
  if (member.model && member.model !== agent.model) settings.model = member.model;
  if (member.thinkingOptionId && member.thinkingOptionId !== agent.thinkingOptionId) {
    settings.thinkingOptionId = member.thinkingOptionId;
  }
  if (agent.options) {
    const options = agent.options;
    const changed = Object.entries(member.features).filter(([key, value]) => options[key] !== value);
    if (changed.length > 0) settings.features = Object.fromEntries(changed);
  }
  const changes = Object.keys(settings);
  if (changes.length === 0) return { ...emptyPlan, syncStatus: "in-sync", syncReason: null, targetProviderModel };
  return {
    ...emptyPlan,
    syncStatus: "update-in-place",
    syncReason: `可原地同步 ${changes.join("、")}，保留现有会话上下文。`,
    targetProviderModel,
    updateAgentParams: { agentId: agent.agentId, settings },
  };
}

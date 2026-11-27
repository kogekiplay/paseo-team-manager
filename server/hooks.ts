import type { AgentToolDefinition, PluginHookRequests } from "@getpaseo/plugin/server";
import { resolvePresetMembers, resolveTeamMember } from "../shared/catalog-defaults.ts";
import type { ProviderCatalogEntry } from "../shared/contracts.ts";
import { findMemberByRole, isSubagentLabels, resolveEffectiveTeamConfig, resolveSubagentRoleId } from "../shared/policy.ts";
import { buildCommanderPrompt, buildSubagentRolePrompt, type DriftedSubagentPromptItem } from "../shared/prompt-builder.ts";
import { LABEL_KEYS, METADATA_KEYS, type TeamSettingsValues } from "../shared/settings.ts";

export function applyAgentCreateBefore(
  request: PluginHookRequests["agent.create.before"],
  settings: TeamSettingsValues,
  homeDir: string,
  catalogProviders: readonly ProviderCatalogEntry[] = [],
): PluginHookRequests["agent.create.before"] | undefined {
  if (!settings.enabled || !settings.enforceMemberDefaultsOnCreate) return;
  const { config, metadata } = request;
  const metadataRole = metadata?.[METADATA_KEYS.roleId];
  if (typeof metadataRole !== "string" || !metadataRole.trim()) return;
  const roleId = metadataRole.trim().toLowerCase();
  if (!roleId) return;

  const effective = resolveEffectiveTeamConfig({ settings, cwd: config.cwd, metadata, homeDir });
  if (!effective.enabled) return;
  const match = findMemberByRole(settings, roleId, effective.presetId);
  if (!match) return;
  const resolved = resolveTeamMember(match.member, catalogProviders, config.provider);
  if (config.provider !== resolved.member.provider) return;

  const { member } = resolved;
  const { preset } = match;
  const providerOptions = config.providerOptions ?? {};
  const missingFeatures = Object.entries(member.features).filter(([key]) =>
    !Object.prototype.hasOwnProperty.call(providerOptions, key) || providerOptions[key] === undefined,
  );
  return {
    ...request,
    config: {
      ...config,
      ...(config.model === undefined && member.model ? { model: member.model } : {}),
      ...(config.modeId === undefined && member.modeId ? { modeId: member.modeId } : {}),
      ...(config.thinkingOptionId === undefined && member.thinkingOptionId ? { thinkingOptionId: member.thinkingOptionId } : {}),
      ...(missingFeatures.length ? { providerOptions: { ...providerOptions, ...Object.fromEntries(missingFeatures) } } : {}),
    },
    metadata: {
      ...metadata,
      [METADATA_KEYS.roleId]: metadata?.[METADATA_KEYS.roleId] ?? member.roleId,
      [METADATA_KEYS.presetId]: metadata?.[METADATA_KEYS.presetId] ?? preset.id,
    },
  };
}

export function applyAgentOpenBefore(
  request: PluginHookRequests["agent.open.before"],
  settings: TeamSettingsValues,
  commanderTools: AgentToolDefinition | readonly AgentToolDefinition[],
  homeDir: string,
  catalogProviders: readonly ProviderCatalogEntry[] = [],
  driftedSubagents: readonly DriftedSubagentPromptItem[] = [],
): PluginHookRequests["agent.open.before"] | undefined {
  if (request.purpose === "history" || request.background) return;
  const { labels, metadata, cwd, workspaceId } = request;
  const effective = resolveEffectiveTeamConfig({ settings, workspaceId, cwd, metadata, labels, homeDir });
  const prompts = request.appendSystemPrompt ?? [];

  if (isSubagentLabels(labels)) {
    if (!settings.enabled) return;
    if (!effective.enabled) return;
    const roleId = resolveSubagentRoleId({ labels, metadata });
    if (!roleId) return;
    // Creation can infer a metadata preset before it has access to the caller's labels.
    const labeledPreset = settings.presets.find((preset) => preset.id === labels[LABEL_KEYS.preset]?.trim());
    const match = findMemberByRole(settings, roleId, labeledPreset?.id ?? effective.presetId);
    if (!match) return;
    const resolved = resolveTeamMember(match.member, catalogProviders, request.provider);
    return { ...request, appendSystemPrompt: [...prompts, buildSubagentRolePrompt({ preset: match.preset, member: resolved.member, cwd })] };
  }

  if (!effective.enabled) return;
  const { resolved } = resolvePresetMembers(effective.preset, catalogProviders, request.provider);
  return {
    ...request,
    appendSystemPrompt: [...prompts, buildCommanderPrompt({
      preset: effective.preset, cwd, workspaceId, resolvedMembers: resolved, sessionMemberOverrides: effective.sessionMemberOverrides, driftedSubagents,
    })],
    tools: [...request.tools, ...("execute" in commanderTools ? [commanderTools] : commanderTools)],
  };
}

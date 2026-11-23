import type { PaseoApi, PaseoProviderSnapshotResult } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getProviderCatalogRpc, getProviderControlsRpc, getWorkspaceTeamStateRpc, previewCommanderPromptRpc,
  ProviderCatalogEntrySchema, ProviderCatalogControlSchema,
  type ProviderCatalogInput, type ProviderCatalogOutput, type ProviderControlsInput, type ProviderControlsOutput,
  type WorkspaceTeamStateInput, type WorkspaceTeamStateOutput,
  type PreviewCommanderPromptInput, type PreviewCommanderPromptOutput,
} from "../shared/contracts.ts";
import { resolveEffectiveTeamConfig } from "../shared/policy.ts";
import { buildCommanderPrompt, buildSubagentRolePrompt } from "../shared/prompt-builder.ts";
import { FeatureValueSchema, formatProviderModel, METADATA_KEYS, type TeamSettingsValues } from "../shared/settings.ts";
import type { createSettingsCache } from "./settings-cache.ts";
import { listWorkspaceAgents, toWorkspaceTeamAgent } from "./tools.ts";

const providerDefaultValueSchema = FeatureValueSchema.nullable();

function getDefaultModel(models: PaseoProviderSnapshotResult["entries"][number]["models"] = []) {
  const selectable = models.filter((model) => model.isSelectable !== false);
  return selectable.find((model) => model.isDefault) ?? selectable[0];
}

export async function handleProviderControls(
  { provider, model, modeId, cwd }: ProviderControlsInput,
  paseo: PaseoApi,
  homeDir: string,
): Promise<ProviderControlsOutput> {
  try {
    if (!model) {
      const snapshot = await paseo.providers.snapshot({ cwd });
      model = getDefaultModel(snapshot.entries.find((entry) => entry.provider === provider)?.models)?.id;
      if (!model) return { provider, controls: [], defaults: {}, error: `No model is available for ${provider}.` };
    }
    const result = await paseo.providers.listControls({ provider: formatProviderModel(provider, model), modeId, cwd: cwd || homeDir });
    const controls = ProviderCatalogControlSchema.array().parse(result.controls ?? []);
    const controlDefaults = controls.flatMap(({ key, defaultValue }) => defaultValue === undefined ? [] : [[key, defaultValue] as const]);
    const effectiveDefaults = Object.entries(result.options ?? {}).flatMap(([key, value]) => {
      const parsed = providerDefaultValueSchema.safeParse(value);
      return parsed.success ? [[key, parsed.data] as const] : [];
    });
    const defaults = Object.fromEntries([...controlDefaults, ...effectiveDefaults]);
    return { provider, controls, defaults, error: result.error ?? null };
  } catch (error) {
    return { provider, controls: [], defaults: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleProviderCatalog(
  { cwd, refresh }: ProviderCatalogInput,
  paseo: PaseoApi,
  homeDir: string,
): Promise<ProviderCatalogOutput> {
  if (refresh) await paseo.providers.refresh({ cwd });
  const snapshot = await paseo.providers.snapshot({ cwd });
  const providers = await Promise.all(snapshot.entries.map(async (entry) => {
    const { provider, status } = entry;
    const enabled = entry.enabled ?? true;
    const defaultModeId = entry.defaultModeId ?? null;
    const defaultModel = getDefaultModel(entry.models);
    const result = enabled && status === "ready" && defaultModel
      ? await handleProviderControls({ provider, model: defaultModel.id, modeId: defaultModeId ?? undefined, cwd }, paseo, homeDir)
      : undefined;
    return ProviderCatalogEntrySchema.parse({
      provider, enabled, status, defaultModeId,
      label: entry.label ?? provider,
      error: entry.error ?? result?.error ?? undefined,
      modes: entry.modes ?? [],
      models: (entry.models ?? []).map((model) => ({ ...model, thinkingOptions: model.thinkingOptions ?? [] })),
      controls: result?.controls ?? [],
    });
  }));
  return { homeDir, fetchedAt: snapshot.generatedAt, providers };
}

export async function handleWorkspaceTeamState(
  { workspaceId, agentId, cwd }: WorkspaceTeamStateInput,
  paseo: PaseoApi,
  settings: TeamSettingsValues,
  homeDir: string,
): Promise<WorkspaceTeamStateOutput> {
  const [workspace, agents] = await Promise.all([
    Promise.resolve().then(() => paseo.workspaces.ref(workspaceId).refresh()).catch(() => null),
    listWorkspaceAgents(paseo, { workspaceId, homeDir, includeBackground: true }).catch(() => []),
  ]);
  let agent = agents.find((item) => item.id === agentId);
  if (!agent && agentId) {
    const result = await Promise.resolve().then(() => paseo.agents.ref(agentId).refresh()).catch(() => null);
    if (result?.agent.workspaceId === workspaceId) agent = result.agent;
  }
  const directory = cwd ?? workspace?.workspaceDirectory ?? agent?.cwd ?? agents[0]?.cwd ?? null;
  const effective = resolveEffectiveTeamConfig({
    settings, workspaceId, cwd: directory, homeDir, metadata: agent?.metadata, labels: agent?.labels,
  });
  return {
    workspaceId,
    cwd: directory,
    homeDir,
    effectiveEnabled: effective.enabled,
    decisionSource: effective.source,
    excludedByDirectory: effective.excludedByDirectory,
    activePresetId: effective.presetId,
    activePreset: effective.preset,
    agents: agents.map(toWorkspaceTeamAgent),
  };
}

export function handlePreviewCommanderPrompt(
  { preset: draft, presetId, cwd, workspaceId, roleId }: PreviewCommanderPromptInput,
  settings: TeamSettingsValues,
  homeDir: string,
): PreviewCommanderPromptOutput {
  const preset = draft ?? resolveEffectiveTeamConfig({
    settings, cwd, workspaceId, homeDir, metadata: { [METADATA_KEYS.presetId]: presetId },
  }).preset;
  const role = roleId?.trim().toLowerCase();
  const member = role && preset.members.find((item) => item.roleId.toLowerCase() === role);
  return {
    presetId: preset.id,
    commanderPrompt: buildCommanderPrompt({ preset, cwd, workspaceId }),
    rolePrompt: member ? buildSubagentRolePrompt({ preset, member, cwd }) : null,
  };
}

export function registerTeamRpcs(
  server: Pick<PluginServerContext, "handle">,
  cache: ReturnType<typeof createSettingsCache>,
  homeDir: string,
): void {
  server.handle(getProviderCatalogRpc, (input, { paseo }) => handleProviderCatalog(input, paseo, homeDir));
  server.handle(getProviderControlsRpc, (input, { paseo }) => handleProviderControls(input, paseo, homeDir));
  server.handle(getWorkspaceTeamStateRpc, async (input, { paseo }) => {
    await cache.waitReady();
    return handleWorkspaceTeamState(input, paseo, cache.getSettings(), homeDir);
  });
  server.handle(previewCommanderPromptRpc, async (input) => {
    await cache.waitReady();
    return handlePreviewCommanderPrompt(input, cache.getSettings(), homeDir);
  });
}

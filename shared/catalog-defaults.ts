import {
  AUTO_PROVIDER,
  type FeatureValue,
  type TeamMember,
  type TeamPreset,
} from "./settings.ts";
import type {
  ProviderCatalogControl,
  ProviderCatalogEntry,
  ProviderCatalogModel,
  ResolvedMemberSummary,
} from "./contracts.ts";

export type MemberResolutionStatus = "explicit" | "auto-matched" | "fallback-host" | "fallback-caller" | "unresolved";

export interface ResolvedTeamMember {
  member: TeamMember;
  configured: TeamMember;
  status: MemberResolutionStatus;
  fallbackReason: string | null;
}

interface RolePreferences {
  providers: string[];
  modelIds: string[];
  thinkingIds: string[];
}

const ROLE_ALIASES: Record<string, string> = {
  ui: "frontend",
  design: "frontend",
  review: "reviewer",
  audit: "reviewer",
  research: "explorer",
  recon: "explorer",
};

const ROLE_PREFERENCES: Record<string, RolePreferences> = {
  backend: {
    providers: ["codex", "claude", "antigravity"],
    modelIds: ["auto/gpt-6.2-sol"],
    thinkingIds: ["xhigh", "high", "medium"],
  },
  frontend: {
    providers: ["antigravity", "claude", "codex"],
    modelIds: ["gemini-4-neon", "gemini-4-carbon"],
    thinkingIds: ["high", "medium"],
  },
  reviewer: {
    providers: ["codex", "claude", "antigravity"],
    modelIds: ["auto/gpt-6.2-sol"],
    thinkingIds: ["xhigh", "high", "medium"],
  },
  explorer: {
    providers: ["antigravity", "claude", "codex"],
    modelIds: ["gemini-4-hydrogen", "gemini-4-argon", "auto/gpt-6-luna", "auto/gpt-6.1-terra", "auto/gpt-6.2-sol"],
    thinkingIds: ["medium", "low", "high"],
  },
};

const DEFAULT_PREFERENCES: RolePreferences = {
  providers: ["codex", "claude", "antigravity"],
  modelIds: [],
  thinkingIds: ["xhigh", "high", "medium"],
};

export function isHighCostModelId(modelId: string): boolean {
  return /(astra|fable)/i.test(modelId);
}

function canonicalProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function isAntigravityModel(model: ProviderCatalogModel): boolean {
  return /gemini/i.test(model.id) && !/gemini-3\.8-flash/i.test(model.id) && !/claude/i.test(model.id);
}

function selectableModels(entry: ProviderCatalogEntry): ProviderCatalogModel[] {
  return entry.models.filter((model) => model.isSelectable !== false);
}

function chooseModel(entry: ProviderCatalogEntry, preferredIds: readonly string[]): ProviderCatalogModel | null {
  const models = selectableModels(entry);
  if (models.length === 0) return null;
  const usable = models.filter((model) => !isHighCostModelId(model.id));
  const pool = usable.length > 0 ? usable : models;
  const antigravityPool = canonicalProvider(entry.provider) === "antigravity"
    ? pool.filter(isAntigravityModel)
    : pool;
  if (canonicalProvider(entry.provider) === "antigravity" && antigravityPool.length === 0) return null;
  const effectivePool = antigravityPool.length > 0 ? antigravityPool : pool;
  for (const preferredId of preferredIds) {
    const match = effectivePool.find((model) => model.id === preferredId);
    if (match) return match;
  }
  return effectivePool.find((model) => model.isDefault) ?? effectivePool[0] ?? null;
}

function chooseOption(options: readonly { id: string; isDefault?: boolean }[], preferred: readonly string[], fallback: string): string {
  for (const id of preferred) if (options.some((option) => option.id === id)) return id;
  return options.find((option) => option.isDefault)?.id ?? options[0]?.id ?? fallback;
}

function hasDefaultServiceTier(controls: readonly ProviderCatalogControl[]): boolean {
  return controls.some((control) => control.type === "select" && control.key === "service_tier" && control.choices.some((choice) => choice.value === "default"));
}

function chooseEntry(roleId: string, providers: readonly ProviderCatalogEntry[]): ProviderCatalogEntry | null {
  const role = ROLE_ALIASES[roleId.trim().toLowerCase()] ?? roleId.trim().toLowerCase();
  const preferences = ROLE_PREFERENCES[role] ?? DEFAULT_PREFERENCES;
  const available = providers.filter((entry) => entry.enabled && entry.status === "ready" && chooseModel(entry, preferences.modelIds) !== null);
  for (const preferredProvider of preferences.providers) {
    const entry = available.find((candidate) => canonicalProvider(candidate.provider) === preferredProvider);
    if (entry) return entry;
  }
  return available[0] ?? null;
}

function rolePreferences(roleId: string): RolePreferences {
  const role = ROLE_ALIASES[roleId.trim().toLowerCase()] ?? roleId.trim().toLowerCase();
  return ROLE_PREFERENCES[role] ?? DEFAULT_PREFERENCES;
}

export function resolveRoleFromCatalog(
  roleId: string,
  providers: readonly ProviderCatalogEntry[],
  options: { preferredThinking?: string } = {},
): { provider: string; model: string; thinkingOptionId: string; modeId: string; features: Record<string, FeatureValue> } | null {
  const preferences = rolePreferences(roleId);
  const entry = chooseEntry(roleId, providers);
  if (!entry) return null;
  const role = ROLE_ALIASES[roleId.trim().toLowerCase()] ?? roleId.trim().toLowerCase();
  const modelIds = canonicalProvider(entry.provider) === "claude" && role === "explorer"
    ? ["claude-haiku", ...preferences.modelIds]
    : preferences.modelIds;
  const model = chooseModel(entry, modelIds);
  if (!model) return null;
  const thinkingOptionId = chooseOption(model.thinkingOptions, options.preferredThinking ? [options.preferredThinking, ...preferences.thinkingIds] : preferences.thinkingIds, "");
  return {
    provider: entry.provider,
    model: model.id,
    thinkingOptionId,
    modeId: "",
    features: hasDefaultServiceTier(entry.controls) ? { service_tier: "default" } : {},
  };
}

export function resolveTeamMember(
  member: TeamMember,
  providers: readonly ProviderCatalogEntry[],
  fallbackProvider?: string | null,
): ResolvedTeamMember {
  const options = { preferredThinking: member.thinkingOptionId || undefined };
  const callerProvider = fallbackProvider?.trim();
  if (member.provider === AUTO_PROVIDER) {
    const resolved = resolveRoleFromCatalog(member.roleId, providers, options);
    if (resolved) return { member: { ...member, ...resolved }, configured: member, status: "auto-matched", fallbackReason: null };
    if (callerProvider) {
      return {
        member: { ...member, provider: callerProvider, model: "", modeId: "", features: {} },
        configured: member,
        status: "fallback-caller",
        fallbackReason: `No ready catalog model matched role ${member.roleId}. Using the caller provider ${callerProvider} without a model override.`,
      };
    }
    return { member: { ...member, modeId: "" }, configured: member, status: "unresolved", fallbackReason: `No ready provider model matched role ${member.roleId}.` };
  }

  if (providers.length === 0) return { member, configured: member, status: "explicit", fallbackReason: null };
  const entry = providers.find((candidate) => candidate.provider === member.provider);
  const ready = entry?.enabled && entry.status === "ready";
  if (ready && (selectableModels(entry).length === 0 || selectableModels(entry).some((model) => model.id === member.model))) {
    return { member, configured: member, status: "explicit", fallbackReason: null };
  }
  const sameProvider = ready && entry ? resolveRoleFromCatalog(member.roleId, [entry], options) : null;
  const resolved = sameProvider ?? resolveRoleFromCatalog(member.roleId, providers, options);
  if (resolved) {
    const configuredMode = member.modeId.trim();
    const keepsConfiguredMode = sameProvider && entry && configuredMode !== "" &&
      (entry.modes.length === 0 || entry.modes.some(({ id }) => id === configuredMode));
    return {
      member: { ...member, ...resolved, modeId: keepsConfiguredMode ? member.modeId : "" },
      configured: member,
      status: "fallback-host",
      fallbackReason: sameProvider
        ? `Configured model ${member.model} is unavailable in provider ${member.provider}. Selected an available model from the same provider.`
        : `Configured provider ${member.provider} is unavailable. Selected an available provider and model from the host catalog.`,
    };
  }
  if (callerProvider) {
    const modeId = canonicalProvider(member.provider) === canonicalProvider(callerProvider) ? member.modeId : "";
    return {
      member: { ...member, provider: callerProvider, model: "", modeId, features: {} },
      configured: member,
      status: "fallback-caller",
      fallbackReason: `Configured provider ${member.provider} is unavailable and no host catalog fallback exists. Using the caller provider ${callerProvider} without a model override.`,
    };
  }
  return { member: { ...member, modeId: "" }, configured: member, status: "unresolved", fallbackReason: `Configured provider ${member.provider} and model ${member.model} are unavailable.` };
}

export function resolvePresetMembers(
  preset: TeamPreset,
  providers: readonly ProviderCatalogEntry[],
  fallbackProvider?: string | null,
): { preset: TeamPreset; resolved: ResolvedTeamMember[] } {
  return { preset, resolved: preset.members.map((member) => resolveTeamMember(member, providers, fallbackProvider)) };
}

export function summarizeResolvedMember(resolved: ResolvedTeamMember): ResolvedMemberSummary {
  return {
    memberId: resolved.configured.id,
    roleId: resolved.configured.roleId,
    status: resolved.status,
    configuredProvider: resolved.configured.provider,
    configuredModel: resolved.configured.model,
    provider: resolved.member.provider,
    model: resolved.member.model,
    thinkingOptionId: resolved.member.thinkingOptionId,
    modeId: resolved.member.modeId,
    features: resolved.member.features,
    fallbackReason: resolved.fallbackReason,
  };
}

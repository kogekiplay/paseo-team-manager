import {
  LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL,
  type TeamMember, type TeamPreset, type TeamSettingsValues, type WorkspaceOverride,
} from "./settings.ts";

export type EffectiveDecisionSource =
  | "agent-metadata"
  | "workspace-override"
  | "excluded-directory"
  | "global-default";

export interface EffectiveTeamConfig {
  enabled: boolean;
  source: EffectiveDecisionSource;
  preset: TeamPreset;
  presetId: string;
  excludedByDirectory: string | null;
}

interface WorkspaceContext {
  workspaceId?: string | null;
  cwd?: string | null;
  homeDir?: string;
}

interface AgentContext {
  labels?: Readonly<Record<string, string>> | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}

export function normalizeDirectoryPath(input: string, homeDir?: string): string {
  let path = input.trim();
  if (homeDir && (path === "~" || path.startsWith("~/"))) {
    path = homeDir + path.slice(1);
  }
  const normalized = path.replace(/\/{2,}/g, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function findMatchingExcludedDirectory(
  cwd: string | null | undefined,
  excludedDirectories: readonly string[],
  homeDir?: string,
): string | null {
  const normalizedCwd = cwd ? normalizeDirectoryPath(cwd, homeDir) : "";
  if (!normalizedCwd) return null;
  return excludedDirectories.find((rule) => {
    const path = normalizeDirectoryPath(rule, homeDir);
    return path && (normalizedCwd === path || normalizedCwd.startsWith(path === "/" ? path : `${path}/`));
  }) ?? null;
}

export function isSubagentLabels(labels: AgentContext["labels"]): boolean {
  return Boolean(labels?.[PARENT_AGENT_ID_LABEL]?.trim());
}

export function extractRoleIdFromTitle(title: string | null | undefined): string | null {
  return title?.match(/^\s*\[([a-z0-9][a-z0-9_-]*)\]/i)?.[1].toLowerCase() ?? null;
}

export function resolveSubagentRoleId({
  labels, metadata, title,
}: AgentContext & { title?: string | null }): string | null {
  const role = labels?.[LABEL_KEYS.role]?.trim();
  const metadataRole = metadata?.[METADATA_KEYS.roleId];
  if (role) return role.toLowerCase();
  if (typeof metadataRole === "string" && metadataRole.trim()) return metadataRole.trim().toLowerCase();
  return extractRoleIdFromTitle(title);
}

export function resolveWorkspaceOverride(
  settings: TeamSettingsValues,
  { workspaceId, cwd, homeDir }: WorkspaceContext,
): WorkspaceOverride | null {
  const overrides = settings.workspaceOverrides;
  if (workspaceId && Object.prototype.hasOwnProperty.call(overrides, workspaceId)) return overrides[workspaceId];
  const path = cwd && normalizeDirectoryPath(cwd, homeDir);
  if (!path) return null;
  return Object.entries(overrides).find(([key]) => normalizeDirectoryPath(key, homeDir) === path)?.[1] ?? null;
}

export function resolveEffectiveTeamConfig({
  settings, workspaceId, cwd, metadata, labels, homeDir,
}: WorkspaceContext & AgentContext & { settings: TeamSettingsValues }): EffectiveTeamConfig {
  const override = resolveWorkspaceOverride(settings, { workspaceId, cwd, homeDir });
  const excludedByDirectory = findMatchingExcludedDirectory(cwd, settings.excludedDirectories, homeDir);
  const presetIds = [metadata?.[METADATA_KEYS.presetId], labels?.[LABEL_KEYS.preset], override?.presetId, settings.defaultPresetId];
  const preset = presetIds
    .map((id) => typeof id === "string" ? settings.presets.find((item) => item.id === id.trim()) : undefined)
    .find((item) => item !== undefined) ?? settings.presets[0];
  const selection = { preset, presetId: preset.id, excludedByDirectory };

  const metadataEnabled = metadata?.[METADATA_KEYS.teamEnabled];
  if (typeof metadataEnabled === "boolean") return { ...selection, enabled: metadataEnabled, source: "agent-metadata" };
  if (typeof override?.enabled === "boolean") return { ...selection, enabled: override.enabled, source: "workspace-override" };
  if (excludedByDirectory !== null) return { ...selection, enabled: false, source: "excluded-directory" };
  return { ...selection, enabled: settings.enabled && settings.autoApplyToNewTopLevelAgents, source: "global-default" };
}

export function findMemberByRole(
  settings: TeamSettingsValues,
  roleId: string,
  preferredPresetId?: string | null,
): { preset: TeamPreset; member: TeamMember } | null {
  const role = roleId.trim().toLowerCase();
  const ordered = new Set([
    settings.presets.find((preset) => preset.id === preferredPresetId),
    settings.presets.find((preset) => preset.id === settings.defaultPresetId),
    ...settings.presets,
  ]);
  for (const preset of ordered) {
    const member = preset?.members.find((item) => item.roleId.toLowerCase() === role);
    if (preset && member) return { preset, member };
  }
  return null;
}

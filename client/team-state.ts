import { normalizeDirectoryPath } from "../shared/policy.ts";
import {
  formatProviderModel,
  METADATA_KEYS,
  TeamMemberSchema,
  TeamPresetSchema,
  type TeamMember,
  type TeamPreset,
  type TeamSettingsValues,
  type WorkspaceOverride,
} from "../shared/settings.ts";

type Str = string;
type Bool = boolean;
type UnknownVal = unknown;
type MetadataValue = Str | Bool | null;
type MetadataMap = Readonly<Record<Str, UnknownVal>>;
type MetadataPatch = Record<Str, MetadataValue>;

export const COMPOSER_AUTO_VALUE = "auto" as const;
export const COMPOSER_OFF_VALUE = "off" as const;
export const COMPOSER_PRESET_PREFIX = "preset:" as const;

export type ComposerTeamValue =
  | typeof COMPOSER_AUTO_VALUE
  | typeof COMPOSER_OFF_VALUE
  | `${typeof COMPOSER_PRESET_PREFIX}${Str}`;

export type ParsedTeamSlashCommand =
  | { readonly kind: "panel" }
  | { readonly kind: "settings" }
  | { readonly kind: "on" }
  | { readonly kind: "off" }
  | { readonly kind: "auto" }
  | { readonly kind: "preset"; readonly presetId: Str }
  | { readonly kind: "invalid"; readonly raw: Str };

const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function isValidRoleId(roleId: Str): Bool {
  const trimmed = roleId.trim();
  return trimmed.length >= 1 && trimmed.length <= 48 && ROLE_ID_PATTERN.test(trimmed);
}

export function encodeComposerTeamValue(
  metadata: MetadataMap | null | undefined,
  presets: readonly TeamPreset[],
): ComposerTeamValue {
  const enabled = metadata?.[METADATA_KEYS.teamEnabled];
  const rawPresetId = metadata?.[METADATA_KEYS.presetId];
  const presetId = typeof rawPresetId === "string" ? rawPresetId.trim() : "";

  if (enabled === false) {
    return COMPOSER_OFF_VALUE;
  }

  if (enabled === true) {
    if (presetId && presets.some((item) => item.id === presetId)) {
      return `${COMPOSER_PRESET_PREFIX}${presetId}`;
    }
    if (presets.length > 0) {
      return `${COMPOSER_PRESET_PREFIX}${presets[0].id}`;
    }
    return COMPOSER_AUTO_VALUE;
  }

  if (presetId && presets.some((item) => item.id === presetId)) {
    return `${COMPOSER_PRESET_PREFIX}${presetId}`;
  }

  return COMPOSER_AUTO_VALUE;
}

export function decodeComposerPresetId(value: ComposerTeamValue): Str | null {
  if (!value.startsWith(COMPOSER_PRESET_PREFIX)) return null;
  const presetId = value.slice(COMPOSER_PRESET_PREFIX.length).trim();
  return presetId.length > 0 ? presetId : null;
}

export function buildComposerMetadataPatch(value: ComposerTeamValue): MetadataPatch {
  if (value === COMPOSER_OFF_VALUE) {
    return {
      [METADATA_KEYS.teamEnabled]: false,
      [METADATA_KEYS.presetId]: null,
    };
  }
  if (value === COMPOSER_AUTO_VALUE) {
    return {
      [METADATA_KEYS.teamEnabled]: null,
      [METADATA_KEYS.presetId]: null,
    };
  }
  const presetId = decodeComposerPresetId(value);
  if (!presetId) {
    return {
      [METADATA_KEYS.teamEnabled]: null,
      [METADATA_KEYS.presetId]: null,
    };
  }
  return {
    [METADATA_KEYS.teamEnabled]: true,
    [METADATA_KEYS.presetId]: presetId,
  };
}

export function parseTeamSlashArgs(rawArgs: Str): ParsedTeamSlashCommand {
  const trimmed = rawArgs.trim();
  if (!trimmed) return { kind: "panel" };

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0].toLowerCase();

  if (tokens.length === 1) {
    if (head === "status" || head === "panel") return { kind: "panel" };
    if (head === "settings" || head === "config") return { kind: "settings" };
    if (head === "on") return { kind: "on" };
    if (head === "off") return { kind: "off" };
    if (head === "auto" || head === "default") return { kind: "auto" };
    return { kind: "invalid", raw: trimmed };
  }

  if (head === "preset" && tokens.length === 2) {
    const presetId = tokens[1].trim();
    if (presetId) return { kind: "preset", presetId };
  }

  return { kind: "invalid", raw: trimmed };
}

export function normalizeExcludedDirectories(
  dirs: readonly Str[],
  homeDir?: Str,
): Str[] {
  const seen = new Set<Str>();
  const result: Str[] = [];
  for (const raw of dirs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeDirectoryPath(trimmed, homeDir);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

export function hasExcludedDirectory(
  dirs: readonly Str[],
  candidate: Str,
  homeDir?: Str,
): Bool {
  const target = normalizeDirectoryPath(candidate, homeDir);
  if (!target) return false;
  return dirs.some((item) => normalizeDirectoryPath(item, homeDir) === target);
}

export function addExcludedDirectory(
  dirs: readonly Str[],
  candidate: Str,
  homeDir?: Str,
): Str[] {
  const trimmed = candidate.trim();
  if (!trimmed) return normalizeExcludedDirectories(dirs, homeDir);
  return normalizeExcludedDirectories([...dirs, trimmed], homeDir);
}

export function removeExcludedDirectory(
  dirs: readonly Str[],
  target: Str,
  homeDir?: Str,
): Str[] {
  const normalizedTarget = normalizeDirectoryPath(target, homeDir);
  return dirs.filter((item) => {
    if (item === target) return false;
    return normalizeDirectoryPath(item, homeDir) !== normalizedTarget;
  });
}

export function slugifyIdentifier(input: Str, fallback = "custom"): Str {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-+$/, "");
  return cleaned.slice(0, 48) || fallback;
}

export function generateUniqueId(base: Str, existingIds: readonly Str[]): Str {
  const taken = new Set(existingIds.map((id) => id.toLowerCase()));
  const root = slugifyIdentifier(base, "item");
  if (!taken.has(root.toLowerCase())) return root;
  let counter = 2;
  while (taken.has(`${root}-${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${root}-${counter}`.slice(0, 64);
}

export function createNewPreset(
  presets: readonly TeamPreset[],
  name: Str,
  description = "",
): { readonly presets: TeamPreset[]; readonly created: TeamPreset } {
  const id = generateUniqueId(
    slugifyIdentifier(name, "team"),
    presets.map((item) => item.id),
  );
  const created = TeamPresetSchema.parse({
    id,
    name: name.trim() || id,
    description: description.trim(),
    commanderNoDirectEdit: true,
    commanderExtraInstructions: "",
    members: [],
  });
  return {
    presets: [...presets, created],
    created,
  };
}

export function duplicatePreset(
  presets: readonly TeamPreset[],
  sourceId: Str,
  copySuffix = "Copy",
): { readonly presets: TeamPreset[]; readonly created: TeamPreset } | null {
  const source = presets.find((item) => item.id === sourceId);
  if (!source) return null;
  const id = generateUniqueId(
    `${source.id}-copy`,
    presets.map((item) => item.id),
  );
  const created = TeamPresetSchema.parse({
    ...source,
    id,
    name: `${source.name} (${copySuffix})`.slice(0, 80),
    members: source.members.map((member) => ({
      ...member,
      features: { ...member.features },
    })),
  });
  return {
    presets: [...presets, created],
    created,
  };
}

export function updatePreset(
  presets: readonly TeamPreset[],
  presetId: Str,
  patch: Partial<TeamPreset>,
): TeamPreset[] {
  return presets.map((item) => {
    if (item.id !== presetId) return item;
    return {
      ...item,
      ...patch,
      id: item.id,
    };
  });
}

export function deletePreset(
  settings: TeamSettingsValues,
  presetId: Str,
): TeamSettingsValues {
  if (settings.presets.length <= 1) return settings;
  const remaining = settings.presets.filter((item) => item.id !== presetId);
  if (remaining.length === settings.presets.length || remaining.length === 0) {
    return settings;
  }
  const nextDefault =
    settings.defaultPresetId === presetId || !remaining.some((item) => item.id === settings.defaultPresetId)
      ? remaining[0].id
      : settings.defaultPresetId;
  return {
    ...settings,
    presets: remaining,
    defaultPresetId: nextDefault,
  };
}

export function upsertMember(preset: TeamPreset, member: TeamMember): TeamPreset {
  const parsed = TeamMemberSchema.parse(member);
  const exists = preset.members.some((item) => item.id === parsed.id);
  const nextMembers = exists
    ? preset.members.map((item) => (item.id === parsed.id ? parsed : item))
    : [...preset.members, parsed];
  return {
    ...preset,
    members: nextMembers,
  };
}

export function toggleMemberEnabled(
  preset: TeamPreset,
  memberId: Str,
  enabled: Bool,
): TeamPreset {
  return {
    ...preset,
    members: preset.members.map((item) =>
      item.id === memberId ? { ...item, enabled } : item,
    ),
  };
}

export function deleteMember(preset: TeamPreset, memberId: Str): TeamPreset {
  return {
    ...preset,
    members: preset.members.filter((item) => item.id !== memberId),
  };
}

export function formatMemberSummary(member: TeamMember): Str {
  const parts: Str[] = [formatProviderModel(member.provider, member.model)];
  if (member.thinkingOptionId.trim()) {
    parts.push(member.thinkingOptionId.trim());
  }
  if (member.modeId.trim()) {
    parts.push(member.modeId.trim());
  }
  const featureEntries = Object.entries(member.features).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [key, value] of featureEntries) {
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" · ");
}

export function updateWorkspaceOverride(
  settings: TeamSettingsValues,
  workspaceId: Str,
  override: WorkspaceOverride | null,
): TeamSettingsValues {
  const nextOverrides: Record<Str, WorkspaceOverride> = {
    ...settings.workspaceOverrides,
  };
  if (override === null || (override.enabled === undefined && override.presetId === undefined)) {
    delete nextOverrides[workspaceId];
  } else {
    nextOverrides[workspaceId] = override;
  }
  return {
    ...settings,
    workspaceOverrides: nextOverrides,
  };
}

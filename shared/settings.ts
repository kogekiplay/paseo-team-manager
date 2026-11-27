import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "paseo-team-manager";
export const SETTINGS_ID = "team";
export const AUTO_PROVIDER = "auto";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const METADATA_KEYS = {
  teamEnabled: "paseo-team-manager.enabled",
  presetId: "paseo-team-manager.presetId",
  roleId: "paseo-team-manager.role",
  memberOverrides: "paseo-team-manager.memberOverrides",
} as const;
export const LABEL_KEYS = {
  role: "paseo-team-manager.role",
  preset: "paseo-team-manager.preset",
} as const;

export const FeatureValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export const SessionMemberOverrideSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().max(128).default(""),
  thinkingOptionId: z.string().trim().max(64).optional(),
  features: z.record(z.string(), FeatureValueSchema).optional(),
  updatedAt: z.string().trim().max(64).optional(),
  baseFingerprint: z.string().trim().max(512).optional(),
}).refine((override) => override.provider === AUTO_PROVIDER || override.model.length > 0, {
  message: "Model is required when provider is not auto",
  path: ["model"],
});
const roleIdSchema = z.string().trim().min(1).max(48).regex(/^[a-z0-9][a-z0-9_-]*$/i);
export const SessionMemberOverridesMapSchema = z.record(roleIdSchema, SessionMemberOverrideSchema);

export const TeamMemberSchema = z.object({
  id: z.string().trim().min(1).max(64),
  roleId: roleIdSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().max(128).default(""),
  thinkingOptionId: z.string().trim().max(64).default(""),
  modeId: z.string().trim().max(64).default(""),
  features: z.record(z.string(), FeatureValueSchema).default({}),
  responsibilities: z.string().max(1000).default(""),
  rolePrompt: z.string().max(4000).default(""),
}).refine((member) => member.provider === AUTO_PROVIDER || member.model.trim().length > 0, {
  message: "Model is required when provider is not auto",
  path: ["model"],
});
export const TeamPresetSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).default(""),
  commanderNoDirectEdit: z.boolean().default(true),
  commanderExtraInstructions: z.string().max(4000).default(""),
  members: z.array(TeamMemberSchema).default([]),
});
export const WorkspaceOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  presetId: z.string().trim().min(1).max(64).optional(),
});
export const teamSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoApplyToNewTopLevelAgents: z.boolean().default(true),
  showComposerControl: z.boolean().default(true),
  enforceMemberDefaultsOnCreate: z.boolean().default(true),
  excludedDirectories: z.array(z.string().trim().min(1)).default([]),
  defaultPresetId: z.string().trim().min(1).default("default-fullstack"),
  presets: z.array(TeamPresetSchema).min(1).default(createDefaultPresets),
  workspaceOverrides: z.record(z.string(), WorkspaceOverrideSchema).default({}),
});

export type FeatureValue = z.infer<typeof FeatureValueSchema>;
export type SessionMemberOverride = z.infer<typeof SessionMemberOverrideSchema>;
export type SessionMemberOverridesMap = z.infer<typeof SessionMemberOverridesMapSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamPreset = z.infer<typeof TeamPresetSchema>;
export type WorkspaceOverride = z.infer<typeof WorkspaceOverrideSchema>;
export type TeamSettingsValues = z.infer<typeof teamSettingsSchema>;

export function normalizeDirectoryPath(input: string, homeDir?: string): string {
  let path = input.trim();
  if (homeDir && (path === "~" || path.startsWith("~/"))) {
    path = homeDir + path.slice(1);
  }
  const normalized = path.replace(/\/{2,}/g, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function computeMemberConfigFingerprint(
  member: Pick<TeamMember, "provider" | "model" | "thinkingOptionId" | "modeId" | "features">,
): string {
  const provider = member.provider.trim().toLowerCase();
  const canonical = JSON.stringify({
    provider,
    model: provider === AUTO_PROVIDER ? "" : member.model.trim(),
    thinkingOptionId: member.thinkingOptionId.trim(),
    modeId: member.modeId.trim(),
    features: Object.fromEntries(Object.keys(member.features).sort().map((key) => [key, member.features[key]])),
  });
  if (canonical.length <= 512) return canonical;

  // Long feature values must fit the metadata schema. Hash in both directions with portable 32-bit arithmetic.
  let forward = 0x811c9dc5;
  let reverse = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) {
    forward = Math.imul(forward ^ canonical.charCodeAt(index), 0x01000193);
    reverse = Math.imul(reverse ^ canonical.charCodeAt(canonical.length - index - 1), 0x01000193);
  }
  return JSON.stringify([canonical.length, forward >>> 0, reverse >>> 0]);
}

export function computeTeamSyncFingerprint(settings: TeamSettingsValues): string {
  return JSON.stringify({
    enabled: settings.enabled,
    autoApplyToNewTopLevelAgents: settings.autoApplyToNewTopLevelAgents,
    defaultPresetId: settings.defaultPresetId,
    excludedDirectories: [...new Set(settings.excludedDirectories.map((path) => normalizeDirectoryPath(path)))].sort(),
    workspaceOverrides: Object.keys(settings.workspaceOverrides).sort().map((key) => {
      const override = settings.workspaceOverrides[key];
      return [key, { enabled: override.enabled, presetId: override.presetId }];
    }),
    presets: settings.presets.map(({ id, commanderNoDirectEdit, members }) => ({
      id,
      commanderNoDirectEdit,
      members: members.map((member) => ({
        id: member.id, roleId: member.roleId, enabled: member.enabled, config: computeMemberConfigFingerprint(member),
      })),
    })),
  });
}

export function parseSessionMemberOverrides(
  metadata?: Readonly<Record<string, unknown>> | null,
): SessionMemberOverridesMap {
  const raw = metadata?.[METADATA_KEYS.memberOverrides];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    const roleId = roleIdSchema.safeParse(key);
    const override = SessionMemberOverrideSchema.safeParse(value);
    return roleId.success && override.success ? [[roleId.data.toLowerCase(), override.data]] : [];
  }));
}

export function filterActiveSessionMemberOverrides(
  basePreset: TeamPreset,
  overrides: SessionMemberOverridesMap,
): { active: SessionMemberOverridesMap; supersededRoleIds: string[] } {
  const activeOverrides: [string, SessionMemberOverride][] = [];
  const supersededRoleIds: string[] = [];
  for (const [key, override] of Object.entries(overrides)) {
    const roleId = key.toLowerCase();
    const baseMember = basePreset.members.find((member) => member.roleId.toLowerCase() === roleId);
    if (!baseMember || (override.baseFingerprint !== undefined && override.baseFingerprint !== computeMemberConfigFingerprint(baseMember))) {
      supersededRoleIds.push(roleId);
    } else {
      activeOverrides.push([roleId, override]);
    }
  }
  return { active: Object.fromEntries(activeOverrides), supersededRoleIds };
}

export function applySessionMemberOverridesToPreset(
  preset: TeamPreset,
  overrides: SessionMemberOverridesMap,
): TeamPreset {
  if (Object.keys(overrides).length === 0) return preset;
  return {
    ...preset,
    members: preset.members.map((member) => {
      const roleId = member.roleId.toLowerCase();
      if (!Object.hasOwn(overrides, roleId)) return member;
      const override = overrides[roleId];
      const automatic = override.provider === AUTO_PROVIDER;
      const sameProvider = !automatic && override.provider.trim().toLowerCase() === member.provider.trim().toLowerCase();
      return {
        ...member,
        provider: override.provider,
        model: automatic ? "" : override.model,
        thinkingOptionId: override.thinkingOptionId ?? (sameProvider ? member.thinkingOptionId : ""),
        modeId: sameProvider ? member.modeId : "",
        features: { ...(override.features ?? (sameProvider ? member.features : {})) },
      };
    }),
  };
}

export function createDefaultPresets(): TeamPreset[] {
  return [TeamPresetSchema.parse({
    id: "default-fullstack",
    name: "全栈开发团队",
    description: "自动适配当前宿主机可用模型，指挥统筹派发不直接改代码",
    commanderNoDirectEdit: true,
    members: [
      {
        id: "backend",
        roleId: "backend",
        name: "后端开发",
        provider: AUTO_PROVIDER,
        model: "",
        thinkingOptionId: "",
        modeId: "",
        features: {},
        responsibilities: "负责服务端、daemon、API、数据层、算法逻辑及对应单元测试。",
        rolePrompt: "按约定的接口契约实现后端逻辑，处理输入校验、错误和状态一致性。与前端对接时明确数据结构和失败行为，并验证正常及异常路径。",
      },
      {
        id: "frontend",
        roleId: "frontend",
        name: "前端开发",
        provider: AUTO_PROVIDER,
        model: "",
        thinkingOptionId: "",
        modeId: "",
        responsibilities: "负责 UI 组件、交互体验、样式主题及跨端响应式适配。",
        rolePrompt: "以共享接口契约为准实现界面，覆盖加载、空数据和错误状态，并验证不同屏幕尺寸与主题下的交互和可读性。",
      },
      {
        id: "reviewer",
        roleId: "reviewer",
        name: "代码审查官",
        enabled: false,
        provider: AUTO_PROVIDER,
        model: "",
        thinkingOptionId: "",
        modeId: "",
        features: {},
        responsibilities: "只读审查代码与架构，检查边界条件、回归风险和安全问题。",
        rolePrompt: "按影响程度列出发现，附文件位置、触发条件与建议。保持只读。",
      },
      {
        id: "qa",
        roleId: "qa",
        name: "测试与验收",
        enabled: false,
        provider: AUTO_PROVIDER,
        model: "",
        thinkingOptionId: "",
        modeId: "",
        features: {},
        responsibilities: "编写单元、集成及端到端测试，定位缺陷并执行回归与验收。",
        rolePrompt: "从验收标准建立测试场景，记录验证命令、结果与失败条件。",
      },
      {
        id: "explorer",
        roleId: "explorer",
        name: "代码库侦察员",
        enabled: false,
        provider: AUTO_PROVIDER,
        model: "",
        thinkingOptionId: "",
        modeId: "",
        responsibilities: "检索代码库、梳理依赖、定位日志并汇总相关文档。",
        rolePrompt: "以只读方式定位入口、调用链和相关资料，汇报时附可核对的文件或日志位置。",
      },
    ],
  })];
}

export function parseTeamSettings(raw: unknown): TeamSettingsValues {
  return teamSettingsSchema.parse(raw);
}

export const DEFAULT_TEAM_SETTINGS = parseTeamSettings({});

export function migrateTeamSettings(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || typeof values !== "object" || values === null || Array.isArray(values)) return values;
  const raw = values as Record<string, unknown>;
  const presets = Array.isArray(raw.presets)
    ? raw.presets.map((preset) => {
      if (typeof preset !== "object" || preset === null || Array.isArray(preset)) return preset;
      const presetRecord = preset as Record<string, unknown>;
      const members = Array.isArray(presetRecord.members)
        ? presetRecord.members.map((member) => {
          if (typeof member !== "object" || member === null || Array.isArray(member)) return member;
          const memberRecord = member as Record<string, unknown>;
          const model = memberRecord.model;
          if (typeof model !== "string" || !/(astra|fable)/i.test(model)) return member;
          return { ...memberRecord, model: "auto/gpt-6.2-sol" };
        })
        : presetRecord.members;
      return { ...presetRecord, ...(Array.isArray(presetRecord.members) ? { members } : {}) };
    })
    : raw.presets;
  return { ...raw, ...(Array.isArray(raw.presets) ? { presets } : {}) };
}

export const teamSettings = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: 2,
  schema: teamSettingsSchema,
  migrate: migrateTeamSettings,
});

export function formatProviderModel(provider: string, model: string): string {
  if (provider === AUTO_PROVIDER) return AUTO_PROVIDER;
  return model ? `${provider}/${model}` : provider;
}

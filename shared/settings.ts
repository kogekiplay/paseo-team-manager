import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "paseo-team-manager";
export const SETTINGS_ID = "team";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const METADATA_KEYS = {
  teamEnabled: "paseo-team-manager.enabled",
  presetId: "paseo-team-manager.presetId",
  roleId: "paseo-team-manager.role",
} as const;
export const LABEL_KEYS = {
  role: "paseo-team-manager.role",
  preset: "paseo-team-manager.preset",
} as const;

export const FeatureValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export const TeamMemberSchema = z.object({
  id: z.string().trim().min(1).max(64),
  roleId: z.string().trim().min(1).max(48).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  thinkingOptionId: z.string().trim().max(64).default(""),
  modeId: z.string().trim().max(64).default("full-access"),
  features: z.record(z.string(), FeatureValueSchema).default({}),
  responsibilities: z.string().max(1000).default(""),
  rolePrompt: z.string().max(4000).default(""),
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
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamPreset = z.infer<typeof TeamPresetSchema>;
export type WorkspaceOverride = z.infer<typeof WorkspaceOverrideSchema>;
export type TeamSettingsValues = z.infer<typeof teamSettingsSchema>;

export function createDefaultPresets(): TeamPreset[] {
  return [TeamPresetSchema.parse({
    id: "default-fullstack",
    name: "全栈开发团队",
    description: "后端 Codex + 前端 Antigravity 核心双核，指挥统筹派发不直接改代码",
    commanderNoDirectEdit: true,
    members: [
      {
        id: "backend",
        roleId: "backend",
        name: "后端开发",
        provider: "codex",
        model: "auto/gpt-6.2-sol",
        thinkingOptionId: "xhigh",
        modeId: "full-access",
        features: { service_tier: "default" },
        responsibilities: "负责服务端、daemon、API、数据层、算法逻辑及对应单元测试。",
        rolePrompt: "按约定的接口契约实现后端逻辑，处理输入校验、错误和状态一致性。与前端对接时明确数据结构和失败行为，并验证正常及异常路径。",
      },
      {
        id: "frontend",
        roleId: "frontend",
        name: "前端开发",
        provider: "antigravity",
        model: "gemini-4-neon",
        thinkingOptionId: "high",
        modeId: "full-access",
        responsibilities: "负责 UI 组件、交互体验、样式主题及跨端响应式适配。",
        rolePrompt: "以共享接口契约为准实现界面，覆盖加载、空数据和错误状态，并验证不同屏幕尺寸与主题下的交互和可读性。",
      },
      {
        id: "reviewer",
        roleId: "reviewer",
        name: "代码审查官",
        enabled: false,
        provider: "codex",
        model: "auto/gpt-6.2-astra",
        thinkingOptionId: "xhigh",
        modeId: "auto",
        features: { service_tier: "default" },
        responsibilities: "只读审查代码与架构，检查边界条件、回归风险和安全问题。",
        rolePrompt: "按影响程度列出发现，附文件位置、触发条件与建议。保持只读。",
      },
      {
        id: "qa",
        roleId: "qa",
        name: "测试与验收",
        enabled: false,
        provider: "codex",
        model: "auto/gpt-6.2-sol",
        thinkingOptionId: "xhigh",
        modeId: "full-access",
        features: { service_tier: "default" },
        responsibilities: "编写单元、集成及端到端测试，定位缺陷并执行回归与验收。",
        rolePrompt: "从验收标准建立测试场景，记录验证命令、结果与失败条件。",
      },
      {
        id: "explorer",
        roleId: "explorer",
        name: "代码库侦察员",
        enabled: false,
        provider: "antigravity",
        model: "gemini-4-hydrogen",
        thinkingOptionId: "medium",
        modeId: "plan",
        responsibilities: "检索代码库、梳理依赖、定位日志并汇总相关文档。",
        rolePrompt: "以只读方式定位入口、调用链和相关资料，汇报时附可核对的文件或日志位置。",
      },
    ],
  })];
}

export const teamSettings = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: teamSettingsSchema,
});

export function parseTeamSettings(raw: unknown): TeamSettingsValues {
  return teamSettingsSchema.parse(raw);
}

export const DEFAULT_TEAM_SETTINGS = parseTeamSettings({});

export function formatProviderModel(provider: string, model: string): string {
  return model ? `${provider}/${model}` : provider;
}

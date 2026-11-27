import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FeatureValueSchema, SessionMemberOverridesMapSchema, TeamPresetSchema } from "./settings.ts";

const providerControlFields = {
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  tooltip: z.string().optional(),
  icon: z.string().optional(),
};
export const ProviderCatalogControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle"), ...providerControlFields, defaultValue: z.boolean().optional() }),
  z.object({
    type: z.literal("select"),
    ...providerControlFields,
    desktopTrigger: z.enum(["icon", "label"]).optional(),
    defaultValue: z.string().optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })),
  }),
]);
export const ProviderCatalogModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export const ProviderCatalogThinkingOptionSchema = ProviderCatalogModeSchema.extend({
  isDefault: z.boolean().optional(),
});
export const ProviderCatalogModelSchema = ProviderCatalogModeSchema.extend({
  isSelectable: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultThinkingOptionId: z.string().optional(),
  thinkingOptions: z.array(ProviderCatalogThinkingOptionSchema),
});
export const MemberResolutionStatusSchema = z.enum(["explicit", "auto-matched", "fallback-host", "fallback-caller", "unresolved"]);
export const AgentSyncStatusSchema = z.enum(["in-sync", "update-in-place", "replace-provider", "unresolved"]);
export const ResolvedMemberSummarySchema = z.object({
  memberId: z.string(),
  roleId: z.string(),
  status: MemberResolutionStatusSchema,
  configuredProvider: z.string(),
  configuredModel: z.string(),
  provider: z.string(),
  model: z.string(),
  thinkingOptionId: z.string(),
  modeId: z.string(),
  features: z.record(z.string(), FeatureValueSchema),
  fallbackReason: z.string().nullable(),
  overriddenInSession: z.boolean().default(false),
});
export const ProviderCatalogEntrySchema = z.object({
  provider: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  error: z.string().optional(),
  defaultModeId: z.string().nullable(),
  modes: z.array(ProviderCatalogModeSchema),
  models: z.array(ProviderCatalogModelSchema),
  controls: z.array(ProviderCatalogControlSchema),
});
export const EffectiveDecisionSourceSchema = z.enum([
  "agent-metadata", "workspace-override", "excluded-directory", "global-default",
]);
export const WorkspaceTeamAgentSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  roleId: z.string().nullable(),
  presetId: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  status: z.string(),
  isCommander: z.boolean(),
  background: z.boolean(),
  updatedAt: z.string(),
  syncStatus: AgentSyncStatusSchema.nullable().optional(),
  syncReason: z.string().nullable().optional(),
  targetProviderModel: z.string().nullable().optional(),
});

export const providerCatalogInputSchema = z.object({ cwd: z.string().optional(), refresh: z.boolean().optional() });
export const providerCatalogOutputSchema = z.object({
  homeDir: z.string(),
  fetchedAt: z.string(),
  providers: z.array(ProviderCatalogEntrySchema),
});
export const providerControlsInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().optional(),
  modeId: z.string().optional(),
  cwd: z.string().optional(),
});
export const providerControlsOutputSchema = z.object({
  provider: z.string(),
  controls: z.array(ProviderCatalogControlSchema),
  defaults: z.record(z.string(), FeatureValueSchema.nullable()),
  error: z.string().nullable(),
});
export const workspaceTeamStateInputSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().optional(),
  cwd: z.string().optional(),
});
export const workspaceTeamStateOutputSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string().nullable(),
  homeDir: z.string(),
  effectiveEnabled: z.boolean(),
  decisionSource: EffectiveDecisionSourceSchema,
  excludedByDirectory: z.string().nullable(),
  activePresetId: z.string(),
  activePreset: TeamPresetSchema,
  sessionMemberOverrides: SessionMemberOverridesMapSchema.default({}),
  resolvedMembers: z.array(ResolvedMemberSummarySchema),
  agents: z.array(WorkspaceTeamAgentSchema),
});
export const previewCommanderPromptInputSchema = z.object({
  preset: TeamPresetSchema.optional(),
  presetId: z.string().optional(),
  cwd: z.string().optional(),
  workspaceId: z.string().optional(),
  roleId: z.string().optional(),
});
export const previewCommanderPromptOutputSchema = z.object({
  presetId: z.string(),
  commanderPrompt: z.string(),
  rolePrompt: z.string().nullable(),
  resolvedMembers: z.array(ResolvedMemberSummarySchema),
});

export const getProviderCatalogRpc = defineRpc({
  name: "team.provider_catalog", input: providerCatalogInputSchema, output: providerCatalogOutputSchema,
});
export const getProviderControlsRpc = defineRpc({
  name: "team.provider_controls", input: providerControlsInputSchema, output: providerControlsOutputSchema,
});
export const getWorkspaceTeamStateRpc = defineRpc({
  name: "team.workspace_state", input: workspaceTeamStateInputSchema, output: workspaceTeamStateOutputSchema,
});
export const previewCommanderPromptRpc = defineRpc({
  name: "team.preview_prompt", input: previewCommanderPromptInputSchema, output: previewCommanderPromptOutputSchema,
});

export type ProviderCatalogControl = z.infer<typeof ProviderCatalogControlSchema>;
export type ProviderCatalogMode = z.infer<typeof ProviderCatalogModeSchema>;
export type ProviderCatalogThinkingOption = z.infer<typeof ProviderCatalogThinkingOptionSchema>;
export type ProviderCatalogModel = z.infer<typeof ProviderCatalogModelSchema>;
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;
export type MemberResolutionStatus = z.infer<typeof MemberResolutionStatusSchema>;
export type AgentSyncStatus = z.infer<typeof AgentSyncStatusSchema>;
export type ResolvedMemberSummary = z.infer<typeof ResolvedMemberSummarySchema>;
export type WorkspaceTeamAgent = z.infer<typeof WorkspaceTeamAgentSchema>;
export type ProviderCatalogInput = z.infer<typeof providerCatalogInputSchema>;
export type ProviderCatalogOutput = z.infer<typeof providerCatalogOutputSchema>;
export type ProviderControlsInput = z.infer<typeof providerControlsInputSchema>;
export type ProviderControlsOutput = z.infer<typeof providerControlsOutputSchema>;
export type WorkspaceTeamStateInput = z.infer<typeof workspaceTeamStateInputSchema>;
export type WorkspaceTeamStateOutput = z.infer<typeof workspaceTeamStateOutputSchema>;
export type PreviewCommanderPromptInput = z.infer<typeof previewCommanderPromptInputSchema>;
export type PreviewCommanderPromptOutput = z.infer<typeof previewCommanderPromptOutputSchema>;

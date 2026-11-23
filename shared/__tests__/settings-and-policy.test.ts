import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractRoleIdFromTitle, findMatchingExcludedDirectory, findMemberByRole, isSubagentLabels,
  normalizeDirectoryPath, resolveEffectiveTeamConfig, resolveSubagentRoleId, resolveWorkspaceOverride,
} from "../policy.ts";
import {
  createDefaultPresets, DEFAULT_TEAM_SETTINGS, formatProviderModel, LABEL_KEYS, METADATA_KEYS,
  PARENT_AGENT_ID_LABEL, parseTeamSettings, teamSettings, TeamMemberSchema, TeamPresetSchema,
} from "../settings.ts";

const homeDir = "/Users/tester";

test("the host setting defines the full default team and independent snapshots", () => {
  assert.equal(teamSettings.id, "team");
  assert.equal(teamSettings.scope, "host");
  assert.equal(teamSettings.version, 2);
  assert.deepEqual(parseTeamSettings({}), DEFAULT_TEAM_SETTINGS);
  const { defaultPresetId, presets: [preset], ...settings } = DEFAULT_TEAM_SETTINGS;
  assert.deepEqual(settings, {
    enabled: true, autoApplyToNewTopLevelAgents: true, showComposerControl: true,
    enforceMemberDefaultsOnCreate: true, excludedDirectories: [], workspaceOverrides: {},
  });
  assert.equal(defaultPresetId, "default-fullstack");
  assert.equal(preset.id, defaultPresetId);
  assert.equal(preset.name, "全栈开发团队");
  assert.equal(preset.description, "自动适配当前宿主机可用模型，指挥统筹派发不直接改代码");
  assert.equal(preset.commanderNoDirectEdit, true);
  assert.deepEqual(preset.members.map(({ roleId, enabled, provider, model, thinkingOptionId, modeId, features }) =>
    [roleId, enabled, provider, model, thinkingOptionId, modeId, features]), [
    ["backend", true, "auto", "", "", "", {}],
    ["frontend", true, "auto", "", "", "", {}],
    ["reviewer", false, "auto", "", "", "", {}],
    ["qa", false, "auto", "", "", "", {}],
    ["explorer", false, "auto", "", "", "", {}],
  ]);
  assert.ok(preset.members.every((member) => member.responsibilities && member.rolePrompt));
  assert.deepEqual(new Set(preset.members.map((member) => formatProviderModel(member.provider, member.model))), new Set([
    "auto",
  ]));
  const independent = parseTeamSettings({});
  independent.presets[0].members[0].features.service_tier = "priority";
  independent.presets[0].members.pop();
  assert.deepEqual(parseTeamSettings({}).presets, createDefaultPresets());
  assert.equal(createDefaultPresets()[0].members.length, 5);
  assert.deepEqual(createDefaultPresets()[0].members[0].features, {});
});

test("settings migration replaces legacy high-cost models while preserving custom settings", () => {
  const legacy = {
    enabled: false,
    customSetting: "preserve me",
    presets: [{
      id: "custom", name: "Custom", commanderExtraInstructions: "Keep this",
      members: [
        { id: "one", roleId: "one", name: "One", provider: "codex", model: "auto/gpt-6.2-AsTrA", enabled: false },
        { id: "two", roleId: "two", name: "Two", provider: "codex", model: "auto/gpt-6.1-FABLE", features: { custom: true } },
        { id: "three", roleId: "three", name: "Three", provider: "codex", model: "auto/gpt-6.1-terra" },
      ],
    }],
  };
  const migrated = teamSettings.migrate!(legacy, 1) as typeof legacy;
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.customSetting, "preserve me");
  assert.equal(migrated.presets[0].commanderExtraInstructions, "Keep this");
  assert.equal(migrated.presets[0].members[0].model, "auto/gpt-6.2-sol");
  assert.equal(migrated.presets[0].members[1].model, "auto/gpt-6.2-sol");
  assert.equal(migrated.presets[0].members[1].features?.custom, true);
  assert.equal(migrated.presets[0].members[2].model, "auto/gpt-6.1-terra");
  assert.equal((legacy.presets[0].members[0] as { model: string }).model, "auto/gpt-6.2-AsTrA");
  assert.deepEqual(teamSettings.migrate!(legacy, 2), legacy);
});

test("settings validate required fields, role IDs, feature values and preset presence", () => {
  const member = { id: " custom ", roleId: " Api-v2 ", name: " API ", provider: " codex ", model: " model " };
  assert.deepEqual(TeamMemberSchema.parse(member), {
    id: "custom", roleId: "Api-v2", name: "API", provider: "codex", model: "model", enabled: true,
    thinkingOptionId: "", modeId: "", features: {}, responsibilities: "", rolePrompt: "",
  });
  assert.equal(TeamMemberSchema.safeParse({ ...member, roleId: "bad role" }).success, false);
  assert.equal(TeamMemberSchema.safeParse({ ...member, features: { bad: [] } }).success, false);
  assert.equal(TeamMemberSchema.safeParse({ ...member, model: " " }).success, false);
  assert.deepEqual(TeamMemberSchema.parse({ ...member, provider: "auto", model: "" }).model, "");
  assert.throws(() => parseTeamSettings({ presets: [] }));
  assert.throws(() => parseTeamSettings({ enabled: "true" }));
});

test("excluded paths normalize home, slash runs and directory boundaries", () => {
  assert.equal(normalizeDirectoryPath(" ~//Downloads/// ", homeDir), `${homeDir}/Downloads`);
  assert.equal(normalizeDirectoryPath("~", homeDir), homeDir);
  assert.equal(normalizeDirectoryPath("~/folder/"), "~/folder");
  assert.equal(normalizeDirectoryPath("///"), "/");
  assert.equal(findMatchingExcludedDirectory(`${homeDir}/Downloads//notes/`, ["~/Downloads//"], homeDir), "~/Downloads//");
  assert.equal(findMatchingExcludedDirectory(`${homeDir}/Downloads`, ["~/Downloads"], homeDir), "~/Downloads");
  assert.equal(findMatchingExcludedDirectory(`${homeDir}/Downloads-old`, ["~/Downloads"], homeDir), null);
  assert.equal(findMatchingExcludedDirectory("/tmp/project", ["/"], homeDir), "/");
  assert.equal(findMatchingExcludedDirectory(null, ["/"], homeDir), null);
});

test("team enablement follows metadata, workspace, exclusion and global in order", () => {
  const cwd = `${homeDir}/Downloads/project`;
  const workspaceId = "workspace-1";
  const settings = parseTeamSettings({ excludedDirectories: ["~/Downloads"], workspaceOverrides: {
    [workspaceId]: { enabled: true }, "~/Downloads/project/": { enabled: false },
  } });
  const resolve = (metadata?: Record<string, unknown>, id: string | null = workspaceId, path = cwd) =>
    resolveEffectiveTeamConfig({ settings, workspaceId: id, cwd: path, metadata, homeDir });
  assert.equal(resolve({ [METADATA_KEYS.teamEnabled]: false }).enabled, false);
  assert.equal(resolve({ [METADATA_KEYS.teamEnabled]: false }).source, "agent-metadata");
  assert.equal(resolve({ [METADATA_KEYS.teamEnabled]: true }, null).enabled, true);
  assert.equal(resolve({ [METADATA_KEYS.teamEnabled]: "false" }).source, "workspace-override");
  assert.equal(resolve().enabled, true);
  assert.equal(resolve().excludedByDirectory, "~/Downloads");
  assert.equal(resolve(undefined, null).enabled, false);
  assert.equal(resolve(undefined, null).source, "workspace-override");
  assert.equal(resolve(undefined, null, `${cwd}/nested`).source, "excluded-directory");
  assert.equal(resolve(undefined, null, `/repo`).source, "global-default");
  assert.equal(resolve(undefined, null, `/repo`).enabled, true);
  for (const override of [{ enabled: false }, { autoApplyToNewTopLevelAgents: false }]) {
    assert.equal(resolveEffectiveTeamConfig({ settings: parseTeamSettings(override) }).enabled, false);
  }
  assert.deepEqual(resolveWorkspaceOverride(settings, { workspaceId, cwd, homeDir }), { enabled: true });
});

test("the global setting is a hard gate over session and workspace enablement", () => {
  const settings = parseTeamSettings({
    enabled: false,
    workspaceOverrides: { "workspace-1": { enabled: true } },
  });
  const effective = resolveEffectiveTeamConfig({
    settings,
    workspaceId: "workspace-1",
    cwd: "/project",
    metadata: { [METADATA_KEYS.teamEnabled]: true },
  });
  assert.equal(effective.enabled, false);
  assert.equal(effective.source, "global-default");
});

test("preset selection falls through valid IDs and role lookups search preferred then default", () => {
  const [base] = createDefaultPresets();
  const preset = (id: string) => TeamPresetSchema.parse({ ...base, id });
  const settings = parseTeamSettings({
    defaultPresetId: "default",
    presets: [preset("first"), preset("default"), preset("override"), preset("label"), preset("metadata")],
    workspaceOverrides: { "~/repo": { presetId: "override" } },
  });
  const context = { settings, cwd: `${homeDir}/repo/`, homeDir };
  const labels = { [LABEL_KEYS.preset]: "label" };
  assert.equal(resolveEffectiveTeamConfig({ ...context, labels, metadata: { [METADATA_KEYS.presetId]: "metadata" } }).presetId, "metadata");
  assert.equal(resolveEffectiveTeamConfig({ ...context, labels, metadata: { [METADATA_KEYS.presetId]: "missing" } }).presetId, "label");
  assert.equal(resolveEffectiveTeamConfig(context).presetId, "override");
  assert.equal(resolveEffectiveTeamConfig({ settings }).presetId, "default");
  assert.equal(resolveEffectiveTeamConfig({ settings: { ...settings, defaultPresetId: "missing" } }).presetId, "first");
  assert.equal(findMemberByRole(settings, " BACKEND ", "label")?.preset.id, "label");
  assert.equal(findMemberByRole(settings, "backend", "missing")?.preset.id, "default");
  assert.equal(findMemberByRole({ ...settings, defaultPresetId: "missing" }, "reviewer")?.preset.id, "first");
  assert.equal(findMemberByRole(settings, "unknown"), null);
});

test("only parent labels identify children and role resolution prefers explicit values", () => {
  assert.equal(isSubagentLabels(undefined), false);
  assert.equal(isSubagentLabels({ [LABEL_KEYS.role]: "backend" }), false);
  assert.equal(isSubagentLabels({ [PARENT_AGENT_ID_LABEL]: "  " }), false);
  assert.equal(isSubagentLabels({ [PARENT_AGENT_ID_LABEL]: " parent " }), true);
  assert.equal(extractRoleIdFromTitle("  [API_v2-x] work"), "api_v2-x");
  assert.equal(extractRoleIdFromTitle("work [backend]"), null);
  assert.equal(extractRoleIdFromTitle("[-backend]"), null);
  assert.equal(extractRoleIdFromTitle(null), null);
  const title = "[frontend] work";
  const metadata = { [METADATA_KEYS.roleId]: " QA " };
  assert.equal(resolveSubagentRoleId({ labels: { [LABEL_KEYS.role]: " BACKEND " }, metadata, title }), "backend");
  assert.equal(resolveSubagentRoleId({ labels: { [LABEL_KEYS.role]: " " }, metadata, title }), "qa");
  assert.equal(resolveSubagentRoleId({ metadata: { [METADATA_KEYS.roleId]: false }, title }), "frontend");
});

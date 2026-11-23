import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TEAM_SETTINGS,
  METADATA_KEYS,
  TeamMemberSchema,
} from "../../shared/settings.ts";
import {
  addExcludedDirectory,
  buildComposerMetadataPatch,
  COMPOSER_AUTO_VALUE,
  COMPOSER_OFF_VALUE,
  createNewPreset,
  decodeComposerPresetId,
  deleteMember,
  deletePreset,
  duplicatePreset,
  encodeComposerTeamValue,
  formatMemberSummary,
  hasExcludedDirectory,
  isValidRoleId,
  localizeModeLabel,
  localizeProviderControl,
  localizeThinkingLabel,
  normalizeExcludedDirectories,
  parseTeamSlashArgs,
  removeExcludedDirectory,
  toggleMemberEnabled,
  updatePreset,
  updateWorkspaceOverride,
  upsertMember,
} from "../team-state.ts";

describe("composer metadata encoding and patches", () => {
  const presets = DEFAULT_TEAM_SETTINGS.presets;

  it("encodes undefined or empty metadata as auto", () => {
    assert.equal(encodeComposerTeamValue(undefined, presets), COMPOSER_AUTO_VALUE);
    assert.equal(encodeComposerTeamValue({}, presets), COMPOSER_AUTO_VALUE);
  });

  it("encodes explicit false as off even if presetId is present", () => {
    assert.equal(
      encodeComposerTeamValue(
        {
          [METADATA_KEYS.teamEnabled]: false,
          [METADATA_KEYS.presetId]: "default-fullstack",
        },
        presets,
      ),
      COMPOSER_OFF_VALUE,
    );
  });

  it("encodes explicit true and known presetId as preset:ID", () => {
    assert.equal(
      encodeComposerTeamValue(
        {
          [METADATA_KEYS.teamEnabled]: true,
          [METADATA_KEYS.presetId]: "default-fullstack",
        },
        presets,
      ),
      "preset:default-fullstack",
    );
  });

  it("falls back to first preset when enabled is true and presetId is unknown", () => {
    assert.equal(
      encodeComposerTeamValue(
        {
          [METADATA_KEYS.teamEnabled]: true,
          [METADATA_KEYS.presetId]: "non-existent",
        },
        presets,
      ),
      "preset:default-fullstack",
    );
  });

  it("builds exact setMetadata patches for off, auto, and preset values", () => {
    assert.deepEqual(buildComposerMetadataPatch(COMPOSER_OFF_VALUE), {
      [METADATA_KEYS.teamEnabled]: false,
      [METADATA_KEYS.presetId]: null,
    });
    assert.deepEqual(buildComposerMetadataPatch(COMPOSER_AUTO_VALUE), {
      [METADATA_KEYS.teamEnabled]: null,
      [METADATA_KEYS.presetId]: null,
    });
    assert.deepEqual(buildComposerMetadataPatch("preset:default-fullstack"), {
      [METADATA_KEYS.teamEnabled]: true,
      [METADATA_KEYS.presetId]: "default-fullstack",
    });
    assert.equal(decodeComposerPresetId("preset:default-fullstack"), "default-fullstack");
    assert.equal(decodeComposerPresetId(COMPOSER_AUTO_VALUE), null);
  });
});

describe("parseTeamSlashArgs", () => {
  it("parses panel, settings, on, off, auto, and preset commands", () => {
    assert.deepEqual(parseTeamSlashArgs(""), { kind: "panel" });
    assert.deepEqual(parseTeamSlashArgs("   "), { kind: "panel" });
    assert.deepEqual(parseTeamSlashArgs("status"), { kind: "panel" });
    assert.deepEqual(parseTeamSlashArgs("PANEL"), { kind: "panel" });
    assert.deepEqual(parseTeamSlashArgs("settings"), { kind: "settings" });
    assert.deepEqual(parseTeamSlashArgs("config"), { kind: "settings" });
    assert.deepEqual(parseTeamSlashArgs("on"), { kind: "on" });
    assert.deepEqual(parseTeamSlashArgs("OFF"), { kind: "off" });
    assert.deepEqual(parseTeamSlashArgs("auto"), { kind: "auto" });
    assert.deepEqual(parseTeamSlashArgs("default"), { kind: "auto" });
    assert.deepEqual(parseTeamSlashArgs("preset default-fullstack"), {
      kind: "preset",
      presetId: "default-fullstack",
    });
    assert.deepEqual(parseTeamSlashArgs("  preset   Custom_Team  "), {
      kind: "preset",
      presetId: "Custom_Team",
    });
  });

  it("reports invalid arguments cleanly", () => {
    assert.deepEqual(parseTeamSlashArgs("preset"), { kind: "invalid", raw: "preset" });
    assert.deepEqual(parseTeamSlashArgs("preset a b"), { kind: "invalid", raw: "preset a b" });
    assert.deepEqual(parseTeamSlashArgs("unknown"), { kind: "invalid", raw: "unknown" });
  });
});

describe("excluded directory helpers", () => {
  const homeDir = "/Users/alex";

  it("normalizes and deduplicates tilde and expanded paths", () => {
    const dirs = normalizeExcludedDirectories(
      [" ~/Downloads/ ", "/Users/alex/Downloads", "", "/tmp//scratch/"],
      homeDir,
    );
    assert.deepEqual(dirs, ["~/Downloads/", "/tmp//scratch/"]);
    assert.equal(hasExcludedDirectory(dirs, "/Users/alex/Downloads", homeDir), true);
    assert.equal(hasExcludedDirectory(dirs, "~/Desktop", homeDir), false);
  });

  it("adds and removes excluded directories symmetrically", () => {
    const added = addExcludedDirectory([], "~/Downloads", homeDir);
    assert.deepEqual(added, ["~/Downloads"]);
    const duplicateAdded = addExcludedDirectory(added, "/Users/alex/Downloads/", homeDir);
    assert.deepEqual(duplicateAdded, ["~/Downloads"]);
    const removed = removeExcludedDirectory(added, "/Users/alex/Downloads", homeDir);
    assert.deepEqual(removed, []);
  });
});

describe("preset and member draft mutations", () => {
  it("creates, duplicates, updates, and safely deletes presets", () => {
    const createdRes = createNewPreset(DEFAULT_TEAM_SETTINGS.presets, "Backend Squad", "API focus");
    assert.equal(createdRes.presets.length, 2);
    assert.equal(createdRes.created.id, "backend-squad");

    const dupRes = duplicatePreset(createdRes.presets, "default-fullstack", "Copy");
    assert.ok(dupRes !== null);
    assert.equal(dupRes.presets.length, 3);
    assert.equal(dupRes.created.members.length, DEFAULT_TEAM_SETTINGS.presets[0].members.length);

    const updated = updatePreset(dupRes.presets, createdRes.created.id, {
      commanderNoDirectEdit: false,
      name: "Renamed Squad",
    });
    assert.equal(updated.find((p) => p.id === createdRes.created.id)?.name, "Renamed Squad");
    assert.equal(updated.find((p) => p.id === createdRes.created.id)?.commanderNoDirectEdit, false);

    // Deleting the default preset shifts defaultPresetId to the first remaining preset
    const afterDeleteDefault = deletePreset(
      { ...DEFAULT_TEAM_SETTINGS, presets: createdRes.presets, defaultPresetId: "default-fullstack" },
      "default-fullstack",
    );
    assert.equal(afterDeleteDefault.presets.length, 1);
    assert.equal(afterDeleteDefault.defaultPresetId, createdRes.created.id);

    // Cannot delete the last remaining preset
    const afterRefusedDelete = deletePreset(afterDeleteDefault, createdRes.created.id);
    assert.equal(afterRefusedDelete.presets.length, 1);
  });

  it("upserts, toggles, deletes, validates, and formats members", () => {
    const preset = DEFAULT_TEAM_SETTINGS.presets[0];
    const customMember = TeamMemberSchema.parse({
      id: "docs-writer",
      roleId: "docs",
      name: "Docs Writer",
      enabled: true,
      provider: "codex",
      model: "auto/gpt-6.2-sol",
      thinkingOptionId: "xhigh",
      modeId: "full-access",
      features: { service_tier: "default", plan_mode: false },
    });

    const withNew = upsertMember(preset, customMember);
    assert.equal(withNew.members.length, preset.members.length + 1);

    const withUpdated = upsertMember(withNew, { ...customMember, name: "Technical Writer" });
    assert.equal(withUpdated.members.length, preset.members.length + 1);
    assert.equal(withUpdated.members.find((m) => m.id === "docs-writer")?.name, "Technical Writer");

    const toggled = toggleMemberEnabled(withUpdated, "docs-writer", false);
    assert.equal(toggled.members.find((m) => m.id === "docs-writer")?.enabled, false);

    const deleted = deleteMember(toggled, "docs-writer");
    assert.equal(deleted.members.length, preset.members.length);

    assert.equal(isValidRoleId("backend"), true);
    assert.equal(isValidRoleId("qa_2-lead"), true);
    assert.equal(isValidRoleId("-bad"), false);
    assert.equal(isValidRoleId("bad space"), false);

    assert.equal(
      formatMemberSummary(customMember),
      "codex/auto/gpt-6.2-sol · xhigh · full-access · plan_mode=false · service_tier=default",
    );

    const backendMember = preset.members.find((m) => m.roleId === "backend");
    assert.ok(backendMember);
    assert.equal(
      formatMemberSummary(backendMember),
      "codex/auto/gpt-6.2-sol · xhigh · full-access · service_tier=default",
    );
  });

  it("sets and clears workspace overrides cleanly", () => {
    const withOverride = updateWorkspaceOverride(DEFAULT_TEAM_SETTINGS, "ws-1", {
      enabled: false,
    });
    assert.deepEqual(withOverride.workspaceOverrides["ws-1"], { enabled: false });

    const cleared = updateWorkspaceOverride(withOverride, "ws-1", null);
    assert.equal(cleared.workspaceOverrides["ws-1"], undefined);
  });
});

describe("dynamic provider label localization", () => {
  it("localizes thinking levels in zh locales and preserves original labels in en", () => {
    assert.equal(localizeThinkingLabel("low", "Low", "zh-CN"), "轻度");
    assert.equal(localizeThinkingLabel("medium", "Medium", "zh-CN"), "中");
    assert.equal(localizeThinkingLabel("high", "High", "zh-CN"), "高");
    assert.equal(localizeThinkingLabel("xhigh", "Extra High", "zh-CN"), "极高");
    assert.equal(localizeThinkingLabel("max", "Max", "zh-CN"), "最大");
    assert.equal(localizeThinkingLabel("ultra", "Ultra", "zh-CN"), "Ultra");
    assert.equal(localizeThinkingLabel("minimal", "Minimal", "zh-CN"), "最低");
    assert.equal(localizeThinkingLabel("none", "None", "zh-CN"), "无");
    assert.equal(localizeThinkingLabel("xhigh", "Extra High", "en"), "Extra High");
  });

  it("localizes session modes in zh locales and preserves original labels in en", () => {
    assert.equal(localizeModeLabel("default", "Default", "zh-CN"), "默认");
    assert.equal(localizeModeLabel("auto", "Default Permissions", "zh-CN"), "默认权限");
    assert.equal(localizeModeLabel("accept-edits", "Accept edits", "zh-CN"), "自动接受编辑");
    assert.equal(localizeModeLabel("auto", "Auto", "zh-CN"), "自动");
    assert.equal(localizeModeLabel("auto-review", "Auto-review", "zh-CN"), "自动审查");
    assert.equal(localizeModeLabel("plan", "Plan", "zh-CN"), "计划");
    assert.equal(localizeModeLabel("full-access", "Full Access", "zh-CN"), "完全访问");
    assert.equal(localizeModeLabel("bypass", "Bypass Permissions", "zh-CN"), "跳过权限确认");
    assert.equal(localizeModeLabel("read-only", "Read-only", "zh-CN"), "只读");
    assert.equal(localizeModeLabel("full-access", "Full Access", "en"), "Full Access");
  });

  it("localizes dynamic provider controls and formatted member summaries in zh locales", () => {
    const speedControl = localizeProviderControl(
      {
        type: "select",
        key: "service_tier",
        label: "Speed",
        description: "Choose processing speed. Faster tiers consume more usage.",
        choices: [
          { value: "default", label: "Normal" },
          { value: "flex", label: "Flex" },
          { value: "priority", label: "Fast" },
          { value: "ultrafast", label: "Ultrafast" },
          { value: "standard", label: "Standard" },
        ],
      },
      "zh-CN",
    );
    assert.equal(speedControl.label, "速度");
    assert.equal(speedControl.description, "选择处理速度。更快的层级会增加用量。");
    assert.equal(speedControl.type, "select");
    if (speedControl.type === "select") {
      assert.deepEqual(
        speedControl.choices.map((c) => c.label),
        ["普通", "弹性", "快速", "超级快速", "标准"],
      );
    }

    const planControl = localizeProviderControl(
      {
        type: "toggle",
        key: "plan_mode",
        label: "Plan mode",
        description: "Switch Codex into planning-only collaboration mode",
      },
      "zh-CN",
    );
    assert.equal(planControl.label, "计划模式");
    assert.equal(planControl.description, "将 Codex 切换为仅规划协作模式");

    const fastControl = localizeProviderControl(
      { type: "toggle", key: "fast_mode", label: "Fast mode" },
      "zh-CN",
    );
    assert.equal(fastControl.label, "快速模式");

    const autoAcceptControl = localizeProviderControl(
      { type: "toggle", key: "auto_accept", label: "Auto accept" },
      "zh-CN",
    );
    assert.equal(autoAcceptControl.label, "自动接受");

    const untouchedEn = localizeProviderControl(
      { type: "toggle", key: "plan_mode", label: "Plan mode" },
      "en",
    );
    assert.equal(untouchedEn.label, "Plan mode");

    const backendMember = DEFAULT_TEAM_SETTINGS.presets[0].members.find(
      (m) => m.roleId === "backend",
    );
    assert.ok(backendMember);
    assert.equal(
      formatMemberSummary(backendMember, "zh-CN"),
      "codex/auto/gpt-6.2-sol · 极高 · 完全访问 · 速度=普通",
    );
  });
});

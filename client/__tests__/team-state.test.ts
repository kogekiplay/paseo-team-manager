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
  const homeDir = "/Users/kogeki";

  it("normalizes and deduplicates tilde and expanded paths", () => {
    const dirs = normalizeExcludedDirectories(
      [" ~/Downloads/ ", "/Users/kogeki/Downloads", "", "/tmp//scratch/"],
      homeDir,
    );
    assert.deepEqual(dirs, ["~/Downloads/", "/tmp//scratch/"]);
    assert.equal(hasExcludedDirectory(dirs, "/Users/kogeki/Downloads", homeDir), true);
    assert.equal(hasExcludedDirectory(dirs, "~/Desktop", homeDir), false);
  });

  it("adds and removes excluded directories symmetrically", () => {
    const added = addExcludedDirectory([], "~/Downloads", homeDir);
    assert.deepEqual(added, ["~/Downloads"]);
    const duplicateAdded = addExcludedDirectory(added, "/Users/kogeki/Downloads/", homeDir);
    assert.deepEqual(duplicateAdded, ["~/Downloads"]);
    const removed = removeExcludedDirectory(added, "/Users/kogeki/Downloads", homeDir);
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

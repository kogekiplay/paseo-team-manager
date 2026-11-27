import assert from "node:assert/strict";
import { test } from "node:test";
import { findSvgIconProblem } from "@getpaseo/plugin";
import { evaluateSubagentSync, resolvePresetMembers, resolveRoleFromCatalog, resolveTeamMember } from "../catalog-defaults.ts";
import { TEAM_MANAGER_ICON } from "../icon.ts";
import { createDefaultPresets } from "../settings.ts";
import type { ProviderCatalogEntry } from "../contracts.ts";

function catalogEntry(provider: string, models: ProviderCatalogEntry["models"], options: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    provider,
    label: provider,
    enabled: true,
    status: "ready",
    defaultModeId: "full-access",
    modes: [
      { id: "full-access", label: "Full Access" },
      { id: "auto", label: "Auto" },
      { id: "plan", label: "Plan" },
      { id: "read-only", label: "Read only" },
      { id: "default", label: "Default" },
    ],
    models,
    controls: [],
    ...options,
  };
}

const thinking = (id: string, isDefault = false) => ({ id, label: id, isDefault });
const codex = catalogEntry("codex", [
  { id: "auto/gpt-6.2-sol", label: "Sol", isDefault: true, thinkingOptions: [thinking("xhigh", true), thinking("high")] },
  { id: "auto/gpt-6.2-astra", label: "Astra", thinkingOptions: [thinking("xhigh", true)] },
  { id: "auto/gpt-6.1-fable", label: "Fable", thinkingOptions: [thinking("high", true)] },
  { id: "gpt-5.4", label: "GPT-5.4", thinkingOptions: [thinking("high", true)] },
  { id: "auto/gpt-6-luna", label: "Luna", thinkingOptions: [thinking("medium", true)] },
  { id: "auto/gpt-6.1-terra", label: "Terra", thinkingOptions: [thinking("medium", true)] },
], {
  controls: [{ type: "select", key: "service_tier", label: "Speed", choices: [{ value: "default", label: "Default" }] }],
});
const antigravity = catalogEntry("antigravity", [
  { id: "gemini-4-neon", label: "Neon", isDefault: true, thinkingOptions: [thinking("high", true), thinking("medium")] },
  { id: "gemini-4-carbon", label: "Carbon", thinkingOptions: [thinking("high", true)] },
  { id: "gemini-4-hydrogen", label: "Hydrogen", thinkingOptions: [thinking("medium", true)] },
  { id: "gemini-4-argon", label: "Argon", thinkingOptions: [thinking("medium", true)] },
  { id: "gemini-3.8-flash", label: "Old Flash", thinkingOptions: [thinking("high", true)] },
  { id: "claude-sonnet", label: "Claude", thinkingOptions: [thinking("high", true)] },
]);
const claude = catalogEntry("claude", [
  { id: "claude-sonnet", label: "Sonnet", isDefault: true, thinkingOptions: [thinking("high", true), thinking("medium")] },
  { id: "claude-haiku", label: "Haiku", thinkingOptions: [thinking("low", true)] },
], { modes: [{ id: "default", label: "Default" }, { id: "bypassPermissions", label: "Bypass" }, { id: "plan", label: "Plan" }] });

test("sync plans preserve context and include only changed settings for the same provider", () => {
  const preset = createDefaultPresets()[0];
  const configured = {
    ...preset.members[0], provider: "codex", model: "gpt-5.4", thinkingOptionId: "high",
    modeId: "full-access", features: { service_tier: "default", trace: true },
  };
  const target = resolveTeamMember(configured, [codex]);
  const agent = {
    agentId: "child", roleId: "backend", provider: "CODEX", model: "auto/gpt-6.2-sol", thinkingOptionId: "xhigh",
    options: { service_tier: "priority", trace: true },
  };
  const drift = evaluateSubagentSync(agent, target, preset.id);
  assert.equal(drift.syncStatus, "update-in-place");
  assert.equal(drift.targetProviderModel, "codex/gpt-5.4");
  assert.match(drift.syncReason ?? "", /model.*thinkingOptionId.*features/);
  assert.deepEqual(drift.updateAgentParams, {
    agentId: "child", settings: { model: "gpt-5.4", thinkingOptionId: "high", features: { service_tier: "default" } },
  });
  assert.equal(drift.createAgentParams, null);
  const matching = { ...agent, model: "gpt-5.4", thinkingOptionId: "high" };
  for (const options of [undefined, null, { service_tier: "default", trace: true }]) {
    assert.deepEqual(evaluateSubagentSync({ ...matching, options }, target, preset.id), {
      syncStatus: "in-sync", syncReason: null, targetProviderModel: "codex/gpt-5.4", updateAgentParams: null, createAgentParams: null,
    });
  }
});

test("a sync plan suggests a replacement for a different provider and handles unresolved roles", () => {
  const preset = createDefaultPresets()[0];
  const agent = { agentId: "child", roleId: "frontend", provider: "claude", model: "claude-sonnet", thinkingOptionId: null };
  const target = resolveTeamMember(preset.members[1], [codex, antigravity]);
  const replacement = evaluateSubagentSync(agent, target, preset.id);
  assert.equal(replacement.syncStatus, "replace-provider");
  assert.match(replacement.syncReason ?? "", /交接上下文摘要.*保留旧会话/);
  assert.equal(replacement.updateAgentParams, null);
  assert.deepEqual(replacement.createAgentParams?.settings, { thinkingOptionId: "high" });
  assert.equal(replacement.createAgentParams?.provider, "antigravity/gemini-4-neon");
  for (const unresolved of [
    undefined,
    resolveTeamMember(preset.members[1], []),
    resolveTeamMember(preset.members[1], [], "codex"),
  ]) {
    const plan = evaluateSubagentSync(agent, unresolved, preset.id);
    assert.equal(plan.syncStatus, "unresolved");
    assert.equal(plan.targetProviderModel, null);
    assert.equal(plan.updateAgentParams, null);
    assert.equal(plan.createAgentParams, null);
  }
});

test("the brand icon is a valid self-contained inline SVG", () => {
  assert.equal(findSvgIconProblem(TEAM_MANAGER_ICON.svg), null);
  assert.match(TEAM_MANAGER_ICON.svg, /viewBox="0 0 24 24"/);
  assert.doesNotMatch(TEAM_MANAGER_ICON.svg, /<script|<style|on[a-z]+=|https?:/i);
});

test("the default roles resolve across Magpie Codex and Antigravity", () => {
  const [preset] = createDefaultPresets();
  const { resolved } = resolvePresetMembers(preset, [codex, antigravity]);
  const byRole = new Map(resolved.map((item) => [item.member.roleId, item]));
  assert.deepEqual(["backend", "qa", "reviewer"].map((role) => [byRole.get(role)?.member.provider, byRole.get(role)?.member.model, byRole.get(role)?.member.thinkingOptionId, byRole.get(role)?.member.modeId]), [
    ["codex", "auto/gpt-6.2-sol", "xhigh", ""],
    ["codex", "auto/gpt-6.2-sol", "xhigh", ""],
    ["codex", "auto/gpt-6.2-sol", "xhigh", ""],
  ]);
  assert.deepEqual([byRole.get("backend")?.member.features, byRole.get("frontend")?.member.features], [{ service_tier: "default" }, {}]);
  assert.deepEqual([byRole.get("frontend")?.member.model, byRole.get("explorer")?.member.model], ["gemini-4-neon", "gemini-4-hydrogen"]);
  assert.equal(byRole.get("frontend")?.member.thinkingOptionId, "high");
  assert.equal(byRole.get("explorer")?.member.thinkingOptionId, "medium");
  for (const item of resolved) {
    assert.equal(item.status, "auto-matched");
    assert.equal(item.member.modeId, "");
  }
  const serialized = JSON.stringify(resolved);
  assert.doesNotMatch(serialized, /astra|fable|gemini-3\.8-flash|claude/i);
});

test("native Codex without Magpie gets its real default model and no unsupported service tier", () => {
  const resolved = resolveRoleFromCatalog("backend", [catalogEntry("codex", [
    { id: "gpt-5.4", label: "GPT-5.4", isDefault: true, thinkingOptions: [thinking("high", true)] },
  ])]);
  assert.deepEqual(resolved, { provider: "codex", model: "gpt-5.4", thinkingOptionId: "high", modeId: "", features: {} });
});

test("a pure Claude host resolves every default role with catalog-supported options", () => {
  const [preset] = createDefaultPresets();
  const { resolved } = resolvePresetMembers(preset, [claude]);
  assert.equal(resolved.length, 5);
  for (const item of resolved) {
    assert.equal(item.member.provider, "claude");
    assert.ok(item.member.model.startsWith("claude-"));
    assert.ok(["high", "medium", "low"].includes(item.member.thinkingOptionId));
    assert.equal(item.member.modeId, "");
    assert.equal(item.status, "auto-matched");
  }
});

test("an arbitrary ready provider is a valid host fallback", () => {
  const resolved = resolveRoleFromCatalog("backend", [catalogEntry("opencode", [
    { id: "foo-model", label: "Foo", isDefault: true, thinkingOptions: [thinking("medium", true)] },
  ])]);
  assert.deepEqual(resolved, { provider: "opencode", model: "foo-model", thinkingOptionId: "medium", modeId: "", features: {} });
});

test("explicit configurations fall back without mutating the saved member", () => {
  const configured = { ...createDefaultPresets()[0].members[0], provider: "codex", model: "auto/gpt-6.2-sol" };
  const resolved = resolveTeamMember(configured, [catalogEntry("codex", [{ id: "gpt-5.4", label: "GPT-5.4", isDefault: true, thinkingOptions: [thinking("high", true)] }])]);
  assert.equal(resolved.status, "fallback-host");
  assert.equal(resolved.member.model, "gpt-5.4");
  assert.equal(resolved.configured.model, "auto/gpt-6.2-sol");
  assert.match(resolved.fallbackReason ?? "", /unavailable/);
  const missing = resolveTeamMember(configured, [], "antigravity");
  assert.equal(missing.status, "explicit");
  const unavailable = resolveTeamMember({ ...configured, provider: "missing" }, [codex], "caller");
  assert.equal(unavailable.status, "fallback-host");
  assert.equal(unavailable.member.provider, "codex");
});

test("auto members discard a saved permission mode across all outcomes", () => {
  const member = { ...createDefaultPresets()[0].members[0], modeId: "full-access" };
  const matched = resolveTeamMember(member, [codex]);
  const caller = resolveTeamMember(member, [], "codex");
  const unresolved = resolveTeamMember(member, []);
  assert.equal(matched.status, "auto-matched");
  assert.equal(caller.status, "fallback-caller");
  assert.equal(caller.member.provider, "codex");
  assert.equal(caller.member.model, "");
  assert.match(caller.fallbackReason ?? "", /caller provider/);
  assert.equal(unresolved.status, "unresolved");
  for (const result of [matched, caller, unresolved]) {
    assert.equal(result.member.modeId, "");
    assert.equal(result.configured.modeId, "full-access");
  }
});

test("an explicit mode survives when the provider stays the same and supports it", () => {
  const member = { ...createDefaultPresets()[0].members[0], provider: "codex", model: "auto/gpt-6.2-sol", modeId: "full-access" };
  const explicit = resolveTeamMember(member, [codex]);
  assert.equal(explicit.status, "explicit");
  assert.strictEqual(explicit.member, member);

  const missingModel = { ...member, model: "retired-model" };
  for (const [modes, configuredMode, expectedMode] of [
    [codex.modes, "full-access", "full-access"],
    [[], "full-access", "full-access"],
    [codex.modes, "", ""],
    [codex.modes, "bypassPermissions", ""],
  ] as const) {
    const fallback = resolveTeamMember({ ...missingModel, modeId: configuredMode }, [{ ...codex, modes: [...modes] }]);
    assert.equal(fallback.status, "fallback-host");
    assert.equal(fallback.member.model, member.model);
    assert.equal(fallback.member.modeId, expectedMode);
  }
});

test("fallback discards permission modes across providers and keeps a canonical caller match", () => {
  const member = { ...createDefaultPresets()[0].members[0], provider: "claude", model: "claude-sonnet", modeId: "bypassPermissions" };
  const hostFallback = resolveTeamMember(member, [{ ...codex, modes: claude.modes }]);
  assert.equal(hostFallback.status, "fallback-host");
  assert.equal(hostFallback.member.provider, "codex");
  assert.equal(hostFallback.member.modeId, "");

  const unavailable = [{ ...claude, enabled: false }];
  const callerFallback = resolveTeamMember(member, unavailable, "codex");
  assert.equal(callerFallback.status, "fallback-caller");
  assert.equal(callerFallback.member.provider, "codex");
  assert.equal(callerFallback.member.modeId, "");
  const sameCaller = resolveTeamMember(member, unavailable, " Claude ");
  assert.equal(sameCaller.status, "fallback-caller");
  assert.equal(sameCaller.member.modeId, member.modeId);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginHookRequests } from "@getpaseo/plugin/server";
import type { ProviderCatalogEntry } from "../../shared/contracts.ts";
import { resolvePresetMembers } from "../../shared/catalog-defaults.ts";
import {
  computeMemberConfigFingerprint, createDefaultPresets, DEFAULT_TEAM_SETTINGS, LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL, parseTeamSettings,
} from "../../shared/settings.ts";
import { applyAgentCreateBefore, applyAgentOpenBefore } from "../hooks.ts";
import { createRosterTool, createUpdateMemberModelTool, listCommanderDriftedSubagents } from "../tools.ts";
import type { HostAgent, HostPaseoApi } from "../paseo-types.ts";

type PaseoAgent = HostAgent;
type PaseoApi = HostPaseoApi;

const homeDir = "/Users/tester";
const cwd = `${homeDir}/src/example`;
const workspaceId = "workspace-1";
const settings = DEFAULT_TEAM_SETTINGS;
const tool = createRosterTool(() => settings, homeDir);
const codexCatalog: ProviderCatalogEntry[] = [{
  provider: "codex", label: "Codex", enabled: true, status: "ready", defaultModeId: "full-access",
  modes: [{ id: "full-access", label: "Full Access" }, { id: "auto", label: "Auto" }],
  models: [{ id: "auto/gpt-6.2-sol", label: "Sol", isDefault: true, thinkingOptions: [{ id: "xhigh", label: "XHigh", isDefault: true }] }],
  controls: [{ type: "select", key: "service_tier", label: "Speed", choices: [{ value: "default", label: "Default" }] }],
}];
const openRequest: PluginHookRequests["agent.open.before"] = {
  agentId: "commander", workspaceId, cwd, provider: "codex", reason: "create", purpose: "interactive",
  title: null, background: false, labels: {}, metadata: {}, tools: [], env: {}, mcpServers: {},
};
const parentLabel = { [PARENT_AGENT_ID_LABEL]: openRequest.agentId };

test("create fills model defaults and role metadata while leaving auto permissions unset", () => {
  const request = {
    config: { provider: "codex", cwd, title: "[BACKEND] 新建接口" },
    metadata: { [METADATA_KEYS.roleId]: "BACKEND" },
    env: { EXISTING: "value" },
  };
  const result = applyAgentCreateBefore(request, settings, homeDir, codexCatalog);
  assert.equal(result?.config.modeId, undefined);
  assert.deepEqual(result, {
    ...request,
    config: {
      ...request.config, model: "auto/gpt-6.2-sol", thinkingOptionId: "xhigh",
      providerOptions: { service_tier: "default" },
    },
    metadata: { [METADATA_KEYS.roleId]: "BACKEND", [METADATA_KEYS.presetId]: "default-fullstack" },
  });
  assert.deepEqual(request.config, { provider: "codex", cwd, title: "[BACKEND] 新建接口" });
});

test("create fills an explicit permission mode for its provider and omits it on cross-provider fallback", () => {
  const [preset] = createDefaultPresets();
  const backend = { ...preset.members[0], provider: "codex", model: "auto/gpt-6.2-sol", modeId: "full-access" };
  const configured = parseTeamSettings({ presets: [{ ...preset, members: [backend] }] });
  const request = { config: { provider: "codex", cwd }, metadata: { [METADATA_KEYS.roleId]: "backend" } };
  const explicit = applyAgentCreateBefore(request, configured, homeDir, codexCatalog);
  assert.equal(explicit?.config.modeId, "full-access");

  const updatedCatalog = [{ ...codexCatalog[0], models: [{ ...codexCatalog[0].models[0], id: "gpt-5.4" }] }];
  const sameProvider = applyAgentCreateBefore(request, configured, homeDir, updatedCatalog);
  assert.equal(sameProvider?.config.model, "gpt-5.4");
  assert.equal(sameProvider?.config.modeId, "full-access");

  const fallbackCatalog = [{ ...updatedCatalog[0], provider: "opencode" }];
  const fallback = applyAgentCreateBefore({ ...request, config: { provider: "opencode", cwd } }, configured, homeDir, fallbackCatalog);
  assert.equal(fallback?.config.model, "gpt-5.4");
  assert.equal(fallback?.config.modeId, undefined);

  const unavailableCatalog = [{ ...codexCatalog[0], enabled: false }];
  const callerFallback = applyAgentCreateBefore({ ...request, config: { provider: "opencode", cwd } }, configured, homeDir, unavailableCatalog);
  assert.ok(callerFallback);
  assert.equal(callerFallback.config.modeId, undefined);
});

test("create preserves explicit options and chooses the metadata role and preferred preset", () => {
  const [preset] = createDefaultPresets();
  const backend = { ...preset.members[0], model: "auto/gpt-6.1-terra", features: { service_tier: "default", trace: true } };
  const alternate = { ...preset, id: "alternate", members: [backend] };
  const configured = parseTeamSettings({ presets: [preset, alternate], workspaceOverrides: { "~/src/example/": { presetId: "alternate" } } });
  const request = {
    config: {
      provider: "codex", cwd, title: "[frontend] 实现接口", modeId: "auto", thinkingOptionId: "low",
      providerOptions: { service_tier: "priority", custom: false },
    },
    metadata: { [METADATA_KEYS.roleId]: "BACKEND", [METADATA_KEYS.presetId]: "alternate", retained: true },
  };
  const result = applyAgentCreateBefore(request, configured, homeDir, codexCatalog);
  assert.deepEqual(result, {
    metadata: request.metadata,
    config: { ...request.config, model: "auto/gpt-6.2-sol" },
  });
  const byDirectory = applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] scope" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, configured, homeDir, codexCatalog);
  assert.equal(byDirectory?.metadata?.[METADATA_KEYS.presetId], "alternate");
  assert.equal(byDirectory?.config.model, "auto/gpt-6.2-sol");
  const withExplicitModel = applyAgentCreateBefore({ config: { ...request.config, model: "caller-model" }, metadata: request.metadata }, configured, homeDir, codexCatalog);
  assert.equal(withExplicitModel?.config.model, "caller-model");
});

test("create skips ordinary and unknown titles, provider mismatches and disabled enforcement", () => {
  const config = { provider: "codex", cwd, title: "[backend] task" };
  for (const request of [
    { config: { ...config, title: "普通对话" } },
    { config: { ...config, title: "[unknown] 普通对话" } },
    { config: { ...config, title: "[frontend] provider mismatch" } },
  ]) assert.equal(applyAgentCreateBefore(request, settings, homeDir, codexCatalog), undefined);
  for (const off of [{ enabled: false }, { enforceMemberDefaultsOnCreate: false }]) {
    assert.equal(applyAgentCreateBefore({ config }, { ...settings, ...off }, homeDir, codexCatalog), undefined);
  }
});

test("create requires explicit role metadata and an enabled directory scope", () => {
  assert.equal(applyAgentCreateBefore({ config: { provider: "codex", cwd, title: "[backend] Fix tests" } }, settings, homeDir, codexCatalog), undefined);
  const excluded = parseTeamSettings({ excludedDirectories: ["~/src"] });
  assert.equal(applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] Fix tests" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, excluded, homeDir, codexCatalog), undefined);
  const workspaceDisabled = parseTeamSettings({ workspaceOverrides: { "~/src/example": { enabled: false } } });
  assert.equal(applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] Fix tests" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, workspaceDisabled, homeDir, codexCatalog), undefined);
});

test("open skips history and background and adds the commander prompt and roster to an interactive top-level agent", () => {
  assert.equal(applyAgentOpenBefore({ ...openRequest, purpose: "history" }, settings, tool, homeDir), undefined);
  assert.equal(applyAgentOpenBefore({ ...openRequest, background: true }, settings, tool, homeDir), undefined);
  const result = applyAgentOpenBefore({ ...openRequest, appendSystemPrompt: ["Existing prompt"] }, settings, tool, homeDir, codexCatalog);
  assert.deepEqual(result?.tools, [tool]);
  assert.equal(result?.tools[0].name, "team_get_roster");
  assert.equal(result?.appendSystemPrompt?.[0], "Existing prompt");
  assert.match(result?.appendSystemPrompt?.[1] ?? "", /Commander/);
  assert.doesNotMatch(result?.appendSystemPrompt?.[1] ?? "", /"modeId"/);
  assert.equal(openRequest.tools.length, 0);
});

test("open gives identified children only role instructions and preserves the existing tool array", () => {
  const [preset] = createDefaultPresets();
  const alternate = { ...preset, id: "alternate", members: [{ ...preset.members[1], rolePrompt: "Custom role prompt" }] };
  const configured = parseTeamSettings({ presets: [preset, alternate] });
  const request = {
    ...openRequest, labels: { ...parentLabel, [LABEL_KEYS.role]: "FRONTEND", [LABEL_KEYS.preset]: "alternate" },
    title: "[qa] task", metadata: { [METADATA_KEYS.roleId]: "backend", [METADATA_KEYS.presetId]: preset.id },
  };
  const result = applyAgentOpenBefore(request, configured, tool, homeDir, codexCatalog);
  assert.equal(result?.tools, request.tools);
  assert.match(result?.appendSystemPrompt?.[0] ?? "", /前端开发[\s\S]*Custom role prompt/);
  assert.doesNotMatch(result?.appendSystemPrompt?.[0] ?? "", /Commander|team_get_roster/);
  assert.equal(applyAgentOpenBefore({ ...openRequest, labels: parentLabel }, settings, tool, homeDir, codexCatalog), undefined);
  assert.equal(applyAgentOpenBefore({
    ...openRequest,
    labels: { ...parentLabel, [LABEL_KEYS.role]: "backend" },
    cwd: `${homeDir}/src/ignored`,
  }, parseTeamSettings({ excludedDirectories: ["~/src"] }), tool, homeDir, codexCatalog), undefined);
  assert.equal(applyAgentOpenBefore(request, { ...configured, enabled: false }, tool, homeDir, codexCatalog), undefined);
});

test("open respects an explicit session opt-out and exclusions", () => {
  const excluded = parseTeamSettings({ excludedDirectories: ["~/src/"] });
  assert.equal(applyAgentOpenBefore(openRequest, excluded, tool, homeDir, codexCatalog), undefined);
  const request = { ...openRequest, metadata: { [METADATA_KEYS.teamEnabled]: false } };
  assert.equal(applyAgentOpenBefore(request, settings, tool, homeDir, codexCatalog), undefined);
  const override = { ...request, metadata: { [METADATA_KEYS.teamEnabled]: true } };
  assert.deepEqual(applyAgentOpenBefore(override, excluded, tool, homeDir, codexCatalog)?.tools, [tool]);
});

test("roster returns current settings, native create parameters and live team children across pages", async () => {
  const backendLabels = { ...parentLabel, [LABEL_KEYS.role]: "backend" };
  const agent = (id: string, fields: Partial<PaseoAgent> = {}) => ({
    id, cwd, workspaceId, provider: "codex", title: `[backend] ${id}`, status: "idle", labels: backendLabels,
    model: "auto/gpt-6.2-sol", currentModeId: "full-access", updatedAt: "2026-11-23T00:00:00.000Z", ...fields,
  });
  const seenCursors: (string | undefined)[] = [];
  const paseo = {
    agents: { list: async ({ page }: { page: { limit: number; cursor?: string } }) => {
      seenCursors.push(page.cursor);
      assert.equal(page.limit, 200);
      const entries = page.cursor ? [agent("live")] : [
        agent("other-workspace", { workspaceId: "workspace-2" }),
        agent("root", { labels: {} }),
        agent("archived", { archivedAt: "2026-11-22" }),
        agent("closed", { status: "closed" }),
        agent("helper", { background: true }),
        agent("unassigned", { labels: parentLabel, title: "misc" }),
      ];
      return { entries: entries.map((item) => ({ agent: item })), pageInfo: { nextCursor: page.cursor ? null : "next" } };
    } },
  } as unknown as PaseoApi;
  const [preset] = createDefaultPresets();
  let currentSettings = settings;
  const liveTool = createRosterTool(() => currentSettings, homeDir, { ensureFresh: async () => codexCatalog });
  currentSettings = parseTeamSettings({ defaultPresetId: "updated", presets: [{ ...preset, id: "updated" }] });
  const context = {
    paseo, signal: new AbortController().signal,
    agent: { id: "commander", workspaceId, parentAgentId: null, provider: "codex", cwd, title: null, background: false, metadata: {} },
  };
  const result = await liveTool.execute({}, context);
  const roster = result.structuredContent as {
    presetId: string; members: { enabled: boolean; createAgentParams: unknown }[]; agents: { agentId: string }[]; agentListError: string | null;
  };
  assert.deepEqual(seenCursors, [undefined, "next"]);
  assert.equal(roster.presetId, "updated");
  assert.equal(roster.members.length, 5);
  assert.equal(roster.members[4].enabled, false);
  assert.deepEqual(roster.members[0].createAgentParams, {
    provider: "codex/auto/gpt-6.2-sol",
    settings: { thinkingOptionId: "xhigh", features: { service_tier: "default" } },
    labels: { [LABEL_KEYS.role]: "backend", [LABEL_KEYS.preset]: "updated" }, recommendedTitlePrefix: "[backend] ",
  });
  assert.deepEqual(roster.agents.map(({ agentId }) => agentId), ["live"]);
  assert.equal(roster.agentListError, null);
  assert.match(result.text ?? "", /团队成员[\s\S]*codex\/auto\/gpt-6\.2-sol[\s\S]*`live`/);
  assert.doesNotMatch(result.text ?? "", /"modeId"/);

  const unavailable = { agents: { list: async () => { throw new Error("agent list unavailable"); } } } as unknown as PaseoApi;
  const degraded = await liveTool.execute({}, { ...context, paseo: unavailable });
  assert.match(degraded.text ?? "", /读取子智能体列表失败.*agent list unavailable/);
  assert.deepEqual(degraded.structuredContent, { ...roster, agents: [], agentListError: "agent list unavailable" });
});

const syncCatalog: ProviderCatalogEntry[] = [
  {
    ...codexCatalog[0],
    models: [
      ...codexCatalog[0].models,
      { id: "gpt-5.4", label: "GPT-5.4", thinkingOptions: [{ id: "high", label: "High" }] },
      { id: "hidden-model", label: "Hidden", isSelectable: false, thinkingOptions: [] },
    ],
  },
  {
    provider: "claude", label: "Claude", enabled: true, status: "ready", defaultModeId: "bypassPermissions",
    modes: [{ id: "bypassPermissions", label: "Bypass" }], controls: [],
    models: [{ id: "claude-sonnet", label: "Sonnet", thinkingOptions: [{ id: "high", label: "High" }] }],
  },
];

type AgentMetadata = NonNullable<PaseoAgent["metadata"]>;
type ToolResult = Awaited<ReturnType<ReturnType<typeof createUpdateMemberModelTool>["execute"]>>;

function setupSyncTools(values = settings, initialMetadata: AgentMetadata = {}, providers = syncCatalog) {
  let currentSettings = values;
  let metadata: AgentMetadata | undefined = { retained: true, ...initialMetadata };
  let listError = false;
  const patches: AgentMetadata[] = [];
  const [preset] = values.presets;
  const agent = (id: string, overrides: Partial<PaseoAgent> = {}) => ({
    id, cwd, workspaceId, status: "idle" as const, title: id, background: false, provider: "codex",
    model: "auto/gpt-6.2-sol", thinkingOptionId: "xhigh", currentModeId: "full-access",
    labels: { ...parentLabel, [LABEL_KEYS.role]: "backend", [LABEL_KEYS.preset]: preset.id },
    options: { service_tier: "default", trace: true },
    updatedAt: "2026-11-23T00:00:00.000Z", ...overrides,
  });
  const children = [
    agent("child"),
    agent("front-child", { labels: { ...parentLabel, [LABEL_KEYS.role]: "frontend" } }),
    agent("other-commander-child", { labels: { [PARENT_AGENT_ID_LABEL]: "other-commander", [LABEL_KEYS.role]: "backend" } }),
    agent("closed", { status: "closed" }),
    agent("archived", { archivedAt: "2026-11-23T00:00:00.000Z" }),
    agent("background", { background: true }),
  ];
  const paseo = {
    agents: {
      ref(id: string) {
        assert.equal(id, "commander");
        return {
          refresh: async () => ({ agent: agent(id, { labels: {}, metadata }) }),
          async setMetadata(patch: AgentMetadata) {
            assert.deepEqual(Object.keys(patch), [METADATA_KEYS.memberOverrides]);
            patches.push(patch);
            metadata = { ...metadata, ...patch };
            if (patch[METADATA_KEYS.memberOverrides] === null) delete metadata[METADATA_KEYS.memberOverrides];
          },
        };
      },
      list: async () => {
        if (listError) throw new Error("agent directory unavailable");
        return { entries: children.map((child) => ({ agent: child })), pageInfo: { nextCursor: null } };
      },
    },
  } as unknown as PaseoApi;
  const context = {
    paseo, signal: new AbortController().signal,
    agent: { id: "commander", workspaceId, parentAgentId: null, provider: "codex", cwd, title: null, background: false, metadata: initialMetadata },
  };
  const cache = { ensureFresh: async () => providers };
  const updateTool = createUpdateMemberModelTool(() => currentSettings, homeDir, cache);
  const rosterTool = createRosterTool(() => currentSettings, homeDir, cache);
  return {
    context, patches, updateTool, getMetadata: () => metadata, failListing: () => { listError = true; },
    omitMetadata: () => { metadata = undefined; },
    saveSettings: (next: typeof currentSettings) => { currentSettings = next; },
    update: (input: unknown) => updateTool.execute(input, context),
    roster: () => rosterTool.execute({}, context),
  };
}

function readSyncResult(result: ToolResult) {
  assert.equal(result.isError, undefined, result.text ?? "");
  return result.structuredContent as {
    sessionMemberOverrides: Record<string, { provider: string; model: string; thinkingOptionId?: string; features?: Record<string, unknown>; baseFingerprint?: string }>;
    resolvedMembers: { roleId: string; overriddenInSession: boolean; modeId: string }[];
    affectedAgents: { agentId: string; syncStatus: string; targetProviderModel: string; updateAgentParams: unknown; createAgentParams: unknown }[];
    agentListError: string | null;
  };
}

test("saved session overrides use the base preset fingerprint and the live roster picks up settings edits", async () => {
  const fixture = setupSyncTools();
  const saved = readSyncResult(await fixture.update({ roleId: "backend", provider: "claude/claude-sonnet" }));
  const baseFingerprint = computeMemberConfigFingerprint(settings.presets[0].members[0]);
  assert.equal(saved.sessionMemberOverrides.backend.baseFingerprint, baseFingerprint);
  const editedOverride = readSyncResult(await fixture.update({ roleId: "backend", provider: "codex/auto/gpt-6.2-sol" }));
  assert.equal(editedOverride.sessionMemberOverrides.backend.baseFingerprint, baseFingerprint);

  const [preset] = createDefaultPresets();
  preset.members[0] = { ...preset.members[0], provider: "codex", model: "gpt-5.4" };
  fixture.saveSettings(parseTeamSettings({ presets: [preset] }));
  const live = await fixture.roster();
  const data = readSyncResult(live);
  assert.equal(data.sessionMemberOverrides.backend, undefined);
  assert.equal(data.resolvedMembers[0].overriddenInSession, false);
  assert.match(live.text ?? "", /目标 `codex\/gpt-5\.4`[\s\S]*下次向上述角色派发任务前/);
  assert.equal(fixture.patches.length, 2);
  const unrelated = readSyncResult(await fixture.update({ roleId: "frontend", provider: "auto" }));
  assert.deepEqual(Object.keys(unrelated.sessionMemberOverrides), ["frontend"]);
  assert.equal(fixture.patches.length, 3);
});

test("the opening drift lookup is read-only, commander-scoped and bounded even if the host stalls", async () => {
  const [preset] = createDefaultPresets();
  preset.members[0] = { ...preset.members[0], provider: "codex", model: "gpt-5.4" };
  const fixture = setupSyncTools();
  const commander = fixture.context.agent;
  const { resolved } = resolvePresetMembers(preset, syncCatalog);
  const drift = await listCommanderDriftedSubagents(fixture.context.paseo, commander, homeDir, resolved, preset.id);
  assert.deepEqual(drift.map(({ agentId, syncStatus }) => [agentId, syncStatus]), [["child", "update-in-place"], ["front-child", "replace-provider"]]);
  assert.equal(fixture.patches.length, 0);
  let finish!: () => void;
  let pages = 0;
  const stalled = { agents: { list: async () => {
    pages++;
    await new Promise<void>((resolve) => { finish = resolve; });
    return { entries: [], pageInfo: { nextCursor: "next" } };
  } } } as unknown as PaseoApi;
  assert.deepEqual(await listCommanderDriftedSubagents(stalled, commander, homeDir, resolved, preset.id, { timeoutMs: 1 }), []);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pages, 1);
  fixture.failListing();
  assert.deepEqual(await listCommanderDriftedSubagents(fixture.context.paseo, commander, homeDir, resolved, preset.id), []);
});

test("updating the session model persists only override metadata and reports same-provider drift to the live roster", async () => {
  const fixture = setupSyncTools();
  const result = await fixture.update({ roleId: " BACKEND ", provider: "codex/gpt-5.4", thinkingOptionId: "high", features: { trace: false } });
  const data = readSyncResult(result);
  assert.equal(fixture.getMetadata()?.retained, true);
  assert.equal(data.sessionMemberOverrides.backend.model, "gpt-5.4");
  assert.equal(data.sessionMemberOverrides.backend.provider, "codex");
  assert.equal(Object.hasOwn(data.sessionMemberOverrides.backend, "modeId"), false);
  assert.equal(data.resolvedMembers.find(({ roleId }) => roleId === "backend")?.overriddenInSession, true);
  assert.equal(settings.presets[0].members[0].provider, "auto");
  assert.deepEqual(data.affectedAgents.map(({ agentId }) => agentId), ["child"]);
  const { syncStatus, targetProviderModel, updateAgentParams, createAgentParams } = data.affectedAgents[0];
  assert.equal(syncStatus, "update-in-place");
  assert.equal(targetProviderModel, "codex/gpt-5.4");
  assert.deepEqual(updateAgentParams, { agentId: "child", settings: { model: "gpt-5.4", thinkingOptionId: "high", features: { trace: false } } });
  assert.equal(createAgentParams, null);
  assert.match(result.text ?? "", /`update_agent` 参数/);

  const rosterResult = await fixture.roster();
  const roster = rosterResult.structuredContent as {
    sessionMemberOverrides: unknown; agents: { agentId: string; syncStatus?: string; updateAgentParams?: unknown }[];
  };
  assert.deepEqual(roster.sessionMemberOverrides, data.sessionMemberOverrides);
  assert.deepEqual(roster.agents.find(({ agentId }) => agentId === "child")?.updateAgentParams, updateAgentParams);
  const otherChild = roster.agents.find(({ agentId }) => agentId === "other-commander-child");
  assert.ok(otherChild);
  assert.equal(otherChild.syncStatus, undefined);
  assert.match(rosterResult.text ?? "", /当前 `codex\/auto\/gpt-6\.2-sol`[\s\S]*`update-in-place` · 目标 `codex\/gpt-5\.4`/);

  const modelOnly = readSyncResult(await fixture.update({ roleId: "backend", model: "auto/gpt-6.2-sol" }));
  assert.equal(modelOnly.sessionMemberOverrides.backend.model, "auto/gpt-6.2-sol");
  assert.equal(modelOnly.sessionMemberOverrides.backend.thinkingOptionId, "high");
  assert.deepEqual(modelOnly.sessionMemberOverrides.backend.features, { trace: false });
  const resetOptions = readSyncResult(await fixture.update({ roleId: "backend", model: "gpt-5.4", thinkingOptionId: null, features: null }));
  assert.equal(Object.hasOwn(resetOptions.sessionMemberOverrides.backend, "thinkingOptionId"), false);
  assert.equal(Object.hasOwn(resetOptions.sessionMemberOverrides.backend, "features"), false);
});

test("cross-provider replacements leave permission unset, while same-provider overrides preserve a preset mode for new sessions", async () => {
  const [preset] = createDefaultPresets();
  preset.members[0] = { ...preset.members[0], provider: "codex", model: "auto/gpt-6.2-sol", modeId: "full-access" };
  const fixture = setupSyncTools(parseTeamSettings({ presets: [preset] }));
  const same = readSyncResult(await fixture.update({ roleId: "backend", provider: "codex", model: "gpt-5.4" }));
  assert.equal(same.resolvedMembers[0].modeId, "full-access");
  assert.deepEqual(same.affectedAgents[0].updateAgentParams, { agentId: "child", settings: { model: "gpt-5.4" } });

  const replacement = await fixture.update({ roleId: "backend", provider: "claude/claude-sonnet", thinkingOptionId: "high" });
  const cross = readSyncResult(replacement);
  assert.equal(cross.resolvedMembers[0].modeId, "");
  assert.equal(cross.affectedAgents[0].syncStatus, "replace-provider");
  assert.equal(cross.affectedAgents[0].updateAgentParams, null);
  assert.deepEqual(cross.affectedAgents[0].createAgentParams, {
    provider: "claude/claude-sonnet", settings: { thinkingOptionId: "high" },
    labels: { [LABEL_KEYS.role]: "backend", [LABEL_KEYS.preset]: preset.id }, recommendedTitlePrefix: "[backend] ",
  });
  assert.match(replacement.text ?? "", /交接上下文摘要，并保留旧会话/);

  const automatic = readSyncResult(await fixture.update({ roleId: "backend", provider: "auto", model: "" }));
  assert.equal(automatic.sessionMemberOverrides.backend.provider, "auto");
  assert.equal(automatic.sessionMemberOverrides.backend.model, "");
  assert.equal(automatic.resolvedMembers[0].modeId, "");
});

test("updates to different roles serialize and clearing one or all overrides restores the preset", async () => {
  const fixture = setupSyncTools();
  const results = await Promise.all([
    fixture.update({ roleId: "backend", provider: "codex/gpt-5.4" }),
    fixture.update({ roleId: "frontend", provider: "claude/claude-sonnet" }),
  ]);
  results.forEach(readSyncResult);
  assert.deepEqual(Object.keys(fixture.getMetadata()?.[METADATA_KEYS.memberOverrides] ?? {}), ["backend", "frontend"]);
  const resetOne = readSyncResult(await fixture.update({ roleId: "BACKEND", clear: true }));
  assert.deepEqual(Object.keys(resetOne.sessionMemberOverrides), ["frontend"]);
  assert.deepEqual(resetOne.affectedAgents.map(({ agentId, syncStatus }) => [agentId, syncStatus]), [["child", "in-sync"]]);
  const resetAll = readSyncResult(await fixture.update({ clearAll: true }));
  assert.deepEqual(resetAll.sessionMemberOverrides, {});
  assert.deepEqual(resetAll.affectedAgents.map(({ agentId }) => agentId), ["front-child"]);
  assert.deepEqual(fixture.patches.at(-1), { [METADATA_KEYS.memberOverrides]: null });
  assert.deepEqual(fixture.getMetadata(), { retained: true });
  await fixture.update({ roleId: "backend", provider: "auto" });
  assert.deepEqual(readSyncResult(await fixture.update({ roleId: "backend", clear: true })).sessionMemberOverrides, {});
  assert.deepEqual(fixture.patches.at(-1), { [METADATA_KEYS.memberOverrides]: null });
});

test("invalid selections, mode input, disabled scope and child callers cannot write override metadata", async () => {
  const fixture = setupSyncTools();
  for (const [input, message] of [
    [{ roleId: "other", provider: "auto" }, /backend.*frontend/],
    [{ roleId: "backend", provider: "unknown/model" }, /当前可用提供方：codex、claude/],
    [{ roleId: "backend", model: "invalid" }, /可用模型：.*gpt-5\.4/],
    [{ roleId: "backend", model: "hidden-model" }, /可用模型：.*gpt-5\.4/],
    [{ roleId: "backend", provider: "codex/gpt-5.4", thinkingOptionId: "xhigh" }, /选项：high/],
    [{ roleId: "backend", provider: "auto", modeId: "full-access" }, /modeId/],
  ] as const) {
    const result = await fixture.update(input);
    assert.equal(result.isError, true);
    assert.match(result.text ?? "", message);
  }
  for (const caller of [{ parentAgentId: "parent" }, { background: true }]) {
    assert.equal((await fixture.updateTool.execute({ clearAll: true }, {
      ...fixture.context, agent: { ...fixture.context.agent, ...caller },
    })).isError, true);
  }
  assert.deepEqual(fixture.patches, []);

  for (const disabled of [
    setupSyncTools({ ...settings, enabled: false }, { [METADATA_KEYS.teamEnabled]: true }),
    setupSyncTools(settings, { [METADATA_KEYS.teamEnabled]: false }),
    setupSyncTools(parseTeamSettings({ workspaceOverrides: { [workspaceId]: { enabled: false } } })),
  ]) {
    const result = await disabled.update({ roleId: "backend", provider: "auto" });
    assert.equal(result.isError, true);
    assert.match(result.text ?? "", /团队模式已关闭/);
    assert.deepEqual(disabled.patches, []);
  }
});

test("saved updates still succeed when the agent listing is unavailable", async () => {
  const fixture = setupSyncTools();
  fixture.failListing();
  const result = readSyncResult(await fixture.update({ roleId: "backend", provider: "codex/gpt-5.4" }));
  assert.equal(result.sessionMemberOverrides.backend.model, "gpt-5.4");
  assert.deepEqual(result.affectedAgents, []);
  assert.equal(result.agentListError, "agent directory unavailable");
});

test("a live roster does not reuse an outdated tool-context override after host metadata is cleared", async () => {
  const fixture = setupSyncTools(settings, { [METADATA_KEYS.memberOverrides]: { backend: { provider: "codex", model: "gpt-5.4" } } });
  fixture.omitMetadata();
  const result = readSyncResult(await fixture.roster());
  assert.deepEqual(result.sessionMemberOverrides, {});
  assert.equal(result.resolvedMembers[0].overriddenInSession, false);
});

test("model-only updates look up a unique catalog owner when Auto has no role match", async () => {
  const antigravity = { ...syncCatalog[1], provider: "antigravity" };
  const fixture = setupSyncTools(settings, {}, [antigravity]);
  const missing = await fixture.update({ roleId: "frontend", model: "not-found" });
  assert.equal(missing.isError, true);
  assert.match(missing.text ?? "", /确定唯一的提供方.*`provider\/model`/);
  assert.deepEqual(fixture.patches, []);
  const match = readSyncResult(await fixture.update({ roleId: "frontend", model: "claude-sonnet" }));
  assert.equal(match.sessionMemberOverrides.frontend.provider, "antigravity");
  assert.equal(match.sessionMemberOverrides.frontend.model, "claude-sonnet");
});

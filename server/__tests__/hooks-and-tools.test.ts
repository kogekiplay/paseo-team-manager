import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { PluginHookRequests } from "@getpaseo/plugin/server";
import {
  createDefaultPresets, DEFAULT_TEAM_SETTINGS, LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL, parseTeamSettings,
} from "../../shared/settings.ts";
import { applyAgentCreateBefore, applyAgentOpenBefore } from "../hooks.ts";
import { createRosterTool } from "../tools.ts";

const homeDir = "/Users/tester";
const cwd = `${homeDir}/src/example`;
const workspaceId = "workspace-1";
const settings = DEFAULT_TEAM_SETTINGS;
const tool = createRosterTool(() => settings, homeDir);
const openRequest: PluginHookRequests["agent.open.before"] = {
  agentId: "commander", workspaceId, cwd, provider: "codex", reason: "create", purpose: "interactive",
  title: null, background: false, labels: {}, metadata: {}, tools: [], env: {}, mcpServers: {},
};
const parentLabel = { [PARENT_AGENT_ID_LABEL]: openRequest.agentId };

test("create fills missing defaults and role metadata without changing cwd or the request", () => {
  const request = {
    config: { provider: "codex", cwd, title: "[BACKEND] 新建接口" },
    metadata: { [METADATA_KEYS.roleId]: "BACKEND" },
    env: { EXISTING: "value" },
  };
  const result = applyAgentCreateBefore(request, settings, homeDir);
  assert.deepEqual(result, {
    ...request,
    config: {
      ...request.config, model: "auto/gpt-6.2-sol", modeId: "full-access", thinkingOptionId: "xhigh",
      providerOptions: { service_tier: "default" },
    },
    metadata: { [METADATA_KEYS.roleId]: "BACKEND", [METADATA_KEYS.presetId]: "default-fullstack" },
  });
  assert.deepEqual(request.config, { provider: "codex", cwd, title: "[BACKEND] 新建接口" });
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
  const result = applyAgentCreateBefore(request, configured, homeDir);
  assert.deepEqual(result, {
    metadata: request.metadata,
    config: { ...request.config, model: "auto/gpt-6.1-terra", providerOptions: { ...request.config.providerOptions, trace: true } },
  });
  const byDirectory = applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] scope" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, configured, homeDir);
  assert.equal(byDirectory?.metadata?.[METADATA_KEYS.presetId], "alternate");
  assert.equal(byDirectory?.config.model, "auto/gpt-6.1-terra");
  const withExplicitModel = applyAgentCreateBefore({ config: { ...request.config, model: "caller-model" }, metadata: request.metadata }, configured, homeDir);
  assert.equal(withExplicitModel?.config.model, "caller-model");
});

test("create skips ordinary and unknown titles, provider mismatches and disabled enforcement", () => {
  const config = { provider: "codex", cwd, title: "[backend] task" };
  for (const request of [
    { config: { ...config, title: "普通对话" } },
    { config: { ...config, title: "[unknown] 普通对话" } },
    { config: { ...config, title: "[frontend] provider mismatch" } },
  ]) assert.equal(applyAgentCreateBefore(request, settings, homeDir), undefined);
  for (const off of [{ enabled: false }, { enforceMemberDefaultsOnCreate: false }]) {
    assert.equal(applyAgentCreateBefore({ config }, { ...settings, ...off }, homeDir), undefined);
  }
});

test("create requires explicit role metadata and an enabled directory scope", () => {
  assert.equal(applyAgentCreateBefore({ config: { provider: "codex", cwd, title: "[backend] Fix tests" } }, settings, homeDir), undefined);
  const excluded = parseTeamSettings({ excludedDirectories: ["~/src"] });
  assert.equal(applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] Fix tests" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, excluded, homeDir), undefined);
  const workspaceDisabled = parseTeamSettings({ workspaceOverrides: { "~/src/example": { enabled: false } } });
  assert.equal(applyAgentCreateBefore({
    config: { provider: "codex", cwd, title: "[backend] Fix tests" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  }, workspaceDisabled, homeDir), undefined);
});

test("open skips history and background and adds the commander prompt and roster to an interactive top-level agent", () => {
  assert.equal(applyAgentOpenBefore({ ...openRequest, purpose: "history" }, settings, tool, homeDir), undefined);
  assert.equal(applyAgentOpenBefore({ ...openRequest, background: true }, settings, tool, homeDir), undefined);
  const result = applyAgentOpenBefore({ ...openRequest, appendSystemPrompt: ["Existing prompt"] }, settings, tool, homeDir);
  assert.deepEqual(result?.tools, [tool]);
  assert.equal(result?.tools[0].name, "team_get_roster");
  assert.equal(result?.appendSystemPrompt?.[0], "Existing prompt");
  assert.match(result?.appendSystemPrompt?.[1] ?? "", /Commander/);
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
  const result = applyAgentOpenBefore(request, configured, tool, homeDir);
  assert.equal(result?.tools, request.tools);
  assert.match(result?.appendSystemPrompt?.[0] ?? "", /前端开发[\s\S]*Custom role prompt/);
  assert.doesNotMatch(result?.appendSystemPrompt?.[0] ?? "", /Commander|team_get_roster/);
  assert.equal(applyAgentOpenBefore({ ...openRequest, labels: parentLabel }, settings, tool, homeDir), undefined);
  assert.equal(applyAgentOpenBefore({
    ...openRequest,
    labels: { ...parentLabel, [LABEL_KEYS.role]: "backend" },
    cwd: `${homeDir}/src/ignored`,
  }, parseTeamSettings({ excludedDirectories: ["~/src"] }), tool, homeDir), undefined);
  assert.equal(applyAgentOpenBefore(request, { ...configured, enabled: false }, tool, homeDir), undefined);
});

test("open respects an explicit session opt-out and exclusions", () => {
  const excluded = parseTeamSettings({ excludedDirectories: ["~/src/"] });
  assert.equal(applyAgentOpenBefore(openRequest, excluded, tool, homeDir), undefined);
  const request = { ...openRequest, metadata: { [METADATA_KEYS.teamEnabled]: false } };
  assert.equal(applyAgentOpenBefore(request, settings, tool, homeDir), undefined);
  const override = { ...request, metadata: { [METADATA_KEYS.teamEnabled]: true } };
  assert.deepEqual(applyAgentOpenBefore(override, excluded, tool, homeDir)?.tools, [tool]);
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
  const liveTool = createRosterTool(() => currentSettings, homeDir);
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
    settings: { modeId: "full-access", thinkingOptionId: "xhigh", features: { service_tier: "default" } },
    labels: { [LABEL_KEYS.role]: "backend", [LABEL_KEYS.preset]: "updated" }, recommendedTitlePrefix: "[backend] ",
  });
  assert.deepEqual(roster.agents.map(({ agentId }) => agentId), ["live"]);
  assert.equal(roster.agentListError, null);
  assert.match(result.text ?? "", /团队成员[\s\S]*codex\/auto\/gpt-6\.2-sol[\s\S]*`live`/);

  const unavailable = { agents: { list: async () => { throw new Error("agent list unavailable"); } } } as unknown as PaseoApi;
  const degraded = await liveTool.execute({}, { ...context, paseo: unavailable });
  assert.match(degraded.text ?? "", /读取子智能体列表失败.*agent list unavailable/);
  assert.deepEqual(degraded.structuredContent, { ...roster, agents: [], agentListError: "agent list unavailable" });
});

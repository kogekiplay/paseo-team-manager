import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import type { AgentToolDefinition, PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import contribute from "../../index.server.ts";
import { getProviderCatalogRpc, getProviderControlsRpc, getWorkspaceTeamStateRpc, previewCommanderPromptRpc } from "../../shared/contracts.ts";
import { LABEL_KEYS, METADATA_KEYS, PARENT_AGENT_ID_LABEL, parseTeamSettings, teamSettings } from "../../shared/settings.ts";
import { createSettingsCache } from "../settings-cache.ts";
import type { HostAgent, HostPaseoApi, HostProviderControlsInput, HostProviderSnapshotResult } from "../paseo-types.ts";

type PaseoAgent = HostAgent;
type PaseoApi = HostPaseoApi;
type PaseoProviderControlsInput = HostProviderControlsInput;
type PaseoProviderSnapshotResult = HostProviderSnapshotResult;

type SettingsState = PluginSettingsState<typeof teamSettings.schema>;
type Handler = (input: unknown, context: { paseo: PaseoApi }) => unknown;

function createServerFixture(readSettings: () => Promise<SettingsState>) {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const cleanupEvents: string[] = [];
  let listener: (state: SettingsState) => void = () => {};
  const context = {
    registerSettings(definition: unknown) {
      assert.equal(definition, teamSettings);
      return {
        read: readSettings,
        subscribe(callback: typeof listener) {
          listener = callback;
          return async () => { cleanupEvents.push("settings"); };
        },
      };
    },
    addHook(name: string, handler: Handler) {
      assert.ok(!hooks.has(name));
      hooks.set(name, handler);
      return () => { cleanupEvents.push(name); hooks.delete(name); };
    },
    handle(contract: { name: string }, handler: Handler) {
      assert.ok(!handlers.has(contract.name));
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;
  return { context, handlers, hooks, cleanupEvents, updateSettings: (state: SettingsState) => listener(state) };
}

const cwd = "/tmp/team-project";
const snapshotDate = "2026-11-23T01:02:03.000Z";
const snapshot: PaseoProviderSnapshotResult = {
  requestId: "snapshot", generatedAt: snapshotDate,
  entries: [
    {
      provider: "codex", enabled: true, status: "ready", label: "Codex", defaultModeId: "full-access",
      modes: [{ id: "full-access", label: "Full Access", description: "Unattended mode", icon: "key" }],
      models: [
        { provider: "codex", id: "other", label: "Other" },
        { provider: "codex", id: "auto/gpt-6.2-sol", label: "GPT-6.2 Sol", isDefault: true, defaultThinkingOptionId: "xhigh",
          thinkingOptions: [{ id: "xhigh", label: "Extra High", isDefault: true }] },
        { provider: "codex", id: "hidden-model", label: "Hidden", isSelectable: false },
      ],
    },
    { provider: "broken", enabled: true, status: "ready", models: [{ provider: "broken", id: "model", label: "Model" }] },
    { provider: "disabled", enabled: false, status: "ready", models: [{ provider: "disabled", id: "model", label: "Model" }] },
    { provider: "missing", enabled: true, status: "unavailable", error: "Not installed" },
  ],
};
const controls = [
  { type: "toggle", key: "plan_mode", label: "Plan", defaultValue: false },
  { type: "select", key: "service_tier", label: "Speed", desktopTrigger: "label", defaultValue: "default",
    choices: [{ value: "default", label: "Normal" }, { value: "priority", label: "Fast" }] },
];

test("entry registers both hooks and all RPCs, uses a racing settings update and cleans up", async (t) => {
  let resolveInitial!: (state: SettingsState) => void;
  const initial = new Promise<SettingsState>((resolve) => { resolveInitial = resolve; });
  const fixture = createServerFixture(() => initial);
  const dispose = contribute(fixture.context);
  t.after(async () => {
    if (fixture.cleanupEvents.length === 0) await dispose();
  });
  assert.deepEqual([...fixture.hooks.keys()], ["agent.create.before", "agent.open.before"]);
  assert.deepEqual([...fixture.handlers.keys()], ["team.provider_catalog", "team.provider_controls", "team.workspace_state", "team.preview_prompt"]);

  const defaults = parseTeamSettings({});
  const selected = { ...defaults.presets[0], id: "latest", commanderExtraInstructions: "验证最新配置。" };
  const values = parseTeamSettings({ ...defaults, presets: [selected], defaultPresetId: selected.id });
  fixture.updateSettings({ status: "ready", revision: "2", values });
  resolveInitial({ status: "ready", revision: "1", values: defaults });

  const providerCalls: unknown[] = [];
  const listingCalls: boolean[] = [];
  const childLabels = { [PARENT_AGENT_ID_LABEL]: "root", [LABEL_KEYS.role]: "FRONTEND", [LABEL_KEYS.preset]: "latest" };
  const agent = (id: string, fields: Partial<PaseoAgent> = {}) => ({
    id, provider: "codex", cwd, workspaceId: "workspace", title: id, status: "idle", labels: {},
    model: null, currentModeId: null, updatedAt: snapshotDate, ...fields,
  });
  const entries = [
    agent("root", { title: "[backend] top-level", metadata: { [METADATA_KEYS.teamEnabled]: false } }),
    agent("child", { labels: childLabels, metadata: { [METADATA_KEYS.roleId]: "backend" },
      currentModeId: "full-access", effectiveThinkingOptionId: "high" }),
    agent("helper", { background: true }),
    agent("other", { workspaceId: "other-workspace", metadata: { [METADATA_KEYS.teamEnabled]: false } }),
  ];
  const paseo = {
    providers: {
      refresh: async (input: unknown) => { providerCalls.push(["refresh", input]); },
      snapshot: async (input: unknown) => { providerCalls.push(["snapshot", input]); return snapshot; },
      listControls: async (input: PaseoProviderControlsInput) => {
        providerCalls.push(["listControls", input]);
        if (input.provider.startsWith("broken/")) throw new Error("Provider timed out");
        return { controls, options: { service_tier: "priority", extra: 3, nullable: null, nested: { ignored: true } }, error: null };
      },
    },
    workspaces: { ref: (id: string) => ({ refresh: async () => {
      assert.equal(id, "workspace");
      return { id, workspaceDirectory: cwd };
    } }) },
    agents: {
      list: async (options: { includeBackground: boolean }) => {
        listingCalls.push(options.includeBackground);
        return { entries: entries.map((item) => ({ agent: item })), pageInfo: { nextCursor: null } };
      },
      ref: (id: string) => ({ refresh: async () => ({ agent: entries.find((item) => item.id === id) }) }),
    },
  } as unknown as PaseoApi;
  const call = (name: string, input: unknown) => fixture.handlers.get(name)!(input, { paseo });
  const open = {
    agentId: "root", workspaceId: "workspace", provider: "codex", cwd, reason: "create", purpose: "interactive",
    title: null, background: false, labels: {}, metadata: {}, tools: [], env: {}, mcpServers: {},
  };
  const openHook = fixture.hooks.get("agent.open.before")!;
  const openResult = await openHook({ request: open }, { paseo }) as { appendSystemPrompt: string[]; tools: AgentToolDefinition[] };
  assert.match(openResult.appendSystemPrompt[0], /验证最新配置/);
  assert.match(openResult.appendSystemPrompt[0], /待自动同步的已有子智能体[\s\S]*`child`.*目标 `codex\/auto\/gpt-6\.2-sol`/);
  assert.match(openResult.appendSystemPrompt[0], /`update_agent` 参数 `{"agentId":"child"/);
  assert.doesNotMatch(openResult.appendSystemPrompt[0], /"modeId"/);
  assert.deepEqual(openResult.tools.map(({ name }) => name), ["team_get_roster", "team_update_member_model"]);
  const childOpen = await openHook({ request: { ...open, agentId: "child", labels: childLabels } }, { paseo }) as typeof openResult;
  assert.deepEqual(childOpen.tools, []);
  assert.doesNotMatch(childOpen.appendSystemPrompt[0], /team_get_roster|team_update_member_model/);
  assert.deepEqual(listingCalls, [false]);
  const createResult = await fixture.hooks.get("agent.create.before")!({ request: {
    config: { provider: "codex", cwd, title: "[backend] task" },
    metadata: { [METADATA_KEYS.roleId]: "backend" },
  } }, { paseo });
  assert.equal((createResult as { metadata: Record<string, unknown> }).metadata[METADATA_KEYS.presetId], "latest");

  const catalog = getProviderCatalogRpc.output.parse(await call(getProviderCatalogRpc.name, { cwd, refresh: true }));
  assert.deepEqual(providerCalls, [
    ["snapshot", { cwd }],
    ["listControls", { provider: "codex/auto/gpt-6.2-sol", modeId: "full-access", cwd }],
    ["listControls", { provider: "broken/model", modeId: undefined, cwd }],
    ["refresh", { cwd }], ["snapshot", { cwd }],
    ["listControls", { provider: "codex/auto/gpt-6.2-sol", modeId: "full-access", cwd }],
    ["listControls", { provider: "broken/model", modeId: undefined, cwd }],
  ]);
  assert.equal(catalog.homeDir, homedir());
  assert.equal(catalog.fetchedAt, snapshotDate);
  assert.equal(catalog.providers[0].models[1].thinkingOptions[0].id, "xhigh");
  assert.deepEqual(catalog.providers[0].models[0].thinkingOptions, []);
  assert.equal(catalog.providers[0].models[2].isSelectable, false);
  assert.deepEqual(catalog.providers[0].modes, [{ id: "full-access", label: "Full Access", description: "Unattended mode" }]);
  assert.deepEqual(catalog.providers[0].controls, controls);
  assert.equal(catalog.providers[1].error, "Provider timed out");
  assert.deepEqual(catalog.providers[1].controls, []);
  assert.equal(catalog.providers[2].enabled, false);
  assert.equal(catalog.providers[3].error, "Not installed");

  const detail = getProviderControlsRpc.output.parse(await call(getProviderControlsRpc.name, { provider: "codex", model: "auto/gpt-6.2-sol", modeId: "full-access", cwd }));
  assert.deepEqual(detail, { provider: "codex", controls, defaults: { service_tier: "priority", plan_mode: false, extra: 3, nullable: null }, error: null });
  assert.deepEqual(getProviderControlsRpc.output.parse(await call(getProviderControlsRpc.name, { provider: "codex" })), detail);
  assert.deepEqual(providerCalls.at(-1), ["listControls", { provider: "codex/auto/gpt-6.2-sol", modeId: undefined, cwd: homedir() }]);
  const detailError = getProviderControlsRpc.output.parse(await call(getProviderControlsRpc.name, { provider: "broken", model: "model", cwd }));
  assert.deepEqual(detailError, { provider: "broken", controls: [], defaults: {}, error: "Provider timed out" });

  const state = getWorkspaceTeamStateRpc.output.parse(await call(getWorkspaceTeamStateRpc.name, { workspaceId: "workspace", agentId: "root" }));
  assert.equal(state.cwd, cwd);
  assert.equal(state.effectiveEnabled, false);
  assert.equal(state.decisionSource, "agent-metadata");
  assert.equal(state.activePresetId, "latest");
  assert.deepEqual(state.agents.map(({ agentId, isCommander, roleId, presetId, background }) => [agentId, isCommander, roleId, presetId, background]), [
    ["root", true, null, null, false], ["child", false, "frontend", "latest", false], ["helper", false, null, null, true],
  ]);
  assert.equal(state.agents[1].parentAgentId, "root");
  assert.equal(state.agents[1].thinkingOptionId, "high");
  assert.equal(state.agents[1].syncStatus, undefined);
  const overrides = { frontend: { provider: "codex", model: "other" } };
  const metadata = { [METADATA_KEYS.memberOverrides]: overrides };
  entries[0] = { ...entries[0], metadata };
  const resumed = await openHook({ request: { ...open, reason: "resume", metadata } }, { paseo }) as typeof openResult;
  assert.match(resumed.appendSystemPrompt[0], /当前会话模型覆盖已生效[\s\S]*"provider": "codex\/other"/);
  const updated = getWorkspaceTeamStateRpc.output.parse(await call(getWorkspaceTeamStateRpc.name, { workspaceId: "workspace", agentId: "root" }));
  assert.deepEqual(updated.sessionMemberOverrides, overrides);
  assert.deepEqual(updated.activePreset.members.find(({ roleId }) => roleId === "frontend")?.model, "other");
  assert.deepEqual(updated.resolvedMembers.filter(({ overriddenInSession }) => overriddenInSession).map(({ roleId }) => roleId), ["frontend"]);
  assert.equal(updated.agents[1].syncStatus, "update-in-place");
  assert.equal(updated.agents[1].targetProviderModel, "codex/other");
  assert.match(updated.agents[1].syncReason ?? "", /model/);
  const other = getWorkspaceTeamStateRpc.output.parse(await call(getWorkspaceTeamStateRpc.name, { workspaceId: "workspace", agentId: "other" }));
  assert.equal(other.decisionSource, "global-default");
  assert.deepEqual(other.sessionMemberOverrides, {});
  assert.equal(other.agents[1].syncStatus, undefined);

  const preview = previewCommanderPromptRpc.output.parse(await call(previewCommanderPromptRpc.name, { roleId: " BACKEND " }));
  assert.equal(preview.presetId, "latest");
  assert.match(preview.commanderPrompt, /验证最新配置/);
  assert.match(preview.rolePrompt ?? "", /后端开发/);
  assert.ok(preview.resolvedMembers.every(({ overriddenInSession }) => overriddenInSession === false));
  const draft = { ...selected, id: "draft", commanderNoDirectEdit: false };
  const draftPreview = previewCommanderPromptRpc.output.parse(await call(previewCommanderPromptRpc.name, { preset: draft, presetId: "latest", roleId: "unknown" }));
  assert.equal(draftPreview.presetId, "draft");
  assert.equal(draftPreview.rolePrompt, null);
  assert.match(draftPreview.commanderPrompt, /可自行处理小型修改/);

  await dispose();
  assert.deepEqual(fixture.cleanupEvents.sort(), ["agent.create.before", "agent.open.before", "settings"]);
  assert.equal(fixture.hooks.size, 0);
});

test("cache keeps the last valid values across read failures, invalid updates and disposal", async () => {
  const fixture = createServerFixture(async () => { throw new Error("read failed"); });
  const cache = createSettingsCache(fixture.context);
  await cache.waitReady();
  assert.equal(cache.getSettings().enabled, true);
  fixture.updateSettings({ status: "ready", revision: "1", values: parseTeamSettings({ enabled: false }) });
  fixture.updateSettings({ status: "invalid", revision: "2", error: "invalid settings" });
  assert.equal(cache.getSettings().enabled, false);
  await cache.dispose();
  await cache.dispose();
  fixture.updateSettings({ status: "ready", revision: "3", values: parseTeamSettings({}) });
  assert.equal(cache.getSettings().enabled, false);
  assert.deepEqual(fixture.cleanupEvents, ["settings"]);
});

test("cache subscriptions start after the first read and only report changed ready values", async () => {
  const initial = parseTeamSettings({});
  const fixture = createServerFixture(async () => ({ status: "ready", revision: "1", values: initial }));
  const cache = createSettingsCache(fixture.context);
  const changes: unknown[] = [];
  const listener = (next: typeof initial, prev: typeof initial) => changes.push([next, prev]);
  const unsubscribe = cache.subscribe(listener);
  await cache.waitReady();
  const changed = parseTeamSettings({ enabled: false });
  fixture.updateSettings({ status: "ready", revision: "2", values: parseTeamSettings({}) });
  fixture.updateSettings({ status: "invalid", revision: "3", error: "invalid settings" });
  fixture.updateSettings({ status: "ready", revision: "4", values: changed });
  assert.deepEqual(changes, [[changed, initial]]);
  unsubscribe();
  fixture.updateSettings({ status: "ready", revision: "5", values: initial });
  assert.equal(changes.length, 1);
  cache.subscribe(listener);
  await cache.dispose();
  fixture.updateSettings({ status: "ready", revision: "6", values: changed });
  assert.equal(changes.length, 1);
});

test("opening commanders discard a drift snapshot if scheduling settings change during the read", async (t) => {
  const initial = parseTeamSettings({});
  const fixture = createServerFixture(async () => ({ status: "ready", revision: "1", values: initial }));
  t.after(contribute(fixture.context));
  const changed = parseTeamSettings(initial);
  changed.presets[0].members[0] = { ...changed.presets[0].members[0], provider: "codex", model: "other" };
  const request = {
    agentId: "root", workspaceId: "workspace", provider: "codex", cwd, reason: "resume", purpose: "interactive",
    title: null, background: false, labels: {}, metadata: {}, tools: [], env: {}, mcpServers: {},
  };
  const child = {
    id: "child", workspaceId: "workspace", provider: "codex", cwd, model: "old",
    status: "idle", labels: { [PARENT_AGENT_ID_LABEL]: "root", [LABEL_KEYS.role]: "backend" },
  };
  let listStarted!: () => void;
  let releaseList!: () => void;
  const started = new Promise<void>((resolve) => { listStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseList = resolve; });
  const paseo = {
    providers: { snapshot: async () => snapshot, listControls: async () => ({ controls }) },
    agents: {
      list: async () => {
        listStarted();
        await release;
        return { entries: [{ agent: child }], pageInfo: { nextCursor: null } };
      },
      ref: () => assert.fail("the open hook only lists agents"),
    },
  } as unknown as PaseoApi;
  const open = fixture.hooks.get("agent.open.before")!;
  const pending = open({ request }, { paseo }) as Promise<{ appendSystemPrompt: string[] }>;
  await started;
  fixture.updateSettings({ status: "ready", revision: "2", values: changed });
  releaseList();
  const result = await pending;
  assert.match(result.appendSystemPrompt[0], /"provider": "codex\/other"/);
  assert.doesNotMatch(result.appendSystemPrompt[0], /### 待自动同步的已有子智能体/);
  assert.match(result.appendSystemPrompt[0], /`team_get_roster`，以实时名册为准/);
});

test("workspace state still resolves directory policy when either host lookup is unavailable", async (t) => {
  const values = parseTeamSettings({ excludedDirectories: ["/tmp"] });
  const fixture = createServerFixture(async () => ({ status: "ready", revision: "1", values }));
  const dispose = contribute(fixture.context);
  t.after(dispose);
  const paseo = {
    workspaces: { ref: () => { throw new Error("workspace unavailable"); } },
    agents: {
      list: async () => { throw new Error("agent directory unavailable"); },
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, workspaceId: "workspace", cwd, metadata: { [METADATA_KEYS.teamEnabled]: true } } }) }),
    },
  } as unknown as PaseoApi;
  const call = fixture.handlers.get(getWorkspaceTeamStateRpc.name)!;
  const fromCwd = getWorkspaceTeamStateRpc.output.parse(await call({ workspaceId: "workspace", cwd }, { paseo }));
  assert.equal(fromCwd.excludedByDirectory, "/tmp");
  assert.equal(fromCwd.effectiveEnabled, false);
  assert.deepEqual(fromCwd.agents, []);
  const fromAgent = getWorkspaceTeamStateRpc.output.parse(await call({ workspaceId: "workspace", agentId: "root" }, { paseo }));
  assert.equal(fromAgent.cwd, cwd);
  assert.equal(fromAgent.effectiveEnabled, true);
  assert.equal(fromAgent.decisionSource, "agent-metadata");
});

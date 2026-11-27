import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolvePresetMembers } from "./shared/catalog-defaults.ts";
import { isSubagentLabels, resolveEffectiveTeamConfig } from "./shared/policy.ts";
import type { DriftedSubagentPromptItem } from "./shared/prompt-builder.ts";
import { computeTeamSyncFingerprint } from "./shared/settings.ts";
import { applyAgentCreateBefore, applyAgentOpenBefore } from "./server/hooks.ts";
import { registerTeamRpcs } from "./server/rpc.ts";
import { createSettingsCache } from "./server/settings-cache.ts";
import { createRosterTool, createUpdateMemberModelTool, listCommanderDriftedSubagents } from "./server/tools.ts";
import { createProviderCatalogCache } from "./server/provider-catalog-cache.ts";

export default function contribute(server: PluginServerContext) {
  const homeDir = homedir();
  const cache = createSettingsCache(server);
  let syncRevision = 0;
  const unsubscribeSettings = cache.subscribe((next, prev) => {
    if (computeTeamSyncFingerprint(next) !== computeTeamSyncFingerprint(prev)) syncRevision++;
  });
  const catalogCache = createProviderCatalogCache(homeDir);
  const rosterTool = createRosterTool(cache.getSettings, homeDir, catalogCache);
  const updateMemberModelTool = createUpdateMemberModelTool(cache.getSettings, homeDir, catalogCache);
  const removeCreateHook = server.addHook("agent.create.before", async ({ request }, context) => {
    await cache.waitReady();
    catalogCache.bind(context.paseo);
    const providers = await catalogCache.ensureFresh(context.paseo, { cwd: request.config.cwd });
    return applyAgentCreateBefore(request, cache.getSettings(), homeDir, providers);
  });
  const removeOpenHook = server.addHook("agent.open.before", async ({ request }, context) => {
    if (request.purpose === "history" || request.background) return;
    await cache.waitReady();
    catalogCache.bind(context.paseo);
    const providers = await catalogCache.ensureFresh(context.paseo, { cwd: request.cwd });
    const settings = cache.getSettings();
    const revision = syncRevision;
    let driftedSubagents: readonly DriftedSubagentPromptItem[] = [];
    if (!isSubagentLabels(request.labels)) {
      const { enabled, preset, presetId } = resolveEffectiveTeamConfig({ ...request, settings, homeDir });
      if (enabled) {
        const { resolved } = resolvePresetMembers(preset, providers, request.provider);
        const commander = { id: request.agentId, workspaceId: request.workspaceId, cwd: request.cwd };
        driftedSubagents = await listCommanderDriftedSubagents(context.paseo, commander, homeDir, resolved, presetId);
      }
    }
    const currentSettings = cache.getSettings();
    return applyAgentOpenBefore(request, currentSettings, [rosterTool, updateMemberModelTool], homeDir, providers,
      revision === syncRevision ? driftedSubagents : []);
  });
  registerTeamRpcs(server, cache, homeDir, catalogCache);

  return async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(removeCreateHook),
      Promise.resolve().then(removeOpenHook),
      Promise.resolve().then(unsubscribeSettings),
      cache.dispose(),
      Promise.resolve().then(() => catalogCache.dispose()),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Unable to release all team manager plugin resources.");
  };
}

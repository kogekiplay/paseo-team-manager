import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyAgentCreateBefore, applyAgentOpenBefore } from "./server/hooks.ts";
import { registerTeamRpcs } from "./server/rpc.ts";
import { createSettingsCache } from "./server/settings-cache.ts";
import { createRosterTool } from "./server/tools.ts";
import { createProviderCatalogCache } from "./server/provider-catalog-cache.ts";

export default function contribute(server: PluginServerContext) {
  const homeDir = homedir();
  const cache = createSettingsCache(server);
  const catalogCache = createProviderCatalogCache(homeDir);
  const rosterTool = createRosterTool(cache.getSettings, homeDir, catalogCache);
  const removeCreateHook = server.addHook("agent.create.before", async ({ request }, context) => {
    await cache.waitReady();
    catalogCache.bind(context.paseo);
    const providers = await catalogCache.ensureFresh(context.paseo, { cwd: request.config.cwd });
    return applyAgentCreateBefore(request, cache.getSettings(), homeDir, providers);
  });
  const removeOpenHook = server.addHook("agent.open.before", async ({ request }, context) => {
    await cache.waitReady();
    catalogCache.bind(context.paseo);
    const providers = await catalogCache.ensureFresh(context.paseo, { cwd: request.cwd });
    return applyAgentOpenBefore(request, cache.getSettings(), rosterTool, homeDir, providers);
  });
  registerTeamRpcs(server, cache, homeDir, catalogCache);

  return async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(removeCreateHook),
      Promise.resolve().then(removeOpenHook),
      cache.dispose(),
      Promise.resolve().then(() => catalogCache.dispose()),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Unable to release all team manager plugin resources.");
  };
}

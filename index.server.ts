import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { applyAgentCreateBefore, applyAgentOpenBefore } from "./server/hooks.ts";
import { registerTeamRpcs } from "./server/rpc.ts";
import { createSettingsCache } from "./server/settings-cache.ts";
import { createRosterTool } from "./server/tools.ts";

export default function contribute(server: PluginServerContext) {
  const homeDir = homedir();
  const cache = createSettingsCache(server);
  const rosterTool = createRosterTool(cache.getSettings, homeDir);
  const removeCreateHook = server.addHook("agent.create.before", async ({ request }) => {
    await cache.waitReady();
    return applyAgentCreateBefore(request, cache.getSettings(), homeDir);
  });
  const removeOpenHook = server.addHook("agent.open.before", async ({ request }) => {
    await cache.waitReady();
    return applyAgentOpenBefore(request, cache.getSettings(), rosterTool, homeDir);
  });
  registerTeamRpcs(server, cache, homeDir);

  return async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(removeCreateHook),
      Promise.resolve().then(removeOpenHook),
      cache.dispose(),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Unable to release all team manager plugin resources.");
  };
}

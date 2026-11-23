import type { PluginServerContext } from "@getpaseo/plugin/server";
import { parseTeamSettings, teamSettings } from "../shared/settings.ts";

export function createSettingsCache(server: Pick<PluginServerContext, "registerSettings">) {
  const registration = server.registerSettings(teamSettings);
  let settings = parseTeamSettings({});
  let observedUpdate = false;
  let disposed = false;

  const unsubscribe = registration.subscribe((state) => {
    if (disposed) return;
    observedUpdate = true;
    if (state.status === "ready") settings = state.values;
  });
  const ready = registration.read().then((state) => {
    if (!disposed && !observedUpdate && state.status === "ready") settings = state.values;
  }).catch(() => {
    // Keep defaults or the latest subscribed settings if the initial read fails.
  });

  return {
    getSettings: () => settings,
    waitReady: () => ready,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await unsubscribe();
    },
  };
}

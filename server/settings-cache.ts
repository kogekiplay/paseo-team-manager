import type { PluginServerContext } from "@getpaseo/plugin/server";
import { isDeepStrictEqual } from "node:util";
import { parseTeamSettings, teamSettings, type TeamSettingsValues } from "../shared/settings.ts";

type SettingsListener = (next: TeamSettingsValues, prev: TeamSettingsValues) => void;

export function createSettingsCache(server: Pick<PluginServerContext, "registerSettings">) {
  const registration = server.registerSettings(teamSettings);
  let settings = parseTeamSettings({});
  let observedUpdate = false;
  let disposed = false;
  let initialized = false;
  const listeners = new Set<SettingsListener>();

  const unsubscribe = registration.subscribe((state) => {
    if (disposed) return;
    observedUpdate = true;
    if (state.status !== "ready") return;
    const prev = settings;
    settings = state.values;
    if (initialized && !isDeepStrictEqual(prev, settings)) {
      for (const listener of listeners) listener(settings, prev);
    }
  });
  const ready = registration.read().then((state) => {
    if (!disposed && !observedUpdate && state.status === "ready") settings = state.values;
  }).catch(() => {
    // Keep defaults or the latest subscribed settings if the initial read fails.
  }).finally(() => { initialized = true; });

  return {
    getSettings: () => settings,
    waitReady: () => ready,
    subscribe(listener: SettingsListener) {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      await unsubscribe();
    },
  };
}

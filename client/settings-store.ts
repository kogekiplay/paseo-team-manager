import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import {
  DEFAULT_TEAM_SETTINGS,
  SETTINGS_ID,
  teamSettings,
  teamSettingsSchema,
  type TeamSettingsValues,
} from "../shared/settings.ts";

type BoolResult = boolean;
type AsyncBool = Promise<BoolResult>;
type VoidResult = void;
type AsyncVoid = Promise<VoidResult>;

export interface SettingsStoreSnapshot {
  readonly values: TeamSettingsValues;
  readonly revision: string | null;
  readonly loaded: boolean;
  readonly saving: boolean;
}

const rpcContracts = settingsRpc(teamSettings.id);

let boundClient: PluginClientContext | null = null;
let bindGeneration = 0;
let snapshot: SettingsStoreSnapshot = {
  values: DEFAULT_TEAM_SETTINGS,
  revision: null,
  loaded: false,
  saving: false,
};

const listeners = new Set<() => VoidResult>();

function safeParseTeamSettings(raw: unknown): TeamSettingsValues {
  const parsed = teamSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_TEAM_SETTINGS;
}

function emit(): VoidResult {
  for (const listener of listeners) {
    listener();
  }
}

function setSnapshot(next: SettingsStoreSnapshot): VoidResult {
  snapshot = next;
  emit();
}

export function getSettingsStoreSnapshot(): SettingsStoreSnapshot {
  return snapshot;
}

export function subscribeSettingsStore(listener: () => VoidResult): () => VoidResult {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTeamSettingsStore(): SettingsStoreSnapshot {
  return useSyncExternalStore(
    subscribeSettingsStore,
    getSettingsStoreSnapshot,
    getSettingsStoreSnapshot,
  );
}

export function getBoundClient(): PluginClientContext | null {
  return boundClient;
}

export function openPluginSettings(screenId = SETTINGS_ID): VoidResult {
  boundClient?.openSettings(screenId);
}

export function syncSettingsSnapshot(
  values: TeamSettingsValues,
  revision: string,
): VoidResult {
  setSnapshot({
    values: safeParseTeamSettings(values),
    revision,
    loaded: true,
    saving: false,
  });
}

export async function refreshTeamSettings(): Promise<SettingsStoreSnapshot> {
  const client = boundClient;
  const generation = bindGeneration;
  if (!client) return snapshot;

  try {
    const result = await client.rpc(rpcContracts.read, {});
    if (generation !== bindGeneration) return snapshot;

    if (result.status === "ready") {
      setSnapshot({
        values: safeParseTeamSettings(result.values),
        revision: result.revision,
        loaded: true,
        saving: false,
      });
    } else {
      setSnapshot({
        values: DEFAULT_TEAM_SETTINGS,
        revision: result.revision,
        loaded: true,
        saving: false,
      });
    }
  } catch (error) {
    if (generation === bindGeneration) {
      console.warn("[paseo-team-manager] Failed to read settings", error);
    }
  }
  return snapshot;
}

export async function patchTeamSettings(
  patch: Partial<TeamSettingsValues>,
): AsyncBool {
  const client = boundClient;
  const generation = bindGeneration;
  if (!client) return false;

  setSnapshot({ ...snapshot, saving: true });

  const tryWrite = async (): Promise<"saved" | "conflict" | "failed"> => {
    let revision = snapshot.revision;
    if (revision === null) {
      await refreshTeamSettings();
      revision = snapshot.revision;
    }
    if (revision === null || generation !== bindGeneration) {
      return "failed";
    }

    const nextValues = safeParseTeamSettings({
      ...snapshot.values,
      ...patch,
    });

    const result = await client.rpc(rpcContracts.write, {
      revision,
      values: nextValues,
    });
    if (generation !== bindGeneration) return "failed";

    if (result.status === "saved") {
      setSnapshot({
        values: safeParseTeamSettings(result.values),
        revision: result.revision,
        loaded: true,
        saving: false,
      });
      return "saved";
    }
    if (result.status === "conflict") {
      return "conflict";
    }
    return "failed";
  };

  try {
    const first = await tryWrite();
    if (first === "saved") return true;
    if (first === "conflict") {
      await refreshTeamSettings();
      const second = await tryWrite();
      if (second === "saved") return true;
    }
  } catch (error) {
    console.warn("[paseo-team-manager] Failed to update settings", error);
  }

  if (generation === bindGeneration) {
    setSnapshot({ ...snapshot, saving: false });
  }
  return false;
}

export function bindSettingsStore(client: PluginClientContext): () => VoidResult {
  bindGeneration += 1;
  const generation = bindGeneration;
  boundClient = client;

  const abortController = new AbortController();
  let releaseObservation: (() => VoidResult | AsyncVoid) | null = null;

  void refreshTeamSettings();

  try {
    const observeEvents = client.paseo?.observeEvents;
    if (typeof observeEvents === "function") {
      const observation = observeEvents.call(
        client.paseo,
        ["status.plugin_settings_changed"],
        { signal: abortController.signal },
      );
      observation.subscribe({
        snapshot: () => {
          if (generation === bindGeneration) {
            void refreshTeamSettings();
          }
        },
        update: (message) => {
          if (generation !== bindGeneration) return;
          if (message.type !== "status") return;
          if (message.payload.status !== "plugin_settings_changed") return;
          const settingsId = message.payload.settingsId;
          if (typeof settingsId === "string" && settingsId !== teamSettings.id) {
            return;
          }
          void refreshTeamSettings();
        },
      });
      releaseObservation = () => observation.release();
    }
  } catch (error) {
    console.warn(
      "[paseo-team-manager] Could not observe plugin settings events; falling back to local sync",
      error,
    );
  }

  return () => {
    abortController.abort();
    if (releaseObservation) {
      void Promise.resolve(releaseObservation()).catch(() => {});
      releaseObservation = null;
    }
    if (generation === bindGeneration) {
      boundClient = null;
      bindGeneration += 1;
    }
  };
}

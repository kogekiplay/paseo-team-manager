import type { PluginCleanup } from "@getpaseo/plugin";
import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ComposerTeamControl } from "./client/composer-control.tsx";
import { messages } from "./client/messages.ts";
import { TeamMainScreen, TeamSettingsScreen } from "./client/settings-screen.tsx";
import {
  bindSettingsStore,
  getSettingsStoreSnapshot,
  patchTeamSettings,
  subscribeSettingsStore,
} from "./client/settings-store.ts";
import { TeamAgentPanel, TeamWorkspacePanel } from "./client/team-panel.tsx";
import {
  buildComposerMetadataPatch,
  COMPOSER_AUTO_VALUE,
  COMPOSER_OFF_VALUE,
  COMPOSER_PRESET_PREFIX,
  parseTeamSlashArgs,
  updateWorkspaceOverride,
  type ComposerTeamValue,
} from "./client/team-state.ts";
import { resolveEffectiveTeamConfig } from "./shared/policy.ts";
import { METADATA_KEYS, SETTINGS_ID } from "./shared/settings.ts";

function TeamSidebarItem({
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Users"
      active={currentScreen?.screenId === SETTINGS_ID}
      onPress={() => openScreen({ screenId: SETTINGS_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let removeComposerItem: PluginCleanup | null = null;

  const unbindStore = bindSettingsStore(client);

  const syncDynamicContributions = () => {
    if (disposed) return;
    const { values } = getSettingsStoreSnapshot();

    if (values.showComposerControl && !removeComposerItem) {
      removeComposerItem = client.addComposerItem({
        id: "team-mode",
        Component: ComposerTeamControl,
      });
    } else if (!values.showComposerControl && removeComposerItem) {
      const remover = removeComposerItem;
      removeComposerItem = null;
      void remover();
    }
  };

  syncDynamicContributions();
  const unsubscribeStore = subscribeSettingsStore(syncDynamicContributions);

  const removeScreen = client.addScreen({
    id: SETTINGS_ID,
    title: messages.message("settings.title"),
    Component: TeamMainScreen,
  });

  const removeSidebarItem = client.addSidebarHeaderItem({
    id: SETTINGS_ID,
    title: messages.message("settings.title"),
    Component: TeamSidebarItem,
  });

  const removeSettingsScreen = client.addSettingsScreen({
    id: SETTINGS_ID,
    title: messages.message("settings.title"),
    icon: "Users",
    Component: TeamSettingsScreen,
  });

  const removeAgentPanel = client.addAgentPanel({
    id: "team-status",
    title: messages.message("panel.title"),
    icon: "Users",
    Component: TeamAgentPanel,
  });

  const removeWorkspacePanel = client.addWorkspacePanel({
    id: "team-workspace",
    title: messages.message("panel.workspaceTitle"),
    icon: "Users",
    Component: TeamWorkspacePanel,
  });

  const removeOpenSettingsCommand = client.addCommandCenterItem({
    id: "open-team-settings",
    title: messages.message("commands.openSettingsTitle"),
    icon: "Settings",
    keywords: ["team", "commander", "preset", "settings", "团队", "指挥", "设置"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  const removeOpenPanelCommand = client.addCommandCenterItem({
    id: "open-team-workspace-panel",
    title: messages.message("commands.openWorkspacePanelTitle"),
    icon: "Users",
    keywords: ["team", "roster", "subagent", "status", "团队", "名册", "状态"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("team-workspace");
    },
  });

  const removeToggleSessionCommand = client.addCommandCenterItem({
    id: "toggle-session-team-mode",
    title: messages.message("commands.toggleSessionTitle"),
    icon: "Users",
    keywords: ["team", "toggle", "commander", "session", "团队", "切换", "指挥"],
    context: "agent",
    async onSelect({ paseo, workspace, agent }) {
      const { values: settings } = getSettingsStoreSnapshot();
      const effective = resolveEffectiveTeamConfig({
        settings,
        workspaceId: workspace.id,
        cwd: agent.cwd,
        metadata: agent.metadata,
        labels: agent.labels,
      });
      await paseo.agents.ref(agent.id).setMetadata({
        [METADATA_KEYS.teamEnabled]: !effective.enabled,
      });
    },
  });

  const removeSlashCommand = client.addSlashCommand({
    name: "team",
    description: messages.message("slash.description"),
    argumentHint: messages.message("slash.argumentHint"),
    context: "workspace",
    async onSubmit({ args, workspace, composers, openPanel, openSettings }) {
      const parsed = parseTeamSlashArgs(args);

      if (parsed.kind === "panel") {
        openPanel("team-workspace");
        return;
      }

      if (parsed.kind === "settings") {
        openSettings(SETTINGS_ID);
        return;
      }

      if (parsed.kind === "invalid") {
        throw new Error(
          client.i18n.t(messages, "slash.invalidArgs", { arg: parsed.raw }),
        );
      }

      const { values: settings } = getSettingsStoreSnapshot();
      const focusedComposer = composers({ focused: true })[0] ?? null;

      if (parsed.kind === "preset") {
        const matched = settings.presets.find(
          (item) => item.id.toLowerCase() === parsed.presetId.toLowerCase(),
        );
        if (!matched) {
          throw new Error(
            client.i18n.t(messages, "slash.presetNotFound", {
              presetId: parsed.presetId,
            }),
          );
        }
        if (focusedComposer) {
          const val = `${COMPOSER_PRESET_PREFIX}${matched.id}` as ComposerTeamValue;
          await focusedComposer.setMetadata(buildComposerMetadataPatch(val));
        } else {
          const nextSettings = updateWorkspaceOverride(settings, workspace.id, {
            enabled: true,
            presetId: matched.id,
          });
          await patchTeamSettings({
            workspaceOverrides: nextSettings.workspaceOverrides,
          });
        }
        return;
      }

      if (parsed.kind === "on") {
        if (focusedComposer) {
          await focusedComposer.setMetadata({
            [METADATA_KEYS.teamEnabled]: true,
          });
        } else {
          const nextSettings = updateWorkspaceOverride(settings, workspace.id, {
            ...settings.workspaceOverrides[workspace.id],
            enabled: true,
          });
          await patchTeamSettings({
            workspaceOverrides: nextSettings.workspaceOverrides,
          });
        }
        return;
      }

      if (parsed.kind === "off") {
        if (focusedComposer) {
          await focusedComposer.setMetadata(
            buildComposerMetadataPatch(COMPOSER_OFF_VALUE),
          );
        } else {
          const nextSettings = updateWorkspaceOverride(settings, workspace.id, {
            ...settings.workspaceOverrides[workspace.id],
            enabled: false,
          });
          await patchTeamSettings({
            workspaceOverrides: nextSettings.workspaceOverrides,
          });
        }
        return;
      }

      // parsed.kind === "auto"
      if (focusedComposer) {
        await focusedComposer.setMetadata(
          buildComposerMetadataPatch(COMPOSER_AUTO_VALUE),
        );
      } else {
        const nextSettings = updateWorkspaceOverride(
          settings,
          workspace.id,
          null,
        );
        await patchTeamSettings({
          workspaceOverrides: nextSettings.workspaceOverrides,
        });
      }
    },
  });

  return () => {
    disposed = true;
    unsubscribeStore();
    if (removeComposerItem) {
      const remover = removeComposerItem;
      removeComposerItem = null;
      void remover();
    }
    void removeSlashCommand();
    void removeToggleSessionCommand();
    void removeOpenPanelCommand();
    void removeOpenSettingsCommand();
    void removeWorkspacePanel();
    void removeAgentPanel();
    void removeSettingsScreen();
    void removeSidebarItem();
    void removeScreen();
    unbindStore();
  };
}

import {
  useAgent,
  useAgents,
  usePaseo,
  useRpc,
  useTranslation,
  useWorkspace,
  type PluginAgentPanelProps,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  ScrollView,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  getWorkspaceTeamStateRpc,
  type WorkspaceTeamAgent,
  type WorkspaceTeamStateOutput,
} from "../shared/contracts.ts";
import { formatProviderModel, METADATA_KEYS } from "../shared/settings.ts";
import { messages } from "./messages.ts";
import {
  openPluginSettings,
  patchTeamSettings,
  useTeamSettingsStore,
} from "./settings-store.ts";
import {
  formatMemberSummary,
  localizeModeLabel,
  localizeThinkingLabel,
  updateWorkspaceOverride,
} from "./team-state.ts";

type Str = string;
type Bool = boolean;
type NullableStr = Str | null;
type NullableState = WorkspaceTeamStateOutput | null;

interface TeamPanelViewProps {
  readonly workspaceId: Str;
  readonly agentId?: Str;
  readonly agentStatus?: Str | null;
  readonly agentUpdatedAt?: Str | null;
  readonly revision: number;
  readonly theme: PluginSurfaceProps["theme"];
  readonly layout: PluginSurfaceProps["layout"];
  readonly navigation: PluginSurfaceProps["navigation"];
}

function getStatusColor(
  status: Str,
  colors: PluginSurfaceProps["theme"]["colors"],
): Str {
  if (status === "running") return colors.accent;
  if (status === "idle") return colors.statusSuccess;
  if (status === "initializing") return colors.statusWarning;
  if (status === "error") return colors.statusDanger;
  return colors.foregroundMuted;
}

function getStatusLabelKey(
  status: Str,
):
  | "panel.agentStatuses.initializing"
  | "panel.agentStatuses.idle"
  | "panel.agentStatuses.running"
  | "panel.agentStatuses.error"
  | "panel.agentStatuses.closed" {
  if (status === "initializing") return "panel.agentStatuses.initializing";
  if (status === "idle") return "panel.agentStatuses.idle";
  if (status === "running") return "panel.agentStatuses.running";
  if (status === "error") return "panel.agentStatuses.error";
  return "panel.agentStatuses.closed";
}

function getSourceLabelKey(
  source: WorkspaceTeamStateOutput["decisionSource"],
):
  | "panel.sources.agent-metadata"
  | "panel.sources.workspace-override"
  | "panel.sources.excluded-directory"
  | "panel.sources.global-default" {
  if (source === "agent-metadata") return "panel.sources.agent-metadata";
  if (source === "workspace-override") return "panel.sources.workspace-override";
  if (source === "excluded-directory") return "panel.sources.excluded-directory";
  return "panel.sources.global-default";
}

function sortWorkspaceAgents(
  agents: readonly WorkspaceTeamAgent[],
): WorkspaceTeamAgent[] {
  return [...agents].sort((a, b) => {
    if (a.isCommander !== b.isCommander) return a.isCommander ? -1 : 1;
    if (a.background !== b.background) return a.background ? 1 : -1;
    const aClosed = a.status === "closed";
    const bClosed = b.status === "closed";
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function TeamPanelView({
  workspaceId,
  agentId,
  agentStatus,
  agentUpdatedAt,
  revision,
  theme,
  layout,
  navigation,
}: TeamPanelViewProps) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const paseo = usePaseo();
  const fetchTeamState = useRpc(getWorkspaceTeamStateRpc);
  const { values: settingsValues, revision: settingsRevision } =
    useTeamSettingsStore();

  const workspaceInfo = useWorkspace(workspaceId, (workspace) => ({
    name: workspace.title || workspace.name,
    directory: workspace.directory,
  }));

  const workspaceAgentRefs = useAgents({
    where: (agent) => agent.workspaceId === workspaceId,
  });

  const [state, setState] = useState<NullableState>(null);
  const [loading, setLoading] = useState<Bool>(true);
  const [error, setError] = useState<NullableStr>(null);
  const [busyAction, setBusyAction] = useState<Bool>(false);
  const reqIdRef = useRef(0);

  const loadState = useCallback(async () => {
    const reqId = reqIdRef.current + 1;
    reqIdRef.current = reqId;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchTeamState({
        workspaceId,
        agentId,
        cwd: workspaceInfo?.directory ?? undefined,
      });
      if (reqIdRef.current !== reqId) return;
      setState(next);
    } catch (err) {
      if (reqIdRef.current !== reqId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (reqIdRef.current === reqId) {
        setLoading(false);
      }
    }
  }, [fetchTeamState, workspaceId, agentId, workspaceInfo?.directory]);

  useEffect(() => {
    void loadState();
  }, [
    loadState,
    revision,
    settingsRevision,
    workspaceAgentRefs.length,
    agentUpdatedAt,
  ]);

  const handleSessionMetadata = useCallback(
    async (enabled: Bool | null) => {
      if (!agentId) return;
      setBusyAction(true);
      try {
        await paseo.agents.ref(agentId).setMetadata({
          [METADATA_KEYS.teamEnabled]: enabled,
          ...(enabled === null || enabled === false
            ? { [METADATA_KEYS.presetId]: null }
            : {}),
        });
        toast.show(t("panel.metadataUpdatedToast"), { variant: "success" });
        await loadState();
      } catch (err) {
        toast.error(
          t("panel.actionFailedToast", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setBusyAction(false);
      }
    },
    [agentId, paseo, toast, t, loadState],
  );

  const handleReloadSession = useCallback(async () => {
    if (!agentId) return;
    setBusyAction(true);
    try {
      await paseo.agents.ref(agentId).reload();
      toast.show(t("panel.reloadedToast"), { variant: "success" });
      await loadState();
    } catch (err) {
      toast.error(
        t("panel.actionFailedToast", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusyAction(false);
    }
  }, [agentId, paseo, toast, t, loadState]);

  const handleWorkspaceOverride = useCallback(
    async (enabled: Bool | null) => {
      setBusyAction(true);
      try {
        const nextSettings = updateWorkspaceOverride(
          settingsValues,
          workspaceId,
          enabled === null ? null : { enabled },
        );
        const ok = await patchTeamSettings({
          workspaceOverrides: nextSettings.workspaceOverrides,
        });
        if (ok) {
          toast.show(t("panel.overrideUpdatedToast"), { variant: "success" });
          await loadState();
        } else {
          toast.error(t("panel.actionFailedToast", { error: "save failed" }));
        }
      } catch (err) {
        toast.error(
          t("panel.actionFailedToast", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setBusyAction(false);
      }
    },
    [settingsValues, workspaceId, toast, t, loadState],
  );

  const activeMembers = useMemo(
    () =>
      state?.activePreset.members.filter((member) => member.enabled) ?? [],
    [state],
  );

  const optionalMembers = useMemo(
    () =>
      state?.activePreset.members.filter((member) => !member.enabled) ?? [],
    [state],
  );

  const sortedAgents = useMemo(
    () => (state ? sortWorkspaceAgents(state.agents) : []),
    [state],
  );

  const effectiveAgentStatus = useMemo(() => {
    if (agentStatus) return agentStatus;
    if (!agentId || !state) return null;
    return state.agents.find((item) => item.agentId === agentId)?.status ?? null;
  }, [agentStatus, agentId, state]);

  const isSessionRunning = effectiveAgentStatus === "running";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
        },
        content: {
          padding: layout.compact ? 14 : 20,
          gap: layout.compact ? 14 : 18,
        },
        card: {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 12,
          padding: layout.compact ? 12 : 16,
          gap: 12,
        },
        headerRow: {
          flexDirection: layout.compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: layout.compact ? "flex-start" : "center",
          gap: 10,
        },
        headerTitleRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        },
        headerActions: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
        },
        titleText: {
          color: theme.colors.foreground,
          fontSize: layout.compact ? 16 : 18,
          fontWeight: "600",
        },
        sectionTitle: {
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
        },
        subSectionTitle: {
          color: theme.colors.foregroundMuted,
          fontSize: 12.5,
          fontWeight: "600",
        },
        metaRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        },
        pillBadge: {
          borderRadius: 999,
          borderWidth: 1,
          paddingHorizontal: 9,
          paddingVertical: 3,
          flexDirection: "row",
          alignSelf: "center",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
        },
        pillEnabled: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.statusSuccess,
        },
        pillDisabled: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
        },
        pillAccent: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.accent,
        },
        pillTextSuccess: {
          color: theme.colors.statusSuccess,
          fontSize: 12,
          fontWeight: "600",
        },
        pillTextMuted: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          fontWeight: "500",
        },
        pillTextAccent: {
          color: theme.colors.accent,
          fontSize: 12,
          fontWeight: "600",
        },
        infoLine: {
          color: theme.colors.foreground,
          fontSize: 13,
        },
        mutedText: {
          color: theme.colors.foregroundMuted,
          fontSize: 12.5,
        },
        warningText: {
          color: theme.colors.statusWarning,
          fontSize: 12.5,
        },
        errorText: {
          color: theme.colors.statusDanger,
          fontSize: 13,
        },
        buttonRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
        },
        btn: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: layout.compact ? 10 : 12,
          paddingVertical: 7,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        btnPrimary: {
          backgroundColor: theme.colors.accent,
          borderColor: theme.colors.accent,
        },
        btnDisabled: {
          opacity: 0.45,
        },
        btnText: {
          color: theme.colors.foreground,
          fontSize: 12.5,
          fontWeight: "500",
        },
        btnTextPrimary: {
          color: theme.colors.accentForeground,
          fontSize: 12.5,
          fontWeight: "600",
        },
        itemCard: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: layout.compact ? 10 : 12,
          gap: 5,
        },
        itemHeader: {
          flexDirection: layout.compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: layout.compact ? "flex-start" : "center",
          gap: 6,
        },
        itemTitleRow: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          flex: 1,
        },
        itemTitle: {
          color: theme.colors.foreground,
          fontSize: 13.5,
          fontWeight: "600",
        },
        statusDot: {
          width: 8,
          height: 8,
          borderRadius: 999,
        },
        listGap: {
          gap: 8,
        },
      }),
    [theme, layout.compact],
  );

  if (loading && !state) {
    return (
      <View style={styles.screen}>
        <Loading />
      </View>
    );
  }

  if (error && !state) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t("panel.loadError")}</Text>
          <Text style={styles.errorText}>{error}</Text>
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void loadState()}
              style={[styles.btn, styles.btnPrimary]}
            >
              <Icon
                name="RefreshCw"
                size={14}
                color={theme.colors.accentForeground}
              />
              <Text style={styles.btnTextPrimary}>
                {t("panel.retryAction")}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Top Status Card */}
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitleRow}>
            <Icon name="Users" size={18} color={theme.colors.foreground} />
            <Text style={styles.titleText}>
              {workspaceInfo?.name ??
                (agentId ? t("panel.title") : t("panel.workspaceTitle"))}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              disabled={loading}
              onPress={() => void loadState()}
              style={[styles.btn, loading ? styles.btnDisabled : null]}
            >
              <Icon name="RefreshCw" size={13} color={theme.colors.foreground} />
              <Text style={styles.btnText}>{t("panel.refreshAction")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => openPluginSettings("team")}
              style={styles.btn}
            >
              <Icon name="Settings" size={13} color={theme.colors.foreground} />
              <Text style={styles.btnText}>{t("panel.openSettingsAction")}</Text>
            </Pressable>
          </View>
        </View>

        {state ? (
          <>
            <View style={styles.metaRow}>
              <View
                style={[
                  styles.pillBadge,
                  state.effectiveEnabled
                    ? styles.pillEnabled
                    : styles.pillDisabled,
                ]}
              >
                <Text
                  style={
                    state.effectiveEnabled
                      ? styles.pillTextSuccess
                      : styles.pillTextMuted
                  }
                >
                  {state.effectiveEnabled
                    ? t("panel.statusEnabled")
                    : t("panel.statusDisabled")}
                </Text>
              </View>

              <View style={[styles.pillBadge, styles.pillDisabled]}>
                <Text style={styles.pillTextMuted}>
                  {t("panel.decisionSourceLabel")}:{" "}
                  {t(getSourceLabelKey(state.decisionSource))}
                </Text>
              </View>

              <View
                style={[
                  styles.pillBadge,
                  state.activePreset.commanderNoDirectEdit
                    ? styles.pillAccent
                    : styles.pillDisabled,
                ]}
              >
                <Icon
                  name="ShieldCheck"
                  size={13}
                  color={
                    state.activePreset.commanderNoDirectEdit
                      ? theme.colors.accent
                      : theme.colors.foregroundMuted
                  }
                />
                <Text
                  style={
                    state.activePreset.commanderNoDirectEdit
                      ? styles.pillTextAccent
                      : styles.pillTextMuted
                  }
                >
                  {state.activePreset.commanderNoDirectEdit
                    ? t("panel.noDirectEditBadge")
                    : t("panel.allowDirectEditBadge")}
                </Text>
              </View>
            </View>

            <Text style={styles.infoLine}>
              {t("panel.activePresetLabel")}: {state.activePreset.name} (
              {state.activePresetId})
            </Text>

            {state.excludedByDirectory ? (
              <Text style={styles.warningText}>
                {t("panel.excludedByLabel", {
                  rule: state.excludedByDirectory,
                })}
              </Text>
            ) : null}

            {state.cwd ? (
              <Text style={styles.mutedText}>{state.cwd}</Text>
            ) : null}
          </>
        ) : null}
      </View>

      {/* Quick Actions Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("panel.quickActionsTitle")}</Text>
        {agentId ? (
          <>
            <View style={styles.buttonRow}>
              <Pressable
                accessibilityRole="button"
                disabled={busyAction}
                onPress={() => void handleSessionMetadata(true)}
                style={[
                  styles.btn,
                  styles.btnPrimary,
                  busyAction ? styles.btnDisabled : null,
                ]}
              >
                <Text style={styles.btnTextPrimary}>
                  {t("panel.sessionEnableAction")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busyAction}
                onPress={() => void handleSessionMetadata(false)}
                style={[styles.btn, busyAction ? styles.btnDisabled : null]}
              >
                <Text style={styles.btnText}>
                  {t("panel.sessionDisableAction")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busyAction}
                onPress={() => void handleSessionMetadata(null)}
                style={[styles.btn, busyAction ? styles.btnDisabled : null]}
              >
                <Text style={styles.btnText}>
                  {t("panel.sessionAutoAction")}
                </Text>
              </Pressable>
            </View>

            <View style={styles.listGap}>
              <View style={styles.buttonRow}>
                <Pressable
                  accessibilityRole="button"
                  disabled={busyAction || isSessionRunning}
                  onPress={() => void handleReloadSession()}
                  style={[
                    styles.btn,
                    busyAction || isSessionRunning ? styles.btnDisabled : null,
                  ]}
                >
                  <Icon
                    name="RefreshCw"
                    size={13}
                    color={theme.colors.foreground}
                  />
                  <Text style={styles.btnText}>
                    {t("panel.reloadSessionAction")}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.mutedText}>
                {isSessionRunning
                  ? t("panel.reloadRunningHint")
                  : t("panel.reloadSessionHint")}
              </Text>
            </View>
          </>
        ) : (
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              disabled={busyAction}
              onPress={() => void handleWorkspaceOverride(true)}
              style={[
                styles.btn,
                styles.btnPrimary,
                busyAction ? styles.btnDisabled : null,
              ]}
            >
              <Text style={styles.btnTextPrimary}>
                {t("panel.workspaceEnableAction")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busyAction}
              onPress={() => void handleWorkspaceOverride(false)}
              style={[styles.btn, busyAction ? styles.btnDisabled : null]}
            >
              <Text style={styles.btnText}>
                {t("panel.workspaceDisableAction")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busyAction}
              onPress={() => void handleWorkspaceOverride(null)}
              style={[styles.btn, busyAction ? styles.btnDisabled : null]}
            >
              <Text style={styles.btnText}>
                {t("panel.workspaceClearAction")}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Team Roster Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{t("panel.rosterTitle")}</Text>

        <Text style={styles.subSectionTitle}>
          {t("panel.activeMembersTitle", { count: activeMembers.length })}
        </Text>
        {activeMembers.length === 0 ? (
          <Text style={styles.mutedText}>{t("panel.noMembers")}</Text>
        ) : (
          <View style={styles.listGap}>
            {activeMembers.map((member) => (
              <View key={member.id} style={styles.itemCard}>
                <View style={styles.itemTitleRow}>
                  <Text style={styles.itemTitle}>{member.name}</Text>
                  <View style={[styles.pillBadge, styles.pillEnabled]}>
                    <Text style={styles.pillTextSuccess}>{member.roleId}</Text>
                  </View>
                </View>
                <Text style={styles.infoLine}>
                  {formatMemberSummary(member, locale)}
                </Text>
                {member.responsibilities.trim() ? (
                  <Text style={styles.mutedText}>
                    {member.responsibilities.trim()}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {optionalMembers.length > 0 ? (
          <>
            <Text style={styles.subSectionTitle}>
              {t("panel.optionalMembersTitle", {
                count: optionalMembers.length,
              })}
            </Text>
            <View style={styles.listGap}>
              {optionalMembers.map((member) => (
                <View key={member.id} style={styles.itemCard}>
                  <View style={styles.itemTitleRow}>
                    <Text style={styles.itemTitle}>{member.name}</Text>
                    <View style={[styles.pillBadge, styles.pillDisabled]}>
                      <Text style={styles.pillTextMuted}>{member.roleId}</Text>
                    </View>
                  </View>
                  <Text style={styles.mutedText}>
                    {formatMemberSummary(member, locale)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>

      {/* Workspace Sessions & Subagents Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          {t("panel.agentsTitle", { count: sortedAgents.length })}
        </Text>

        {sortedAgents.length === 0 ? (
          <Text style={styles.mutedText}>{t("panel.noAgents")}</Text>
        ) : (
          <View style={styles.listGap}>
            {sortedAgents.map((item) => {
              const dotColor = getStatusColor(item.status, theme.colors);
              const providerLabel = formatProviderModel(
                item.provider,
                item.model ?? "",
              );
              return (
                <View key={item.agentId} style={styles.itemCard}>
                  <View style={styles.itemHeader}>
                    <View style={styles.itemTitleRow}>
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: dotColor },
                        ]}
                      />
                      <Text style={styles.itemTitle}>
                        {item.title || item.agentId}
                      </Text>

                      {item.isCommander ? (
                        <View style={[styles.pillBadge, styles.pillAccent]}>
                          <Text style={styles.pillTextAccent}>
                            {t("panel.commanderBadge")}
                          </Text>
                        </View>
                      ) : item.roleId ? (
                        <View style={[styles.pillBadge, styles.pillEnabled]}>
                          <Text style={styles.pillTextSuccess}>
                            {item.roleId}
                          </Text>
                        </View>
                      ) : (
                        <View style={[styles.pillBadge, styles.pillDisabled]}>
                          <Text style={styles.pillTextMuted}>
                            {t("panel.subagentBadge")}
                          </Text>
                        </View>
                      )}

                      {item.background ? (
                        <View style={[styles.pillBadge, styles.pillDisabled]}>
                          <Text style={styles.pillTextMuted}>
                            {t("panel.backgroundBadge")}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {navigation?.openAgent ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          navigation.openAgent({ agentId: item.agentId })
                        }
                        style={styles.btn}
                      >
                        <Icon
                          name="ExternalLink"
                          size={13}
                          color={theme.colors.foreground}
                        />
                        <Text style={styles.btnText}>
                          {t("panel.openAgentAction")}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>

                  <Text style={styles.mutedText}>
                    {t(getStatusLabelKey(item.status))} · {providerLabel}
                    {item.thinkingOptionId
                      ? ` · ${localizeThinkingLabel(item.thinkingOptionId, item.thinkingOptionId, locale)}`
                      : ""}
                    {item.modeId
                      ? ` · ${localizeModeLabel(item.modeId, item.modeId, locale)}`
                      : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

export function TeamAgentPanel({
  workspaceId,
  params,
  revision,
  theme,
  layout,
  navigation,
}: PluginAgentPanelProps) {
  const agentSnapshot = useAgent(params.agentId, (agent) => ({
    status: agent.status,
    updatedAt: agent.updatedAt,
  }));

  return (
    <TeamPanelView
      workspaceId={workspaceId}
      agentId={params.agentId}
      agentStatus={agentSnapshot?.status ?? null}
      agentUpdatedAt={agentSnapshot?.updatedAt ?? null}
      revision={revision}
      theme={theme}
      layout={layout}
      navigation={navigation}
    />
  );
}

export function TeamWorkspacePanel({
  workspaceId,
  revision,
  theme,
  layout,
  navigation,
}: PluginWorkspacePanelProps) {
  return (
    <TeamPanelView
      workspaceId={workspaceId}
      revision={revision}
      theme={theme}
      layout={layout}
      navigation={navigation}
    />
  );
}

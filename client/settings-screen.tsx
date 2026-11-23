import {
  useRpc,
  useSettings,
  useTranslation,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Markdown,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  getProviderCatalogRpc,
  previewCommanderPromptRpc,
  type ProviderCatalogEntry,
  type ProviderCatalogOutput,
} from "../shared/contracts.ts";
import { buildCommanderPrompt } from "../shared/prompt-builder.ts";
import {
  teamSettings,
  type TeamMember,
  type TeamPreset,
  type TeamSettingsValues,
} from "../shared/settings.ts";
import { MemberEditorModal } from "./member-editor-modal.tsx";
import { messages } from "./messages.ts";
import { syncSettingsSnapshot } from "./settings-store.ts";
import {
  addExcludedDirectory,
  createNewPreset,
  deleteMember,
  deletePreset,
  duplicatePreset,
  formatMemberSummary,
  hasExcludedDirectory,
  normalizeExcludedDirectories,
  removeExcludedDirectory,
  toggleMemberEnabled,
  updatePreset,
  upsertMember,
} from "./team-state.ts";

type TeamSchema = typeof teamSettings.schema;
type ReadySettings = Extract<SettingsState<TeamSchema>, { status: "ready" }>;
type Str = string;
type Bool = boolean;
type NullableStr = Str | null;
type NullableCatalog = ProviderCatalogOutput | null;
type NullableMember = TeamMember | null;

const EMPTY_PROVIDERS: readonly ProviderCatalogEntry[] = [];
const EMPTY_MEMBERS: readonly TeamMember[] = [];

interface TeamDraft {
  readonly excludedDirectories: Str[];
  readonly defaultPresetId: Str;
  readonly presets: TeamPreset[];
}

function buildDraft(values: TeamSettingsValues): TeamDraft {
  return {
    excludedDirectories: [...values.excludedDirectories],
    defaultPresetId: values.defaultPresetId,
    presets: values.presets.map((preset) => ({
      ...preset,
      members: preset.members.map((member) => ({
        ...member,
        features: { ...member.features },
      })),
    })),
  };
}

function serializeDraft(draft: TeamDraft): Str {
  return JSON.stringify({
    excludedDirectories: draft.excludedDirectories,
    defaultPresetId: draft.defaultPresetId,
    presets: draft.presets,
  });
}

function ReadyTeamSettingsContent({
  settings,
  theme,
  layout,
}: {
  readonly settings: ReadySettings;
  readonly theme: PluginSurfaceProps["theme"];
  readonly layout: PluginSurfaceProps["layout"];
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();

  const fetchProviderCatalog = useRpc(getProviderCatalogRpc);
  const fetchPromptPreview = useRpc(previewCommanderPromptRpc);

  useEffect(() => {
    syncSettingsSnapshot(settings.values, settings.revision);
  }, [settings.values, settings.revision]);

  const [draft, setDraft] = useState<TeamDraft>(() => buildDraft(settings.values));
  const [draftRevision, setDraftRevision] = useState<Str>(settings.revision);
  const ownImmediateSavePendingRef = useRef(false);

  const [selectedPresetId, setSelectedPresetId] = useState<Str>(
    () => settings.values.defaultPresetId || settings.values.presets[0]?.id || "",
  );
  const [newDirInput, setNewDirInput] = useState<Str>("");

  const [catalog, setCatalog] = useState<NullableCatalog>(null);
  const [catalogLoading, setCatalogLoading] = useState<Bool>(false);
  const [catalogError, setCatalogError] = useState<NullableStr>(null);

  const [memberModalOpen, setMemberModalOpen] = useState<Bool>(false);
  const [editingMember, setEditingMember] = useState<NullableMember>(null);

  const [previewExpanded, setPreviewExpanded] = useState<Bool>(false);
  const [previewText, setPreviewText] = useState<NullableStr>(null);
  const [previewLoading, setPreviewLoading] = useState<Bool>(false);
  const previewReqRef = useRef(0);

  const isDraftDirty = useMemo(
    () => serializeDraft(draft) !== serializeDraft(buildDraft(settings.values)),
    [draft, settings.values],
  );

  useEffect(() => {
    if (settings.revision === draftRevision) return;
    if (ownImmediateSavePendingRef.current) {
      ownImmediateSavePendingRef.current = false;
      setDraftRevision(settings.revision);
      return;
    }
    if (!isDraftDirty) {
      const next = buildDraft(settings.values);
      setDraft(next);
      setDraftRevision(settings.revision);
      setSelectedPresetId((current) =>
        next.presets.some((item) => item.id === current)
          ? current
          : next.defaultPresetId || next.presets[0]?.id || "",
      );
    }
  }, [isDraftDirty, settings.revision, settings.values, draftRevision]);

  const activePreset = useMemo(
    () =>
      draft.presets.find((item) => item.id === selectedPresetId) ??
      draft.presets[0],
    [draft.presets, selectedPresetId],
  );

  useEffect(() => {
    if (activePreset && activePreset.id !== selectedPresetId) {
      setSelectedPresetId(activePreset.id);
    }
  }, [activePreset, selectedPresetId]);

  const loadCatalog = useCallback(
    async (refresh = false) => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const result = await fetchProviderCatalog({ refresh });
        setCatalog(result);
      } catch (error) {
        setCatalogError(error instanceof Error ? error.message : String(error));
      } finally {
        setCatalogLoading(false);
      }
    },
    [fetchProviderCatalog],
  );

  useEffect(() => {
    void loadCatalog(false);
  }, [loadCatalog]);

  const localFallbackPreview = useMemo(
    () => (activePreset ? buildCommanderPrompt({ preset: activePreset }) : ""),
    [activePreset],
  );

  useEffect(() => {
    if (!previewExpanded || !activePreset) return;
    const reqId = previewReqRef.current + 1;
    previewReqRef.current = reqId;
    setPreviewLoading(true);

    void fetchPromptPreview({ preset: activePreset })
      .then((result) => {
        if (previewReqRef.current !== reqId) return;
        setPreviewText(result.commanderPrompt);
      })
      .catch(() => {
        if (previewReqRef.current !== reqId) return;
        setPreviewText(null);
      })
      .finally(() => {
        if (previewReqRef.current === reqId) {
          setPreviewLoading(false);
        }
      });
  }, [previewExpanded, activePreset, fetchPromptPreview]);

  const saveImmediate = useCallback(
    async (patch: Partial<TeamSettingsValues>) => {
      const nextValues: TeamSettingsValues = {
        ...settings.values,
        ...patch,
      };
      ownImmediateSavePendingRef.current = true;
      const ok = await settings.save(nextValues, settings.revision);
      if (!ok) {
        ownImmediateSavePendingRef.current = false;
        if (settings.saveError) {
          toast.error(t("settings.saveFailedToast", { error: settings.saveError }));
        }
      }
    },
    [settings, toast, t],
  );

  const handleSaveDraft = useCallback(async () => {
    const emptyNamePreset = draft.presets.find((item) => item.name.trim() === "");
    if (emptyNamePreset) {
      setSelectedPresetId(emptyNamePreset.id);
      toast.error(t("settings.presets.nameEmptyError"));
      return;
    }

    const normalizedDirs = normalizeExcludedDirectories(
      draft.excludedDirectories,
      catalog?.homeDir,
    );
    const validDefault = draft.presets.some(
      (item) => item.id === draft.defaultPresetId,
    )
      ? draft.defaultPresetId
      : draft.presets[0].id;
    const nextValues: TeamSettingsValues = {
      ...settings.values,
      excludedDirectories: normalizedDirs,
      defaultPresetId: validDefault,
      presets: draft.presets.map((preset) => ({
        ...preset,
        name: preset.name.trim(),
      })),
    };
    const ok = await settings.save(nextValues, draftRevision);
    if (ok) {
      toast.show(t("settings.savedToast"), { variant: "success" });
    } else if (settings.saveError) {
      toast.error(t("settings.saveFailedToast", { error: settings.saveError }));
    }
  }, [draft, draftRevision, catalog?.homeDir, settings, toast, t]);

  const handleDiscardDraft = useCallback(() => {
    const reset = buildDraft(settings.values);
    setDraft(reset);
    setDraftRevision(settings.revision);
    setSelectedPresetId(reset.defaultPresetId || reset.presets[0]?.id || "");
    toast.show(t("settings.discardedToast"), { variant: "info" });
  }, [settings.values, settings.revision, toast, t]);

  const handleResetDefaults = useCallback(async () => {
    const ok = await settings.reset();
    if (ok) {
      toast.show(t("settings.resetSuccessToast"), { variant: "success" });
    } else if (settings.saveError) {
      toast.error(t("settings.saveFailedToast", { error: settings.saveError }));
    }
  }, [settings, toast, t]);

  const handleAddExcludedDir = useCallback(
    (rawPath: Str) => {
      const trimmed = rawPath.trim();
      if (!trimmed) return;
      if (hasExcludedDirectory(draft.excludedDirectories, trimmed, catalog?.homeDir)) {
        toast.show(t("settings.excludedDirs.alreadyExcludedToast"), {
          variant: "info",
        });
        return;
      }
      setDraft((current) => ({
        ...current,
        excludedDirectories: addExcludedDirectory(
          current.excludedDirectories,
          trimmed,
          catalog?.homeDir,
        ),
      }));
      if (rawPath === newDirInput) {
        setNewDirInput("");
      }
      toast.show(t("settings.excludedDirs.addedToast", { dir: trimmed }), {
        variant: "info",
      });
    },
    [draft.excludedDirectories, catalog?.homeDir, newDirInput, toast, t],
  );

  const handleRemoveExcludedDir = useCallback(
    (dir: Str) => {
      setDraft((current) => ({
        ...current,
        excludedDirectories: removeExcludedDirectory(
          current.excludedDirectories,
          dir,
          catalog?.homeDir,
        ),
      }));
    },
    [catalog?.homeDir],
  );

  const handleCreatePreset = useCallback(() => {
    const { presets, created } = createNewPreset(
      draft.presets,
      t("settings.presets.newPresetBaseName"),
    );
    setDraft((current) => ({ ...current, presets }));
    setSelectedPresetId(created.id);
    toast.show(t("settings.presets.createdToast", { name: created.name }), {
      variant: "info",
    });
  }, [draft.presets, toast, t]);

  const handleDuplicatePreset = useCallback(() => {
    if (!activePreset) return;
    const duplicated = duplicatePreset(
      draft.presets,
      activePreset.id,
      t("settings.presets.duplicateSuffix"),
    );
    if (!duplicated) return;
    setDraft((current) => ({ ...current, presets: duplicated.presets }));
    setSelectedPresetId(duplicated.created.id);
    toast.show(
      t("settings.presets.duplicatedToast", { name: duplicated.created.name }),
      { variant: "info" },
    );
  }, [activePreset, draft.presets, toast, t]);

  const handleDeletePreset = useCallback(() => {
    if (!activePreset) return;
    if (draft.presets.length <= 1) {
      toast.show(t("settings.presets.cannotDeleteLastToast"), {
        variant: "warning",
      });
      return;
    }
    const deletedName = activePreset.name;
    const nextSettings = deletePreset(
      { ...settings.values, ...draft },
      activePreset.id,
    );
    setDraft((current) => ({
      ...current,
      presets: nextSettings.presets,
      defaultPresetId: nextSettings.defaultPresetId,
    }));
    setSelectedPresetId(nextSettings.defaultPresetId);
    toast.show(t("settings.presets.deletedToast", { name: deletedName }), {
      variant: "info",
    });
  }, [activePreset, draft, settings.values, toast, t]);

  const handleSetDefaultPreset = useCallback(() => {
    if (!activePreset) return;
    setDraft((current) => ({
      ...current,
      defaultPresetId: activePreset.id,
    }));
  }, [activePreset]);

  const patchActivePreset = useCallback(
    (patch: Partial<TeamPreset>) => {
      if (!activePreset) return;
      setDraft((current) => ({
        ...current,
        presets: updatePreset(current.presets, activePreset.id, patch),
      }));
    },
    [activePreset],
  );

  const handleSaveMember = useCallback(
    (member: TeamMember) => {
      if (!activePreset) return;
      setDraft((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id ? upsertMember(preset, member) : preset,
        ),
      }));
      setMemberModalOpen(false);
      setEditingMember(null);
    },
    [activePreset],
  );

  const handleToggleMember = useCallback(
    (memberId: Str, enabled: Bool) => {
      if (!activePreset) return;
      setDraft((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id
            ? toggleMemberEnabled(preset, memberId, enabled)
            : preset,
        ),
      }));
    },
    [activePreset],
  );

  const handleDeleteMember = useCallback(
    (member: TeamMember) => {
      if (!activePreset) return;
      setDraft((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id
            ? deleteMember(preset, member.id)
            : preset,
        ),
      }));
      toast.show(t("settings.members.removedToast", { name: member.name }), {
        variant: "info",
      });
    },
    [activePreset, toast, t],
  );

  const handleCopyPreview = useCallback(async () => {
    const content = previewText ?? localFallbackPreview;
    if (!content) return;
    try {
      await copyText(content);
      toast.show(t("settings.preview.copiedToast"), { variant: "success" });
    } catch {
      toast.error(t("settings.preview.copyFailedToast"));
    }
  }, [previewText, localFallbackPreview, toast, t]);

  const presetOptions = useMemo(
    () =>
      draft.presets.map((preset) => ({
        value: preset.id,
        label:
          preset.id === draft.defaultPresetId
            ? `${preset.name} ${t("settings.presets.defaultTag")}`
            : preset.name,
      })),
    [draft.presets, draft.defaultPresetId, t],
  );

  const downloadsExcluded = useMemo(
    () =>
      hasExcludedDirectory(
        draft.excludedDirectories,
        "~/Downloads",
        catalog?.homeDir,
      ),
    [draft.excludedDirectories, catalog?.homeDir],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          gap: layout.compact ? 16 : 20,
        },
        textInput: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          color: theme.colors.foreground,
          fontSize: 13.5,
          paddingHorizontal: 10,
          paddingVertical: layout.compact ? 8 : 9,
        },
        multilineInput: {
          minHeight: layout.compact ? 80 : 96,
          textAlignVertical: "top",
        },
        inlineInputRow: {
          flexDirection: layout.compact ? "column" : "row",
          gap: 8,
          alignItems: layout.compact ? "stretch" : "center",
        },
        flexInput: {
          flex: 1,
        },
        actionRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingTop: 4,
        },
        chipBtn: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: layout.compact ? 10 : 12,
          paddingVertical: 7,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        },
        chipBtnPrimary: {
          backgroundColor: theme.colors.accent,
          borderColor: theme.colors.accent,
        },
        chipBtnDanger: {
          borderColor: theme.colors.statusDanger,
        },
        chipBtnDisabled: {
          opacity: 0.45,
        },
        chipBtnText: {
          color: theme.colors.foreground,
          fontSize: 12.5,
          fontWeight: "500",
        },
        chipBtnTextPrimary: {
          color: theme.colors.accentForeground,
          fontSize: 12.5,
          fontWeight: "600",
        },
        chipBtnTextDanger: {
          color: theme.colors.statusDanger,
          fontSize: 12.5,
          fontWeight: "500",
        },
        dirList: {
          gap: 8,
          paddingTop: 4,
        },
        dirRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          gap: 8,
        },
        dirLeft: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flex: 1,
        },
        dirText: {
          color: theme.colors.foreground,
          fontSize: 13,
          flexShrink: 1,
        },
        mutedText: {
          color: theme.colors.foregroundMuted,
          fontSize: 12.5,
        },
        errorText: {
          color: theme.colors.statusDanger,
          fontSize: 12.5,
        },
        warningText: {
          color: theme.colors.statusWarning,
          fontSize: 12.5,
          fontWeight: "500",
        },
        successBadge: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.statusSuccess,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 8,
          paddingVertical: 2,
        },
        successBadgeText: {
          color: theme.colors.statusSuccess,
          fontSize: 11.5,
          fontWeight: "600",
        },
        mutedBadge: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 8,
          paddingVertical: 2,
        },
        mutedBadgeText: {
          color: theme.colors.foregroundMuted,
          fontSize: 11.5,
          fontWeight: "500",
        },
        memberList: {
          gap: 10,
          paddingHorizontal: layout.compact ? 10 : 14,
          paddingVertical: 10,
        },
        memberCard: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: layout.compact ? 10 : 12,
          gap: 8,
        },
        memberHeader: {
          flexDirection: layout.compact ? "column" : "row",
          justifyContent: "space-between",
          alignItems: layout.compact ? "flex-start" : "center",
          gap: 8,
        },
        memberTitleRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        },
        memberName: {
          color: theme.colors.foreground,
          fontSize: 14,
          fontWeight: "600",
        },
        memberRoleTag: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
        },
        memberSummary: {
          color: theme.colors.foreground,
          fontSize: 12.5,
        },
        memberActions: {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        },
        previewHeaderBtn: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: layout.compact ? 12 : 14,
          paddingVertical: 12,
          gap: 8,
        },
        previewHeaderLeft: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flex: 1,
        },
        previewHeaderTitle: {
          color: theme.colors.foreground,
          fontSize: 13.5,
          fontWeight: "600",
        },
        previewBody: {
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          padding: layout.compact ? 12 : 14,
          gap: 10,
        },
        previewToolbar: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        },
        previewMarkdownBox: {
          backgroundColor: theme.colors.surface0,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: layout.compact ? 10 : 12,
        },
      }),
    [theme, layout.compact],
  );

  const displayedPreview = previewText ?? localFallbackPreview;

  return (
    <View style={styles.container}>
      {/* Section 1: General Settings */}
      <SettingsSection title={t("settings.sections.general")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.enabledLabel")}
            hint={t("settings.general.enabledHint")}
            value={settings.values.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) => void saveImmediate({ enabled })}
          />
          <SettingsSwitch
            label={t("settings.general.autoApplyLabel")}
            hint={t("settings.general.autoApplyHint")}
            value={settings.values.autoApplyToNewTopLevelAgents}
            disabled={settings.saving}
            onValueChange={(autoApplyToNewTopLevelAgents) =>
              void saveImmediate({ autoApplyToNewTopLevelAgents })
            }
          />
          <SettingsSwitch
            label={t("settings.general.showComposerLabel")}
            hint={t("settings.general.showComposerHint")}
            value={settings.values.showComposerControl}
            disabled={settings.saving}
            onValueChange={(showComposerControl) =>
              void saveImmediate({ showComposerControl })
            }
          />
          <SettingsSwitch
            label={t("settings.general.enforceDefaultsLabel")}
            hint={t("settings.general.enforceDefaultsHint")}
            value={settings.values.enforceMemberDefaultsOnCreate}
            disabled={settings.saving}
            onValueChange={(enforceMemberDefaultsOnCreate) =>
              void saveImmediate({ enforceMemberDefaultsOnCreate })
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Section 2: Excluded Directories */}
      <SettingsSection title={t("settings.sections.excludedDirs")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.excludedDirs.listLabel")}
            hint={t("settings.excludedDirs.listHint")}
          >
            {draft.excludedDirectories.length === 0 ? (
              <Text style={styles.mutedText}>
                {t("settings.excludedDirs.empty")}
              </Text>
            ) : (
              <View style={styles.dirList}>
                {draft.excludedDirectories.map((dir) => (
                  <View key={dir} style={styles.dirRow}>
                    <View style={styles.dirLeft}>
                      <Icon
                        name="FolderX"
                        size={15}
                        color={theme.colors.foregroundMuted}
                      />
                      <Text style={styles.dirText}>{dir}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => handleRemoveExcludedDir(dir)}
                      style={styles.chipBtn}
                    >
                      <Icon
                        name="Trash2"
                        size={13}
                        color={theme.colors.statusDanger}
                      />
                      <Text style={styles.chipBtnTextDanger}>
                        {t("settings.excludedDirs.removeAction")}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
          </SettingsRow>

          <SettingsRow
            label={t("settings.excludedDirs.inputLabel")}
            hint={t("settings.excludedDirs.inputHint")}
          >
            <View style={styles.inlineInputRow}>
              <TextInput
                value={newDirInput}
                placeholder={t("settings.excludedDirs.inputPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.textInput, styles.flexInput]}
                onChangeText={setNewDirInput}
                onSubmitEditing={() => handleAddExcludedDir(newDirInput)}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!newDirInput.trim()}
                onPress={() => handleAddExcludedDir(newDirInput)}
                style={[
                  styles.chipBtn,
                  styles.chipBtnPrimary,
                  !newDirInput.trim() ? styles.chipBtnDisabled : null,
                ]}
              >
                <Icon
                  name="Plus"
                  size={14}
                  color={theme.colors.accentForeground}
                />
                <Text style={styles.chipBtnTextPrimary}>
                  {t("settings.excludedDirs.addAction")}
                </Text>
              </Pressable>
            </View>
          </SettingsRow>

          <SettingsAction
            label={t("settings.excludedDirs.quickDownloadsLabel")}
            hint={
              catalog?.homeDir
                ? t("settings.excludedDirs.quickDownloadsHint", {
                    resolved: `${catalog.homeDir}/Downloads`,
                  })
                : t("settings.excludedDirs.quickDownloadsHintSimple")
            }
            actionLabel={
              downloadsExcluded
                ? t("settings.excludedDirs.quickDownloadsDone")
                : t("settings.excludedDirs.quickDownloadsAction")
            }
            disabled={downloadsExcluded}
            onPress={() => handleAddExcludedDir("~/Downloads")}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Section 3: Team Presets */}
      <SettingsSection title={t("settings.sections.presets")}>
        <SettingsCard>
          <SettingsSelect<Str>
            label={t("settings.presets.selectLabel")}
            hint={t("settings.presets.selectHint")}
            value={activePreset?.id ?? ""}
            options={presetOptions}
            onValueChange={setSelectedPresetId}
          />

          <SettingsRow label={activePreset?.name ?? ""}>
            <View style={styles.actionRow}>
              {activePreset?.id === draft.defaultPresetId ? (
                <View style={styles.successBadge}>
                  <Text style={styles.successBadgeText}>
                    {t("settings.presets.isDefaultBadge")}
                  </Text>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={handleSetDefaultPreset}
                  style={[styles.chipBtn, styles.chipBtnPrimary]}
                >
                  <Icon
                    name="Check"
                    size={13}
                    color={theme.colors.accentForeground}
                  />
                  <Text style={styles.chipBtnTextPrimary}>
                    {t("settings.presets.setDefaultAction")}
                  </Text>
                </Pressable>
              )}

              <Pressable
                accessibilityRole="button"
                onPress={handleCreatePreset}
                style={styles.chipBtn}
              >
                <Icon name="Plus" size={13} color={theme.colors.foreground} />
                <Text style={styles.chipBtnText}>
                  {t("settings.presets.newAction")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={handleDuplicatePreset}
                style={styles.chipBtn}
              >
                <Icon name="Copy" size={13} color={theme.colors.foreground} />
                <Text style={styles.chipBtnText}>
                  {t("settings.presets.duplicateAction")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={draft.presets.length <= 1}
                onPress={handleDeletePreset}
                style={[
                  styles.chipBtn,
                  styles.chipBtnDanger,
                  draft.presets.length <= 1 ? styles.chipBtnDisabled : null,
                ]}
              >
                <Icon
                  name="Trash2"
                  size={13}
                  color={theme.colors.statusDanger}
                />
                <Text style={styles.chipBtnTextDanger}>
                  {t("settings.presets.deleteAction")}
                </Text>
              </Pressable>
            </View>
          </SettingsRow>

          {activePreset ? (
            <>
              <SettingsRow label={t("settings.presets.nameLabel")}>
                <TextInput
                  value={activePreset.name}
                  placeholder={t("settings.presets.namePlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.textInput}
                  onChangeText={(name) => patchActivePreset({ name })}
                />
              </SettingsRow>

              <SettingsRow label={t("settings.presets.descriptionLabel")}>
                <TextInput
                  value={activePreset.description}
                  placeholder={t("settings.presets.descriptionPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.textInput}
                  onChangeText={(description) =>
                    patchActivePreset({ description })
                  }
                />
              </SettingsRow>

              <SettingsSwitch
                label={t("settings.presets.noDirectEditLabel")}
                hint={t("settings.presets.noDirectEditHint")}
                value={activePreset.commanderNoDirectEdit}
                onValueChange={(commanderNoDirectEdit) =>
                  patchActivePreset({ commanderNoDirectEdit })
                }
              />

              <SettingsRow
                label={t("settings.presets.extraInstructionsLabel")}
                hint={t("settings.presets.extraInstructionsHint")}
              >
                <TextInput
                  value={activePreset.commanderExtraInstructions}
                  placeholder={t("settings.presets.extraInstructionsPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline={true}
                  style={[styles.textInput, styles.multilineInput]}
                  onChangeText={(commanderExtraInstructions) =>
                    patchActivePreset({ commanderExtraInstructions })
                  }
                />
              </SettingsRow>
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {/* Section 4: Team Members */}
      <SettingsSection title={t("settings.sections.members")}>
        <SettingsCard>
          <SettingsAction
            label={t("settings.members.catalogStatusLabel")}
            hint={
              catalogLoading
                ? t("settings.members.catalogLoading")
                : catalogError
                  ? t("settings.members.catalogError", { error: catalogError })
                  : catalog
                    ? t("settings.members.catalogReady", {
                        count: catalog.providers.length,
                      })
                    : t("settings.members.catalogLoading")
            }
            actionLabel={t("settings.members.refreshCatalogAction")}
            disabled={catalogLoading}
            onPress={() => void loadCatalog(true)}
          />

          <View style={styles.memberList}>
            {!activePreset || activePreset.members.length === 0 ? (
              <Text style={styles.mutedText}>{t("settings.members.empty")}</Text>
            ) : (
              activePreset.members.map((member) => (
                <View key={member.id} style={styles.memberCard}>
                  <View style={styles.memberHeader}>
                    <View style={styles.memberTitleRow}>
                      <Text style={styles.memberName}>{member.name}</Text>
                      <Text style={styles.memberRoleTag}>{member.roleId}</Text>
                      <View
                        style={
                          member.enabled
                            ? styles.successBadge
                            : styles.mutedBadge
                        }
                      >
                        <Text
                          style={
                            member.enabled
                              ? styles.successBadgeText
                              : styles.mutedBadgeText
                          }
                        >
                          {member.enabled
                            ? t("settings.members.enabledBadge")
                            : t("settings.members.optionalBadge")}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.memberActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("settings.members.toggleA11y", {
                          name: member.name,
                        })}
                        onPress={() =>
                          handleToggleMember(member.id, !member.enabled)
                        }
                        style={styles.chipBtn}
                      >
                        <Text style={styles.chipBtnText}>
                          {member.enabled
                            ? t("settings.members.disableAction")
                            : t("settings.members.enableAction")}
                        </Text>
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          setEditingMember(member);
                          setMemberModalOpen(true);
                        }}
                        style={styles.chipBtn}
                      >
                        <Icon
                          name="Pencil"
                          size={13}
                          color={theme.colors.foreground}
                        />
                        <Text style={styles.chipBtnText}>
                          {t("settings.members.editAction")}
                        </Text>
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        onPress={() => handleDeleteMember(member)}
                        style={[styles.chipBtn, styles.chipBtnDanger]}
                      >
                        <Icon
                          name="Trash2"
                          size={13}
                          color={theme.colors.statusDanger}
                        />
                        <Text style={styles.chipBtnTextDanger}>
                          {t("settings.members.deleteAction")}
                        </Text>
                      </Pressable>
                    </View>
                  </View>

                  <Text style={styles.memberSummary}>
                    {formatMemberSummary(member)}
                  </Text>

                  {member.responsibilities.trim() ? (
                    <Text style={styles.mutedText}>
                      {member.responsibilities.trim()}
                    </Text>
                  ) : null}
                </View>
              ))
            )}

            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setEditingMember(null);
                  setMemberModalOpen(true);
                }}
                style={[styles.chipBtn, styles.chipBtnPrimary]}
              >
                <Icon
                  name="Plus"
                  size={14}
                  color={theme.colors.accentForeground}
                />
                <Text style={styles.chipBtnTextPrimary}>
                  {t("settings.members.addRoleAction")}
                </Text>
              </Pressable>
            </View>
          </View>
        </SettingsCard>
      </SettingsSection>

      {/* Section 5: Live Commander Prompt Preview */}
      <SettingsSection title={t("settings.sections.preview")}>
        <SettingsCard>
          <Pressable
            accessibilityRole="button"
            onPress={() => setPreviewExpanded((open) => !open)}
            style={styles.previewHeaderBtn}
          >
            <View style={styles.previewHeaderLeft}>
              <Icon
                name="Sparkles"
                size={16}
                color={theme.colors.accent}
              />
              <Text style={styles.previewHeaderTitle}>
                {previewExpanded
                  ? t("settings.preview.toggleHide")
                  : t("settings.preview.toggleShow")}
              </Text>
            </View>
            <Icon
              name={previewExpanded ? "ChevronDown" : "ChevronRight"}
              size={16}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>

          {previewExpanded ? (
            <View style={styles.previewBody}>
              <View style={styles.previewToolbar}>
                <Text style={styles.mutedText}>
                  {previewLoading
                    ? t("settings.preview.loadingHint")
                    : previewText === null
                      ? t("settings.preview.fallbackHint")
                      : activePreset?.name ?? ""}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleCopyPreview()}
                  style={styles.chipBtn}
                >
                  <Icon name="Copy" size={13} color={theme.colors.foreground} />
                  <Text style={styles.chipBtnText}>
                    {t("settings.preview.copyAction")}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.previewMarkdownBox}>
                <Markdown>{displayedPreview}</Markdown>
              </View>
            </View>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {/* Section 6: Save / Discard / Reset */}
      <SettingsSection title={t("settings.sections.actions")}>
        <SettingsCard>
          {isDraftDirty ? (
            <SettingsRow label={t("settings.actions.unsavedHint")}>
              <Text style={styles.warningText}>
                {t("settings.actions.saveHint")}
              </Text>
            </SettingsRow>
          ) : null}

          <SettingsAction
            label={t("settings.actions.saveLabel")}
            hint={t("settings.actions.saveHint")}
            actionLabel={t("settings.actions.saveAction")}
            disabled={settings.saving || !isDraftDirty}
            onPress={() => void handleSaveDraft()}
          />

          {isDraftDirty ? (
            <SettingsAction
              label={t("settings.actions.discardLabel")}
              actionLabel={t("settings.actions.discardAction")}
              disabled={settings.saving}
              onPress={handleDiscardDraft}
            />
          ) : null}

          <SettingsAction
            label={t("settings.resetLabel")}
            hint={t("settings.resetHint")}
            actionLabel={t("settings.resetAction")}
            disabled={settings.saving}
            onPress={() => void handleResetDefaults()}
          />
        </SettingsCard>

        {settings.saveError ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {settings.saveError}
          </Text>
        ) : null}
      </SettingsSection>

      <MemberEditorModal
        open={memberModalOpen}
        initialMember={editingMember}
        existingMembers={activePreset?.members ?? EMPTY_MEMBERS}
        providers={catalog?.providers ?? EMPTY_PROVIDERS}
        theme={theme}
        layout={layout}
        onClose={() => {
          setMemberModalOpen(false);
          setEditingMember(null);
        }}
        onSave={handleSaveMember}
      />
    </View>
  );
}

export function TeamSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const settings = useSettings(teamSettings);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        errorText: {
          color: theme.colors.statusDanger,
          fontSize: 13,
        },
      }),
    [theme],
  );

  if (settings.status === "loading") {
    return (
      <SettingsSection title={t("settings.title")}>
        <SettingsCard>
          <SettingsRow label={t("settings.loading")} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("settings.title")}>
        <SettingsCard>
          <SettingsRow label={t("settings.loadError")}>
            <Text style={styles.errorText}>{settings.error}</Text>
          </SettingsRow>
          <SettingsAction
            label={t("settings.reloadLabel")}
            actionLabel={t("settings.reloadAction")}
            disabled={settings.saving}
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label={t("settings.resetLabel")}
              actionLabel={t("settings.resetAction")}
              disabled={settings.saving}
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <ReadyTeamSettingsContent
      settings={settings}
      theme={theme}
      layout={layout}
    />
  );
}

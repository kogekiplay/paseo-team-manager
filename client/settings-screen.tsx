import {
  useRpc,
  useSettings,
  useTranslation,
  type PluginScreenProps,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  Markdown,
  ScrollView,
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
  resolvePresetMembers,
  type ResolvedTeamMember,
} from "../shared/catalog-defaults.ts";
import {
  getProviderCatalogRpc,
  previewCommanderPromptRpc,
  type ProviderCatalogEntry,
  type ProviderCatalogOutput,
} from "../shared/contracts.ts";
import { buildCommanderPrompt } from "../shared/prompt-builder.ts";
import {
  AUTO_PROVIDER,
  formatProviderModel,
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
  applyResolvedFallbackToMember,
  createNewPreset,
  deleteMember,
  deletePreset,
  duplicatePreset,
  formatMemberSummary,
  hasExcludedDirectory,
  lockPresetMembersToHost,
  normalizeExcludedDirectories,
  removeExcludedDirectory,
  setAllPresetMembersAuto,
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
type SetTimeoutFn = typeof setTimeout;
type TimerHandle = ReturnType<SetTimeoutFn> | null;
type SaveResolver = (ok: Bool) => void;
type AsyncBool = Promise<Bool>;

interface QueuedSave {
  readonly values: TeamSettingsValues;
  readonly resolvers: SaveResolver[];
}

const EMPTY_PROVIDERS: readonly ProviderCatalogEntry[] = [];
const EMPTY_MEMBERS: readonly TeamMember[] = [];
const TEXT_AUTOSAVE_DEBOUNCE_MS = 500;
const REVISION_WAIT_FALLBACK_MS = 250;

function cloneSettingsValues(values: TeamSettingsValues): TeamSettingsValues {
  return {
    ...values,
    excludedDirectories: [...values.excludedDirectories],
    presets: values.presets.map((preset) => ({
      ...preset,
      members: preset.members.map((member) => ({
        ...member,
        features: { ...member.features },
      })),
    })),
    workspaceOverrides: { ...values.workspaceOverrides },
  };
}

function prepareSettingsForSave(
  values: TeamSettingsValues,
  homeDir?: Str,
): TeamSettingsValues | null {
  if (values.presets.some((preset) => preset.name.trim() === "")) {
    return null;
  }
  const normalizedDirs = normalizeExcludedDirectories(
    values.excludedDirectories,
    homeDir,
  );
  const validDefault = values.presets.some(
    (item) => item.id === values.defaultPresetId,
  )
    ? values.defaultPresetId
    : values.presets[0].id;
  return {
    ...values,
    excludedDirectories: normalizedDirs,
    defaultPresetId: validDefault,
    presets: values.presets.map((preset) => ({
      ...preset,
      name: preset.name.trim(),
    })),
  };
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
  const { t, locale } = useTranslation(messages);
  const toast = useToast();

  const fetchProviderCatalog = useRpc(getProviderCatalogRpc);
  const fetchPromptPreview = useRpc(previewCommanderPromptRpc);

  useEffect(() => {
    syncSettingsSnapshot(settings.values, settings.revision);
  }, [settings.values, settings.revision]);

  const [localValues, setLocalValues] = useState<TeamSettingsValues>(() =>
    cloneSettingsValues(settings.values),
  );
  const localValuesRef = useRef<TeamSettingsValues>(localValues);
  const settingsRef = useRef<ReadySettings>(settings);
  settingsRef.current = settings;

  const [selectedPresetId, setSelectedPresetId] = useState<Str>(
    () => settings.values.defaultPresetId || settings.values.presets[0]?.id || "",
  );
  const [newDirInput, setNewDirInput] = useState<Str>("");

  const [catalog, setCatalog] = useState<NullableCatalog>(null);
  const [catalogLoading, setCatalogLoading] = useState<Bool>(false);
  const [catalogError, setCatalogError] = useState<NullableStr>(null);
  const catalogHomeDirRef = useRef<Str | undefined>(undefined);
  catalogHomeDirRef.current = catalog?.homeDir;

  const [memberModalOpen, setMemberModalOpen] = useState<Bool>(false);
  const [editingMember, setEditingMember] = useState<NullableMember>(null);

  const [previewExpanded, setPreviewExpanded] = useState<Bool>(false);
  const [previewText, setPreviewText] = useState<NullableStr>(null);
  const [previewLoading, setPreviewLoading] = useState<Bool>(false);
  const previewReqRef = useRef(0);

  const [autoSaving, setAutoSaving] = useState<Bool>(false);
  const [localSaveError, setLocalSaveError] = useState<NullableStr>(null);

  const inFlightRef = useRef<Bool>(false);
  const awaitingRevisionFromRef = useRef<NullableStr>(null);
  const pendingSaveRef = useRef<QueuedSave | null>(null);
  const debounceTimerRef = useRef<TimerHandle>(null);
  const revisionFallbackTimerRef = useRef<TimerHandle>(null);
  const lastSyncedRevisionRef = useRef<Str>(settings.revision);
  const mountedRef = useRef<Bool>(true);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearRevisionFallbackTimer = useCallback(() => {
    if (revisionFallbackTimerRef.current !== null) {
      clearTimeout(revisionFallbackTimerRef.current);
      revisionFallbackTimerRef.current = null;
    }
  }, []);

  const peekPendingSave = useCallback(
    (): QueuedSave | null => pendingSaveRef.current,
    [],
  );

  const flushQueue = useCallback(async () => {
    if (inFlightRef.current || awaitingRevisionFromRef.current !== null) {
      return;
    }
    const nextQueued = pendingSaveRef.current;
    if (!nextQueued) {
      if (mountedRef.current) setAutoSaving(false);
      return;
    }
    pendingSaveRef.current = null;

    const prepared = prepareSettingsForSave(
      nextQueued.values,
      catalogHomeDirRef.current,
    );
    if (!prepared) {
      for (const resolve of nextQueued.resolvers) resolve(false);
      if (mountedRef.current) setAutoSaving(false);
      return;
    }

    inFlightRef.current = true;
    if (mountedRef.current) {
      setAutoSaving(true);
      setLocalSaveError(null);
    }

    const revBefore = settingsRef.current.revision;
    const ok = await settingsRef.current.save(prepared, revBefore);
    inFlightRef.current = false;

    if (ok) {
      for (const resolve of nextQueued.resolvers) resolve(true);
      if (peekPendingSave() !== null) {
        if (settingsRef.current.revision !== revBefore) {
          void flushQueue();
        } else {
          awaitingRevisionFromRef.current = revBefore;
          clearRevisionFallbackTimer();
          revisionFallbackTimerRef.current = setTimeout(() => {
            revisionFallbackTimerRef.current = null;
            if (awaitingRevisionFromRef.current === revBefore) {
              awaitingRevisionFromRef.current = null;
              void flushQueue();
            }
          }, REVISION_WAIT_FALLBACK_MS);
        }
      } else if (mountedRef.current) {
        setAutoSaving(false);
      }
      return;
    }

    const errMsg = settingsRef.current.saveError ?? t("settings.loadError");
    if (mountedRef.current) {
      setLocalSaveError(errMsg);
      toast.error(t("settings.saveFailedToast", { error: errMsg }));
      setAutoSaving(false);
    }
    for (const resolve of nextQueued.resolvers) resolve(false);
    const dropped = peekPendingSave();
    if (dropped !== null) {
      pendingSaveRef.current = null;
      for (const resolve of dropped.resolvers) resolve(false);
    }
    void settingsRef.current.reload();
  }, [clearRevisionFallbackTimer, peekPendingSave, toast, t]);

  const enqueueSave = useCallback(
    (values: TeamSettingsValues): AsyncBool =>
      new Promise<Bool>((resolve) => {
        const existingResolvers = pendingSaveRef.current?.resolvers ?? [];
        pendingSaveRef.current = {
          values,
          resolvers: [...existingResolvers, resolve],
        };
        if (mountedRef.current) setAutoSaving(true);
        void flushQueue();
      }),
    [flushQueue],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearRevisionFallbackTimer();
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        void enqueueSave(localValuesRef.current);
      }
    };
  }, [clearRevisionFallbackTimer, enqueueSave]);

  useEffect(() => {
    if (settings.revision === lastSyncedRevisionRef.current) return;
    lastSyncedRevisionRef.current = settings.revision;

    if (awaitingRevisionFromRef.current !== null) {
      awaitingRevisionFromRef.current = null;
      clearRevisionFallbackTimer();
      if (pendingSaveRef.current !== null) {
        void flushQueue();
        return;
      }
    }

    if (
      !inFlightRef.current &&
      pendingSaveRef.current === null &&
      debounceTimerRef.current === null
    ) {
      const synced = cloneSettingsValues(settings.values);
      localValuesRef.current = synced;
      setLocalValues(synced);
      setSelectedPresetId((current) =>
        synced.presets.some((item) => item.id === current)
          ? current
          : synced.defaultPresetId || synced.presets[0]?.id || "",
      );
    }
  }, [settings.revision, settings.values, clearRevisionFallbackTimer, flushQueue]);

  const activePreset = useMemo(
    () =>
      localValues.presets.find((item) => item.id === selectedPresetId) ??
      localValues.presets[0],
    [localValues.presets, selectedPresetId],
  );

  useEffect(() => {
    if (activePreset && activePreset.id !== selectedPresetId) {
      setSelectedPresetId(activePreset.id);
    }
  }, [activePreset, selectedPresetId]);

  const hasEmptyPresetName = useMemo(
    () => localValues.presets.some((item) => item.name.trim() === ""),
    [localValues.presets],
  );

  const activePresetNameEmpty = Boolean(
    activePreset && activePreset.name.trim() === "",
  );

  const commitImmediate = useCallback(
    async (
      updater: (current: TeamSettingsValues) => TeamSettingsValues,
    ): AsyncBool => {
      clearDebounceTimer();
      const next = updater(localValuesRef.current);
      localValuesRef.current = next;
      setLocalValues(next);
      if (next.presets.some((item) => item.name.trim() === "")) {
        toast.error(t("settings.presets.nameEmptyError"));
        return false;
      }
      return enqueueSave(next);
    },
    [clearDebounceTimer, enqueueSave, toast, t],
  );

  const updateTextField = useCallback(
    (updater: (current: TeamSettingsValues) => TeamSettingsValues) => {
      const next = updater(localValuesRef.current);
      localValuesRef.current = next;
      setLocalValues(next);
      clearDebounceTimer();
      if (next.presets.some((item) => item.name.trim() === "")) {
        return;
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void enqueueSave(localValuesRef.current);
      }, TEXT_AUTOSAVE_DEBOUNCE_MS);
    },
    [clearDebounceTimer, enqueueSave],
  );

  const flushTextOnBlur = useCallback(() => {
    if (debounceTimerRef.current === null) return;
    clearDebounceTimer();
    const current = localValuesRef.current;
    if (current.presets.some((item) => item.name.trim() === "")) {
      return;
    }
    void enqueueSave(current);
  }, [clearDebounceTimer, enqueueSave]);

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

  const resolvedPresetResult = useMemo(
    () =>
      activePreset
        ? resolvePresetMembers(activePreset, catalog?.providers ?? EMPTY_PROVIDERS)
        : null,
    [activePreset, catalog?.providers],
  );

  const resolvedByMemberId = useMemo(() => {
    const map = new Map<Str, ResolvedTeamMember>();
    if (resolvedPresetResult) {
      for (const item of resolvedPresetResult.resolved) {
        map.set(item.configured.id, item);
      }
    }
    return map;
  }, [resolvedPresetResult]);

  const hasLockableMembers = useMemo(
    () =>
      Boolean(
        resolvedPresetResult?.resolved.some(
          (item) =>
            item.status === "auto-matched" || item.status === "fallback-host",
        ),
      ),
    [resolvedPresetResult],
  );

  const hasNonAutoMembers = useMemo(
    () =>
      Boolean(
        activePreset?.members.some(
          (member) =>
            member.provider !== AUTO_PROVIDER ||
            member.model !== "" ||
            member.thinkingOptionId !== "" ||
            member.modeId !== "" ||
            Object.keys(member.features).length > 0,
        ),
      ),
    [activePreset],
  );

  const localFallbackPreview = useMemo(
    () =>
      activePreset
        ? buildCommanderPrompt({
            preset: activePreset,
            resolvedMembers: resolvedPresetResult?.resolved,
          })
        : "",
    [activePreset, resolvedPresetResult],
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

  const handleResetDefaults = useCallback(async () => {
    clearDebounceTimer();
    clearRevisionFallbackTimer();
    awaitingRevisionFromRef.current = null;
    if (pendingSaveRef.current) {
      const dropped = pendingSaveRef.current;
      pendingSaveRef.current = null;
      for (const resolve of dropped.resolvers) resolve(false);
    }
    setLocalSaveError(null);
    const ok = await settings.reset();
    if (ok) {
      toast.show(t("settings.resetSuccessToast"), { variant: "success" });
    } else if (settings.saveError) {
      toast.error(t("settings.saveFailedToast", { error: settings.saveError }));
    }
  }, [clearDebounceTimer, clearRevisionFallbackTimer, settings, toast, t]);

  const handleAddExcludedDir = useCallback(
    async (rawPath: Str) => {
      const trimmed = rawPath.trim();
      if (!trimmed) return;
      if (
        hasExcludedDirectory(
          localValuesRef.current.excludedDirectories,
          trimmed,
          catalogHomeDirRef.current,
        )
      ) {
        toast.show(t("settings.excludedDirs.alreadyExcludedToast"), {
          variant: "info",
        });
        return;
      }
      const ok = await commitImmediate((current) => ({
        ...current,
        excludedDirectories: addExcludedDirectory(
          current.excludedDirectories,
          trimmed,
          catalogHomeDirRef.current,
        ),
      }));
      if (ok) {
        if (rawPath === newDirInput) {
          setNewDirInput("");
        }
        toast.show(t("settings.excludedDirs.addedToast", { dir: trimmed }), {
          variant: "success",
        });
      }
    },
    [commitImmediate, newDirInput, toast, t],
  );

  const handleRemoveExcludedDir = useCallback(
    async (dir: Str) => {
      await commitImmediate((current) => ({
        ...current,
        excludedDirectories: removeExcludedDirectory(
          current.excludedDirectories,
          dir,
          catalogHomeDirRef.current,
        ),
      }));
    },
    [commitImmediate],
  );

  const handleCreatePreset = useCallback(async () => {
    const { presets, created } = createNewPreset(
      localValuesRef.current.presets,
      t("settings.presets.newPresetBaseName"),
    );
    const ok = await commitImmediate((current) => ({ ...current, presets }));
    if (ok) {
      setSelectedPresetId(created.id);
      toast.show(t("settings.presets.createdToast", { name: created.name }), {
        variant: "success",
      });
    }
  }, [commitImmediate, toast, t]);

  const handleDuplicatePreset = useCallback(async () => {
    if (!activePreset) return;
    const duplicated = duplicatePreset(
      localValuesRef.current.presets,
      activePreset.id,
      t("settings.presets.duplicateSuffix"),
    );
    if (!duplicated) return;
    const ok = await commitImmediate((current) => ({
      ...current,
      presets: duplicated.presets,
    }));
    if (ok) {
      setSelectedPresetId(duplicated.created.id);
      toast.show(
        t("settings.presets.duplicatedToast", { name: duplicated.created.name }),
        { variant: "success" },
      );
    }
  }, [activePreset, commitImmediate, toast, t]);

  const handleDeletePreset = useCallback(async () => {
    if (!activePreset) return;
    if (localValuesRef.current.presets.length <= 1) {
      toast.show(t("settings.presets.cannotDeleteLastToast"), {
        variant: "warning",
      });
      return;
    }
    const deletedName = activePreset.name;
    const nextSettings = deletePreset(localValuesRef.current, activePreset.id);
    const ok = await commitImmediate(() => nextSettings);
    if (ok) {
      setSelectedPresetId(nextSettings.defaultPresetId);
      toast.show(t("settings.presets.deletedToast", { name: deletedName }), {
        variant: "success",
      });
    }
  }, [activePreset, commitImmediate, toast, t]);

  const handleSetDefaultPreset = useCallback(async () => {
    if (!activePreset) return;
    await commitImmediate((current) => ({
      ...current,
      defaultPresetId: activePreset.id,
    }));
  }, [activePreset, commitImmediate]);

  const handleSaveMember = useCallback(
    async (member: TeamMember): AsyncBool => {
      if (!activePreset) return false;
      if (localValuesRef.current.presets.some((item) => item.name.trim() === "")) {
        toast.error(t("settings.presets.nameEmptyError"));
        return false;
      }
      const previous = localValuesRef.current;
      const ok = await commitImmediate((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id ? upsertMember(preset, member) : preset,
        ),
      }));
      if (ok) {
        setMemberModalOpen(false);
        setEditingMember(null);
        toast.show(t("settings.members.savedToast", { name: member.name }), {
          variant: "success",
        });
        return true;
      }
      localValuesRef.current = previous;
      setLocalValues(previous);
      return false;
    },
    [activePreset, commitImmediate, toast, t],
  );

  const handleToggleMember = useCallback(
    async (memberId: Str, enabled: Bool) => {
      if (!activePreset) return;
      await commitImmediate((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id
            ? toggleMemberEnabled(preset, memberId, enabled)
            : preset,
        ),
      }));
    },
    [activePreset, commitImmediate],
  );

  const handleDeleteMember = useCallback(
    async (member: TeamMember) => {
      if (!activePreset) return;
      const ok = await commitImmediate((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id
            ? deleteMember(preset, member.id)
            : preset,
        ),
      }));
      if (ok) {
        toast.show(t("settings.members.removedToast", { name: member.name }), {
          variant: "success",
        });
      }
    },
    [activePreset, commitImmediate, toast, t],
  );

  const handleApplyFallback = useCallback(
    async (resolved: ResolvedTeamMember) => {
      if (!activePreset) return;
      const ok = await commitImmediate((current) => ({
        ...current,
        presets: current.presets.map((preset) =>
          preset.id === activePreset.id
            ? applyResolvedFallbackToMember(preset, resolved)
            : preset,
        ),
      }));
      if (ok) {
        toast.show(
          t("settings.members.appliedFallbackToast", {
            name: resolved.configured.name,
          }),
          { variant: "success" },
        );
      }
    },
    [activePreset, commitImmediate, toast, t],
  );

  const handleLockHostDefaults = useCallback(async () => {
    if (!activePreset || !catalog) return;
    const { preset: lockedPreset, lockedCount } = lockPresetMembersToHost(
      activePreset,
      catalog.providers,
    );
    if (lockedCount === 0) return;
    const ok = await commitImmediate((current) => ({
      ...current,
      presets: current.presets.map((preset) =>
        preset.id === activePreset.id ? lockedPreset : preset,
      ),
    }));
    if (ok) {
      toast.show(t("settings.members.lockedHostToast", { count: lockedCount }), {
        variant: "success",
      });
    }
  }, [activePreset, catalog, commitImmediate, toast, t]);

  const handleSetAllAuto = useCallback(async () => {
    if (!activePreset) return;
    const ok = await commitImmediate((current) => ({
      ...current,
      presets: current.presets.map((preset) =>
        preset.id === activePreset.id
          ? setAllPresetMembersAuto(preset)
          : preset,
      ),
    }));
    if (ok) {
      toast.show(t("settings.members.setAllAutoToast"), { variant: "success" });
    }
  }, [activePreset, commitImmediate, toast, t]);

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
      localValues.presets.map((preset) => ({
        value: preset.id,
        label:
          preset.id === localValues.defaultPresetId
            ? `${preset.name} ${t("settings.presets.defaultTag")}`
            : preset.name,
      })),
    [localValues.presets, localValues.defaultPresetId, t],
  );

  const downloadsExcluded = useMemo(
    () =>
      hasExcludedDirectory(
        localValues.excludedDirectories,
        "~/Downloads",
        catalog?.homeDir,
      ),
    [localValues.excludedDirectories, catalog?.homeDir],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          gap: layout.compact ? 16 : 20,
        },
        fieldBlock: {
          paddingHorizontal: layout.compact ? 14 : 16,
          paddingVertical: 12,
          gap: 8,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        fieldBlockFirst: {
          borderTopWidth: 0,
        },
        fieldHeader: {
          gap: 2,
        },
        fieldLabel: {
          color: theme.colors.foreground,
          fontSize: 13.5,
          fontWeight: "500",
        },
        fieldHint: {
          color: theme.colors.foregroundMuted,
          fontSize: 12,
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
        fullWidthInput: {
          width: "100%",
        },
        descriptionInput: {
          width: "100%",
          minHeight: 76,
          textAlignVertical: "top",
        },
        extraInstructionsInput: {
          width: "100%",
          minHeight: 112,
          textAlignVertical: "top",
        },
        inlineInputRow: {
          flexDirection: layout.compact ? "column" : "row",
          gap: 8,
          alignItems: layout.compact ? "stretch" : "center",
          width: "100%",
        },
        flexInput: {
          flex: 1,
        },
        actionRow: {
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          paddingTop: 2,
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
          paddingHorizontal: 10,
          paddingVertical: 4,
          alignSelf: "center",
          alignItems: "center",
          justifyContent: "center",
        },
        successBadgeText: {
          color: theme.colors.statusSuccess,
          fontSize: 11.5,
          fontWeight: "600",
        },
        accentBadge: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.accent,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
          alignSelf: "center",
          alignItems: "center",
          justifyContent: "center",
        },
        accentBadgeText: {
          color: theme.colors.accent,
          fontSize: 11.5,
          fontWeight: "600",
        },
        mutedBadge: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 4,
          alignSelf: "center",
          alignItems: "center",
          justifyContent: "center",
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
            value={localValues.enabled}
            onValueChange={(enabled) =>
              void commitImmediate((current) => ({ ...current, enabled }))
            }
          />
          <SettingsSwitch
            label={t("settings.general.autoApplyLabel")}
            hint={t("settings.general.autoApplyHint")}
            value={localValues.autoApplyToNewTopLevelAgents}
            onValueChange={(autoApplyToNewTopLevelAgents) =>
              void commitImmediate((current) => ({
                ...current,
                autoApplyToNewTopLevelAgents,
              }))
            }
          />
          <SettingsSwitch
            label={t("settings.general.showComposerLabel")}
            hint={t("settings.general.showComposerHint")}
            value={localValues.showComposerControl}
            onValueChange={(showComposerControl) =>
              void commitImmediate((current) => ({
                ...current,
                showComposerControl,
              }))
            }
          />
          <SettingsSwitch
            label={t("settings.general.enforceDefaultsLabel")}
            hint={t("settings.general.enforceDefaultsHint")}
            value={localValues.enforceMemberDefaultsOnCreate}
            onValueChange={(enforceMemberDefaultsOnCreate) =>
              void commitImmediate((current) => ({
                ...current,
                enforceMemberDefaultsOnCreate,
              }))
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Section 2: Excluded Directories */}
      <SettingsSection title={t("settings.sections.excludedDirs")}>
        <SettingsCard>
          <View style={[styles.fieldBlock, styles.fieldBlockFirst]}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>
                {t("settings.excludedDirs.listLabel")}
              </Text>
              <Text style={styles.fieldHint}>
                {t("settings.excludedDirs.listHint")}
              </Text>
            </View>
            {localValues.excludedDirectories.length === 0 ? (
              <Text style={styles.mutedText}>
                {t("settings.excludedDirs.empty")}
              </Text>
            ) : (
              <View style={styles.dirList}>
                {localValues.excludedDirectories.map((dir) => (
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
                      onPress={() => void handleRemoveExcludedDir(dir)}
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
          </View>

          <View style={styles.fieldBlock}>
            <View style={styles.fieldHeader}>
              <Text style={styles.fieldLabel}>
                {t("settings.excludedDirs.inputLabel")}
              </Text>
              <Text style={styles.fieldHint}>
                {t("settings.excludedDirs.inputHint")}
              </Text>
            </View>
            <View style={styles.inlineInputRow}>
              <TextInput
                value={newDirInput}
                placeholder={t("settings.excludedDirs.inputPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.textInput, styles.flexInput]}
                onChangeText={setNewDirInput}
                onSubmitEditing={() => void handleAddExcludedDir(newDirInput)}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!newDirInput.trim()}
                onPress={() => void handleAddExcludedDir(newDirInput)}
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
          </View>

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
            onPress={() => void handleAddExcludedDir("~/Downloads")}
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

          <View style={styles.fieldBlock}>
            {activePreset?.name ? (
              <Text style={styles.fieldLabel}>{activePreset.name}</Text>
            ) : null}
            <View style={styles.actionRow}>
              {activePreset?.id === localValues.defaultPresetId ? (
                <View style={styles.successBadge}>
                  <Text style={styles.successBadgeText}>
                    {t("settings.presets.isDefaultBadge")}
                  </Text>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleSetDefaultPreset()}
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
                onPress={() => void handleCreatePreset()}
                style={styles.chipBtn}
              >
                <Icon name="Plus" size={13} color={theme.colors.foreground} />
                <Text style={styles.chipBtnText}>
                  {t("settings.presets.newAction")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                onPress={() => void handleDuplicatePreset()}
                style={styles.chipBtn}
              >
                <Icon name="Copy" size={13} color={theme.colors.foreground} />
                <Text style={styles.chipBtnText}>
                  {t("settings.presets.duplicateAction")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={localValues.presets.length <= 1}
                onPress={() => void handleDeletePreset()}
                style={[
                  styles.chipBtn,
                  styles.chipBtnDanger,
                  localValues.presets.length <= 1 ? styles.chipBtnDisabled : null,
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
          </View>

          {activePreset ? (
            <>
              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>
                  {t("settings.presets.nameLabel")}
                </Text>
                <TextInput
                  value={activePreset.name}
                  placeholder={t("settings.presets.namePlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={[styles.textInput, styles.fullWidthInput]}
                  onChangeText={(name) =>
                    updateTextField((current) => ({
                      ...current,
                      presets: updatePreset(current.presets, activePreset.id, {
                        name,
                      }),
                    }))
                  }
                  onBlur={flushTextOnBlur}
                />
                {activePresetNameEmpty ? (
                  <Text accessibilityRole="alert" style={styles.errorText}>
                    {t("settings.presets.nameEmptyError")}
                  </Text>
                ) : null}
              </View>

              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>
                  {t("settings.presets.descriptionLabel")}
                </Text>
                <TextInput
                  value={activePreset.description}
                  placeholder={t("settings.presets.descriptionPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline={true}
                  numberOfLines={3}
                  style={[styles.textInput, styles.descriptionInput]}
                  onChangeText={(description) =>
                    updateTextField((current) => ({
                      ...current,
                      presets: updatePreset(current.presets, activePreset.id, {
                        description,
                      }),
                    }))
                  }
                  onBlur={flushTextOnBlur}
                />
              </View>

              <SettingsSwitch
                label={t("settings.presets.noDirectEditLabel")}
                hint={t("settings.presets.noDirectEditHint")}
                value={activePreset.commanderNoDirectEdit}
                onValueChange={(commanderNoDirectEdit) =>
                  void commitImmediate((current) => ({
                    ...current,
                    presets: updatePreset(current.presets, activePreset.id, {
                      commanderNoDirectEdit,
                    }),
                  }))
                }
              />

              <View style={styles.fieldBlock}>
                <View style={styles.fieldHeader}>
                  <Text style={styles.fieldLabel}>
                    {t("settings.presets.extraInstructionsLabel")}
                  </Text>
                  <Text style={styles.fieldHint}>
                    {t("settings.presets.extraInstructionsHint")}
                  </Text>
                </View>
                <TextInput
                  value={activePreset.commanderExtraInstructions}
                  placeholder={t("settings.presets.extraInstructionsPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  multiline={true}
                  numberOfLines={4}
                  style={[styles.textInput, styles.extraInstructionsInput]}
                  onChangeText={(commanderExtraInstructions) =>
                    updateTextField((current) => ({
                      ...current,
                      presets: updatePreset(current.presets, activePreset.id, {
                        commanderExtraInstructions,
                      }),
                    }))
                  }
                  onBlur={flushTextOnBlur}
                />
              </View>
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
              activePreset.members.map((member) => {
                const resolved = resolvedByMemberId.get(member.id);
                const isAuto = member.provider === AUTO_PROVIDER;
                return (
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
                        {isAuto ? (
                          <View style={styles.accentBadge}>
                            <Text style={styles.accentBadgeText}>
                              {t("settings.members.autoBadge")}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={styles.memberActions}>
                        {resolved?.status === "fallback-host" ? (
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => void handleApplyFallback(resolved)}
                            style={[styles.chipBtn, styles.chipBtnPrimary]}
                          >
                            <Icon
                              name="Check"
                              size={13}
                              color={theme.colors.accentForeground}
                            />
                            <Text style={styles.chipBtnTextPrimary}>
                              {t("settings.members.applyFallbackAction")}
                            </Text>
                          </Pressable>
                        ) : null}

                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={t("settings.members.toggleA11y", {
                            name: member.name,
                          })}
                          onPress={() =>
                            void handleToggleMember(member.id, !member.enabled)
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
                          onPress={() => void handleDeleteMember(member)}
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

                    {isAuto ? (
                      resolved?.status === "auto-matched" ? (
                        <Text style={styles.memberSummary}>
                          {t("settings.members.autoMatchedSummary", {
                            summary: formatMemberSummary(
                              resolved.member,
                              locale,
                            ),
                          })}
                        </Text>
                      ) : (
                        <Text style={styles.mutedText}>
                          {catalogLoading
                            ? t("settings.members.autoResolving")
                            : t("settings.members.autoUnresolved")}
                        </Text>
                      )
                    ) : (
                      <>
                        <Text style={styles.memberSummary}>
                          {formatMemberSummary(member, locale)}
                        </Text>
                        {resolved?.status === "fallback-host" ? (
                          <Text style={styles.warningText}>
                            {t("settings.members.fallbackHostWarning", {
                              configured: formatProviderModel(
                                member.provider,
                                member.model,
                              ),
                              fallback: formatMemberSummary(
                                resolved.member,
                                locale,
                              ),
                            })}
                          </Text>
                        ) : resolved?.status === "unresolved" &&
                          !catalogLoading &&
                          (catalog?.providers.length ?? 0) > 0 ? (
                          <Text style={styles.warningText}>
                            {t("settings.members.unresolvedWarning")}
                          </Text>
                        ) : null}
                      </>
                    )}

                    {member.responsibilities.trim() ? (
                      <Text style={styles.mutedText}>
                        {member.responsibilities.trim()}
                      </Text>
                    ) : null}
                  </View>
                );
              })
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

              <Pressable
                accessibilityRole="button"
                disabled={catalogLoading || !hasLockableMembers}
                onPress={() => void handleLockHostDefaults()}
                style={[
                  styles.chipBtn,
                  catalogLoading || !hasLockableMembers
                    ? styles.chipBtnDisabled
                    : null,
                ]}
              >
                <Icon name="Check" size={13} color={theme.colors.foreground} />
                <Text style={styles.chipBtnText}>
                  {t("settings.members.lockHostAction")}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={!hasNonAutoMembers}
                onPress={() => void handleSetAllAuto()}
                style={[
                  styles.chipBtn,
                  !hasNonAutoMembers ? styles.chipBtnDisabled : null,
                ]}
              >
                <Icon
                  name="Sparkles"
                  size={13}
                  color={theme.colors.foreground}
                />
                <Text style={styles.chipBtnText}>
                  {t("settings.members.setAllAutoAction")}
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

      {/* Section 6: Auto-save Status & Reset */}
      <SettingsSection title={t("settings.sections.actions")}>
        <SettingsCard>
          <SettingsRow label={t("settings.actions.autoSaveLabel")}>
            {hasEmptyPresetName ? (
              <Text style={styles.warningText}>
                {t("settings.actions.autoSavePausedEmptyName")}
              </Text>
            ) : autoSaving || settings.saving ? (
              <Text style={styles.mutedText}>
                {t("settings.actions.autoSaveSaving")}
              </Text>
            ) : (
              <Text style={styles.mutedText}>
                {t("settings.actions.autoSaveIdle")}
              </Text>
            )}
          </SettingsRow>

          <SettingsAction
            label={t("settings.resetLabel")}
            hint={t("settings.resetHint")}
            actionLabel={t("settings.resetAction")}
            disabled={settings.saving || autoSaving}
            onPress={() => void handleResetDefaults()}
          />
        </SettingsCard>

        {localSaveError || settings.saveError ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {localSaveError ?? settings.saveError}
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

export function TeamMainScreen({
  theme,
  layout,
  host,
  navigation,
}: PluginScreenProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.surface0,
        },
        content: {
          padding: layout.compact ? 16 : 24,
        },
        inner: {
          maxWidth: 860,
          width: "100%",
          alignSelf: "center",
        },
      }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.inner}>
        <TeamSettingsScreen
          theme={theme}
          layout={layout}
          host={host}
          navigation={navigation}
        />
      </View>
    </ScrollView>
  );
}

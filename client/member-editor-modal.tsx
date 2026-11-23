import {
  useRpc,
  useTranslation,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  isHighCostModelId,
  resolveRoleFromCatalog,
  resolveTeamMember,
} from "../shared/catalog-defaults.ts";
import {
  getProviderControlsRpc,
  type ProviderCatalogControl,
  type ProviderCatalogEntry,
  type ProviderCatalogModel,
} from "../shared/contracts.ts";
import { TEAM_MANAGER_ICON } from "../shared/icon.ts";
import {
  AUTO_PROVIDER,
  TeamMemberSchema,
  type FeatureValue,
  type TeamMember,
} from "../shared/settings.ts";
import { messages } from "./messages.ts";
import {
  formatMemberSummary,
  generateUniqueId,
  isValidRoleId,
  localizeModeLabel,
  localizeProviderControl,
  localizeThinkingLabel,
  slugifyIdentifier,
} from "./team-state.ts";

type Str = string;
type Bool = boolean;
type NullableStr = Str | null;
type FeatureMap = Record<Str, FeatureValue>;
type FeatureDefaultMap = Record<Str, FeatureValue | null>;
type ControlList = readonly ProviderCatalogControl[];
type AsyncSaveResult = Promise<Bool>;

interface MemberDraft {
  readonly id: Str;
  readonly roleId: Str;
  readonly name: Str;
  readonly enabled: Bool;
  readonly provider: Str;
  readonly model: Str;
  readonly thinkingOptionId: Str;
  readonly modeId: Str;
  readonly features: FeatureMap;
  readonly responsibilities: Str;
  readonly rolePrompt: Str;
}

export interface MemberEditorModalProps {
  readonly open: Bool;
  readonly initialMember: TeamMember | null;
  readonly existingMembers: readonly TeamMember[];
  readonly providers: readonly ProviderCatalogEntry[];
  readonly theme: PluginSurfaceProps["theme"];
  readonly layout: PluginSurfaceProps["layout"];
  readonly onClose: () => void;
  readonly onSave: (member: TeamMember) => AsyncSaveResult;
}

const EMPTY_OPTION_VALUE = "__default__";

function isModelSelectable(model: ProviderCatalogModel): Bool {
  return (model as ProviderCatalogModel & { readonly isSelectable?: Bool }).isSelectable !== false;
}

function getSelectableModels(entry: ProviderCatalogEntry | undefined): ProviderCatalogModel[] {
  if (!entry) return [];
  return entry.models.filter(isModelSelectable);
}

function pickDefaultModel(entry: ProviderCatalogEntry | undefined): ProviderCatalogModel | undefined {
  const selectable = getSelectableModels(entry);
  const affordable = selectable.filter((item) => !isHighCostModelId(item.id));
  const pool = affordable.length > 0 ? affordable : selectable;
  return pool.find((item) => item.isDefault) ?? pool[0];
}

function pickDefaultMode(entry: ProviderCatalogEntry | undefined): Str {
  if (!entry) return "full-access";
  if (entry.defaultModeId) return entry.defaultModeId;
  const fullAccess = entry.modes.find((mode) => mode.id === "full-access");
  if (fullAccess) return fullAccess.id;
  return entry.modes[0]?.id ?? "";
}

function pickDefaultThinking(
  providerId: Str,
  model: ProviderCatalogModel | undefined,
): Str {
  if (
    providerId === "codex" &&
    model?.thinkingOptions.some((opt) => opt.id === "xhigh")
  ) {
    return "xhigh";
  }
  return model?.defaultThinkingOptionId ?? "";
}

function pickDefaultFeatures(entry: ProviderCatalogEntry | undefined): FeatureMap {
  if (!entry) return {};
  const supportsDefaultServiceTier = entry.controls.some(
    (control) =>
      control.type === "select" &&
      control.key === "service_tier" &&
      control.choices.some((choice) => choice.value === "default"),
  );
  return supportsDefaultServiceTier ? { service_tier: "default" } : {};
}

function buildInitialDraft(
  initialMember: TeamMember | null,
): MemberDraft {
  if (initialMember) {
    return {
      id: initialMember.id,
      roleId: initialMember.roleId,
      name: initialMember.name,
      enabled: initialMember.enabled,
      provider: initialMember.provider,
      model: initialMember.model,
      thinkingOptionId: initialMember.thinkingOptionId,
      modeId: initialMember.modeId,
      features: { ...initialMember.features },
      responsibilities: initialMember.responsibilities,
      rolePrompt: initialMember.rolePrompt,
    };
  }

  return {
    id: "",
    roleId: "",
    name: "",
    enabled: true,
    provider: AUTO_PROVIDER,
    model: "",
    thinkingOptionId: "",
    modeId: "",
    features: {},
    responsibilities: "",
    rolePrompt: "",
  };
}

export function MemberEditorModal({
  open,
  initialMember,
  existingMembers,
  providers,
  theme,
  layout,
  onClose,
  onSave,
}: MemberEditorModalProps) {
  const { t, locale } = useTranslation(messages);
  const fetchProviderControls = useRpc(getProviderControlsRpc);

  const [draft, setDraft] = useState<MemberDraft>(() =>
    buildInitialDraft(initialMember),
  );
  const [roleIdTouched, setRoleIdTouched] = useState<Bool>(Boolean(initialMember));
  const [nameError, setNameError] = useState<NullableStr>(null);
  const [roleIdError, setRoleIdError] = useState<NullableStr>(null);
  const [providerError, setProviderError] = useState<NullableStr>(null);
  const [modelError, setModelError] = useState<NullableStr>(null);

  const [controls, setControls] = useState<ControlList>([]);
  const [controlDefaults, setControlDefaults] = useState<FeatureDefaultMap>({});
  const [controlsLoading, setControlsLoading] = useState<Bool>(false);
  const [controlsError, setControlsError] = useState<NullableStr>(null);
  const [submitting, setSubmitting] = useState<Bool>(false);
  const controlsRequestRef = useRef(0);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setDraft(buildInitialDraft(initialMember));
    setRoleIdTouched(Boolean(initialMember));
    setNameError(null);
    setRoleIdError(null);
    setProviderError(null);
    setModelError(null);
    setControls([]);
    setControlDefaults({});
    setControlsError(null);
    setSubmitting(false);
  }, [open, initialMember]);

  const isAutoProvider = draft.provider === AUTO_PROVIDER;

  const autoResolvedPreview = useMemo(() => {
    if (!isAutoProvider) return null;
    const previewMember: TeamMember = {
      id: draft.id || "preview",
      roleId: draft.roleId.trim() || "custom",
      name: draft.name.trim() || "Role",
      enabled: draft.enabled,
      provider: AUTO_PROVIDER,
      model: "",
      thinkingOptionId: draft.thinkingOptionId.trim(),
      modeId: draft.modeId.trim(),
      features: {},
      responsibilities: "",
      rolePrompt: "",
    };
    return resolveTeamMember(previewMember, providers);
  }, [
    isAutoProvider,
    draft.id,
    draft.roleId,
    draft.name,
    draft.enabled,
    draft.thinkingOptionId,
    draft.modeId,
    providers,
  ]);

  const effectiveProviderId = isAutoProvider
    ? (autoResolvedPreview?.status === "auto-matched"
        ? autoResolvedPreview.member.provider
        : "")
    : draft.provider;

  const effectiveModelId = isAutoProvider
    ? (autoResolvedPreview?.status === "auto-matched"
        ? autoResolvedPreview.member.model
        : "")
    : draft.model;

  const selectedProviderEntry = useMemo(
    () => providers.find((item) => item.provider === effectiveProviderId),
    [providers, effectiveProviderId],
  );

  const selectableModels = useMemo(
    () => getSelectableModels(selectedProviderEntry),
    [selectedProviderEntry],
  );

  const selectedModelEntry = useMemo(
    () => selectableModels.find((item) => item.id === effectiveModelId),
    [selectableModels, effectiveModelId],
  );

  useEffect(() => {
    if (!open || isAutoProvider || !draft.provider.trim()) {
      setControls([]);
      setControlDefaults({});
      setControlsLoading(false);
      setControlsError(null);
      return;
    }
    const reqId = controlsRequestRef.current + 1;
    controlsRequestRef.current = reqId;
    setControlsLoading(true);
    setControlsError(null);

    void fetchProviderControls({
      provider: draft.provider,
      model: draft.model.trim() || undefined,
      modeId: draft.modeId.trim() || undefined,
    })
      .then((result) => {
        if (controlsRequestRef.current !== reqId) return;
        setControls(result.controls);
        setControlDefaults(result.defaults);
        setControlsError(result.error);
      })
      .catch((error: unknown) => {
        if (controlsRequestRef.current !== reqId) return;
        setControls(selectedProviderEntry?.controls ?? []);
        setControlDefaults({});
        setControlsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (controlsRequestRef.current === reqId) {
          setControlsLoading(false);
        }
      });
  }, [
    open,
    isAutoProvider,
    draft.provider,
    draft.model,
    draft.modeId,
    fetchProviderControls,
    selectedProviderEntry,
  ]);

  const providerOptions = useMemo(() => {
    const list = [
      { value: AUTO_PROVIDER, label: t("memberModal.providerAuto") },
      ...providers.map((entry) => ({
        value: entry.provider,
        label:
          entry.enabled && entry.status === "ready"
            ? entry.label
            : t("memberModal.providerUnavailable", { label: entry.label }),
      })),
    ];
    if (
      draft.provider &&
      draft.provider !== AUTO_PROVIDER &&
      !list.some((item) => item.value === draft.provider)
    ) {
      list.push({
        value: draft.provider,
        label: t("memberModal.providerUnavailable", { label: draft.provider }),
      });
    }
    return list;
  }, [providers, draft.provider, t]);

  const modelOptions = useMemo(() => {
    const list = selectableModels.map((item) => ({
      value: item.id,
      label: item.label || item.id,
    }));
    if (draft.model && !list.some((item) => item.value === draft.model)) {
      list.unshift({
        value: draft.model,
        label: t("memberModal.modelUnavailable", { label: draft.model }),
      });
    }
    return list;
  }, [selectableModels, draft.model, t]);

  const thinkingOptions = useMemo(() => {
    const base = [
      { value: EMPTY_OPTION_VALUE, label: t("memberModal.thinkingDefault") },
    ];
    const fromModel = (selectedModelEntry?.thinkingOptions ?? []).map((item) => ({
      value: item.id,
      label: localizeThinkingLabel(item.id, item.label || item.id, locale),
    }));
    const list = [...base, ...fromModel];
    if (
      draft.thinkingOptionId &&
      !list.some((item) => item.value === draft.thinkingOptionId)
    ) {
      list.push({
        value: draft.thinkingOptionId,
        label: localizeThinkingLabel(
          draft.thinkingOptionId,
          draft.thinkingOptionId,
          locale,
        ),
      });
    }
    return list;
  }, [selectedModelEntry, draft.thinkingOptionId, locale, t]);

  const modeOptions = useMemo(() => {
    const base = [
      { value: EMPTY_OPTION_VALUE, label: t("memberModal.modeDefault") },
    ];
    const fromProvider = (selectedProviderEntry?.modes ?? []).map((item) => ({
      value: item.id,
      label: localizeModeLabel(item.id, item.label || item.id, locale),
    }));
    const list = [...base, ...fromProvider];
    if (draft.modeId && !list.some((item) => item.value === draft.modeId)) {
      list.push({
        value: draft.modeId,
        label: localizeModeLabel(draft.modeId, draft.modeId, locale),
      });
    }
    return list;
  }, [selectedProviderEntry, draft.modeId, locale, t]);

  const handleProviderChange = useCallback(
    (nextProvider: Str) => {
      setProviderError(null);
      setModelError(null);
      if (nextProvider === AUTO_PROVIDER) {
        setDraft((current) => ({
          ...current,
          provider: AUTO_PROVIDER,
          model: "",
          thinkingOptionId: "",
          modeId: "",
          features: {},
        }));
        return;
      }
      const nextEntry = providers.find((item) => item.provider === nextProvider);
      setDraft((current) => {
        const resolvedForProvider = nextEntry
          ? resolveRoleFromCatalog(current.roleId.trim() || "custom", [nextEntry])
          : null;
        if (resolvedForProvider) {
          return {
            ...current,
            provider: nextProvider,
            model: resolvedForProvider.model,
            thinkingOptionId: resolvedForProvider.thinkingOptionId,
            modeId: resolvedForProvider.modeId,
            features: { ...resolvedForProvider.features },
          };
        }
        const nextDefaultModel = pickDefaultModel(nextEntry);
        return {
          ...current,
          provider: nextProvider,
          model: nextDefaultModel?.id ?? "",
          thinkingOptionId: pickDefaultThinking(nextProvider, nextDefaultModel),
          modeId: pickDefaultMode(nextEntry),
          features: pickDefaultFeatures(nextEntry),
        };
      });
    },
    [providers],
  );

  const handleModelChange = useCallback(
    (nextModelId: Str) => {
      setModelError(null);
      const nextModel = selectableModels.find((item) => item.id === nextModelId);
      setDraft((current) => {
        const validThinking =
          current.thinkingOptionId &&
          nextModel?.thinkingOptions.some(
            (opt) => opt.id === current.thinkingOptionId,
          );
        return {
          ...current,
          model: nextModelId,
          thinkingOptionId: validThinking
            ? current.thinkingOptionId
            : (nextModel?.defaultThinkingOptionId ?? ""),
        };
      });
    },
    [selectableModels],
  );

  const handleFeatureChange = useCallback((key: Str, value: FeatureValue | null) => {
    setDraft((current) => {
      const nextFeatures: FeatureMap = { ...current.features };
      if (value === null) {
        delete nextFeatures[key];
      } else {
        nextFeatures[key] = value;
      }
      return {
        ...current,
        features: nextFeatures,
      };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (submitting) return;
    const trimmedName = draft.name.trim();
    const trimmedRoleId = draft.roleId.trim();
    const trimmedProvider = draft.provider.trim();
    const trimmedModel = draft.model.trim();

    let hasError = false;
    if (!trimmedName) {
      setNameError(t("memberModal.nameRequired"));
      hasError = true;
    } else {
      setNameError(null);
    }

    if (!isValidRoleId(trimmedRoleId)) {
      setRoleIdError(t("memberModal.roleIdInvalid"));
      hasError = true;
    } else {
      const duplicate = existingMembers.some(
        (member) =>
          member.id !== initialMember?.id &&
          member.roleId.toLowerCase() === trimmedRoleId.toLowerCase(),
      );
      if (duplicate) {
        setRoleIdError(t("memberModal.roleIdDuplicate"));
        hasError = true;
      } else {
        setRoleIdError(null);
      }
    }

    if (!trimmedProvider) {
      setProviderError(t("memberModal.providerRequired"));
      hasError = true;
    } else {
      setProviderError(null);
    }

    if (trimmedProvider !== AUTO_PROVIDER && !trimmedModel) {
      setModelError(t("memberModal.modelRequired"));
      hasError = true;
    } else {
      setModelError(null);
    }

    if (hasError) return;

    const finalId =
      initialMember?.id ||
      generateUniqueId(
        trimmedRoleId,
        existingMembers.map((item) => item.id),
      );

    const isAuto = trimmedProvider === AUTO_PROVIDER;
    const parsed = TeamMemberSchema.parse({
      id: finalId,
      roleId: trimmedRoleId,
      name: trimmedName,
      enabled: draft.enabled,
      provider: trimmedProvider,
      model: isAuto ? "" : trimmedModel,
      thinkingOptionId: draft.thinkingOptionId.trim(),
      modeId: draft.modeId.trim(),
      features: isAuto ? {} : draft.features,
      responsibilities: draft.responsibilities,
      rolePrompt: draft.rolePrompt,
    });

    setSubmitting(true);
    try {
      await onSave(parsed);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, draft, existingMembers, initialMember, onSave, t]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          gap: layout.compact ? 14 : 16,
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
        fieldLabel: {
          color: theme.colors.foreground,
          fontSize: 13.5,
          fontWeight: "500",
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
        rowTextInput: {
          minWidth: layout.compact ? undefined : 220,
        },
        multilineInput: {
          width: "100%",
          minHeight: layout.compact ? 76 : 84,
          textAlignVertical: "top",
        },
        promptInput: {
          width: "100%",
          minHeight: layout.compact ? 96 : 112,
          textAlignVertical: "top",
        },
        autoPreviewBox: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.accent,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 11,
          paddingVertical: 9,
          gap: 4,
        },
        autoPreviewLabel: {
          color: theme.colors.accent,
          fontSize: 12,
          fontWeight: "600",
        },
        autoPreviewText: {
          color: theme.colors.foreground,
          fontSize: 12.5,
        },
        mutedText: {
          color: theme.colors.foregroundMuted,
          fontSize: 12.5,
        },
        errorText: {
          color: theme.colors.statusDanger,
          fontSize: 12.5,
        },
        controlsHeader: {
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "600",
        },
        footerRow: {
          flexDirection: layout.compact ? "column-reverse" : "row",
          justifyContent: "flex-end",
          gap: 10,
          paddingTop: 4,
        },
        primaryBtn: {
          backgroundColor: theme.colors.accent,
          borderRadius: 8,
          paddingHorizontal: 16,
          paddingVertical: 10,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 6,
        },
        primaryBtnText: {
          color: theme.colors.accentForeground,
          fontSize: 13.5,
          fontWeight: "600",
        },
        primaryBtnDisabled: {
          opacity: 0.55,
        },
        secondaryBtn: {
          backgroundColor: theme.colors.surface2,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 16,
          paddingVertical: 10,
          alignItems: "center",
          justifyContent: "center",
        },
        secondaryBtnText: {
          color: theme.colors.foreground,
          fontSize: 13.5,
          fontWeight: "500",
        },
      }),
    [theme, layout.compact],
  );

  return (
    <Modal
      title={initialMember ? t("memberModal.editTitle") : t("memberModal.addTitle")}
      icon={<Icon icon={TEAM_MANAGER_ICON} size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <SettingsCard>
            <SettingsRow label={t("memberModal.nameLabel")} error={nameError}>
              <TextInput
                value={draft.name}
                placeholder={t("memberModal.namePlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={[styles.textInput, styles.rowTextInput]}
                onChangeText={(name) => {
                  setNameError(null);
                  setDraft((current) => {
                    if (!roleIdTouched && !initialMember) {
                      const suggested = slugifyIdentifier(name, "");
                      return { ...current, name, roleId: suggested };
                    }
                    return { ...current, name };
                  });
                }}
              />
            </SettingsRow>

            <SettingsRow
              label={t("memberModal.roleIdLabel")}
              hint={t("memberModal.roleIdHint")}
              error={roleIdError}
            >
              <TextInput
                value={draft.roleId}
                placeholder={t("memberModal.roleIdPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.textInput, styles.rowTextInput]}
                onChangeText={(roleId) => {
                  setRoleIdTouched(true);
                  setRoleIdError(null);
                  setDraft((current) => ({ ...current, roleId }));
                }}
              />
            </SettingsRow>

            <SettingsSwitch
              label={t("memberModal.enabledLabel")}
              hint={t("memberModal.enabledHint")}
              value={draft.enabled}
              onValueChange={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))
              }
            />
          </SettingsCard>

          <SettingsCard>
            {providerOptions.length > 0 ? (
              <SettingsSelect<Str>
                label={t("memberModal.providerLabel")}
                error={providerError}
                value={draft.provider}
                options={providerOptions}
                onValueChange={handleProviderChange}
              />
            ) : (
              <SettingsRow
                label={t("memberModal.providerLabel")}
                error={providerError}
              >
                <TextInput
                  value={draft.provider}
                  placeholder={t("memberModal.providerPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.textInput}
                  onChangeText={handleProviderChange}
                />
              </SettingsRow>
            )}

            {isAutoProvider ? (
              <View style={styles.fieldBlock}>
                <View style={styles.autoPreviewBox}>
                  <Text style={styles.autoPreviewLabel}>
                    {t("memberModal.autoPreviewLabel")}
                  </Text>
                  <Text style={styles.autoPreviewText}>
                    {autoResolvedPreview?.status === "auto-matched"
                      ? t("memberModal.autoPreviewMatched", {
                          summary: formatMemberSummary(
                            autoResolvedPreview.member,
                            locale,
                          ),
                        })
                      : t("memberModal.autoPreviewUnresolved")}
                  </Text>
                </View>
              </View>
            ) : modelOptions.length > 0 ? (
              <SettingsSelect<Str>
                label={t("memberModal.modelLabel")}
                error={modelError}
                value={draft.model}
                options={modelOptions}
                onValueChange={handleModelChange}
              />
            ) : (
              <SettingsRow label={t("memberModal.modelLabel")} error={modelError}>
                <TextInput
                  value={draft.model}
                  placeholder="auto/gpt-6.2-sol"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.textInput}
                  onChangeText={handleModelChange}
                />
              </SettingsRow>
            )}

            <SettingsSelect<Str>
              label={t("memberModal.thinkingLabel")}
              value={draft.thinkingOptionId || EMPTY_OPTION_VALUE}
              options={thinkingOptions}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  thinkingOptionId: value === EMPTY_OPTION_VALUE ? "" : value,
                }))
              }
            />

            <SettingsSelect<Str>
              label={t("memberModal.modeLabel")}
              value={draft.modeId || EMPTY_OPTION_VALUE}
              options={modeOptions}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  modeId: value === EMPTY_OPTION_VALUE ? "" : value,
                }))
              }
            />
          </SettingsCard>

          {!isAutoProvider && (controlsLoading || controlsError || controls.length > 0) ? (
            <SettingsCard>
              <SettingsRow label={t("memberModal.controlsTitle")}>
                {controlsLoading ? (
                  <Text style={styles.mutedText}>
                    {t("memberModal.controlsLoading")}
                  </Text>
                ) : controlsError ? (
                  <Text style={styles.errorText}>
                    {t("memberModal.controlsError", { error: controlsError })}
                  </Text>
                ) : null}
              </SettingsRow>

              {controls.map((rawControl) => {
                const control = localizeProviderControl(rawControl, locale);
                if (control.type === "toggle") {
                  const rawValue = draft.features[control.key];
                  const fallbackDefault =
                    typeof controlDefaults[control.key] === "boolean"
                      ? Boolean(controlDefaults[control.key])
                      : Boolean(control.defaultValue);
                  const checked =
                    typeof rawValue === "boolean" ? rawValue : fallbackDefault;
                  return (
                    <SettingsSwitch
                      key={control.key}
                      label={control.label}
                      hint={control.description}
                      value={checked}
                      onValueChange={(value) =>
                        handleFeatureChange(control.key, value)
                      }
                    />
                  );
                }

                const rawValue = draft.features[control.key];
                const defaultVal =
                  typeof controlDefaults[control.key] === "string"
                    ? String(controlDefaults[control.key])
                    : (control.defaultValue ?? "");
                const effectiveVal =
                  typeof rawValue === "string"
                    ? rawValue
                    : defaultVal || EMPTY_OPTION_VALUE;

                const choiceOptions = [
                  ...(defaultVal
                    ? []
                    : [
                        {
                          value: EMPTY_OPTION_VALUE,
                          label: t("memberModal.controlsDefaultOption"),
                        },
                      ]),
                  ...control.choices.map((choice) => ({
                    value: choice.value,
                    label: choice.label,
                  })),
                ];
                if (
                  effectiveVal !== EMPTY_OPTION_VALUE &&
                  !choiceOptions.some((item) => item.value === effectiveVal)
                ) {
                  choiceOptions.push({
                    value: effectiveVal,
                    label: effectiveVal,
                  });
                }

                return (
                  <SettingsSelect<Str>
                    key={control.key}
                    label={control.label}
                    hint={control.description}
                    value={effectiveVal}
                    options={choiceOptions}
                    onValueChange={(value) =>
                      handleFeatureChange(
                        control.key,
                        value === EMPTY_OPTION_VALUE ? null : value,
                      )
                    }
                  />
                );
              })}
            </SettingsCard>
          ) : null}

          <SettingsCard>
            <View style={[styles.fieldBlock, styles.fieldBlockFirst]}>
              <Text style={styles.fieldLabel}>
                {t("memberModal.responsibilitiesLabel")}
              </Text>
              <TextInput
                value={draft.responsibilities}
                placeholder={t("memberModal.responsibilitiesPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline={true}
                numberOfLines={3}
                style={[styles.textInput, styles.multilineInput]}
                onChangeText={(responsibilities) =>
                  setDraft((current) => ({ ...current, responsibilities }))
                }
              />
            </View>

            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>
                {t("memberModal.rolePromptLabel")}
              </Text>
              <TextInput
                value={draft.rolePrompt}
                placeholder={t("memberModal.rolePromptPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline={true}
                numberOfLines={4}
                style={[styles.textInput, styles.promptInput]}
                onChangeText={(rolePrompt) =>
                  setDraft((current) => ({ ...current, rolePrompt }))
                }
              />
            </View>
          </SettingsCard>

          <View style={styles.footerRow}>
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              onPress={onClose}
              style={[
                styles.secondaryBtn,
                submitting ? styles.primaryBtnDisabled : null,
              ]}
            >
              <Text style={styles.secondaryBtnText}>
                {t("memberModal.cancelAction")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={submitting}
              onPress={() => void handleSave()}
              style={[
                styles.primaryBtn,
                submitting ? styles.primaryBtnDisabled : null,
              ]}
            >
              <Icon
                name="Check"
                size={15}
                color={theme.colors.accentForeground}
              />
              <Text style={styles.primaryBtnText}>
                {submitting
                  ? t("memberModal.savingAction")
                  : t("memberModal.saveAction")}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

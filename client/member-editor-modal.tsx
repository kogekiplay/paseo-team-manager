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
  getProviderControlsRpc,
  type ProviderCatalogControl,
  type ProviderCatalogEntry,
  type ProviderCatalogModel,
} from "../shared/contracts.ts";
import {
  TeamMemberSchema,
  type FeatureValue,
  type TeamMember,
} from "../shared/settings.ts";
import { messages } from "./messages.ts";
import {
  generateUniqueId,
  isValidRoleId,
  slugifyIdentifier,
} from "./team-state.ts";

type Str = string;
type Bool = boolean;
type NullableStr = Str | null;
type FeatureMap = Record<Str, FeatureValue>;
type FeatureDefaultMap = Record<Str, FeatureValue | null>;
type ControlList = readonly ProviderCatalogControl[];

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
  readonly onSave: (member: TeamMember) => void;
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
  return selectable.find((item) => item.isDefault) ?? selectable[0];
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

function pickDefaultFeatures(providerId: Str): FeatureMap {
  return providerId === "codex" ? { service_tier: "default" } : {};
}

function buildInitialDraft(
  initialMember: TeamMember | null,
  providers: readonly ProviderCatalogEntry[],
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

  const readyProvider =
    providers.find((item) => item.enabled && item.status === "ready") ??
    providers[0];
  const providerId = readyProvider?.provider ?? "antigravity";
  const defaultModel = pickDefaultModel(readyProvider);
  return {
    id: "",
    roleId: "",
    name: "",
    enabled: true,
    provider: providerId,
    model: defaultModel?.id ?? "",
    thinkingOptionId: pickDefaultThinking(providerId, defaultModel),
    modeId: pickDefaultMode(readyProvider),
    features: pickDefaultFeatures(providerId),
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
  const { t } = useTranslation(messages);
  const fetchProviderControls = useRpc(getProviderControlsRpc);

  const [draft, setDraft] = useState<MemberDraft>(() =>
    buildInitialDraft(initialMember, providers),
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
  const controlsRequestRef = useRef(0);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setDraft(buildInitialDraft(initialMember, providers));
    setRoleIdTouched(Boolean(initialMember));
    setNameError(null);
    setRoleIdError(null);
    setProviderError(null);
    setModelError(null);
    setControls([]);
    setControlDefaults({});
    setControlsError(null);
  }, [open, initialMember, providers]);

  const selectedProviderEntry = useMemo(
    () => providers.find((item) => item.provider === draft.provider),
    [providers, draft.provider],
  );

  const selectableModels = useMemo(
    () => getSelectableModels(selectedProviderEntry),
    [selectedProviderEntry],
  );

  const selectedModelEntry = useMemo(
    () => selectableModels.find((item) => item.id === draft.model),
    [selectableModels, draft.model],
  );

  useEffect(() => {
    if (!open || !draft.provider.trim()) return;
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
    draft.provider,
    draft.model,
    draft.modeId,
    fetchProviderControls,
    selectedProviderEntry,
  ]);

  const providerOptions = useMemo(() => {
    const list = providers.map((entry) => ({
      value: entry.provider,
      label:
        entry.enabled && entry.status === "ready"
          ? entry.label
          : t("memberModal.providerUnavailable", { label: entry.label }),
    }));
    if (
      draft.provider &&
      !list.some((item) => item.value === draft.provider)
    ) {
      list.unshift({
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
      label: item.label || item.id,
    }));
    const list = [...base, ...fromModel];
    if (
      draft.thinkingOptionId &&
      !list.some((item) => item.value === draft.thinkingOptionId)
    ) {
      list.push({
        value: draft.thinkingOptionId,
        label: draft.thinkingOptionId,
      });
    }
    return list;
  }, [selectedModelEntry, draft.thinkingOptionId, t]);

  const modeOptions = useMemo(() => {
    const base = [
      { value: EMPTY_OPTION_VALUE, label: t("memberModal.modeDefault") },
    ];
    const fromProvider = (selectedProviderEntry?.modes ?? []).map((item) => ({
      value: item.id,
      label: item.label || item.id,
    }));
    const list = [...base, ...fromProvider];
    if (draft.modeId && !list.some((item) => item.value === draft.modeId)) {
      list.push({
        value: draft.modeId,
        label: draft.modeId,
      });
    }
    return list;
  }, [selectedProviderEntry, draft.modeId, t]);

  const handleProviderChange = useCallback(
    (nextProvider: Str) => {
      setProviderError(null);
      setModelError(null);
      const nextEntry = providers.find((item) => item.provider === nextProvider);
      const nextDefaultModel = pickDefaultModel(nextEntry);
      setDraft((current) => ({
        ...current,
        provider: nextProvider,
        model: nextDefaultModel?.id ?? "",
        thinkingOptionId: pickDefaultThinking(nextProvider, nextDefaultModel),
        modeId: pickDefaultMode(nextEntry),
        features: pickDefaultFeatures(nextProvider),
      }));
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

  const handleSave = useCallback(() => {
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

    if (!trimmedModel) {
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

    const parsed = TeamMemberSchema.parse({
      id: finalId,
      roleId: trimmedRoleId,
      name: trimmedName,
      enabled: draft.enabled,
      provider: trimmedProvider,
      model: trimmedModel,
      thinkingOptionId: draft.thinkingOptionId.trim(),
      modeId: draft.modeId.trim(),
      features: draft.features,
      responsibilities: draft.responsibilities,
      rolePrompt: draft.rolePrompt,
    });
    onSave(parsed);
  }, [draft, existingMembers, initialMember, onSave, t]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: {
          gap: layout.compact ? 14 : 16,
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
          minHeight: layout.compact ? 72 : 84,
          textAlignVertical: "top",
        },
        promptInput: {
          minHeight: layout.compact ? 96 : 112,
          textAlignVertical: "top",
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
      icon={<Icon name="Users" size={18} color={theme.colors.foreground} />}
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
                style={styles.textInput}
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
                style={styles.textInput}
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

            {modelOptions.length > 0 ? (
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

          {(controlsLoading || controlsError || controls.length > 0) ? (
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

              {controls.map((control) => {
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
            <SettingsRow label={t("memberModal.responsibilitiesLabel")}>
              <TextInput
                value={draft.responsibilities}
                placeholder={t("memberModal.responsibilitiesPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline={true}
                style={[styles.textInput, styles.multilineInput]}
                onChangeText={(responsibilities) =>
                  setDraft((current) => ({ ...current, responsibilities }))
                }
              />
            </SettingsRow>

            <SettingsRow label={t("memberModal.rolePromptLabel")}>
              <TextInput
                value={draft.rolePrompt}
                placeholder={t("memberModal.rolePromptPlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline={true}
                style={[styles.textInput, styles.promptInput]}
                onChangeText={(rolePrompt) =>
                  setDraft((current) => ({ ...current, rolePrompt }))
                }
              />
            </SettingsRow>
          </SettingsCard>

          <View style={styles.footerRow}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>
                {t("memberModal.cancelAction")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleSave}
              style={styles.primaryBtn}
            >
              <Icon
                name="Check"
                size={15}
                color={theme.colors.accentForeground}
              />
              <Text style={styles.primaryBtnText}>
                {t("memberModal.saveAction")}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

import { useComposer, useTranslation } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { messages } from "./messages.ts";
import { useTeamSettingsStore } from "./settings-store.ts";
import {
  buildComposerMetadataPatch,
  COMPOSER_AUTO_VALUE,
  COMPOSER_OFF_VALUE,
  COMPOSER_PRESET_PREFIX,
  encodeComposerTeamValue,
  type ComposerTeamValue,
} from "./team-state.ts";

export function ComposerTeamControl() {
  const { t } = useTranslation(messages);
  const composer = useComposer();
  const { values, saving } = useTeamSettingsStore();

  const currentValue = useMemo(
    () => encodeComposerTeamValue(composer.agent.metadata, values.presets),
    [composer.agent.metadata, values.presets],
  );

  const defaultPreset = useMemo(
    () =>
      values.presets.find((item) => item.id === values.defaultPresetId) ??
      values.presets[0],
    [values.presets, values.defaultPresetId],
  );

  const options = useMemo(() => {
    const autoEnabled = values.enabled && values.autoApplyToNewTopLevelAgents;
    const autoDescription = autoEnabled && defaultPreset
      ? t("composer.autoDescDefault", { preset: defaultPreset.name })
      : t("composer.autoDescDisabled");

    const baseOptions: {
      readonly value: ComposerTeamValue;
      readonly label: string;
      readonly description: string;
    }[] = [
      {
        value: COMPOSER_AUTO_VALUE,
        label: t("composer.autoLabel"),
        description: autoDescription,
      },
      {
        value: COMPOSER_OFF_VALUE,
        label: t("composer.offLabel"),
        description: t("composer.offDesc"),
      },
    ];

    const presetOptions = values.presets.map((preset) => {
      const activeCount = preset.members.filter((member) => member.enabled).length;
      return {
        value: `${COMPOSER_PRESET_PREFIX}${preset.id}` as ComposerTeamValue,
        label: preset.name,
        description: t("composer.presetDesc", { count: activeCount }),
      };
    });

    return [...baseOptions, ...presetOptions];
  }, [values.enabled, values.autoApplyToNewTopLevelAgents, values.presets, defaultPreset, t]);

  const handleValueChange = useCallback(
    async ({ value }: { readonly value: ComposerTeamValue }) => {
      await composer.setMetadata(buildComposerMetadataPatch(value));
    },
    [composer],
  );

  return (
    <Select<ComposerTeamValue>
      title={t("composer.title")}
      icon="Users"
      value={currentValue}
      options={options}
      disabled={saving}
      onValueChange={handleValueChange}
    />
  );
}

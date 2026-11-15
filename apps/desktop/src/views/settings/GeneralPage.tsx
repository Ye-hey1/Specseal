// 一般页（desktop-settings-mode design D5；desktop-about-page design D7）：「语言与外观」卡（显示
// 语言列、外观列）与「键盘快捷键」卡。更新、CLI 与版本信息各在自己的分类页，这里不重复。
import { AlertTriangle } from "lucide-react";
import {
  Kbd,
  SEMANTIC_TONE,
  SettingsCard,
  SettingsChoice,
  SettingsPageHeader,
  SettingsRow,
  useI18n,
  type ThemePreference,
} from "@specseal/ui";

import { buildShortcutList } from "../../appMenu";
import type { LocalePreference } from "../../i18n/locale";
import type { Platform } from "../../platform";

/** 「跟随系统」在偏好里是 null，Radix Select 的值不接受空值：以哨兵值往返。 */
const FOLLOW_SYSTEM = "system";

function LocaleRow({
  localePref,
  onLocalePrefChange,
}: {
  localePref: LocalePreference;
  onLocalePrefChange: (pref: LocalePreference) => void;
}) {
  const { t } = useI18n();
  const label = t("settings.displayLanguage");
  return (
    <SettingsRow
      label={label}
      description={t("settings.uiLocaleHelp")}
      control={
        <SettingsChoice
          ariaLabel={label}
          value={localePref ?? FOLLOW_SYSTEM}
          options={[
            { value: FOLLOW_SYSTEM, label: t("settings.followSystem") },
            { value: "zh-CN", label: "繁体中文" },
            { value: "en", label: "English" },
          ]}
          onChange={(v) => onLocalePrefChange(v === "zh-CN" || v === "en" ? v : null)}
        />
      }
    />
  );
}

function ThemeRow({
  themePref,
  onThemePrefChange,
}: {
  themePref: ThemePreference;
  onThemePrefChange: (pref: ThemePreference) => void;
}) {
  const { t } = useI18n();
  const label = t("settings.appearance");
  return (
    <SettingsRow
      label={label}
      description={t("settings.appearanceHelp")}
      control={
        <SettingsChoice
          ariaLabel={label}
          value={themePref ?? FOLLOW_SYSTEM}
          options={[
            { value: FOLLOW_SYSTEM, label: t("settings.followSystem") },
            { value: "light", label: t("settings.theme.light") },
            { value: "dark", label: t("settings.theme.dark") },
          ]}
          onChange={(v) => onThemePrefChange(v === "light" || v === "dark" ? v : null)}
        />
      }
    />
  );
}

export interface InterfacePrefsProps {
  localePref: LocalePreference;
  onLocalePrefChange: (pref: LocalePreference) => void;
  themePref: ThemePreference;
  onThemePrefChange: (pref: ThemePreference) => void;
}

function TrayPanelError({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <p role="alert" className={`m-0 flex items-start gap-1.5 text-xs ${SEMANTIC_TONE.danger}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {t("settings.parseErrorHint")} {message}
      </span>
    </p>
  );
}

export interface GeneralPageProps extends InterfacePrefsProps {
  platform: Platform;
  trayPanelError?: string | null;
}

export function GeneralPage({
  platform,
  localePref,
  onLocalePrefChange,
  themePref,
  onThemePrefChange,
  trayPanelError,
}: GeneralPageProps) {
  const { t } = useI18n();
  return (
    <>
      <SettingsPageHeader title={t("settings.section.general")} note={t("settings.pageNote")} />
      <SettingsCard title={t("settings.interfaceCard")}>
        <LocaleRow localePref={localePref} onLocalePrefChange={onLocalePrefChange} />
        <ThemeRow themePref={themePref} onThemePrefChange={onThemePrefChange} />
      </SettingsCard>
      <SettingsCard title={t("settings.shortcutsTitle")}>
        {buildShortcutList({ t, platform }).map((row) => (
          <SettingsRow key={row.id} label={row.text} control={<Kbd>{row.keys}</Kbd>} />
        ))}
      </SettingsCard>
      {trayPanelError && <TrayPanelError message={trayPanelError} />}
    </>
  );
}

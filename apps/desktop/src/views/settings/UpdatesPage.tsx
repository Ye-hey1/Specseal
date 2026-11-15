// 更新页（desktop-settings-mode design D6；spec「桌面自动更新」「更新日志弹窗」）：页标题右侧
// 「检查更新」；版本卡（目前版本、最新版本＋状态签）；下载与安装卡（只在有事等用户处置时）；
// 更新日志卡（最新版本展开、较旧版本一列一个；条目与分组标题依接口语言）；自动检查卡（背景检查开关）。
import { useEffect, useRef } from "react";
import {
  Button,
  SettingsCard,
  SettingsPageHeader,
  SettingsRow,
  StatusPill,
  Switch,
  useI18n,
  type StatusPillLabel,
} from "@specseal/ui";

import { UpdateInstallRow } from "../../components/UpdateInstallRow";
import { updateNeedsAttention, type UpdaterState } from "../../core/updater";
import { entryText, RELEASE_NOTES } from "../../release-notes/release-notes";
import type { AppSettingsUpdaterProps } from "../AppSettingsView";

/** 「最新版本」列：等宽版号（无则「—」或不显示）＋状态签；关于页版本列的状态签共用。 */
export function latestOf(state: UpdaterState, currentVersion: string | null | undefined): {
  version: string | null;
  pill: StatusPillLabel;
} {
  switch (state.phase) {
    case "available":
    case "downloading":
    case "restartPending":
      return { version: state.version, pill: { key: "updater.page.pill.available", tone: "warning" } };
    case "upToDate":
      return { version: currentVersion ?? null, pill: { key: "updater.page.pill.upToDate", tone: "success" } };
    case "checking":
      return { version: null, pill: { key: "updater.page.pill.checking", tone: "neutral" } };
    case "checkFailed":
      return { version: null, pill: { key: "updater.page.pill.checkFailed", tone: "destructive" } };
    case "error":
      return { version: null, pill: { key: "updater.page.pill.error", tone: "destructive" } };
    case "idle":
      return { version: "—", pill: { key: "updater.page.pill.idle", tone: "neutral" } };
  }
}

/** 等宽版号。 */
const VersionText = ({ children }: { children: string }) => (
  <span className="font-mono text-[13px]">{children}</span>
);

export function UpdatesPage({ updater }: { updater?: AppSettingsUpdaterProps }) {
  const { t, locale } = useI18n();
  // 聚焦卷动（图标列更新钮、toast「查看」、技能档较新态的入口举旗）：卷到下载与安装卡，
  // 没有该卡时卷到版本卡；卷一次并回呼清旗标。
  const versionCard = useRef<HTMLDivElement>(null);
  const installCard = useRef<HTMLDivElement>(null);
  const focus = updater?.focus === true;
  const onFocusHandled = updater?.onFocusHandled;
  useEffect(() => {
    if (!focus) return;
    (installCard.current ?? versionCard.current)?.scrollIntoView({ block: "start", behavior: "smooth" });
    onFocusHandled?.();
  }, [focus, onFocusHandled]);

  if (!updater) {
    return <SettingsPageHeader title={t("settings.section.updates")} />;
  }
  const latest = latestOf(updater.state, updater.currentVersion);
  const [newest, ...older] = RELEASE_NOTES;
  const autoCheckLabel = t("updater.page.autoCheck");
  return (
    <>
      <SettingsPageHeader
        title={t("settings.section.updates")}
        description={t("updater.page.description")}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={updater.state.phase === "checking"}
            onClick={updater.onCheck}
          >
            {t("updater.check")}
          </Button>
        }
      />
      <div ref={versionCard}>
        <SettingsCard title={t("updater.page.versionCard")}>
          <SettingsRow label={t("updater.currentVersion")} control={<VersionText>{updater.currentVersion ?? "—"}</VersionText>} />
          <SettingsRow
            label={t("updater.page.latest")}
            control={
              <>
                {latest.version && <VersionText>{latest.version}</VersionText>}
                <StatusPill tone={latest.pill.tone}>{t(latest.pill.key)}</StatusPill>
              </>
            }
          />
        </SettingsCard>
      </div>
      {updateNeedsAttention(updater.state) && (
        <div ref={installCard}>
          <SettingsCard title={t("updater.page.installCard")}>
            <UpdateInstallRow
              state={updater.state}
              onAccept={updater.onAccept}
              onCancel={updater.onCancel}
              onRelaunch={updater.onRelaunch}
              onRetry={updater.onCheck}
            />
          </SettingsCard>
        </div>
      )}
      <SettingsCard title={t("releaseNotes.open")}>
        {newest && (
          <SettingsRow
            label={<VersionText>{newest.version}</VersionText>}
            description={newest.date}
            control={null}
          >
            <div className="flex flex-col gap-2">
              {newest.sections.map((section) => (
                <div key={section.kind} className="flex flex-col gap-1">
                  <span className="text-xs font-medium">{t(`releaseNotes.kind.${section.kind}`)}</span>
                  <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-muted-foreground">
                    {section.items.map((item, i) => (
                      <li key={i}>{entryText(item, locale)}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </SettingsRow>
        )}
        {older.map((entry) => (
          <SettingsRow
            key={entry.version}
            label={<VersionText>{entry.version}</VersionText>}
            description={
              <span className="line-clamp-1">
                {entry.date} · {entry.sections[0] ? entryText(entry.sections[0].items[0], locale) : ""}
              </span>
            }
            control={
              <Button type="button" variant="ghost" size="sm" onClick={() => updater.onShowReleaseNotes(entry.version)}>
                {t("updater.page.viewNotes")}
              </Button>
            }
          />
        ))}
        <div className="flex justify-end px-4 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => updater.onShowReleaseNotes()}>
            {t("updater.page.allNotes")}
          </Button>
        </div>
      </SettingsCard>
      <SettingsCard title={t("updater.page.autoCheckCard")}>
        <SettingsRow
          label={autoCheckLabel}
          description={t("updater.page.autoCheckHint")}
          control={
            <Switch
              aria-label={autoCheckLabel}
              checked={updater.autoCheck}
              onCheckedChange={updater.onAutoCheckChange}
            />
          }
        />
      </SettingsCard>
    </>
  );
}

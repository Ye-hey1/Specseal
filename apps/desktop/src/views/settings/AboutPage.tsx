// 关于页（desktop-about-page design D2／D6；spec「关于页」）：品牌卡（锁版、版本列附可点的
// 更新状态签与拷贝版本信息钮、产品描述）、链接卡（原代码、说明文档、回报问题）、授权卡（授权
// 条款、第三方授权）。检查更新与更新日志只在更新页，这里不设。
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Button,
  Card,
  CopyButton,
  SettingsCard,
  SettingsLinkRow,
  SettingsPageHeader,
  SettingsRow,
  StatusPill,
  Wordmark,
  useI18n,
} from "@specseal/ui";

import type { AppInfo } from "../../adapter/appInfo";
import type { UpdaterState } from "../../core/updater";
import {
  BUNDLED_THIRD_PARTY_LICENSES,
  LicenseDialog,
  type LicenseDialogContent,
  type ThirdPartyLicenses,
} from "../../components/LicenseDialog";
import { latestOf } from "./UpdatesPage";

/** 仓库网址（原生菜单的 GitHub／回报问题也用它；能力档的 opener 权限只放行这个前缀）。 */
export const REPO_URL = "https://github.com/MomoChenisMe/speclink";
export const ISSUE_URL = `${REPO_URL}/issues/new`;
const DOCS_URL = `${REPO_URL}/tree/main/docs`;

/** 以系统浏览器打开网址，失败以失败 toast 呈现（原生菜单的外部链接共用）。 */
export function openExternal(url: string) {
  openUrl(url).catch((e) => toast.error(String(e)));
}

/** 「拷贝版本信息」与回报问题 issue 内文共用的三行。 */
function versionLines(info: AppInfo): string {
  return [
    `Specseal ${info.appVersion}`,
    `Engine ${info.engineVersion}`,
    `Platform ${info.platform} ${info.arch}`,
  ].join("\n");
}

export interface AboutPageProps {
  /** null＝尚未取得（版本列显示「—」、无拷贝钮）。 */
  appInfo: AppInfo | null;
  /** 进页时要求加载版本信息（store 缓存，重复调用不重取）。 */
  onLoadAppInfo: () => void;
  /** 与更新页「最新版本」列同一份更新状态；未注入时不显示状态签。 */
  updaterState?: UpdaterState;
  /** 点状态签：进更新页。 */
  onOpenUpdates: () => void;
  thirdPartyLicenses?: ThirdPartyLicenses | null;
}

export function AboutPage({
  appInfo,
  onLoadAppInfo,
  updaterState,
  onOpenUpdates,
  thirdPartyLicenses = BUNDLED_THIRD_PARTY_LICENSES,
}: AboutPageProps) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<LicenseDialogContent | null>(null);
  useEffect(() => {
    onLoadAppInfo();
  }, [onLoadAppInfo]);

  const lines = appInfo ? versionLines(appInfo) : null;
  const pill = updaterState ? latestOf(updaterState, null).pill : null;
  const viewButton = (content: LicenseDialogContent) => (
    <Button type="button" variant="outline" size="sm" onClick={() => setDialog(content)}>
      {t("about.view")}
    </Button>
  );

  return (
    <>
      <SettingsPageHeader title={t("about.title")} description={t("about.description")} />
      <Card data-testid="about-brand" className="flex flex-col gap-3 p-5">
        <Wordmark className="h-10 self-start" />
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>
            {appInfo
              ? `${appInfo.appVersion} · ${t("about.engine")} ${appInfo.engineVersion} · ${appInfo.platform} ${appInfo.arch}`
              : "—"}
          </span>
          {pill && (
            <button
              type="button"
              onClick={onOpenUpdates}
              aria-label={t("about.updateStatus").replace("{status}", t(pill.key))}
              className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StatusPill tone={pill.tone}>{t(pill.key)}</StatusPill>
            </button>
          )}
          {lines && (
            <span className="ml-auto">
              <CopyButton size="sm" value={lines} label={t("about.copyInfo")} />
            </span>
          )}
        </div>
        <p className="m-0 text-[15px]">{t("about.tagline")}</p>
      </Card>

      <SettingsCard title={t("about.linksCard")}>
        <SettingsLinkRow
          label={t("about.source")}
          description={<span className="font-mono">{REPO_URL.replace(/^https:\/\//, "")}</span>}
          onClick={() => openExternal(REPO_URL)}
        />
        <SettingsLinkRow label={t("about.docs")} description={t("about.docsHint")} onClick={() => openExternal(DOCS_URL)} />
        <SettingsLinkRow
          label={t("about.report")}
          description={t("about.reportHint")}
          onClick={() => openExternal(`${ISSUE_URL}${lines ? `?body=${encodeURIComponent(lines)}` : ""}`)}
        />
      </SettingsCard>

      <SettingsCard title={t("about.licenseCard")}>
        <SettingsRow label={t("about.license")} description={t("about.licenseHint")} control={viewButton("license")} />
        <SettingsRow
          label={t("about.thirdParty")}
          description={t("about.thirdPartyHint")}
          control={viewButton("thirdParty")}
        />
      </SettingsCard>

      <LicenseDialog content={dialog} thirdPartyLicenses={thirdPartyLicenses} onClose={() => setDialog(null)} />
    </>
  );
}

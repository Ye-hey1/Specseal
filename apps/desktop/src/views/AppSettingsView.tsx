// 应用程序设置（desktop-settings-mode design D5）：与任何项目无关；依设置分类栏的所在分类渲染
// 一页——一般、更新、CLI、服务器、关于（desktop-about-page design D4／D7）。
import type { Platform } from "../platform";
import type { UpdaterState } from "../core/updater";
import type { SettingsSection } from "../settingsCatalog";
import { AboutPage, type AboutPageProps } from "./settings/AboutPage";
import { CliPage, type CliInstallProps } from "./settings/CliPage";
import { GeneralPage, type InterfacePrefsProps } from "./settings/GeneralPage";
import { ServersPage, type ServersPageProps } from "./settings/ServersPage";
import { UpdatesPage } from "./settings/UpdatesPage";

/** 软件更新面：状态机现值＋手动检查入口＋更新日志浏览入口＋常驻现版号（null＝尚未取得）
 * ＋「下载与安装」的动作＋聚焦卷动＋背景检查开关。 */
export interface AppSettingsUpdaterProps {
  state: UpdaterState;
  onCheck: () => void;
  /** 打开更新日志对话框的浏览模式（desktop-app「更新日志弹窗」）；带版号时打开后卷到该版。 */
  onShowReleaseNotes: (version?: string) => void;
  currentVersion?: string | null;
  /** 用户同意：下载并套用。 */
  onAccept: () => void;
  /** 取消下载＝放弃本次同意、回闲置。 */
  onCancel: () => void;
  /** 套用完成后重启为新版。 */
  onRelaunch: () => void;
  /** true＝进更新页后卷到下载与安装卡一次（图标列更新钮、toast「查看」、技能档较新态的入口）。 */
  focus?: boolean;
  /** 卷到卡后回呼，调用端清旗标。 */
  onFocusHandled?: () => void;
  /** 启动时与回到前景的背景检查开关现值（缺省开）。 */
  autoCheck: boolean;
  onAutoCheckChange: (on: boolean) => void;
}

export interface AppSettingsViewProps extends InterfacePrefsProps {
  /** 设置分类栏的所在分类。 */
  section: SettingsSection;
  /** 键盘快捷键卡依平台列出实际生效的快捷键（desktop-native-menu design D5）。 */
  platform: Platform;
  /** 面板创建失败时于一般页底浮出的单行错误。 */
  trayPanelError?: string | null;
  /** app 全域服务器管理面；测试或不支持连接的壳层可不注入。 */
  servers?: ServersPageProps;
  /** 软件更新面（desktop-app「桌面自动更新」）；测试或不支持更新的壳层可不注入。 */
  updater?: AppSettingsUpdaterProps;
  /** 安装 CLI 指令面（desktop-app「安装 CLI 指令到 PATH」）；探测前或无壳层支持时不注入。 */
  cliInstall?: CliInstallProps;
  /** 关于页的版本信息面（更新状态沿用 updater）；未注入时关于页不渲染。 */
  about?: Omit<AboutPageProps, "updaterState" | "thirdPartyLicenses">;
}

export function AppSettingsView({
  section,
  platform,
  localePref,
  onLocalePrefChange,
  themePref,
  onThemePrefChange,
  trayPanelError = null,
  servers,
  updater,
  cliInstall,
  about,
}: AppSettingsViewProps) {
  const prefs = { localePref, onLocalePrefChange, themePref, onThemePrefChange };
  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 pb-10 pt-7">
      {section === "general" && (
        <GeneralPage {...prefs} platform={platform} trayPanelError={trayPanelError} />
      )}
      {section === "updates" && <UpdatesPage updater={updater} />}
      {section === "cli" && <CliPage cliInstall={cliInstall} />}
      {section === "servers" && servers && <ServersPage {...servers} />}
      {section === "about" && about && <AboutPage {...about} updaterState={updater?.state} />}
    </div>
  );
}

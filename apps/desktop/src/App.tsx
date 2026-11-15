import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloudOff, MoreHorizontal } from "lucide-react";
import {
  KanbanBoard,
  RoadmapView,
  BoardViewSwitch,
  ArchivedList,
  ArchivedDetailPage,
  SpecList,
  SpecDetailPage,
  sortSpecs,
  ManualPage,
  ChangeDetailPage,
  DiscussionDetailPage,
  DetailActionsSlot,
  DetailActionsSlotProvider,
  DetailNav,
  RevertBlockedDialog,
  ReviewArchiveDialog,
  Button,
  Checkbox,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  I18nProvider,
  SEMANTIC_SURFACE,
  applyThemePreference,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
  SEMANTIC_TONE,
  Toaster,
  cn,
  useI18n,
  siblingChangesOf,
  discussionChipStage,
  type Crumb,
  type DocumentTarget,
  type Verb,
} from "@specseal/ui";

import {
  createAppStore,
  isSettingsView,
  openTicketStation,
  selectAssetMigrated,
  selectAssetPrompt,
  type AppState,
} from "./store";
import { locatorKey, type WorkspaceSession } from "./session";
import { initTray, type TrayController } from "./tray";
import { installDeepLinks } from "./deepLink";
import { installAppMenu, type AppMenuAction } from "./appMenu";
import { ProjectRail, tabPathHint } from "./components/ProjectRail";
import { ProjectColumn } from "./components/ProjectColumn";
import { SettingsColumn } from "./components/SettingsColumn";
import { ProjectSettingsColumn } from "./components/ProjectSettingsColumn";
import { APP_SETTINGS_CATEGORIES, projectSettingsTrail } from "./settingsCatalog";
import { EmptyWorkspace } from "./components/EmptyWorkspace";
import { ProjectActionItems, type ProjectActions } from "./components/ProjectActionsMenu";
import { LeftTitleBar, MainTitleBar } from "./components/TitleBar";
import { DetailBack, isBackShortcut } from "./components/DetailBack";
import { SwipeBack } from "./components/SwipeBack";
import { DocumentActionsMenu } from "./components/DocumentActionsMenu";
import { detectPlatform } from "./platform";
import { WorkspaceChooser } from "./components/WorkspaceChooser";
import { visibleRecents } from "./recents";
import { MigrationDialog } from "./components/MigrationDialog";
import { RemoteConflictDialog } from "./components/RemoteConflictDialog";
import { RemoteWorkspaceRecovery } from "./components/RemoteWorkspaceRecovery";
import { AppSettingsView } from "./views/AppSettingsView";
import { ISSUE_URL, REPO_URL, openExternal } from "./views/settings/AboutPage";
import { AssetNoticeCard } from "./components/AssetNoticeCard";
import { AssetNoticeDialog } from "./components/AssetNoticeDialog";
import { UpdateRailButton } from "./components/UpdateRailButton";
import { appVersion, type UpdaterAdapter } from "./adapter/updater";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { readLastSeenVersion, whatsNewDecision, writeLastSeenVersion } from "./core/whatsNew";
import { RELEASE_NOTES, type ReleaseNotesEntry } from "./release-notes/release-notes";
import type { CliInstallAdapter } from "./adapter/cliInstall";
import { projectDirOf, type FsActionsAdapter } from "./adapter/fsActions";
import type { AppInfo } from "./adapter/appInfo";
import { ProjectSettingsView } from "./views/ProjectSettingsView";
import type { ConnectionsAdapter } from "./adapter/connections";
import type { WorkspaceAdapter } from "./adapter/workspace";
import {
  createMigrationAdapter,
  type MigrationAdapter,
} from "./adapter/migration";
import { APP_MESSAGES } from "./i18n/messages";
import {
  readLocalePreference,
  resolveUiLocale,
  writeLocalePreference,
  type LocalePreference,
} from "./i18n/locale";
import { setAppT } from "./i18n/runtime";
import { BUILTIN_TOOLS } from "./builtinTools";

export interface AppProps {
  /** local session 工厂（root 绑定 dataSource／settings／events；workspace-session 决策 3/6）。 */
  createSession: (root: string, name: string) => WorkspaceSession;
  /** remote session 工厂（remote-data-source 决策 6/7）：handshake 成功回
   * session、失败上抛；未注入时 remote 打开入口不激活。 */
  openRemote?: (
    connectionId: string,
    target: string,
    checkoutRoot?: string,
  ) => Promise<WorkspaceSession>;
  /** workspace 探测面（开项目／init／统计／监看重挂）；未注入时对应 UI 不激活。 */
  workspace?: WorkspaceAdapter;
  /** server 连接面（desktop-connections）；未注入时服务器页签不激活。 */
  connections?: ConnectionsAdapter;
  /** 正式 local→remote 迁移命令；缺省使用 Tauri adapter，测试可注入。 */
  migration?: MigrationAdapter;
  /** 自动更新面（desktop-app「桌面自动更新」）；未注入时更新入口不激活。 */
  updater?: UpdaterAdapter;
  /** CLI 布署面（desktop-app「安装 CLI 指令到 PATH」）；未注入时 CLI 卡不激活。 */
  cliInstall?: CliInstallAdapter;
  /** 项目层文件系统动作面（desktop-app「项目层文件系统动作」）；未注入时菜单动作不动作。 */
  fsActions?: FsActionsAdapter;
  /** 关于页的版本信息来源（desktop-about-page design D1）；未注入时版本列显示「—」。 */
  loadAppInfo?: () => Promise<AppInfo>;
}

const DEFAULT_MIGRATION_ADAPTER = createMigrationAdapter();


/** 关闭作用中项目（非 macOS 的 Ctrl+W 与原生菜单「关闭项目」共用）。 */
function closeActiveProject(store: ReturnType<typeof createAppStore>) {
  const { activeKey, closeTab } = store.getState();
  if (activeKey) closeTab(activeKey);
}

/** 四种详情页任一开着（spec「详情页互斥」：同时至多一个）。 */
function detailPageOpen(
  st: Pick<AppState, "detailChange" | "detailDiscussion" | "detailSpec" | "detailArchived">,
): boolean {
  return st.detailChange !== null || st.detailDiscussion !== null || st.detailSpec !== null || st.detailArchived !== null;
}

/** 处在两种设置模式之一（项目设置模式要有项目；零分页时项目设置落在空状态，不算）。 */
function inSettingsMode(st: Pick<AppState, "boardView" | "tabs">): boolean {
  return st.boardView === "settings" || (st.boardView === "project-settings" && st.tabs.length > 0);
}

/** 有对话框开着（Radix 只在打开时挂载内容）：返回属于底下的页面，不得连带收掉对话框。 */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** 有确认框（封存、退回、删除、讨论封存）待确认：确认框属于目前详情页，返回与切换都不作用。 */
function confirmPending(
  st: Pick<AppState, "pendingArchive" | "pendingRevert" | "pendingDelete" | "pendingArchiveDiscussion">,
): boolean {
  return st.pendingArchive !== null || st.pendingRevert !== null || st.pendingDelete !== null || st.pendingArchiveDiscussion !== null;
}

/** 各清单页回报的呈现顺序（含搜索与筛选）——详情页 ‹ › 串行的来源。 */
type VisibleOrder = Record<"changes" | "discussions" | "specs" | "archivedChanges" | "archivedDiscussions", string[]>;

/** 开着的详情页：种类、目前项目、‹ › 串行与在串行内打开某项的动作（与打开同一个状态层动作）。 */
interface OpenDetail {
  kind: "change" | "discussion" | "spec" | "archived";
  current: string;
  sequence: string[];
  open: (key: string) => void;
}

/**
 * 详情页种类的唯一分派处（串行、面包屑、切换、渲染共用）。规格与已封存的串行依宿主取：宿主是
 * 对应清单页时用它回报的顺序；否则（手册页、规格页开已封存）用 store 清单的未过滤顺序——规格
 * 依规格页的缺省排序，已封存沿清单序。
 */
function openDetailOf(s: AppState, order: VisibleOrder): OpenDetail | null {
  const archivedHost = s.boardView === "archived";
  const a = s.detailArchived;
  if (s.detailChange) return { kind: "change", current: s.detailChange.name, sequence: order.changes, open: s.openDetail };
  if (s.detailDiscussion) {
    return { kind: "discussion", current: s.detailDiscussion.slug, sequence: order.discussions, open: s.openDiscussion };
  }
  if (s.detailSpec !== null) {
    const sequence = s.boardView === "specs" ? order.specs : sortSpecs(s.specs).map((spec) => spec.id);
    return { kind: "spec", current: s.detailSpec, sequence, open: s.openSpec };
  }
  if (a?.kind === "change") {
    const sequence = archivedHost ? order.archivedChanges : s.archived.map((x) => x.datedName);
    return { kind: "archived", current: a.datedName, sequence, open: (datedName) => s.openArchived({ kind: "change", datedName }) };
  }
  if (a?.kind === "discussion") {
    const sequence = archivedHost ? order.archivedDiscussions : s.discussions.archived.map((d) => d.slug);
    return { kind: "archived", current: a.slug, sequence, open: (slug) => s.openArchived({ kind: "discussion", slug }) };
  }
  return null;
}

const DISABLED_CHOOSER_CONNECTIONS: Pick<
  ConnectionsAdapter,
  "scopes" | "inspectCheckout" | "bindCheckout"
> = {
  scopes: async () => ({ projects: [] }),
  inspectCheckout: async () => {
    throw new Error("此环境未提供 server 连接功能");
  },
  bindCheckout: async () => {
    throw new Error("此环境未提供 server 连接功能");
  },
};

/** 对话框描述文本内嵌粗体名称：以 {name} 占位切分渲染。 */
function BoldName({ text, name }: { text: string; name: string }) {
  const [before, after] = text.split("{name}");
  return (
    <>
      {before}
      <b>{name}</b>
      {after}
    </>
  );
}

/** 桌面 app 进入点：解析 UI 语言（偏好优先、null 跟随系统）并挂 I18nProvider。 */
export function App({
  createSession,
  openRemote,
  workspace,
  connections,
  migration = DEFAULT_MIGRATION_ADAPTER,
  updater,
  cliInstall,
  fsActions,
  loadAppInfo,
}: AppProps) {
  const [localePref, setLocalePrefState] = useState<LocalePreference>(() => readLocalePreference());
  // 切换即时生效并持久化（设置页的 UI 语言三选接这里）。
  const setLocalePref = (pref: LocalePreference) => {
    writeLocalePreference(pref);
    setLocalePrefState(pref);
  };
  const uiLocale = resolveUiLocale(
    localePref,
    typeof navigator !== "undefined" ? navigator.language : undefined,
  );
  // 外观偏好（desktop-settings-mode design D4）：启动套用在 index.html 的开机脚本；切换时写入、套用并通知
  // 系统匣面板 webview 重套（非 Tauri 环境静默）。
  const [themePref, setThemePrefState] = useState<ThemePreference>(() => readThemePreference());
  const setThemePref = (pref: ThemePreference) => {
    writeThemePreference(pref);
    applyThemePreference(pref);
    setThemePrefState(pref);
    void emit("specseal:theme-changed", pref).catch(() => {});
  };
  return (
    <I18nProvider locale={uiLocale} messages={APP_MESSAGES}>
      <AppInner
        createSession={createSession}
        openRemote={openRemote}
        workspace={workspace}
        connections={connections}
        migration={migration}
        updater={updater}
        cliInstall={cliInstall}
        fsActions={fsActions}
        loadAppInfo={loadAppInfo}
        localePref={localePref}
        onLocalePrefChange={setLocalePref}
        themePref={themePref}
        onThemePrefChange={setThemePref}
      />
      <Toaster />
    </I18nProvider>
  );
}

interface AppInnerProps extends AppProps {
  /** UI 语言偏好现值（null＝跟随系统）；设置页三选用。 */
  localePref: LocalePreference;
  onLocalePrefChange: (pref: LocalePreference) => void;
  /** 外观偏好现值（null＝跟随系统）；设置页外观列用。 */
  themePref: ThemePreference;
  onThemePrefChange: (pref: ThemePreference) => void;
}

/** 桌面主画面：生命周期看板（主视图）＋已封存独立页＋设置页＋富详情抽屉。 */
function AppInner({
  createSession,
  openRemote,
  workspace,
  connections,
  migration,
  updater,
  cliInstall,
  fsActions,
  loadAppInfo,
  localePref,
  onLocalePrefChange,
  themePref,
  onThemePrefChange,
}: AppInnerProps) {
  const useStore = useMemo(
    () =>
      createAppStore({
        createSession,
        openRemote,
        workspace,
        connections,
        migration,
        updater,
        cliInstall,
        fsActions,
        loadAppInfo,
      }),
    [createSession, openRemote, workspace, connections, migration, updater, cliInstall, fsActions, loadAppInfo],
  );
  const s = useStore();
  // 活跃 session（workspace-session 决策 6）：详情／规格／封存抽屉的文档加载
  // 与设置页一律经它——App 不再持有全域 dataSource。
  const activeSession = s.activeKey ? s.sessions[s.activeKey] : undefined;
  const activeTab = s.activeKey
    ? s.tabs.find((tab) => locatorKey(tab.locator) === s.activeKey)
    : undefined;
  const activeRecovery = s.activeKey ? s.remoteRecovery[s.activeKey] : undefined;
  const activeRecoveryTab =
    !activeSession && activeRecovery && activeTab?.locator.kind === "remote"
      ? activeTab
      : undefined;
  const activeRecoveryConnectionId =
    activeRecoveryTab?.locator.kind === "remote"
      ? activeRecoveryTab.locator.connectionId
      : undefined;
  const activeRecoveryConnection = activeRecoveryConnectionId
    ? s.connections.find((connection) => connection.id === activeRecoveryConnectionId)
    : undefined;
  const dataSource = activeSession?.dataSource;
  // capability 驱动停用（remote-data-source 决策 2）：remote session 依 server
  // 端点覆盖停用 affordance；本地 session 全真、同一路径零分岐。
  const caps = activeSession?.capabilities;
  const connectionState = activeSession?.connectionState;
  const remoteArchiveScope =
    activeSession?.locator.kind === "remote" ? activeSession.descriptor.name : null;
  // 封存入口守门（spec「封存入口三选项扩及验证工单」）：待封存 change 仍有
  // 未结工单的站 → 以该站的三选项对话框取代一般确认；双工单并存时依序各弹
  // 一次，全部处置完才走一般封存。
  const pendingArchiveStation =
    s.pendingArchive === null
      ? null
      : openTicketStation(s.changes, s.pendingArchive, s.pendingArchiveSettled);
  const stale =
    activeSession?.locator.kind === "remote" &&
    connectionState !== undefined &&
    connectionState.state !== "online";
  const sessionConnectionStates = Object.fromEntries(
    Object.entries(s.sessions).map(([key, session]) => [key, session.connectionState]),
  );
  const servers = connections && {
    connections: s.connections,
    phases: s.connectionPhases,
    onAdd: s.addConnection,
    onLogin: s.loginConnection,
    onCancelLogin: s.cancelLogin,
    onSubmitPat: s.submitPat,
    onLogout: s.logoutConnection,
    onRemove: s.removeConnection,
    onRefresh: s.refreshConnections,
    focusConnectionId: s.reauthConnectionId,
    // 开着的 remote session 回报需重新登录的连接：服务器页列为登录过期。
    expiredConnectionIds: Object.values(s.sessions).flatMap((session) =>
      session.connectionState?.state === "needs-reauth" ? [session.connectionState.connectionId] : [],
    ),
    onOpenWorkspace:
      openRemote && ((id: string) => s.openWorkspaceChooser({ initialConnectionId: id })),
    defaultConnectionId: s.defaultConnectionId,
    onDefaultConnectionChange: s.setDefaultConnectionId,
  };
  // 设置页软件更新卡的常驻现版号（updater 注入时启动取一次；非 Tauri 环境静默）。
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  // 更新日志对话框（desktop-app「更新日志弹窗」）：纯 UI 开关，不进 store。whatsNew＝
  // 版号变更后首次启动自动弹出（关闭即记下现版号）；browse＝设置页按钮（关闭不写记录）。
  const [releaseNotes, setReleaseNotes] = useState<
    { mode: "whatsNew"; entries: ReleaseNotesEntry[] } | { mode: "browse"; focusVersion?: string } | null
  >(null);
  useEffect(() => {
    if (updater) {
      appVersion()
        .then((version) => {
          setCurrentVersion(version);
          const decision = whatsNewDecision({
            appVersion: version,
            entries: RELEASE_NOTES,
            lastSeen: readLastSeenVersion(),
            dev: import.meta.env.DEV,
          });
          if (decision.kind === "show") {
            setReleaseNotes({ mode: "whatsNew", entries: decision.entries });
          } else if (decision.kind === "record") {
            writeLastSeenVersion(version);
          }
        })
        .catch(() => {});
    }
  }, [updater]);
  // 变更详情或讨论抽屉打开或换开另一个时收掉更新日志（spec「detail 抽屉互斥」）：被
  // 抽屉顶掉不走关闭钮，whatsNew 不记为已看过、下次启动照旧弹出。以名称为键，重载
  // 换掉同一个 change 的对象不算换开。
  const openedDrawer = s.detailChange
    ? `change:${s.detailChange.name}`
    : s.detailDiscussion
      ? `discussion:${s.detailDiscussion.slug}`
      : null;
  // 技能档提示确认框（desktop-notice-relocation design D1）：纯 UI 开关，与 releaseNotes 同型；
  // 抽屉打开时一并收掉（可取消浮层互斥），提示消失（更新成功、保留现状、切分页）时也关。
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const assetPromptNow = selectAssetPrompt(s);
  useEffect(() => {
    if (openedDrawer !== null) {
      setReleaseNotes(null);
      setAssetDialogOpen(false);
    }
  }, [openedDrawer]);
  // 迁移完成态（desktop-spec-dir-migration D2）在提示消失后仍留着，直到用户按「知道了」；
  // 它属于套用的分页——更新途中切走的，切回来才开框显示。
  const assetMigratedNow = selectAssetMigrated(s);
  useEffect(() => {
    if (assetMigratedNow) setAssetDialogOpen(true);
    else if (!assetPromptNow) setAssetDialogOpen(false);
  }, [assetPromptNow, assetMigratedNow]);
  // 初始化确认框的工具多选（缺省勾 claude）；对话框每次打开重设。
  const [initTools, setInitTools] = useState<string[]>(["claude"]);
  useEffect(() => {
    if (s.pendingInit) setInitTools(["claude"]);
  }, [s.pendingInit]);
  // 激活确认框的工具多选（决策 3：与初始化框同型、独立状态）。
  const [adoptTools, setAdoptTools] = useState<string[]>(["claude"]);
  useEffect(() => {
    if (s.pendingAdopt) setAdoptTools(["claude"]);
  }, [s.pendingAdopt]);
  const { t } = useI18n();
  // 同步 store 层（非 React）的 t 桥——store 组用户可见消息时取当前语言。
  useEffect(() => {
    setAppT(t);
  }, [t]);
  // 写入面的停用说明（server-reader-write-guard D5）：脱机时是连接原因；连接
  // 正常仍停用的写入只剩角色原因——server 对 reader 的每个写入都回 403。
  const writeDisabledReason = t(stale ? "remote.writeUnavailable" : "remote.readerRole");

  // 看板拖曳手势让路（design D6、TaskList 同款）：手势中暂缓 workspace-changed
  // 的整批 refresh（避免拖曳中卡片重排打断手势），放开后补跑一次。
  const boardDragActive = useRef(false);
  const pendingRefresh = useRef(false);
  // 详情页内的确认（封存、删除、退回）在途时，成功／失败由 store 决定是否关页——
  // 这段期间 Esc 不关页，免得确认框收合的 Esc 尾巴误清 detailChange。
  const detailConfirmInFlight = useRef(false);
  const handleBoardDragActive = (active: boolean) => {
    boardDragActive.current = active;
    if (!active && pendingRefresh.current) {
      pendingRefresh.current = false;
      void useStore.getState().refresh();
    }
  };

  useEffect(() => {
    // 启动：有 workspace 即还原分页列（依持久化 activeKey 切回上次活跃项目、
    // 背景徽章快照）；否则维持既有的整批 refresh（无活跃 session 时为无事）。
    // specseal 网址（desktop-app「以 specseal 网址打开详情页」）排队到分页还原之后才处理。
    const uninstallDeepLinks = workspace
      ? installDeepLinks(useStore, useStore.getState().restoreTabs())
      : null;
    if (!workspace) void useStore.getState().refresh();
    if (connections) void useStore.getState().refreshConnections();
    // 启动背景检查更新（非阻塞；失败静默——desktop-app「检查失败静默」）。
    if (updater) void useStore.getState().checkForUpdates(false);
    // 主窗口回到前景时重检（desktop-app「回到前景逾一小时即重检」；design D3）：
    // 只对取得焦点反应，节流由 store 判定；订阅失败（非 Tauri）静默。unlisten 走
    // Promise 链取消，卸载早于订阅完成也不漏。
    const focusUnlisten = updater?.onFocusChanged
      ? updater
          .onFocusChanged((focused) => {
            if (focused) void useStore.getState().recheckOnFocus();
          })
          .catch(() => null)
      : null;
    // CLI 布署状态探测（含 AppImage 版本不符的启动自我修复）。
    if (cliInstall) void useStore.getState().refreshCliInstall();
    return () => {
      uninstallDeepLinks?.();
      void focusUnlisten?.then((unlisten) => unlisten?.());
      // 卸载时取消漏出的搜索去抖，杜绝在途 timer 于 store 卸载后才开火。
      useStore.getState().disposeSearch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStore, connections, workspace, updater, cliInstall]);

  // 文件监看的宿主层 wiring（workspace-session 决策 5）：订阅活跃 session 的
  // 事件来源（workspace-changed 以自身 root 过滤），触发既有整批 refresh；
  // 切换活跃分页即换订阅、卸载时解除。
  useEffect(() => {
    const st = useStore.getState();
    const session = st.activeKey ? st.sessions[st.activeKey] : undefined;
    if (!session) return;
    return session.events.subscribe(
      () => {
        // 监看重挂先于刷新（worktree 增减会改变监看拓扑；目标不变时 Rust 端
        // 沿用原监看）——拖曳手势只暂缓画面刷新，不暂缓重挂。
        void useStore.getState().rearmWatch();
        if (boardDragActive.current) {
          pendingRefresh.current = true;
          return;
        }
        void useStore.getState().refresh();
        // 外部 specseal update 也要让提示自然消失（决策 4：workspace-changed 重查）。
        void useStore.getState().refreshAssetPrompt();
      },
      (event) => {
        const store = useStore.getState();
        store.applyRemoteConnectionState(event);
        // Rust runtime 是连接状态单一真相；worker 收敛回 online 时以同一事件
        // 驱动全量 Query 重查，用户不需再等下一笔 SSE 或手动重整。
        if (event.state === "online") void store.refresh();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStore, s.activeKey, s.sessionEpoch]);

  // 指令档过期探测（desktop-instruction-staleness-prompt 决策 4）：本地项目与有 checkout
  // 的 remote 项目分页成为活跃时查一次；没有 checkout 的 remote 分页由 store 自行略过。
  // 有 checkout 的 remote 项目另外监看 checkout 的技能档：在终端机改动技能档之后，提示卡
  // 不必切换分页就会更新。这个通知只重新探测，不重新加载项目数据。
  useEffect(() => {
    if (!workspace) return;
    const store = useStore.getState();
    void store.refreshAssetPrompt();
    const locator = store.activeKey ? store.sessions[store.activeKey]?.locator : undefined;
    if (locator?.kind !== "remote" || !locator.checkoutRoot) return;
    void store.rearmWatch();
    return workspace.onCheckoutSkillsChanged(locator.checkoutRoot, () => {
      // 技能目录可能刚出现：重挂让监看换成它本身，再重新探测。
      void useStore.getState().rearmWatch();
      void useStore.getState().refreshAssetPrompt();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStore, workspace, s.activeKey, s.sessionEpoch]);

  // 系统匣状态菜单（tray-status-menu）：订阅同一 store 于菜单列／系统匣呈现状态并可切项目。
  // store 为本组件范围，故于此接线（非 main.tsx）。创建失败（如非 Tauri 环境）只静默降级——
  // app 照常、仅无系统匣（与文件监看不可用时的降级一致）。卸载时 dispose。
  useEffect(() => {
    let controller: TrayController | null = null;
    let disposed = false;
    // 面板样式（macOS）：点击图标 toggle 面板；创建失败退回原生菜单并于设置页浮出错误。
    const onPanelToggle = () => {
      void invoke("toggle_tray_panel").catch((e) => {
        useStore.getState().panelFallback(String(e));
      });
    };
    initTray(useStore, { onPanelToggle })
      .then((c) => {
        if (disposed) c.dispose();
        else controller = c;
      })
      .catch(() => {
        /* 系统匣不可用：app 照常运作 */
      });
    return () => {
      disposed = true;
      controller?.dispose();
    };
  }, [useStore]);

  const platform = useMemo(() => detectPlatform(), []);
  // 详情页串行（design D2；desktop-readonly-detail-pages D4）：各清单页回报的呈现顺序（含搜索
  // 与筛选），‹ › 与 ⌥↑／⌥↓ 共用。
  const [visibleOrder, setVisibleOrder] = useState<VisibleOrder>({
    changes: [],
    discussions: [],
    specs: [],
    archivedChanges: [],
    archivedDiscussions: [],
  });
  const detail = openDetailOf(s, visibleOrder);
  const pageOpen = detail !== null;
  const detailCurrent = detail?.current ?? null;
  const detailIndex = detail ? detail.sequence.indexOf(detail.current) : -1;
  // 确认（封存、删除、退回）框开着或在途时，切换与返回都不作用：确认框属于目前详情页，
  // 会被一起收掉；在途确认成功后 store 关掉的是「目前」详情页，切过去的新页会被误关。
  // 以 getState 读：window 事件处理器只挂一次。
  const detailActionsBlocked = () => detailConfirmInFlight.current || confirmPending(useStore.getState());
  /** 在串行内切换：越界不动、不循环；经与打开相同的状态层动作（互斥与浮层规则同样适用）。 */
  const stepDetail = (delta: -1 | 1) => {
    const next = detail?.sequence[detailIndex + delta];
    if (!detail || detailIndex < 0 || next === undefined || detailActionsBlocked()) return;
    detail.open(next);
  };
  // 项目设置的未存修改（ProjectSettingsView 回报）：离开前先问要不要舍弃。
  const projectSettingsDirty = useRef(false);
  const onProjectSettingsDirty = useCallback((dirty: boolean) => {
    projectSettingsDirty.current = dirty;
  }, []);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  // 全系统唯一的返回：返回钮、Esc、⌘[（非 macOS 为 Alt+←）、鼠标侧键、触摸板滑动都经此决定
  // 去处——详情页开着时关页回宿主页（确认框待确认或确认在途时不作用）；设置与项目设置模式
  // 回到进入前的页面（项目设置有未存修改时先问）；其余页面没有返回（null）。
  const backTarget = (st: AppState): (() => void) | null => {
    if (detailPageOpen(st)) return detailActionsBlocked() ? null : st.closeDetailPage;
    if (!inSettingsMode(st)) return null;
    return st.boardView === "project-settings" && projectSettingsDirty.current
      ? () => setDiscardPrompt(true)
      : st.leaveSettings;
  };
  // 触发当下才看有没有对话框开着（渲染时读到的 DOM 还是上一刻，不能拿来决定滑动开关）。
  const resolveBack = (st: AppState) => (dialogOpen() ? null : backTarget(st));
  // 以调用当下的状态决定去处（事件处理器与手势结束时的状态可能已不同于渲染时）。
  const goBack = () => resolveBack(useStore.getState())?.();
  // 标题列的动作插槽（desktop-detail-doc-tree design D3）：详情页以 portal 把变更层动作送进来。
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  // 切换项目时页层卷回顶端：卷动容器不重挂，否则沿用上一项的卷动位置。
  const detailLayerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (detailLayerRef.current) detailLayerRef.current.scrollTop = 0;
  }, [detailCurrent]);
  // window keydown 处理器只挂一次：以 ref 读最新的串行与切换动作。
  const stepDetailRef = useRef(stepDetail);
  stepDetailRef.current = stepDetail;
  const handleNavKey = (e: KeyboardEvent): boolean => {
    const st = useStore.getState();
    if (e.defaultPrevented) return false;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return false;
    }
    // 返回（design D8）：Esc 与 ⌘[、⌘←（非 macOS 为 Alt+←）等效于返回钮。
    const escape = e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const back = escape || isBackShortcut(e, platform) ? resolveBack(st) : null;
    if (back) {
      e.preventDefault();
      back();
      return true;
    }
    if (detailPageOpen(st) && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepDetailRef.current(e.key === "ArrowUp" ? -1 : 1);
      return true;
    }
    return false;
  };
  // 键盘切换分页：Ctrl+Tab 循环、Ctrl+1..9 直达（spec「项目分页列存于 app 本机」）；
  // 项目动作菜单标示的 ⌘R／Ctrl+R 刷新、Ctrl+W 关闭项目（spec「项目层文件系统动作」）。
  // macOS 的 ⌘W 先被系统缺省菜单拦走（关闭窗口），由原生菜单承接，这里不接。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 返回快捷键（Esc、⌘[／Alt+←）与详情页的 ⌥↑／⌥↓ 切上一个／下一个（spec「详情页的导览与返回」）。
      // 浮层已处理（defaultPrevented）或焦点在文本输入时不作用。
      if (handleNavKey(e)) return;
      const key = e.key.toLowerCase();
      if (key === "r" && (platform === "macos" ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        void useStore.getState().refresh();
        return;
      }
      if (!e.ctrlKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        void useStore.getState().cycleTab();
      } else if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        void useStore.getState().gotoTab(Number(e.key));
      } else if (key === "w" && platform !== "macos") {
        e.preventDefault();
        closeActiveProject(useStore);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [useStore, platform]);
  // 鼠标侧键「上一页」（button 3）：WebView 是否送出此事件依平台而异，以真机验收为准。
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const back = e.button === 3 ? resolveBack(useStore.getState()) : null;
      if (!back) return;
      e.preventDefault();
      back();
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [useStore]);

  // macOS 原生菜单列（desktop-native-menu design D3／D4）：语言或项目有无改变时重装，cleanup
  // 取消尚未套用的上一次；非 macOS 由 installAppMenu 自行 no-op。菜单动作只派发到 store 既有
  // 动作、看板搜索列的 window 事件、更新日志对话框，或外部浏览器。
  const hasProject = s.activeKey !== null;
  // 「搜索看板」的共用入口（菜单项，以及路线图显示中的搜索快捷键）：看板的卡片查看显示中直接聚焦；
  // 不在看板页或正显示路线图时先切回卡片，等搜索列挂上且不再藏着（子组件的 effect 先于本组件）
  // 再聚焦。
  const pendingSearchFocus = useRef(false);
  useEffect(() => {
    if (s.boardView !== "board" || s.boardMode !== "cards" || !pendingSearchFocus.current) return;
    pendingSearchFocus.current = false;
    window.dispatchEvent(new CustomEvent("specseal:focus-search"));
  }, [s.boardView, s.boardMode]);
  const focusBoardSearch = useCallback(() => {
    const st = useStore.getState();
    if (st.boardView === "board" && st.boardMode === "cards") {
      window.dispatchEvent(new CustomEvent("specseal:focus-search"));
      return;
    }
    pendingSearchFocus.current = true;
    if (st.boardView !== "board") st.setBoardView("board");
    st.setBoardMode("cards");
  }, [useStore]);
  useEffect(() => {
    const dispatch = (action: AppMenuAction) => {
      const st = useStore.getState();
      switch (action) {
        // 原生菜单各入口进设置模式的对应分类（desktop-settings-mode design D1；
        // desktop-about-page design D4）。
        case "about":
          st.setBoardView("settings");
          return st.setSettingsSection("about");
        case "settings":
          st.setBoardView("settings");
          return st.setSettingsSection("general");
        case "installCli":
          st.setBoardView("settings");
          return st.setSettingsSection("cli");
        case "checkUpdates":
          // 手动检查的进度与结果呈现在更新页的「最新版本」列。
          st.setBoardView("settings");
          st.setSettingsSection("updates");
          return void st.checkForUpdates(true);
        case "openProject":
          return st.openWorkspaceChooser();
        case "closeProject":
          // 系统匣面板（nonactivating NSPanel）在前景时 ⌘W 也会进到 app 菜单：主窗口为焦点才关。
          return void getCurrentWindow()
            .isFocused()
            .then((focused) => focused && closeActiveProject(useStore));
        case "viewBoard":
          return st.setBoardView("board");
        case "viewArchived":
          return st.setBoardView("archived");
        case "viewSpecs":
          return st.setBoardView("specs");
        case "viewManual":
        case "helpManual":
          return st.setBoardView("manual");
        case "viewProjectSettings":
          return st.setBoardView("project-settings");
        case "focusSearch":
          return focusBoardSearch();
        case "refresh":
          return void st.refresh();
        case "nextProject":
          return void st.cycleTab();
        case "bringAllToFront":
          return void getCurrentWindow().setFocus();
        case "releaseNotes":
          return setReleaseNotes({ mode: "browse" });
        case "github":
          return openExternal(REPO_URL);
        case "reportIssue":
          return openExternal(ISSUE_URL);
      }
    };
    return installAppMenu({ isMacOS: platform === "macos", t, hasProject, dispatch });
  }, [useStore, platform, t, hasProject, focusBoardSearch]);

  const onRunVerb = (verb: Verb, change: string) => {
    if (verb === "archive") s.requestArchive(change);
    else void s.runVerb(verb, change);
  };

  const confirmDetailAction = async (confirm: () => Promise<void>) => {
    detailConfirmInFlight.current = true;
    try {
      await confirm();
    } finally {
      // 让 AlertDialog 的收合 callback 先完成；之后用户仍可正常手动关闭抽屉。
      queueMicrotask(() => {
        detailConfirmInFlight.current = false;
      });
    }
  };

  // 同源链接数据：来源讨论清单（记录已不在时以 slug 充当 topic，出身讨论在前）与
  // 同源刀（与此变更共享至少一份来源讨论的 active 变更，可互跳）。
  const fromSlugs = s.detailChange?.fromDiscussions ?? [];
  const allDiscussions = [...s.discussions.active, ...s.discussions.archived];
  const sourceDiscussions = fromSlugs.map((slug) => ({
    slug,
    topic: allDiscussions.find((d) => d.slug === slug)?.topic ?? slug,
  }));
  const siblingChanges = siblingChangesOf(s.changes, fromSlugs, s.detailChange?.name ?? "");
  // 封存变更抽屉的来源讨论（design D1 增补）：自封存清单以 datedName 查 fromDiscussions，
  // topic 同上解析、记录已不在时退回 slug。
  const detailArchived = s.detailArchived;
  const archivedItem =
    detailArchived?.kind === "change" ? s.archived.find((a) => a.datedName === detailArchived.datedName) : undefined;
  // 封存讨论的记录 live 优先、封存后备（与加载同一序）。
  const archivedDiscussion =
    detailArchived?.kind === "discussion" ? allDiscussions.find((d) => d.slug === detailArchived.slug) : undefined;
  const archivedFromSlugs = archivedItem?.fromDiscussions ?? [];
  const archivedSourceDiscussions = archivedFromSlugs.map((slug) => ({
    slug,
    topic: allDiscussions.find((d) => d.slug === slug)?.topic ?? slug,
  }));
  // 封存讨论抽屉的衍生列（drawer-provenance-links design D4）：自封存讨论清单项的 promotedTo
  // 派生三态——封存清单命中→副标封存日期；活跃清单命中→副标看板阶段词；皆无→不可点「无封存记录」。
  // 顺序沿 promotedTo 原序（转出顺序、出身在前）。
  const archivedPromotedChanges = (archivedDiscussion?.promotedTo ?? []).map(
        (name) => {
          const archivedHit = s.archived.find((a) => a.name === name);
          if (archivedHit) return { slug: name, topic: archivedHit.date };
          if (s.changes.some((c) => c.name === name)) {
            return { slug: name, topic: t(discussionChipStage(name, s.changes, s.archived)) };
          }
          return { slug: name, topic: t("rdrawer.noArchiveRecord"), disabled: true };
        },
      );
  // 讨论文档的名称签（desktop-discussion-doc-views design D8）：正式规格名与全部讨论 slug。
  const specNames = s.specs.map((x) => x.id);
  const discussionSlugs = allDiscussions.map((d) => d.slug);
  // 已封存讨论页背景文档的讨论签：作用中的开讨论详情页，其余开已封存讨论页（来源讨论签恒开已封存页）。
  const openAnyDiscussion = (slug: string) =>
    s.discussions.active.some((d) => d.slug === slug)
      ? s.openDiscussion(slug)
      : s.openArchived({ kind: "discussion", slug });
  // 点衍生签：已封存→封存抽屉（底层不切页）；活跃→详情抽屉（openDetail 依正典落回看板）。
  const openPromotedChange = (name: string) => {
    const archivedHit = s.archived.find((a) => a.name === name);
    if (archivedHit) s.openArchived({ kind: "change", datedName: archivedHit.datedName });
    else if (s.changes.some((c) => c.name === name)) s.openDetail(name);
  };
  // 封存抽屉出身列的三栏（desktop-archived-parity D4）：一律自封存清单项带入，
  // 抽屉零新查找。封存讨论无封存日期字段——该栏自然缺席。
  const archivedProvenance = archivedItem
    ? { createdBy: archivedItem.createdBy, created: archivedItem.created, archivedDate: archivedItem.date }
    : { createdBy: archivedDiscussion?.createdBy, created: archivedDiscussion?.created };

  // 壳（design D2）：标题列文本与面包屑依模式——设置、有作用中项目、零项目（留白）。
  // projectTab＝标题列要呈现的项目（设置模式时没有）。
  const projectTab = s.boardView === "settings" ? undefined : activeTab;
  // 看板页两种查看共用的加载状态。骨架的前提是「首访的加载正在进行」：探测中
  // （pendingTabKey）或整批加载中（loadingActive），且尚无真值。只看 loaded 会让探测
  // 失败或读取失败的 workspace 永远停在加载中——读不到不等于还在读。
  const boardLoading = (s.pendingTabKey !== null || s.loadingActive) && !s.loaded;
  const boardLoadFailed = !s.loaded && s.loadFailed;
  const boardViewSwitch = <BoardViewSwitch value={s.boardMode} onChange={s.setBoardMode} />;
  // 设置模式（desktop-settings-mode design D1／D2）：远程项目没有 .specseal.yaml 页，记住的分类
  // 落在那页时退回项目说明。
  const remoteProject = activeTab?.locator.kind === "remote";
  const projectSettingsSection =
    remoteProject && s.projectSettingsSection === "specseal" ? "context" : s.projectSettingsSection;
  const settingsMode = s.boardView === "settings";
  const projectSettingsMode = inSettingsMode(s) && !settingsMode;
  // 项目设置分类栏的解析失败警示点：由项目设置页读到设置快照后回报。
  const [projectParseErrors, setProjectParseErrors] = useState({ config: false, specseal: false });
  const connectionNames = Object.fromEntries(s.connections.map((c) => [c.id, c.name]));
  const PAGE_LABEL_KEY: Record<Exclude<typeof s.boardView, "settings">, string> = {
    board: "app.navChanges",
    archived: "app.archived",
    specs: "app.navSpecs",
    manual: "app.navManual",
    "project-settings": "app.navProjectSettings",
  };
  // 详情页打开时三段（spec「详情页的导览与返回」）：项目名与页名点击关页回宿主，
  // 项目名等宽不可点。
  const crumbs: Crumb[] =
    s.boardView === "settings"
      ? [
          { label: t("app.settingsTitle"), onClick: () => s.setSettingsSection("general") },
          { label: t(APP_SETTINGS_CATEGORIES.find((c) => c.id === s.settingsSection)!.labelKey) },
        ]
      : projectTab && s.boardView === "project-settings"
        ? [
            { label: projectTab.name, onClick: () => s.setBoardView("board") },
            { label: t("app.navProjectSettings"), onClick: () => s.setProjectSettingsSection("context") },
            // 子项的页多一段上层分类，点了开它指定的页（品质关卡 → 审查规则）；最后一段不可点。
            ...projectSettingsTrail(projectSettingsSection).map(({ labelKey, opens }) => ({
              label: t(labelKey),
              onClick: opens && (() => s.setProjectSettingsSection(opens)),
            })),
          ]
      : projectTab && detail
        ? [
            {
              label: projectTab.name,
              onClick: () => {
                s.closeDetailPage();
                s.setBoardView("board");
              },
            },
            { label: t(PAGE_LABEL_KEY[s.boardView]), onClick: s.closeDetailPage },
            // 已封存变更以变更名呈现（串行与拷贝用含日期前缀的封存目录名）。
            { label: archivedItem?.name ?? detail.current, mono: true },
          ]
        : projectTab
          ? [
              { label: projectTab.name, onClick: () => s.setBoardView("board") },
              { label: t(PAGE_LABEL_KEY[s.boardView]) },
            ]
          : [];
  // 「打开 ▾」（design D4）：页回报文档，位置由 core 解析；本机目录缺席（remote 无 checkout）时只剩拷贝内容。
  const hasLocalDir = activeTab ? projectDirOf(activeTab.locator) !== null : false;
  // 提案影响段路径签的显示钮：文案与「打开 ▾」菜单同一组平台词条（macOS「在 Finder 显示」）。
  const pathReveal = hasLocalDir
    ? { label: t(`fs.revealIn.${platform}`), reveal: (path: string) => void s.revealProjectPath(path) }
    : undefined;
  // 规格与手册阅读卡出处行的文件路径同样由 core 解析（跟着 spec 目录名走）；无本机目录时不查、该段缺席。
  const locateDocument = hasLocalDir ? s.locateDocument : undefined;
  const renderDocumentActions = (target: DocumentTarget | null) => (
    <DocumentActionsMenu
      target={target}
      local={hasLocalDir}
      platform={platform}
      locate={s.locateDocument}
      onOpenDefault={(location) => void s.openDocumentDefault(location)}
      onReveal={(location) => void s.revealDocument(location)}
      onCopyPath={(location) => void s.copyDocumentPath(location)}
      onCopyContent={(text) => void s.copyDocumentContent(text)}
    />
  );
  const projectActions: ProjectActions = {
    reveal: (key) => void s.revealProject(key),
    openTerminal: (key) => void s.openProjectInTerminal(key),
    openEditor: (key) => void s.openProjectInEditor(key),
    copyPath: (key) => void s.copyProjectPath(key),
    // 背景项目没有加载中的数据可重整：切过去即重新加载。
    refresh: (key) => (key === s.activeKey ? void s.refresh() : void s.activateTab(key)),
    close: s.closeTab,
  };

  // 变更详情页（design D6）：props 自原抽屉接线搬移，另接「打开 ▾」。
  const changeDetailPage = (
    <ChangeDetailPage
      change={s.detailChange}
      refreshGen={s.refreshGen}
      loadDocument={(change, artifact) => dataSource?.getDocument(change, artifact) ?? Promise.resolve(null)}
      loadStationTicket={(change, station) =>
        dataSource?.getStationTicket(change, station) ?? Promise.resolve(null)
      }
      // changeCapabilities/changeMeta 于 remote 亦直达（status payload 映射，
      // remote-read-parity）；capability 为假时仍以空集呈现——同一条停用法则，
      // 不伪造、也不让详情页加载失败。
      loadCapabilities={(change) =>
        caps && !caps.changeCapabilities
          ? Promise.resolve([])
          : (dataSource?.changeCapabilities(change) ?? Promise.resolve([]))
      }
      loadMeta={(change) =>
        caps && !caps.changeMeta
          ? Promise.resolve(null)
          : (dataSource?.changeMeta(change) ?? Promise.resolve(null))
      }
      onRunVerb={onRunVerb}
      detailVerb={s.detailVerb}
      onClearVerb={s.clearDetailVerb}
      onDelete={s.requestDelete}
      // 认领是 RemoteOnly：后端没有这个方法（本地）就整段不接线，详情页因此
      // 连停用的入口都不长出来。
      onClaim={dataSource?.claim ? s.claimChange : undefined}
      onRevert={s.requestRevert}
      // 调度分页：同波伙伴自清单派生；前置编辑只在 capability 为真时接线（remote 的
      // reader 为假，分页唯读）；数据源提供候选名册时以它为准（worktree 映射时为副本）。
      changes={s.changes}
      onSetDepends={
        caps && !caps.setDepends
          ? undefined
          : (change, on, remove) => void s.setDepends(change, on, remove)
      }
      loadDependsCandidates={
        dataSource?.dependsCandidates
          ? (change) => dataSource.dependsCandidates!(change)
          : undefined
      }
      unavailable={
        caps && {
          analyze:
            caps.validate && caps.analyze ? undefined : t("remote.analyzeUnavailable"),
          archive: caps.archive ? undefined : writeDisabledReason,
          delete: caps.deleteChange ? undefined : writeDisabledReason,
          tasks: caps.setTaskDone && caps.setAllTasks ? undefined : writeDisabledReason,
          claim: caps.claim ? undefined : writeDisabledReason,
        }
      }
      onToggleTask={
        caps && !caps.setTaskDone
          ? undefined
          : async (change, task, done) => {
              await dataSource?.setTaskDone(change, task, done);
              await s.refresh();
            }
      }
      onMoveTask={
        caps && !caps.moveTask
          ? undefined
          : async (change, from, to, before) => {
              await dataSource?.moveTask(change, from, to, before);
              await s.refresh();
            }
      }
      onSetAllTasks={
        caps && !caps.setAllTasks
          ? undefined
          : async (change, done) => {
              await dataSource?.setAllTasks(change, done);
              await s.refresh();
            }
      }
      sourceDiscussions={sourceDiscussions}
      siblingChanges={siblingChanges}
      onOpenDiscussion={s.openDiscussion}
      onOpenSibling={s.openDetail}
      renderDocumentActions={renderDocumentActions}
      onOpenSpec={s.openSpec}
      // 路径签的显示钮只在有本机目录时接（remote 无 checkout 时只有拷贝钮）。
      pathReveal={pathReveal}
    />
  );
  // 讨论详情页（design D7）。
  const discussionDetailPage = (
    <DiscussionDetailPage
      discussion={s.detailDiscussion}
      refreshGen={s.refreshGen}
      loadDocument={(slug) => dataSource?.getDiscussionDocument(slug) ?? Promise.resolve(null)}
      changes={s.changes}
      archivedChanges={s.archived}
      onOpenChangeCard={s.openDetail}
      onOpenArchivedChange={(datedName) => s.openArchived({ kind: "change", datedName })}
      specNames={specNames}
      discussionSlugs={discussionSlugs}
      onOpenSpec={s.openSpec}
      onOpenDiscussion={s.openDiscussion}
      onArchiveDiscussion={
        // 已封存的讨论(自来源讨论 chip 打开)与 capability 缺口不提供封存;
        // 其余走与讨论卡同一确认流程。
        (caps && !caps.archiveDiscussion) ||
        s.discussions.archived.some((d) => d.slug === s.detailDiscussion?.slug)
          ? undefined
          : s.requestArchiveDiscussion
      }
      renderDocumentActions={renderDocumentActions}
      specDir={s.discussions.specDir}
    />
  );
  // 规格详情页（desktop-readonly-detail-pages design D2）：宿主为规格页或手册页，皆不切页。
  const specDetailPage = (
    <SpecDetailPage
      capability={s.detailSpec}
      refreshGen={s.refreshGen}
      loadDocument={(capability) => dataSource?.getSpecDocument(capability) ?? Promise.resolve(null)}
      archivedChanges={s.archived}
      onOpenArchivedChange={(datedName) => s.openArchived({ kind: "change", datedName })}
      renderDocumentActions={renderDocumentActions}
      locateDocument={locateDocument}
    />
  );
  // 已封存详情页（design D3）：props 自原已封存抽屉的接线搬移。
  const archivedDetailPage = (
    <ArchivedDetailPage
      target={s.detailArchived}
      refreshGen={s.refreshGen}
      loadDocument={(datedName, artifact) => dataSource?.getArchivedDocument(datedName, artifact) ?? Promise.resolve(null)}
      loadStationTicket={(datedName, station) =>
        dataSource?.getArchivedStationTicket(datedName, station) ?? Promise.resolve(null)
      }
      loadCapabilities={(datedName) => dataSource?.archivedCapabilities(datedName) ?? Promise.resolve([])}
      loadDiscussionDocument={(slug) => dataSource?.getDiscussionDocument(slug) ?? Promise.resolve(null)}
      sourceDiscussions={archivedSourceDiscussions}
      onOpenDiscussion={(slug) => s.openArchived({ kind: "discussion", slug })}
      onOpenContextDiscussion={openAnyDiscussion}
      promotedChanges={archivedPromotedChanges}
      onOpenPromotedChange={openPromotedChange}
      reviewStatus={archivedItem?.reviewStatus}
      verifyStatus={archivedItem?.verifyStatus}
      discussionKind={archivedDiscussion?.kind}
      discussionTopic={archivedDiscussion?.topic}
      {...archivedProvenance}
      renderDocumentActions={renderDocumentActions}
      onOpenSpec={s.openSpec}
      pathReveal={pathReveal}
      changes={s.changes}
      archivedChanges={s.archived}
      specNames={specNames}
      discussionSlugs={discussionSlugs}
    />
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧（design D2）：图标列与项目栏共用一条 48px 标题列；零项目时只剩图标列 */}
      <div
        className={cn(
          "flex shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar",
          settingsMode || s.tabs.length > 0 ? "w-[256px]" : "w-14",
        )}
      >
        {/* 零项目且非设置模式时 56px 放不下文本（macOS 红绿灯也占住这段），标题列留白；
            设置模式左端为「← 设置」，项目设置模式左端为「← 项目设置」、右端为等宽项目名 */}
        <LeftTitleBar
          title={projectTab?.name}
          path={projectTab && tabPathHint(projectTab, connectionNames, t)}
          back={
            settingsMode || projectSettingsMode
              ? { label: t(settingsMode ? "app.settingsTitle" : "app.navProjectSettings"), onClick: goBack }
              : undefined
          }
          trailing={projectSettingsMode ? projectTab?.name : undefined}
          menu={
            projectTab && !projectSettingsMode ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("app.projectActions")}
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <ProjectActionItems
                    menu="dropdown"
                    tab={projectTab}
                    platform={platform}
                    actions={projectActions}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : undefined
          }
        />
        <div className="flex min-h-0 flex-1">
          <ProjectRail
            tabs={s.tabs}
            activeKey={s.activeKey}
            tabErrors={s.tabErrors}
            recoveryStates={s.remoteRecovery}
            connectionStates={sessionConnectionStates}
            connectionNames={connectionNames}
            pendingKey={s.pendingTabKey}
            assetPrompts={s.assetPrompts}
            platform={platform}
            actions={projectActions}
            onActivate={(key) => void s.activateTab(key)}
            onOpen={() => s.openWorkspaceChooser()}
            onOpenSettings={() => s.setBoardView("settings")}
            settingsActive={s.boardView === "settings"}
            updateButton={
              updater && <UpdateRailButton state={s.updater} onClick={s.openSettingsUpdate} />
            }
          />
          {settingsMode ? (
            <SettingsColumn section={s.settingsSection} onSelect={s.setSettingsSection} />
          ) : projectSettingsMode ? (
            <ProjectSettingsColumn
              section={projectSettingsSection}
              remote={remoteProject}
              configParseError={projectParseErrors.config}
              specsealParseError={projectParseErrors.specseal}
              onSelect={s.setProjectSettingsSection}
              notice={
                <AssetNoticeCard prompt={assetPromptNow} onOpen={() => setAssetDialogOpen(true)} />
              }
            />
          ) : (
            s.tabs.length > 0 && (
              <ProjectColumn
                boardView={s.boardView}
                archivedCount={s.archived.length}
                onNavigate={s.setBoardView}
                notice={
                  <AssetNoticeCard prompt={assetPromptNow} onOpen={() => setAssetDialogOpen(true)} />
                }
              />
            )
          )}
        </div>
      </div>

      {/* relative＋overflow-hidden：滑动返回指示定位在主区栏、裁掉左缘外那段；设置页的 main
          会卷动，指示不能放在 main 里 */}
      <DetailActionsSlotProvider value={actionsSlot}>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <MainTitleBar
          platform={platform}
          crumbs={crumbs}
          leading={
            pageOpen && s.boardView !== "settings" ? (
              <DetailBack
                page={t(PAGE_LABEL_KEY[s.boardView])}
                keys={platform === "macos" ? "⌘[" : "Alt+←"}
                onBack={goBack}
              />
            ) : undefined
          }
          trailing={
            pageOpen ? (
              <>
                <DetailNav index={detailIndex} total={detail?.sequence.length ?? 0} onStep={stepDetail} />
                <DetailActionsSlot ref={setActionsSlot} />
              </>
            ) : undefined
          }
        />

          {stale && connectionState && (
            <div
              role="status"
              data-testid="remote-stale-banner"
              data-connection-state={connectionState.state}
              className={cn(
                "flex min-h-10 shrink-0 items-center gap-2 border-b px-4 py-2",
                SEMANTIC_SURFACE.warning,
              )}
            >
              <CloudOff className={cn("h-4 w-4 shrink-0", SEMANTIC_TONE.warning)} />
              <div className="min-w-0 text-xs">
                <span className="font-semibold">
                  {connectionState.state === "needs-reauth"
                    ? t("remote.reauthTitle")
                    : t("remote.offlineTitle")}
                </span>
                <span className="ml-2 text-muted-foreground">
                  {connectionState.message ?? t("remote.staleHint")}
                </span>
              </div>
              <span className="ml-auto rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                stale
              </span>
              {connectionState.state === "needs-reauth" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 bg-background/80 text-xs"
                  onClick={() => s.openConnectionReauth(connectionState.connectionId)}
                >
                  {t("remote.reauthAction")}
                </Button>
              )}
            </div>
          )}

          {/* 主内容：看板、规格页、已封存页填满高度（清单于内部容器卷动、换页控
              制列沉底常驻）；设置页维持整页纵向卷动；手册页的三栏分隔线要贯穿
              主内容全高，padding 由 ManualPage 各栏自管。flex 直栏让各视图根节点
              （h-full min-h-0）填满主区；技能档提示住在项目栏，主区不为它扣高度 */}
          <main
            className={cn(
              "relative flex flex-1 flex-col",
              // 设置页各页自带内距（desktop-settings-mode design D5）。
              s.boardView === "manual" || isSettingsView(s.boardView) ? "p-0" : "p-5",
              isSettingsView(s.boardView) ? "overflow-y-auto" : "overflow-hidden",
            )}
          >
            {/* 宿主页（design D1）：详情页打开期间保持挂载但不可见、不可交互——卷动位置、
                搜索字符串与筛选原样保留，关页后即回到开页前的样子。 */}
            <div
              data-testid="host-page"
              inert={pageOpen || undefined}
              aria-hidden={pageOpen || undefined}
              className={cn("flex min-h-0 flex-1 flex-col", pageOpen && "invisible")}
            >
            {s.boardView === "settings" ? (
              <AppSettingsView
                section={s.settingsSection}
                platform={platform}
                localePref={localePref}
                onLocalePrefChange={onLocalePrefChange}
                themePref={themePref}
                onThemePrefChange={onThemePrefChange}
                trayPanelError={s.trayPanelError}
                servers={servers}
                updater={
                  updater && {
                    state: s.updater,
                    currentVersion,
                    onCheck: () => void s.checkForUpdates(true),
                    onShowReleaseNotes: (focusVersion) => setReleaseNotes({ mode: "browse", focusVersion }),
                    onAccept: () => void s.acceptUpdate(),
                    onCancel: s.dismissUpdate,
                    onRelaunch: () => void s.relaunchToUpdate(),
                    focus: s.focusUpdater,
                    onFocusHandled: s.clearFocusUpdater,
                    autoCheck: s.updaterAutoCheck,
                    onAutoCheckChange: s.setUpdaterAutoCheck,
                  }
                }
                cliInstall={
                  s.cliInstall
                    ? { view: s.cliInstall, onInstall: () => void s.installCli() }
                    : undefined
                }
                about={{ appInfo: s.appInfo, onLoadAppInfo: s.loadAppInfo, onOpenUpdates: s.openSettingsUpdate }}
              />
            ) : workspace !== undefined && s.tabs.length === 0 ? (
              // 零分页（首次使用）：项目范围页面落入空状态引导页（取代空看板）；应用程序设置已于上方先行处理。
              <EmptyWorkspace
                recents={visibleRecents(s.recents, s.tabs)}
                connections={s.connections}
                onRefreshConnections={s.refreshConnections}
                workspace={workspace}
                connectionAdapter={connections ?? DISABLED_CHOOSER_CONNECTIONS}
                onOpenLocal={s.openProjectAt}
                onOpenRemote={s.openRemoteWorkspace}
                onRemoveRecent={s.forgetRecent}
                onOpenChooser={s.openWorkspaceChooser}
              />
            ) : activeRecoveryTab && activeRecovery && activeRecoveryConnectionId ? (
              <RemoteWorkspaceRecovery
                tab={activeRecoveryTab}
                recovery={activeRecovery}
                connection={activeRecoveryConnection}
                onRetry={() => void s.retryRemoteWorkspace(locatorKey(activeRecoveryTab.locator))}
                onOpenSettings={() => s.openConnectionReauth(activeRecoveryConnectionId)}
                onReauthenticate={() => s.openConnectionReauth(activeRecoveryConnectionId)}
                onRemove={() => s.closeTab(locatorKey(activeRecoveryTab.locator))}
              />
            ) : s.boardView === "project-settings" && activeSession !== undefined ? (
              <ProjectSettingsView
                settings={activeSession.settings}
                section={projectSettingsSection}
                onParseErrors={setProjectParseErrors}
                onDirtyChange={onProjectSettingsDirty}
              />
            ) : s.boardView === "manual" ? (
              <ManualPage
                index={s.manual}
                loadPage={(slug) => dataSource?.getManualPage(slug) ?? Promise.resolve(null)}
                onOpenSpec={s.openSpec}
                capabilities={s.specs.map((spec) => spec.id)}
                refreshGen={s.refreshGen}
                renderDocumentActions={renderDocumentActions}
                locateDocument={locateDocument}
                loadSpec={(capability) => dataSource?.getSpecDocument(capability) ?? Promise.resolve(null)}
              />
            ) : s.boardView === "specs" ? (
              <SpecList
                title={t("app.navSpecs")}
                description={t("specs.pageDesc")}
                specs={s.specs}
                onOpen={s.openSpec}
                focus={s.detailSpec}
                pageSize={s.pageSizes.specs}
                onPageSizeChange={(size) => s.setPageSize("specs", size)}
                onVisibleOrderChange={(specs) => setVisibleOrder((v) => ({ ...v, specs }))}
              />
            ) : s.boardView === "board" ? (
              // 看板页的两种查看（desktop-roadmap design「路线图是看板页的一种查看」）：两者同时
              // 挂载、只显示 boardMode 指定的一个——卡片的卷动、搜索与筛选在切换间原样保留，
              // 详情页的 ‹ › 照旧依卡片顺序；两者吃同一份清单数据，不各自查找。
              <>
                <div
                  data-testid="board-cards"
                  hidden={s.boardMode !== "cards"}
                  inert={s.boardMode !== "cards" || undefined}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <KanbanBoard
                    viewSwitch={boardViewSwitch}
                    title={t("app.navChanges")}
                    description={t("board.pageDesc")}
                    changes={s.changes}
                    onOpenChange={s.openDetail}
                    onArchive={caps && !caps.archive ? undefined : s.requestArchive}
                    onRevert={s.requestRevert}
                    discussions={s.discussions}
                    archivedChanges={s.archived}
                    onOpenDiscussion={s.openDiscussion}
                    onArchiveDiscussion={
                      caps && !caps.archiveDiscussion ? undefined : s.requestArchiveDiscussion
                    }
                    query={s.boardQuery}
                    onQuery={s.setBoardQuery}
                    fulltextHits={s.searchHits}
                    searchUnavailableReason={
                      caps && !caps.searchWorkspace ? t("remote.searchUnavailable") : undefined
                    }
                    onRevealSearch={s.boardMode === "roadmap" ? focusBoardSearch : undefined}
                    onReorder={
                      caps?.reorderCard
                        ? (kind, id, prevId, nextId) => void s.reorderCard(kind, id, prevId, nextId)
                        : undefined
                    }
                    reorderUnavailableReason={
                      caps && !caps.reorderCard ? writeDisabledReason : undefined
                    }
                    planError={s.planError}
                    onDragActiveChange={handleBoardDragActive}
                    onVisibleOrderChange={(order) => setVisibleOrder((v) => ({ ...v, ...order }))}
                    promotedExpanded={s.promotedExpanded}
                    onPromotedExpandedChange={s.setPromotedExpanded}
                    loading={boardLoading}
                    // 首访失败的终态：读不到 ≠ 确认是空的，故不落回空态文案。已有旧
                    // 缓存（loaded）时照旧静默沿用最后成功快照，不显示提示。
                    loadFailed={boardLoadFailed}
                  />
                </div>
                <div
                  data-testid="board-roadmap"
                  hidden={s.boardMode !== "roadmap"}
                  inert={s.boardMode !== "roadmap" || undefined}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <RoadmapView
                    viewSwitch={boardViewSwitch}
                    title={t("app.navChanges")}
                    description={t("roadmap.pageDesc")}
                    changes={s.changes}
                    next={s.planNext}
                    unpromotedCuts={s.unpromotedCuts}
                    planError={s.planError}
                    discussions={s.discussions}
                    onOpenChange={s.openDetail}
                    onOpenDiscussion={s.openDiscussion}
                    loading={boardLoading}
                    loadFailed={boardLoadFailed}
                  />
                </div>
              </>
            ) : (
              <ArchivedList
                title={t("app.archived")}
                description={t("archived.pageDesc")}
                archived={s.archived}
                query={s.query}
                onQuery={s.setQuery}
                archivedDiscussions={s.discussions.archived}
                onOpen={s.openArchived}
                changesPageSize={s.pageSizes.archivedChanges}
                onChangesPageSizeChange={(size) => s.setPageSize("archivedChanges", size)}
                discussionsPageSize={s.pageSizes.archivedDiscussions}
                onDiscussionsPageSizeChange={(size) => s.setPageSize("archivedDiscussions", size)}
                onVisibleOrderChange={(order) =>
                  setVisibleOrder((v) => ({
                    ...v,
                    archivedChanges: order.changes,
                    archivedDiscussions: order.discussions,
                  }))
                }
              />
            )}
            </div>
            {/* 详情页层（design D1／D9）：覆盖主区，150ms 淡入＋4px 位移；关闭直接移除。 */}
            {detail && (
              <div
                ref={detailLayerRef}
                data-testid="detail-page"
                className="absolute inset-0 overflow-x-hidden overflow-y-auto bg-background animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out motion-reduce:animate-none"
              >
                {
                  {
                    change: changeDetailPage,
                    discussion: discussionDetailPage,
                    spec: specDetailPage,
                    archived: archivedDetailPage,
                  }[detail.kind]
                }
              </div>
            )}
          </main>
          {/* 触摸板滑动返回（design D8）：左缘「←」指示，过门槛放开即返回（去处同返回钮）。
              手指放开的信号只有 macOS 原生层提供，其他平台不提供（desktop-swipe-back-finger-lift D5）。 */}
          <SwipeBack enabled={platform === "macos" && backTarget(s) !== null} onBack={goBack} />
      </div>
      </DetailActionsSlotProvider>

      {workspace && (
        <WorkspaceChooser
          open={s.workspaceChooser !== null}
          onOpenChange={(isOpen) => !isOpen && s.closeWorkspaceChooser()}
          connections={s.connections}
          connectionAdapter={connections ?? DISABLED_CHOOSER_CONNECTIONS}
          workspace={workspace}
          onOpenLocal={s.openProjectAt}
          onRequestMigration={s.requestMigration}
          onAddServer={s.addConnection}
          phases={s.connectionPhases}
          onCancelLogin={s.cancelLogin}
          onSubmitPat={s.submitPat}
          onRefreshConnections={s.refreshConnections}
          onOpenRemote={s.openRemoteWorkspace}
          recents={visibleRecents(s.recents, s.tabs)}
          onRemoveRecent={s.forgetRecent}
          initialConnectionId={s.workspaceChooser?.initialConnectionId}
          initialServerUrl={s.workspaceChooser?.initialServerUrl}
          initialStep={s.workspaceChooser?.initialStep}
          initialScope={s.workspaceChooser?.initialScope}
          initialCheckoutPath={s.workspaceChooser?.initialCheckoutPath}
          defaultConnectionId={s.defaultConnectionId}
        />
      )}

      {workspace && migration && (
        <MigrationDialog
          open={s.migrationRoot !== null}
          root={s.migrationRoot ?? ""}
          connections={s.connections}
          connectionAdapter={connections ?? DISABLED_CHOOSER_CONNECTIONS}
          migration={migration}
          onOpenChange={(isOpen) => !isOpen && s.cancelMigration()}
          onMigrated={(connectionId, target, checkoutRoot) =>
            s.replaceLocalWorkspaceWithRemote(checkoutRoot, connectionId, target)
          }
        />
      )}

      {/* 技能档提示确认框（spec「指令档过期提示」）：三列信息、依状态的按钮；较新态的主
          动作改开设置页软件更新卡。 */}
      <AssetNoticeDialog
        open={assetDialogOpen}
        onOpenChange={setAssetDialogOpen}
        prompt={assetPromptNow}
        busy={s.assetUpdating}
        error={s.assetUpdateError}
        onApply={() => void s.applyAssetUpdate()}
        onDismiss={s.dismissAssetPrompt}
        onOpenSettingsUpdate={s.openSettingsUpdate}
        migrated={assetMigratedNow}
        onDone={() => {
          s.closeAssetMigrated();
          setAssetDialogOpen(false);
        }}
      />

      {updater && (
        <ReleaseNotesDialog
          open={releaseNotes !== null}
          mode={releaseNotes?.mode ?? "browse"}
          entries={releaseNotes?.mode === "whatsNew" ? releaseNotes.entries : RELEASE_NOTES}
          focusVersion={releaseNotes?.mode === "browse" ? releaseNotes.focusVersion : undefined}
          onOpenChange={(isOpen) => {
            if (isOpen) return;
            // 先关再写：写入失败不能把 modal 卡在画面上。
            const wasWhatsNew = releaseNotes?.mode === "whatsNew";
            setReleaseNotes(null);
            if (wasWhatsNew && currentVersion) writeLastSeenVersion(currentVersion);
          }}
        />
      )}

      <RemoteConflictDialog
        conflict={s.pendingRemoteConflict}
        onContinueLocal={s.continueLocalFromConflict}
        onUseServer={s.useServerFromConflict}
        onMigrateLocal={s.migrateLocalFromConflict}
      />

      {/* 初始化确认（写入型确认框：Radix 缺省焦点落在取消） */}
      <ConfirmDialog
        open={discardPrompt}
        onOpenChange={setDiscardPrompt}
        title={t("settings.discardTitle")}
        description={t("settings.discardHint")}
        confirmLabel={t("settings.discard")}
        destructive
        onConfirm={() => {
          setDiscardPrompt(false);
          useStore.getState().leaveSettings();
        }}
      />
      <ConfirmDialog
        open={s.pendingInit !== null}
        onOpenChange={(o) => !o && s.cancelInit()}
        title={t("app.initTitle")}
        description={<BoldName text={t("app.initDesc")} name={s.pendingInit ?? ""} />}
        confirmLabel={t("app.initConfirm")}
        onConfirm={() => s.confirmInit(initTools)}
      >
        <div className="flex gap-4">
          {BUILTIN_TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={initTools.includes(tool)}
                onCheckedChange={(v) =>
                  setInitTools((prev) =>
                    v === true ? [...prev, tool] : prev.filter((x) => x !== tool),
                  )
                }
              />
              {tool}
            </label>
          ))}
        </div>
      </ConfirmDialog>

      {/* 激活确认（spec「未激活文件夹经确认后补齐激活」；与初始化确认框同型、独立状态） */}
      <ConfirmDialog
        open={s.pendingAdopt !== null}
        onOpenChange={(o) => !o && s.cancelAdopt()}
        title={t("app.adoptTitle")}
        description={
          <>
            <BoldName text={t("app.adoptDesc")} name={s.pendingAdopt ?? ""} />
            {s.pendingAdoptImport && ` ${t("app.adoptImportNote")}`}
          </>
        }
        confirmLabel={t("app.adoptConfirm")}
        onConfirm={() => s.confirmAdopt(adoptTools)}
      >
        <div className="flex gap-4">
          {BUILTIN_TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={adoptTools.includes(tool)}
                onCheckedChange={(v) =>
                  setAdoptTools((prev) =>
                    v === true ? [...prev, tool] : prev.filter((x) => x !== tool),
                  )
                }
              />
              {tool}
            </label>
          ))}
        </div>
      </ConfirmDialog>

      {/* 讨论封存确认 */}
      <ConfirmDialog
        open={s.pendingArchiveDiscussion !== null}
        onOpenChange={(o) => !o && s.cancelArchiveDiscussion()}
        title={t("app.archiveDiscussionTitle")}
        description={
          <BoldName text={t("app.archiveDiscussionDesc")} name={s.pendingArchiveDiscussion ?? ""} />
        }
        confirmLabel={t("app.archiveConfirm")}
        confirmDisabled={caps !== undefined && !caps.archiveDiscussion}
        onConfirm={s.confirmArchiveDiscussion}
      />

      {/* 封存入口的未结工单三选项（spec「封存入口三选项扩及验证工单」）：目标
          change 该站工单未结时取代一般封存确认；未选择前不运行封存。remote
          项目同样适用；连到不回报关卡状态的旧版 Server 时清单项没有
          inReview／inVerify，走一般确认。 */}
      <ReviewArchiveDialog
        open={pendingArchiveStation !== null}
        change={s.pendingArchive}
        station={pendingArchiveStation ?? "review"}
        onOpenChange={(o) => !o && s.cancelArchive()}
        onGoStamp={() => {
          const name = s.pendingArchive;
          s.cancelArchive();
          if (name) s.openDetail(name);
        }}
        onDiscardReview={() =>
          void s.confirmArchiveDiscardTicket(pendingArchiveStation ?? "review")
        }
        onCarryReview={() => void s.confirmArchiveCarryTicket(pendingArchiveStation ?? "review")}
      />

      {/* 封存确认 */}
      <ConfirmDialog
        open={s.pendingArchive !== null && pendingArchiveStation === null}
        onOpenChange={(o) => !o && s.cancelArchive()}
        title={t("app.archiveTitle")}
        description={
          <>
            <BoldName text={t("app.archiveDesc")} name={s.pendingArchive ?? ""} />
            {remoteArchiveScope && (
              <span className="mt-2 block rounded-md border border-border bg-muted/45 px-2.5 py-2 font-mono text-xs text-foreground">
                {t("app.archiveRemoteScope").replace("{scope}", remoteArchiveScope)}
              </span>
            )}
          </>
        }
        confirmLabel={t("app.archiveConfirm")}
        confirmDisabled={caps !== undefined && !caps.archive}
        onConfirm={() => confirmDetailAction(s.confirmArchive)}
      />

      {/* 退回提案中确认：确认后直接调用引擎动词,UI 不预判守门。 */}
      <ConfirmDialog
        open={s.pendingRevert !== null}
        onOpenChange={(o) => !o && s.cancelRevert()}
        title={t("app.revertTitle")}
        description={<BoldName text={t("app.revertDesc")} name={s.pendingRevert ?? ""} />}
        confirmLabel={t("app.revertConfirm")}
        onConfirm={() => confirmDetailAction(s.confirmRevert)}
      />

      {/* 退回被守门挡下：列引擎证据与出路,无清理或强制退回的机械出路。 */}
      <RevertBlockedDialog info={s.revertBlocked} onClose={s.dismissRevertBlocked} />

      {/* 删除确认 */}
      <ConfirmDialog
        open={s.pendingDelete !== null}
        onOpenChange={(o) => !o && s.cancelDelete()}
        title={t("app.deleteTitle")}
        description={<BoldName text={t("app.deleteDesc")} name={s.pendingDelete ?? ""} />}
        confirmLabel={t("app.deleteConfirm")}
        destructive
        onConfirm={() => confirmDetailAction(s.confirmDelete)}
      />
    </div>
  );
}

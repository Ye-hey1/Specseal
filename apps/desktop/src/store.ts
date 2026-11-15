import { create, type StoreApi, type UseBoundStore } from "zustand";
import { toast } from "sonner";
import type {
  ArchivedTarget,
  BoardMode,
  CardKind,
  ChangeItem,
  ChangeListPayload,
  SpecItem,
  ArchivedItem,
  DiscussionItem,
  DiscussionLists,
  DocumentRef,
  ListView,
  ManualIndex,
  SearchHit,
  SpecsealDataSource,
  UnpromotedCutItem,
  Verb,
  AnalyzeReport,
  VerbDrawerResult,
} from "@specseal/ui";
import {
  PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  RevertBlockedError,
  emptyManualIndex,
  type RevertBlockedInfo,
} from "@specseal/ui";

import { appT } from "./i18n/runtime";
import type { ConnectionsAdapter, ConnectionView, LoginPhase } from "./adapter/connections";
import type { AssetUpdateResult, ProjectProbe, RemoteCheckout, WorkspaceAdapter } from "./adapter/workspace";
import type { MigrationAdapter } from "./adapter/migration";
import {
  applyRemoteConnectionState,
  locatorKey,
  normalizeRemoteOpenFailure,
  type RemoteConnectionStateEvent,
  type RemoteWorkspaceRecoveryState,
  type WorkspaceSession,
} from "./session";
import {
  persistTabs,
  readPersistedTabs,
  removeTab,
  upsertTab,
  type ProjectTab,
} from "./tabs";
import {
  persistRecents,
  readPersistedRecents,
  removeRecent,
  upsertRecent,
  type RecentEntry,
} from "./recents";
import {
  assetPrompt,
  readAssetSkips,
  writeAssetSkip,
  type AssetPromptState,
} from "./assetPrompt";
import type { TrayStyle } from "./tray";
import { detectPlatform } from "./platform";
import { projectDirOf, type DocumentLocation, type FsActionsAdapter } from "./adapter/fsActions";
import {
  focusRecheckAllowed,
  focusRecheckDue,
  initialUpdaterState,
  reduceUpdater,
  type UpdaterState,
} from "./core/updater";
import type { PendingUpdate, UpdaterAdapter } from "./adapter/updater";
import {
  cliDeployPlan,
  cliInstallStatus,
  isDirOnPath,
  needsRedeploy,
  parseCliVersion,
  zprofilePlan,
  type CliInstallStatus,
  type CliPlatform,
} from "./core/cliInstall";
import type { CliInstallAdapter } from "./adapter/cliInstall";
import type { AppInfo } from "./adapter/appInfo";
import type { ProjectSettingsSection, SettingsSection } from "./settingsCatalog";

const FAILURE_TOAST_ID = "desktop-operation-failure";
type FailureMessageKey =
  | "store.claimFailed"
  | "store.deleteFailed"
  | "store.archiveFailed"
  | "store.archiveAfterDiscardFailed"
  | "store.discardReviewFailed"
  | "store.archiveAfterDiscardVerifyFailed"
  | "store.archiveAfterDiscardBothFailed"
  | "store.discardVerifyFailed"
  | "store.reviewActionUnsupported"
  | "store.revertFailed"
  | "store.discussionArchiveFailed"
  | "store.reorderFailed"
  | "store.setDependsFailed"
  | "store.openProjectFailed"
  | "store.initFailed"
  | "store.adoptFailed"
  | "store.documentActionFailed";

/** error 缺席时不输出尾缀——消息本身已完整，且错误细节不得夹带工程词给用户。 */
function showFailureToast(subject: string, messageKey: FailureMessageKey, error?: unknown): void {
  const detail = error === undefined ? "" : ` ✗ ${String(error)}`;
  toast.error(`${subject} · ${appT(messageKey)}${detail}`, { id: FAILURE_TOAST_ID });
}

/** remote 拖排放开后的暂时可见序：只按 UI 已解析好的邻居移动，不理解 rank。 */
function moveBetweenNeighbors<T>(
  items: T[],
  itemId: (item: T) => string,
  id: string,
  prevId: string | null,
  nextId: string | null,
): T[] {
  const moving = items.find((item) => itemId(item) === id);
  if (!moving) return items;
  const remaining = items.filter((item) => itemId(item) !== id);
  const nextIndex = nextId === null ? -1 : remaining.findIndex((item) => itemId(item) === nextId);
  if (nextIndex >= 0) {
    return [...remaining.slice(0, nextIndex), moving, ...remaining.slice(nextIndex)];
  }
  const prevIndex = prevId === null ? -1 : remaining.findIndex((item) => itemId(item) === prevId);
  const insertAt = prevIndex >= 0 ? prevIndex + 1 : nextId !== null ? 0 : remaining.length;
  return [...remaining.slice(0, insertAt), moving, ...remaining.slice(insertAt)];
}

/** 主页面：变更看板（缺省）、规格页、手册页、已封存页、项目设置或应用程序设置。 */
export type BoardView = "board" | "specs" | "manual" | "archived" | "project-settings" | "settings";
type SettingsView = "project-settings" | "settings";
export const isSettingsView = (v: BoardView): v is SettingsView => v === "settings" || v === "project-settings";

/** 逐连接登录交互状态（desktop-connections；client-browser-login D9）：
 * patInput＝server 只收访问密钥或没有 device flow，就地收 PAT（规格 PAT
 * fallback）；awaitingApproval／awaitingBrowser＝等待设备核准／等待浏览器登录，
 * 由 Rust 经事件送来，承载设备码与验证网址或授权网址，以及截止时刻（倒数由
 * 呈现层以截止时刻计算）；notice＝非错误提示（如 PAT 注销后的帐号页撤销提醒）。 */
export type ConnectionPhase =
  | { kind: "idle" }
  | { kind: "busy" }
  | LoginPhase
  | { kind: "patInput"; error: string | null }
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string };

export interface WorkspaceChooserIntent {
  initialConnectionId?: string | null;
  initialServerUrl?: string | null;
  /** 既有 marker 缺工具选集时，预填 scope 让 chooser 直达 checkout 步骤。 */
  initialScope?: { projectKey: string; repoKey: string } | null;
  /** 既有 marker 缺工具选集时，预填 checkout 文件夹路径（chooser 直接 inspect）。 */
  initialCheckoutPath?: string | null;
  /** 空状态「连接 Server」入口：chooser 直接起始于 Server 步骤。 */
  initialStep?: "server";
}

/** 设置页 CLI 卡的呈现视图（core 判定的汇整结果）。 */
export interface CliInstallView {
  platform: CliPlatform;
  status: CliInstallStatus;
  /** 平台是否支持 app 内布署动作（macOS／AppImage）。 */
  canDeploy: boolean;
  /** 已布署但布署目录不在 PATH——接口提示加入方式。 */
  pathHint: boolean;
  /** 布署目录（提示文案用；不支持布署的平台为 null）。 */
  deployDir: string | null;
  /** 布署动作进行中。 */
  busy: boolean;
  /** 布署失败的单行错误（null＝无）。 */
  error: string | null;
}

export interface RemoteMarkerConflict {
  path: string;
  url: string;
  repo: string | null;
}

/** 看板讨论栏底「已转出」收合列的展开记忆键（desktop-board-reskin design D2）：
 * app 本机（localStorage）、值为 "true"／"false"，不写入任何项目目录。 */
export const PROMOTED_EXPANDED_STORAGE_KEY = "specseal.board.promotedExpanded";

/** 键缺席、坏值或 localStorage 不可用一律视为收合（false），不抛错。 */
function readPromotedExpanded(): boolean {
  try {
    return localStorage.getItem(PROMOTED_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** 清单每页笔数的记忆键（desktop-list-pages-reskin design D7）：app 本机（localStorage）、
 * 值为 JSON 对象，不写入任何项目目录。 */
export const PAGE_SIZES_STORAGE_KEY = "specseal.list.pageSizes";

/** 记住每页笔数的三个清单：规格页、已封存「变更」节与「讨论」节。 */
export type PageSizeList = "specs" | "archivedChanges" | "archivedDiscussions";
export type PageSizes = Record<PageSizeList, number>;

/** 逐栏读回：只接受 PAGE_SIZE_OPTIONS 内的值（0 会让总页数变无限大），其他一律 PAGE_SIZE。
 * 键缺席、坏 JSON、非对象或 localStorage 不可用都不抛错。 */
function readPageSizes(): PageSizes {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(PAGE_SIZES_STORAGE_KEY) ?? "null");
  } catch {
    // 坏 JSON 或 localStorage 不可用：当作没记过。
  }
  const record = saved !== null && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const pick = (list: PageSizeList) => {
    const value = record[list];
    return typeof value === "number" && PAGE_SIZE_OPTIONS.includes(value) ? value : PAGE_SIZE;
  };
  return { specs: pick("specs"), archivedChanges: pick("archivedChanges"), archivedDiscussions: pick("archivedDiscussions") };
}

/** 更新页「启动时在背景检查新版本」开关的记忆键（desktop-settings-mode design D6）：app 本机、
 * 值为 "true"／"false"；只有 "false" 关闭——键缺席、坏值或 localStorage 不可用都维持缺省开。 */
export const UPDATER_AUTO_CHECK_STORAGE_KEY = "specseal.updater.autoCheck";

function readUpdaterAutoCheck(): boolean {
  try {
    return localStorage.getItem(UPDATER_AUTO_CHECK_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** 添加远程项目时缺省使用的连接（desktop-settings-mode design D7）：app 本机、值为 connection id。
 * 指向的连接不存在或未登录时由添加项目对话框忽略，这里不验证。 */
export const DEFAULT_CONNECTION_STORAGE_KEY = "specseal.defaultConnection";

function readDefaultConnectionId(): string | null {
  try {
    return localStorage.getItem(DEFAULT_CONNECTION_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export interface AppState {
  changes: ChangeItem[];
  /** 清单 payload 的顶层 planError（依赖成环消息；null＝无成环或数据源不供）。 */
  planError: string | null;
  /** 清单 payload 的顶层 next（plan 的下一个；缺键、成环或 plan 不可得为 null）——路线图的「下一个」签。 */
  planNext: string | null;
  /** 清单 payload 的顶层 unpromotedCuts（缺键为空数组）——路线图的「尚未转出」栏。 */
  unpromotedCuts: UnpromotedCutItem[];
  specs: SpecItem[];
  archived: ArchivedItem[];
  /** 讨论两节（active 进看板第 0 栏、archived 进已封存页讨论节）。 */
  discussions: DiscussionLists;
  loaded: boolean;
  /** 活跃 workspace 有整批 refresh 在途——由在途计数导出，不手动记帐（design D2）。
   * 与 loaded 搭配才是骨架的条件：loaded 只说「有没有真值」，读取失败时它维持
   * false（读不到 ≠ 确认是空的），骨架的终止由此旗标负责。
   * 首访后 loaded 恒为 true，故监看触发的周期性刷新不会再让骨架闪现。 */
  loadingActive: boolean;
  /** 活跃 workspace 最近一次整批加载以失败收场（design D4）。与 loaded 搭配才是
   * 首访失败终态：`!loaded && loadFailed` 才显示加载失败提示——已有旧缓存的
   * workspace 重载失败照旧静默沿用最后成功快照。成功加载即归 false。 */
  loadFailed: boolean;
  /** 刷新世代——每次整批 refresh 完成后递增；内容组件据此重载已加载的文档。 */
  refreshGen: number;
  /** 手册索引（desktop-manual-page）：只在手册视图活跃时读取与重取；null＝尚未加载
   * （骨架）。切换分页即清空——索引属于当时的 workspace。 */
  manual: ManualIndex | null;

  boardView: BoardView;
  /** 看板页显示哪一种查看：app 层级、启动时为 cards、不写入任何文件；详情页开关不动它。 */
  boardMode: BoardMode;
  /** 应用程序设置的所在分类（desktop-settings-mode design D1）：切回设置模式时沿用上次分类。 */
  settingsSection: SettingsSection;
  /** 项目设置的所在分类；远程项目无 .specseal.yaml 页，呈现端退回项目说明。 */
  projectSettingsSection: ProjectSettingsSection;
  /** 两种设置模式的返回去处：进入设置前所在的页面（两种设置模式之间切换不改写）。 */
  settingsReturnView: Exclude<BoardView, SettingsView>;
  view: ListView;
  query: string;
  /** 看板搜索字符串——与已封存页的 query 各自独立；不持久化、不跨启动保留（spec）。 */
  boardQuery: string;
  /** 讨论栏底「已转出」收合列的展开状态（design D2）：初值自 app 本机键读，跨启动保留。 */
  promotedExpanded: boolean;
  /** 清单每页笔数（design D7）：初值自 app 本机键读，三个清单各自跨启动保留。 */
  pageSizes: PageSizes;
  /** 看板全文查找命中（design D6）：去抖后由 searchWorkspace 回填；空 query 恒空。 */
  searchHits: SearchHit[];
  expandedName: string | null;

  /** 详情抽屉当前的 change（null=关闭）。 */
  detailChange: ChangeItem | null;
  /** 讨论抽屉当前的讨论（null=关闭）。 */
  detailDiscussion: DiscussionItem | null;
  /** 规格抽屉当前的 capability id（null=关闭；spec-archive-drawer design D2）。 */
  detailSpec: string | null;
  /** 封存抽屉当前目标（封存变更或封存讨论；null=关闭）。 */
  detailArchived: ArchivedTarget | null;

  pendingArchive: string | null;
  /** 封存守门已处置完的品质站（spec「封存入口三选项扩及验证工单」）：双工单
   * 并存时用户须对两站分别处置，处置完的站记在这里，才不会再弹一次。
   * 「照样带走」的站同时记进 `pendingArchiveCarry`。 */
  pendingArchiveSettled: { review: boolean; verify: boolean };
  /** 已选择「照样带走」的站——全部处置完后一次随封存上路。 */
  pendingArchiveCarry: { review: boolean; verify: boolean };
  pendingDelete: string | null;
  /** 待确认的退回提案中（change 名）。 */
  pendingRevert: string | null;
  /** 退回被守门挡下的证据（null＝无对话框）。 */
  revertBlocked: RevertBlockedInfo | null;
  /** 待确认的讨论归档（slug）。 */
  pendingArchiveDiscussion: string | null;
  /** 变更详情页内呈现的 validate／analyze 结构化结果（keyed by change）；null=无。 */
  detailVerb: VerbDrawerResult | null;

  refresh: () => Promise<void>;
  /** 监看重挂（事件驱动）：workspace-changed 后重解析监看目标——worktree 增减
   * 会改变监看拓扑；Rust 端目标集合不变时沿用原监看，故可放心每次事件都叫。有 checkout 的
   * remote 分页挂的是 checkout 的技能档监看；没有 checkout 的 remote 分页不挂。 */
  rearmWatch: () => Promise<void>;
  /** 重取手册索引：切到手册视图时、以及手册视图活跃下的每次整批 refresh
   * （workspace-changed 沿用同一条路，不添加监看目标）；交错回应以最新为准。 */
  refreshManual: () => Promise<void>;
  setBoardView: (v: BoardView) => void;
  setBoardMode: (mode: BoardMode) => void;
  /** 开路线图（specseal://roadmap 网址）：切回看板页、离开详情页并显示路线图，与 openDetail 一样收掉
   * 可取消浮层；不可取消浮层打开中不改任何状态。 */
  openRoadmap: () => void;
  /** 显示看板（specseal://project 网址）：切回看板页、离开详情页并固定显卡片查看，与 openDetail 一样收掉
   * 可取消浮层；不可取消浮层打开中不改任何状态。 */
  openBoard: () => void;
  /** 离开设置模式，回到 settingsReturnView。 */
  leaveSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  setProjectSettingsSection: (section: ProjectSettingsSection) => void;
  setView: (v: ListView) => void;
  setQuery: (q: string) => void;
  setBoardQuery: (q: string) => void;
  /** 写回同一个 app 本机键（"true"／"false"）。 */
  setPromotedExpanded: (expanded: boolean) => void;
  /** 改一个清单的每页笔数，并把整组值写回同一个 app 本机键。 */
  setPageSize: (list: PageSizeList, size: number) => void;
  /** 生命周期清理：取消在途搜索去抖 timer 并作废在途回填——由拥有此 store 的
   * 组件卸载时调用，杜绝去抖在 store 卸载后才开火（否则漏出的 timer 会异步触发）。 */
  disposeSearch: () => void;
  toggleExpand: (name: string) => void;
  openDetail: (name: string) => void;
  openDiscussion: (slug: string) => void;
  openSpec: (capability: string) => void;
  openArchived: (target: ArchivedTarget) => void;
  /** 关闭详情页回宿主页（Esc、面包屑、‹ › 失效时共用）：一次清空四个详情字段与 detailVerb。 */
  closeDetailPage: () => void;
  requestArchive: (name: string) => void;
  confirmArchive: () => Promise<void>;
  cancelArchive: () => void;
  /** 三选项「放弃审查／放弃验证」：先删该站工单，再处置下一站或封存。 */
  confirmArchiveDiscardTicket: (station: "review" | "verify") => Promise<void>;
  /** 三选项「照样带走」：记下该站的带走决定，再处置下一站或封存
   * （--carry-review／--carry-verify，永久显示「曾审查／曾验证未通过」）。 */
  confirmArchiveCarryTicket: (station: "review" | "verify") => Promise<void>;
  requestDelete: (name: string) => void;
  confirmDelete: () => Promise<void>;
  cancelDelete: () => void;
  /** 认领一个 change（RemoteOnly）；失败以 toast 呈现 server 消息。 */
  claimChange: (name: string) => Promise<void>;
  requestRevert: (name: string) => void;
  confirmRevert: () => Promise<void>;
  cancelRevert: () => void;
  /** 关闭守门对话框（唯一出路——不提供清理或强制退回）。 */
  dismissRevertBlocked: () => void;
  requestArchiveDiscussion: (slug: string) => void;
  confirmArchiveDiscussion: () => Promise<void>;
  cancelArchiveDiscussion: () => void;
  runVerb: (verb: Verb, change: string) => Promise<void>;
  /** 收合变更详情页的分析结果（再按分析或面板关闭钮）。 */
  clearDetailVerb: () => void;
  /** 看板拖排写回：把卡片排到两邻居之间（null＝栏顶／栏底）；失败以 toast 呈现。 */
  reorderCard: (kind: CardKind, id: string, prevId: string | null, nextId: string | null) => Promise<void>;
  /** 调度分页的前置添加／移除：写回后刷新看板；引擎拒绝以 toast 呈现其消息。 */
  setDepends: (change: string, on: string[], remove: boolean) => Promise<void>;

  // --- workspace／项目分页列（注入 workspace adapter 时生效；design D3/D10/D11） ---
  /** 分页清单（打开顺序；持久化于 app 本机）。分页身分＝locator（workspace-session 决策 1）。 */
  tabs: ProjectTab[];
  /** session 集（locatorKey 为键；workspace-session 决策 6）——数据加载一律经活跃 session。 */
  sessions: Record<string, WorkspaceSession>;
  /** Rust connection 状态事件套用至同 connection 的所有 remote sessions。 */
  applyRemoteConnectionState: (event: RemoteConnectionStateEvent) => void;
  /** session 事件订阅世代；重新认证完成后递增，让 active worker 解除再重挂。 */
  sessionEpoch: number;
  /** 目前 active 分页的 locator key（null＝零分页空状态）。 */
  activeKey: string | null;
  /** 探测进行中的目标分页 key（design D1）：本地分页的 openProject 挡在翻页前，
   * 期间画面仍停在原 workspace——此键让分页列标出「正在切过去」。null＝无切换。 */
  pendingTabKey: string | null;
  /** 待确认的初始化目录（uninitialized 判定触发；null＝无对话框）。 */
  pendingInit: string | null;
  /** 待确认的激活项目根（unadopted 判定触发、锚定探测回报 root；null＝无对话框）。 */
  pendingAdopt: string | null;
  /** 待确认的激活会先把 openspec/ 改名为 specseal/（desktop-spec-dir-migration D3）；
   * 只在 pendingAdopt 有值时有意义。 */
  pendingAdoptImport: boolean;
  /** 失效分页错误（locator key → 单行消息）。 */
  tabErrors: Record<string, string>;
  /** 最近打开清单（design D1）：曾成功打开过的 workspace，最新在前，与分页列分离。 */
  recents: RecentEntry[];
  /** 自最近打开清单移除一笔（状态与 localStorage 同步）。 */
  forgetRecent: (key: string) => void;
  /** 尚无 session 的 remote 分页复原状态；运行期限定、不持久化。 */
  remoteRecovery: Record<string, RemoteWorkspaceRecoveryState>;
  /** null＝chooser 关闭；对象承载服务器页或 remote marker 的预选意图。 */
  workspaceChooser: WorkspaceChooserIntent | null;
  openWorkspaceChooser: (intent?: WorkspaceChooserIntent) => void;
  closeWorkspaceChooser: () => void;
  /** local openspec/ 与 remote marker 并存时的强制选择。 */
  pendingRemoteConflict: RemoteMarkerConflict | null;
  continueLocalFromConflict: () => Promise<void>;
  useServerFromConflict: () => Promise<void>;
  migrateLocalFromConflict: () => Promise<void>;
  cancelRemoteConflict: () => void;
  /** 正式迁移对话框的本机来源 root。 */
  migrationRoot: string | null;
  requestMigration: (root: string) => Promise<void>;
  cancelMigration: () => void;
  /** 打开项目（dialog 或还原路径）：三态分流。进入本机项目、整批加载成功、且加载完成时
   * 它仍是活跃分页，才回传该分页的 locator key；其余（未初始化、未激活、remote 标记、
   * 探测或加载失败、加载期间已切走）为 null。remoteViaChooser：remote 标记一律改开选择器，
   * 不自动同步、不自动连接（specseal 网址入口，确认前零写入）。 */
  openProjectAt: (path: string, options?: { remoteViaChooser?: boolean }) => Promise<string | null>;
  /** 打开 remote workspace（remote-data-source 决策 6）：handshake 成功才建
   * session 与分页并切至看板；失败上抛、由打开表单就地呈现。第四参数
   * dropLocalRoot 供本机文件夹转 remote 的路径移除同一文件夹的 local 最近
   * 打开条目（design D2：同一文件夹不留两笔）。 */
  openRemoteWorkspace: (
    connectionId: string,
    target: string,
    checkoutRoot?: string,
    dropLocalRoot?: string,
  ) => Promise<void>;
  /** 正式迁移完成后，以同 checkoutRoot 的 remote session 原地取代 local 分页。 */
  replaceLocalWorkspaceWithRemote: (
    root: string,
    connectionId: string,
    target: string,
  ) => Promise<void>;
  /** 开文件夹选择器再走 openProjectAt；取消即无事。 */
  openProjectViaDialog: () => Promise<void>;
  /** 点分页（locator key）：remote 无 session 时先选取并进 restoring，失败留在复原页。 */
  activateTab: (key: string) => Promise<void>;
  /** 对既有 remote recovery 分页原地重走 handshake，不改主窗口焦点。 */
  retryRemoteWorkspace: (key: string) => Promise<void>;
  /** 由 Tray 显式打开问题详情：选取既有 recovery destination，但不隐含重试。 */
  showRemoteWorkspaceRecovery: (key: string) => void;
  closeTab: (key: string) => void;
  /** 项目层文件系统动作（design D5）：作用于本机根或 remote checkout；无本机目录时不动作。
   * 成功静默、失败 toast（i18n 键查表，否则原文）。 */
  revealProject: (key: string) => Promise<void>;
  openProjectInTerminal: (key: string) => Promise<void>;
  openProjectInEditor: (key: string) => Promise<void>;
  copyProjectPath: (key: string) => Promise<void>;
  /** 详情页「打开 ▾」的文档定位（design D4）：活跃项目有本机目录时由 core 解析磁盘位置
   * （与读文档同一套：worktree 副本、spec 目录名、已封存讨论）；remote 无 checkout、
   * 查不到或 core 回报错误时为 null。 */
  locateDocument: (doc: DocumentRef) => Promise<DocumentLocation | null>;
  /** 对已定位文档的动作：成功静默、失败以失败 toast 呈现（主词为相对路径）。 */
  openDocumentDefault: (location: DocumentLocation) => Promise<void>;
  revealDocument: (location: DocumentLocation) => Promise<void>;
  copyDocumentPath: (location: DocumentLocation) => Promise<void>;
  /** 把分页已加载的文档原文写入剪贴板（remote 无 checkout 时唯一的文档动作）；失败同上。 */
  copyDocumentContent: (text: string) => Promise<void>;
  /** 在文件管理员显示活跃项目内的相对路径（提案影响段的路径签）：没有本机目录时不动作；
   * 失败以失败 toast 呈现（主词为相对路径）。 */
  revealProjectPath: (relative: string) => Promise<void>;
  confirmInit: (tools: string[]) => Promise<void>;
  cancelInit: () => void;
  confirmAdopt: (tools: string[]) => Promise<void>;
  cancelAdopt: () => void;
  /** 启动：还原持久化分页、依持久化 activeKey 切回最后活跃项目（完成即 resolve）；
   * 背景 local 分页各探测一次路径有效性，不等它们完成。 */
  restoreTabs: () => Promise<void>;
  /** Ctrl+Tab：循环切至下一分页（走打开项目语意）。 */
  cycleTab: () => Promise<void>;
  /** Ctrl+1..9：直达第 N 个分页（1-based；超界不动作）。 */
  gotoTab: (n: number) => Promise<void>;

  // --- 技能档过期提示（desktop-instruction-staleness-prompt；决策 4/6/7） ---
  /** 各分页上次探测的提示（locator key → 值；null＝不提示：现版、无法判定或已略过同版）。
   * 只在分页活跃时探测，切走后保留上次结果供图标列琥珀点用；活跃分页的提示以
   * `selectAssetPrompt` 推算（desktop-notice-relocation design D1）。 */
  assetPrompts: Record<string, AssetPromptState | null>;
  /** 更新失败的单行消息（呈现于提示原位、可重试）；成功或重查即清空。 */
  assetUpdateError: string | null;
  /** 更新进行中（动作停用、避免重复触发）。 */
  assetUpdating: boolean;
  /** 上次更新的规格文件夹迁移结果与套用它的分页（确认框的完成态；desktop-spec-dir-migration
   * D2）；null＝没有待读的完成态。以 `selectAssetMigrated` 取活跃分页的那一份，关框才清空。 */
  assetMigrated: (AssetUpdateResult["migrated"] & { key: string }) | null;
  /** 对活跃本地分页重跑探测并裁决是否提示；remote 分页与无 adapter 时无动作。 */
  refreshAssetPrompt: () => Promise<void>;
  /** 主动作（更新／安装）：经引擎既有再生入口整套再生，成功后重查。按下前重探一次：
   * 迁移状态与确认框所写的不同时不更新，改显示最新内容。 */
  applyAssetUpdate: () => Promise<void>;
  /** 收起确认框的迁移完成态。 */
  closeAssetMigrated: () => void;
  /** 保留现状：记下此项目已略过当前产物层版号并收合提示，不写入项目任何文件。 */
  dismissAssetPrompt: () => void;

  // --- 自动更新（desktop-app「桌面自动更新」；design D6） ---
  /** 更新状态机现值（core/updater reducer 驱动；运行期状态、不持久化）。 */
  updater: UpdaterState;
  /** 检查更新（manual＝手动入口）：自动失败静默、手动失败浮出无法检查。 */
  checkForUpdates: (manual: boolean) => Promise<void>;
  /** 关于页的版本信息（desktop-about-page design D1）；null＝尚未取得或取得失败。 */
  appInfo: AppInfo | null;
  /** 首次进关于页时取得并缓存：已取得或取得中不重取；失败维持 null，下次进页再取。 */
  loadAppInfo: () => Promise<void>;
  /**
   * 主窗口回到前景时的重检（desktop-app「回到前景逾一小时即重检」）：距上次
   * 检查（自动或手动皆计）满 1 小时才走自动检查；now 未给时取现在时刻。
   */
  recheckOnFocus: (now?: number) => Promise<void>;
  /** 用户同意：下载并套用；签章验证失败转错误态、既有安装不受影响。 */
  acceptUpdate: () => Promise<void>;
  /** 用户稍后：回闲置、不下载。 */
  dismissUpdate: () => void;
  /** 套用完成后重启为新版。 */
  relaunchToUpdate: () => Promise<void>;
  /** 设置页软件更新卡的聚焦旗标（图标列更新钮、toast「查看」、较新态「更新 Specseal」举旗；
   * AppSettingsView 卷到卡后清回 false）。运行期状态、不持久化。 */
  focusUpdater: boolean;
  /** 进设置模式的更新页并聚焦（desktop-settings-mode design D1／D6）。 */
  openSettingsUpdate: () => void;
  clearFocusUpdater: () => void;
  /** 启动时与回到前景的背景检查开关（缺省开、存 app 本机）：关闭时两者都不发出，手动检查照常。 */
  updaterAutoCheck: boolean;
  setUpdaterAutoCheck: (on: boolean) => void;

  // --- 安装 CLI 指令（desktop-app「安装 CLI 指令到 PATH」；design D5） ---
  /** CLI 布署状态视图（null＝尚未探测或无 adapter；运行期状态、不持久化）。 */
  cliInstall: CliInstallView | null;
  /** 探测状态并运行 AppImage 版本不符的启动自我修复；App 启动与动作后调用。 */
  refreshCliInstall: () => Promise<void>;
  /** 显式布署动作（macOS symlink／AppImage 拷贝；其余平台为 no-op）。 */
  installCli: () => Promise<void>;

  // --- 系统匣样式（平台决定；tray 接线层订阅分流） ---
  /** 系统匣样式现值：macOS 与 Windows＝panel、Linux＝native-menu；运行期状态、不持久化。 */
  trayStyle: TrayStyle;
  /** 面板创建失败的单行错误（设置页本机设置签以独立警示行浮出）。 */
  trayPanelError: string | null;
  /** 面板创建失败的退回（spec：退回原生菜单并浮出单行错误）。 */
  panelFallback: (message: string) => void;

  // --- server 连接（desktop-connections）：app 全域、不经 session 绑定 ---
  /** saved servers 清单（registry 查看＋由 Keychain 推导的登录状态）。 */
  connections: ConnectionView[];
  /** 逐连接交互状态（keyed by origin；运行期状态、不持久化）。 */
  connectionPhases: Record<string, ConnectionPhase>;
  /** needs-reauth 导向服务器页时要聚焦的 connection id。 */
  reauthConnectionId: string | null;
  openConnectionReauth: (connectionId: string) => void;
  /** 添加远程项目时缺省使用的连接（null＝不预选；存 app 本机）。 */
  defaultConnectionId: string | null;
  setDefaultConnectionId: (connectionId: string | null) => void;
  /** 重整连接清单。回传读取是否成功——失败时清单保留现值，调用端据此区分
   * 「清单真的空」与「读不到」（chooser 的最近打开列靠它判定连接已移除）。 */
  refreshConnections: () => Promise<boolean>;
  /** 添加（同 origin 即更新显示名）并随即开始登录（决策 7）；登录不等到终态——
   * 等待面要在登录进行中就地显示。无效输入上抛、由表单就地呈现。回传范式
   * origin（决策三——供发起登录的接口追踪该连接的交互状态）；无 adapter 时回 null。 */
  addConnection: (baseUrl: string, name: string) => Promise<string | null>;
  /** 登录到终态：途中的等待阶段原样放进 connectionPhases；需要访问密钥时转
   * patInput、连接错误浮为可读状态。 */
  loginConnection: (origin: string) => Promise<void>;
  /** 取消等待中的登录：通知 Rust 结束等待、立即回未登录。 */
  cancelLogin: (origin: string) => void;
  /** PAT 单次过境提交；无效 PAT 留在输入面并就地浮错。 */
  submitPat: (origin: string, pat: string) => Promise<void>;
  logoutConnection: (origin: string) => Promise<void>;
  /** 移除连接（Rust 侧先注销再删条目——决策 6）。 */
  removeConnection: (id: string) => Promise<void>;
}

type WorkspaceSnapshot = Pick<
  AppState,
  | "changes"
  | "planError"
  | "planNext"
  | "unpromotedCuts"
  | "specs"
  | "archived"
  | "discussions"
  | "loaded"
  | "loadFailed"
>;

type CliProbe = Awaited<ReturnType<CliInstallAdapter["probe"]>>;

/** 探测结果 → 三态判定（版本解析与比对归 core）。 */
function statusFromProbe(probe: CliProbe): CliInstallStatus {
  const deployed = probe.deployedVersionOutput
    ? parseCliVersion(probe.deployedVersionOutput)
    : null;
  return cliInstallStatus(deployed, probe.appVersion);
}

/** 探测＋判定 → 设置页 CLI 卡视图（PATH 提示只对 ~/.local/bin 布署平台）。 */
function cliViewFrom(probe: CliProbe, status: CliInstallStatus): CliInstallView {
  const deploysToLocalBin = probe.platform === "macos" || probe.platform === "linux-appimage";
  const deployDir = deploysToLocalBin && probe.home ? `${probe.home}/.local/bin` : null;
  return {
    platform: probe.platform,
    status,
    canDeploy: deployDir !== null && probe.bundledCliPath !== null,
    pathHint:
      deployDir !== null &&
      status.kind !== "not-installed" &&
      !isDirOnPath(deployDir, probe.pathEnv, probe.pathDelimiter),
    deployDir,
    busy: false,
    error: null,
  };
}

/** createAppStore 的注入面（workspace-session 决策 6）：session 工厂取代全域
 * dataSource；workspace 为探测面（开项目／init／统计／选文件夹／监看重挂）。 */
export interface AppStoreDeps {
  /** local session 工厂（root、显示名）；测试注入假 session。 */
  createSession: (root: string, name: string) => WorkspaceSession;
  /** remote session 工厂（remote-data-source 决策 6/7）：以 connectionId 与
   * workspace 识别（project 或 project/repo）走 handshake，成功回 session、
   * 失败上抛——未注入时 remote 打开入口不激活。 */
  openRemote?: (
    connectionId: string,
    target: string,
    checkoutRoot?: string,
  ) => Promise<WorkspaceSession>;
  /** workspace 探测面；未注入时对应 UI 不激活。 */
  workspace?: WorkspaceAdapter;
  /** server 连接面（desktop-connections）；未注入时服务器页签不激活。 */
  connections?: ConnectionsAdapter;
  /** local→remote 迁移与「采用 server」本机备份面。 */
  migration?: MigrationAdapter;
  /** 自动更新面（tauri-plugin-updater 委派）；未注入时更新入口不激活。 */
  updater?: UpdaterAdapter;
  /** CLI 布署面（探测与计划运行）；未注入时安装 CLI 卡不激活。 */
  cliInstall?: CliInstallAdapter;
  /** 项目层文件系统动作面（design D5）；未注入时四个动作不动作。 */
  fsActions?: FsActionsAdapter;
  /** 关于页的版本信息来源（Tauri `app_info`）；未注入时版本列显示「—」。 */
  loadAppInfo?: () => Promise<AppInfo>;
}

/**
 * 待封存 change 上还没处置的品质站工单（spec「封存入口三选项扩及验证工单」）。
 * 顺序固定：审查站在前、验证站在后——双工单并存时弹框顺序不随数据抖动。
 * 两站都已处置、或本就无未结工单时回 null（走一般封存确认）。
 */
export function openTicketStation(
  changes: ChangeItem[],
  change: string,
  settled: { review: boolean; verify: boolean },
): "review" | "verify" | null {
  const item = changes.find((c) => c.name === change);
  if (!item) return null;
  if (!settled.review && item.reviewStatus === "inReview") return "review";
  if (!settled.verify && item.verifyStatus === "inVerify") return "verify";
  return null;
}

/** 封存守门的闲置状态：无待封存目标，两站都未处置、未带走。 */
function idleArchiveGate(): Pick<AppState, "pendingArchive" | "pendingArchiveSettled" | "pendingArchiveCarry"> {
  return {
    pendingArchive: null,
    pendingArchiveSettled: { review: false, verify: false },
    pendingArchiveCarry: { review: false, verify: false },
  };
}

/**
 * 可取消浮层的归零片段（spec「detail 抽屉互斥」）：变更详情与讨论抽屉打开时展开
 * 进同一次 set，语意等同用户按各浮层的「取消」或「关闭」。站别处置随封存守门
 * 一起还原，下一次封存入口不沿用上一轮。之后添加可取消浮层只改这里。
 */
function cancelableOverlaysCleared(): Partial<AppState> {
  return {
    workspaceChooser: null,
    pendingInit: null,
    pendingAdopt: null,
    pendingAdoptImport: false,
    ...idleArchiveGate(),
    pendingArchiveDiscussion: null,
    pendingDelete: null,
    pendingRevert: null,
    revertBlocked: null,
  };
}

/** 不可取消浮层（迁移、远程冲突）打开中——变更详情与讨论的打开动作此时不改任何状态；
 * specseal 网址（deepLink.ts）此时也不切换项目。 */
export function uncancelableOverlayOpen(s: Pick<AppState, "migrationRoot" | "pendingRemoteConflict">): boolean {
  return s.migrationRoot !== null || s.pendingRemoteConflict !== null;
}

/** 活跃项目清单中的变更——openDetail 与 specseal 网址共用的查找。 */
export function findChange(s: Pick<AppState, "changes">, name: string): ChangeItem | undefined {
  return s.changes.find((x) => x.name === name);
}

/** 活跃项目清单中的讨论（进行中先于已封存）——openDiscussion 与 specseal 网址共用的查找。 */
export function findDiscussion(
  s: Pick<AppState, "discussions">,
  slug: string,
): AppState["discussions"]["active"][number] | undefined {
  return s.discussions.active.find((x) => x.slug === slug) ?? s.discussions.archived.find((x) => x.slug === slug);
}

/** 活跃分页的迁移完成态：更新途中切走的分页，切回来才显示。 */
export function selectAssetMigrated(
  state: Pick<AppState, "activeKey" | "assetMigrated">,
): AppState["assetMigrated"] {
  return state.assetMigrated && state.assetMigrated.key === state.activeKey ? state.assetMigrated : null;
}

/** 活跃分页的技能档提示：`assetPrompts[activeKey]` 的推算值（null＝不提示）。 */
export function selectAssetPrompt(
  state: Pick<AppState, "activeKey" | "assetPrompts">,
): AssetPromptState | null {
  return state.activeKey ? (state.assetPrompts[state.activeKey] ?? null) : null;
}

/**
 * 创建 app 状态 store（Zustand）。状态集中此处、留在 apps/desktop；共用组件
 * （packages/ui）不依赖 store，仍经 props 取数据——守住数据源解耦。数据加载
 * 一律经活跃 session 的 dataSource（单活跃加载语意不变）。
 */
export function createAppStore(deps: AppStoreDeps): UseBoundStore<StoreApi<AppState>> {
  const {
    createSession,
    openRemote,
    workspace,
    connections: connectionsAdapter,
    migration,
    updater: updaterAdapter,
    cliInstall: cliInstallAdapter,
    fsActions: fsActionsAdapter,
    loadAppInfo: fetchAppInfo,
  } = deps;
  return create<AppState>((set, get) => {
    /** 切回看板页、离开详情页并显示指定的查看，同时收掉可取消浮层；不可取消浮层打开中不改任何状态。 */
    const showBoardMode = (boardMode: BoardMode) => {
      if (uncancelableOverlayOpen(get())) return;
      get().setBoardView("board");
      set({ boardMode, ...cancelableOverlaysCleared() });
    };
    /** 分页的本机目录：local 为项目根、remote 为 checkout；remote 无 checkout 时为 null。 */
    const localDirOf = (key: string | null): string | null => {
      const tab = get().tabs.find((entry) => locatorKey(entry.locator) === key);
      return tab ? projectDirOf(tab.locator) : null;
    };
    /** 对分页的本机目录运行文件系统动作；remote 无 checkout 时没有本机目录、不动作。 */
    const runOnProjectDir = async (
      key: string,
      action: "reveal" | "openTerminal" | "openEditor" | "copyText",
    ) => {
      const dir = localDirOf(key);
      if (!fsActionsAdapter || dir === null) return;
      try {
        await fsActionsAdapter[action](dir);
      } catch (e) {
        // appT 对未知键回原字符串：i18n 键（fs.noEditor）查表、opener 原文照旧。
        toast.error(appT(String(e)));
      }
    };
    /** 文档动作的单槽失败 toast：i18n 键（fs.notDocument）查表、opener 原文照旧。 */
    const runOnDocument = async (subject: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (e) {
        showFailureToast(subject, "store.documentActionFailed", appT(String(e)));
      }
    };
    // 全文查找的去抖与 latest-wins 状态（design D6）——闭包层、不进 store state。
    let searchSeq = 0;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    // check 找到的待套用更新（承载 plugin 的下载句柄）——闭包层、不进 store state。
    let pendingUpdate: PendingUpdate | null = null;
    // 上次真正进入检查中的时刻（前景重检的节流依据；design D2）——闭包层、不持久化。
    let lastCheckedAt: number | null = null;
    // 关于页版本信息的取得中 promise：并发进页只发一次。
    let appInfoInFlight: Promise<void> | null = null;
    // 已以 toast 提示过的目标版本（desktop-notice-relocation design D4：同一版本于 app 运行期间
    // 只发一次）——闭包层、运行期记忆、不持久化。
    let notifiedVersion: string | null = null;
    // 最后一次 CLI 布署探测（installCli 取 home 与 sidecar 路径）——闭包层。
    let lastCliProbe: Awaited<ReturnType<CliInstallAdapter["probe"]>> | null = null;
    // remote handshake 世代只属目前 app 运行期；同 locator 仅最新结果可落地。
    const remoteOpenGeneration = new Map<string, number>();
    // 看板最后成功内容只活在本次 app 运行期，依 locator 隔离且不进 localStorage。
    const workspaceSnapshots = new Map<string, WorkspaceSnapshot>();
    const latestRefreshGeneration = new Map<string, number>();
    let nextRefreshGeneration = 0;
    // 手册索引的 latest-wins 世代——闭包层、不进 store state。
    let manualGeneration = 0;
    // 每个 workspace 的整批加载在途笔数（design D1）：refresh 进场 +1、settle -1，
    // 归零即删 key。「加载中」由这里导出，没有任何入口／出口需要自己记帐。
    // 非 React 状态——读取端一律看导出的 loadingActive。
    const inflightRefreshes = new Map<string, number>();

    function emptyWorkspaceSnapshot(): WorkspaceSnapshot {
      return {
        changes: [],
        planError: null,
        planNext: null,
        unpromotedCuts: [],
        specs: [],
        archived: [],
        discussions: { active: [], archived: [] },
        loaded: false,
        loadFailed: false,
      };
    }

    function visibleWorkspaceSnapshot(key: string): WorkspaceSnapshot {
      return workspaceSnapshots.get(key) ?? emptyWorkspaceSnapshot();
    }

    function resetWorkspaceTransientState(): Partial<AppState> {
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      searchSeq++;
      return {
        searchHits: [],
        expandedName: null,
        detailChange: null,
        detailDiscussion: null,
        detailSpec: null,
        detailArchived: null,
        ...idleArchiveGate(),
        pendingDelete: null,
        pendingRevert: null,
        revertBlocked: null,
        pendingArchiveDiscussion: null,
        detailVerb: null,
        manual: null,
      };
    }

    /** 技能档探测的对象：本机项目（探测它的项目根），或有 checkout 的 remote 项目（基准是
     * Server 提供的技能）。`skipKey` 是略过记忆的键：本机项目是项目根，remote 项目是分页的键。 */
    type AssetSubject =
      | { kind: "local"; root: string; skipKey: string }
      | { kind: "remote"; checkout: RemoteCheckout; skipKey: string };

    /** 探测 `subject` 的技能档并裁决提示；探测失败照样抛出，由调用端决定怎么呈现。
     * Server 没有提供技能（null）时没有可比的基准：不提示。 */
    async function promptAt(ws: WorkspaceAdapter, subject: AssetSubject): Promise<AssetPromptState | null> {
      const probe =
        subject.kind === "remote" ? await ws.probeRemoteAssets(subject.checkout) : await ws.probeAssets(subject.root);
      return probe ? assetPrompt(probe, subject.skipKey, readAssetSkips()) : null;
    }

    /** 探测指定分页的技能档并记进该分页的记忆（结果属于探测时的分页，期间切走也不错置）。 */
    async function probeAssetPromptFor(ws: WorkspaceAdapter, key: string, subject: AssetSubject): Promise<void> {
      let next: AssetPromptState | null;
      try {
        next = await promptAt(ws, subject);
      } catch {
        // 探测不可用（remote 项目连不上也是）等同无法判定：静默不提示，开项目不受影响。
        next = null;
      }
      set({ assetPrompts: { ...get().assetPrompts, [key]: next } });
    }

    /** 活跃分页的技能档探测对象：本机项目，或有 checkout 的 remote 项目。没有 checkout
     * 的 remote 分页（只看规格）与零分页回 null——没有受管的技能档可查。 */
    function activeAssetSubject(): AssetSubject | null {
      const key = get().activeKey;
      const locator = key ? get().sessions[key]?.locator : undefined;
      if (!key || !locator) return null;
      if (locator.kind === "local") return { kind: "local", root: locator.root, skipKey: locator.root };
      if (!locator.checkoutRoot) return null;
      return {
        kind: "remote",
        skipKey: key,
        checkout: {
          connectionId: locator.connectionId,
          project: locator.projectId,
          repo: locator.repoId,
          checkout: locator.checkoutRoot,
        },
      };
    }

    /** 指定 workspace 是否有整批加载在途（loadingActive 的唯一真相）。 */
    function loadingActiveFor(key: string | null): boolean {
      return key !== null && (inflightRefreshes.get(key) ?? 0) > 0;
    }

    /** refresh 进场：在第一个 await 前 +1，并重算导出旗标。 */
    function beginInflight(key: string): void {
      inflightRefreshes.set(key, (inflightRefreshes.get(key) ?? 0) + 1);
      syncLoadingActive();
    }

    /** refresh settle（成功、失败、世代过期皆同一条路）：-1，归零即删 key。 */
    function endInflight(key: string): void {
      const next = (inflightRefreshes.get(key) ?? 1) - 1;
      if (next > 0) inflightRefreshes.set(key, next);
      else inflightRefreshes.delete(key);
      syncLoadingActive();
    }

    /** 计数变动后重算导出值；未变动不写 state（避免无谓重渲染）。 */
    function syncLoadingActive(): void {
      const next = loadingActiveFor(get().activeKey);
      if (get().loadingActive !== next) set({ loadingActive: next });
    }

    /** 翻页到某 workspace 时的可见状态：其快照＋（换 workspace 时）暂态重置。
     * 加载中不由入口表态——导出自该 key 的在途计数，接加载的入口在同一同步段内
     * 起 refresh（计数 +1）故与 activeKey 同批落下，不接加载的入口天然为 false。 */
    function workspaceActivationState(key: string): Partial<AppState> {
      const snapshot = visibleWorkspaceSnapshot(key);
      return {
        ...snapshot,
        ...(get().activeKey === key ? {} : resetWorkspaceTransientState()),
        loadingActive: loadingActiveFor(key),
      };
    }

    function beginRefresh(key: string): number {
      const generation = ++nextRefreshGeneration;
      latestRefreshGeneration.set(key, generation);
      return generation;
    }

    function isCurrentRefresh(key: string, generation: number): boolean {
      return latestRefreshGeneration.get(key) === generation;
    }

    function pruneWorkspaceSnapshots(live: Set<string>): void {
      for (const key of workspaceSnapshots.keys()) {
        if (!live.has(key)) workspaceSnapshots.delete(key);
      }
      for (const key of latestRefreshGeneration.keys()) {
        if (!live.has(key)) latestRefreshGeneration.delete(key);
      }
    }

    function bumpRemoteOpenGeneration(key: string): number {
      const generation = (remoteOpenGeneration.get(key) ?? 0) + 1;
      remoteOpenGeneration.set(key, generation);
      return generation;
    }

    function isCurrentRemoteOpen(key: string, generation: number): boolean {
      return remoteOpenGeneration.get(key) === generation;
    }

    /** 活跃 session；零分页空状态回 null。 */
    function activeSession(): WorkspaceSession | null {
      const { activeKey, sessions } = get();
      return (activeKey && sessions[activeKey]) || null;
    }

    /** 活跃 session 的 dataSource；零分页空状态回 null（数据操作一律早退）。 */
    function activeDataSource(): SpecsealDataSource | null {
      return activeSession()?.dataSource ?? null;
    }

    /** 封存终局的共同收尾（D1）：成功由画面表达（关抽屉、不发 toast），失败以
     * 单槽 toast 呈现 core 的消息；两条路都重载。`archive` 动词与「照样带走」
     * 都是封存终局，收尾只此一份。 */
    async function settleArchive(
      change: string,
      run: () => Promise<unknown>,
      failKey: FailureMessageKey = "store.archiveFailed",
    ) {
      try {
        await run();
        set({ detailChange: null });
      } catch (e) {
        showFailureToast(change, failKey, e);
      }
      await get().refresh();
    }

    /** 三选项处置进行中——连点守门（对话框按钮未锁，await 期间再点直接忽略）。 */
    let ticketSettling = false;

    /**
     * 封存守门的一站处置收尾（spec「封存入口三选项扩及验证工单」）：记下本站
     * 已处置与是否带走，另一站仍有未结工单就留在守门流程（App 会弹该站的对话
     * 框），否则带着累积的旗标真正封存。工单在 discard 已删且不可回复——封存
     * 此后失败的提示由「已放弃了哪些站」导出，不得退化成单纯「封存失败」。
     *
     * `prior` 是按下处置当下的守门快照：discard 在途时守门可能已被收掉（开抽屉）或
     * 换了目标（另一个封存入口），已送出的处置照快照走完，守门状态只在仍属本
     * change 时回写。
     */
    async function settleStation(
      change: string,
      station: "review" | "verify",
      carry: boolean,
      prior: Pick<AppState, "pendingArchiveSettled" | "pendingArchiveCarry">,
    ) {
      const settled = { ...prior.pendingArchiveSettled, [station]: true };
      const carried = { ...prior.pendingArchiveCarry, [station]: carry };
      const stillGating = get().pendingArchive === change;
      if (stillGating) set({ pendingArchiveSettled: settled, pendingArchiveCarry: carried });
      if (openTicketStation(get().changes, change, settled)) {
        // 另一站的工单还没处置——守门流程继续；守门已被收掉则停在这里，等同在下一站按取消。
        return;
      }
      if (stillGating) set({ pendingArchive: null });
      const dataSource = activeDataSource();
      if (!dataSource) {
        showFailureToast(change, "store.reviewActionUnsupported");
        return;
      }
      const discardedReview = settled.review && !carried.review;
      const discardedVerify = settled.verify && !carried.verify;
      const failKey: FailureMessageKey =
        discardedReview && discardedVerify
          ? "store.archiveAfterDiscardBothFailed"
          : discardedReview
            ? "store.archiveAfterDiscardFailed"
            : discardedVerify
              ? "store.archiveAfterDiscardVerifyFailed"
              : "store.archiveFailed";
      if (!carried.review && !carried.verify) {
        await settleArchive(change, () => dataSource.runVerb("archive", change), failKey);
        return;
      }
      const archiveCarry = dataSource.archiveCarry;
      if (!archiveCarry) {
        showFailureToast(change, "store.reviewActionUnsupported");
        return;
      }
      await settleArchive(
        change,
        () => archiveCarry(change, carried.review, carried.verify),
        failKey,
      );
    }

    /** 逐连接交互状态的单点更新（desktop-connections）。 */
    function setConnectionPhase(origin: string, phase: ConnectionPhase) {
      set({ connectionPhases: { ...get().connectionPhases, [origin]: phase } });
    }

    /** 每个 origin 目前这一轮登录的编号：取消或重按登录就换新一轮，前一轮晚到的
     * 阶段与结果一律作废，不得复活等待面或盖掉新一轮的状态。 */
    const loginRuns = new Map<string, number>();
    function nextLoginRun(origin: string): number {
      const run = (loginRuns.get(origin) ?? 0) + 1;
      loginRuns.set(origin, run);
      return run;
    }

    /** 登录成功后原地复活同 connection 的全部已创建 remote sessions：逐一
     * handshake、保留失败 session／分页并标 tab error，最后重查与重挂 worker。 */
    async function recoverRemoteSessions(origin: string) {
      if (!openRemote) return;
      const connectionId = get().connections.find((entry) => entry.origin === origin)?.id;
      if (!connectionId) return;
      const targets = Object.entries(get().sessions).filter(
        ([, session]) =>
          session.locator.kind === "remote" && session.locator.connectionId === connectionId,
      );
      const recoveryKeys = get()
        .tabs.filter(
          (tab) =>
            tab.locator.kind === "remote" &&
            tab.locator.connectionId === connectionId &&
            !get().sessions[locatorKey(tab.locator)],
        )
        .map((tab) => locatorKey(tab.locator));
      if (targets.length === 0 && recoveryKeys.length === 0) return;

      const sessions = { ...get().sessions };
      const tabErrors = { ...get().tabErrors };
      for (const [key, session] of targets) {
        const locator = session.locator;
        if (locator.kind !== "remote") continue;
        try {
          const target = `${locator.projectId}/${locator.repoId}`;
          const fresh = locator.checkoutRoot
            ? await openRemote(connectionId, target, locator.checkoutRoot)
            : await openRemote(connectionId, target);
          if (fresh.id !== key) throw new Error("重新连接后项目身分不一致");
          sessions[key] = fresh;
          delete tabErrors[key];
        } catch (error) {
          tabErrors[key] = String(error);
        }
      }
      set({ sessions, tabErrors });
      for (const key of recoveryKeys) await reconnectRemoteTab(key, false);
      await get().refresh();
      set((state) => ({
        sessionEpoch: state.sessionEpoch + 1,
        boardView: "board",
        reauthConnectionId: null,
      }));
    }

    function markerLocation(url: string): { origin: string; project: string } {
      const parsed = new URL(url);
      const marker = "/api/specseal/v1/projects/";
      const index = parsed.pathname.indexOf(marker);
      const project =
        index >= 0 ? parsed.pathname.slice(index + marker.length).split("/")[0] : "";
      if (!project) throw new Error("remote marker 的 url 未包含 project 识别");
      return { origin: parsed.origin.toLowerCase(), project: decodeURIComponent(project) };
    }

    function pathName(path: string): string {
      const trimmed = path.replace(/[\\/]+$/, "");
      return trimmed.split(/[\\/]/).pop() || path;
    }

    /** 成功打开的共同记入（design D2）：算出记到最前的新清单。dropKey 用于
     * 本机文件夹转 remote 的路径——同一文件夹不留 local 与 remote 两笔。
     * 纯计算不落地——持久化由调用端在 set 之后与 persistTabs 一起做，
     * 两者之间抛错才不会留下「已写档、状态没进去」的分歧。 */
    function recordRecent(entry: RecentEntry, dropKey?: string): RecentEntry[] {
      const base = dropKey ? removeRecent(get().recents, dropKey) : get().recents;
      return upsertRecent(base, entry);
    }

    /** 命中项目的共同尾声：upsert session 与分页（去重）、设 activeKey、清对话框、
     * persist、显式重挂监看、整批 refresh。probe 为纯探测，其回报值即后端真相。
     * 回传该分页的 locator key。 */
    async function enterProject(root: string, name: string): Promise<string> {
      const locator = { kind: "local", root } as const;
      const key = locatorKey(locator);
      const tabs = upsertTab(get().tabs, { locator, name });
      const recents = recordRecent({ locator, name });
      const sessions = { ...get().sessions };
      if (!sessions[key]) sessions[key] = createSession(root, name);
      // 淘汰出分页列的 session 一并回收（上限丢最旧）。
      const live = new Set(tabs.map((t) => locatorKey(t.locator)));
      for (const k of Object.keys(sessions)) if (!live.has(k)) delete sessions[k];
      pruneWorkspaceSnapshots(live);
      const tabErrors = { ...get().tabErrors };
      delete tabErrors[key];
      set({
        tabs,
        recents,
        sessions,
        tabErrors,
        activeKey: key,
        pendingInit: null,
        pendingAdopt: null,
        ...workspaceActivationState(key),
      });
      persistTabs(tabs, key);
      persistRecents(recents);
      // 整批加载在翻页的同一同步段内起跑（其计数 +1 在第一个 await 之前）——
      // 监看挂载可达秒级，先等它就会留下「已翻页、尚未起加载」的空窗假空态。
      const loading = get().refresh();
      // 占位 handler：await 之前的拒绝不触发 unhandledrejection（下方 await 照样取得结果）。
      loading.catch(() => {});
      // 监看显式跟随活跃 session（决策 5）；不可用仅失去自动刷新、app 照常。
      let watched = true;
      try {
        await workspace?.watchWorkspace(root);
      } catch {
        watched = false; /* 降级：无自动刷新 */
      }
      await loading;
      // 首批读取先于挂载完成，窗口内的变动无事件也不在首批结果内——挂载成功后
      // 补一发盖掉静默过时窗口（降级模式本就无自动刷新，不补）。
      if (watched && get().activeKey === key) await get().refresh();
      return key;
    }

    /** remote session 的入列尾声（remote-data-source 决策 6）：upsert 分页与
     * session、设 activeKey、persist、整批 refresh。无文件监看——事件面由
     * session 的 remote-workspace-changed 订阅承担。 */
    async function adoptRemoteSession(session: WorkspaceSession, dropRecentKey?: string) {
      const key = session.id;
      const tabs = upsertTab(get().tabs, {
        locator: session.locator,
        name: session.descriptor.name,
      });
      const recents = recordRecent(
        { locator: session.locator, name: session.descriptor.name },
        dropRecentKey,
      );
      const sessions = { ...get().sessions, [key]: session };
      const live = new Set(tabs.map((t) => locatorKey(t.locator)));
      for (const k of Object.keys(sessions)) if (!live.has(k)) delete sessions[k];
      pruneWorkspaceSnapshots(live);
      const tabErrors = { ...get().tabErrors };
      delete tabErrors[key];
      const remoteRecovery = { ...get().remoteRecovery };
      delete remoteRecovery[key];
      set({
        tabs,
        recents,
        sessions,
        tabErrors,
        remoteRecovery,
        activeKey: key,
        pendingInit: null,
        pendingAdopt: null,
        ...workspaceActivationState(key),
      });
      persistTabs(tabs, key);
      persistRecents(recents);
      await get().refresh();
    }

    /** 对已存在的 remote tab 重走 handshake。activate=true 只在用户选取分页时
     * 同步更新 activeKey；Tray／retry 使用 false，不得抢走目前作用中分页。 */
    async function reconnectRemoteTab(key: string, activate: boolean) {
      if (!openRemote) return;
      const tab = get().tabs.find((candidate) => locatorKey(candidate.locator) === key);
      if (!tab || tab.locator.kind !== "remote") return;

      const generation = bumpRemoteOpenGeneration(key);
      set((state) => {
        const tabErrors = { ...state.tabErrors };
        delete tabErrors[key];
        return {
          ...(activate
            ? {
                activeKey: key,
                boardView: "board" as const,
                ...workspaceActivationState(key),
              }
            : {}),
          tabErrors,
          remoteRecovery: {
            ...state.remoteRecovery,
            [key]: { status: "restoring", failure: null },
          },
        };
      });
      if (activate) persistTabs(get().tabs, key);

      const { connectionId, projectId, repoId, checkoutRoot } = tab.locator;
      try {
        const session = checkoutRoot
          ? await openRemote(connectionId, `${projectId}/${repoId}`, checkoutRoot)
          : await openRemote(connectionId, `${projectId}/${repoId}`);
        if (!isCurrentRemoteOpen(key, generation)) return;
        if (!get().tabs.some((candidate) => locatorKey(candidate.locator) === key)) return;
        if (session.id !== key) throw new Error("重新连接后项目身分不一致");

        const tabs = get().tabs.map((candidate) =>
          locatorKey(candidate.locator) === key
            ? {
                ...candidate,
                locator: session.locator,
                name: session.descriptor.name,
              }
            : candidate,
        );
        const tabErrors = { ...get().tabErrors };
        delete tabErrors[key];
        const remoteRecovery = { ...get().remoteRecovery };
        delete remoteRecovery[key];
        set((state) => ({
          tabs,
          sessions: { ...state.sessions, [key]: session },
          tabErrors,
          remoteRecovery,
          // activeKey 先于 session 成立时，必须显式触发事件订阅重新挂载。
          sessionEpoch: state.sessionEpoch + 1,
        }));
        // 重连是一次成功打开（design D2）——remote 分页的顺序不得停在旧值。
        const recents = recordRecent({
          locator: session.locator,
          name: session.descriptor.name,
        });
        set({ recents });
        persistTabs(tabs, get().activeKey);
        persistRecents(recents);
        if (get().activeKey === key) await get().refresh();
      } catch (error) {
        if (!isCurrentRemoteOpen(key, generation)) return;
        if (!get().tabs.some((candidate) => locatorKey(candidate.locator) === key)) return;
        const failure = normalizeRemoteOpenFailure(error);
        set((state) => ({
          tabErrors: { ...state.tabErrors, [key]: failure.message },
          remoteRecovery: {
            ...state.remoteRecovery,
            [key]: { status: "error", failure },
          },
        }));
      }
    }

    return {
    changes: [],
    planError: null,
    planNext: null,
    unpromotedCuts: [],
    specs: [],
    archived: [],
    discussions: { active: [], archived: [] },
    loaded: false,
    loadingActive: false,
    loadFailed: false,
    refreshGen: 0,
    manual: null,
    boardView: "board",
    boardMode: "cards",
    settingsSection: "general",
    settingsReturnView: "board",
    projectSettingsSection: "context",
    view: "active",
    query: "",
    boardQuery: "",
    promotedExpanded: readPromotedExpanded(),
    pageSizes: readPageSizes(),
    searchHits: [],
    expandedName: null,
    detailChange: null,
    detailDiscussion: null,
    detailSpec: null,
    detailArchived: null,
    ...idleArchiveGate(),
    pendingDelete: null,
    pendingRevert: null,
    revertBlocked: null,
    pendingArchiveDiscussion: null,
    detailVerb: null,

    async refresh() {
      const sourceKey = get().activeKey;
      const session = sourceKey ? get().sessions[sourceKey] : null;
      if (!sourceKey || !session) return;
      const generation = beginRefresh(sourceKey);
      // 手册视图活跃时同批重取索引（外部写入手册目录走的是同一个 workspace-changed）。
      if (get().boardView === "manual") void get().refreshManual();
      try {
        // 在途 +1 在第一个 await 之前；三条离开路径（成功、失败、世代过期）共用
        // 同一个 finally 递减——没有任何出口需要判断「这面旗标归不归我收」。
        // +1 先落 Map 再重算导出值：重算的 set 即使被订阅者炸掉，finally 仍会递减。
        beginInflight(sourceKey);
        const dataSource = session.dataSource;
        // capability 驱动（remote-data-source 决策 2）：server 未提供的读取跳过、
        // 以空集呈现（archived 页另有提示卡），不让整批 refresh 失败。
        let loaded: [ChangeListPayload, SpecItem[], ArchivedItem[], DiscussionLists];
        try {
          loaded = await Promise.all([
            // 清单与顶层 planError 同一次 IO（add-change-plan-desktop design D1）。
            dataSource.listChanges(),
            dataSource.listSpecs(),
            session.capabilities.listArchived ? dataSource.listArchived() : Promise.resolve([]),
            dataSource.listDiscussions(),
          ]);
        } catch {
          // remote 坏天气：最后一次成功 snapshot 是唯读真值；任一 reload 失败
          // 都不得用空集或部分结果覆盖。连接呈现只由 Rust 状态事件决定。
          // loaded 维持 false——读不到不等于「确认是空的」；骨架的终止由在途计数负责。
          // 失败终态随快照存续（切走再切回仍记得）；只有现任世代写得进去——
          // 先发的失败不得盖掉后发刚落地的成功。
          if (isCurrentRefresh(sourceKey, generation)) {
            workspaceSnapshots.set(sourceKey, {
              ...visibleWorkspaceSnapshot(sourceKey),
              loadFailed: true,
            });
            set((state) => (state.activeKey === sourceKey ? { loadFailed: true } : {}));
          }
          return;
        }
        const [{ changes, planError, next, unpromotedCuts }, specs, archived, discussions] = loaded;
        const snapshot: WorkspaceSnapshot = {
          changes,
          planError,
          planNext: next,
          unpromotedCuts,
          specs,
          archived,
          discussions,
          loaded: true,
          loadFailed: false,
        };
        if (!isCurrentRefresh(sourceKey, generation)) {
          // 世代过期＝同 key 有更新的 refresh 在途（或已自行收尾）——先发的数据已
          // 过时，不得覆盖后发的结果。
          return;
        }
        workspaceSnapshots.set(sourceKey, snapshot);
        set((state) => (state.activeKey === sourceKey ? snapshot : {}));
        if (get().activeKey !== sourceKey) return;
        // 详情开着时同步其数据（如任务数更新）
        const cur = get().detailChange;
        if (cur) {
          set({ detailChange: changes.find((c) => c.name === cur.name) ?? null });
        }
        // 讨论抽屉开着时同步（轮数更新、转出后 promotedTo 增长；封存则关闭）
        const curD = get().detailDiscussion;
        if (curD) {
          set({ detailDiscussion: discussions.active.find((d) => d.slug === curD.slug) ?? null });
        }
        // 清单就绪后递增刷新世代——开着的内容查看据此重载至磁盘现况。
        set((st) => ({ refreshGen: st.refreshGen + 1 }));
      } finally {
        endInflight(sourceKey);
      }
    },

    async rearmWatch() {
      const st = get();
      const locator = st.activeKey ? st.sessions[st.activeKey]?.locator : undefined;
      if (!locator) return;
      try {
        if (locator.kind === "local") await workspace?.watchWorkspace(locator.root);
        // 有 checkout 的 remote 项目：监看 checkout 的技能档，供提示卡自动更新。
        else if (locator.checkoutRoot) await workspace?.watchCheckoutSkills(locator.checkoutRoot);
      } catch {
        /* 降级：无自动刷新 */
      }
    },

    async refreshManual() {
      const key = get().activeKey;
      const session = key ? get().sessions[key] : null;
      if (!key || !session) return;
      const generation = ++manualGeneration;
      let index: ManualIndex;
      try {
        index = await session.dataSource.listManualPages();
      } catch {
        // 读不到不等于「确认是空的」：有旧索引沿用；首访才落成尚无手册的空索引。
        if (get().manual) return;
        index = emptyManualIndex(null);
      }
      // 交错回应以最新为准；分页已切走的结果丢弃（索引属于当时的 workspace）。
      if (generation !== manualGeneration || get().activeKey !== key) return;
      set({ manual: index });
    },

    setBoardView(boardView) {
      const from = get().boardView;
      // 切换主区页面＝离开详情页：四种详情页都叠在宿主页上，不关就会盖住新页。
      set({
        boardView,
        ...(isSettingsView(boardView) && !isSettingsView(from) ? { settingsReturnView: from } : {}),
        reauthConnectionId: null,
        detailChange: null,
        detailDiscussion: null,
        detailSpec: null,
        detailArchived: null,
        detailVerb: null,
      });
      if (boardView === "manual") void get().refreshManual();
    },

    setBoardMode(boardMode) {
      set({ boardMode });
    },

    openRoadmap() {
      showBoardMode("roadmap");
    },

    openBoard() {
      showBoardMode("cards");
    },

    leaveSettings() {
      get().setBoardView(get().settingsReturnView);
    },

    setSettingsSection(settingsSection) {
      set({ settingsSection });
    },

    setProjectSettingsSection(projectSettingsSection) {
      set({ projectSettingsSection });
    },

    setView(view) {
      set({ view });
    },

    setQuery(query) {
      set({ query });
    },

    setPromotedExpanded(promotedExpanded) {
      set({ promotedExpanded });
      try {
        localStorage.setItem(PROMOTED_EXPANDED_STORAGE_KEY, String(promotedExpanded));
      } catch {
        // 写不进 app 本机（私密模式、配额）只失去跨启动记忆，本次运行期照常展开。
      }
    },

    setPageSize(list, size) {
      const pageSizes = { ...get().pageSizes, [list]: size };
      set({ pageSizes });
      try {
        localStorage.setItem(PAGE_SIZES_STORAGE_KEY, JSON.stringify(pageSizes));
      } catch {
        // 写不进 app 本机（私密模式、配额）只失去跨启动记忆，本次运行期照常生效。
      }
    },

    setBoardQuery(boardQuery) {
      set({ boardQuery });
      // 全文查找（design D6）：200ms 去抖、latest-wins 序号防交错；空 query 清
      // 命中并作废在途；失败静默退回字段比对（spec）——不弹错、不阻断输入。
      if (searchTimer !== null) clearTimeout(searchTimer);
      const seq = ++searchSeq;
      if (!boardQuery.trim()) {
        set({ searchHits: [] });
        return;
      }
      searchTimer = setTimeout(() => {
        const dataSource = activeDataSource();
        if (!dataSource) return;
        void dataSource
          .searchWorkspace(boardQuery)
          .then((hits) => {
            if (seq === searchSeq) set({ searchHits: hits });
          })
          .catch(() => {
            if (seq === searchSeq) set({ searchHits: [] });
          });
      }, 200);
    },

    disposeSearch() {
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      // 前进序号作废任何已开火、在途的查找回填（latest-wins 语意）。
      searchSeq++;
    },

    toggleExpand(name) {
      set({ expandedName: get().expandedName === name ? null : name });
    },

    // 详情页互斥（spec「详情页互斥」）：每个 open* 清除其他三个 detail 字段，后开者
    // 取代先开者；互斥由此层保证，调用端入口（含 ‹ › 切换）不需自行先关再开。
    // 宿主归位（spec「变更与讨论详情页的宿主为看板」）：变更与讨论详情页叠在看板上，
    // 打开时同一次 set 内把宿主切回看板，一个落点涵盖全部入口（系统匣、页内跳转、
    // 封存前「去盖章」）；openSpec／openArchived 不在此列——其宿主本就是规格页与
    // 已封存页。两者同时收掉可取消浮层（cancelableOverlaysCleared）；不可取消浮层
    // 打开中则不改任何状态（系统匣仍会把主窗口带到前景）。
    openDetail(name) {
      if (uncancelableOverlayOpen(get())) return;
      const c = findChange(get(), name);
      // 换 change 清掉上一个 change 的动词结果（detailVerb keyed by change）。
      if (c)
        set({
          detailChange: c,
          boardView: "board",
          detailVerb: null,
          detailDiscussion: null,
          detailSpec: null,
          detailArchived: null,
          ...cancelableOverlaysCleared(),
        });
    },

    openDiscussion(slug) {
      if (uncancelableOverlayOpen(get())) return;
      const d = findDiscussion(get(), slug);
      // 取代变更详情页时 detailVerb 一并清空（比照 closeDetailPage）。
      if (d)
        set({
          detailDiscussion: d,
          boardView: "board",
          detailChange: null,
          detailVerb: null,
          detailSpec: null,
          detailArchived: null,
          ...cancelableOverlaysCleared(),
        });
    },

    openSpec(capability) {
      set({
        detailSpec: capability,
        detailChange: null,
        detailVerb: null,
        detailDiscussion: null,
        detailArchived: null,
      });
    },

    openArchived(target) {
      set({
        detailArchived: target,
        detailChange: null,
        detailVerb: null,
        detailDiscussion: null,
        detailSpec: null,
      });
    },

    closeDetailPage() {
      set({
        detailChange: null,
        detailDiscussion: null,
        detailSpec: null,
        detailArchived: null,
        detailVerb: null,
      });
    },

    requestArchive(name) {
      set({ ...idleArchiveGate(), pendingArchive: name });
    },

    async confirmArchive() {
      const name = get().pendingArchive;
      set({ pendingArchive: null });
      if (name) await get().runVerb("archive", name);
    },

    cancelArchive() {
      set({ pendingArchive: null });
    },

    async confirmArchiveDiscardTicket(station) {
      const gate = get();
      const name = gate.pendingArchive;
      if (!name || ticketSettling) return;
      const dataSource = activeDataSource();
      const discard = station === "review" ? dataSource?.discardReview : dataSource?.discardVerify;
      if (!dataSource || !discard) {
        set({ pendingArchive: null });
        showFailureToast(name, "store.reviewActionUnsupported");
        return;
      }
      ticketSettling = true;
      try {
        try {
          await discard(name);
        } catch (e) {
          set({ pendingArchive: null });
          showFailureToast(
            name,
            station === "review" ? "store.discardReviewFailed" : "store.discardVerifyFailed",
            e,
          );
          await get().refresh();
          return;
        }
        await settleStation(name, station, false, gate);
      } finally {
        ticketSettling = false;
      }
    },

    async confirmArchiveCarryTicket(station) {
      const gate = get();
      const name = gate.pendingArchive;
      if (!name || ticketSettling) return;
      ticketSettling = true;
      try {
        await settleStation(name, station, true, gate);
      } finally {
        ticketSettling = false;
      }
    },

    async claimChange(name) {
      const dataSource = activeDataSource();
      if (!dataSource?.claim) return;
      try {
        await dataSource.claim(name);
      } catch (e) {
        // 已被他人持有时 server 的消息带持有人与建议动作——原样入 toast 尾缀。
        showFailureToast(name, "store.claimFailed", e);
      }
      await get().refresh();
    },

    requestDelete(name) {
      set({ pendingDelete: name });
    },

    async confirmDelete() {
      const name = get().pendingDelete;
      set({ pendingDelete: null });
      if (!name) return;
      const dataSource = activeDataSource();
      if (!dataSource) return;
      try {
        await dataSource.deleteChange(name);
        set({ detailChange: null });
      } catch (e) {
        showFailureToast(name, "store.deleteFailed", e);
      }
      await get().refresh();
    },

    cancelDelete() {
      set({ pendingDelete: null });
    },

    requestRevert(name) {
      set({ pendingRevert: name });
    },

    async confirmRevert() {
      const name = get().pendingRevert;
      set({ pendingRevert: null });
      if (!name) return;
      const dataSource = activeDataSource();
      if (!dataSource) return;
      try {
        // UI 不预判守门——引擎是唯一裁决点;成功后不手动搬卡,重载后
        // startedAt 为空、勾选为 0,卡片依派生自然回提案中栏。
        await dataSource.revertChangeToProposed(name);
      } catch (e) {
        if (e instanceof RevertBlockedError) {
          set({
            revertBlocked: {
              change: name,
              checkedTasks: e.checkedTasks,
              touchedFiles: e.touchedFiles,
            },
          });
        } else {
          showFailureToast(name, "store.revertFailed", e);
        }
      }
      await get().refresh();
    },

    cancelRevert() {
      set({ pendingRevert: null });
    },

    dismissRevertBlocked() {
      set({ revertBlocked: null });
    },

    requestArchiveDiscussion(slug) {
      set({ pendingArchiveDiscussion: slug });
    },

    async confirmArchiveDiscussion() {
      const slug = get().pendingArchiveDiscussion;
      set({ pendingArchiveDiscussion: null });
      if (!slug) return;
      const dataSource = activeDataSource();
      if (!dataSource) return;
      try {
        await dataSource.archiveDiscussion(slug);
        set({ detailDiscussion: null });
      } catch (e) {
        showFailureToast(slug, "store.discussionArchiveFailed", e);
      }
      await get().refresh();
    },

    cancelArchiveDiscussion() {
      set({ pendingArchiveDiscussion: null });
    },

    async runVerb(verb, change) {
      const dataSource = activeDataSource();
      if (!dataSource) return;
      // archive 属看板全域操作：成功由画面表达，失败以单槽 toast 呈现（D1）。
      if (verb === "archive") {
        await settleArchive(change, () => dataSource.runVerb(verb, change));
        return;
      }
      // 「分析」一键双动词（design D1）：validate＋analyze 并发运行、合并为
      // 单一结构化抽屉结果，不占顶列。任一失败即整批以 error 呈现、不静默。
      try {
        const [v, a] = await Promise.all([
          dataSource.runVerb("validate", change),
          dataSource.runVerb("analyze", change),
        ]);
        const o = (v ?? {}) as { valid?: boolean; errors?: string[] };
        set({
          detailVerb: {
            change,
            validate: { valid: !!o.valid, errors: o.errors ?? [] },
            analyze: a as AnalyzeReport,
          },
        });
      } catch (e) {
        set({ detailVerb: { change, error: String(e) } });
      }
      await get().refresh();
    },

    clearDetailVerb() {
      set({ detailVerb: null });
    },

    async reorderCard(kind, id, prevId, nextId) {
      const dataSource = activeDataSource();
      if (!dataSource) return;
      const sourceKey = get().activeKey;
      const session = activeSession();
      let previousSnapshot: WorkspaceSnapshot | null = null;
      if (sourceKey && session?.locator.kind === "remote") {
        const current = get();
        previousSnapshot = workspaceSnapshots.get(sourceKey) ?? {
          changes: current.changes,
          planError: current.planError,
          planNext: current.planNext,
          unpromotedCuts: current.unpromotedCuts,
          specs: current.specs,
          archived: current.archived,
          discussions: current.discussions,
          loaded: current.loaded,
          loadFailed: current.loadFailed,
        };
        const optimistic: WorkspaceSnapshot =
          kind === "change"
            ? {
                ...previousSnapshot,
                changes: moveBetweenNeighbors(
                  previousSnapshot.changes,
                  (change) => change.name,
                  id,
                  prevId,
                  nextId,
                ),
              }
            : {
                ...previousSnapshot,
                discussions: {
                  ...previousSnapshot.discussions,
                  active: moveBetweenNeighbors(
                    previousSnapshot.discussions.active,
                    (discussion) => discussion.slug,
                    id,
                    prevId,
                    nextId,
                  ),
                },
              };
        workspaceSnapshots.set(sourceKey, optimistic);
        set((state) => (state.activeKey === sourceKey ? optimistic : {}));
      }
      try {
        await dataSource.reorderCard(kind, id, prevId, nextId);
      } catch (e) {
        // 写回失败不留假象（spec）：先复原最后成功 snapshot，再 refresh server 现况。
        if (sourceKey && previousSnapshot) {
          workspaceSnapshots.set(sourceKey, previousSnapshot);
          set((state) => (state.activeKey === sourceKey ? previousSnapshot! : {}));
        }
        showFailureToast(id, "store.reorderFailed", e);
      }
      await get().refresh();
    },

    async setDepends(change, on, remove) {
      const dataSource = activeDataSource();
      if (!dataSource) return;
      try {
        await dataSource.setDepends(change, on, remove);
      } catch (e) {
        // 引擎拒绝（自依赖、不存在、已封存、成环）：单行呈现引擎消息，画面不变。
        showFailureToast(change, "store.setDependsFailed", e);
        return;
      }
      await get().refresh();
    },

    // --- workspace／项目分页列 ---
    tabs: [],
    sessions: {},
    sessionEpoch: 0,
    applyRemoteConnectionState(event) {
      let changed = false;
      const sessions = Object.fromEntries(
        Object.entries(get().sessions).map(([key, session]) => {
          const next = applyRemoteConnectionState(session, event);
          if (next !== session) changed = true;
          return [key, next];
        }),
      );
      if (changed) set({ sessions });
    },
    activeKey: null,
    pendingTabKey: null,
    pendingInit: null,
    pendingAdopt: null,
    pendingAdoptImport: false,
    tabErrors: {},
    recents: [],
    remoteRecovery: {},
    workspaceChooser: null,
    pendingRemoteConflict: null,
    migrationRoot: null,

    openWorkspaceChooser(intent = {}) {
      set({ workspaceChooser: intent });
    },

    closeWorkspaceChooser() {
      set({ workspaceChooser: null });
    },

    async requestMigration(root) {
      if (!workspace) throw new Error("此环境未提供本机 workspace 功能");
      const probe = await workspace.openProject(root);
      if (probe.status !== "project") {
        throw new Error(`无法准备本机迁移分页：${root} 不再是本机 Specseal 项目`);
      }
      // 迁移确认前先创建 local session／分页。如此 import 失败时仍有原 local
      // 分页可留在原位，成功时 replaceLocalWorkspaceWithRemote 才有明确取代目标。
      await enterProject(probe.root, probe.name);
      set({ migrationRoot: probe.root, workspaceChooser: null });
    },

    cancelMigration() {
      set({ migrationRoot: null });
    },

    async continueLocalFromConflict() {
      const conflict = get().pendingRemoteConflict;
      if (!conflict) return;
      set({ pendingRemoteConflict: null });
      await enterProject(conflict.path, pathName(conflict.path));
    },

    async useServerFromConflict() {
      const conflict = get().pendingRemoteConflict;
      if (!conflict) return;
      if (!openRemote) throw new Error("此环境未提供 remote workspace 功能");
      if (!migration) throw new Error("此环境未提供本机 workspace 备份功能");

      const marker = markerLocation(conflict.url);
      let available = get().connections;
      if (connectionsAdapter) {
        available = await connectionsAdapter.list();
        set({ connections: available });
      }
      const connection = available.find(
        (entry) => entry.loggedIn && entry.origin.toLowerCase() === marker.origin,
      );
      if (!connection) throw new Error(`尚未登录 ${marker.origin}，无法采用 server 内容`);
      const target = conflict.repo ? `${marker.project}/${conflict.repo}` : marker.project;

      // 文件夹转为 checkout 前先收敛既有工具选集（spec「以 server 为准」＝备份后弃用
      // 本机、完成工具 reconciliation 后打开）。同步在创建分页之前完成。
      if (connectionsAdapter && conflict.repo) {
        const inspection = await connectionsAdapter.inspectCheckout(
          conflict.path,
          connection.origin,
          marker.project,
          conflict.repo,
        );
        if (inspection.tools.length > 0) {
          await connectionsAdapter.bindCheckout(
            conflict.path,
            connection.origin,
            marker.project,
            conflict.repo,
            inspection.tools,
          );
        }
      }

      // 先完成只读 handshake，再改名本机 openspec/；任一步失败都不创建 remote 分页。
      const session = await openRemote(connection.id, target, conflict.path);
      await migration.adoptRemote(conflict.path);
      await adoptRemoteSession(session, locatorKey({ kind: "local", root: conflict.path }));
      set({ pendingRemoteConflict: null, boardView: "board" });
    },

    async migrateLocalFromConflict() {
      const conflict = get().pendingRemoteConflict;
      if (!conflict) return;
      await enterProject(conflict.path, pathName(conflict.path));
      set({ pendingRemoteConflict: null, migrationRoot: conflict.path });
    },

    cancelRemoteConflict() {
      set({ pendingRemoteConflict: null });
    },

    // --- 自动更新（desktop-app「桌面自动更新」；design D6） ---
    updater: initialUpdaterState,
    appInfo: null,
    loadAppInfo() {
      if (!fetchAppInfo || get().appInfo) return Promise.resolve();
      appInfoInFlight ??= fetchAppInfo()
        .then((appInfo) => set({ appInfo }))
        .catch(() => {})
        .finally(() => {
          appInfoInFlight = null;
        });
      return appInfoInFlight;
    },
    async checkForUpdates(manual) {
      if (!updaterAdapter) return;
      // 自动检查关闭：背景检查（启动、前景重检）不发出、节流时间戳不动；手动照常。
      if (!manual && !get().updaterAutoCheck) return;
      const before = get().updater;
      const checking = reduceUpdater(before, { type: "checkStarted", manual });
      if (checking === before) return; // 下载中／待重启不可重检
      lastCheckedAt = Date.now();
      set({ updater: checking });
      try {
        const update = await updaterAdapter.check();
        pendingUpdate = update;
        set({
          updater: reduceUpdater(
            get().updater,
            update ? { type: "updateFound", version: update.version } : { type: "noUpdate" },
          ),
        });
        // 背景检查（启动或前景重检）发现新版本：toast 一次，「查看」进设置页软件更新卡；手动
        // 检查的结果在卡内行内呈现、不发；同版本第二次不再发（spec「背景检查的 toast 只发一次」）。
        if (update && !manual && notifiedVersion !== update.version) {
          notifiedVersion = update.version;
          toast(appT("updater.toast.available").replace("{version}", update.version), {
            id: "updater-available",
            action: { label: appT("updater.toast.view"), onClick: () => get().openSettingsUpdate() },
          });
        }
      } catch {
        // 脱机／端点不可达：reducer 决定静默（自动）或浮出（手动）。
        set({ updater: reduceUpdater(get().updater, { type: "checkFailed" }) });
      }
    },
    async recheckOnFocus(now) {
      // now 供测试注入，未给取现在时刻（design D2）；状态守门让待同意的提示与
      // 安装失败的错误留到用户处置，不被自动重检清掉。
      if (!focusRecheckAllowed(get().updater)) return;
      if (!focusRecheckDue(lastCheckedAt, now ?? Date.now())) return;
      await get().checkForUpdates(false);
    },
    async acceptUpdate() {
      const pending = pendingUpdate;
      if (!pending) return;
      set({ updater: reduceUpdater(get().updater, { type: "accepted" }) });
      // 这次同意是否仍有效：用户取消（回闲置）或重新检查换掉了待套用项之后，晚到的下载
      // 结果一律不落地——不安装、不推进状态、不清掉新的待套用项（desktop-app「取消下载回到闲置」）。
      const stillAccepted = () => pendingUpdate === pending && get().updater.phase === "downloading";
      try {
        await pending.download();
        if (!stillAccepted()) return;
        await pending.install();
        if (!stillAccepted()) return;
        set({ updater: reduceUpdater(get().updater, { type: "downloaded" }) });
      } catch (error) {
        if (!stillAccepted()) return;
        // 签章验证失败等：转错误态、清掉待套用项；既有安装不受影响。
        pendingUpdate = null;
        set({
          updater: reduceUpdater(get().updater, {
            type: "installFailed",
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    },
    dismissUpdate() {
      set({ updater: reduceUpdater(get().updater, { type: "dismissed" }) });
    },
    async relaunchToUpdate() {
      await updaterAdapter?.relaunch();
    },
    focusUpdater: false,
    openSettingsUpdate() {
      get().setBoardView("settings");
      set({ settingsSection: "updates", focusUpdater: true });
    },
    clearFocusUpdater() {
      set({ focusUpdater: false });
    },
    updaterAutoCheck: readUpdaterAutoCheck(),
    setUpdaterAutoCheck(updaterAutoCheck) {
      set({ updaterAutoCheck });
      try {
        localStorage.setItem(UPDATER_AUTO_CHECK_STORAGE_KEY, String(updaterAutoCheck));
      } catch {
        // 写不进 app 本机只失去跨启动记忆，本次运行期照常生效。
      }
    },

    // --- 安装 CLI 指令（desktop-app「安装 CLI 指令到 PATH」；design D5） ---
    cliInstall: null,
    async refreshCliInstall() {
      if (!cliInstallAdapter) return;
      try {
        let probe = await cliInstallAdapter.probe();
        let status = statusFromProbe(probe);
        // 启动自动布署（spec 修订：macOS 未安装／版本不符皆自动、AppImage 版本
        // 不符自我修复）；失败不阻断启动，错误浮到卡片。
        let startupError: string | null = null;
        if (needsRedeploy(probe.platform, status) && probe.home && probe.bundledCliPath) {
          const plan = cliDeployPlan(probe.platform, {
            home: probe.home,
            bundledCliPath: probe.bundledCliPath,
          });
          if (plan.action !== "none") {
            try {
              await cliInstallAdapter.deploy(plan);
              probe = await cliInstallAdapter.probe();
              status = statusFromProbe(probe);
            } catch (error) {
              startupError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        // macOS PATH 幂等追加（design D12）：布署完成而 ~/.local/bin 不在 PATH
        // 且 zprofile 无识别行才写；最佳努力，失败不挡。
        if (probe.platform === "macos" && status.kind !== "not-installed" && probe.home) {
          const onPath = isDirOnPath(
            `${probe.home}/.local/bin`,
            probe.pathEnv,
            probe.pathDelimiter,
          );
          const plan = zprofilePlan(onPath, probe.zprofile);
          if (plan.action === "append") {
            try {
              await cliInstallAdapter.appendZprofile(plan.line);
            } catch {
              // 写 zprofile 失败：接口仍有 pathHint 供手动加入。
            }
          }
        }
        lastCliProbe = probe;
        const view = cliViewFrom(probe, status);
        set({ cliInstall: startupError ? { ...view, error: startupError } : view });
      } catch {
        // 探测失败（壳层异常）：不显卡——探测是最佳努力，不挡其他设置。
      }
    },
    async installCli() {
      const view = get().cliInstall;
      const probe = lastCliProbe;
      if (!cliInstallAdapter || !view?.canDeploy || view.busy) return;
      if (!probe?.home || !probe.bundledCliPath) return;
      set({ cliInstall: { ...view, busy: true, error: null } });
      try {
        const plan = cliDeployPlan(probe.platform, {
          home: probe.home,
          bundledCliPath: probe.bundledCliPath,
        });
        if (plan.action === "none") return; // canDeploy 平台不会走到；供类型收窄
        await cliInstallAdapter.deploy(plan);
        // 重探测呈现已安装与 PATH 提示（spec：动作后侦测 PATH）。
        await get().refreshCliInstall();
      } catch (error) {
        const current = get().cliInstall;
        if (current) {
          set({
            cliInstall: {
              ...current,
              busy: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    },

    // --- 系统匣样式（平台决定、不持久化） ---
    trayStyle: detectPlatform() === "linux" ? "native-menu" : "panel",
    trayPanelError: null,
    panelFallback(message) {
      set({ trayStyle: "native-menu", trayPanelError: message });
    },

    // --- server 连接（desktop-connections；决策 5/6/7） ---
    connections: [],
    connectionPhases: {},
    reauthConnectionId: null,
    openConnectionReauth(connectionId) {
      // 经 setBoardView 切页：连接失效横幅在主区外、详情页开着时仍点得到，详情页要一并关闭。
      get().setBoardView("settings");
      set({ settingsSection: "servers", reauthConnectionId: connectionId });
    },
    defaultConnectionId: readDefaultConnectionId(),
    setDefaultConnectionId(defaultConnectionId) {
      set({ defaultConnectionId });
      try {
        if (defaultConnectionId === null) localStorage.removeItem(DEFAULT_CONNECTION_STORAGE_KEY);
        else localStorage.setItem(DEFAULT_CONNECTION_STORAGE_KEY, defaultConnectionId);
      } catch {
        // 写不进 app 本机只失去跨启动记忆，本次运行期照常生效。
      }
    },
    async refreshConnections() {
      if (!connectionsAdapter) return false;
      try {
        set({ connections: await connectionsAdapter.list() });
        return true;
      } catch {
        // 清单读取失败保留现值——registry 坏档在 Rust 侧已归零，走到这里
        // 多半是暂时性环境问题，不清空用户眼前的清单。
        return false;
      }
    },
    async addConnection(baseUrl, name) {
      if (!connectionsAdapter) return null;
      const entry = await connectionsAdapter.add(baseUrl, name);
      // 规格「添加后清单即时反映」：条目先上清单、再进入登录流程。登录会一直
      // 等到用户完成或取消，调用端拿到 origin 后就地追踪它的交互状态。
      await get().refreshConnections();
      void get().loginConnection(entry.origin);
      return entry.origin;
    },
    async loginConnection(origin) {
      if (!connectionsAdapter) return;
      // 重按登录＝重来一次：Rust 端会取消前一轮，这里让它晚到的结果作废。
      const run = nextLoginRun(origin);
      const current = () => loginRuns.get(origin) === run;
      setConnectionPhase(origin, { kind: "busy" });
      try {
        const result = await connectionsAdapter.loginStart(origin, (phase) => {
          if (current()) setConnectionPhase(origin, phase);
        });
        if (!current()) return;
        if (result.status === "loggedIn") {
          await get().refreshConnections();
          await recoverRemoteSessions(origin);
          setConnectionPhase(origin, { kind: "idle" });
        } else if (result.status === "patRequired") {
          setConnectionPhase(origin, { kind: "patInput", error: null });
        } else if (result.status === "denied") {
          setConnectionPhase(origin, {
            kind: "error",
            message: appT(result.method === "browser" ? "servers.browserDenied" : "servers.denied"),
          });
        } else if (result.status === "expired") {
          setConnectionPhase(origin, {
            kind: "error",
            message: appT(result.method === "browser" ? "servers.browserExpired" : "servers.expired"),
          });
        } else {
          setConnectionPhase(origin, { kind: "idle" });
        }
      } catch (e) {
        if (current()) setConnectionPhase(origin, { kind: "error", message: String(e) });
      }
    },
    cancelLogin(origin) {
      // 立即回未登录；Rust 端结束等待、关掉回呼的端口，不留任何 credential。
      nextLoginRun(origin);
      void connectionsAdapter?.loginCancel(origin);
      setConnectionPhase(origin, { kind: "idle" });
    },
    async submitPat(origin, pat) {
      if (!connectionsAdapter) return;
      setConnectionPhase(origin, { kind: "busy" });
      try {
        await connectionsAdapter.patLogin(origin, pat);
        await get().refreshConnections();
        await recoverRemoteSessions(origin);
        setConnectionPhase(origin, { kind: "idle" });
      } catch (e) {
        // 无效 PAT：留在输入面、就地浮出错误。
        setConnectionPhase(origin, { kind: "patInput", error: String(e) });
      }
    },
    async logoutConnection(origin) {
      if (!connectionsAdapter) return;
      setConnectionPhase(origin, { kind: "busy" });
      try {
        const outcome = await connectionsAdapter.logout(origin);
        setConnectionPhase(
          origin,
          outcome.patNotice
            ? { kind: "notice", message: appT("servers.patNotice") }
            : { kind: "idle" },
        );
        await get().refreshConnections();
      } catch (e) {
        setConnectionPhase(origin, { kind: "error", message: String(e) });
      }
    },
    async removeConnection(id) {
      if (!connectionsAdapter) return;
      const origin = get().connections.find((c) => c.id === id)?.origin;
      if (origin) {
        // 条目要消失了：等待中的登录不得再回填它的状态（Rust 端同时取消它）。
        nextLoginRun(origin);
        setConnectionPhase(origin, { kind: "busy" });
      }
      try {
        await connectionsAdapter.remove(id);
        if (origin) {
          const phases = { ...get().connectionPhases };
          delete phases[origin];
          set({ connectionPhases: phases });
        }
        await get().refreshConnections();
      } catch (e) {
        if (origin) setConnectionPhase(origin, { kind: "error", message: String(e) });
      }
    },

    async openProjectAt(path, options) {
      if (!workspace) return null;
      try {
        const probe = await workspace.openProject(path);
        if (probe.status === "project") {
          const key = await enterProject(probe.root, probe.name);
          return get().activeKey === key && !get().loadFailed ? key : null;
        } else if (probe.status === "uninitialized") {
          set({ pendingInit: probe.dir });
        } else if (probe.status === "unadopted") {
          // 有规格数据但未激活（spec「未激活文件夹经确认后补齐激活」）：
          // 锚定探测回报的项目根打开用确认框，确认前零写入。
          set({ pendingAdopt: probe.root, pendingAdoptImport: probe.needsImport });
        } else if (probe.hasLocalOpenspec) {
          set({
            pendingRemoteConflict: {
              path,
              url: probe.url,
              repo: probe.repo ?? null,
            },
          });
        } else {
          const marker = markerLocation(probe.url);
          let available = get().connections;
          if (connectionsAdapter) {
            available = await connectionsAdapter.list();
            set({ connections: available });
          }
          const connection = available.find(
            (entry) => entry.loggedIn && entry.origin.toLowerCase() === marker.origin,
          );
          const target = probe.repo ? `${marker.project}/${probe.repo}` : marker.project;
          if (!connection) {
            set({ workspaceChooser: { initialServerUrl: marker.origin } });
          } else if (options?.remoteViaChooser) {
            // specseal 网址入口（desktop-deep-link）：不自动同步技能档、不自动连接——
            // 预选好连接、scope 与 checkout，交给用户在选择器确认。
            set({
              workspaceChooser: {
                initialConnectionId: connection.id,
                initialScope: probe.repo ? { projectKey: marker.project, repoKey: probe.repo } : null,
                initialCheckoutPath: path,
              },
            });
          } else if (connectionsAdapter && probe.repo) {
            // 打开前先收敛本机 Agent 工具（spec「remote marker 文件夹的探测分流」）：
            // 有既有选集就自动 reconciliation 后才 handshake；缺选集则导回 chooser
            // checkout 步骤由用户明示选择，同步成功前不创建 remote session。
            const inspection = await connectionsAdapter.inspectCheckout(
              path,
              connection.origin,
              marker.project,
              probe.repo,
            );
            if (inspection.tools.length === 0) {
              set({
                workspaceChooser: {
                  initialConnectionId: connection.id,
                  initialScope: { projectKey: marker.project, repoKey: probe.repo },
                  initialCheckoutPath: path,
                },
              });
            } else {
              await connectionsAdapter.bindCheckout(
                path,
                connection.origin,
                marker.project,
                probe.repo,
                inspection.tools,
              );
              await get().openRemoteWorkspace(connection.id, target, path, path);
            }
          } else {
            await get().openRemoteWorkspace(connection.id, target, path, path);
          }
        }
      } catch (e) {
        // 打开失败（spec：显示带所选路径的单行错误并维持原项目）。
        showFailureToast(path, "store.openProjectFailed", e);
      }
      return null;
    },

    async openProjectViaDialog() {
      if (!workspace) return;
      const picked = await workspace.pickFolder();
      if (picked) await get().openProjectAt(picked);
    },

    async openRemoteWorkspace(connectionId, target, checkoutRoot, dropLocalRoot) {
      if (!openRemote) return;
      // handshake fail-closed（决策 6）：失败原样上抛、不建分页不建 session。
      const session = checkoutRoot
        ? await openRemote(connectionId, target, checkoutRoot)
        : await openRemote(connectionId, target);
      await adoptRemoteSession(
        session,
        dropLocalRoot ? locatorKey({ kind: "local", root: dropLocalRoot }) : undefined,
      );
      // 打开 workspace 的意图是看板——自服务器页切回看板呈现 server 数据。
      set({ boardView: "board", workspaceChooser: null });
    },

    async replaceLocalWorkspaceWithRemote(root, connectionId, target) {
      if (!openRemote) throw new Error("此环境未提供 remote workspace 功能");
      const localKey = locatorKey({ kind: "local", root });
      if (!get().tabs.some((tab) => locatorKey(tab.locator) === localKey)) {
        throw new Error(`找不到待转换的本机分页：${root}`);
      }

      // handshake 成功前不改 store；若打开 remote 失败，原 local 分页与 session 保留。
      const session = await openRemote(connectionId, target, root);
      const remoteKey = session.id;
      const replacement = {
        locator: session.locator,
        name: session.descriptor.name,
      };
      const tabs: ProjectTab[] = [];
      for (const tab of get().tabs) {
        const key = locatorKey(tab.locator);
        if (key === localKey) tabs.push(replacement);
        else if (key !== remoteKey) tabs.push(tab);
      }

      const sessions = { ...get().sessions, [remoteKey]: session };
      delete sessions[localKey];
      const live = new Set(tabs.map((tab) => locatorKey(tab.locator)));
      for (const key of Object.keys(sessions)) if (!live.has(key)) delete sessions[key];
      workspaceSnapshots.delete(localKey);
      pruneWorkspaceSnapshots(live);
      const tabErrors = { ...get().tabErrors };
      delete tabErrors[localKey];
      delete tabErrors[remoteKey];
      const recents = recordRecent(replacement, localKey);
      set({
        tabs,
        recents,
        sessions,
        tabErrors,
        activeKey: remoteKey,
        boardView: "board",
        workspaceChooser: null,
        ...workspaceActivationState(remoteKey),
      });
      persistTabs(tabs, remoteKey);
      persistRecents(recents);
      await get().refresh();
    },

    async activateTab(key) {
      if (!workspace) return;
      const tab = get().tabs.find((t) => locatorKey(t.locator) === key);
      if (!tab) return;
      if (tab.locator.kind === "remote") {
        const existing = get().sessions[key];
        if (existing) {
          bumpRemoteOpenGeneration(key);
          const tabErrors = { ...get().tabErrors };
          delete tabErrors[key];
          const remoteRecovery = { ...get().remoteRecovery };
          delete remoteRecovery[key];
          const recents = recordRecent({ locator: tab.locator, name: tab.name });
          set({
            activeKey: key,
            tabErrors,
            remoteRecovery,
            recents,
            ...workspaceActivationState(key),
          });
          persistTabs(get().tabs, key);
          persistRecents(recents);
          await get().refresh();
        } else {
          await reconnectRemoteTab(key, true);
        }
        return;
      }
      // 探测挡在翻页前（可达秒级）：标出切换中，画面留在原 workspace 且照常可交互。
      // 切换中只涵盖探测本身——翻页后的整批加载由清单 skeleton 承担，两者并存会让
      // 已切换完成的分页持续挂「正在切换」。
      set({ pendingTabKey: key });
      let probe: ProjectProbe | null = null;
      try {
        probe = await workspace.openProject(tab.locator.root);
      } catch (e) {
        set({ tabErrors: { ...get().tabErrors, [key]: String(e) } });
      } finally {
        // 后发切换覆写先发时，先发的收尾不得清掉后发的标记。
        if (get().pendingTabKey === key) set({ pendingTabKey: null });
      }
      if (!probe) return;
      try {
        if (probe.status === "project") {
          await enterProject(probe.root, probe.name);
        } else {
          // openspec/ 已删但目录还在：分页转错误态，不开初始化对话框。
          set({ tabErrors: { ...get().tabErrors, [key]: appT("store.tabInvalid") } });
        }
      } catch (e) {
        set({ tabErrors: { ...get().tabErrors, [key]: String(e) } });
      }
    },

    async retryRemoteWorkspace(key) {
      await reconnectRemoteTab(key, false);
    },

    showRemoteWorkspaceRecovery(key) {
      const tab = get().tabs.find((candidate) => locatorKey(candidate.locator) === key);
      if (tab?.locator.kind !== "remote" || !get().remoteRecovery[key]) return;
      set({
        activeKey: key,
        boardView: "board",
        ...workspaceActivationState(key),
      });
      persistTabs(get().tabs, key);
    },

    forgetRecent(key) {
      const recents = removeRecent(get().recents, key);
      set({ recents });
      persistRecents(recents);
    },

    revealProject: (key) => runOnProjectDir(key, "reveal"),
    openProjectInTerminal: (key) => runOnProjectDir(key, "openTerminal"),
    openProjectInEditor: (key) => runOnProjectDir(key, "openEditor"),
    copyProjectPath: (key) => runOnProjectDir(key, "copyText"),
    async locateDocument(doc) {
      const dir = localDirOf(get().activeKey);
      if (!fsActionsAdapter || dir === null) return null;
      try {
        return await fsActionsAdapter.locate(dir, doc);
      } catch {
        return null;
      }
    },
    openDocumentDefault: (location) =>
      runOnDocument(location.relative, async () => fsActionsAdapter?.openDefault(location.path)),
    revealDocument: (location) =>
      runOnDocument(location.relative, async () => fsActionsAdapter?.reveal(location.path)),
    copyDocumentPath: (location) =>
      runOnDocument(location.relative, async () => fsActionsAdapter?.copyText(location.path)),
    copyDocumentContent: (text) =>
      runOnDocument(appT("detail.copyContent"), async () => fsActionsAdapter?.copyText(text)),
    async revealProjectPath(relative) {
      const dir = localDirOf(get().activeKey);
      if (!fsActionsAdapter || dir === null) return;
      // 相对路径为正斜线；Windows 的 reveal 接受混合分隔符（Rust std::path 吸收）。
      await runOnDocument(relative, async () => fsActionsAdapter.reveal(`${dir}/${relative}`));
    },

    closeTab(key) {
      bumpRemoteOpenGeneration(key);
      const tabs = removeTab(get().tabs, key);
      const sessions = { ...get().sessions };
      delete sessions[key];
      const tabErrors = { ...get().tabErrors };
      delete tabErrors[key];
      const remoteRecovery = { ...get().remoteRecovery };
      delete remoteRecovery[key];
      const wasActive = get().activeKey === key;
      const activeKey = wasActive ? null : get().activeKey;
      workspaceSnapshots.delete(key);
      latestRefreshGeneration.delete(key);
      set({
        tabs,
        sessions,
        tabErrors,
        remoteRecovery,
        activeKey,
        ...(wasActive
          ? {
              ...emptyWorkspaceSnapshot(),
              ...resetWorkspaceTransientState(),
              // 关掉的分页若还有在途加载，它会自行 settle；此刻的加载中看新的
              // activeKey（零分页即 null）——不是清谁的旗标，是重算导出值。
              loadingActive: loadingActiveFor(activeKey),
            }
          : {}),
      });
      persistTabs(tabs, activeKey);
      // 关掉 active 分页：切到最近的剩余分页（走完整打开语意）；零分页则空状态。
      if (wasActive) {
        const next = tabs.at(-1);
        if (next) void get().activateTab(locatorKey(next.locator));
      }
    },

    async confirmInit(tools) {
      const dir = get().pendingInit;
      set({ pendingInit: null });
      if (!dir || !workspace) return;
      try {
        const probe = await workspace.initProject(dir, tools);
        if (probe.status === "project") await enterProject(probe.root, probe.name);
      } catch (e) {
        // 初始化失败：显示带所选目录的单行错误、不切换 root（spec）。
        showFailureToast(dir, "store.initFailed", e);
      }
    },

    cancelInit() {
      set({ pendingInit: null });
    },

    async confirmAdopt(tools) {
      const root = get().pendingAdopt;
      set({ pendingAdopt: null });
      if (!root || !workspace) return;
      try {
        const probe = await workspace.adoptProject(root, tools);
        if (probe.status === "project") await enterProject(probe.root, probe.name);
      } catch (e) {
        // 激活失败：显示带项目根的单行错误、不切换 root（spec）。
        showFailureToast(root, "store.adoptFailed", e);
      }
    },

    cancelAdopt() {
      set({ pendingAdopt: null });
    },

    async cycleTab() {
      const { tabs, activeKey } = get();
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => locatorKey(t.locator) === activeKey);
      const next = tabs[(idx + 1) % tabs.length];
      await get().activateTab(locatorKey(next.locator));
    },

    async gotoTab(n) {
      const target = get().tabs[n - 1];
      if (!target || locatorKey(target.locator) === get().activeKey) return;
      await get().activateTab(locatorKey(target.locator));
    },

    assetPrompts: {},
    assetUpdateError: null,
    assetUpdating: false,
    assetMigrated: null,

    async refreshAssetPrompt() {
      const key = get().activeKey;
      const subject = activeAssetSubject();
      set({ assetUpdateError: null });
      // 没有 checkout 的 remote 分页无受管技能档可查；无 adapter 时 UI 不激活。
      if (!workspace || !subject || !key) return;
      await probeAssetPromptFor(workspace, key, subject);
    },

    async applyAssetUpdate() {
      const key = get().activeKey;
      const subject = activeAssetSubject();
      if (!workspace || !subject || !key || get().assetUpdating) return;
      set({ assetUpdating: true, assetUpdateError: null });
      // 确认框写的迁移内容是承诺（例如「文件夹不动」）：按下前状态变了就改显示最新内容。
      const shown = get().assetPrompts[key]?.migration.state ?? "none";
      let fresh: AssetPromptState | null;
      try {
        fresh = await promptAt(workspace, subject);
      } catch (error) {
        set({ assetUpdateError: String(error), assetUpdating: false });
        return;
      }
      if ((fresh?.migration.state ?? "none") !== shown) {
        set({ assetPrompts: { ...get().assetPrompts, [key]: fresh }, assetUpdating: false });
        return;
      }
      let result: AssetUpdateResult;
      try {
        result =
          subject.kind === "remote"
            ? await workspace.updateRemoteAssets(subject.checkout)
            : await workspace.updateAssets(subject.root);
      } catch (error) {
        // 失败留在原位可重试——update() 幂等，重试即收敛（决策 5）。
        set({ assetUpdateError: String(error), assetUpdating: false });
        // 更新期间监看已暂停（Windows 上监看会挡住文件夹改名）。
        await get().rearmWatch();
        return;
      }
      const { migrated } = result;
      set({
        assetUpdating: false,
        assetMigrated: migrated.movedFolder || migrated.renamed > 0 ? { ...migrated, key } : null,
      });
      // 文件夹改名后监看依新的规格文件夹重新解析；重挂不发事件，数据改从 specseal/ 读要整批重载。
      await get().rearmWatch();
      if (migrated.movedFolder && get().activeKey === key) await get().refresh();
      // 重探套用的那个分页：用户途中切走，它的提示与琥珀点仍要收合。
      await probeAssetPromptFor(workspace, key, subject);
    },

    closeAssetMigrated() {
      set({ assetMigrated: null });
    },

    dismissAssetPrompt() {
      const key = get().activeKey;
      const subject = activeAssetSubject();
      const prompt = selectAssetPrompt(get());
      if (!key || !subject || !prompt) return;
      writeAssetSkip(subject.skipKey, prompt.version);
      set({ assetPrompts: { ...get().assetPrompts, [key]: null }, assetUpdateError: null });
    },

    async restoreTabs() {
      if (!workspace) return;
      const persisted = readPersistedTabs();
      const tabs: ProjectTab[] = persisted.tabs.map((t) => ({ ...t }));
      // 最近打开（design D5）：键缺席即升级后首次启动，以分页反序（最后打开在最前）
      // 补种一次；键已存在（含空清单与坏数据归零）照用、不补种。
      const storedRecents = readPersistedRecents();
      const recents =
        storedRecents ?? [...tabs].reverse().map(({ locator, name }) => ({ locator, name }));
      if (storedRecents === null) persistRecents(recents);
      set({ tabs, recents });
      // 首启活跃项目由持久化 activeKey 决定（决策 4/6）。
      const activeTab = persisted.activeKey
        ? tabs.find((t) => locatorKey(t.locator) === persisted.activeKey)
        : undefined;
      if (activeTab) {
        // 切回上次活跃项目（完整打开语意；失效即转错误态、维持空状态）。
        await get().activateTab(locatorKey(activeTab.locator));
      } else if (tabs.length === 0) {
        // 首启无持久化分页：启动目录（cwd 探索）若是项目即自动记入。
        try {
          const dir = await workspace.startupDir();
          const probe = await workspace.openProject(dir);
          if (probe.status === "project") await enterProject(probe.root, probe.name);
        } catch {
          // 非项目目录启动：维持零分页空状态。
        }
      }
      // 背景 local 分页启动时各探测一次路径有效性；失效转错误态（design D11）。
      // 不等它们完成：restoreTabs 是 specseal 网址的就绪信号，卡住的背景分页不得拖住它。
      const active = get().activeKey;
      void Promise.all(
        get()
          .tabs.filter((t) => locatorKey(t.locator) !== active)
          .map(async (t) => {
            const key = locatorKey(t.locator);
            if (t.locator.kind !== "local") return;
            try {
              await workspace.projectStats(t.locator.root);
            } catch (e) {
              set({ tabErrors: { ...get().tabErrors, [key]: String(e) } });
            }
          }),
      );
    },
    };
  });
}

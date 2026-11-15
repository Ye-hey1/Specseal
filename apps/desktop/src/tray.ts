// 系统匣状态菜单（design D1/D3/D5）：前端拥有的呈现面。分两层——
// (1) buildTrayModel：store 快照 → 菜单模型的纯函数（本档上半，无 Tauri 依赖、直测）；
// (2) 接线层：订阅 store、去抖重建、挂点击 handler（本档下半，以 Tauri JS tray/menu API）。
import { changeStage, planWave, STAGES, type ChangeItem } from "@specseal/ui";
import { TrayIcon } from "@tauri-apps/api/tray";
import {
  Menu,
  type MenuItemOptions,
  type CheckMenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { handleIconState } from "@tauri-apps/plugin-positioner";

import { appT } from "./i18n/runtime";
import type { ConnectionView } from "./adapter/connections";
import {
  locatorKey,
  remoteWorkspaceStatus,
  type RemoteRecoveryKind,
  type RemoteWorkspaceRecoveryState,
  type RemoteWorkspaceStatus,
  type WorkspaceLocator,
  type WorkspaceSession,
} from "./session";
import { trayIconBytes } from "./trayIcon";
import { detectPlatform, type Platform } from "./platform";

/** 系统匣交互样式：由平台决定（macOS 与 Windows＝panel、Linux＝native-menu），panel
    创建失败时退回 native-menu——运行期状态、不持久化（tray-macos-panel-only 拆除偏好）。 */
export type TrayStyle = "native-menu" | "panel";

export type TrayTabSnapshot =
  | {
      key: string;
      name: string;
      source: "local";
      status: "ready";
    }
  | {
      key: string;
      name: string;
      source: "remote";
      status: RemoteWorkspaceStatus;
      /** 仅 remote error 的封闭分类；不把 raw technical detail 带入 Tray。 */
      failureKind?: RemoteRecoveryKind;
      connectionId: string;
      serverLabel: string;
      serverOrigin?: string;
    };

/** 组模型所需的 store 快照（自 AppState 收敛而来——与看板同源，design D3）。
 * 分页项识别与切换把手皆为 locator key（workspace-session 决策 6）。 */
export interface TraySnapshot {
  tabs: TrayTabSnapshot[];
  activeKey: string | null;
  changes: ChangeItem[];
  /** 进看板的 active 讨论（slug 供点击打开；promoted＝已转出、已有结论且未保留
   * （hold 非 true），分流至「已转出」分区——尚无结论或保留在途者留「讨论」分区，
   * 只有引擎会自动收走的讨论才算已转出）。 */
  discussions: Array<{ slug: string; topic: string; promoted: boolean }>;
  /** 探测进行中的目标分页 key（null＝无切换）：面板据此在该分页出 spinner。 */
  pendingTabKey: string | null;
  /** 活跃 workspace 的首访加载进行中（design D3）：整条骨架条件由 store 导出，
   * 与主窗口看板同一个值——面板纯渲染，不自行组合旗标。 */
  workspaceLoading: boolean;
  /** 活跃 workspace 首访加载以失败收场：分区显示加载失败提示（非空态、非骨架）。
   * 已有旧缓存的重载失败为 false——那条照旧沿用最后成功数据，不提示。 */
  workspaceLoadFailed: boolean;
}

/** 变更子菜单的动作项。 */
export type TrayChangeAction = { kind: "open-change" | "copy-name"; label: string };

/** 讨论子菜单的动作项。 */
export type TrayDiscussionAction = { kind: "open-discussion" | "copy-slug"; label: string };

export type TrayRecoveryAction = {
  kind: "retry" | "open-recovery" | "open-settings" | "reauthenticate";
  label: string;
};

/** 分区溢出门槛（spec「分区溢出折叠」）：各分区直列笔数上限，逾此收进溢出节点。 */
export const OVERFLOW_LIMIT = 5;

/** 菜单项目模型（纯数据；接线层据此建原生 menu item 并挂 action）。 */
export type TrayMenuItem =
  | {
      kind: "project";
      key: string;
      label: string;
      checked: boolean;
      source: "local" | "remote";
      status: "ready" | "offline";
    }
  | {
      kind: "recovery";
      key: string;
      connectionId: string;
      label: string;
      summary: string;
      active: boolean;
      status: "restoring" | "error" | "needs-reauth";
      actions: TrayRecoveryAction[];
    }
  | { kind: "header"; label: string }
  | { kind: "change"; name: string; label: string; actions: TrayChangeAction[] }
  | {
      kind: "discussion";
      slug: string;
      /** 父项标签＝slug（识别锚点直出）；topic 降为子菜单首行描述。 */
      label: string;
      topic: string;
      actions: TrayDiscussionAction[];
    }
  | {
      /** 分区溢出节点「还有 N 个…」：内嵌其余项目的同构模型（接线层递归转子菜单）。 */
      kind: "overflow";
      label: string;
      items: TrayMenuItem[];
    }
  | { kind: "empty"; label: string }
  | { kind: "separator" }
  | { kind: "open"; label: string }
  | { kind: "project-settings"; label: string }
  | { kind: "settings"; label: string }
  | { kind: "quit"; label: string };

export interface TrayModel {
  items: TrayMenuItem[];
}

/** unicode 方块进度条（width 格）；total<=0 回空字符串（无任务不画）。 */
export function progressBar(completed: number, total: number, width = 8): string {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((completed / total) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** 变更列标签：有任务时「名称  ▓▓░ n/m」，无任务时仅名称；清单项带 wave 时前缀
 * 「N· 」（spec tray-status-menu「变更列的波次标示与顺序同源」——原生菜单无法变淡，
 * 只加波次数字）。name（拷贝来源）不带前缀。 */
function changeLabel(c: ChangeItem): string {
  const wave = planWave(c);
  const prefix = wave === null ? "" : `${wave}· `;
  if (c.totalTasks <= 0) return `${prefix}${c.name}`;
  const bar = progressBar(c.completedTasks, c.totalTasks);
  return `${prefix}${c.name}  ${bar} ${c.completedTasks}/${c.totalTasks}`;
}

/**
 * 由 store 快照组出菜单模型。纯函数、无平台分支。区段顺序：
 * 项目区（作用中打勾）→ 分隔 → 生命周期分区（提案中/进行中/已就绪各一 header＋变更子菜单，
 * 变更列带进度条，子菜单含「打开此变更」「拷贝名称」；全无变更则空状态）→ 分隔 →
 * 讨论区（header＋各讨论子菜单：父项标签为 slug、topic 为子菜单首行描述、
 * 含「打开此讨论」「拷贝 slug」；无则「讨论 0」）→ 分隔 → 动作区（打开 Specseal、项目设置、
 * 设置、结束——项目层动作在前、app 层在后，与主窗口侧栏层次一致）。
 */
export function buildTrayModel(
  snapshot: TraySnapshot,
  t: (key: string) => string,
): TrayModel {
  const items: TrayMenuItem[] = [];
  const activeTab = snapshot.tabs.find((tab) => tab.key === snapshot.activeKey);
  const hideWorkspaceData =
    activeTab?.status === "restoring" || activeTab?.status === "error";

  const statusSummary = (tab: TrayTabSnapshot): string => {
    if (tab.source === "local") return "";
    if (tab.status === "restoring") return t("tray.recovery.restoring");
    if (tab.status === "offline") return t("tray.recovery.offline");
    if (tab.status === "needs-reauth" || tab.failureKind === "needs-reauth") {
      return t("tray.recovery.needsReauth");
    }
    if (tab.failureKind === "access-denied") return t("tray.recovery.accessDenied");
    if (tab.failureKind === "not-found") return t("tray.recovery.notFound");
    if (tab.failureKind === "unknown") return t("tray.recovery.unknown");
    return t("tray.recovery.unreachable");
  };

  /** 分区切片：逾门槛收进「还有 N 个…」溢出节点（≤门槛原样返回）。 */
  const withOverflow = (rows: TrayMenuItem[]): TrayMenuItem[] => {
    if (rows.length <= OVERFLOW_LIMIT) return rows;
    return [
      ...rows.slice(0, OVERFLOW_LIMIT),
      {
        kind: "overflow",
        label: t("tray.more").replace("{n}", String(rows.length - OVERFLOW_LIMIT)),
        items: rows.slice(OVERFLOW_LIMIT),
      },
    ];
  };

  // 项目区（识别＝locator key；显示文本与行为不变）
  for (const tab of snapshot.tabs) {
    if (tab.status === "ready" || tab.status === "offline") {
      items.push({
        kind: "project",
        key: tab.key,
        label:
          tab.status === "offline" ? `${tab.name} — ${statusSummary(tab)}` : tab.name,
        checked: tab.key === snapshot.activeKey,
        source: tab.source,
        status: tab.status,
      });
    } else {
      const needsReauth =
        tab.status === "needs-reauth" || tab.failureKind === "needs-reauth";
      const summary = statusSummary(tab);
      const actions: TrayRecoveryAction[] =
        tab.status === "restoring"
          ? []
          : [
              {
                kind: needsReauth ? "reauthenticate" : "retry",
                label: t(
                  needsReauth
                    ? "tray.recovery.reauthenticate"
                    : "tray.recovery.retry",
                ),
              },
              { kind: "open-recovery", label: t("tray.recovery.open") },
              { kind: "open-settings", label: t("tray.recovery.settings") },
            ];
      items.push({
        kind: "recovery",
        key: tab.key,
        connectionId: tab.connectionId,
        label: `${tab.name} — ${summary}`,
        summary,
        active: tab.key === snapshot.activeKey,
        status: tab.status,
        actions,
      });
    }
  }
  if (snapshot.tabs.length > 0) items.push({ kind: "separator" });

  if (!hideWorkspaceData) {
    // 生命周期分区：每个非空阶段一个 header＋变更子菜单
    let anyChange = false;
    for (const stage of STAGES) {
      const staged = snapshot.changes.filter((c) => changeStage(c) === stage);
      if (staged.length === 0) continue;
      anyChange = true;
      items.push({ kind: "header", label: t(`stage.${stage}`) });
      items.push(
        ...withOverflow(
          staged.map((c): TrayMenuItem => ({
            kind: "change",
            name: c.name,
            label: changeLabel(c),
            actions: [
              { kind: "open-change", label: t("tray.openChange") },
              { kind: "copy-name", label: t("tray.copyName") },
            ],
          })),
        ),
      );
    }
    if (!anyChange) items.push({ kind: "empty", label: t("tray.noChanges") });

    items.push({ kind: "separator" });

    // 讨论区分流（spec「讨论列表」）。
    const discussionItem = (d: { slug: string; topic: string }): TrayMenuItem => ({
      kind: "discussion",
      slug: d.slug,
      label: d.slug,
      topic: d.topic,
      actions: [
        { kind: "open-discussion", label: t("tray.openDiscussion") },
        { kind: "copy-slug", label: t("tray.copySlug") },
      ],
    });
    const openDiscussions = snapshot.discussions.filter((d) => !d.promoted);
    const promotedDiscussions = snapshot.discussions.filter((d) => d.promoted);
    if (openDiscussions.length > 0) {
      items.push({ kind: "header", label: t("tray.discussionsHeader") });
      items.push(...withOverflow(openDiscussions.map(discussionItem)));
    } else {
      items.push({ kind: "empty", label: t("tray.discussions").replace("{n}", "0") });
    }
    if (promotedDiscussions.length > 0) {
      items.push({ kind: "header", label: t("tray.promotedHeader") });
      items.push(...withOverflow(promotedDiscussions.map(discussionItem)));
    }

    items.push({ kind: "separator" });
  }
  items.push({ kind: "open", label: t("tray.open") });
  // 文案沿用主窗口侧栏「项目设置」词条——同概念同词，不另造 tray 专属键。
  items.push({ kind: "project-settings", label: t("app.navProjectSettings") });
  items.push({ kind: "settings", label: t("tray.settings") });
  items.push({ kind: "quit", label: t("tray.quit") });

  return { items };
}

// ---- 接线层：订阅 store、去抖重建、挂点击 handler ----

/** tray 订阅所需的最小 store 接口（Zustand bound store 兼容——AppState 的结构子集）。 */
export interface TrayStoreApi {
  getState: () => {
    tabs: Array<{ locator: WorkspaceLocator; name: string }>;
    activeKey: string | null;
    /** 探测进行中的目标分页 key（store 的切换中标记）。 */
    pendingTabKey: string | null;
    /** 活跃 workspace 快照是否已完成首次加载。 */
    loaded: boolean;
    /** 活跃 workspace 有整批加载在途（store 导出，非手动记帐）。 */
    loadingActive: boolean;
    /** 活跃 workspace 最近一次整批加载以失败收场。 */
    loadFailed: boolean;
    changes: ChangeItem[];
    discussions: {
      active: Array<{
        slug: string;
        topic: string;
        promotedTo: string[];
        concluded?: boolean;
        hold?: boolean;
      }>;
    };
    sessions: Record<string, WorkspaceSession>;
    remoteRecovery: Record<string, RemoteWorkspaceRecoveryState>;
    connections: ConnectionView[];
    /** 系统匣样式：native-menu 挂原生菜单；panel 的点击改走 action（Windows 右键仍是原生菜单）。 */
    trayStyle: TrayStyle;
    /** 切换既有分页；locator key 同时涵盖 local 与 remote。 */
    activateTab: (key: string) => void | Promise<void>;
    retryRemoteWorkspace: (key: string) => void | Promise<void>;
    showRemoteWorkspaceRecovery: (key: string) => void;
    openConnectionReauth: (connectionId: string) => void;
    /** 开文件夹选择器加入项目（面板 add-project 动作用；取消即无事）。 */
    openProjectViaDialog: () => void | Promise<void>;
    /** 打开变更详情抽屉（子菜单「打开此变更」用）。 */
    openDetail: (name: string) => void;
    /** 打开讨论抽屉（讨论项点击用）。 */
    openDiscussion: (slug: string) => void;
    /** 切换主页面（动作区「项目设置」「设置」用；store 既有 BoardView 动作的结构子集）。 */
    setBoardView: (view: "settings" | "project-settings") => void;
  };
  subscribe: (listener: () => void) => () => void;
}

export interface TrayDeps {
  /** 平台（可注入以利测试；缺省由 navigator 侦测）：macOS 套 template 图标；panel 样式下
   * macOS 左右键皆开闭面板、Windows 左键开闭面板且右键为原生菜单。 */
  platform?: Platform;
  /** 菜单重建去抖延迟（ms）；缺省与看板刷新同量级（400ms）。 */
  debounceMs?: number;
  /** 面板样式下点击图标的开闭回调（面板实作由调用端注入；未注入即无动作）。 */
  onPanelToggle?: () => void;
}

export interface TrayController {
  /** 卸载时调用：取消订阅、清去抖 timer、关闭 tray 图标。 */
  dispose: () => void;
}

/** 面板骨架条件（design D3）：探测中或整批加载在途，且尚无真值。与 App.tsx
 * 传给看板的 loading 同式——快照导出与即推面共用这一份，不会各算各的。 */
function workspaceLoadingOf(
  state: Pick<ReturnType<TrayStoreApi["getState"]>, "pendingTabKey" | "loadingActive" | "loaded">,
): boolean {
  return (state.pendingTabKey !== null || state.loadingActive) && !state.loaded;
}

/** store 状态 → 模型快照（与看板同源）。 */
export function buildTraySnapshot(state: ReturnType<TrayStoreApi["getState"]>): TraySnapshot {
  return {
    tabs: state.tabs.map((tab): TrayTabSnapshot => {
      const key = locatorKey(tab.locator);
      if (tab.locator.kind === "local") {
        return { key, name: tab.name, source: "local", status: "ready" };
      }
      const connectionId = tab.locator.connectionId;
      const recovery = state.remoteRecovery[key];
      const session = state.sessions[key];
      const connection = state.connections.find((entry) => entry.id === connectionId);
      return {
        key,
        name: tab.name,
        source: "remote",
        status: remoteWorkspaceStatus(session, recovery),
        failureKind:
          recovery?.status === "error"
            ? recovery.failure.kind
            : session?.connectionState?.state === "needs-reauth"
              ? "needs-reauth"
              : undefined,
        connectionId,
        serverLabel: connection?.name ?? connectionId,
        serverOrigin: connection?.origin,
      };
    }),
    activeKey: state.activeKey,
    changes: state.changes,
    discussions: state.discussions.active.map((d) => ({
      slug: d.slug,
      topic: d.topic,
      // 只有引擎会自动收走的讨论才归「已转出」分区：已转出、已有结论、未保留。
      // concluded 缺席（旧 server）退回「转出即已转出」的既有判准，不把缺席当成
      // 尚无结论；hold 缺席视同未保留，不把缺席当成保留。
      promoted: d.promotedTo.length > 0 && d.concluded !== false && d.hold !== true,
    })),
    pendingTabKey: state.pendingTabKey,
    // 骨架条件在此收敛成一栏（design D3）——面板与主窗口不会各自算出不同答案。
    workspaceLoading: workspaceLoadingOf(state),
    // 首访失败才是终态提示；有旧缓存时照旧沿用最后成功数据，不提示。
    workspaceLoadFailed: state.loadFailed && !state.loaded,
  };
}

/**
 * 初始化系统匣原生菜单：建图标与首份菜单、订阅 store（去抖重建菜单）。
 * 回传 controller，其 dispose 于 app 卸载时清理。项目切换走 store 既有 activateTab
 * 且不动窗口焦点；变更子菜单「打开此变更」与讨论项开主窗口并跳详情；「结束」为原生 predefined Quit。
 */
export async function initTray(store: TrayStoreApi, deps: TrayDeps = {}): Promise<TrayController> {
  const platform = deps.platform ?? detectPlatform();
  const debounceMs = deps.debounceMs ?? 400;
  const icon = await Image.fromBytes(trayIconBytes());

  type TrayItemOptions =
    | MenuItemOptions
    | CheckMenuItemOptions
    | PredefinedMenuItemOptions
    | SubmenuOptions;
  /** 开主窗口并运行 store 动作（子菜单/讨论项用）——tray 于主窗口 context，直接调用 store。 */
  const openIn = (fn: () => void) => {
    void openMainWindow();
    fn();
  };
  /** 写剪贴板（Rust 端插件——主窗口隐藏/无焦点仍成功）；失败静默、不弹窗不中断菜单。 */
  const copy = (text: string) => {
    void writeText(text).catch(() => {});
  };
  /** 动作联集 → 子菜单项：open-* 开主窗口运行 store 动作、copy-* 写剪贴板。 */
  const actionItems = (
    actions: Array<TrayChangeAction | TrayDiscussionAction>,
    open: () => void,
    copyText: string,
  ): MenuItemOptions[] =>
    actions.map((a) => ({
      text: a.label,
      action:
        a.kind === "open-change" || a.kind === "open-discussion"
          ? () => openIn(open)
          : () => copy(copyText),
    }));
  const toOptions = (item: TrayMenuItem): TrayItemOptions => {
    switch (item.kind) {
      case "project":
        return {
          text: item.label,
          checked: item.checked,
          action: () => {
            void store.getState().activateTab(item.key);
          },
        };
      case "recovery":
        if (item.actions.length === 0) return { text: item.label, enabled: false };
        return {
          text: item.label,
          items: [
            {
              text: appT(item.active ? "tray.recovery.active" : "tray.recovery.inactive"),
              enabled: false,
            },
            { text: item.summary, enabled: false },
            ...item.actions.map((action): MenuItemOptions => ({
              text: action.label,
              action: () => {
                if (action.kind === "retry") {
                  void store.getState().retryRemoteWorkspace(item.key);
                } else if (action.kind === "open-recovery") {
                  openIn(() => store.getState().showRemoteWorkspaceRecovery(item.key));
                } else {
                  openIn(() => store.getState().openConnectionReauth(item.connectionId));
                }
              },
            })),
          ],
        };
      case "header":
      case "empty":
        return { text: item.label, enabled: false };
      case "change":
        return {
          text: item.label,
          items: actionItems(item.actions, () => store.getState().openDetail(item.name), item.name),
        };
      case "discussion":
        return {
          text: item.label,
          items: [
            // topic 首行描述：disabled、不可选取，仅供辨识
            { text: item.topic, enabled: false },
            ...actionItems(
              item.actions,
              () => store.getState().openDiscussion(item.slug),
              item.slug,
            ),
          ],
        };
      case "overflow":
        // 溢出节点 → 原生子菜单（内嵌项目递归转换；macOS 菜单超高原生卷动）
        return { text: item.label, items: item.items.map(toOptions) };
      case "separator":
        return { item: "Separator" };
      case "open":
        return { text: item.label, action: () => openMainWindow() };
      case "project-settings":
        // 唤起主窗口＋切至作用中项目的项目设置页；recovery／stale 不特判——呈现交主窗口既有行为
        return { text: item.label, action: () => openIn(() => store.getState().setBoardView("project-settings")) };
      case "settings":
        // 唤起主窗口＋切设置页（与「打开此变更」同一唤起语意）
        return { text: item.label, action: () => openIn(() => store.getState().setBoardView("settings")) };
      case "quit":
        return { item: "Quit", text: item.label };
    }
  };
  const styleOf = () => store.getState().trayStyle;
  const render = async () => {
    const model = buildTrayModel(buildTraySnapshot(store.getState()), appT);
    const menu = await Menu.new({ items: model.items.map(toOptions) });
    return { menu };
  };

  // 挂菜单的时机：native-menu 样式，或 Windows 的 panel 样式（右键由系统显示同一份
  // 原生菜单——spec「面板样式」平台差异；tray-panel-windows design D5）。左键开菜单
  // 只属 native-menu：panel 样式的左键要留给 action 开闭面板。
  const menuAttached = () => styleOf() === "native-menu" || platform === "windows";
  // macOS 的面板左右键等价；Windows 的右键已交给原生菜单，只有左键开闭面板。
  const panelButtons = platform === "windows" ? ["Left"] : ["Left", "Right"];
  const first = await render();
  // 固定 id＋先移除同 id 孤儿：webview 重建（重载、窗口重开）会再跑 initTray，
  // 前一个 context 的 tray 无人 dispose 时成为僵尸——其 title 永远冻在最后值，
  // 用户看到的就是「徽章不更新」。同 id 至多一个 tray，僵尸在此被清掉。
  try {
    await TrayIcon.removeById("specseal-tray");
  } catch {
    /* 无孤儿即略过 */
  }
  const tray = await TrayIcon.new({
    // Windows 面板定位以此 id 找图标位置（src-tauri/src/panel.rs 的 TRAY_ID），两处须一致。
    id: "specseal-tray",
    icon,
    iconAsTemplate: platform === "macos",
    tooltip: "Specseal",
    // 样式分流：native-menu 挂菜单（左键开菜单）；panel 的点击交给 action。
    menu: menuAttached() ? first.menu : undefined,
    showMenuOnLeftClick: styleOf() === "native-menu",
    action: (event) => {
      // 面板样式限定（原生菜单样式由菜单接管点击）。
      if (styleOf() !== "panel") return;
      // macOS 先喂 tray 事件座标给 positioner——面板显示前的 tray 相对定位依此计算；
      // Windows 的面板位置由 Tauri 壳读图标位置自算（tray-panel-windows design D3）。
      if (platform === "macos") void handleIconState(event).catch(() => {});
      const e = event as { type?: string; button?: string; buttonState?: string };
      // 放开才开闭；哪些键开闭面板依平台（spec「面板样式」平台差异）。
      if (
        e.type === "Click" &&
        panelButtons.includes(e.button ?? "") &&
        e.buttonState === "Up"
      ) {
        deps.onPanelToggle?.();
      }
    },
  });

  // 面板接线（design D5）：主窗口拥有数据——面板 ready 时补推快照（lazy 建窗的
  // 首开空窗）、去抖订阅时推送、面板动作事件回流 store 运行（与菜单动作同语意）。
  const pushSnapshot = () => {
    void emit("tray-snapshot", buildTraySnapshot(store.getState()));
  };
  const unlistenReady = await listen("tray-panel-ready", pushSnapshot);
  const unlistenAction = await listen<{ kind: string; id?: string }>(
    "tray-panel-action",
    (event) => {
      const { kind, id } = event.payload ?? {};
      if (kind === "open-project" && id) void store.getState().activateTab(id);
      else if (kind === "retry-workspace" && id) void store.getState().retryRemoteWorkspace(id);
      else if (kind === "open-recovery" && id) {
        openIn(() => store.getState().showRemoteWorkspaceRecovery(id));
      } else if ((kind === "open-server-settings" || kind === "reauthenticate") && id) {
        openIn(() => store.getState().openConnectionReauth(id));
      }
      // 快速加入项目（D7）：走 openIn 先唤起主窗口——主窗口位于另一桌面时
      // macOS 随聚焦切换 Space，文件夹选择器才于前景可见；取消即无事。
      else if (kind === "add-project") openIn(() => void store.getState().openProjectViaDialog());
      else if (kind === "open-change" && id) openIn(() => store.getState().openDetail(id));
      else if (kind === "open-discussion" && id) openIn(() => store.getState().openDiscussion(id));
      else if (kind === "open-app") void openMainWindow();
      else if (kind === "open-project-settings") {
        openIn(() => store.getState().setBoardView("project-settings"));
      } else if (kind === "open-settings") openIn(() => store.getState().setBoardView("settings"));
      // 结束走 Rust 命令（webview 无法自行结束行程）；失败静默——tray 无可浮出错误的接口。
      else if (kind === "quit") void invoke("quit_app").catch(() => {});
    },
  );

  // 去抖订阅：数据或样式变动后依样式分流——要挂菜单者重建菜单，其余卸菜单；
  // 两样式皆推送快照给面板（面板未开时为无害广播）。
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 面板的「我在看哪个 workspace、它载完了没」走即时推送，不进去抖：spec 要求
  // 点下分页当下就出 spinner，且 spinner 消失与高亮移转须同批抵达。去抖每次 store
  // 变动都重设计时器——这些字段若跟着去抖，面板会闪一下 spinner 就回到切换前的
  // 样子。清单内容变动仍走去抖（原生菜单重建的成本在那里）。
  // JSON 串行化而非字符串拼接：locator key 内含路径（可能有空白），拼接的字段
  // 边界不明确，不同状态组合能拼出同一字符串而漏掉推送。
  // 加载态纳入此面（design D3，取代 desktop-loading-skeleton-ux D5 的去抖例外）：
  // 首访失败时翻的是加载态而非 loaded，不纳入就得等一个去抖周期才收掉骨架。
  // 已访 workspace 的周期性刷新恒为 false（有真值即非骨架），不会每轮翻两次。
  const surfaceKey = () => {
    const s = store.getState();
    return JSON.stringify([s.pendingTabKey, s.activeKey, workspaceLoadingOf(s)]);
  };
  let lastSurface = surfaceKey();
  // 即推以 microtask 合并：翻页入口在同一同步段内连续两次 set（先翻 activeKey、
  // 再由 refresh 的计数翻真），逐次即推会把中间那份「已翻页、尚未起加载」的
  // 假空态推给面板。同段变动只推一份最终快照；跨段（真正的先后事件）仍逐次即推。
  let pushQueued = false;
  const unsubscribe = store.subscribe(() => {
    const surface = surfaceKey();
    if (surface !== lastSurface) {
      lastSurface = surface;
      if (!pushQueued) {
        pushQueued = true;
        queueMicrotask(() => {
          pushQueued = false;
          pushSnapshot();
        });
      }
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        pushSnapshot();
        try {
          await tray.setMenu(menuAttached() ? (await render()).menu : null);
          // panel 样式必关左键开菜单：不关，左键仍被「开菜单」路径吃掉（macOS 菜单
          // 已空＝点了无事发生），点击事件到不了 action／面板。
          await tray.setShowMenuOnLeftClick(styleOf() === "native-menu");
        } catch (e) {
          console.error("tray menu update failed", e);
        }
      })();
    }, debounceMs);
  });

  return {
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      unlistenReady();
      unlistenAction();
      void tray.close();
    },
  };
}

/** 显示主窗口并取得焦点（自最小化亦还原）——菜单、面板与 specseal 网址（deepLink.ts）
 * 所有唤起主窗口的动作共用。
 * 先收合面板再唤起（spec「面板交接主窗口后鼠标交互完整」、design D2）：交接当下
 * 不再有面板与主窗口同拍互踩；命令幂等，面板已因失焦先收合亦无事、不会重开。
 * 收合失败静默——不阻断后续 show 与 setFocus。 */
export async function openMainWindow(): Promise<void> {
  await invoke("hide_tray_panel").catch(() => {});
  const win = getCurrentWindow();
  await win.unminimize();
  await win.show();
  await win.setFocus();
}

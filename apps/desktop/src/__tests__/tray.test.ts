import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChangeItem } from "@specseal/ui";
import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu } from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit as tauriEmit, listen as tauriListen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { handleIconState } from "@tauri-apps/plugin-positioner";

import {
  buildTrayModel,
  buildTraySnapshot,
  progressBar,
  initTray,
  type TraySnapshot,
  type TrayMenuItem,
  type TrayStoreApi,
} from "../tray";
import type { WorkspaceLocator } from "../session";
import type {
  RemoteWorkspaceRecoveryState,
  WorkspaceSession,
} from "../session";
import type { ConnectionView } from "../adapter/connections";
import { trayIconBytes } from "../trayIcon";

// tray.ts 于顶层 import @tauri-apps/api 的 tray/menu/window/image（＋面板模式的 webviewWindow/dpi）；
// 于 jsdom 下以桩替，使模块加载安全并让接线测试可拦截调用。纯函数测试不触及这些。
vi.mock("@tauri-apps/api/tray", () => ({
  TrayIcon: { new: vi.fn(), removeById: vi.fn() },
}));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { fromBytes: vi.fn() } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-positioner", () => ({
  handleIconState: vi.fn().mockResolvedValue(undefined),
}));

const fakeT = (key: string): string =>
  (({
    "tray.open": "打开 Specseal",
    "tray.settings": "设置",
    "tray.quit": "结束",
    "app.navProjectSettings": "项目设置",
    "tray.discussions": "讨论 {n}",
    "tray.discussionsHeader": "讨论",
    "tray.promotedHeader": "已转出",
    "tray.more": "还有 {n} 个…",
    "tray.openChange": "打开此变更",
    "tray.copyName": "拷贝名称",
    "tray.openDiscussion": "打开此讨论",
    "tray.copySlug": "拷贝 slug",
    "tray.noChanges": "尚无进行中变更",
    "tray.recovery.active": "作用中",
    "tray.recovery.restoring": "正在连接",
    "tray.recovery.offline": "脱机（最后数据）",
    "tray.recovery.needsReauth": "需要重新登录",
    "tray.recovery.unreachable": "无法连接",
    "tray.recovery.retry": "重新连接",
    "tray.recovery.open": "查看问题",
    "tray.recovery.settings": "服务器设置",
    "tray.recovery.reauthenticate": "重新登录",
    "stage.proposed": "提案中",
    "stage.in-progress": "进行中",
    "stage.ready": "已就绪",
  } as Record<string, string>)[key] ?? key);

function change(over: Partial<ChangeItem> & { name: string }): ChangeItem {
  return { status: "", totalTasks: 0, completedTasks: 0, ...over };
}

/** 典型快照：两分页（p1 作用中）、一提案／一进行中／一已就绪、两讨论。 */
function snapshot(over: Partial<TraySnapshot> = {}): TraySnapshot {
  return {
    tabs: [
      { key: "local:/proj/one", name: "one", source: "local", status: "ready" },
      { key: "local:/proj/two", name: "two", source: "local", status: "ready" },
    ],
    activeKey: "local:/proj/one",
    changes: [
      change({ name: "prop", totalTasks: 5, completedTasks: 0 }), // proposed
      change({ name: "inprog", totalTasks: 12, completedTasks: 3 }), // in-progress
      change({ name: "rdy", totalTasks: 4, completedTasks: 4 }), // ready
    ],
    discussions: [
      { slug: "d1", topic: "讨论一", promoted: false },
      { slug: "d2", topic: "讨论二", promoted: false },
    ],
    pendingTabKey: null,
    workspaceLoading: false,
    workspaceLoadFailed: false,
    ...over,
  };
}

const kinds = (items: TrayMenuItem[]) => items.map((i) => i.kind);
const byKind = <K extends TrayMenuItem["kind"]>(items: TrayMenuItem[], kind: K) =>
  items.filter((i): i is Extract<TrayMenuItem, { kind: K }> => i.kind === kind);

describe("trayIconBytes", () => {
  it("解码内嵌 base64 为有效 PNG（magic bytes）", () => {
    const bytes = trayIconBytes();
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(100);
  });
});

describe("progressBar", () => {
  it("依比例填满 unicode 方块", () => {
    expect(progressBar(0, 5, 8)).toBe("░░░░░░░░");
    expect(progressBar(4, 4, 8)).toBe("▓▓▓▓▓▓▓▓");
    expect(progressBar(3, 12, 8)).toBe("▓▓░░░░░░"); // round(3/12*8)=2
  });
  it("total<=0 回空字符串（无任务不画）", () => {
    expect(progressBar(0, 0)).toBe("");
    expect(progressBar(5, 0)).toBe("");
  });
});

describe("buildTrayModel", () => {
  it("项目项依分页顺序、作用中打勾", () => {
    const projects = byKind(buildTrayModel(snapshot(), fakeT).items, "project");
    expect(projects.map((p) => p.key)).toEqual(["local:/proj/one", "local:/proj/two"]);
    expect(projects.map((p) => p.checked)).toEqual([true, false]);
  });

  it("每个非空阶段一个分区标题（header），依 proposed/in-progress/ready 序", () => {
    const headers = byKind(buildTrayModel(snapshot(), fakeT).items, "header");
    // 三阶段皆非空＋讨论 header
    expect(headers.map((h) => h.label)).toEqual(["提案中", "进行中", "已就绪", "讨论"]);
  });

  it("变更列带进度条标签，子菜单动作依序为「打开此变更」「拷贝名称」", () => {
    const changes = byKind(buildTrayModel(snapshot(), fakeT).items, "change");
    expect(changes.map((c) => c.name)).toEqual(["prop", "inprog", "rdy"]);
    // 进行中 3/12 → 进度条＋n/m
    const inprog = changes.find((c) => c.name === "inprog")!;
    expect(inprog.label).toBe("inprog  ▓▓░░░░░░ 3/12");
    // spec tray-status-menu Scenario「原生菜单不受影响」：站章不进纯文本 label
    // ——单一字符承载四态、无 tooltip 无色彩，不可辨识（design D7 已否决）。
    const stamped = buildTrayModel(
      snapshot({
        changes: [
          change({
            name: "inprog",
            totalTasks: 12,
            completedTasks: 3,
            reviewStatus: "reviewed",
            verifyStatus: "verifiedStale",
          }),
        ],
      }),
      fakeT,
    );
    const stampedRow = byKind(stamped.items, "change").find((c) => c.name === "inprog")!;
    expect(stampedRow.label).toBe("inprog  ▓▓░░░░░░ 3/12");
    expect(inprog.actions).toEqual([
      { kind: "open-change", label: "打开此变更" },
      { kind: "copy-name", label: "拷贝名称" },
    ]);
    // ready 全满
    expect(changes.find((c) => c.name === "rdy")!.label).toBe("rdy  ▓▓▓▓▓▓▓▓ 4/4");
  });

  it("拷贝来源为纯名称：标签含进度条字符、name 不含（spec 例：0/10）", () => {
    const items = buildTrayModel(
      snapshot({
        changes: [change({ name: "phase2-e2e-chain", totalTasks: 10, completedTasks: 0 })],
      }),
      fakeT,
    ).items;
    const c = byKind(items, "change")[0];
    expect(c.label).toBe("phase2-e2e-chain  ░░░░░░░░ 0/10");
    expect(c.name).toBe("phase2-e2e-chain");
  });

  it("原生菜单列标签于 wave 存在时前缀「N· 」，无 wave 时不加（spec「原生菜单前缀数字」）", () => {
    // add-change-plan-desktop design D7：原生菜单无法变淡，只前缀波次数字。
    const items = buildTrayModel(
      snapshot({
        changes: [
          change({ name: "third", totalTasks: 10, completedTasks: 2, wave: 3, blockedBy: ["x"] }),
          change({ name: "plain", totalTasks: 10, completedTasks: 2 }),
          change({ name: "bare", totalTasks: 0, completedTasks: 0, wave: 1 }),
        ],
      }),
      fakeT,
    ).items;
    const byName = (name: string) => byKind(items, "change").find((c) => c.name === name)!;
    expect(byName("third").label).toBe("3· third  ▓▓░░░░░░ 2/10");
    expect(byName("plain").label).toBe("plain  ▓▓░░░░░░ 2/10");
    expect(byName("bare").label).toBe("1· bare");
    // name（拷贝来源）不带前缀。
    expect(byName("third").name).toBe("third");
  });

  it("无任务的变更仅显示名称（不画进度条）", () => {
    const items = buildTrayModel(
      snapshot({ changes: [change({ name: "empty-tasks", totalTasks: 0, completedTasks: 0 })] }),
      fakeT,
    ).items;
    expect(byKind(items, "change")[0].label).toBe("empty-tasks");
  });

  it("讨论项以 slug 为标签、携带 topic，子菜单动作依序为「打开此讨论」「拷贝 slug」", () => {
    const items = buildTrayModel(snapshot(), fakeT).items;
    const disc = byKind(items, "discussion");
    expect(disc.map((d) => [d.slug, d.label, d.topic])).toEqual([
      ["d1", "d1", "讨论一"],
      ["d2", "d2", "讨论二"],
    ]);
    expect(disc[0].actions).toEqual([
      { kind: "open-discussion", label: "打开此讨论" },
      { kind: "copy-slug", label: "拷贝 slug" },
    ]);
  });

  it("无变更时显示空状态", () => {
    const items = buildTrayModel(snapshot({ changes: [] }), fakeT).items;
    expect(byKind(items, "change")).toHaveLength(0);
    expect(byKind(items, "empty").some((e) => e.label === "尚无进行中变更")).toBe(true);
  });

  it("无讨论时显示「讨论 0」", () => {
    const items = buildTrayModel(snapshot({ discussions: [] }), fakeT).items;
    expect(byKind(items, "discussion")).toHaveLength(0);
    expect(byKind(items, "empty").some((e) => e.label === "讨论 0")).toBe(true);
  });

  it("讨论分流：已转出讨论列于「已转出」分区、讨论中列于「讨论」分区", () => {
    const items = buildTrayModel(
      snapshot({
        discussions: [
          { slug: "open-d", topic: "讨论中的", promoted: false },
          { slug: "prom-d", topic: "已转出的", promoted: true },
        ],
      }),
      fakeT,
    ).items;
    const headers = byKind(items, "header").map((h) => h.label);
    expect(headers).toContain("讨论");
    expect(headers).toContain("已转出");
    // 顺序：讨论 header → open-d → 已转出 header → prom-d
    const labels = items.map((i) => ("label" in i ? i.label : i.kind));
    const iDisc = labels.indexOf("讨论");
    const iOpen = labels.indexOf("open-d");
    const iProm = labels.indexOf("已转出");
    const iPromD = labels.indexOf("prom-d");
    expect(iDisc).toBeLessThan(iOpen);
    expect(iOpen).toBeLessThan(iProm);
    expect(iProm).toBeLessThan(iPromD);
    // 两分区子菜单结构相同（同为 discussion 项、带完整动作）
    const disc = byKind(items, "discussion");
    expect(disc.map((d) => d.actions.length)).toEqual([2, 2]);
  });

  it("无已转出讨论时不出现「已转出」分区；无讨论中仍显示「讨论 0」且已转出照列", () => {
    const none = buildTrayModel(snapshot(), fakeT).items;
    expect(byKind(none, "header").map((h) => h.label)).not.toContain("已转出");

    const onlyPromoted = buildTrayModel(
      snapshot({ discussions: [{ slug: "prom-d", topic: "已转出的", promoted: true }] }),
      fakeT,
    ).items;
    expect(byKind(onlyPromoted, "empty").some((e) => e.label === "讨论 0")).toBe(true);
    expect(byKind(onlyPromoted, "header").map((h) => h.label)).toContain("已转出");
    expect(byKind(onlyPromoted, "discussion").map((d) => d.slug)).toEqual(["prom-d"]);
  });

  it("分区逾 5 笔：直列前 5、尾端「还有 N 个…」内嵌其余（spec Example 门槛边界 5/6/20）", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => change({ name: `c${i}`, totalTasks: 2, completedTasks: 1 }));
    // 5 → 无溢出节点
    let items = buildTrayModel(snapshot({ changes: mk(5), discussions: [] }), fakeT).items;
    expect(byKind(items, "change")).toHaveLength(5);
    expect(byKind(items, "overflow")).toHaveLength(0);
    // 6 → 5＋还有 1 个
    items = buildTrayModel(snapshot({ changes: mk(6), discussions: [] }), fakeT).items;
    expect(byKind(items, "change")).toHaveLength(5);
    let overflow = byKind(items, "overflow")[0];
    expect(overflow.label).toBe("还有 1 个…");
    expect(overflow.items).toHaveLength(1);
    // 20 → 5＋还有 15 个，内嵌项目保有完整动作（同构 change 模型）
    items = buildTrayModel(snapshot({ changes: mk(20), discussions: [] }), fakeT).items;
    expect(byKind(items, "change")).toHaveLength(5);
    overflow = byKind(items, "overflow")[0];
    expect(overflow.label).toBe("还有 15 个…");
    expect(overflow.items).toHaveLength(15);
    const nested = overflow.items[0] as Extract<TrayMenuItem, { kind: "change" }>;
    expect(nested.kind).toBe("change");
    expect(nested.actions).toHaveLength(2);
  });

  it("讨论分区同样适用溢出门槛", () => {
    const ds = Array.from({ length: 7 }, (_, i) => ({ slug: `d${i}`, topic: `t${i}`, promoted: false }));
    const items = buildTrayModel(snapshot({ discussions: ds }), fakeT).items;
    expect(byKind(items, "discussion")).toHaveLength(5);
    expect(byKind(items, "overflow")[0].label).toBe("还有 2 个…");
  });

  it("模型不含数字徽章字段（系统匣不显示数字）", () => {
    expect("badge" in buildTrayModel(snapshot(), fakeT)).toBe(false);
  });

  it("区段顺序：项目 → 分隔 → 各阶段(header+change) → 分隔 → 讨论(header+项) → 分隔 → 动作", () => {
    expect(kinds(buildTrayModel(snapshot(), fakeT).items)).toEqual([
      "project",
      "project",
      "separator",
      "header",
      "change",
      "header",
      "change",
      "header",
      "change",
      "separator",
      "header",
      "discussion",
      "discussion",
      "separator",
      "open",
      "project-settings",
      "settings",
      "quit",
    ]);
  });

  it("动作区含项目设置项：位于打开 Specseal 之后、label 沿用 app.navProjectSettings", () => {
    const items = buildTrayModel(snapshot(), fakeT).items;
    const ps = byKind(items, "project-settings");
    expect(ps).toHaveLength(1);
    expect(ps[0].label).toBe("项目设置");
  });

  it("共用状态投影让 restoring／error／needs-reauth 成为原生复原项，且 active error 不显示旧数据", () => {
    const errorKey = "remote:c1/demo/error";
    const model = buildTrayModel(
      snapshot({
        tabs: [
          { key: "local:/proj/one", name: "one", source: "local", status: "ready" },
          {
            key: "remote:c1/demo/ready",
            name: "Demo/ready",
            source: "remote",
            status: "ready",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
          {
            key: "remote:c1/demo/restoring",
            name: "Demo/restoring",
            source: "remote",
            status: "restoring",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
          {
            key: errorKey,
            name: "Demo/error",
            source: "remote",
            status: "error",
            failureKind: "unreachable",
            connectionId: "c1",
            serverLabel: "Team Server",
            serverOrigin: "https://spec.example.test",
          },
          {
            key: "remote:c1/demo/auth",
            name: "Demo/auth",
            source: "remote",
            status: "needs-reauth",
            connectionId: "c1",
            serverLabel: "Team Server",
          },
        ],
        activeKey: errorKey,
        changes: [change({ name: "previous-workspace-change", totalTasks: 2, completedTasks: 1 })],
        discussions: [{ slug: "previous-workspace-discussion", topic: "旧数据", promoted: false }],
      } as unknown as Partial<TraySnapshot>),
      fakeT,
    );

    const recoveries = byKind(model.items, "recovery");
    expect(recoveries.map((item) => item.status)).toEqual([
      "restoring",
      "error",
      "needs-reauth",
    ]);
    expect(recoveries.find((item) => item.status === "restoring")?.actions).toEqual([]);
    expect(recoveries.find((item) => item.status === "error")?.actions.map((a) => a.kind)).toEqual([
      "retry",
      "open-recovery",
      "open-settings",
    ]);
    expect(recoveries.find((item) => item.status === "needs-reauth")?.actions[0]?.kind).toBe(
      "reauthenticate",
    );
    expect(byKind(model.items, "change")).toHaveLength(0);
    expect(byKind(model.items, "discussion")).toHaveLength(0);
  });
});

// ---- 接线层（Tauri tray/menu/window API）----

/** 可观察的假 store（tabs＋changes＋discussions＋动作），可推变更通知订阅者。 */
function makeStore(
  activateTab = vi.fn(),
  openProjectAt = vi.fn(),
  openDetail = vi.fn(),
  openDiscussion = vi.fn(),
  openProjectViaDialog = vi.fn(),
  setBoardView = vi.fn(),
) {
  let state = {
    tabs: [
      { locator: { kind: "local", root: "/proj/one" } as const, name: "one" },
      { locator: { kind: "local", root: "/proj/two" } as const, name: "two" },
    ] as Array<{ locator: WorkspaceLocator; name: string }>,
    activeKey: "local:/proj/one",
    pendingTabKey: null as string | null,
    loaded: true,
    loadingActive: false,
    loadFailed: false,
    changes: [
      change({ name: "alpha", totalTasks: 12, completedTasks: 3 }),
      change({ name: "gamma", totalTasks: 5, completedTasks: 0 }),
    ],
    discussions: {
      active: [
        { slug: "d1", topic: "t1", promotedTo: [] as string[] },
        { slug: "d2", topic: "t2", promotedTo: [] as string[] },
      ],
    },
    trayStyle: "native-menu" as "native-menu" | "panel",
    activateTab,
    openProjectAt,
    openDetail,
    openDiscussion,
    openProjectViaDialog,
    setBoardView,
    sessions: {} as Record<string, WorkspaceSession>,
    remoteRecovery: {} as Record<string, RemoteWorkspaceRecoveryState>,
    connections: [] as ConnectionView[],
    retryRemoteWorkspace: vi.fn(),
    showRemoteWorkspaceRecovery: vi.fn(),
    openConnectionReauth: vi.fn(),
  };
  const listeners = new Set<() => void>();
  return {
    store: {
      getState: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as TrayStoreApi,
    emit(next: Partial<typeof state>) {
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    activateTab,
    openProjectAt,
    openDetail,
    openDiscussion,
    openProjectViaDialog,
    setBoardView,
    retryRemoteWorkspace: state.retryRemoteWorkspace,
    showRemoteWorkspaceRecovery: state.showRemoteWorkspaceRecovery,
    openConnectionReauth: state.openConnectionReauth,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyItem = any;

describe("initTray 接线（菜单）", () => {
  const trayObj = {
    setMenu: vi.fn(),
    setTitle: vi.fn(),
    setShowMenuOnLeftClick: vi.fn(),
    close: vi.fn(),
  };
  const win = { show: vi.fn(), setFocus: vi.fn(), unminimize: vi.fn() };
  let lastItems: AnyItem[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeText).mockResolvedValue(undefined as never);
    vi.mocked(Image.fromBytes).mockResolvedValue({} as never);
    vi.mocked(Menu.new).mockImplementation(async (opts?: { items?: AnyItem[] }) => {
      lastItems = opts?.items ?? [];
      return { id: "menu" } as never;
    });
    vi.mocked(TrayIcon.new).mockResolvedValue(trayObj as never);
    vi.mocked(getCurrentWindow).mockReturnValue(win as never);
  });

  it("创建 tray 图标并挂上由当前快照组出的菜单（含两项目 check 项）", async () => {
    const { store } = makeStore();
    await initTray(store, { platform: "macos" });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    expect(opts.menu).toBeDefined();
    expect(opts.iconAsTemplate).toBe(true);
    const projects = lastItems.filter((i) => "checked" in i);
    expect(projects).toHaveLength(2);
    expect(projects.map((p: AnyItem) => p.checked)).toEqual([true, false]);
  });

  it("变更列为子菜单（有 items）、标签带进度条；store 变动后重建菜单", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 100 });
    vi.mocked(Menu.new).mockClear();
    trayObj.setMenu.mockClear();
    trayObj.setTitle.mockClear();

    vi.useFakeTimers();
    bag.emit({
      changes: [
        change({ name: "alpha", totalTasks: 12, completedTasks: 6 }),
        change({ name: "beta", totalTasks: 8, completedTasks: 2 }),
      ],
    });
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();

    expect(trayObj.setMenu).toHaveBeenCalledTimes(1);
    const submenus = lastItems.filter((i) => Array.isArray(i.items) && /\d+\/\d+$/.test(i.text ?? ""));
    expect(submenus.map((s: AnyItem) => s.text)).toEqual(["alpha  ▓▓▓▓░░░░ 6/12", "beta  ▓▓░░░░░░ 2/8"]);
  });

  it.each([
    ["local", { kind: "local", root: "/proj/two" } as const, "two", "local:/proj/two"],
    [
      "remote",
      { kind: "remote", connectionId: "conn-1", projectId: "demo", repoId: "backend" } as const,
      "Demo/backend",
      "remote:conn-1/demo/backend",
    ],
  ])("点非作用中 %s 项目以 locator key 调用 activateTab", async (_kind, locator, name, key) => {
    const bag = makeStore();
    bag.emit({
      tabs: [
        { locator: { kind: "local", root: "/proj/one" }, name: "one" },
        { locator, name },
      ],
      sessions:
        _kind === "remote"
          ? {
              [key]: {
                locator,
                connectionState: {
                  connectionId: "conn-1",
                  state: "online",
                  message: null,
                },
              } as WorkspaceSession,
            }
          : {},
    });
    await initTray(bag.store, { platform: "macos" });
    const projects = lastItems.filter((i) => "checked" in i);
    projects[1].action();
    expect(bag.activateTab).toHaveBeenCalledWith(key);
    expect(bag.openProjectAt).not.toHaveBeenCalled();
  });

  it("变更子菜单「打开此变更」开主窗口并打开该变更的详情页（store openDetail，宿主落回看板）", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    // alpha 为进行中，是子菜单（有 items）
    const alpha = lastItems.find((i) => Array.isArray(i.items) && (i.text ?? "").startsWith("alpha"));
    expect(alpha).toBeDefined();
    alpha.items[0].action();
    // openMainWindow 为 async（hide_tray_panel → unminimize → show → setFocus）：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.openDetail).toHaveBeenCalledWith("alpha");
  });

  it("原生 needs-reauth submenu 的显式详情与登录才聚焦主窗口", async () => {
    const bag = makeStore();
    const key = "remote:c1/demo/backend";
    bag.emit({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
          name: "Demo/backend",
        },
      ],
      activeKey: key,
      remoteRecovery: {
        [key]: {
          status: "error",
          failure: {
            kind: "needs-reauth",
            message: "sensitive technical detail must not enter tray snapshot",
            reason: "needs_reauth",
            status: 401,
          },
        },
      },
      connections: [
        {
          id: "c1",
          origin: "https://spec.example.test",
          name: "Team Server",
          loggedIn: false,
        },
      ],
    });
    await initTray(bag.store, { platform: "macos" });

    const recovery = lastItems.find((item) =>
      Array.isArray(item.items) && item.text.includes("Demo/backend"),
    );
    expect(recovery.items.map((item: AnyItem) => item.text)).toEqual([
      "作用中",
      "需要重新登录",
      "重新登录",
      "查看问题",
      "服务器设置",
    ]);

    recovery.items[2].action();
    expect(bag.openConnectionReauth).toHaveBeenCalledWith("c1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.show).toHaveBeenCalledTimes(1);

    win.show.mockClear();
    recovery.items[3].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bag.showRemoteWorkspaceRecovery).toHaveBeenCalledWith(key);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("原生 error submenu 直接 retry 不显示或聚焦主窗口，且 snapshot 不携带 technical detail", async () => {
    const bag = makeStore();
    const key = "remote:c1/demo/backend";
    bag.emit({
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
          name: "Demo/backend",
        },
      ],
      activeKey: key,
      remoteRecovery: {
        [key]: {
          status: "error",
          failure: {
            kind: "unreachable",
            message: "authorization: Bearer must-never-enter-tray",
            reason: "offline",
            status: null,
          },
        },
      },
      connections: [
        {
          id: "c1",
          origin: "https://spec.example.test",
          name: "Team Server",
          loggedIn: true,
        },
      ],
    });

    const projected = buildTraySnapshot(bag.store.getState());
    expect(JSON.stringify(projected)).not.toContain("must-never-enter-tray");
    expect(projected.tabs[0]).toEqual(
      expect.objectContaining({
        key,
        status: "error",
        failureKind: "unreachable",
        serverLabel: "Team Server",
      }),
    );

    await initTray(bag.store, { platform: "macos" });
    const recovery = lastItems.find(
      (item) => Array.isArray(item.items) && item.text.includes("Demo/backend"),
    );
    recovery.items[2].action();
    expect(bag.retryRemoteWorkspace).toHaveBeenCalledWith(key);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.show).not.toHaveBeenCalled();
    expect(win.setFocus).not.toHaveBeenCalled();
  });

  it("变更子菜单「拷贝名称」写入剪贴板且不开主窗口", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    const alpha = lastItems.find((i) => Array.isArray(i.items) && (i.text ?? "").startsWith("alpha"));
    expect(alpha.items.map((a: AnyItem) => a.text)).toEqual(["打开此变更", "拷贝名称"]);
    await alpha.items[1].action();
    expect(writeText).toHaveBeenCalledWith("alpha");
    expect(win.show).not.toHaveBeenCalled();
  });

  it("讨论为子菜单：父标签 slug、首行 disabled topic、打开与拷贝 slug 动作", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    const disc = lastItems.find((i) => Array.isArray(i.items) && i.text === "d1");
    expect(disc).toBeDefined();
    // 首行为 topic 描述（disabled、不可选取）
    expect(disc.items[0].text).toBe("t1");
    expect(disc.items[0].enabled).toBe(false);
    // 打开此讨论 → 主窗口＋openDiscussion（打开该讨论的详情页）
    expect(disc.items[1].text).toBe("打开此讨论");
    disc.items[1].action();
    // openMainWindow 为 async（hide_tray_panel → unminimize → show → setFocus）：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.openDiscussion).toHaveBeenCalledWith("d1");
    // 拷贝 slug → 剪贴板为 slug
    expect(disc.items[2].text).toBe("拷贝 slug");
    await disc.items[2].action();
    expect(writeText).toHaveBeenCalledWith("d1");
  });

  it("剪贴板写入失败时静默（不抛出、不弹窗）", async () => {
    vi.mocked(writeText).mockRejectedValue(new Error("denied"));
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    const alpha = lastItems.find((i) => Array.isArray(i.items) && (i.text ?? "").startsWith("alpha"));
    await expect(Promise.resolve(alpha.items[1].action())).resolves.not.toThrow();
    // 冲洗微任务：内部 rejection 须被吞掉，否则 vitest 以 unhandled rejection 失败
    await new Promise((r) => setTimeout(r, 0));
  });

  it("点「打开 Specseal」显示窗口并取得焦点", async () => {
    const { store } = makeStore();
    await initTray(store, { platform: "macos" });
    const open = lastItems.find((i) => i.text === "打开 Specseal");
    await open.action();
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
  });

  it("点「设置」开主窗口、取得焦点并切换至设置页", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    const settings = lastItems.find((i) => i.text === "设置");
    expect(settings).toBeDefined();
    settings.action();
    // openMainWindow 为 async（hide_tray_panel → unminimize → show → setFocus）：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
    expect(bag.setBoardView).toHaveBeenCalledWith("settings");
  });

  it("点「项目设置」开主窗口、取得焦点并切换至项目设置页", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos" });
    const ps = lastItems.find((i) => i.text === "项目设置");
    expect(ps).toBeDefined();
    ps.action();
    // openMainWindow 为 async（hide_tray_panel → unminimize → show → setFocus）：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
    expect(bag.setBoardView).toHaveBeenCalledWith("project-settings");
  });

  it("「结束」映射为原生 predefined Quit", async () => {
    const { store } = makeStore();
    await initTray(store, { platform: "macos" });
    expect(lastItems.find((i) => i.item === "Quit")).toBeDefined();
  });

  it("macOS panel 样式：创建时不挂菜单、不开左键菜单，点击图标触发 onPanelToggle", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "macos", onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    expect(opts.menu).toBeUndefined();
    expect(opts.showMenuOnLeftClick).toBe(false);
    opts.action({ type: "Click", button: "Left", buttonState: "Up" });
    expect(onPanelToggle).toHaveBeenCalledTimes(1);
  });

  it("macOS panel 样式：右键点击图标同样触发 onPanelToggle（与左键等价），Down 不触发", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "macos", onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    opts.action({ type: "Click", button: "Right", buttonState: "Up" });
    expect(onPanelToggle).toHaveBeenCalledTimes(1);
    // 放开才开闭：Down 事件不触发（与左键同规则）
    opts.action({ type: "Click", button: "Right", buttonState: "Down" });
    expect(onPanelToggle).toHaveBeenCalledTimes(1);
  });

  it("native 样式：点击事件不触发 onPanelToggle（菜单接管交互）", async () => {
    const bag = makeStore();
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "macos", onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    opts.action?.({ type: "Click", button: "Left", buttonState: "Up" });
    opts.action?.({ type: "Click", button: "Right", buttonState: "Up" });
    expect(onPanelToggle).not.toHaveBeenCalled();
  });

  it("样式切换即时分流：panel 卸菜单且关左键开菜单、切回 native 双双复原（无需重启）", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    trayObj.setMenu.mockClear();
    vi.useFakeTimers();
    bag.emit({ trayStyle: "panel" });
    await vi.advanceTimersByTimeAsync(50);
    expect(trayObj.setMenu).toHaveBeenLastCalledWith(null);
    // 关键：仅卸菜单不够——左键仍被「开菜单」路径吃掉，点击事件到不了 action。
    expect(trayObj.setShowMenuOnLeftClick).toHaveBeenLastCalledWith(false);
    bag.emit({ trayStyle: "native-menu" });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(trayObj.setMenu).toHaveBeenLastCalledWith({ id: "menu" });
    expect(trayObj.setShowMenuOnLeftClick).toHaveBeenLastCalledWith(true);
  });

  // Windows 的 panel 样式（spec「面板样式」平台差异——Windows；tray-panel-windows design D5）：
  // 左键开闭面板、右键由系统显示同一份原生菜单。
  it("Windows panel 样式：创建时挂原生菜单且关左键开菜单，只有左键放开触发 onPanelToggle", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "windows", onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    expect(opts.menu).toEqual({ id: "menu" });
    expect(opts.showMenuOnLeftClick).toBe(false);
    expect(opts.iconAsTemplate).toBe(false);
    opts.action({ type: "Click", button: "Right", buttonState: "Up" });
    expect(onPanelToggle).not.toHaveBeenCalled();
    opts.action({ type: "Click", button: "Left", buttonState: "Down" });
    expect(onPanelToggle).not.toHaveBeenCalled();
    opts.action({ type: "Click", button: "Left", buttonState: "Up" });
    expect(onPanelToggle).toHaveBeenCalledTimes(1);
  });

  it("Windows panel 样式：去抖更新后仍挂菜单（随快照重建）且维持关闭左键开菜单", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    await initTray(bag.store, { platform: "windows", debounceMs: 50 });
    trayObj.setMenu.mockClear();
    vi.useFakeTimers();
    bag.emit({ changes: [change({ name: "alpha", totalTasks: 12, completedTasks: 6 })] });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(trayObj.setMenu).toHaveBeenLastCalledWith({ id: "menu" });
    expect(trayObj.setShowMenuOnLeftClick).toHaveBeenLastCalledWith(false);
  });

  it("Windows 面板创建失败（panelFallback）后转 native-menu：左键开菜单、点击不再开闭面板", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "windows", debounceMs: 50, onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    vi.useFakeTimers();
    bag.emit({ trayStyle: "native-menu" }); // panelFallback 的效果
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(trayObj.setMenu).toHaveBeenLastCalledWith({ id: "menu" });
    expect(trayObj.setShowMenuOnLeftClick).toHaveBeenLastCalledWith(true);
    opts.action({ type: "Click", button: "Left", buttonState: "Up" });
    expect(onPanelToggle).not.toHaveBeenCalled();
  });

  // 面板位置：macOS 由 positioner 依点击事件的图标座标计算；Windows 由 Tauri 壳读图标位置自算
  // （tray-panel-windows design D3），点击不喂 positioner。
  it("macOS panel 样式：点击先把事件喂给 positioner", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    await initTray(bag.store, { platform: "macos", onPanelToggle: vi.fn() });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    const event = { type: "Click", button: "Left", buttonState: "Up" };
    opts.action(event);
    expect(handleIconState).toHaveBeenCalledWith(event);
  });

  it("Windows panel 样式：点击不喂 positioner", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "windows", onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    opts.action({ type: "Click", button: "Left", buttonState: "Up" });
    expect(onPanelToggle).toHaveBeenCalledTimes(1);
    expect(handleIconState).not.toHaveBeenCalled();
  });

  it("tray 以固定 id 创建，创建前先移除同 id 孤儿（webview 重建不残留僵尸徽章）", async () => {
    const { store } = makeStore();
    await initTray(store, { platform: "macos" });
    expect(TrayIcon.removeById).toHaveBeenCalledWith("specseal-tray");
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    expect(opts.id).toBe("specseal-tray");
    expect(vi.mocked(TrayIcon.removeById).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(TrayIcon.new).mock.invocationCallOrder[0],
    );
  });

  it("不显示数字徽章：创建不带 title，数据变动与点击图标皆不调用 setTitle", async () => {
    const bag = makeStore();
    bag.emit({ trayStyle: "panel" });
    const onPanelToggle = vi.fn();
    await initTray(bag.store, { platform: "macos", debounceMs: 50, onPanelToggle });
    const opts = vi.mocked(TrayIcon.new).mock.calls[0][0] as AnyItem;
    expect(opts.title).toBeUndefined();
    vi.useFakeTimers();
    bag.emit({
      changes: [change({ name: "alpha", totalTasks: 12, completedTasks: 6 })],
    });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    opts.action({ type: "Click", button: "Left", buttonState: "Up" });
    await Promise.resolve();
    expect(trayObj.setTitle).not.toHaveBeenCalled();
  });

  it("溢出节点转为原生子菜单（内含其余变更、各自保有动作子菜单）", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.useFakeTimers();
    bag.emit({
      changes: Array.from({ length: 7 }, (_, i) =>
        change({ name: `c${i}`, totalTasks: 2, completedTasks: 1 }),
      ),
    });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    const more = lastItems.find((i) => i.text === "还有 2 个…");
    expect(more).toBeDefined();
    expect(more.items).toHaveLength(2);
    // 内嵌项目仍是完整变更子菜单（打开此变更＋拷贝名称）
    expect(more.items[0].items.map((a: AnyItem) => a.text)).toEqual(["打开此变更", "拷贝名称"]);
  });

  it("面板事件接线：订阅 ready/action、去抖推送快照、动作回流 store", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    // 订阅面板的 ready 与 action 事件
    const topics = vi.mocked(tauriListen).mock.calls.map((c) => c[0]);
    expect(topics).toContain("tray-panel-ready");
    expect(topics).toContain("tray-panel-action");
    // 数据变动去抖后推送快照给面板
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ activeKey: "local:/proj/two" });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(vi.mocked(tauriEmit)).toHaveBeenCalledWith(
      "tray-snapshot",
      expect.objectContaining({ activeKey: "local:/proj/two" }),
    );
    // 动作回流：open-change 开主窗口并打开该变更的详情页
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-change", id: "alpha" } });
    // openMainWindow 为 async（hide_tray_panel → unminimize → show → setFocus）：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.openDetail).toHaveBeenCalledWith("alpha");
  });

  // spec「面板交接主窗口后鼠标交互完整」（design D2、D5 自动层）：交接先收合面板
  // 再唤起主窗口——invoke 的第一个调用是 hide_tray_panel，窗口 unminimize／show／
  // setFocus 全在其后；收合失败静默，不阻断唤起。
  it("面板动作 open-change 先 invoke hide_tray_panel，之后才 unminimize／show／setFocus", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-change", id: "alpha" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(invoke).mock.calls[0]?.[0]).toBe("hide_tray_panel");
    const hideAt = vi.mocked(invoke).mock.invocationCallOrder[0];
    expect(hideAt).toBeLessThan(win.unminimize.mock.invocationCallOrder[0]);
    expect(hideAt).toBeLessThan(win.show.mock.invocationCallOrder[0]);
    expect(hideAt).toBeLessThan(win.setFocus.mock.invocationCallOrder[0]);
    expect(bag.openDetail).toHaveBeenCalledWith("alpha");
  });

  it("hide_tray_panel 拒绝时静默，主窗口仍 show 并 setFocus", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("tray panel unavailable"));
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-change", id: "alpha" } });
    // 冲洗微任务：rejection 须被吞掉，否则 vitest 以 unhandled rejection 失败
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledWith("hide_tray_panel");
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
  });

  it("面板动作 open-project 以 remote locator key 调用 activateTab", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    const remoteKey = "remote:conn-1/demo/backend";
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-project", id: remoteKey } });
    expect(bag.activateTab).toHaveBeenCalledWith(remoteKey);
    expect(bag.openProjectAt).not.toHaveBeenCalled();
  });

  it("面板 recovery action 的 retry 留在 Tray，详情／设置／登录才显示并聚焦主窗口", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    const dispatch = actionCall[1] as (event: AnyItem) => void;
    const key = "remote:c1/demo/backend";

    dispatch({ payload: { kind: "retry-workspace", id: key } });
    expect(bag.retryRemoteWorkspace).toHaveBeenCalledWith(key);
    expect(win.show).not.toHaveBeenCalled();

    dispatch({ payload: { kind: "open-recovery", id: key } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bag.showRemoteWorkspaceRecovery).toHaveBeenCalledWith(key);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.setFocus).toHaveBeenCalledTimes(1);

    win.show.mockClear();
    win.setFocus.mockClear();
    dispatch({ payload: { kind: "open-server-settings", id: "c1" } });
    dispatch({ payload: { kind: "reauthenticate", id: "c1" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bag.openConnectionReauth).toHaveBeenCalledTimes(2);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.setFocus).toHaveBeenCalledTimes(2);
  });

  it("面板动作 open-settings 唤起主窗口并切换至设置页", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-settings" } });
    // openMainWindow 为 async：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.setBoardView).toHaveBeenCalledWith("settings");
  });

  it("面板动作 open-project-settings 唤起主窗口并切换至项目设置页", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "open-project-settings" } });
    // openMainWindow 为 async：冲洗微任务后再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.setBoardView).toHaveBeenCalledWith("project-settings");
  });

  it("面板动作 quit 调用结束 app 的命令", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "quit" } });
    expect(invoke).toHaveBeenCalledWith("quit_app");
  });

  it("面板动作 add-project 先唤起主窗口再转呼文件夹选择流程（D7 快速加入项目）", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    const actionCall = vi.mocked(tauriListen).mock.calls.find((c) => c[0] === "tray-panel-action")!;
    (actionCall[1] as (e: AnyItem) => void)({ payload: { kind: "add-project" } });
    // 唤起主窗口（openIn 路径）：主窗口在另一桌面时 macOS 才会切 Space，
    // 选择器才于前景可见（D7 实测修订）。openMainWindow 为 async，冲洗微任务。
    await new Promise((r) => setTimeout(r, 0));
    expect(win.show).toHaveBeenCalled();
    expect(bag.openProjectViaDialog).toHaveBeenCalled();
  });

  it("dispose 取消订阅并关闭 tray", async () => {
    const bag = makeStore();
    const controller = await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    controller.dispose();
    expect(trayObj.close).toHaveBeenCalled();
    trayObj.setMenu.mockClear();
    vi.useFakeTimers();
    bag.emit({ activeKey: "local:/proj/two" });
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(trayObj.setMenu).not.toHaveBeenCalled();
  });
});

// spec「面板分页切换中回馈」「面板分区首访 skeleton」（design D5）：面板是薄渲染层，
// 两个加载态字段自主窗口 store 导出，面板不自建状态。
describe("TraySnapshot 的讨论分区判准（conclusion-gated-discussion-archive）", () => {
  it("promoted 且 concluded 非 false 且未保留才归「已转出」；未结论或保留中留「讨论」分区；缺席退回现行", () => {
    const bag = makeStore();
    bag.emit({
      discussions: {
        active: [
          { slug: "mid", topic: "未结论转出", promotedTo: ["cut-a"], concluded: false },
          { slug: "done", topic: "已结论转出", promotedTo: ["cut-b"], concluded: true },
          { slug: "legacy", topic: "旧 server 无字段", promotedTo: ["cut-c"] },
          { slug: "plain", topic: "未转出", promotedTo: [], concluded: false },
          { slug: "held", topic: "保留中", promotedTo: ["cut-d"], concluded: true, hold: true },
          { slug: "freed", topic: "已释放", promotedTo: ["cut-e"], concluded: true, hold: false },
        ],
      },
    });

    const snap = buildTraySnapshot(bag.store.getState());
    const bySlug = Object.fromEntries(snap.discussions.map((d) => [d.slug, d.promoted]));
    expect(bySlug).toEqual({
      mid: false, // 已转出但尚无结论 → 「讨论」分区
      done: true, // 已转出、已有结论、hold 缺席（视同未保留）→ 「已转出」分区
      legacy: true, // concluded 缺席（旧 server）→ 退回现行判准
      plain: false,
      held: false, // 保留在途 → 「讨论」分区
      freed: true, // hold 为 false → 「已转出」分区
    });
  });
});

describe("TraySnapshot 的加载态导出", () => {
  it("切换中 → pendingTabKey 带出目标分页 key", () => {
    const bag = makeStore();
    bag.emit({ pendingTabKey: "local:/proj/two" });
    expect(buildTraySnapshot(bag.store.getState()).pendingTabKey).toBe("local:/proj/two");
  });

  it("无切换 → pendingTabKey 为 null", () => {
    const bag = makeStore();
    expect(buildTraySnapshot(bag.store.getState()).pendingTabKey).toBeNull();
  });

  // spec「面板点击分页立即回馈」：切换中要「立即」出 spinner。走去抖（400ms 且每次
  // store 变动都重设）等于探测快时 spinner 根本不出现——正是本变更要解决的情境。
  it("切换中标记不等去抖 → 即时推送快照给面板", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ pendingTabKey: "local:/proj/two" });
    // 去抖时间尚未到，快照就该已经送出。
    await vi.advanceTimersByTimeAsync(0);
    const pushed = vi
      .mocked(tauriEmit)
      .mock.calls.filter((c) => c[0] === "tray-snapshot");
    vi.useRealTimers();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0][1]).toEqual(
      expect.objectContaining({ pendingTabKey: "local:/proj/two" }),
    );
  });

  // spec「切换完成后高亮更新」：spinner 消失与高亮移转须同批抵达。只即时推
  // pendingTabKey 会让面板在 spinner 消失后仍停在切换前的高亮与数据。
  it("活跃分页翻转 → 一并即时推送，不落后于 spinner 消失", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({
      activeKey: "local:/proj/two",
      pendingTabKey: null,
      loaded: false,
      loadingActive: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const pushed = vi.mocked(tauriEmit).mock.calls.filter((c) => c[0] === "tray-snapshot");
    vi.useRealTimers();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0][1]).toEqual(
      expect.objectContaining({ activeKey: "local:/proj/two", workspaceLoading: true }),
    );
  });

  it("整批加载完成（加载态翻假）→ 一并即时推送", async () => {
    const bag = makeStore();
    bag.emit({ loaded: false, loadingActive: true });
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ loaded: true, loadingActive: false });
    await vi.advanceTimersByTimeAsync(0);
    const pushed = vi.mocked(tauriEmit).mock.calls.filter((c) => c[0] === "tray-snapshot");
    vi.useRealTimers();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0][1]).toEqual(expect.objectContaining({ workspaceLoading: false }));
  });

  // 翻页入口是同一同步段内的两次 set：先翻 activeKey（加载态尚未翻真）、再由
  // refresh() 的计数 +1 翻真。逐次即推会把中间那份「已翻页、尚未起加载」的
  // 假空态推给面板——同段变动必须合并成一份最终快照。
  it("同一同步段的连续变动 → 只推最终快照，不推中间假空态", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ activeKey: "local:/proj/two", loaded: false, changes: [] });
    bag.emit({ loadingActive: true });
    await vi.advanceTimersByTimeAsync(0);
    const pushed = vi.mocked(tauriEmit).mock.calls.filter((c) => c[0] === "tray-snapshot");
    vi.useRealTimers();
    expect(pushed).toHaveLength(1);
    expect(pushed[0][1]).toEqual(
      expect.objectContaining({ activeKey: "local:/proj/two", workspaceLoading: true }),
    );
  });

  // 失败时 loaded 维持 false，翻的是加载态——它若不在即推面，面板要等一个去抖
  // 周期才收掉骨架（desktop-loading-skeleton-ux design D5 的例外，本案取代之）。
  it("首访加载失败（加载态翻假）→ 即时推送，骨架当下收掉", async () => {
    const bag = makeStore();
    bag.emit({ loaded: false, loadingActive: true });
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ loadingActive: false, loadFailed: true });
    await vi.advanceTimersByTimeAsync(0);
    const pushed = vi.mocked(tauriEmit).mock.calls.filter((c) => c[0] === "tray-snapshot");
    vi.useRealTimers();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0][1]).toEqual(
      expect.objectContaining({ workspaceLoading: false, workspaceLoadFailed: true }),
    );
  });

  it("只有清单内容变动（活跃分页与加载态不变）→ 维持去抖", async () => {
    const bag = makeStore();
    await initTray(bag.store, { platform: "macos", debounceMs: 50 });
    vi.mocked(tauriEmit).mockClear();
    vi.useFakeTimers();
    bag.emit({ changes: [change({ name: "delta", totalTasks: 3, completedTasks: 1 })] });
    await vi.advanceTimersByTimeAsync(0);
    const immediate = vi
      .mocked(tauriEmit)
      .mock.calls.filter((c) => c[0] === "tray-snapshot");
    expect(immediate).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(
      vi.mocked(tauriEmit).mock.calls.filter((c) => c[0] === "tray-snapshot").length,
    ).toBeGreaterThan(0);
  });

  // 面板骨架的条件整条由 store 导出（design D3）：面板不再自行组合旗标，
  // 导出值即主窗口看板的骨架条件——两处呈现不会各自算出不同答案。
  it("首访整批加载中 → workspaceLoading 为 true", () => {
    const bag = makeStore();
    bag.emit({ loaded: false, loadingActive: true });
    expect(buildTraySnapshot(bag.store.getState()).workspaceLoading).toBe(true);
  });

  it("首访探测中（尚未起整批加载）→ workspaceLoading 为 true", () => {
    const bag = makeStore();
    bag.emit({ loaded: false, pendingTabKey: "local:/proj/two" });
    expect(buildTraySnapshot(bag.store.getState()).workspaceLoading).toBe(true);
  });

  it("已有真值的重载 → workspaceLoading 为 false（不重回骨架）", () => {
    const bag = makeStore();
    bag.emit({ loaded: true, loadingActive: true });
    expect(buildTraySnapshot(bag.store.getState()).workspaceLoading).toBe(false);
  });

  it("无加载亦无探测 → workspaceLoading 为 false", () => {
    const bag = makeStore();
    expect(buildTraySnapshot(bag.store.getState()).workspaceLoading).toBe(false);
  });

  it("首访加载失败 → workspaceLoadFailed 为 true、workspaceLoading 为 false", () => {
    const bag = makeStore();
    bag.emit({ loaded: false, loadingActive: false, loadFailed: true });
    const snapshot = buildTraySnapshot(bag.store.getState());
    expect(snapshot.workspaceLoadFailed).toBe(true);
    expect(snapshot.workspaceLoading).toBe(false);
  });

  it("已有旧缓存的重载失败 → workspaceLoadFailed 为 false（照旧沿用旧数据）", () => {
    const bag = makeStore();
    bag.emit({ loaded: true, loadFailed: true });
    expect(buildTraySnapshot(bag.store.getState()).workspaceLoadFailed).toBe(false);
  });
});

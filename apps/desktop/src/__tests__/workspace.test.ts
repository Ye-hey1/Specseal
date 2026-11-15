// 打开项目 action 三态与分页列状态（design D3/D10/D11；spec 需求
// 「项目分页列存于 app 本机」）。workspace 探测面与 session 工厂以 mock 注入
// （workspace-session 决策 6）：数据加载一律经活跃 session 的 dataSource。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpecsealDataSource } from "@specseal/ui";

import { createAppStore } from "../store";
import { locatorKey, LOCAL_CAPABILITIES, type WorkspaceSession } from "../session";
import { persistTabs, readPersistedTabs, type ProjectTab } from "../tabs";
import { persistRecents, readPersistedRecents, RECENTS_STORAGE_KEY } from "../recents";
import type { WorkspaceAdapter } from "../adapter/workspace";
import { changeList } from "./helpers/changeList";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

function fakeDataSource(): SpecsealDataSource {
  return {
    listChanges: vi.fn().mockResolvedValue(changeList([
      { name: "started", status: "in-progress", totalTasks: 10, completedTasks: 0, startedAt: "2026-07-06" },
      { name: "proposed", status: "in-progress", totalTasks: 28, completedTasks: 0 },
    ])),
    listSpecs: vi.fn().mockResolvedValue([]),
    listArchived: vi.fn().mockResolvedValue([]),
    listDiscussions: vi.fn().mockResolvedValue({ active: [], archived: [] }),
    getDocument: vi.fn().mockResolvedValue(null),
    getArchivedDocument: vi.fn().mockResolvedValue(null),
    getDiscussionDocument: vi.fn().mockResolvedValue(null),
    changeCapabilities: vi.fn().mockResolvedValue([]),
    archivedCapabilities: vi.fn().mockResolvedValue([]),
    changeMeta: vi.fn().mockResolvedValue(null),
    status: vi.fn().mockResolvedValue(null),
    runVerb: vi.fn().mockResolvedValue({}),
    deleteChange: vi.fn().mockResolvedValue(undefined),
    setTaskDone: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    promoteDiscussion: vi.fn().mockResolvedValue({ change: "x" }),
    archiveDiscussion: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpecsealDataSource;
}

function fakeWorkspace(over: Partial<WorkspaceAdapter> = {}): WorkspaceAdapter {
  return {
    openProject: vi.fn().mockResolvedValue({ status: "project", root: "C:\\proj\\alpha", name: "alpha" }),
    initProject: vi.fn().mockResolvedValue({ status: "project", root: "C:\\proj\\fresh", name: "fresh" }),
    adoptProject: vi.fn().mockResolvedValue({ status: "project", root: "C:\\migrated", name: "migrated" }),
    // 缺省非项目语境：首启回退路径走 catch、维持零分页。
    startupDir: vi.fn().mockRejectedValue("startup dir unavailable in this fake"),
    projectStats: vi.fn().mockResolvedValue({ pendingWrapUp: 2 }),
    watchWorkspace: vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
    ...over,
  } as WorkspaceAdapter;
}

/** 假 session：dataSource 共用测试注入的 fake（settings／events 本套件不涉）。 */
function fakeSession(ds: SpecsealDataSource, root: string, name: string): WorkspaceSession {
  return {
    id: `local:${root}`,
    locator: { kind: "local", root },
    descriptor: { name },
    dataSource: ds,
    settings: {
      kind: "local",
      policyWrite: true,
      readSettings: vi.fn(),
      writeAppTools: vi.fn(),
      writeWorkflowConfig: vi.fn(),
      writeWorkflowContext: vi.fn(),
      writeWorkflowRules: vi.fn(),
      writeWorkflowReview: vi.fn(),
      writeWorkflowSubagentModel: vi.fn(),
      readSchemas: vi.fn(),
      writeWorkflowSchema: vi.fn(),
      forkSchema: vi.fn(),
      createSchema: vi.fn(),
      revealSchema: vi.fn(),
      deleteSchema: vi.fn(),
    },
    events: { subscribe: () => () => {} },
    capabilities: LOCAL_CAPABILITIES,
  };
}

function makeStore(ds: SpecsealDataSource, ws: WorkspaceAdapter) {
  return createAppStore({
    createSession: (root, name) => fakeSession(ds, root, name),
    workspace: ws,
  });
}

function tab(root: string, name = root): ProjectTab {
  return { locator: { kind: "local", root }, name };
}

function keys(tabs: ProjectTab[]): string[] {
  return tabs.map((t) => locatorKey(t.locator));
}

beforeEach(() => {
  localStorage.clear();
  toastError.mockClear();
});

describe("打开项目 action 三态（design D3）", () => {
  it("命中项目：纯探测成功后记入分页、设 activeKey、重挂监看、整批 refresh", async () => {
    const ds = fakeDataSource();
    const ws = fakeWorkspace();
    const store = makeStore(ds, ws);
    await store.getState().openProjectAt("C:\\proj\\alpha");
    const s = store.getState();
    expect(ws.openProject).toHaveBeenCalledWith("C:\\proj\\alpha");
    expect(keys(s.tabs)).toEqual(["local:C:\\proj\\alpha"]);
    expect(s.activeKey).toBe("local:C:\\proj\\alpha");
    // 监看显式跟随活跃 session（决策 5）。
    expect(ws.watchWorkspace).toHaveBeenCalledWith("C:\\proj\\alpha");
    expect(ds.listChanges).toHaveBeenCalled();
    // 持久化：locator＋显示名＋最后活跃 key。
    const persisted = readPersistedTabs();
    expect(persisted.tabs[0]).toEqual({
      locator: { kind: "local", root: "C:\\proj\\alpha" },
      name: "alpha",
    });
    expect(persisted.activeKey).toBe("local:C:\\proj\\alpha");
  });

  it("uninitialized：显示初始化确认（pendingInit），分页与数据不动", async () => {
    const ds = fakeDataSource();
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "uninitialized", dir: "C:\\empty" }),
    });
    const store = makeStore(ds, ws);
    await store.getState().openProjectAt("C:\\empty");
    const s = store.getState();
    expect(s.pendingInit).toBe("C:\\empty");
    expect(s.tabs).toEqual([]);
    expect(ds.listChanges).not.toHaveBeenCalled();
  });

  it("取消初始化：画面与状态不动、不调用 init", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "uninitialized", dir: "C:\\empty" }),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("C:\\empty");
    store.getState().cancelInit();
    const s = store.getState();
    expect(s.pendingInit).toBeNull();
    expect(s.tabs).toEqual([]);
    expect(ws.initProject).not.toHaveBeenCalled();
  });

  it("确认初始化：以所选工具调用 init，成功后切入新项目", async () => {
    const ds = fakeDataSource();
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "uninitialized", dir: "C:\\proj\\fresh" }),
    });
    const store = makeStore(ds, ws);
    await store.getState().openProjectAt("C:\\proj\\fresh");
    await store.getState().confirmInit(["claude", "codex"]);
    const s = store.getState();
    expect(ws.initProject).toHaveBeenCalledWith("C:\\proj\\fresh", ["claude", "codex"]);
    expect(s.pendingInit).toBeNull();
    expect(s.activeKey).toBe("local:C:\\proj\\fresh");
    expect(keys(s.tabs)).toContain("local:C:\\proj\\fresh");
  });

  // --- 第四态：未激活（spec 需求「未激活文件夹经确认后补齐激活」；决策 3） ---

  it("unadopted：显示激活确认（pendingAdopt 锚定回报 root），分页与数据不动", async () => {
    const ds = fakeDataSource();
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "unadopted", root: "C:\\migrated", needsImport: false }),
    });
    const store = makeStore(ds, ws);
    // 自子目录打开：pendingAdopt 必须是探测回报的项目根，非用户所选路径。
    await store.getState().openProjectAt("C:\\migrated\\sub");
    const s = store.getState();
    expect(s.pendingAdopt).toBe("C:\\migrated");
    expect(s.pendingAdoptImport).toBe(false);
    expect(s.tabs).toEqual([]);
    expect(ds.listChanges).not.toHaveBeenCalled();
  });

  it("unadopted 且需要导入：记下激活会改名规格文件夹", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "unadopted", root: "C:\\legacy", needsImport: true }),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("C:\\legacy");
    expect(store.getState().pendingAdoptImport).toBe(true);
  });

  it("取消激活：状态清空、无任何写入调用", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "unadopted", root: "C:\\migrated", needsImport: false }),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("C:\\migrated");
    store.getState().cancelAdopt();
    const s = store.getState();
    expect(s.pendingAdopt).toBeNull();
    expect(s.tabs).toEqual([]);
    expect(ws.adoptProject).not.toHaveBeenCalled();
    expect(ws.initProject).not.toHaveBeenCalled();
  });

  it("确认激活：以所选工具调用 adopt，成功后以回报 root 切入项目", async () => {
    const ds = fakeDataSource();
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "unadopted", root: "C:\\migrated", needsImport: false }),
    });
    const store = makeStore(ds, ws);
    await store.getState().openProjectAt("C:\\migrated");
    await store.getState().confirmAdopt(["claude", "codex"]);
    const s = store.getState();
    expect(ws.adoptProject).toHaveBeenCalledWith("C:\\migrated", ["claude", "codex"]);
    expect(s.pendingAdopt).toBeNull();
    expect(s.activeKey).toBe("local:C:\\migrated");
    expect(keys(s.tabs)).toContain("local:C:\\migrated");
  });

  it("激活失败：单行错误 toast、不切换项目", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "unadopted", root: "C:\\migrated", needsImport: false }),
      adoptProject: vi.fn().mockRejectedValue("cannot adopt 'C:\\migrated': permission denied"),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("C:\\migrated");
    await store.getState().confirmAdopt(["claude"]);
    const s = store.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeKey).toBeNull();
    expect(s.pendingAdopt).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
    const [message] = toastError.mock.calls[0] as [string];
    expect(message).toContain("C:\\migrated");
    expect(message).toContain("permission denied");
  });

  it("打开与初始化失败皆以相同固定 id 发出含主词与 core 错误的 toast", async () => {
    const openWs = fakeWorkspace({
      openProject: vi.fn().mockRejectedValue("cannot open 'C:\\gone': not an existing directory"),
    });
    const openStore = makeStore(fakeDataSource(), openWs);
    await openStore.getState().openProjectAt("C:\\gone");
    expect(openStore.getState().tabs).toEqual([]);
    expect(openStore.getState().activeKey).toBeNull();

    const initWs = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "uninitialized", dir: "C:\\fresh" }),
      initProject: vi.fn().mockRejectedValue("cannot initialize 'C:\\fresh': permission denied"),
    });
    const initStore = makeStore(fakeDataSource(), initWs);
    await initStore.getState().openProjectAt("C:\\fresh");
    await initStore.getState().confirmInit(["codex"]);
    expect(initStore.getState().tabs).toEqual([]);
    expect(initStore.getState().activeKey).toBeNull();

    expect(toastError).toHaveBeenCalledTimes(2);
    const [openMessage, openOptions] = toastError.mock.calls[0] as [string, { id?: string }];
    expect(openMessage).toContain("C:\\gone");
    expect(openMessage).toContain("cannot open");
    const [initMessage, initOptions] = toastError.mock.calls[1] as [string, { id?: string }];
    expect(initMessage).toContain("C:\\fresh");
    expect(initMessage).toContain("permission denied");
    expect(openOptions.id).toEqual(expect.any(String));
    expect(initOptions.id).toBe(openOptions.id);
  });
});

describe("分页列（spec 需求「项目分页列存于 app 本机」）", () => {
  it("依序打开 A、B 再开 A：各一分页、A 为 active（spec Scenario 去重）", async () => {
    const opened: Record<string, { status: string; root: string; name: string }> = {
      A: { status: "project", root: "A", name: "a" },
      B: { status: "project", root: "B", name: "b" },
    };
    const ws = fakeWorkspace({
      openProject: vi.fn().mockImplementation((p: string) => Promise.resolve(opened[p])),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("A");
    await store.getState().openProjectAt("B");
    await store.getState().openProjectAt("A");
    const s = store.getState();
    expect(keys(s.tabs)).toEqual(["local:A", "local:B"]);
    expect(s.activeKey).toBe("local:A");
    // 重启还原：持久化内容一致。
    expect(readPersistedTabs().tabs.map((t) => locatorKey(t.locator))).toEqual([
      "local:A",
      "local:B",
    ]);
    expect(readPersistedTabs().activeKey).toBe("local:A");
  });

  it("点分页切换走与打开项目相同语意（spec Scenario 点击分页切换项目）", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }),
    });
    const ds = fakeDataSource();
    const store = makeStore(ds, ws);
    store.setState({ tabs: [tab("A", "a"), tab("B", "b")], activeKey: "local:A" });
    await store.getState().activateTab("local:B");
    expect(ws.openProject).toHaveBeenCalledWith("B");
    expect(store.getState().activeKey).toBe("local:B");
    expect(ds.listChanges).toHaveBeenCalled();
  });

  it("关闭分页即自持久化清单移除，session 一并回收", async () => {
    const store = makeStore(fakeDataSource(), fakeWorkspace());
    const tabs: ProjectTab[] = [tab("A", "a"), tab("B", "b")];
    store.setState({ tabs, activeKey: "local:A" });
    persistTabs(tabs, "local:A");
    store.getState().closeTab("local:B");
    expect(keys(store.getState().tabs)).toEqual(["local:A"]);
    expect(readPersistedTabs().tabs.map((t) => locatorKey(t.locator))).toEqual(["local:A"]);
    expect(store.getState().sessions["local:B"]).toBeUndefined();
  });

  it("restoreTabs：依持久化 activeKey 还原活跃分页、背景 local 分页各探测一次路径有效性", async () => {
    persistTabs([tab("A", "a"), tab("B", "b")], "local:A");
    const ws = fakeWorkspace({
      openProject: vi
        .fn()
        .mockImplementation((p: string) =>
          Promise.resolve({ status: "project", root: p, name: p.toLowerCase() }),
        ),
      projectStats: vi.fn().mockResolvedValue({ pendingWrapUp: 2 }),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().restoreTabs();
    const s = store.getState();
    expect(keys(s.tabs)).toEqual(["local:A", "local:B"]);
    expect(s.activeKey).toBe("local:A");
    // 背景分页 B 探测一次路径；active 分页 A 不经 project_stats。分页不携带计数徽章。
    expect(ws.projectStats).toHaveBeenCalledWith("B");
    expect(ws.projectStats).not.toHaveBeenCalledWith("A");
    expect(s.tabs.every((t) => !("badge" in t))).toBe(true);
  });

  // specseal 网址以 restoreTabs 为就绪信号：某个背景分页卡住（例如网络磁盘断线）不得拖住它。
  it("restoreTabs：活跃分页还原完成即 resolve，不等背景分页的路径探测", async () => {
    persistTabs([tab("A", "a"), tab("B", "b")], "local:A");
    const ws = fakeWorkspace({
      openProject: vi
        .fn()
        .mockImplementation((p: string) =>
          Promise.resolve({ status: "project", root: p, name: p.toLowerCase() }),
        ),
      projectStats: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const store = makeStore(fakeDataSource(), ws);
    const settled = await Promise.race([
      store.getState().restoreTabs().then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 200)),
    ]);
    expect(settled).toBe("resolved");
    expect(store.getState().activeKey).toBe("local:A");
    expect(ws.projectStats).toHaveBeenCalledWith("B");
  });

  it("首启无持久化分页：启动目录（cwd 探索）为项目时自动记入（决策 4 首启路径）", async () => {
    const ws = fakeWorkspace({
      startupDir: vi.fn().mockResolvedValue("C:\\proj\\alpha"),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().restoreTabs();
    expect(ws.startupDir).toHaveBeenCalled();
    expect(ws.openProject).toHaveBeenCalledWith("C:\\proj\\alpha");
    expect(store.getState().activeKey).toBe("local:C:\\proj\\alpha");
  });

  it("首启且启动目录非项目：维持零分页空状态", async () => {
    const ws = fakeWorkspace({
      startupDir: vi.fn().mockResolvedValue("C:\\nowhere"),
      openProject: vi.fn().mockRejectedValue("cannot open 'C:\\nowhere'"),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().restoreTabs();
    expect(store.getState().tabs).toEqual([]);
    expect(store.getState().activeKey).toBeNull();
  });

  it("refresh 后分页不携带计数徽章（spec「分页不显示计数徽章」）", async () => {
    const ds = fakeDataSource();
    // 契约范例：2 个已就绪变更＋1 份已结论未转出讨论 → 徽章 3。
    ds.listChanges = vi.fn().mockResolvedValue(changeList([
      { name: "ready-a", status: "in-progress", totalTasks: 5, completedTasks: 5 },
      { name: "ready-b", status: "in-progress", totalTasks: 3, completedTasks: 3 },
      { name: "started", status: "in-progress", totalTasks: 10, completedTasks: 2, startedAt: "2026-07-06" },
    ]));
    ds.listDiscussions = vi.fn().mockResolvedValue({
      active: [
        { slug: "alpha", topic: "a", status: "concluded", rounds: 1, created: "2026-01-02", promotedTo: [] },
        { slug: "beta", topic: "b", status: "open", rounds: 1, created: "2026-01-02", promotedTo: [] },
        { slug: "gamma", topic: "c", status: "promoted", rounds: 1, created: "2026-01-02", promotedTo: ["cut"] },
      ],
      archived: [],
    });
    const store = makeStore(ds, fakeWorkspace());
    store.setState({
      tabs: [tab("A", "a")],
      sessions: { "local:A": fakeSession(ds, "A", "a") },
      activeKey: "local:A",
    });
    await store.getState().refresh();
    expect("badge" in store.getState().tabs[0]).toBe(false);
  });

  it("切换以纯探测回报值为准（决策 4：probe 即后端真相，无 current-root 全域）", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "project", root: "B", name: "fresh-name" }),
    });
    const store = makeStore(fakeDataSource(), ws);
    await store.getState().openProjectAt("B");
    expect(
      store.getState().tabs.find((t) => locatorKey(t.locator) === "local:B")?.name,
    ).toBe("fresh-name");
  });

  it("cycleTab 循环切至下一分页（Ctrl+Tab，走打开项目语意）", async () => {
    const ws = fakeWorkspace({
      openProject: vi
        .fn()
        .mockImplementation((p: string) =>
          Promise.resolve({ status: "project", root: p, name: p.toLowerCase() }),
        ),
    });
    const store = makeStore(fakeDataSource(), ws);
    store.setState({
      tabs: [tab("A", "a"), tab("B", "b"), tab("C", "c")],
      activeKey: "local:C",
    });
    await store.getState().cycleTab();
    expect(store.getState().activeKey).toBe("local:A"); // 尾端循环回首位
    await store.getState().cycleTab();
    expect(store.getState().activeKey).toBe("local:B");
  });

  it("gotoTab 直达第 N 个分页（Ctrl+1..9，1-based；超界不动作）", async () => {
    const ws = fakeWorkspace({
      openProject: vi
        .fn()
        .mockImplementation((p: string) =>
          Promise.resolve({ status: "project", root: p, name: p.toLowerCase() }),
        ),
    });
    const store = makeStore(fakeDataSource(), ws);
    store.setState({
      tabs: [tab("A", "a"), tab("B", "b")],
      activeKey: "local:A",
    });
    await store.getState().gotoTab(2);
    expect(store.getState().activeKey).toBe("local:B");
    await store.getState().gotoTab(9);
    expect(store.getState().activeKey).toBe("local:B");
    expect(ws.openProject).toHaveBeenCalledTimes(1);
  });

  it("失效分页：点击转错误态、显示错误、可自项目列移除且不切换（spec Scenario）", async () => {
    const ws = fakeWorkspace({
      openProject: vi.fn().mockRejectedValue("cannot open 'B': not an existing directory"),
    });
    const store = makeStore(fakeDataSource(), ws);
    store.setState({
      tabs: [tab("A", "a"), tab("B", "b")],
      activeKey: "local:A",
    });
    await store.getState().activateTab("local:B");
    const s = store.getState();
    expect(s.activeKey).toBe("local:A");
    expect(s.tabErrors["local:B"]).toContain("not an existing directory");
    // 自项目列移除后持久化清单同步消失。
    store.getState().closeTab("local:B");
    expect(keys(store.getState().tabs)).toEqual(["local:A"]);
    expect(store.getState().tabErrors["local:B"]).toBeUndefined();
  });
});

describe("最近打开清单（spec 需求「最近打开清单」；design D2 成功打开即记入、D5 升级补种）", () => {
  function openable() {
    return fakeWorkspace({
      openProject: vi
        .fn()
        .mockImplementation((p: string) =>
          Promise.resolve({ status: "project", root: p, name: p.toLowerCase() }),
        ),
    });
  }

  it("依序打开 A、B：记录最新在前并写入 localStorage", async () => {
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().openProjectAt("A");
    await store.getState().openProjectAt("B");
    expect(store.getState().recents.map((r) => locatorKey(r.locator))).toEqual([
      "local:B",
      "local:A",
    ]);
    expect(store.getState().recents[0].name).toBe("b");
    expect(readPersistedRecents()?.map((r) => locatorKey(r.locator))).toEqual([
      "local:B",
      "local:A",
    ]);
  });

  // spec Example「顺序、去重与上限」第二列：A, B, C 且 B 分页其后被关闭 → C, B, A。
  it("关闭分页不动记录（spec Scenario 关闭分页后仍列于最近打开）", async () => {
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().openProjectAt("A");
    await store.getState().openProjectAt("B");
    await store.getState().openProjectAt("C");
    store.getState().closeTab("local:B");
    expect(keys(store.getState().tabs)).toEqual(["local:A", "local:C"]);
    expect(store.getState().recents.map((r) => locatorKey(r.locator))).toEqual([
      "local:C",
      "local:B",
      "local:A",
    ]);
    expect(readPersistedRecents()?.map((r) => locatorKey(r.locator))).toEqual([
      "local:C",
      "local:B",
      "local:A",
    ]);
  });

  it("forgetRecent 自状态与 localStorage 移除该笔", async () => {
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().openProjectAt("A");
    await store.getState().openProjectAt("B");
    store.getState().forgetRecent("local:A");
    expect(store.getState().recents.map((r) => locatorKey(r.locator))).toEqual(["local:B"]);
    expect(readPersistedRecents()?.map((r) => locatorKey(r.locator))).toEqual(["local:B"]);
  });

  it("restoreTabs：键缺席时以持久化分页反序补种并立即写入（spec Scenario 升级后首次启动自分页补种）", async () => {
    // 依序打开 A、B 后关闭 app：B 是最后打开也是活跃分页。
    persistTabs([tab("A", "a"), tab("B", "b")], "local:B");
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().restoreTabs();
    expect(store.getState().recents.map((r) => locatorKey(r.locator))).toEqual([
      "local:B",
      "local:A",
    ]);
    expect(readPersistedRecents()?.map((r) => locatorKey(r.locator))).toEqual([
      "local:B",
      "local:A",
    ]);
  });

  it("restoreTabs：键已存在（空清单）时不补种", async () => {
    persistTabs([tab("A", "a"), tab("B", "b")], null);
    persistRecents([]);
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().restoreTabs();
    expect(store.getState().recents).toEqual([]);
    expect(readPersistedRecents()).toEqual([]);
  });

  it("restoreTabs：键为坏数据时归零且不补种（spec Scenario 坏数据归零且不补种）", async () => {
    persistTabs([tab("A", "a"), tab("B", "b")], null);
    localStorage.setItem(RECENTS_STORAGE_KEY, "{not json");
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().restoreTabs();
    expect(store.getState().recents).toEqual([]);
    expect(localStorage.getItem(RECENTS_STORAGE_KEY)).toBe("{not json");
    // 下一次成功打开即把键写回 version 1 的合法内容，且只含这一笔。
    await store.getState().openProjectAt("A");
    expect(readPersistedRecents()?.map((r) => locatorKey(r.locator))).toEqual(["local:A"]);
    expect(JSON.parse(localStorage.getItem(RECENTS_STORAGE_KEY) ?? "{}").version).toBe(1);
  });

  it("restoreTabs 还原活跃分页不把其他分页记入记录", async () => {
    persistTabs([tab("A", "a"), tab("B", "b")], "local:A");
    persistRecents([{ locator: { kind: "local", root: "A" }, name: "a" }]);
    const store = makeStore(fakeDataSource(), openable());
    await store.getState().restoreTabs();
    expect(store.getState().recents.map((r) => locatorKey(r.locator))).toEqual(["local:A"]);
  });
});

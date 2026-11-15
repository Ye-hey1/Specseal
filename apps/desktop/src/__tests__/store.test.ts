import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type {
  ChangeItem,
  ChangeListPayload,
  ManualIndex,
  SearchHit,
  SpecsealDataSource,
  StatusReport,
  UnpromotedCutItem,
} from "@specseal/ui";

import { createAppStore, openTicketStation, selectAssetMigrated, selectAssetPrompt, type AppState } from "../store";
import { assetPrompt } from "../assetPrompt";
import type { ConnectionsAdapter, LoginPhase, LoginResult } from "../adapter/connections";
import type { FsActionsAdapter } from "../adapter/fsActions";
import { APP_MESSAGES } from "../i18n/messages";
import fsActionsRs from "../../core/src/fs_actions.rs?raw";
import type { WorkspaceAdapter } from "../adapter/workspace";
import { LOCAL_CAPABILITIES, type WorkspaceSession } from "../session";
import { REMOTE_CHECKOUT, REMOTE_STALE_PROBE, STALE_PROBE } from "./helpers/assetFixtures";
import { changeList } from "./helpers/changeList";

// sonner 双面 mock：toast() 本体（背景检查发现新版本的提示）与 toast.error（失败路径）。
const { toastError, toastFn } = vi.hoisted(() => ({ toastError: vi.fn(), toastFn: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(toastFn, { error: toastError }) }));

const STATUS: StatusReport = {
  changeName: "x",
  schemaName: "spec-driven",
  isComplete: false,
  applyRequires: ["tasks"],
  artifacts: [],
};

/** 两站工单并存的 change——封存守门要连过两站的测试共用这笔。 */
const BOTH_TICKETS_CHANGE = {
  name: "desktop-shell-and-browser",
  status: "in-progress",
  totalTasks: 26,
  completedTasks: 26,
  reviewStatus: "inReview" as const,
  verifyStatus: "inVerify" as const,
};

function fakeDataSource(over: Partial<SpecsealDataSource> = {}): SpecsealDataSource {
  return {
    listChanges: vi.fn().mockResolvedValue(changeList([
      { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 26, completedTasks: 24 },
    ])),
    listSpecs: vi.fn().mockResolvedValue([{ id: "desktop-app" }]),
    listArchived: vi.fn().mockResolvedValue([{ datedName: "2026-07-04-x", date: "2026-07-04", name: "x" }]),
    status: vi.fn().mockResolvedValue(STATUS),
    changeMeta: vi.fn().mockResolvedValue(null),
    deleteChange: vi.fn().mockResolvedValue(undefined),
    setTaskDone: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    getDocument: vi.fn().mockResolvedValue("## Why\nhello"),
    getSpecDocument: vi.fn().mockResolvedValue("# spec"),
    searchWorkspace: vi.fn().mockResolvedValue([]),
    changeCapabilities: vi.fn().mockResolvedValue(["desktop-app"]),
    runVerb: vi.fn().mockResolvedValue({ valid: true }),
    getArchivedDocument: vi.fn().mockResolvedValue(null),
    archivedCapabilities: vi.fn().mockResolvedValue([]),
    listDiscussions: vi.fn().mockResolvedValue({ active: [], archived: [] }),
    getDiscussionDocument: vi.fn().mockResolvedValue(null),
    promoteDiscussion: vi.fn().mockResolvedValue({ change: "promoted-change" }),
    archiveDiscussion: vi.fn().mockResolvedValue(undefined),
    reorderCard: vi.fn().mockResolvedValue(undefined),
    setDepends: vi.fn().mockResolvedValue(undefined),
    listManualPages: vi
      .fn()
      .mockResolvedValue({ present: false, reason: null, pages: [], uncoveredNew: [], malformed: [] }),
    getManualPage: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

/** 带一则 active 讨论 topic-a 的数据源（讨论抽屉相关测试共用）。 */
function withTopicA(over: Partial<SpecsealDataSource> = {}): SpecsealDataSource {
  return fakeDataSource({
    listDiscussions: vi.fn().mockResolvedValue({
      active: [
        { slug: "topic-a", topic: "t", status: "open", rounds: 1, created: "2026-07-17", promotedTo: [] },
      ],
      archived: [],
    }),
    ...over,
  });
}

/** 假 session（workspace-session 决策 6）：数据加载一律经活跃 session 的 dataSource。 */
function fakeSession(ds: SpecsealDataSource, root = "A", name = "a"): WorkspaceSession {
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
    },
    events: { subscribe: () => () => {} },
    capabilities: LOCAL_CAPABILITIES,
  };
}

/** 以活跃 session 预置 store（注入 session 工厂、无 workspace 探测面）。 */
function storeWith(ds: SpecsealDataSource) {
  const store = trackedAppStore({ createSession: (root, name) => fakeSession(ds, root, name) });
  const session = fakeSession(ds);
  store.setState({ sessions: { [session.id]: session }, activeKey: session.id });
  return store;
}

function remoteSession(ds: SpecsealDataSource, repoId: string): WorkspaceSession {
  const locator = { kind: "remote" as const, connectionId: "c1", projectId: "demo", repoId };
  return {
    id: `remote:c1/demo/${repoId}`,
    locator,
    descriptor: { name: `Demo/${repoId}` },
    dataSource: ds,
    settings: {
      kind: "remote",
      policyWrite: true,
      readSettings: vi.fn(),
      writeAppTools: vi.fn(),
      writeWorkflowConfig: vi.fn(),
      writeWorkflowContext: vi.fn(),
      writeWorkflowRules: vi.fn(),
    },
    events: { subscribe: () => () => {} },
    capabilities: LOCAL_CAPABILITIES,
  };
}

function storeWithRemoteSessions(a: WorkspaceSession, b: WorkspaceSession) {
  const store = trackedAppStore({
    createSession: () => {
      throw new Error("remote session 测试不得创建 local session");
    },
    workspace: {} as WorkspaceAdapter,
  });
  store.setState({
    tabs: [
      { locator: a.locator, name: a.descriptor.name },
      { locator: b.locator, name: b.descriptor.name },
    ],
    sessions: { [a.id]: a, [b.id]: b },
    activeKey: a.id,
  });
  return store;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  toastError.mockClear();
  toastFn.mockClear();
  localStorage.clear();
});

// 追踪本档创建的每个 store，测后统一清掉搜索去抖计时器：测试结束后才开火的
// 200ms 计时器会打在已拆除的 mock 上（searchWorkspace 回 undefined），成为整包
// 测试的 unhandled error flake——535 全过仍红整个 run。
const trackedStores: ReturnType<typeof createAppStore>[] = [];
function trackedAppStore(...args: Parameters<typeof createAppStore>) {
  const store = createAppStore(...args);
  trackedStores.push(store);
  return store;
}
afterEach(() => {
  for (const store of trackedStores.splice(0)) store.getState().disposeSearch();
});

describe("app store (Zustand)", () => {
  it("refresh loads changes, specs and archived", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    expect(store.getState().changes).toHaveLength(1);
    expect(store.getState().specs).toHaveLength(1);
    expect(store.getState().archived).toHaveLength(1);
    expect(store.getState().loaded).toBe(true);
  });

  it("refresh increments the refreshGen generation (initial 0)", async () => {
    // 刷新世代：内容组件据此重载已加载的文档（design D1）。
    const store = storeWith(fakeDataSource());
    expect(store.getState().refreshGen).toBe(0);
    await store.getState().refresh();
    expect(store.getState().refreshGen).toBe(1);
    await store.getState().refresh();
    expect(store.getState().refreshGen).toBe(2);
  });

  it("switches back to each remote session's own last-success snapshot when refresh fails", async () => {
    const aChanges = vi
      .fn()
      .mockResolvedValue(changeList([{ name: "a-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }]));
    const bChanges = vi
      .fn()
      .mockResolvedValue(changeList([{ name: "b-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }]));
    const a = remoteSession(fakeDataSource({ listChanges: aChanges }), "alpha");
    const b = remoteSession(fakeDataSource({ listChanges: bChanges }), "beta");
    const store = storeWithRemoteSessions(a, b);

    await store.getState().refresh();
    await store.getState().activateTab(b.id);
    expect(store.getState().changes.map((change) => change.name)).toEqual(["b-change"]);

    aChanges.mockRejectedValue(new Error("alpha offline"));
    bChanges.mockRejectedValue(new Error("beta offline"));
    await store.getState().activateTab(a.id);
    const afterReturningToA = store.getState().changes.map((change) => change.name);
    await store.getState().activateTab(b.id);
    const afterReturningToB = store.getState().changes.map((change) => change.name);

    expect([afterReturningToA, afterReturningToB]).toEqual([["a-change"], ["b-change"]]);
    const persisted = JSON.parse(localStorage.getItem("specseal.projectTabs") ?? "{}");
    expect(Object.keys(persisted).sort()).toEqual(["activeKey", "tabs", "version"]);
    expect(JSON.stringify(persisted)).not.toContain("a-change");
    expect(JSON.stringify(persisted)).not.toContain("b-change");
  });

  it("clears the previous workspace when a never-loaded needs-reauth session cannot refresh", async () => {
    const a = remoteSession(
      fakeDataSource({
        listChanges: vi
          .fn()
          .mockResolvedValue(changeList([{ name: "a-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }])),
        listSpecs: vi.fn().mockResolvedValue([{ id: "a-spec" }]),
      }),
      "alpha",
    );
    const b = remoteSession(
      fakeDataSource({ listChanges: vi.fn().mockRejectedValue(new Error("login required")) }),
      "beta",
    );
    b.connectionState = {
      connectionId: "c1",
      state: "needs-reauth",
      message: "请重新登录",
    };
    const store = storeWithRemoteSessions(a, b);
    await store.getState().refresh();

    await store.getState().activateTab(b.id);

    const state = store.getState();
    expect(state.activeKey).toBe(b.id);
    expect(state.changes).toEqual([]);
    expect(state.specs).toEqual([]);
    expect(state.archived).toEqual([]);
    expect(state.discussions).toEqual({ active: [], archived: [] });
    expect(state.loaded).toBe(false);
  });

  it("clears a closed active session's content instead of retaining its runtime snapshot", async () => {
    const a = remoteSession(
      fakeDataSource({
        listChanges: vi
          .fn()
          .mockResolvedValue(changeList([{ name: "a-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }])),
      }),
      "alpha",
    );
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("remote session 测试不得创建 local session");
      },
      workspace: {} as WorkspaceAdapter,
    });
    store.setState({
      tabs: [{ locator: a.locator, name: a.descriptor.name }],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });
    await store.getState().refresh();

    store.getState().closeTab(a.id);

    expect(store.getState().activeKey).toBeNull();
    expect(store.getState().changes).toEqual([]);
    expect(store.getState().loaded).toBe(false);
  });

  it("does not let a late refresh from workspace A overwrite active workspace B", async () => {
    const pendingA = deferred<ChangeListPayload>();
    const a = remoteSession(
      fakeDataSource({ listChanges: vi.fn(() => pendingA.promise) }),
      "alpha",
    );
    const b = remoteSession(
      fakeDataSource({
        listChanges: vi
          .fn()
          .mockResolvedValue(changeList([{ name: "b-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }])),
      }),
      "beta",
    );
    const store = storeWithRemoteSessions(a, b);

    const aRefresh = store.getState().refresh();
    await store.getState().activateTab(b.id);
    expect(store.getState().changes.map((change) => change.name)).toEqual(["b-change"]);

    pendingA.resolve(changeList([
      { name: "a-late", status: "in-progress", totalTasks: 1, completedTasks: 0 },
    ]));
    await aRefresh;

    expect(store.getState().activeKey).toBe(b.id);
    expect(store.getState().changes.map((change) => change.name)).toEqual(["b-change"]);
  });

  it("keeps the latest refresh result when an older request for the same session finishes last", async () => {
    const older = deferred<ChangeListPayload>();
    const latest = deferred<ChangeListPayload>();
    const listChanges = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);
    const b = remoteSession(fakeDataSource({ listChanges }), "beta");
    const other = remoteSession(fakeDataSource(), "other");
    const store = storeWithRemoteSessions(b, other);

    const olderRefresh = store.getState().refresh();
    const latestRefresh = store.getState().refresh();
    latest.resolve(changeList([
      { name: "newer", status: "in-progress", totalTasks: 1, completedTasks: 0 },
    ]));
    await latestRefresh;
    older.resolve(changeList([
      { name: "older", status: "in-progress", totalTasks: 1, completedTasks: 0 },
    ]));
    await olderRefresh;

    expect(store.getState().changes.map((change) => change.name)).toEqual(["newer"]);
  });

  it("invalidates workspace A search and detail state when switching to needs-reauth B", async () => {
    vi.useFakeTimers();
    const pendingSearch = deferred<SearchHit[]>();
    const a = remoteSession(
      fakeDataSource({
        listChanges: vi
          .fn()
          .mockResolvedValue(changeList([{ name: "a-change", status: "in-progress", totalTasks: 1, completedTasks: 0 }])),
        searchWorkspace: vi.fn(() => pendingSearch.promise),
      }),
      "alpha",
    );
    const b = remoteSession(
      fakeDataSource({ listChanges: vi.fn().mockRejectedValue(new Error("login required")) }),
      "beta",
    );
    b.connectionState = {
      connectionId: "c1",
      state: "needs-reauth",
      message: "请重新登录",
    };
    const store = storeWithRemoteSessions(a, b);

    try {
      await store.getState().refresh();
      store.getState().openDetail("a-change");
      store.setState({
        detailSpec: "a-spec",
        pendingArchive: "a-change",
        pendingDelete: "a-change",
        pendingArchiveDiscussion: "a-topic",
      });
      store.getState().setBoardQuery("a");
      await vi.advanceTimersByTimeAsync(200);

      await store.getState().activateTab(b.id);

      expect(store.getState()).toMatchObject({
        activeKey: b.id,
        searchHits: [],
        detailChange: null,
        detailDiscussion: null,
        detailSpec: null,
        detailArchived: null,
        pendingArchive: null,
        pendingDelete: null,
        pendingArchiveDiscussion: null,
        detailVerb: null,
      });

      pendingSearch.resolve([
        { kind: "change", id: "a-change", artifact: "design.md", snippet: "A only" },
      ]);
      await Promise.resolve();
      await Promise.resolve();
      expect(store.getState().searchHits).toEqual([]);
      expect(store.getState().boardQuery).toBe("a");
    } finally {
      store.getState().disposeSearch();
      vi.useRealTimers();
    }
  });

  it("setView, setQuery and toggleExpand update UI state", () => {
    const store = storeWith(fakeDataSource());
    store.getState().setView("archived");
    store.getState().setQuery("desk");
    store.getState().toggleExpand("a");
    expect(store.getState().view).toBe("archived");
    expect(store.getState().query).toBe("desk");
    expect(store.getState().expandedName).toBe("a");
    // 再次 toggle 同一名称收合
    store.getState().toggleExpand("a");
    expect(store.getState().expandedName).toBeNull();
  });

  it("boardView can switch to the specs page and keeps the specs list state", async () => {
    // spec「规格页提供清单、搜索与展开查看」：主视图添加 specs 态
    // （与看板、已封存、设置并列），切换不动已加载的 specs 清单。
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    store.getState().setBoardView("specs");
    expect(store.getState().boardView).toBe("specs");
    expect(store.getState().specs).toHaveLength(1);
    store.getState().setBoardView("board");
    expect(store.getState().boardView).toBe("board");
  });

  it("boardQuery starts empty and setBoardQuery updates it", () => {
    // 看板搜索字符串：纯 UI 状态、不入任何 persist 机制（spec「不跨启动保留」）。
    const store = storeWith(fakeDataSource());
    expect(store.getState().boardQuery).toBe("");
    store.getState().setBoardQuery("desk");
    expect(store.getState().boardQuery).toBe("desk");
  });

  it("boardQuery triggers the debounced full-text search (latest wins); clearing resets hits", async () => {
    // design D6：200ms 去抖、latest-wins；空 query 清命中并取消在途。
    vi.useFakeTimers();
    const hits = [{ kind: "change", id: "demo", artifact: "design.md", snippet: "…x…" }];
    const ds = fakeDataSource({ searchWorkspace: vi.fn().mockResolvedValue(hits) });
    const store = storeWith(ds);
    store.getState().setBoardQuery("d");
    store.getState().setBoardQuery("di");
    expect(ds.searchWorkspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(ds.searchWorkspace).toHaveBeenCalledTimes(1);
    expect(ds.searchWorkspace).toHaveBeenCalledWith("di");
    expect(store.getState().searchHits).toEqual(hits);
    store.getState().setBoardQuery("");
    expect(store.getState().searchHits).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(ds.searchWorkspace).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("full-text search failure falls back to field matching silently", async () => {
    // spec「全文查找失败静默退回字段比对」：不弹错、不阻断输入。
    vi.useFakeTimers();
    const ds = fakeDataSource({ searchWorkspace: vi.fn().mockRejectedValue(new Error("ipc down")) });
    const store = storeWith(ds);
    store.getState().setBoardQuery("x");
    await vi.advanceTimersByTimeAsync(200);
    expect(store.getState().searchHits).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("disposeSearch cancels the pending debounced search（卸载后在途去抖不触发）", async () => {
    // 生命周期清理：组件卸载时取消漏出的去抖 timer 并作废在途回填，
    // 杜绝搜索在拥有它的 store 卸载后才开火所致的未处理例外。
    vi.useFakeTimers();
    const ds = fakeDataSource({ searchWorkspace: vi.fn().mockResolvedValue([]) });
    const store = storeWith(ds);
    store.getState().setBoardQuery("di");
    store.getState().disposeSearch();
    await vi.advanceTimersByTimeAsync(300);
    expect(ds.searchWorkspace).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("boardQuery and the archived-page query are independent", () => {
    // spec「搜索字符串…与已封存页独立」：各自设值互不覆盖。
    const store = storeWith(fakeDataSource());
    store.getState().setBoardQuery("kanban");
    store.getState().setQuery("archived");
    expect(store.getState().boardQuery).toBe("kanban");
    expect(store.getState().query).toBe("archived");
    store.getState().setQuery("other");
    expect(store.getState().boardQuery).toBe("kanban");
  });

  it("archive confirm flow: request sets pending, confirm runs archive and clears", async () => {
    const ds = fakeDataSource();
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    expect(store.getState().pendingArchive).toBe("desktop-shell-and-browser");
    await store.getState().confirmArchive();
    expect(store.getState().pendingArchive).toBeNull();
    expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
  });

  it("cancelArchive clears pending without running", () => {
    const ds = fakeDataSource();
    const store = storeWith(ds);
    store.getState().requestArchive("x");
    store.getState().cancelArchive();
    expect(store.getState().pendingArchive).toBeNull();
    expect(ds.runVerb).not.toHaveBeenCalled();
  });

  it("删除、封存变更与封存讨论成功时皆不发出 toast", async () => {
    const ds = fakeDataSource({
      runVerb: vi.fn().mockResolvedValue({ datedName: "2026-07-17-desktop-shell-and-browser" }),
    });
    const store = storeWith(ds);

    store.getState().requestDelete("desktop-shell-and-browser");
    await store.getState().confirmDelete();
    await store.getState().runVerb("archive", "desktop-shell-and-browser");
    store.getState().requestArchiveDiscussion("desktop-feedback-surface");
    await store.getState().confirmArchiveDiscussion();

    expect(toastError).not.toHaveBeenCalled();
  });

  it("四条 store 失败路径皆发出含主词、core 错误与相同固定 id 的 error toast", async () => {
    const ds = fakeDataSource({
      deleteChange: vi.fn().mockRejectedValue(new Error("delete locked")),
      runVerb: vi.fn().mockRejectedValue(new Error("archive blocked")),
      archiveDiscussion: vi.fn().mockRejectedValue(new Error("discussion locked")),
      reorderCard: vi.fn().mockRejectedValue(new Error("order locked")),
    });
    const store = storeWith(ds);

    store.getState().requestDelete("delete-me");
    await store.getState().confirmDelete();
    await store.getState().runVerb("archive", "archive-me");
    store.getState().requestArchiveDiscussion("discussion-me");
    await store.getState().confirmArchiveDiscussion();
    await store.getState().reorderCard("change", "reorder-me", null, "next-change");

    expect(toastError).toHaveBeenCalledTimes(4);
    const expected = [
      ["delete-me", "delete locked"],
      ["archive-me", "archive blocked"],
      ["discussion-me", "discussion locked"],
      ["reorder-me", "order locked"],
    ];
    for (const [index, [subject, coreError]] of expected.entries()) {
      const [message, options] = toastError.mock.calls[index] as [string, { id?: string }];
      expect(message).toContain(subject);
      expect(message).toContain(coreError);
      expect(options.id).toEqual(expect.any(String));
    }
    expect(new Set(toastError.mock.calls.map((call) => call[1]?.id)).size).toBe(1);
    expect(ds.listChanges).toHaveBeenCalled();
  });

  it("refresh：清单与顶层 planError 来自同一次 listChanges；无成环时 planError 为 null", async () => {
    // add-change-plan-desktop design D1／D5：planError 随清单 payload 进 store，
    // 宿主据此让看板出成环提示。
    const cyclic = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(
        changeList(
          [{ name: "a", status: "in-progress", totalTasks: 1, completedTasks: 0 }],
          "dependency cycle: a -> b -> a",
        ),
      ),
    });
    const store = storeWith(cyclic);
    await store.getState().refresh();
    expect(store.getState().changes.map((c) => c.name)).toEqual(["a"]);
    expect(store.getState().planError).toBe("dependency cycle: a -> b -> a");

    const plain = storeWith(fakeDataSource());
    await plain.getState().refresh();
    expect(plain.getState().planError).toBeNull();
  });

  // desktop-roadmap：路线图的 next 与尚未转出的刀随同一次 listChanges 进 store。
  const PANEL_CUT: UnpromotedCutItem = {
    discussion: "panel",
    cut: "cut 3",
    title: "路线图",
    changes: ["add-z"],
    unpromoted: ["add-z"],
  };

  it("refresh：清单回应的 next 与 unpromotedCuts 进 store 的 planNext 与 unpromotedCuts", async () => {
    const store = storeWith(
      fakeDataSource({
        listChanges: vi.fn().mockResolvedValue({
          ...changeList([{ name: "add-a", status: "proposed", totalTasks: 1, completedTasks: 0 }]),
          next: "add-a",
          unpromotedCuts: [PANEL_CUT],
        }),
      }),
    );
    await store.getState().refresh();
    expect(store.getState().planNext).toBe("add-a");
    expect(store.getState().unpromotedCuts).toEqual([PANEL_CUT]);
  });

  it("refresh：清单回应的 next 为 null、unpromotedCuts 为空数组时照样写入", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    expect(store.getState().planNext).toBeNull();
    expect(store.getState().unpromotedCuts).toEqual([]);
  });

  it("切到另一个 workspace 再切回时 planNext 与 unpromotedCuts 由快照还原", async () => {
    const aChanges = vi.fn().mockResolvedValue({
      ...changeList([{ name: "a-change", status: "proposed", totalTasks: 1, completedTasks: 0 }]),
      next: "a-change",
      unpromotedCuts: [PANEL_CUT],
    });
    const a = remoteSession(fakeDataSource({ listChanges: aChanges }), "alpha");
    const b = remoteSession(fakeDataSource(), "beta");
    const store = storeWithRemoteSessions(a, b);

    await store.getState().refresh();
    await store.getState().activateTab(b.id);
    expect(store.getState().planNext).toBeNull();
    expect(store.getState().unpromotedCuts).toEqual([]);

    // 切回 A 时重载失败：画面上的两栏只能来自 A 的快照。
    aChanges.mockRejectedValue(new Error("alpha offline"));
    await store.getState().activateTab(a.id);
    expect(store.getState().planNext).toBe("a-change");
    expect(store.getState().unpromotedCuts).toEqual([PANEL_CUT]);
  });

  // spec desktop-roadmap「看板页的路线图查看」：卡片／路线图是看板页的两种查看。
  it("boardMode 缺省为 cards", () => {
    expect(storeWith(fakeDataSource()).getState().boardMode).toBe("cards");
  });

  it("openDetail、openDiscussion 与关闭详情页都不改变 boardMode（自路线图开详情、关闭后回到路线图）", async () => {
    const store = storeWith(withTopicA());
    await store.getState().refresh();
    store.getState().setBoardMode("roadmap");
    store.getState().openDetail("desktop-shell-and-browser");
    expect(store.getState().detailChange?.name).toBe("desktop-shell-and-browser");
    expect(store.getState().boardMode).toBe("roadmap");
    store.getState().closeDetailPage();
    expect(store.getState().boardMode).toBe("roadmap");
    store.getState().openDiscussion("topic-a");
    expect(store.getState().detailDiscussion?.slug).toBe("topic-a");
    expect(store.getState().boardMode).toBe("roadmap");
    store.getState().closeDetailPage();
    expect(store.getState().boardView).toBe("board");
    expect(store.getState().boardMode).toBe("roadmap");
  });

  it("切到其他页再回到看板页时维持上次选的查看（Scenario「切到其他页再回来维持路线图」）", () => {
    const store = storeWith(fakeDataSource());
    store.getState().setBoardMode("roadmap");
    store.getState().setBoardView("specs");
    store.getState().setBoardView("board");
    expect(store.getState().boardMode).toBe("roadmap");
  });

  it("openRoadmap 关闭开着的详情页、切回看板页并显示路线图（Scenario「以网址打开路线图」）", async () => {
    const store = storeWith(withTopicA());
    await store.getState().refresh();
    store.getState().openDetail("desktop-shell-and-browser");
    store.getState().openRoadmap();
    expect(store.getState().detailChange).toBeNull();
    expect(store.getState().boardView).toBe("board");
    expect(store.getState().boardMode).toBe("roadmap");
    store.getState().setBoardView("specs");
    store.getState().openRoadmap();
    expect(store.getState().boardView).toBe("board");
    expect(store.getState().boardMode).toBe("roadmap");
  });

  it("openBoard 从详情页、规格页与路线图查看都回到看板页的卡片查看（Scenario「以网址切到项目并显示看板」）", async () => {
    const store = storeWith(withTopicA());
    await store.getState().refresh();
    const expectBoardCards = () =>
      expect(store.getState()).toMatchObject({
        boardView: "board",
        boardMode: "cards",
        detailChange: null,
        detailDiscussion: null,
      });
    // 开着变更详情页，而且上次选的是路线图。
    store.getState().setBoardMode("roadmap");
    store.getState().openDetail("desktop-shell-and-browser");
    store.getState().openBoard();
    expectBoardCards();
    // 开着讨论详情页。
    store.getState().setBoardMode("roadmap");
    store.getState().openDiscussion("topic-a");
    store.getState().openBoard();
    expectBoardCards();
    // 规格页。
    store.getState().setBoardView("specs");
    store.getState().openBoard();
    expectBoardCards();
    // 路线图查看。
    store.getState().openRoadmap();
    store.getState().openBoard();
    expectBoardCards();
  });

  it("boardMode 不写进 localStorage", async () => {
    const store = storeWith(withTopicA());
    await store.getState().refresh();
    store.getState().setBoardMode("roadmap");
    store.getState().setBoardView("specs");
    store.getState().setBoardView("board");
    store.getState().openDetail("desktop-shell-and-browser");
    store.getState().closeDetailPage();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(`${key}=${localStorage.getItem(key)}`).not.toMatch(/roadmap|boardMode/);
    }
  });

  it("setDepends：成功后刷新清单，失败以同一单槽 toast 呈现引擎消息", async () => {
    // add-change-plan-desktop design D6：写入经数据源 setDepends，成功刷新、
    // 失败单行错误（引擎拒绝文本）且画面不变。
    const ds = fakeDataSource({
      setDepends: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("dependency cycle: b -> a -> b")),
    });
    const store = storeWith(ds);
    const listed = (ds.listChanges as ReturnType<typeof vi.fn>).mock.calls.length;

    await store.getState().setDepends("b", ["a"], false);
    expect(ds.setDepends).toHaveBeenCalledWith("b", ["a"], false);
    expect(toastError).not.toHaveBeenCalled();
    expect((ds.listChanges as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listed + 1);

    await store.getState().setDepends("b", ["a"], false);
    expect(toastError).toHaveBeenCalledTimes(1);
    const [message] = toastError.mock.calls[0] as [string];
    expect(message).toContain("b");
    expect(message).toContain("dependency cycle: b -> a -> b");
  });

  it("core 错误为空、超长或 HTML-like 字符串时皆安全交给 sonner", async () => {
    const longError = "x".repeat(20_000);
    const htmlLikeError = '<img src="x" onerror="globalThis.pwned=true">';
    const deleteChange = vi
      .fn()
      .mockRejectedValueOnce("")
      .mockRejectedValueOnce(longError)
      .mockRejectedValueOnce(htmlLikeError);
    const store = storeWith(fakeDataSource({ deleteChange }));

    for (const subject of ["empty-error", "long-error", "html-error"]) {
      store.getState().requestDelete(subject);
      await store.getState().confirmDelete();
    }

    expect(toastError).toHaveBeenCalledTimes(3);
    const messages = toastError.mock.calls.map(([message]) => message as string);
    expect(messages[0]).toContain("empty-error");
    expect(messages[0]).toContain("✗ ");
    expect(messages[1]).toContain(longError);
    expect(messages[2]).toContain(htmlLikeError);
    expect(messages.every((message) => typeof message === "string")).toBe(true);
  });

  it("runVerb analyze runs validate and analyze together into one drawer result", async () => {
    // design D1：「分析」单键双动词——validate＋analyze 合并为单一结构化抽屉结果。
    const report = {
      change_id: "x",
      dimensions: [{ dimension: "Ambiguity", status: "1 issue(s) found", finding_count: 1 }],
      findings: [
        { id: "AMB-1", dimension: "Ambiguity", severity: "Suggestion", location: "specs", summary: "s", recommendation: "r" },
      ],
      artifacts_analyzed: [],
      artifacts_missing: [],
    };
    const runVerb = vi.fn().mockImplementation((verb: string) =>
      Promise.resolve(verb === "validate" ? { valid: true, errors: [] } : report),
    );
    const ds = fakeDataSource({ runVerb });
    const store = storeWith(ds);
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    expect(runVerb).toHaveBeenCalledWith("validate", "desktop-shell-and-browser");
    expect(runVerb).toHaveBeenCalledWith("analyze", "desktop-shell-and-browser");
    expect(store.getState().detailVerb).toMatchObject({
      change: "desktop-shell-and-browser",
      validate: { valid: true },
      analyze: { findings: [{ dimension: "Ambiguity" }] },
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(ds.listChanges).toHaveBeenCalled();
  });

  it("runVerb analyze failure surfaces the error in the drawer result", async () => {
    // 任一动词失败不静默：error 进抽屉结果呈现 core 消息。
    const ds = fakeDataSource({ runVerb: vi.fn().mockRejectedValue(new Error("parse boom")) });
    const store = storeWith(ds);
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    expect(store.getState().detailVerb?.change).toBe("desktop-shell-and-browser");
    expect(store.getState().detailVerb?.error).toContain("parse boom");
  });

  it("clearDetailVerb closes the analysis result; switching change still clears it", async () => {
    // design D2：分析面板可关闭——clearDetailVerb 收合；既有「换 change 清空」不回归。
    const ds = fakeDataSource();
    const store = storeWith(ds);
    await store.getState().refresh();
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    expect(store.getState().detailVerb).not.toBeNull();
    store.getState().clearDetailVerb();
    expect(store.getState().detailVerb).toBeNull();
    // 换 change 清空行为保留
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    store.getState().openDetail("desktop-shell-and-browser");
    expect(store.getState().detailVerb).toBeNull();
  });

  it("runVerb archive 成功维持静默", async () => {
    const ds = fakeDataSource({ runVerb: vi.fn().mockResolvedValue({ datedName: "2026-07-09-x" }) });
    const store = storeWith(ds);
    await store.getState().runVerb("archive", "desktop-shell-and-browser");
    expect(toastError).not.toHaveBeenCalled();
    expect(store.getState().detailVerb).toBeNull();
    expect(ds.listChanges).toHaveBeenCalled();
  });

  it("详情抽屉中的封存成功会关闭抽屉，失败则保留 change 上下文", async () => {
    const successStore = storeWith(fakeDataSource());
    await successStore.getState().refresh();
    successStore.getState().openDetail("desktop-shell-and-browser");
    successStore.getState().requestArchive("desktop-shell-and-browser");
    await successStore.getState().confirmArchive();
    expect(successStore.getState().detailChange).toBeNull();

    const failureStore = storeWith(fakeDataSource({
      runVerb: vi.fn().mockRejectedValue(new Error("archive prerequisites missing")),
    }));
    await failureStore.getState().refresh();
    failureStore.getState().openDetail("desktop-shell-and-browser");
    failureStore.getState().requestArchive("desktop-shell-and-browser");
    await failureStore.getState().confirmArchive();
    expect(failureStore.getState().detailChange?.name).toBe("desktop-shell-and-browser");
  });

  it("三选项「放弃审查」先删工单再走既有封存流程", async () => {
    // spec「封存入口的未结工单三选项」：等同 review discard 后封存——工单先删，
    // 之后照既有 archive 动词走（含成功静默与重载）。
    const discardReview = vi.fn().mockResolvedValue(undefined);
    const ds = fakeDataSource({ discardReview });
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    expect(discardReview).toHaveBeenCalledWith("desktop-shell-and-browser");
    expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
    expect(store.getState().pendingArchive).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("「放弃审查」删工单失败即不封存，且提示说的是删工单而非封存", async () => {
    const ds = fakeDataSource({
      discardReview: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    expect(ds.runVerb).not.toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("放弃审查失败"),
      expect.anything(),
    );
  });

  it("后端不支持三选项处置时出声，不静默吞掉", async () => {
    // remote 等未实作的后端：对话框关掉却什幺都没发生，用户无从得知。
    for (const action of ["confirmArchiveDiscardTicket", "confirmArchiveCarryTicket"] as const) {
      toastError.mockClear();
      const store = storeWith(fakeDataSource());
      store.getState().requestArchive("desktop-shell-and-browser");
      await store.getState()[action]("review");
      expect(store.getState().pendingArchive).toBeNull();
      expect(toastError).toHaveBeenCalled();
    }
  });

  it("不支持处置的提示不含工程方法名", async () => {
    // openspec/LANGUAGE.md：工程词不出现在用户可见文案。
    for (const [action, method] of [
      ["confirmArchiveDiscardTicket", "discardReview"],
      ["confirmArchiveCarryTicket", "archiveCarry"],
    ] as const) {
      toastError.mockClear();
      const store = storeWith(fakeDataSource());
      store.getState().requestArchive("desktop-shell-and-browser");
      await store.getState()[action]("review");
      const [message] = toastError.mock.calls[0] as [string];
      expect(message).not.toContain(method);
    }
  });

  it("「放弃审查」后封存失败的提示点名审查已放弃，而非单纯封存失败", async () => {
    // 工单在 discard 已删；封存此后被拒时，用户必须知道审查纪录已不在。
    const ds = fakeDataSource({
      discardReview: vi.fn().mockResolvedValue(undefined),
      runVerb: vi.fn().mockRejectedValue(new Error("tasks incomplete")),
    });
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("审查已放弃"),
      expect.anything(),
    );
  });

  it("处置按钮连点只发一次处置，不重复封存也不误报失败", async () => {
    // 对话框在 await 期间保持打开且按钮未锁——连点的第二击必须被忽略，否则
    // 第二次 discard 对已删的工单失败，错误提示配上「其实已封存」的矛盾。
    const discardReview = vi.fn().mockResolvedValue(undefined);
    const ds = fakeDataSource({ discardReview });
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    await Promise.all([
      store.getState().confirmArchiveDiscardTicket("review"),
      store.getState().confirmArchiveDiscardTicket("review"),
    ]);
    expect(discardReview).toHaveBeenCalledTimes(1);
    const archiveCalls = (ds.runVerb as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([verb]) => verb === "archive",
    );
    expect(archiveCalls).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("先放弃审查、验证照样带走：封存失败仍点名审查纪录已不在", async () => {
    // 混合处置：review.md 已删且不可回复——最终封存无论由哪站收尾，失败提示
    // 都不得退化成单纯「封存失败」。
    const ds = fakeDataSource({
      discardReview: vi.fn().mockResolvedValue(undefined),
      archiveCarry: vi.fn().mockRejectedValue(new Error("refused")),
      listChanges: vi.fn().mockResolvedValue(changeList([BOTH_TICKETS_CHANGE])),
    });
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    await store.getState().confirmArchiveCarryTicket("verify");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("审查已放弃"),
      expect.anything(),
    );
  });

  it("两站都放弃后封存失败：提示点名两站纪录都已不在", async () => {
    const ds = fakeDataSource({
      discardReview: vi.fn().mockResolvedValue(undefined),
      discardVerify: vi.fn().mockResolvedValue(undefined),
      runVerb: vi.fn().mockRejectedValue(new Error("refused")),
      listChanges: vi.fn().mockResolvedValue(changeList([BOTH_TICKETS_CHANGE])),
    });
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    await store.getState().confirmArchiveDiscardTicket("verify");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("审查与验证已放弃"),
      expect.anything(),
    );
  });

  it("处置途中工作区分页已关闭：出声而非静默结束", async () => {
    // settleStation 的 dataSource 早退不得静默——其他处置路径此情境都会出声。
    const store = storeWith(fakeDataSource());
    store.getState().requestArchive("desktop-shell-and-browser");
    store.setState({ sessions: {}, activeKey: null });
    await store.getState().confirmArchiveCarryTicket("review");
    expect(store.getState().pendingArchive).toBeNull();
    expect(toastError).toHaveBeenCalled();
  });

  it("「照样带走」封存成功会关闭抽屉，失败则保留 change 上下文", async () => {
    // 三选项的第三条与既有 archive 同为封存终局——抽屉不得停在已封存的 change。
    const archiveCarry = vi.fn().mockResolvedValue(undefined);
    const successStore = storeWith(fakeDataSource({ archiveCarry }));
    await successStore.getState().refresh();
    successStore.getState().openDetail("desktop-shell-and-browser");
    successStore.getState().requestArchive("desktop-shell-and-browser");
    await successStore.getState().confirmArchiveCarryTicket("review");
    expect(archiveCarry).toHaveBeenCalledWith("desktop-shell-and-browser", true, false);
    expect(successStore.getState().pendingArchive).toBeNull();
    expect(successStore.getState().detailChange).toBeNull();

    const failureStore = storeWith(fakeDataSource({
      archiveCarry: vi.fn().mockRejectedValue(new Error("archive refused")),
    }));
    await failureStore.getState().refresh();
    failureStore.getState().openDetail("desktop-shell-and-browser");
    failureStore.getState().requestArchive("desktop-shell-and-browser");
    await failureStore.getState().confirmArchiveCarryTicket("review");
    expect(toastError).toHaveBeenCalled();
    expect(failureStore.getState().detailChange?.name).toBe("desktop-shell-and-browser");
  });

  it("双工单并存时两站分别处置后才封存（旗标一次带齐）", async () => {
    // spec desktop-app Scenario「双工单并存的封存」：处置第一站不封存，两站
    // 都处置完才真的封存，且两个带走旗标一起上路。
    const archiveCarry = vi.fn().mockResolvedValue(undefined);
    const ds = fakeDataSource({
      archiveCarry,
      listChanges: vi.fn().mockResolvedValue(changeList([
        {
          name: "desktop-shell-and-browser",
          status: "in-progress",
          totalTasks: 26,
          completedTasks: 26,
          reviewStatus: "inReview",
          verifyStatus: "inVerify",
        },
      ])),
    });
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().requestArchive("desktop-shell-and-browser");

    await store.getState().confirmArchiveCarryTicket("review");
    expect(archiveCarry).not.toHaveBeenCalled();
    expect(store.getState().pendingArchive).toBe("desktop-shell-and-browser");
    expect(
      openTicketStation(
        store.getState().changes,
        "desktop-shell-and-browser",
        store.getState().pendingArchiveSettled,
      ),
    ).toBe("verify");

    await store.getState().confirmArchiveCarryTicket("verify");
    expect(archiveCarry).toHaveBeenCalledWith("desktop-shell-and-browser", true, true);
    expect(store.getState().pendingArchive).toBeNull();
  });

  it("两站都选「放弃」时不带旗标，走一般封存动词", async () => {
    const discardReview = vi.fn().mockResolvedValue(undefined);
    const discardVerify = vi.fn().mockResolvedValue(undefined);
    const ds = fakeDataSource({
      discardReview,
      discardVerify,
      listChanges: vi.fn().mockResolvedValue(changeList([
        {
          name: "desktop-shell-and-browser",
          status: "in-progress",
          totalTasks: 26,
          completedTasks: 26,
          reviewStatus: "inReview",
          verifyStatus: "inVerify",
        },
      ])),
    });
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    expect(ds.runVerb).not.toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("verify");
    expect(discardReview).toHaveBeenCalledWith("desktop-shell-and-browser");
    expect(discardVerify).toHaveBeenCalledWith("desktop-shell-and-browser");
    expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
  });

  it("放弃工单途中打开抽屉：已送出的处置照常走完封存，不遗失前一站的处置", async () => {
    // 规格「detail 抽屉互斥」收掉的是未送出的确认；工单已删、不可回复，封存不得默默不做。
    const verifyDiscard = deferred<void>();
    const ds = fakeDataSource({
      discardReview: vi.fn().mockResolvedValue(undefined),
      discardVerify: vi.fn().mockReturnValue(verifyDiscard.promise),
      listChanges: vi.fn().mockResolvedValue(changeList([BOTH_TICKETS_CHANGE])),
    });
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().requestArchive("desktop-shell-and-browser");
    await store.getState().confirmArchiveDiscardTicket("review");
    const settling = store.getState().confirmArchiveDiscardTicket("verify");

    store.getState().openDetail("desktop-shell-and-browser");
    verifyDiscard.resolve();
    await settling;

    expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
  });

  it("放弃工单途中封存目标换成别的 change：不改写新目标的守门状态", async () => {
    const reviewDiscard = deferred<void>();
    const ds = fakeDataSource({ discardReview: vi.fn().mockReturnValue(reviewDiscard.promise) });
    const store = storeWith(ds);
    store.getState().requestArchive("desktop-shell-and-browser");
    const settling = store.getState().confirmArchiveDiscardTicket("review");

    store.getState().requestArchive("other-change");
    reviewDiscard.resolve();
    await settling;

    expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
    expect(store.getState()).toMatchObject({
      pendingArchive: "other-change",
      pendingArchiveSettled: { review: false, verify: false },
      pendingArchiveCarry: { review: false, verify: false },
    });
  });

  it("openTicketStation 的顺序固定：审查站在前、验证站在后", () => {
    const both = [
      {
        name: "c",
        status: "in-progress",
        totalTasks: 1,
        completedTasks: 1,
        reviewStatus: "inReview" as const,
        verifyStatus: "inVerify" as const,
      },
    ];
    const none = { review: false, verify: false };
    expect(openTicketStation(both, "c", none)).toBe("review");
    expect(openTicketStation(both, "c", { review: true, verify: false })).toBe("verify");
    expect(openTicketStation(both, "c", { review: true, verify: true })).toBeNull();
    expect(openTicketStation(both, "ghost", none)).toBeNull();
  });

  it("reorderCard passes neighbor ids through and refreshes on success", async () => {
    // design D5：store 动作把 kind/id/prevId/nextId 原样交给 data source，成功后整批 refresh。
    const ds = fakeDataSource();
    const store = storeWith(ds);
    await store.getState().reorderCard("discussion", "slug-a", "prev-s", null);
    expect(ds.reorderCard).toHaveBeenCalledWith("discussion", "slug-a", "prev-s", null);
    expect(ds.listChanges).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("remote reorder 在 server 写回完成前先更新可见卡片顺序", async () => {
    const writing = deferred<void>();
    const listed: ChangeItem[] = [
      { name: "alpha", status: "proposed", totalTasks: 0, completedTasks: 0 },
      { name: "beta", status: "proposed", totalTasks: 0, completedTasks: 0 },
    ];
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList(listed)),
      reorderCard: vi.fn().mockReturnValue(writing.promise),
    });
    const active = remoteSession(ds, "backend");
    const other = remoteSession(fakeDataSource(), "other");
    const store = storeWithRemoteSessions(active, other);
    await store.getState().refresh();

    const saving = store.getState().reorderCard("change", "beta", null, "alpha");

    expect(store.getState().changes.map((change) => change.name)).toEqual(["beta", "alpha"]);
    writing.resolve();
    await saving;
  });

  it("remote reorder 写回失败且 refresh 失败时仍立即还原最后成功顺序", async () => {
    const writing = deferred<void>();
    const listed: ChangeItem[] = [
      { name: "alpha", status: "proposed", totalTasks: 0, completedTasks: 0 },
      { name: "beta", status: "proposed", totalTasks: 0, completedTasks: 0 },
    ];
    const listChanges = vi.fn().mockResolvedValueOnce(changeList(listed)).mockRejectedValue(new Error("offline"));
    const ds = fakeDataSource({ listChanges, reorderCard: vi.fn().mockReturnValue(writing.promise) });
    const active = remoteSession(ds, "backend");
    const other = remoteSession(fakeDataSource(), "other");
    const store = storeWithRemoteSessions(active, other);
    await store.getState().refresh();

    const saving = store.getState().reorderCard("change", "beta", null, "alpha");
    expect(store.getState().changes.map((change) => change.name)).toEqual(["beta", "alpha"]);
    writing.reject(new Error("write failed"));
    await saving;

    expect(store.getState().changes.map((change) => change.name)).toEqual(["alpha", "beta"]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  // 回退 fallback 快照必须是完整的 WorkspaceSnapshot：缺 loadFailed 键的快照
  // 进了 Map，之后的翻页 spread 不会覆盖该字段，前一个 workspace 的失败记号
  // 就漏进来——没失败过的 workspace 显示失败提示。
  it("remote reorder 写回失败的回退快照保留 loadFailed 字段，不受他 workspace 污染", async () => {
    const gate = deferred<ChangeListPayload>();
    const dsA = fakeDataSource({
      listChanges: vi.fn(() => gate.promise),
      reorderCard: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    const dsB = fakeDataSource({
      listChanges: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const a = remoteSession(dsA, "repo-a");
    const b = remoteSession(dsB, "repo-b");
    const store = storeWithRemoteSessions(a, b);

    // A 的首批加载在途（尚无快照）时拖排失败 → 回退走 fallback 字面量。
    void store.getState().refresh();
    const saving = store.getState().reorderCard("change", "alpha", null, null);

    // 翻到 B 且 B 加载失败 → 现任 loadFailed 为 true。
    await store.getState().activateTab(b.id);
    expect(store.getState().loadFailed).toBe(true);

    // 切回 A：A 从未失败过，翻页当下不得显示失败记号。
    const back = store.getState().activateTab(a.id);
    expect(store.getState().loadFailed).toBe(false);

    gate.resolve(changeList([]));
    await Promise.all([saving, back]);
  });

  it("local reorder 维持既有流程，不在数据源写回前改动可见顺序", async () => {
    const writing = deferred<void>();
    const listed: ChangeItem[] = [
      { name: "alpha", status: "proposed", totalTasks: 0, completedTasks: 0 },
      { name: "beta", status: "proposed", totalTasks: 0, completedTasks: 0 },
    ];
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList(listed)),
      reorderCard: vi.fn().mockReturnValue(writing.promise),
    });
    const store = storeWith(ds);
    await store.getState().refresh();

    const saving = store.getState().reorderCard("change", "beta", null, "alpha");

    expect(store.getState().changes.map((change) => change.name)).toEqual(["alpha", "beta"]);
    writing.resolve();
    await saving;
  });

  it("detailSpec 开闭 action 比照 detailChange（spec-archive-drawer design D2）", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    expect(store.getState().detailSpec).toBeNull();
    store.getState().openSpec("desktop-app");
    expect(store.getState().detailSpec).toBe("desktop-app");
    store.getState().closeDetailPage();
    expect(store.getState().detailSpec).toBeNull();
  });

  it("detailArchived 开闭 action：change 与 discussion 两型 discriminated target", () => {
    const store = storeWith(fakeDataSource());
    expect(store.getState().detailArchived).toBeNull();
    store.getState().openArchived({ kind: "change", datedName: "2026-07-04-x" });
    expect(store.getState().detailArchived).toEqual({ kind: "change", datedName: "2026-07-04-x" });
    store.getState().openArchived({ kind: "discussion", slug: "old-topic" });
    expect(store.getState().detailArchived).toEqual({ kind: "discussion", slug: "old-topic" });
    store.getState().closeDetailPage();
    expect(store.getState().detailArchived).toBeNull();
  });

  it("detail 抽屉互斥：任一 open* 动作清除其他三个 detail 字段（后开者取代先开者）", async () => {
    // 规格「detail 抽屉互斥」Example 表：讨论→变更详情→规格→封存→讨论。
    const ds = withTopicA();
    const store = storeWith(ds);
    await store.getState().refresh();

    store.getState().openDiscussion("topic-a");
    expect(store.getState().detailDiscussion?.slug).toBe("topic-a");
    store.getState().openDetail("desktop-shell-and-browser");
    expect(store.getState().detailChange?.name).toBe("desktop-shell-and-browser");
    expect(store.getState().detailDiscussion).toBeNull();

    store.getState().openSpec("desktop-app");
    expect(store.getState().detailSpec).toBe("desktop-app");
    expect(store.getState().detailChange).toBeNull();

    store.getState().openArchived({ kind: "change", datedName: "2026-07-04-x" });
    expect(store.getState().detailArchived).toEqual({ kind: "change", datedName: "2026-07-04-x" });
    expect(store.getState().detailSpec).toBeNull();

    store.getState().openDiscussion("topic-a");
    expect(store.getState().detailDiscussion?.slug).toBe("topic-a");
    expect(store.getState().detailArchived).toBeNull();
  });

  it("切换主区页面先关闭变更／讨论详情页（连同分析结果）", async () => {
    const store = storeWith(withTopicA());
    await store.getState().refresh();
    store.getState().openDetail("desktop-shell-and-browser");
    store.setState({ detailVerb: { change: "desktop-shell-and-browser" } as never });
    store.getState().setBoardView("specs");
    expect(store.getState().boardView).toBe("specs");
    expect(store.getState().detailChange).toBeNull();
    expect(store.getState().detailVerb).toBeNull();

    store.getState().openDiscussion("topic-a");
    store.getState().setBoardView("settings");
    expect(store.getState().boardView).toBe("settings");
    expect(store.getState().detailDiscussion).toBeNull();
  });

  it("重新登录（openConnectionReauth）切到设置页时同样先关闭详情页、聚焦该连接", async () => {
    // 连接失效横幅在主区外，详情页开着时仍点得到——不关页设置页就被详情页盖住。
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    store.getState().openSpec("desktop-app");
    store.getState().openConnectionReauth("c1");
    expect(store.getState().boardView).toBe("settings");
    expect(store.getState().detailSpec).toBeNull();
    expect(store.getState().reauthConnectionId).toBe("c1");
  });

  it("详情页互斥：取代变更详情页时 detailVerb 一并清空（比照 closeDetailPage）", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    store.getState().openDetail("desktop-shell-and-browser");
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    expect(store.getState().detailVerb).not.toBeNull();
    store.getState().openSpec("desktop-app");
    expect(store.getState().detailChange).toBeNull();
    expect(store.getState().detailVerb).toBeNull();
  });

  it("closeDetailPage 一次清空四个详情字段与 detailVerb（Esc、面包屑共用）", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    store.getState().openDetail("desktop-shell-and-browser");
    await store.getState().runVerb("analyze", "desktop-shell-and-browser");
    // 四个字段互斥，平常只有一个非 null；直接灌入全部非 null 以验一次清空。
    store.setState({
      detailDiscussion: store.getState().discussions.active[0] ?? null,
      detailSpec: "desktop-app",
      detailArchived: { kind: "change", datedName: "2026-07-04-x" },
    });
    expect(store.getState().detailChange).not.toBeNull();
    expect(store.getState().detailVerb).not.toBeNull();
    store.getState().closeDetailPage();
    const st = store.getState();
    expect([st.detailChange, st.detailDiscussion, st.detailSpec, st.detailArchived, st.detailVerb]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    // 宿主页不变：关页只拿掉页层。
    expect(st.boardView).toBe("board");
  });

  it("openDetail 于已封存页把底层页面切回看板（规格「变更与讨论详情页的宿主为看板」）", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();
    store.getState().setBoardView("archived");

    store.getState().openDetail("desktop-shell-and-browser");

    expect(store.getState().boardView).toBe("board");
    expect(store.getState().detailChange?.name).toBe("desktop-shell-and-browser");
  });

  it("openDiscussion 于规格页把底层页面切回看板", async () => {
    const ds = withTopicA();
    const store = storeWith(ds);
    await store.getState().refresh();
    store.getState().setBoardView("specs");

    store.getState().openDiscussion("topic-a");

    expect(store.getState().boardView).toBe("board");
    expect(store.getState().detailDiscussion?.slug).toBe("topic-a");
  });

  it("openSpec 与 openArchived 不切页——宿主页面即规格页与已封存页", async () => {
    const store = storeWith(fakeDataSource());
    await store.getState().refresh();

    store.getState().setBoardView("specs");
    store.getState().openSpec("desktop-app");
    expect(store.getState().boardView).toBe("specs");

    store.getState().setBoardView("archived");
    store.getState().openArchived({ kind: "change", datedName: "2026-07-04-x" });
    expect(store.getState().boardView).toBe("archived");
  });

  // 规格「detail 抽屉互斥」：变更详情与讨论抽屉的打开动作同时收掉可取消浮层，
  // 语意等同按「取消」——浮层字段归零，封存守门的站别处置一并还原。
  const OPENERS: [string, (s: AppState) => void, (s: AppState) => boolean][] = [
    [
      "openDetail",
      (s) => s.openDetail("desktop-shell-and-browser"),
      (s) => s.detailChange?.name === "desktop-shell-and-browser",
    ],
    ["openDiscussion", (s) => s.openDiscussion("topic-a"), (s) => s.detailDiscussion?.slug === "topic-a"],
    // 路线图网址（desktop-roadmap）与开详情的网址一样收掉可取消浮层。
    ["openRoadmap", (s) => s.openRoadmap(), (s) => s.boardMode === "roadmap"],
    // 项目网址（desktop-app）同样收掉可取消浮层，并固定回到卡片查看。
    ["openBoard", (s) => s.openBoard(), (s) => s.boardMode === "cards" && s.detailChange === null],
  ];
  describe.each(OPENERS)("open 动作清除可取消浮层：%s", (_name, open, drawerOpen) => {
    it.each<[string, Partial<AppState>]>([
      ["添加项目", { workspaceChooser: {} }],
      ["初始化确认", { pendingInit: "/tmp/new-project" }],
      ["激活确认", { pendingAdopt: "/tmp/old-project" }],
      ["封存确认", { pendingArchive: "desktop-shell-and-browser" }],
      [
        "工单三选项框（已处置一站并选带走）",
        {
          pendingArchive: "desktop-shell-and-browser",
          pendingArchiveSettled: { review: true, verify: false },
          pendingArchiveCarry: { review: true, verify: false },
        },
      ],
      ["封存讨论确认", { pendingArchiveDiscussion: "topic-a" }],
      ["删除确认", { pendingDelete: "desktop-shell-and-browser" }],
      ["退回提案中确认", { pendingRevert: "desktop-shell-and-browser" }],
      [
        "退回被挡说明",
        { revertBlocked: { change: "desktop-shell-and-browser", checkedTasks: 2, touchedFiles: ["a.rs"] } },
      ],
    ])("%s", async (_overlay, overlay) => {
      const ds = withTopicA({ discardReview: vi.fn(), discardVerify: vi.fn() });
      const store = storeWith(ds);
      await store.getState().refresh();
      store.getState().setBoardView("specs");
      store.setState(overlay);
      const activeKey = store.getState().activeKey;

      open(store.getState());

      const s = store.getState();
      expect(drawerOpen(s)).toBe(true);
      expect(s).toMatchObject({
        boardView: "board",
        activeKey,
        workspaceChooser: null,
        pendingInit: null,
        pendingAdopt: null,
        pendingArchive: null,
        pendingArchiveSettled: { review: false, verify: false },
        pendingArchiveCarry: { review: false, verify: false },
        pendingArchiveDiscussion: null,
        pendingDelete: null,
        pendingRevert: null,
        revertBlocked: null,
      });
      // 收掉等同按取消：没有任何未确认的动作被送出（无封存、无删除、工单维持未结）。
      for (const write of [ds.runVerb, ds.deleteChange, ds.archiveDiscussion, ds.discardReview, ds.discardVerify]) {
        expect(write).not.toHaveBeenCalled();
      }
    });
  });

  // 迁移与远程冲突不可取消：打开动作静默 no-op，连 set 都不调用（state 参考不变）。
  describe.each(OPENERS)("不可取消浮层打开中 open 动作不改状态：%s", (_name, open) => {
    it.each<[string, Partial<AppState>]>([
      ["迁移对话框", { migrationRoot: "/tmp/migrating" }],
      ["远程冲突对话框", { pendingRemoteConflict: { path: "/tmp/x", url: "https://example.test", repo: null } }],
    ])("%s", async (_overlay, overlay) => {
      const store = storeWith(withTopicA());
      await store.getState().refresh();
      store.getState().setBoardView("specs");
      store.setState(overlay);
      const before = store.getState();

      open(before);

      expect(store.getState()).toBe(before);
      expect(store.getState().boardView).toBe("specs");
    });
  });
});

// ---- 系统匣样式由平台决定（tray-panel-windows：规格「系统匣图标与原生菜单」平台分流） ----

describe("系统匣样式由平台决定", () => {
  const setUA = (value: string) =>
    Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
  const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64)";

  it("macOS 与 Windows 初值为 panel、Linux 为 native-menu，且不读 localStorage 旧偏好", () => {
    localStorage.setItem("specseal.trayStyle", "native-menu"); // 旧偏好残留：不再被读取
    setUA(MAC_UA);
    expect(storeWith(fakeDataSource()).getState().trayStyle).toBe("panel");
    setUA(WIN_UA);
    expect(storeWith(fakeDataSource()).getState().trayStyle).toBe("panel");
    setUA(LINUX_UA);
    expect(storeWith(fakeDataSource()).getState().trayStyle).toBe("native-menu");
    localStorage.removeItem("specseal.trayStyle");
  });

  it("panelFallback 退回 native-menu、浮出单行错误，且不写 localStorage（规格「面板样式」失败退回）", () => {
    setUA(MAC_UA);
    const store = storeWith(fakeDataSource());
    store.getState().panelFallback("tray panel window creation failed: boom");
    expect(store.getState().trayStyle).toBe("native-menu");
    expect(store.getState().trayPanelError).toBe("tray panel window creation failed: boom");
    expect(localStorage.getItem("specseal.trayStyle")).toBeNull();
  });
});

// --- 登录阶段（client-browser-login D7、D9）：等待的循环在 Rust，store 只把送来
// 的阶段放进 ConnectionPhase、依终态收场；轮询、间隔与逾时都不在前端。 ---

describe("登录阶段", () => {
  const ORIGIN = "http://localhost:8080";
  const APPROVAL: LoginPhase = {
    kind: "awaitingApproval",
    userCode: "ABCD-EFGH",
    verificationUri: "http://localhost:8080/activate",
    expiresAt: Date.now() + 900_000,
  };
  const BROWSER: LoginPhase = {
    kind: "awaitingBrowser",
    url: "https://id.example.com/authorize?state=s1&code_challenge=c1&code_challenge_method=S256",
    expiresAt: Date.now() + 300_000,
  };

  /** 可控的登录：测试决定何时送阶段、何时结束。 */
  function controlledLogin() {
    let onPhase: (phase: LoginPhase) => void = () => {};
    let resolve: (result: LoginResult) => void = () => {};
    const loginStart = vi.fn(
      (_origin: string, listener: (phase: LoginPhase) => void) =>
        new Promise<LoginResult>((r) => {
          onPhase = listener;
          resolve = r;
        }),
    );
    return {
      loginStart,
      phase: (phase: LoginPhase) => onPhase(phase),
      finish: (result: LoginResult) => resolve(result),
    };
  }

  function fakeConnections(over: Partial<ConnectionsAdapter> = {}): ConnectionsAdapter {
    return {
      list: vi.fn().mockResolvedValue([{ id: "conn_1", origin: ORIGIN, name: "本地", loggedIn: false }]),
      add: vi.fn(),
      remove: vi.fn(),
      loginStart: vi.fn(),
      loginCancel: vi.fn().mockResolvedValue(undefined),
      patLogin: vi.fn(),
      logout: vi.fn(),
      scopes: vi.fn().mockResolvedValue({ projects: [] }),
      inspectCheckout: vi.fn(),
      bindCheckout: vi.fn(),
      ...over,
    };
  }

  function storeWithConnections(adapter: ConnectionsAdapter) {
    return trackedAppStore({
      createSession: () => ({}) as WorkspaceSession,
      connections: adapter,
    });
  }

  it("收到的阶段原样成为连接的交互状态", async () => {
    const login = controlledLogin();
    const store = storeWithConnections(fakeConnections({ loginStart: login.loginStart }));
    const done = store.getState().loginConnection(ORIGIN);

    expect(store.getState().connectionPhases[ORIGIN]).toEqual({ kind: "busy" });
    login.phase(APPROVAL);
    expect(store.getState().connectionPhases[ORIGIN]).toEqual(APPROVAL);
    login.phase(BROWSER);
    expect(store.getState().connectionPhases[ORIGIN]).toEqual(BROWSER);
    login.finish({ status: "cancelled" });
    await done;
  });

  it("登录成功即重整清单并回到 idle", async () => {
    const login = controlledLogin();
    const adapter = fakeConnections({ loginStart: login.loginStart });
    const store = storeWithConnections(adapter);
    const done = store.getState().loginConnection(ORIGIN);
    login.phase(BROWSER);
    login.finish({ status: "loggedIn", display: "Dev" });
    await done;

    expect(store.getState().connectionPhases[ORIGIN]).toEqual({ kind: "idle" });
    expect(adapter.list).toHaveBeenCalled();
  });

  it("需要访问密钥即就地收 PAT", async () => {
    const store = storeWithConnections(
      fakeConnections({ loginStart: vi.fn().mockResolvedValue({ status: "patRequired" }) }),
    );
    await store.getState().loginConnection(ORIGIN);

    expect(store.getState().connectionPhases[ORIGIN]).toEqual({ kind: "patInput", error: null });
  });

  it("拒绝与逾时各自浮为可读状态，浏览器登录与设备核准的说法不同", async () => {
    for (const [phase, method, status, message] of [
      [APPROVAL, "device", "denied", "已在浏览器拒绝授权"],
      [APPROVAL, "device", "expired", "授权逾时"],
      [BROWSER, "browser", "denied", "已在登录服务拒绝登录"],
      [BROWSER, "browser", "expired", "浏览器登录逾时"],
    ] as const) {
      const login = controlledLogin();
      const store = storeWithConnections(fakeConnections({ loginStart: login.loginStart }));
      const done = store.getState().loginConnection(ORIGIN);
      login.phase(phase);
      login.finish({ status, method });
      await done;

      const current = store.getState().connectionPhases[ORIGIN];
      expect(current.kind).toBe("error");
      expect(current.kind === "error" && current.message).toContain(message);
    }
  });

  it("连接错误浮为错误状态，不进 PAT 输入", async () => {
    const store = storeWithConnections(
      fakeConnections({ loginStart: vi.fn().mockRejectedValue("server unavailable — check the connection url") }),
    );
    await store.getState().loginConnection(ORIGIN);

    expect(store.getState().connectionPhases[ORIGIN]).toEqual({
      kind: "error",
      message: "server unavailable — check the connection url",
    });
  });

  it("取消即调用取消并回未登录；之后送来的阶段与结果都作废", async () => {
    const login = controlledLogin();
    const adapter = fakeConnections({ loginStart: login.loginStart });
    const store = storeWithConnections(adapter);
    const done = store.getState().loginConnection(ORIGIN);
    login.phase(BROWSER);

    store.getState().cancelLogin(ORIGIN);
    expect(adapter.loginCancel).toHaveBeenCalledWith(ORIGIN);
    expect(store.getState().connectionPhases[ORIGIN]).toEqual({ kind: "idle" });

    login.phase(APPROVAL);
    login.finish({ status: "denied", method: "device" });
    await done;
    expect(store.getState().connectionPhases[ORIGIN]).toEqual({ kind: "idle" });
  });

  it("重按登录＝重来一次：前一轮的结果不得盖掉新一轮", async () => {
    const first = controlledLogin();
    const second = controlledLogin();
    const loginStart = vi.fn().mockImplementationOnce(first.loginStart).mockImplementationOnce(second.loginStart);
    const store = storeWithConnections(fakeConnections({ loginStart }));
    const firstDone = store.getState().loginConnection(ORIGIN);
    const secondDone = store.getState().loginConnection(ORIGIN);
    second.phase(APPROVAL);

    first.finish({ status: "cancelled" });
    await firstDone;
    expect(store.getState().connectionPhases[ORIGIN]).toEqual(APPROVAL);
    second.finish({ status: "cancelled" });
    await secondDone;
  });
});

// --- 指令档过期提示（desktop-instruction-staleness-prompt；规格「指令档过期提示」） ---

const MISSING_PROBE = {
  ...STALE_PROBE,
  status: "missing" as const,
  tools: [{ tool: "claude", workspaceVersion: null, stale: false, newer: false, missing: true }],
};

/** 项目文档领先引擎：app 本体是旧版，任何改写动作都不该被提供。 */
const NEWER_PROBE = {
  ...STALE_PROBE,
  status: "newer" as const,
  tools: [{ tool: "claude", workspaceVersion: "v1.4.0", stale: false, newer: true, missing: false }],
};

function fakeInstructionWorkspace(over: Partial<WorkspaceAdapter> = {}) {
  return {
    openProject: vi.fn().mockResolvedValue({ status: "project", root: "A", name: "a" }),
    initProject: vi.fn(),
    adoptProject: vi.fn(),
    startupDir: vi.fn().mockRejectedValue("none"),
    projectStats: vi.fn().mockResolvedValue({ pendingWrapUp: 0 }),
    probeAssets: vi.fn().mockResolvedValue(STALE_PROBE),
    updateAssets: vi.fn().mockResolvedValue({ migrated: { movedFolder: false, renamed: 0 } }),
    watchWorkspace: vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
    ...over,
  } as unknown as WorkspaceAdapter;
}

/** 以单一 local session 预置 store 并注入 workspace 探测面。 */
function storeWithAssetProbe(ws: WorkspaceAdapter, ds = fakeDataSource()) {
  const store = trackedAppStore({
    createSession: (root, name) => fakeSession(ds, root, name),
    workspace: ws,
  });
  const session = fakeSession(ds);
  store.setState({
    tabs: [{ locator: session.locator, name: session.descriptor.name }],
    sessions: { [session.id]: session },
    activeKey: session.id,
  });
  return store;
}

describe("监看重挂（rearmWatch）", () => {
  // worktree 增减会改变监看拓扑（副本 change 目录、.git/worktrees 登记簿）；
  // workspace-changed 后由前端顺手重挂，Rust 端目标集合不变时沿用原监看。
  it("活跃 local session → 对其 root 重挂监看", async () => {
    const ws = fakeInstructionWorkspace();
    const store = storeWithAssetProbe(ws);
    await store.getState().rearmWatch();
    expect(ws.watchWorkspace).toHaveBeenCalledWith("A");
  });

  it("无活跃 session → 不动", async () => {
    const ws = fakeInstructionWorkspace();
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(fakeDataSource(), root, name),
      workspace: ws,
    });
    await store.getState().rearmWatch();
    expect(ws.watchWorkspace).not.toHaveBeenCalled();
  });

  it("活跃 session 非 local → 不动", async () => {
    const ws = fakeInstructionWorkspace();
    const store = storeWithAssetProbe(ws);
    const remote = {
      ...fakeSession(fakeDataSource(), "R", "r"),
      id: "remote:R",
      locator: { kind: "remote", server: "s", projectKey: "p", repoKey: "r" },
    } as unknown as WorkspaceSession;
    store.setState({ sessions: { [remote.id]: remote }, activeKey: remote.id });
    await store.getState().rearmWatch();
    expect(ws.watchWorkspace).not.toHaveBeenCalled();
  });
});

describe("指令档过期提示的显示裁决", () => {
  beforeEach(() => {
    localStorage.removeItem("specseal.assetSkips");
  });

  it("过期且未略过：以更新语意提示并带差异档数", async () => {
    const store = storeWithAssetProbe(fakeInstructionWorkspace());
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toEqual({
      kind: "stale",
      fileCount: 2,
      version: "v1.3.0",
      projectVersion: "v0.9.0",
      migration: { state: "none" },
    });
  });

  it("缺失且未略过：以安装语意提示", async () => {
    const store = storeWithAssetProbe(
      fakeInstructionWorkspace({ probeAssets: vi.fn().mockResolvedValue(MISSING_PROBE) }),
    );
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.kind).toBe("missing");
    // 从未安装：tools 全无标记版号，确认框第一列显示「—」的依据。
    expect(selectAssetPrompt(store.getState())?.projectVersion).toBeNull();
  });

  it("保留现状后同版不再提示，且不写入项目内任何文档", async () => {
    const ws = fakeInstructionWorkspace();
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();
    store.getState().dismissAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();

    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(ws.updateAssets).not.toHaveBeenCalled();
  });

  it("领先引擎且未略过：以较新语意提示并带差异档数", async () => {
    const store = storeWithAssetProbe(
      fakeInstructionWorkspace({ probeAssets: vi.fn().mockResolvedValue(NEWER_PROBE) }),
    );
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toEqual({
      kind: "newer",
      fileCount: 2,
      version: "v1.3.0",
      projectVersion: "v1.4.0",
      migration: { state: "none" },
    });
  });

  it("较新态的保留现状与过期共用同一略过记忆", async () => {
    const store = storeWithAssetProbe(
      fakeInstructionWorkspace({ probeAssets: vi.fn().mockResolvedValue(NEWER_PROBE) }),
    );
    await store.getState().refreshAssetPrompt();
    store.getState().dismissAssetPrompt();
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  it("缺失态的保留现状与过期共用同一略过记忆", async () => {
    const store = storeWithAssetProbe(
      fakeInstructionWorkspace({ probeAssets: vi.fn().mockResolvedValue(MISSING_PROBE) }),
    );
    await store.getState().refreshAssetPrompt();
    store.getState().dismissAssetPrompt();
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  it("已略过旧版、产物层版号变动后重新提示", async () => {
    const probe = vi.fn().mockResolvedValue(STALE_PROBE);
    const store = storeWithAssetProbe(fakeInstructionWorkspace({ probeAssets: probe }));
    await store.getState().refreshAssetPrompt();
    store.getState().dismissAssetPrompt();

    probe.mockResolvedValue({ ...STALE_PROBE, currentVersion: "v1.4.0" });
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.version).toBe("v1.4.0");
  });

  it("无法判定：不提示且不记入略过（后续判过期仍提示）", async () => {
    const probe = vi.fn().mockResolvedValue({
      status: "unknown",
      currentVersion: "v1.3.0",
      tools: [],
      differingFiles: [],
    });
    const store = storeWithAssetProbe(fakeInstructionWorkspace({ probeAssets: probe }));
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(localStorage.getItem("specseal.assetSkips")).toBeNull();

    probe.mockResolvedValue(STALE_PROBE);
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.kind).toBe("stale");
  });

  it("现版：不提示", async () => {
    const store = storeWithAssetProbe(
      fakeInstructionWorkspace({
        probeAssets: vi.fn().mockResolvedValue({
          status: "current",
          currentVersion: "v1.3.0",
          tools: [],
          differingFiles: [],
          migration: { state: "none" as const },
        }),
      }),
    );
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  it("没有 checkout 的 remote 分页不运行探测", async () => {
    const ws = fakeInstructionWorkspace();
    const ds = fakeDataSource();
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("remote 分页不建 local session");
      },
      workspace: ws,
    });
    const remote = remoteSession(ds, "repo-a");
    store.setState({
      tabs: [{ locator: remote.locator, name: remote.descriptor.name }],
      sessions: { [remote.id]: remote },
      activeKey: remote.id,
    });

    await store.getState().refreshAssetPrompt();
    expect(ws.probeAssets).not.toHaveBeenCalled();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  it("更新成功：整套再生后重查，提示消失", async () => {
    const probe = vi.fn().mockResolvedValue(STALE_PROBE);
    const ws = fakeInstructionWorkspace({ probeAssets: probe });
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();

    probe.mockResolvedValue({
      status: "current",
      currentVersion: "v1.3.0",
      tools: [],
      differingFiles: [],
      migration: { state: "none" as const },
    });
    await store.getState().applyAssetUpdate();

    expect(ws.updateAssets).toHaveBeenCalledWith("A");
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(store.getState().assetUpdateError).toBeNull();
  });

  it("更新失败：错误留在提示原位、提示保持可重试", async () => {
    const ws = fakeInstructionWorkspace({
      updateAssets: vi.fn().mockRejectedValue("CLAUDE.md: permission denied"),
    });
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();
    await store.getState().applyAssetUpdate();

    expect(store.getState().assetUpdateError).toContain("permission denied");
    expect(selectAssetPrompt(store.getState())).not.toBeNull();
  });

  it("外部 specseal update 后（workspace-changed 重查）提示自然消失", async () => {
    const probe = vi.fn().mockResolvedValue(STALE_PROBE);
    const store = storeWithAssetProbe(fakeInstructionWorkspace({ probeAssets: probe }));
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).not.toBeNull();

    // 用户于终端跑 specseal update：受管档成为现版，重查即收合。
    probe.mockResolvedValue({
      status: "current",
      currentVersion: "v1.3.0",
      tools: [],
      differingFiles: [],
      migration: { state: "none" as const },
    });
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  // --- 多分页记忆（desktop-notice-relocation design D1）：探测结果以 locator key 为键
  // 保留，assetPrompt 是作用中分页的派生值；背景分页的值供图标列琥珀点用。 ---

  const CURRENT_PROBE = {
    status: "current" as const,
    currentVersion: "v1.3.0",
    tools: [],
    differingFiles: [],
    migration: { state: "none" as const },
  };

  /** 两个本地分页 A（作用中）与 B，共用同一个 workspace 探测面。 */
  function storeWithTwoLocalTabs(ws: WorkspaceAdapter) {
    const ds = fakeDataSource();
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a, [b.id]: b },
      activeKey: a.id,
    });
    return store;
  }

  it("探测后以 locator key 记下结果；projectVersion 取 tools 第一个非 null 的标记版号", async () => {
    const store = storeWithAssetProbe(fakeInstructionWorkspace());
    await store.getState().refreshAssetPrompt();
    expect(store.getState().assetPrompts["local:A"]).toEqual({
      kind: "stale",
      fileCount: 2,
      version: "v1.3.0",
      projectVersion: "v0.9.0",
      migration: { state: "none" },
    });
    expect(selectAssetPrompt(store.getState())).toEqual(store.getState().assetPrompts["local:A"]);
  });

  it("切到另一分页后原分页的探测结果保留；作用中提示改为新分页的值", async () => {
    const probe = vi
      .fn()
      .mockImplementation((root: string) => Promise.resolve(root === "A" ? STALE_PROBE : CURRENT_PROBE));
    const store = storeWithTwoLocalTabs(fakeInstructionWorkspace({ probeAssets: probe }));
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.kind).toBe("stale");

    store.setState({ activeKey: "local:B" });
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(store.getState().assetPrompts["local:B"]).toBeNull();
    expect(store.getState().assetPrompts["local:A"]?.kind).toBe("stale");
  });

  it("保留现状只清作用中分页的记忆，背景分页的值不受影响", async () => {
    const store = storeWithTwoLocalTabs(fakeInstructionWorkspace());
    await store.getState().refreshAssetPrompt();
    store.setState({ activeKey: "local:B" });
    await store.getState().refreshAssetPrompt();
    expect(store.getState().assetPrompts["local:B"]?.kind).toBe("stale");

    store.getState().dismissAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(store.getState().assetPrompts["local:B"]).toBeNull();
    expect(store.getState().assetPrompts["local:A"]?.kind).toBe("stale");
    // 略过记忆以项目路径为键：只记 B，A 下次探测照样提示。
    expect(JSON.parse(localStorage.getItem("specseal.instructionSkips") ?? "{}")).toEqual({
      B: "v1.3.0",
    });
  });

  it("套用途中切走分页：完成后重探套用的那个分页，它的提示收合、另一分页的记忆不受影响", async () => {
    const update = deferred<{ migrated: { movedFolder: boolean; renamed: number } }>();
    const probe = vi.fn().mockResolvedValue(STALE_PROBE);
    const ws = fakeInstructionWorkspace({ probeAssets: probe, updateAssets: vi.fn(() => update.promise) });
    const store = storeWithTwoLocalTabs(ws);
    await store.getState().refreshAssetPrompt();
    store.setState({ activeKey: "local:B" });
    await store.getState().refreshAssetPrompt();
    store.setState({ activeKey: "local:A" });

    const applying = store.getState().applyAssetUpdate();
    store.setState({ activeKey: "local:B" });
    probe.mockImplementation((root: string) => Promise.resolve(root === "A" ? CURRENT_PROBE : STALE_PROBE));
    update.resolve({ migrated: { movedFolder: false, renamed: 0 } });
    await applying;

    expect(ws.updateAssets).toHaveBeenCalledWith("A");
    expect(probe).toHaveBeenLastCalledWith("A");
    expect(store.getState().assetPrompts["local:A"]).toBeNull();
    expect(store.getState().assetPrompts["local:B"]?.kind).toBe("stale");
    expect(selectAssetPrompt(store.getState())?.kind).toBe("stale");
  });

  it("projectVersion 依状态挑工具：较新取领先的工具、过期取落后的工具、缺失为 null", () => {
    const tool = (name: string, version: string | null, flags: { stale?: boolean; newer?: boolean; missing?: boolean }) => ({
      tool: name,
      workspaceVersion: version,
      stale: flags.stale ?? false,
      newer: flags.newer ?? false,
      missing: flags.missing ?? false,
    });
    const newer = assetPrompt(
      { ...STALE_PROBE, status: "newer", tools: [tool("claude", "v0.9.0", { stale: true }), tool("codex", "v1.4.0", { newer: true })] },
      "A",
      {},
    );
    expect(newer?.projectVersion).toBe("v1.4.0");
    const stale = assetPrompt(
      { ...STALE_PROBE, status: "stale", tools: [tool("codex", "v1.3.0", {}), tool("claude", "v0.9.0", { stale: true })] },
      "A",
      {},
    );
    expect(stale?.projectVersion).toBe("v0.9.0");
    const missing = assetPrompt(
      { ...STALE_PROBE, status: "missing", tools: [tool("claude", "v1.3.0", {}), tool("codex", null, { missing: true })] },
      "A",
      {},
    );
    expect(missing?.projectVersion).toBeNull();
  });
});

// --- remote 项目的技能档提示：基准是 Server 提供的技能（remote-skill-delivery D6） ---

describe("remote 项目的技能档提示", () => {
  const SKIPS = "specseal.instructionSkips";
  const CURRENT = { ...REMOTE_STALE_PROBE, status: "current" as const, differingFiles: [] };

  beforeEach(() => {
    localStorage.removeItem(SKIPS);
  });

  function remoteWorkspace(over: Partial<WorkspaceAdapter> = {}) {
    return fakeInstructionWorkspace({
      probeRemoteAssets: vi.fn().mockResolvedValue(REMOTE_STALE_PROBE),
      updateRemoteAssets: vi.fn().mockResolvedValue({ migrated: { movedFolder: false, renamed: 0 } }),
      ...over,
    });
  }

  /** 有 checkout 的 remote 分页（remote:c1/demo/backend）为作用中的 store。 */
  function storeWithRemoteCheckout(ws: WorkspaceAdapter) {
    const locator = {
      kind: "remote" as const,
      connectionId: "c1",
      projectId: "demo",
      repoId: "backend",
      checkoutRoot: "/work/demo",
    };
    const remote: WorkspaceSession = { ...remoteSession(fakeDataSource(), "backend"), locator };
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("remote 分页不建 local session");
      },
      workspace: ws,
    });
    store.setState({
      tabs: [{ locator: remote.locator, name: remote.descriptor.name }],
      sessions: { [remote.id]: remote },
      activeKey: remote.id,
    });
    return store;
  }

  it("有 checkout：向 Server 探测，和 Server 不同时提示", async () => {
    const ws = remoteWorkspace();
    const store = storeWithRemoteCheckout(ws);
    await store.getState().refreshAssetPrompt();
    expect(ws.probeRemoteAssets).toHaveBeenCalledWith(REMOTE_CHECKOUT);
    expect(ws.probeAssets).not.toHaveBeenCalled();
    expect(selectAssetPrompt(store.getState())).toEqual({
      kind: "stale",
      fileCount: 1,
      version: "v1.58.0",
      projectVersion: "v1.56.0",
      migration: { state: "none" },
      server: { appVersion: "v1.57.0", appOlder: false },
    });
  });

  it("Server 没有提供技能：没有提示，也没有略过被记下", async () => {
    const store = storeWithRemoteCheckout(remoteWorkspace({ probeRemoteAssets: vi.fn().mockResolvedValue(null) }));
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    store.getState().dismissAssetPrompt();
    expect(localStorage.getItem(SKIPS)).toBeNull();
  });

  it("探测失败（连不上）：没有提示、没有略过；连接恢复后下一次探测照常", async () => {
    const probe = vi.fn().mockRejectedValue("server unreachable");
    const store = storeWithRemoteCheckout(remoteWorkspace({ probeRemoteAssets: probe }));
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(localStorage.getItem(SKIPS)).toBeNull();

    probe.mockResolvedValue(REMOTE_STALE_PROBE);
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.kind).toBe("stale");
  });

  it("更新：向 Server 取技能写进 checkout，重查后提示消失", async () => {
    const probe = vi.fn().mockResolvedValue(REMOTE_STALE_PROBE);
    const ws = remoteWorkspace({ probeRemoteAssets: probe });
    const store = storeWithRemoteCheckout(ws);
    await store.getState().refreshAssetPrompt();

    probe.mockResolvedValue(CURRENT);
    await store.getState().applyAssetUpdate();
    expect(ws.updateRemoteAssets).toHaveBeenCalledWith(REMOTE_CHECKOUT);
    expect(ws.updateAssets).not.toHaveBeenCalled();
    expect(selectAssetPrompt(store.getState())).toBeNull();
    expect(store.getState().assetUpdateError).toBeNull();
    expect(store.getState().assetMigrated).toBeNull();
  });

  it("更新失败：错误留在提示原位、可重试", async () => {
    const ws = remoteWorkspace({ updateRemoteAssets: vi.fn().mockRejectedValue("server unavailable") });
    const store = storeWithRemoteCheckout(ws);
    await store.getState().refreshAssetPrompt();
    await store.getState().applyAssetUpdate();
    expect(store.getState().assetUpdateError).toContain("server unavailable");
    expect(store.getState().assetUpdating).toBe(false);
    expect(selectAssetPrompt(store.getState())?.kind).toBe("stale");
  });

  // design D8：有 checkout 的 remote 分页监看 checkout 的技能档，不监看规格文档夹。
  it("监看重挂：有 checkout 的 remote 分页挂 checkout 的监看，不挂本机的监看", async () => {
    const ws = remoteWorkspace({ watchCheckoutSkills: vi.fn().mockResolvedValue(undefined) });
    const store = storeWithRemoteCheckout(ws);
    await store.getState().rearmWatch();
    expect(ws.watchCheckoutSkills).toHaveBeenCalledWith("/work/demo");
    expect(ws.watchWorkspace).not.toHaveBeenCalled();
  });

  it("监看重挂：checkout 的监看挂不上时不抛错（降级为没有自动重新探测）", async () => {
    const ws = remoteWorkspace({ watchCheckoutSkills: vi.fn().mockRejectedValue("watch unavailable") });
    const store = storeWithRemoteCheckout(ws);
    await expect(store.getState().rearmWatch()).resolves.toBeUndefined();
  });

  it("监看重挂：没有 checkout 的 remote 分页什幺都不挂", async () => {
    const ws = remoteWorkspace({ watchCheckoutSkills: vi.fn().mockResolvedValue(undefined) });
    const remote = remoteSession(fakeDataSource(), "backend");
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("remote 分页不建 local session");
      },
      workspace: ws,
    });
    store.setState({
      tabs: [{ locator: remote.locator, name: remote.descriptor.name }],
      sessions: { [remote.id]: remote },
      activeKey: remote.id,
    });
    await store.getState().rearmWatch();
    expect(ws.watchCheckoutSkills).not.toHaveBeenCalled();
    expect(ws.watchWorkspace).not.toHaveBeenCalled();
  });

  it("保留现状：以项目与 Server 的版本记下；同一版不再提示，Server 换版后再出现", async () => {
    const probe = vi.fn().mockResolvedValue(REMOTE_STALE_PROBE);
    const store = storeWithRemoteCheckout(remoteWorkspace({ probeRemoteAssets: probe }));
    await store.getState().refreshAssetPrompt();
    store.getState().dismissAssetPrompt();
    expect(JSON.parse(localStorage.getItem(SKIPS) ?? "{}")).toEqual({ "remote:c1/demo/backend": "v1.58.0" });
    expect(selectAssetPrompt(store.getState())).toBeNull();

    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())).toBeNull();

    probe.mockResolvedValue({ ...REMOTE_STALE_PROBE, serverVersion: "v1.59.0" });
    await store.getState().refreshAssetPrompt();
    expect(selectAssetPrompt(store.getState())?.version).toBe("v1.59.0");
  });
});

// --- 技能档提示承载规格文档夹迁移（desktop-spec-dir-migration design D2） ---

const PENDING_PROBE = {
  ...STALE_PROBE,
  migration: { state: "pending" as const, folder: "openspec", metaFiles: 4 },
};
const SETTLED_PROBE = {
  status: "current" as const,
  currentVersion: "v1.3.0",
  tools: [],
  differingFiles: [],
  migration: { state: "none" as const },
};
const DEFERRED_MIGRATION = {
  state: "deferred" as const,
  folder: "openspec",
  reason: "otherWorktrees" as const,
  worktrees: ["/work/side"],
};

describe("技能档提示承载规格文档夹迁移", () => {
  beforeEach(() => {
    localStorage.removeItem("specseal.assetSkips");
    localStorage.removeItem("specseal.instructionSkips");
  });

  it("更新完成且文档夹已改名：记下迁移结果，重挂监看并刷新", async () => {
    const probe = vi.fn().mockResolvedValue(PENDING_PROBE);
    const updateAssets = vi.fn(async () => {
      probe.mockResolvedValue(SETTLED_PROBE);
      return { migrated: { movedFolder: true, renamed: 4 } };
    });
    const ws = fakeInstructionWorkspace({ probeAssets: probe, updateAssets });
    const ds = fakeDataSource();
    const store = storeWithAssetProbe(ws, ds);
    await store.getState().refreshAssetPrompt();

    await store.getState().applyAssetUpdate();

    expect(selectAssetMigrated(store.getState())).toEqual({ key: "local:A", movedFolder: true, renamed: 4 });
    const watch = vi.mocked(ws.watchWorkspace);
    expect(watch).toHaveBeenCalledWith("A");
    expect(watch.mock.invocationCallOrder.at(-1)).toBeGreaterThan(updateAssets.mock.invocationCallOrder[0]);
    // 改名后数据源读到的是 specseal/：整批刷新（讨论记录路径等跟着换）。
    const listDiscussions = vi.mocked(ds.listDiscussions);
    expect(listDiscussions.mock.invocationCallOrder.at(-1)).toBeGreaterThan(updateAssets.mock.invocationCallOrder[0]);
    expect(selectAssetPrompt(store.getState())).toBeNull();

    store.getState().closeAssetMigrated();
    expect(selectAssetMigrated(store.getState())).toBeNull();
  });

  it("更新途中切走分页：完成态属于套用的分页，切回来才显示", async () => {
    const update = deferred<{ migrated: { movedFolder: boolean; renamed: number } }>();
    const probe = vi.fn().mockResolvedValue(PENDING_PROBE);
    const store = storeWithAssetProbe(fakeInstructionWorkspace({ probeAssets: probe, updateAssets: vi.fn(() => update.promise) }));
    await store.getState().refreshAssetPrompt();

    const applying = store.getState().applyAssetUpdate();
    store.setState({ activeKey: "local:B" });
    update.resolve({ migrated: { movedFolder: true, renamed: 4 } });
    await applying;

    expect(selectAssetMigrated(store.getState())).toBeNull();
    store.setState({ activeKey: "local:A" });
    expect(selectAssetMigrated(store.getState())).toMatchObject({ key: "local:A", movedFolder: true });
  });

  it("按下前的重探失败：错误留在对话框，不更新", async () => {
    const probe = vi.fn().mockResolvedValue(PENDING_PROBE);
    const ws = fakeInstructionWorkspace({ probeAssets: probe });
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();

    probe.mockRejectedValue("probe failed");
    await store.getState().applyAssetUpdate();

    expect(ws.updateAssets).not.toHaveBeenCalled();
    expect(store.getState().assetUpdateError).toContain("probe failed");
    expect(store.getState().assetUpdating).toBe(false);
    expect(selectAssetPrompt(store.getState())?.migration).toEqual(PENDING_PROBE.migration);
  });

  it("更新失败：错误原样留在对话框，监看照样重挂", async () => {
    const message = "cannot move openspec/ to specseal/ — nothing was moved";
    const ws = fakeInstructionWorkspace({
      probeAssets: vi.fn().mockResolvedValue(PENDING_PROBE),
      updateAssets: vi.fn().mockRejectedValue(message),
    });
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();
    vi.mocked(ws.watchWorkspace).mockClear();

    await store.getState().applyAssetUpdate();

    expect(store.getState().assetUpdateError).toBe(message);
    expect(selectAssetMigrated(store.getState())).toBeNull();
    expect(ws.watchWorkspace).toHaveBeenCalledWith("A");
  });

  it("暂缓时按更新：只更新技能档，没有迁移结果；技能档成为现版后暂缓不再提示", async () => {
    const probe = vi.fn().mockResolvedValue({ ...STALE_PROBE, migration: DEFERRED_MIGRATION });
    const updateAssets = vi.fn(async () => {
      probe.mockResolvedValue({ ...SETTLED_PROBE, migration: DEFERRED_MIGRATION });
      return { migrated: { movedFolder: false, renamed: 0 } };
    });
    const store = storeWithAssetProbe(fakeInstructionWorkspace({ probeAssets: probe, updateAssets }));
    await store.getState().refreshAssetPrompt();

    await store.getState().applyAssetUpdate();

    expect(updateAssets).toHaveBeenCalledWith("A");
    expect(selectAssetMigrated(store.getState())).toBeNull();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });

  it("对话框写着暂缓、按下前已可迁移：不运行更新，改显示最新内容", async () => {
    const probe = vi.fn().mockResolvedValue({ ...STALE_PROBE, migration: DEFERRED_MIGRATION });
    const ws = fakeInstructionWorkspace({ probeAssets: probe });
    const store = storeWithAssetProbe(ws);
    await store.getState().refreshAssetPrompt();

    probe.mockResolvedValue(PENDING_PROBE);
    await store.getState().applyAssetUpdate();

    expect(ws.updateAssets).not.toHaveBeenCalled();
    expect(selectAssetPrompt(store.getState())?.migration).toEqual(PENDING_PROBE.migration);
    expect(store.getState().assetUpdating).toBe(false);
  });

  it("remote 分页没有迁移提示", async () => {
    const ws = fakeInstructionWorkspace({ probeAssets: vi.fn().mockResolvedValue(PENDING_PROBE) });
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("remote 分页不建 local session");
      },
      workspace: ws,
    });
    const remote = remoteSession(fakeDataSource(), "repo-a");
    store.setState({
      tabs: [{ locator: remote.locator, name: remote.descriptor.name }],
      sessions: { [remote.id]: remote },
      activeKey: remote.id,
    });

    await store.getState().refreshAssetPrompt();
    expect(ws.probeAssets).not.toHaveBeenCalled();
    expect(selectAssetPrompt(store.getState())).toBeNull();
  });
});

// --- 背景检查发现新版本的 toast（desktop-app「背景检查的 toast 只发一次」；design D4） ---

describe("背景检查发现新版本的 toast", () => {
  type ToastOptions = { id?: string; action?: { label: string; onClick: () => void } };
  function updaterStore(versions: string[]) {
    const check = vi.fn();
    for (const version of versions) {
      check.mockResolvedValueOnce({
        version,
        download: vi.fn(() => new Promise<void>(() => {})), // 停在下载中，供「取消」回闲置
        install: vi.fn(),
      });
    }
    return trackedAppStore({ createSession: vi.fn() as never, updater: { check, relaunch: vi.fn() } });
  }

  it("背景检查发现新版本：toast 一次（含版号、固定 id）；「查看」进设置页并聚焦软件更新卡", async () => {
    const store = updaterStore(["0.5.1"]);
    await store.getState().checkForUpdates(false);
    expect(store.getState().updater).toEqual({ phase: "available", version: "0.5.1" });
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [message, options] = toastFn.mock.calls[0] as [string, ToastOptions];
    expect(message).toContain("0.5.1");
    expect(options.id).toBe("updater-available");
    expect(options.action?.label).toBe("查看");
    options.action?.onClick();
    expect(store.getState().boardView).toBe("settings");
    expect(store.getState().focusUpdater).toBe(true);
  });

  it("Scenario「背景检查的 toast 只发一次」：下载后取消回闲置，一小时后前景重检回报同版本不再发；换了版本才再发", async () => {
    const store = updaterStore(["0.5.1", "0.5.1", "0.5.2"]);
    await store.getState().checkForUpdates(false);
    expect(toastFn).toHaveBeenCalledTimes(1);
    // 待同意时前景重检被挡（提示留到用户处置）；取消下载回闲置后才会重检。
    void store.getState().acceptUpdate();
    store.getState().dismissUpdate();
    expect(store.getState().updater).toEqual({ phase: "idle" });

    await store.getState().recheckOnFocus(Date.now() + 60 * 60 * 1000);
    expect(store.getState().updater).toEqual({ phase: "available", version: "0.5.1" });
    expect(toastFn).toHaveBeenCalledTimes(1);

    void store.getState().acceptUpdate();
    store.getState().dismissUpdate();
    await store.getState().recheckOnFocus(Date.now() + 2 * 60 * 60 * 1000);
    expect(toastFn).toHaveBeenCalledTimes(2);
    expect((toastFn.mock.calls[1] as [string])[0]).toContain("0.5.2");
  });

  it("手动检查不发 toast：结果以卡内行内文本呈现", async () => {
    const store = updaterStore(["0.5.1"]);
    await store.getState().checkForUpdates(true);
    expect(store.getState().updater).toEqual({ phase: "available", version: "0.5.1" });
    expect(toastFn).not.toHaveBeenCalled();
  });
});

// --- 版本更新的取消（desktop-app「取消下载回到闲置」；desktop-notice-relocation design D3） ---

describe("取消下载", () => {
  function pendingUpdate(version: string) {
    const download = deferred<void>();
    return {
      download,
      pending: { version, download: vi.fn(() => download.promise), install: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it("取消后下载完成：不安装、不进 restartPending，状态留在闲置", async () => {
    const first = pendingUpdate("0.2.0");
    const store = trackedAppStore({
      createSession: vi.fn() as never,
      updater: { check: vi.fn().mockResolvedValue(first.pending), relaunch: vi.fn() },
    });
    await store.getState().checkForUpdates(false);
    const accepting = store.getState().acceptUpdate();
    expect(store.getState().updater).toEqual({ phase: "downloading", version: "0.2.0" });

    store.getState().dismissUpdate();
    expect(store.getState().updater).toEqual({ phase: "idle" });

    first.download.resolve();
    await accepting;
    expect(first.pending.install).not.toHaveBeenCalled();
    expect(store.getState().updater).toEqual({ phase: "idle" });
  });

  it("取消后重新检查并再次下载：旧下载晚到完成不推进新下载、也不安装旧包", async () => {
    const first = pendingUpdate("0.2.0");
    const second = pendingUpdate("0.2.0");
    const store = trackedAppStore({
      createSession: vi.fn() as never,
      updater: {
        check: vi.fn().mockResolvedValueOnce(first.pending).mockResolvedValueOnce(second.pending),
        relaunch: vi.fn(),
      },
    });
    await store.getState().checkForUpdates(false);
    const firstAccept = store.getState().acceptUpdate();
    store.getState().dismissUpdate();
    await store.getState().checkForUpdates(true);
    const secondAccept = store.getState().acceptUpdate();
    expect(store.getState().updater).toEqual({ phase: "downloading", version: "0.2.0" });

    first.download.resolve();
    await firstAccept;
    expect(first.pending.install).not.toHaveBeenCalled();
    expect(store.getState().updater).toEqual({ phase: "downloading", version: "0.2.0" });

    second.download.resolve();
    await secondAccept;
    expect(second.pending.install).toHaveBeenCalledTimes(1);
    expect(store.getState().updater).toEqual({ phase: "restartPending", version: "0.2.0" });
  });

  it("取消后重新检查：旧下载晚到失败不转错误、不清掉新的待更新项（「下载」仍可用）", async () => {
    const first = pendingUpdate("0.2.0");
    const second = pendingUpdate("0.2.0");
    const store = trackedAppStore({
      createSession: vi.fn() as never,
      updater: {
        check: vi.fn().mockResolvedValueOnce(first.pending).mockResolvedValueOnce(second.pending),
        relaunch: vi.fn(),
      },
    });
    await store.getState().checkForUpdates(false);
    const firstAccept = store.getState().acceptUpdate();
    store.getState().dismissUpdate();
    await store.getState().checkForUpdates(true);
    expect(store.getState().updater).toEqual({ phase: "available", version: "0.2.0" });

    first.download.reject(new Error("network"));
    await firstAccept;
    expect(store.getState().updater).toEqual({ phase: "available", version: "0.2.0" });

    void store.getState().acceptUpdate();
    expect(second.pending.download).toHaveBeenCalledTimes(1);
    expect(store.getState().updater).toEqual({ phase: "downloading", version: "0.2.0" });
  });
});

// spec「分页切换中即时回馈」（design D1）：本地分页的项目探测挡在翻页之前，
// 期间 pendingTabKey 指向目标分页——探测成功翻页、失败转错误态，两条路都清空。
describe("切换中分页（pendingTabKey）", () => {
  /** 两个本地分页（活跃 A、待切 B），B 的探测以 deferred 控制完成时机。 */
  function storeWithTwoLocalTabs(probe: Promise<unknown>) {
    const ds = fakeDataSource();
    const ws = fakeInstructionWorkspace({
      openProject: vi.fn().mockReturnValue(probe),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });
    return { store, ws, keyB: b.id };
  }

  it("初值为 null", () => {
    const store = storeWithAssetProbe(fakeInstructionWorkspace());
    expect(store.getState().pendingTabKey).toBeNull();
  });

  it("探测进行中 → 指向目标分页，活跃分页不变", async () => {
    const d = deferred<unknown>();
    const { store, keyB } = storeWithTwoLocalTabs(d.promise);
    const activeBefore = store.getState().activeKey;
    const activation = store.getState().activateTab(keyB);
    expect(store.getState().pendingTabKey).toBe(keyB);
    expect(store.getState().activeKey).toBe(activeBefore);
    d.resolve({ status: "project", root: "B", name: "b" });
    await activation;
  });

  it("探测成功翻页后 → 清为 null", async () => {
    const d = deferred<unknown>();
    const { store, keyB } = storeWithTwoLocalTabs(d.promise);
    const activation = store.getState().activateTab(keyB);
    d.resolve({ status: "project", root: "B", name: "b" });
    await activation;
    expect(store.getState().pendingTabKey).toBeNull();
    expect(store.getState().activeKey).toBe(keyB);
  });

  // spec「探测成功后切页」：spinner 只涵盖探测本身。翻页后的整批加载由 skeleton
  // 承担——两者并存会让已切换完成的分页持续挂「正在切换」。
  it("探测完成即清除 → 后续整批加载期间不再挂切换中", async () => {
    const probe = deferred<unknown>();
    const load = deferred<ChangeListPayload>();
    const ds = fakeDataSource({ listChanges: vi.fn(() => load.promise) });
    const ws = fakeInstructionWorkspace({
      openProject: vi.fn().mockReturnValue(probe.promise),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });

    const activation = store.getState().activateTab(b.id);
    probe.resolve({ status: "project", root: "B", name: "b" });
    // 让 enterProject 推进到整批加载的 await（清单仍未回）。
    await new Promise((r) => setTimeout(r, 0));

    expect(store.getState().activeKey).toBe(b.id);
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().pendingTabKey).toBeNull();

    load.resolve(changeList([]));
    await activation;
  });

  it("探测回非项目 → 清为 null，分页错误照旧写入", async () => {
    const d = deferred<unknown>();
    const { store, keyB } = storeWithTwoLocalTabs(d.promise);
    const activation = store.getState().activateTab(keyB);
    d.resolve({ status: "uninitialized", dir: "B" });
    await activation;
    expect(store.getState().pendingTabKey).toBeNull();
    expect(store.getState().tabErrors[keyB]).toBeTruthy();
    expect(store.getState().activeKey).not.toBe(keyB);
  });

  it("探测上抛 → 清为 null，分页错误照旧写入", async () => {
    const d = deferred<unknown>();
    const { store, keyB } = storeWithTwoLocalTabs(d.promise);
    const activation = store.getState().activateTab(keyB);
    d.reject("boom");
    await activation;
    expect(store.getState().pendingTabKey).toBeNull();
    expect(store.getState().tabErrors[keyB]).toBeTruthy();
  });

  // 翻页阶段抛错仍须转分页错误态——不得因 spinner 清除时机的重构而变成未处理的
  // rejection（调用端多为 void activateTab(...)，逸出即静默）。
  it("翻页阶段抛错 → 转分页错误态，不逸出", async () => {
    const ds = fakeDataSource();
    const ws = fakeInstructionWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: () => {
        throw new Error("翻页失败");
      },
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });

    await expect(store.getState().activateTab(b.id)).resolves.toBeUndefined();
    expect(store.getState().tabErrors[b.id]).toBeTruthy();
    expect(store.getState().pendingTabKey).toBeNull();
  });

  // 快速连点两个分页：先发的收尾不得清掉后发的标记，否则后发切换全程无回馈。
  it("先发切换收尾 → 不清掉后发切换的标记", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const ds = fakeDataSource();
    const ws = fakeInstructionWorkspace({
      openProject: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    const c = fakeSession(ds, "C", "c");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
        { locator: c.locator, name: c.descriptor.name },
      ],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });

    const toB = store.getState().activateTab(b.id);
    const toC = store.getState().activateTab(c.id);
    expect(store.getState().pendingTabKey).toBe(c.id);

    first.reject("B 探测失败");
    await toB;
    // B 的收尾走完，标记仍指向 C——C 的切换还在进行中。
    expect(store.getState().pendingTabKey).toBe(c.id);

    second.resolve({ status: "project", root: "C", name: "c" });
    await toC;
    expect(store.getState().pendingTabKey).toBeNull();
  });
});

// 骨架的终止条件是 loadingActive，不是 loaded：读不到不等于「确认是空的」，
// 所以失败时 loaded 维持 false，但在途计数必须归零让骨架收掉。
describe("整批加载的进行中旗标", () => {
  it("加载进行中 → loadingActive 为 true；完成后落回 false", async () => {
    const d = deferred<ChangeListPayload>();
    const store = storeWith(fakeDataSource({ listChanges: vi.fn(() => d.promise) }));
    const pending = store.getState().refresh();
    expect(store.getState().loadingActive).toBe(true);
    d.resolve(changeList([]));
    await pending;
    expect(store.getState().loadingActive).toBe(false);
    expect(store.getState().loaded).toBe(true);
  });

  it("首访无缓存且读取失败 → loadingActive 落回 false，loaded 维持 false", async () => {
    const store = storeWith(
      fakeDataSource({ listChanges: vi.fn().mockRejectedValue(new Error("offline")) }),
    );
    await store.getState().refresh();
    expect(store.getState().loadingActive).toBe(false);
    expect(store.getState().loaded).toBe(false);
  });

  it("已有缓存时读取失败 → 沿用最后一次成功快照，不覆盖", async () => {
    const listChanges = vi
      .fn()
      .mockResolvedValue(changeList([{ name: "kept", status: "in-progress", totalTasks: 1, completedTasks: 0 }]));
    const store = storeWith(fakeDataSource({ listChanges }));
    await store.getState().refresh();
    expect(store.getState().changes.map((c) => c.name)).toEqual(["kept"]);

    listChanges.mockRejectedValue(new Error("offline"));
    await store.getState().refresh();
    expect(store.getState().changes.map((c) => c.name)).toEqual(["kept"]);
    expect(store.getState().loaded).toBe(true);
  });
});

// 读不到 ≠ 确认是空的：首访失败要留下终态记号，看板与面板才能显示「加载失败」
// 而不是与真空 workspace 同貌的空态。记号随快照走，切走再切回仍记得。
describe("首访加载失败终态", () => {
  it("首访加载失败 → loadFailed 为 true、loaded 维持 false", async () => {
    const store = storeWith(
      fakeDataSource({ listChanges: vi.fn().mockRejectedValue(new Error("offline")) }),
    );
    await store.getState().refresh();
    expect(store.getState().loadFailed).toBe(true);
    expect(store.getState().loaded).toBe(false);
  });

  it("失败后成功加载 → loadFailed 落回 false", async () => {
    const listChanges = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(changeList([]));
    const store = storeWith(fakeDataSource({ listChanges }));
    await store.getState().refresh();
    expect(store.getState().loadFailed).toBe(true);

    await store.getState().refresh();
    expect(store.getState().loadFailed).toBe(false);
    expect(store.getState().loaded).toBe(true);
  });

  it("过期世代的失败回来 → 不得覆写后发的成功", async () => {
    const first = deferred<ChangeListPayload>();
    const second = deferred<ChangeListPayload>();
    const listChanges = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = storeWith(fakeDataSource({ listChanges }));

    const p1 = store.getState().refresh();
    const p2 = store.getState().refresh();
    second.resolve(changeList([]));
    await p2;
    first.reject(new Error("offline"));
    await p1;
    expect(store.getState().loadFailed).toBe(false);
    expect(store.getState().loaded).toBe(true);
  });

  it("切走再切回 → 失败记录随快照存续（不重回骨架、不显示空态）", async () => {
    const gate = deferred<ChangeListPayload>();
    const dsA = fakeDataSource({
      listChanges: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockReturnValueOnce(gate.promise),
    });
    const a = remoteSession(dsA, "repo-a");
    const b = remoteSession(fakeDataSource(), "repo-b");
    const store = storeWithRemoteSessions(a, b);

    await store.getState().refresh();
    expect(store.getState().loadFailed).toBe(true);

    await store.getState().activateTab(b.id);
    expect(store.getState().loadFailed).toBe(false);

    // 切回 A：重载才刚起跑，此刻的失败记号来自快照而非这一发的结果。
    const back = store.getState().activateTab(a.id);
    expect(store.getState().loadFailed).toBe(true);
    expect(store.getState().loaded).toBe(false);

    gate.resolve(changeList([]));
    await back;
    expect(store.getState().loadFailed).toBe(false);
  });
});

// loadingActive 由 activeKey 的在途计数导出：计数按 key 记，导出值跟着活跃
// workspace 走。一旦两者错位就会卡在 true——那正是骨架永久挂着的老问题复发。
describe("整批加载旗标的记帐边界", () => {
  it("加载途中关掉该分页 → 旗标不卡在 true", async () => {
    const d = deferred<ChangeListPayload>();
    const ds = fakeDataSource({ listChanges: vi.fn(() => d.promise) });
    const store = trackedAppStore({ createSession: (root, name) => fakeSession(ds, root, name) });
    const a = fakeSession(ds, "A", "a");
    store.setState({
      tabs: [{ locator: a.locator, name: a.descriptor.name }],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });

    const pending = store.getState().refresh();
    expect(store.getState().loadingActive).toBe(true);
    store.getState().closeTab(a.id);
    d.resolve(changeList([]));
    await pending;
    expect(store.getState().loadingActive).toBe(false);
  });

  it("别的 workspace 的在途加载结束 → 不得清掉现任的旗标", async () => {
    const aLoad = deferred<ChangeListPayload>();
    const bLoad = deferred<ChangeListPayload>();
    const dsA = fakeDataSource({ listChanges: vi.fn(() => aLoad.promise) });
    const dsB = fakeDataSource({ listChanges: vi.fn(() => bLoad.promise) });
    const a = fakeSession(dsA, "A", "a");
    const b = fakeSession(dsB, "B", "b");
    const store = trackedAppStore({ createSession: () => a });
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a, [b.id]: b },
      activeKey: a.id,
    });

    const aPending = store.getState().refresh();
    // 翻到 B 并起 B 自己的加载：此时画面上「正在载」的是 B。
    store.setState({ activeKey: b.id, loaded: false });
    const bPending = store.getState().refresh();
    expect(store.getState().loadingActive).toBe(true);

    // A 的在途加载这时才回来——它已不是现任，不得把 B 的旗标收掉。
    aLoad.resolve(changeList([]));
    await aPending;
    expect(store.getState().loadingActive).toBe(true);

    bLoad.resolve(changeList([]));
    await bPending;
    expect(store.getState().loadingActive).toBe(false);
  });

  it("同 key 重叠加载：先发成功回来 → 不得清掉后发在途的旗标", async () => {
    const first = deferred<ChangeListPayload>();
    const second = deferred<ChangeListPayload>();
    const listChanges = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = storeWith(fakeDataSource({ listChanges }));

    const p1 = store.getState().refresh();
    const p2 = store.getState().refresh();
    expect(store.getState().loadingActive).toBe(true);

    // 先发此刻已是过期世代——回来时后发还在载，旗标不得归零。
    first.resolve(changeList([]));
    await p1;
    expect(store.getState().loadingActive).toBe(true);

    second.resolve(changeList([]));
    await p2;
    expect(store.getState().loadingActive).toBe(false);
  });

  it("同 key 重叠加载：先发失败 → 不得清掉后发在途的旗标", async () => {
    const first = deferred<ChangeListPayload>();
    const second = deferred<ChangeListPayload>();
    const listChanges = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = storeWith(fakeDataSource({ listChanges }));

    const p1 = store.getState().refresh();
    const p2 = store.getState().refresh();

    first.reject(new Error("offline"));
    await p1;
    expect(store.getState().loadingActive).toBe(true);

    second.resolve(changeList([]));
    await p2;
    expect(store.getState().loadingActive).toBe(false);
  });

  it("开修复页（后面不接整批加载）→ 不得标加载中", () => {
    const ds = fakeDataSource();
    const a = remoteSession(ds, "repo-a");
    const b = remoteSession(ds, "repo-b");
    const store = storeWithRemoteSessions(a, b);
    store.setState({
      remoteRecovery: { [b.id]: { status: "restoring", failure: null } },
    });

    store.getState().showRemoteWorkspaceRecovery(b.id);
    expect(store.getState().activeKey).toBe(b.id);
    // 这条翻页路径不会起整批加载——没有在途就没有加载中，入口无须表态。
    expect(store.getState().loadingActive).toBe(false);
  });
});

// 翻页到首访 workspace 的那一刻起就算加载中：翻页入口不再自行表态，改由它
// 同步接上的 refresh() 计数 +1 导出——中间不得有「已翻页、尚未起加载」的空窗，
// 那个窗口渲染的正是假空态。监看挂载慢时尤其明显，故以卡住的 watch 把关。
describe("翻页与加载中标记同批", () => {
  it("翻到首访 workspace → activeKey 翻转当下即为加载中", async () => {
    const load = deferred<ChangeListPayload>();
    const ds = fakeDataSource({ listChanges: vi.fn(() => load.promise) });
    let resolveWatch!: () => void;
    const watchGate = new Promise<void>((r) => {
      resolveWatch = r;
    });
    const ws = fakeInstructionWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }),
      watchWorkspace: vi.fn(() => watchGate),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const a = fakeSession(ds, "A", "a");
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [
        { locator: a.locator, name: a.descriptor.name },
        { locator: b.locator, name: b.descriptor.name },
      ],
      sessions: { [a.id]: a },
      activeKey: a.id,
    });

    const activation = store.getState().activateTab(b.id);
    // 监看挂载卡住：此刻已翻页但整批加载尚未开跑——不得出现三信号全灭的空窗。
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().activeKey).toBe(b.id);
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().loadingActive).toBe(true);

    resolveWatch();
    load.resolve(changeList([]));
    await activation;
    expect(store.getState().loadingActive).toBe(false);
  });

  // 首批加载先于监看挂载起跑（消灭空窗）的代价：挂载完成前的文档变动既无事件
  // 也不在首批结果内。挂载成功后必须补一发整批加载，盖掉这个静默过时窗口。
  it("监看挂载完成后补一发整批加载，涵盖挂载窗口内的变动", async () => {
    const stale: ChangeItem[] = [];
    const fresh: ChangeItem[] = [
      { name: "landed-during-mount", status: "proposed", totalTasks: 0, completedTasks: 0 },
    ];
    const listChanges = vi
      .fn()
      .mockResolvedValueOnce(changeList(stale))
      .mockResolvedValue(changeList(fresh));
    const ds = fakeDataSource({ listChanges });
    let resolveWatch!: () => void;
    const watchGate = new Promise<void>((r) => {
      resolveWatch = r;
    });
    const ws = fakeInstructionWorkspace({
      openProject: vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }),
      watchWorkspace: vi.fn(() => watchGate),
    } as Partial<WorkspaceAdapter>);
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: ws,
    });
    const b = fakeSession(ds, "B", "b");
    store.setState({
      tabs: [{ locator: b.locator, name: b.descriptor.name }],
      sessions: {},
      activeKey: null,
    });

    const activation = store.getState().activateTab(b.id);
    await new Promise((r) => setTimeout(r, 0));
    // 首批（过时）已在途；此刻监看才挂载完成——窗口内的变动只有补读看得到。
    resolveWatch();
    await activation;
    expect(listChanges.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.getState().changes.map((c) => c.name)).toEqual(["landed-during-mount"]);
  });
});

describe("认领撞 ownership 冲突的呈现", () => {
  // server 的 409 消息本身就写了「谁持有、该去找谁协调」——桌面端必须原样
  // 转印。退化成单纯「认领失败」,等于把撞工当下唯一有用的信息丢掉。
  const HELD =
    "change 'demo' is already claimed by Alice Chen <alice@example.com> — coordinate with them, or ask them to release it";

  it("提示原样带出目前持有人与建议动作", async () => {
    const claim = vi.fn().mockRejectedValue(new Error(HELD));
    const store = storeWith(fakeDataSource({ claim }));
    await store.getState().claimChange("desktop-shell-and-browser");

    expect(claim).toHaveBeenCalledWith("desktop-shell-and-browser");
    const [message] = toastError.mock.calls[0] as [string];
    expect(message).toContain("Alice Chen <alice@example.com>");
    expect(message).toContain("coordinate with them");
  });

  it("认领成功不出提示,且重新加载清单", async () => {
    const ds = fakeDataSource({ claim: vi.fn().mockResolvedValue(undefined) });
    const store = storeWith(ds);
    await store.getState().claimChange("desktop-shell-and-browser");
    expect(toastError).not.toHaveBeenCalled();
    expect(ds.listChanges).toHaveBeenCalled();
  });
});

// desktop-manual-page design「手册页的外部变更重载沿用既有 watcher 事件」：store 收到
// 带 root 的文档变更事件（→ 整批 refresh）且手册视图活跃时重取索引；交错回应以
// 最新为准；不添加监看目标（沿用 refresh 这条路）。
describe("手册索引的重取（refreshManual）", () => {
  const INDEX: ManualIndex = { present: true, reason: null, pages: [], uncoveredNew: [], malformed: [] };

  it("切到手册视图即取索引；之后每次整批 refresh 在手册视图活跃时重取，非活跃不取", async () => {
    const ds = fakeDataSource({ listManualPages: vi.fn().mockResolvedValue(INDEX) });
    const store = storeWith(ds);
    await store.getState().refresh();
    expect(ds.listManualPages).not.toHaveBeenCalled();
    expect(store.getState().manual).toBeNull();

    store.getState().setBoardView("manual");
    await vi.waitFor(() => expect(store.getState().manual).toEqual(INDEX));
    expect(ds.listManualPages).toHaveBeenCalledTimes(1);

    // 两笔假事件（workspace-changed → refresh）。
    await store.getState().refresh();
    await store.getState().refresh();
    expect(ds.listManualPages).toHaveBeenCalledTimes(3);

    store.getState().setBoardView("board");
    await store.getState().refresh();
    expect(ds.listManualPages).toHaveBeenCalledTimes(3);
  });

  it("交错回应以最新为准：先发后到的索引不得覆盖后发先到的", async () => {
    const first = deferred<ManualIndex>();
    const second = deferred<ManualIndex>();
    const listManualPages = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = storeWith(fakeDataSource({ listManualPages }));
    store.getState().setBoardView("manual");
    await store.getState().refresh();
    expect(listManualPages).toHaveBeenCalledTimes(2);
    second.resolve({ ...INDEX, uncoveredNew: ["new"] });
    await vi.waitFor(() => expect(store.getState().manual?.uncoveredNew).toEqual(["new"]));
    first.resolve({ ...INDEX, uncoveredNew: ["old"] });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().manual?.uncoveredNew).toEqual(["new"]);
  });

  it("索引读取失败：无旧索引时落成尚无手册的空索引，有旧索引时沿用旧索引", async () => {
    const listManualPages = vi.fn().mockRejectedValueOnce(new Error("io"));
    const store = storeWith(fakeDataSource({ listManualPages }));
    store.getState().setBoardView("manual");
    await vi.waitFor(() => expect(store.getState().manual?.present).toBe(false));
    listManualPages.mockResolvedValueOnce(INDEX).mockRejectedValueOnce(new Error("io"));
    await store.getState().refresh();
    await vi.waitFor(() => expect(store.getState().manual).toEqual(INDEX));
    await store.getState().refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().manual).toEqual(INDEX);
  });

  it("手册出处开规格抽屉：detailSpec 设置、boardView 维持手册页不切页", () => {
    const store = storeWith(fakeDataSource());
    store.getState().setBoardView("manual");
    store.getState().openSpec("desktop-app");
    expect(store.getState().boardView).toBe("manual");
    expect(store.getState().detailSpec).toBe("desktop-app");
  });
});

// desktop-app「项目层文档系统动作」（design D5）：成功静默、失败 toast；
// remote 无 checkout 时没有本机目录，四个动作都不碰文档系统。
describe("项目层文档系统动作", () => {
  beforeEach(() => {
    toastError.mockReset();
  });

  function fakeFsActions(): { [K in keyof FsActionsAdapter]: ReturnType<typeof vi.fn> } {
    return {
      reveal: vi.fn().mockResolvedValue(undefined),
      openDefault: vi.fn().mockResolvedValue(undefined),
      openTerminal: vi.fn().mockResolvedValue(undefined),
      openEditor: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      locate: vi.fn().mockResolvedValue(null),
    };
  }

  function storeWithTabs(fsActions = fakeFsActions()) {
    const ds = fakeDataSource();
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      fsActions: fsActions as unknown as FsActionsAdapter,
    });
    store.setState({
      tabs: [
        { locator: { kind: "local", root: "/work/alpha" }, name: "alpha" },
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "api" },
          name: "Demo/api",
        },
        {
          locator: {
            kind: "remote",
            connectionId: "c1",
            projectId: "demo",
            repoId: "web",
            checkoutRoot: "/work/web",
          },
          name: "Demo/web",
        },
      ],
    });
    return { store, fsActions };
  }

  it("成功时四个动作都不调用 toast，路径为项目根或 checkout", async () => {
    const { store, fsActions } = storeWithTabs();
    await store.getState().revealProject("local:/work/alpha");
    await store.getState().openProjectInTerminal("local:/work/alpha");
    await store.getState().openProjectInEditor("remote:c1/demo/web");
    await store.getState().copyProjectPath("local:/work/alpha");
    expect(fsActions.reveal).toHaveBeenCalledWith("/work/alpha");
    expect(fsActions.openTerminal).toHaveBeenCalledWith("/work/alpha");
    expect(fsActions.openEditor).toHaveBeenCalledWith("/work/web");
    expect(fsActions.copyText).toHaveBeenCalledWith("/work/alpha");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("i18n 键的错误以对应文案显示 toast（找不到终端机、找不到编辑器、目录已不存在）", async () => {
    const fsActions = fakeFsActions();
    fsActions.openTerminal.mockRejectedValueOnce("fs.noTerminal").mockRejectedValueOnce("fs.dirMissing");
    fsActions.openEditor.mockRejectedValue("fs.noEditor");
    const { store } = storeWithTabs(fsActions);
    await store.getState().openProjectInTerminal("local:/work/alpha");
    await store.getState().openProjectInEditor("local:/work/alpha");
    await store.getState().openProjectInTerminal("local:/work/alpha");
    expect(toastError.mock.calls).toEqual([
      ["找不到可用的终端机"],
      ["找不到可用的编辑器（支持 VS Code、Cursor、Zed、Sublime）"],
      ["项目目录已不存在"],
    ]);
  });

  it("「找不到编辑器」文案列出的编辑器与 Rust 候选清单同一份、同顺序（两语系）", () => {
    // 增减编辑器时，Rust 清单、两语系文案要一起改；漏改任一处这里就红。
    const LABEL: Record<string, string> = { code: "VS Code", cursor: "Cursor", zed: "Zed", subl: "Sublime" };
    const list = /Platform::MacOs \| Platform::Linux => \[([^\]]*)\]/.exec(fsActionsRs)?.[1] ?? "";
    const labels = [...list.matchAll(/"([^"]+)"/g)].map(([, program]) => LABEL[program] ?? `?${program}`);
    expect(labels.length).toBeGreaterThan(0);
    expect(APP_MESSAGES["zh-CN"]["fs.noEditor"]).toBe(`找不到可用的编辑器（支持 ${labels.join("、")}）`);
    expect(APP_MESSAGES.en["fs.noEditor"]).toBe(`No editor found (supports ${labels.join(", ")})`);
  });

  it("非 i18n 键的错误原样显示（如 opener 的路径不存在）", async () => {
    const fsActions = fakeFsActions();
    fsActions.reveal.mockRejectedValue("No such file or directory (os error 2)");
    fsActions.copyText.mockRejectedValue(new Error("clipboard denied"));
    const { store } = storeWithTabs(fsActions);
    await store.getState().revealProject("local:/work/alpha");
    await store.getState().copyProjectPath("local:/work/alpha");
    expect(toastError.mock.calls).toEqual([
      ["No such file or directory (os error 2)"],
      ["Error: clipboard denied"],
    ]);
  });

  it("remote 无 checkout 时四个动作都不调用文档系统面", async () => {
    const { store, fsActions } = storeWithTabs();
    const key = "remote:c1/demo/api";
    await store.getState().revealProject(key);
    await store.getState().openProjectInTerminal(key);
    await store.getState().openProjectInEditor(key);
    await store.getState().copyProjectPath(key);
    for (const action of Object.values(fsActions)) expect(action).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

// desktop-app「详情页的文档动作」（design D4）：磁盘位置由 core 以读文档同一套解析回报
// （worktree 副本、spec 目录名、已封存讨论）；失败以单槽失败 toast 呈现、主词为相对路径；
// remote 无 checkout 不查位置、只剩拷贝内容。
describe("详情页文档动作", () => {
  const DOC = { change: "add-auth", artifact: "proposal.md" };
  const LOC = {
    path: "/work/app-wt/add-auth/specseal/changes/add-auth/proposal.md",
    relative: "specseal/changes/add-auth/proposal.md",
  };

  function fakeFsActions(): { [K in keyof FsActionsAdapter]: ReturnType<typeof vi.fn> } {
    return {
      reveal: vi.fn().mockResolvedValue(undefined),
      openDefault: vi.fn().mockResolvedValue(undefined),
      openTerminal: vi.fn().mockResolvedValue(undefined),
      openEditor: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      locate: vi.fn().mockResolvedValue(LOC),
    };
  }

  function storeActive(activeKey: string, fsActions = fakeFsActions()) {
    const store = trackedAppStore({
      createSession: (root, name) => fakeSession(fakeDataSource(), root, name),
      fsActions: fsActions as unknown as FsActionsAdapter,
    });
    store.setState({
      tabs: [
        { locator: { kind: "local", root: "/work/app" }, name: "app" },
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "api" },
          name: "Demo/api",
        },
      ],
      activeKey,
    });
    return { store, fsActions };
  }

  beforeEach(() => {
    toastError.mockReset();
  });

  it("locateDocument 以活跃项目的本机目录向 core 查位置", async () => {
    const { store, fsActions } = storeActive("local:/work/app");
    expect(await store.getState().locateDocument(DOC)).toEqual(LOC);
    expect(fsActions.locate).toHaveBeenCalledWith("/work/app", DOC);
  });

  it("三个动作作用于 core 回报的绝对路径（worktree 副本），成功静默", async () => {
    const { store, fsActions } = storeActive("local:/work/app");
    await store.getState().openDocumentDefault(LOC);
    await store.getState().revealDocument(LOC);
    await store.getState().copyDocumentPath(LOC);
    expect(fsActions.openDefault).toHaveBeenCalledWith(LOC.path);
    expect(fsActions.reveal).toHaveBeenCalledWith(LOC.path);
    expect(fsActions.copyText).toHaveBeenCalledWith(LOC.path);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("revealDocument 失败发失败 toast 且主词为相对路径", async () => {
    const fsActions = fakeFsActions();
    fsActions.reveal.mockRejectedValue("No such file or directory (os error 2)");
    const { store } = storeActive("local:/work/app", fsActions);
    await store.getState().revealDocument(LOC);
    expect(toastError).toHaveBeenCalledTimes(1);
    const [message, options] = toastError.mock.calls[0] as [string, { id?: string }];
    expect(message.startsWith(`${LOC.relative} · `)).toBe(true);
    expect(message).toContain("No such file or directory (os error 2)");
    expect(options?.id).toBe("desktop-operation-failure");
  });

  // desktop-change-doc-views design D11：提案影响段路径签的「在文档管理员显示」。
  it("revealProjectPath 以项目目录拼出路径交 reveal；失败发失败 toast、主词为相对路径", async () => {
    const fsActions = fakeFsActions();
    const { store } = storeActive("local:/work/app", fsActions);
    await store.getState().revealProjectPath("packages/ui/src/docModel.ts");
    expect(fsActions.reveal).toHaveBeenCalledWith("/work/app/packages/ui/src/docModel.ts");
    expect(toastError).not.toHaveBeenCalled();
    fsActions.reveal.mockRejectedValueOnce("No such file or directory (os error 2)");
    await store.getState().revealProjectPath("gone.ts");
    expect((toastError.mock.calls[0] as [string])[0].startsWith("gone.ts · ")).toBe(true);
  });

  it("revealProjectPath 在 remote 无 checkout 时不动作", async () => {
    const { store, fsActions } = storeActive("remote:c1/demo/api");
    await store.getState().revealProjectPath("a.ts");
    expect(fsActions.reveal).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("core 查不到或回报错误时 locateDocument 为 null、不抛", async () => {
    const fsActions = fakeFsActions();
    fsActions.locate.mockResolvedValueOnce(null).mockRejectedValueOnce("boom");
    const { store } = storeActive("local:/work/app", fsActions);
    expect(await store.getState().locateDocument({ discussion: "gone" })).toBeNull();
    expect(await store.getState().locateDocument(DOC)).toBeNull();
  });

  it("remote 无 checkout：不查位置；copyDocumentContent 写入原文", async () => {
    const { store, fsActions } = storeActive("remote:c1/demo/api");
    expect(await store.getState().locateDocument(DOC)).toBeNull();
    expect(fsActions.locate).not.toHaveBeenCalled();
    await store.getState().copyDocumentContent("# 讨论原文");
    expect(fsActions.copyText).toHaveBeenCalledWith("# 讨论原文");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("copyDocumentContent 失败与其他文档动作同样以失败 toast 呈现", async () => {
    const fsActions = fakeFsActions();
    fsActions.copyText.mockRejectedValue(new Error("clipboard denied"));
    const { store } = storeActive("remote:c1/demo/api", fsActions);
    await store.getState().copyDocumentContent("# 原文");
    const [message, options] = toastError.mock.calls[0] as [string, { id?: string }];
    expect(message).toBe("拷贝内容 · 文档动作失败 ✗ Error: clipboard denied");
    expect(options?.id).toBe("desktop-operation-failure");
  });
});

// desktop-board-reskin design D2：看板讨论栏底「已转出」收合列的展开状态存于 app 本机
// （localStorage 键 specseal.board.promotedExpanded）跨启动保留；坏值或缺席一律收合。
describe("promotedExpanded（讨论栏收合列的跨启动记忆）", () => {
  const KEY = "specseal.board.promotedExpanded";

  it("无键时为 false", () => {
    const store = storeWith(fakeDataSource());
    expect(store.getState().promotedExpanded).toBe(false);
  });

  it('键为 "true" 时为 true', () => {
    localStorage.setItem(KEY, "true");
    const store = storeWith(fakeDataSource());
    expect(store.getState().promotedExpanded).toBe(true);
  });

  it("坏值视为 false、不抛错", () => {
    localStorage.setItem(KEY, "yes");
    const store = storeWith(fakeDataSource());
    expect(store.getState().promotedExpanded).toBe(false);
  });

  it('setPromotedExpanded(true) 后键为 "true"；false 写回 "false"', () => {
    const store = storeWith(fakeDataSource());
    store.getState().setPromotedExpanded(true);
    expect(store.getState().promotedExpanded).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("true");
    store.getState().setPromotedExpanded(false);
    expect(store.getState().promotedExpanded).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("false");
  });
});

// desktop-list-pages-reskin design D7：清单每页笔数存于 app 本机（localStorage 键
// specseal.list.pageSizes，JSON 对象）跨启动保留；三个清单各自记住，缺席、坏 JSON 或
// 不在 20／50／100 之内的字段一律退回 20。spec scenario「每页笔数跨启动记住」Example。
describe("pageSizes（清单每页笔数的跨启动记忆）", () => {
  const KEY = "specseal.list.pageSizes";

  it.each<[string, string | null, { specs: number; archivedChanges: number; archivedDiscussions: number }]>([
    ["缺席", null, { specs: 20, archivedChanges: 20, archivedDiscussions: 20 }],
    [
      "specs 50、archivedDiscussions 100",
      JSON.stringify({ specs: 50, archivedDiscussions: 100 }),
      { specs: 50, archivedChanges: 20, archivedDiscussions: 100 },
    ],
    [
      "specs 0、archivedChanges 37",
      JSON.stringify({ specs: 0, archivedChanges: 37 }),
      { specs: 20, archivedChanges: 20, archivedDiscussions: 20 },
    ],
    ["无法解析的文本", "not json{", { specs: 20, archivedChanges: 20, archivedDiscussions: 20 }],
  ])("记忆内容 %s", (_label, raw, expected) => {
    if (raw !== null) localStorage.setItem(KEY, raw);
    const store = storeWith(fakeDataSource());
    expect(store.getState().pageSizes).toEqual(expected);
  });

  it("记忆内容不是对象（数组、字符串）时三个清单都退回 20", () => {
    localStorage.setItem(KEY, JSON.stringify([50, 50, 50]));
    expect(storeWith(fakeDataSource()).getState().pageSizes).toEqual({
      specs: 20,
      archivedChanges: 20,
      archivedDiscussions: 20,
    });
    localStorage.setItem(KEY, JSON.stringify("50"));
    expect(storeWith(fakeDataSource()).getState().pageSizes.specs).toBe(20);
  });

  it("setPageSize 更新该清单并把整个对象写回键；其他清单不变", () => {
    const store = storeWith(fakeDataSource());
    store.getState().setPageSize("specs", 50);
    expect(store.getState().pageSizes).toEqual({ specs: 50, archivedChanges: 20, archivedDiscussions: 20 });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      specs: 50,
      archivedChanges: 20,
      archivedDiscussions: 20,
    });
    store.getState().setPageSize("archivedDiscussions", 100);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      specs: 50,
      archivedChanges: 20,
      archivedDiscussions: 100,
    });
    // 新建的 store（重开 app）读回同一组值。
    expect(storeWith(fakeDataSource()).getState().pageSizes).toEqual({
      specs: 50,
      archivedChanges: 20,
      archivedDiscussions: 100,
    });
  });

  it("localStorage 写入失败时本次运行期照常生效、不抛错", () => {
    const store = storeWith(fakeDataSource());
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(() => store.getState().setPageSize("archivedChanges", 50)).not.toThrow();
      expect(store.getState().pageSizes.archivedChanges).toBe(50);
    } finally {
      spy.mockRestore();
    }
  });
});

// desktop-settings-mode design D1／D6／D7：设置模式的分类（记住上次所在分类）、更新页的自动检查
// 开关（specseal.updater.autoCheck，缺省开）与服务器页的缺省连接（specseal.defaultConnection）。
describe("设置模式的分类与偏好", () => {
  it("缺省落在一般与项目说明；setter 改分类，切回设置模式不重设", () => {
    const store = storeWith(fakeDataSource());
    expect(store.getState().settingsSection).toBe("general");
    expect(store.getState().projectSettingsSection).toBe("context");
    store.getState().setSettingsSection("cli");
    store.getState().setProjectSettingsSection("workflow");
    store.getState().setBoardView("board");
    store.getState().setBoardView("settings");
    expect(store.getState().settingsSection).toBe("cli");
    store.getState().setBoardView("project-settings");
    expect(store.getState().projectSettingsSection).toBe("workflow");
  });

  it("openSettingsUpdate 切到设置模式的更新页并举旗 focusUpdater", () => {
    const store = storeWith(fakeDataSource());
    store.getState().openSettingsUpdate();
    expect(store.getState().boardView).toBe("settings");
    expect(store.getState().settingsSection).toBe("updates");
    expect(store.getState().focusUpdater).toBe(true);
  });

  it("openConnectionReauth 切到设置模式的服务器页并聚焦该连接", () => {
    const store = storeWith(fakeDataSource());
    store.getState().openConnectionReauth("c1");
    expect(store.getState().boardView).toBe("settings");
    expect(store.getState().settingsSection).toBe("servers");
    expect(store.getState().reauthConnectionId).toBe("c1");
  });

  it("进入设置模式记下来处，两种设置模式之间切换不改写；leaveSettings 回到来处", () => {
    const store = storeWith(fakeDataSource());
    expect(store.getState().settingsReturnView).toBe("board");
    store.getState().setBoardView("specs");
    store.getState().setBoardView("project-settings");
    expect(store.getState().settingsReturnView).toBe("specs");
    store.getState().setBoardView("settings");
    expect(store.getState().settingsReturnView).toBe("specs");
    store.getState().leaveSettings();
    expect(store.getState().boardView).toBe("specs");
    // 其他入口（更新钮、重新登录）同样经 setBoardView，记下的是当时所在页。
    store.getState().setBoardView("manual");
    store.getState().openSettingsUpdate();
    store.getState().leaveSettings();
    expect(store.getState().boardView).toBe("manual");
  });

  describe("updaterAutoCheck", () => {
    const KEY = "specseal.updater.autoCheck";
    const updaterStore = () => {
      const check = vi.fn().mockResolvedValue(null);
      const store = trackedAppStore({ createSession: vi.fn() as never, updater: { check, relaunch: vi.fn() } });
      return { store, check };
    };

    it.each<[string | null, boolean]>([
      [null, true],
      ["false", false],
      ["true", true],
      ["0", true],
    ])("键 %j 读为 %s（坏值视为缺省开）", (stored, expected) => {
      if (stored !== null) localStorage.setItem(KEY, stored);
      expect(updaterStore().store.getState().updaterAutoCheck).toBe(expected);
    });

    it("setUpdaterAutoCheck 写回同一键", () => {
      const { store } = updaterStore();
      store.getState().setUpdaterAutoCheck(false);
      expect(store.getState().updaterAutoCheck).toBe(false);
      expect(localStorage.getItem(KEY)).toBe("false");
      store.getState().setUpdaterAutoCheck(true);
      expect(localStorage.getItem(KEY)).toBe("true");
    });

    it("关闭时背景检查与前景重检不调用端点，手动检查照常", async () => {
      localStorage.setItem(KEY, "false");
      const { store, check } = updaterStore();
      await store.getState().checkForUpdates(false);
      await store.getState().recheckOnFocus(Date.now() + 2 * 60 * 60 * 1000);
      expect(check).not.toHaveBeenCalled();
      expect(store.getState().updater).toEqual({ phase: "idle" });
      await store.getState().checkForUpdates(true);
      expect(check).toHaveBeenCalledTimes(1);
      expect(store.getState().updater).toEqual({ phase: "upToDate" });
    });
  });

  describe("defaultConnectionId", () => {
    const KEY = "specseal.defaultConnection";

    it("无键为 null；有键读回 connection id", () => {
      expect(storeWith(fakeDataSource()).getState().defaultConnectionId).toBeNull();
      localStorage.setItem(KEY, "c1");
      expect(storeWith(fakeDataSource()).getState().defaultConnectionId).toBe("c1");
    });

    it("setDefaultConnectionId 写入；设回 null 移除键", () => {
      const store = storeWith(fakeDataSource());
      store.getState().setDefaultConnectionId("c2");
      expect(store.getState().defaultConnectionId).toBe("c2");
      expect(localStorage.getItem(KEY)).toBe("c2");
      store.getState().setDefaultConnectionId(null);
      expect(store.getState().defaultConnectionId).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });
});

// desktop-about-page design D1：关于页的版本信息（一次取得并缓存）。
describe("关于页的版本信息", () => {
  const INFO = {
    appVersion: "0.8.0",
    engineVersion: "v1.44.0",
    platform: "macOS",
    arch: "arm64",
  };

  it("loadAppInfo 只调用 adapter 一次：并发与再次进页都沿用缓存", async () => {
    const loadAppInfo = vi.fn().mockResolvedValue(INFO);
    const store = trackedAppStore({ createSession: vi.fn() as never, loadAppInfo });
    expect(store.getState().appInfo).toBeNull();
    await Promise.all([store.getState().loadAppInfo(), store.getState().loadAppInfo()]);
    await store.getState().loadAppInfo();
    expect(loadAppInfo).toHaveBeenCalledTimes(1);
    expect(store.getState().appInfo).toEqual(INFO);
  });

  it("取得失败时维持 null，下次进页重取", async () => {
    const loadAppInfo = vi.fn().mockRejectedValueOnce(new Error("ipc down")).mockResolvedValueOnce(INFO);
    const store = trackedAppStore({ createSession: vi.fn() as never, loadAppInfo });
    await store.getState().loadAppInfo();
    expect(store.getState().appInfo).toBeNull();
    await store.getState().loadAppInfo();
    expect(loadAppInfo).toHaveBeenCalledTimes(2);
    expect(store.getState().appInfo).toEqual(INFO);
  });
});

// specseal 网址（desktop-deep-link「项目一律走 openProjectAt，详情等加载后再开」）：
// 调用端靠回传值知道是否进入了本机项目，再决定要不要开详情页。
describe("openProjectAt 的回传值", () => {
  function storeWithProbe(openProject: WorkspaceAdapter["openProject"], ds = fakeDataSource()) {
    return trackedAppStore({
      createSession: (root, name) => fakeSession(ds, root, name),
      workspace: fakeInstructionWorkspace({ openProject }),
    });
  }

  it("探测为本机项目：整批加载完成后才 resolve，值为该分页的 locator key", async () => {
    const load = deferred<ChangeListPayload>();
    const ds = fakeDataSource({ listChanges: vi.fn(() => load.promise) });
    const store = storeWithProbe(vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }), ds);
    let settled = false;
    const opening = store.getState().openProjectAt("B").then((key) => {
      settled = true;
      return key;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().activeKey).toBe("local:B");
    expect(settled).toBe(false);
    load.resolve(changeList([]));
    expect(await opening).toBe("local:B");
  });

  it.each([
    ["未初始化", { status: "uninitialized", dir: "C" }],
    ["未激活", { status: "unadopted", root: "C", needsImport: false }],
  ])("探测为%s：回传 null", async (_label, probe) => {
    const store = storeWithProbe(vi.fn().mockResolvedValue(probe));
    expect(await store.getState().openProjectAt("C")).toBeNull();
  });

  // Scenario「项目网址指向未初始化的文档夹」：确认框接手，主区维持原本的页面。
  it("探测为未初始化：开初始化确认框，主区维持原本的页面", async () => {
    const store = storeWithProbe(vi.fn().mockResolvedValue({ status: "uninitialized", dir: "C" }));
    store.getState().setBoardView("specs");
    await store.getState().openProjectAt("C");
    expect(store.getState().pendingInit).toBe("C");
    expect(store.getState().boardView).toBe("specs");
  });

  it("探测失败：回传 null", async () => {
    const store = storeWithProbe(vi.fn().mockRejectedValue(new Error("gone")));
    expect(await store.getState().openProjectAt("C")).toBeNull();
  });

  // 清单没载进来时，调用端不得把空清单当成「找不到目标」。
  it("整批加载失败：回传 null", async () => {
    const ds = fakeDataSource({ listChanges: vi.fn().mockRejectedValue(new Error("io")) });
    const store = storeWithProbe(vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }), ds);
    expect(await store.getState().openProjectAt("B")).toBeNull();
    expect(store.getState().loadFailed).toBe(true);
  });

  // 回传的 key 代表「现在可以拿这个项目的清单来用」：加载期间切走就不成立。
  it("加载期间用户切到别的分页：回传 null", async () => {
    const load = deferred<ChangeListPayload>();
    const ds = fakeDataSource({ listChanges: vi.fn(() => load.promise) });
    const store = storeWithProbe(vi.fn().mockResolvedValue({ status: "project", root: "B", name: "b" }), ds);
    const opening = store.getState().openProjectAt("B");
    await new Promise((r) => setTimeout(r, 0));
    store.setState({ activeKey: "local:A" });
    load.resolve(changeList([]));
    expect(await opening).toBeNull();
  });

  describe("带 remote 标记（已登录、checkout 已有工具选集）", () => {
    const MARKER = {
      status: "remoteBinding",
      url: "https://spec.example.test/api/specseal/v1/projects/demo",
      repo: "backend",
      hasLocalOpenspec: false,
    };
    function storeWithMarker() {
      const connections = {
        list: vi.fn().mockResolvedValue([
          { id: "c1", origin: "https://spec.example.test", name: "Team", loggedIn: true },
        ]),
        inspectCheckout: vi.fn().mockResolvedValue({ root: "/work/backend", tools: ["claude"] }),
        bindCheckout: vi.fn().mockResolvedValue("/work/backend"),
      } as unknown as ConnectionsAdapter;
      const openRemote = vi.fn().mockResolvedValue(remoteSession(fakeDataSource(), "backend"));
      const store = trackedAppStore({
        createSession: vi.fn() as never,
        workspace: fakeInstructionWorkspace({ openProject: vi.fn().mockResolvedValue(MARKER) }),
        connections,
        openRemote,
      });
      return { store, connections, openRemote };
    }

    it("既有流程自动同步并开 remote 分页：回传 null", async () => {
      const { store, connections, openRemote } = storeWithMarker();
      expect(await store.getState().openProjectAt("/work/backend")).toBeNull();
      expect(connections.bindCheckout).toHaveBeenCalled();
      expect(openRemote).toHaveBeenCalled();
    });

    // specseal 网址入口：确认前零写入，交给用户在选择器确认。
    it("remoteViaChooser：改开选择器（预选连接、scope 与 checkout），不同步、不连接，回传 null", async () => {
      const { store, connections, openRemote } = storeWithMarker();
      expect(await store.getState().openProjectAt("/work/backend", { remoteViaChooser: true })).toBeNull();
      expect(connections.inspectCheckout).not.toHaveBeenCalled();
      expect(connections.bindCheckout).not.toHaveBeenCalled();
      expect(openRemote).not.toHaveBeenCalled();
      expect(store.getState().workspaceChooser).toEqual({
        initialConnectionId: "c1",
        initialScope: { projectKey: "demo", repoKey: "backend" },
        initialCheckoutPath: "/work/backend",
      });
    });
  });
});

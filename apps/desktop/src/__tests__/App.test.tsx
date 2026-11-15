import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, waitFor, fireEvent, within, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getVersion } from "@tauri-apps/api/app";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { App } from "../App";
import { buildShortcutList } from "../appMenu";
import { APP_MESSAGES } from "../i18n/messages";
import { detectPlatform } from "../platform";
import { RELEASE_NOTES } from "../release-notes/release-notes";
import { LOCAL_CAPABILITIES, type WorkspaceSession } from "../session";
import type { FsActionsAdapter } from "../adapter/fsActions";
import { REMOTE_CHECKOUT, REMOTE_STALE_PROBE, STALE_PROBE } from "./helpers/assetFixtures";
import { changeList, sharedBoardRequirement } from "./helpers/changeList";
import { editorText, typeInEditor } from "./helpers/codemirror";
import { REMOTE_KEY, fakeRemoteDs, fakeRemoteSession } from "./helpers/remoteFixtures";
import { expectToolCheckboxes } from "./helpers/toolCheckboxes";
import { gesture, gestureHandlers } from "./helpers/trackpadGesture";
import { dictionaryProblems, type SpecsealDataSource, type StatusReport } from "@specseal/ui";

// 仿真 Tauri 事件层：捕捉 workspace-changed 的订阅 handler，测试可手动触发；trackpad-gesture
// （触摸板手指按下／离开）交给共用替身，测试以 gesture() 触发。
const { workspaceHandlers } = vi.hoisted(() => ({
  workspaceHandlers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/event", async () => {
  const { subscribeGesture } = await import("./helpers/trackpadGesture");
  return {
    // 外观偏好切换时通知系统匣面板（desktop-settings-mode design D4）。
    emit: vi.fn(() => Promise.resolve()),
    listen: vi.fn((event: string, handler: () => void) => {
      if (event === "trackpad-gesture") return subscribeGesture(handler as never);
      if (event === "workspace-changed") workspaceHandlers.push(handler);
      return Promise.resolve(() => {
        const i = workspaceHandlers.indexOf(handler);
        if (i >= 0) workspaceHandlers.splice(i, 1);
      });
    }),
  };
});

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
/** 在指定平台下跑一段测试：App 挂载时以 userAgent 判定平台，跑完还原。 */
async function onPlatform(ua: string, body: () => Promise<void>) {
  const spy = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
}
/** 手指按着向右滑 200px：四个 deltaX -50 的 wheel（自然卷动下手指向右＝deltaX 为负）。 */
const swipeRight = () =>
  act(() => {
    for (let i = 0; i < 4; i++) window.dispatchEvent(new WheelEvent("wheel", { deltaX: -50, bubbles: true }));
  });
const swipeIndicator = () => document.querySelector("[data-swipe-back]") as HTMLElement;

// app 版本查找（侧栏与设置页的现版号）：jsdom 无 Tauri IPC，以固定版本仿真。
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
}));

// macOS 原生菜单（desktop-native-menu）：拦下 installAppMenu，取得 App 每次安装传入的 deps
// （dispatch、t、hasProject）与取消函数的调用；菜单模型本身由 appMenu.test 承载。
const { appMenuSpy, windowSpy } = vi.hoisted(() => ({
  appMenuSpy: {
    deps: [] as Array<Parameters<typeof import("../appMenu").installAppMenu>[0]>,
    cancel: vi.fn(),
  },
  windowSpy: {
    isFocused: vi.fn(),
    setFocus: vi.fn(),
    // Windows 自绘窗口钮（TitleBar 的 WindowControls）挂载时读最大化状态并订阅 resize。
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
  },
}));
vi.mock("../appMenu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../appMenu")>()),
  installAppMenu: (deps: (typeof appMenuSpy.deps)[number]) => {
    appMenuSpy.deps.push(deps);
    return appMenuSpy.cancel;
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
// specseal 网址（desktop-deep-link）：jsdom 无 Tauri IPC，插件换成不带任何网址的假模块；
// 派送行为由 deepLink.test 承载。
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn().mockResolvedValue(null),
  onOpenUrl: vi.fn().mockResolvedValue(() => {}),
}));

// 系统匣（tray-status-menu）：jsdom 载不了原生图标，initTray 原本就会失败而静默降级。
// 这里改为捕捉 App 交给系统匣的 store，测试以它调用系统匣「打开此变更」所走的同一个动作。
const { traySpy } = vi.hoisted(() => ({
  traySpy: { store: null as null | { getState: () => { openDetail: (name: string) => void } } },
}));
vi.mock("../tray", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tray")>()),
  initTray: (store: NonNullable<typeof traySpy.store>) => {
    traySpy.store = store;
    return Promise.resolve({ dispose: () => {} });
  },
}));
// 菜单「关闭项目」只在主窗口为焦点时动作：jsdom 无 Tauri 窗口，以可控的焦点状态仿真。
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => windowSpy,
}));

// 两种详情页的 pass-through spy：捕捉 props（验证刷新世代下发）后照常渲染原组件；
// Toaster 以 marker 验证由 App 根层挂载，行为集成由 packages/ui 测试承载。
const { pageSpy, toasterSpy } = vi.hoisted(() => ({
  pageSpy: { change: [] as Array<Record<string, unknown>>, disc: [] as Array<Record<string, unknown>> },
  toasterSpy: vi.fn(),
}));
vi.mock("@specseal/ui", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@specseal/ui")>();
  return {
    ...mod,
    ChangeDetailPage: (props: never) => {
      pageSpy.change.push(props);
      return <mod.ChangeDetailPage {...(props as object) as Parameters<typeof mod.ChangeDetailPage>[0]} />;
    },
    DiscussionDetailPage: (props: never) => {
      pageSpy.disc.push(props);
      return <mod.DiscussionDetailPage {...(props as object) as Parameters<typeof mod.DiscussionDetailPage>[0]} />;
    },
    Toaster: () => {
      toasterSpy();
      return <div data-testid="app-toaster" />;
    },
  };
});

beforeEach(() => {
  workspaceHandlers.length = 0;
  gestureHandlers.length = 0;
  pageSpy.change.length = 0;
  pageSpy.disc.length = 0;
  toasterSpy.mockClear();
  appMenuSpy.deps.length = 0;
  appMenuSpy.cancel.mockClear();
  windowSpy.isFocused.mockReset().mockResolvedValue(true);
  // 各测试自行预置分页持久化；先清掉避免跨测试泄漏。
  localStorage.removeItem("specseal.projectTabs");
  // 技能档提示的「保留现状」记忆也是 localStorage：清掉，免得一条测试按过
  // 保留现状就让后面期待提示出现的测试依运行顺序逾时。
  localStorage.removeItem("specseal.instructionSkips");
  // 清单每页笔数记忆（desktop-list-pages-reskin design D7）同样跨测试泄漏。
  localStorage.removeItem("specseal.list.pageSizes");
  // jsdom 的 navigator.language 为 en-US；既有中文断言以明示偏好 zh-CN 固定 UI 语言。
  localStorage.setItem("specseal.uiLocale", "zh-CN");
});

// workspace 探测面 mock（workspace-session 决策 6）：缺省非项目语境——
// openProject 拒绝、startupDir 拒绝（首启回退维持零分页）。
function fakeWorkspace() {
  return {
    openProject: vi.fn().mockRejectedValue("not a project"),
    initProject: vi.fn(),
    adoptProject: vi.fn(),
    startupDir: vi.fn().mockRejectedValue("startup dir unavailable in this fake"),
    projectStats: vi.fn().mockResolvedValue({ pendingWrapUp: 0 }),
    watchWorkspace: vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
  };
}

/** 技能档探测回报过期（3 个受管档有异）的 workspace 面：store 带 assetPrompt（kind stale、fileCount 3）。 */
function staleWorkspace() {
  return {
    ...fakeWorkspace(),
    openProject: vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" }),
    probeAssets: vi.fn().mockResolvedValue({
      ...STALE_PROBE,
      differingFiles: [...STALE_PROBE.differingFiles, ".claude/skills/specseal-propose/SKILL.md"],
    }),
    updateAssets: vi.fn().mockResolvedValue({ migrated: { movedFolder: false, renamed: 0 } }),
  };
}

/** 活跃 session 的设置面 mock（设置页经 session.settings 读写）。 */
function fakeSettings() {
  return {
    readSettings: vi.fn().mockResolvedValue({
      app: { tools: [], customTools: [], parseError: null },
      workflow: {
        locale: null,
        specLocale: null,
        tdd: false,
        audit: false,
        context: null,
        rules: {},
        review: { baseline: "extend", critical: [], warning: [], suggestion: [] },
        reviewBaselineSmells: [],
        subagentModel: { review: {}, verify: {}, choices: {} },
        builtinSubagentModels: { claude: ["sonnet", "opus", "haiku", "fable"] },
        schemaArtifacts: ["proposal", "design", "specs", "tasks"],
        schemaName: "spec-driven",
        schemaKnown: true,
        parseError: null,
      },
    }),
    writeAppTools: vi.fn(),
    writeWorkflowConfig: vi.fn().mockResolvedValue(undefined),
    writeWorkflowContext: vi.fn(),
    writeWorkflowRules: vi.fn(),
    writeWorkflowReview: vi.fn(),
    writeWorkflowSubagentModel: vi.fn(),
    readSchemas: vi.fn().mockResolvedValue([]),
    writeWorkflowSchema: vi.fn().mockResolvedValue(undefined),
    forkSchema: vi.fn().mockResolvedValue("spec-driven-custom"),
    createSchema: vi.fn().mockResolvedValue(undefined),
    revealSchema: vi.fn().mockResolvedValue(undefined),
    deleteSchema: vi.fn().mockResolvedValue(undefined),
  };
}

/** session 工厂：dataSource 共用注入的 fake；events 订阅者收进 workspaceHandlers，
 * 测试以 workspaceHandlers.forEach((h) => h()) 仿真 workspace-changed。 */
function makeSession(ds: SpecsealDataSource, settings = fakeSettings()) {
  return (root: string, name: string): WorkspaceSession => ({
    id: `local:${root}`,
    locator: { kind: "local", root },
    descriptor: { name },
    dataSource: ds,
    settings: settings as never,
    events: {
      subscribe: (h: () => void) => {
        workspaceHandlers.push(h);
        return () => {
          const i = workspaceHandlers.indexOf(h);
          if (i >= 0) workspaceHandlers.splice(i, 1);
        };
      },
    },
    capabilities: LOCAL_CAPABILITIES,
  });
}

/** 预置单一项目分页 A（v2 持久化、activeKey 指向）并渲染 App——
 * 数据经活跃 session 的 dataSource 加载（App 无全域 dataSource）。 */
function renderApp(
  ds: SpecsealDataSource = fakeDataSource(),
  over: {
    ws?: ReturnType<typeof fakeWorkspace>;
    settings?: ReturnType<typeof fakeSettings>;
    updater?: { check: Mock; relaunch: Mock };
    loadAppInfo?: Mock;
    fsActions?: FsActionsAdapter;
  } = {},
) {
  localStorage.setItem(
    "specseal.projectTabs",
    JSON.stringify({
      version: 2,
      tabs: [{ locator: { kind: "local", root: "A" }, name: "proj-a" }],
      activeKey: "local:A",
    }),
  );
  const ws = over.ws ?? fakeWorkspace();
  if (!over.ws) {
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
  }
  const settings = over.settings ?? fakeSettings();
  render(
    <App
      createSession={makeSession(ds, settings)}
      workspace={ws as never}
      updater={over.updater as never}
      loadAppInfo={over.loadAppInfo as never}
      fsActions={over.fsActions}
    />,
  );
  return { ds, ws, settings };
}

/** 壳（design D2）：项目栏是带「项目导览」标签的 nav；设置入口是图标列底部齿轮。 */
const projectColumn = () => screen.getByRole("navigation", { name: "项目导览" });
const settingsColumn = () => screen.getByRole("navigation", { name: "设置分类" });
const projectSettingsColumn = () => screen.getByRole("navigation", { name: "项目设置分类" });
const crumbText = () =>
  (screen.getByTestId("main-titlebar").querySelector("nav")?.textContent ?? "").replace(/\s+/g, "");
// 只在图标列内找：设置模式的面包屑「设置」也是按钮。
const settingsGear = () =>
  within(document.querySelector("[data-project-rail]") as HTMLElement).getByRole("button", { name: "设置" });
/** 设置页的列右侧下拉（Radix Select）：打开并选取一项。 */
async function pickOption(combobox: string, option: string) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(await screen.findByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}
/** 左侧整栏（标题列＋图标列＋项目栏）。 */
const leftSide = () => screen.getByTestId("left-titlebar").parentElement as HTMLElement;

const STATUS: StatusReport = {
  changeName: "desktop-shell-and-browser",
  schemaName: "spec-driven",
  isComplete: false,
  applyRequires: ["tasks"],
  artifacts: [],
};

function fakeDataSource(over: Partial<SpecsealDataSource> = {}): SpecsealDataSource {
  return {
    listChanges: vi.fn().mockResolvedValue(changeList([
      { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 30 },
    ])),
    listSpecs: vi.fn().mockResolvedValue([{ id: "desktop-app" }]),
    listArchived: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue(STATUS),
    getDocument: vi.fn().mockResolvedValue("## Why\nhello body"),
    getSpecDocument: vi.fn().mockResolvedValue("# spec"),
    searchWorkspace: vi.fn().mockResolvedValue([]),
    changeCapabilities: vi.fn().mockResolvedValue(["desktop-app"]),
    changeMeta: vi.fn().mockResolvedValue({ created: "2026-07-05", createdBy: "MomoChen", createdWith: "claude" }),
    deleteChange: vi.fn().mockResolvedValue(undefined),
    setTaskDone: vi.fn().mockResolvedValue(undefined),
    setAllTasks: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    runVerb: vi.fn().mockResolvedValue({ valid: true }),
    getArchivedDocument: vi.fn().mockResolvedValue(null),
    archivedCapabilities: vi.fn().mockResolvedValue([]),
    getStationTicket: vi.fn().mockResolvedValue(null),
    getArchivedStationTicket: vi.fn().mockResolvedValue(null),
    listDiscussions: vi.fn().mockResolvedValue({ active: [], archived: [] }),
    getDiscussionDocument: vi.fn().mockResolvedValue(null),
    promoteDiscussion: vi.fn().mockResolvedValue({ change: "promoted-change" }),
    archiveDiscussion: vi.fn().mockResolvedValue(undefined),
    reorderCard: vi.fn().mockResolvedValue(undefined),
    setDepends: vi.fn().mockResolvedValue(undefined),
    revertChangeToProposed: vi.fn().mockResolvedValue(undefined),
    listManualPages: vi
      .fn()
      .mockResolvedValue({ present: false, reason: null, pages: [], uncoveredNew: [], malformed: [] }),
    getManualPage: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

/** 手册索引 fixture（desktop-manual-page）：两个分区、一页 stale。 */
const MANUAL_INDEX = {
  present: true,
  reason: null,
  pages: [
    {
      slug: "index",
      title: "手册",
      section: "开始使用",
      order: 10,
      keywords: [],
      sources: [],
      generated: "2026-09-01",
      stale: false,
    },
    {
      slug: "boards",
      title: "看板",
      section: "日常操作",
      order: 20,
      keywords: ["kanban"],
      sources: ["desktop-app"],
      generated: "2026-09-01",
      stale: true,
    },
  ],
  uncoveredNew: [],
  malformed: [],
};

describe("App (kanban primary + rich detail)", () => {
  it("根层挂载 Toaster，主区顶列不含操作结果文本节点", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId("app-toaster")).toBeTruthy());
    expect(toasterSpy).toHaveBeenCalledTimes(1);

    const bar = screen.getByTestId("main-titlebar");
    expect(bar.querySelector(".font-mono")).toBeNull();
  });

  // spec desktop-app「侧栏导览结构」：图标列顶端是共用组件库的品牌标记；壳上不再有横式字标
  // （字标只在零项目空状态）。
  it("图标列顶端为共用 BrandMark，有项目时壳上无横式字标", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const rail = document.querySelector("[data-project-rail]") as HTMLElement;
    expect(rail.firstElementChild?.getAttribute("aria-label")).toBe("Specseal");
    expect(document.querySelector('img[alt="Specseal"]')).toBeNull();
  });

  it("renders the kanban board by default with change cards", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText("desktop-shell-and-browser")).toBeTruthy());
    // 看板字段存在
    expect(document.querySelector('[data-column="ready"]')).toBeTruthy();
  });

  it("opens the rich detail drawer with metadata when a card is clicked", async () => {
    const ds = fakeDataSource();
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(screen.getByText("desktop-shell-and-browser"));
    await waitFor(() => expect(screen.getByText("MomoChen")).toBeTruthy());
    expect(ds.changeMeta).toHaveBeenCalledWith("desktop-shell-and-browser");
  });

  it("清单 payload 带 planError 时看板出现成环提示列（宿主自 payload 传入）", async () => {
    // spec desktop-app「依赖成环时看板提示」Scenario「成环提示」。
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(
        changeList(
          [{ name: "add-a", status: "in-progress", totalTasks: 3, completedTasks: 0 }],
          "dependency cycle: add-a -> add-b -> add-a",
        ),
      ),
    });
    renderApp(ds);
    // 看板页同时挂着隐藏的路线图（desktop-roadmap）：成环提示以卡片查看为准。
    const cards = () => within(screen.getByTestId("board-cards"));
    await waitFor(() => cards().getByText("依赖成环：dependency cycle: add-a -> add-b -> add-a"));
    expect(cards().getByText("add-a")).toBeTruthy();
  });

  it("数据源提供 dependsCandidates 时，调度分页的添加候选取自它（宿主接线）", async () => {
    // spec desktop-app Scenario「worktree 映射时候选来自副本名册」的宿主面：看板清单有
    // add-auth 与 add-late，名册查找只回 add-auth——添加下拉只列 add-auth。
    const item = (name: string) => ({
      name,
      status: "in-progress",
      totalTasks: 3,
      completedTasks: 0,
      wave: 1,
      blockedBy: [],
      dependsOn: [],
      overlaps: [],
    });
    const dependsCandidates = vi.fn().mockResolvedValue(["add-auth"]);
    const ds = fakeDataSource({
      listChanges: vi
        .fn()
        .mockResolvedValue(changeList([item("add-dark-mode"), item("add-auth"), item("add-late")])),
      dependsCandidates,
    });
    renderApp(ds);
    // 带波次的变更也是隐藏路线图上的站（desktop-roadmap）：点卡片查看的卡。
    fireEvent.click(await within(await screen.findByTestId("board-cards")).findByText("add-dark-mode"));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /调度/ }));
    await waitFor(() => expect(dependsCandidates).toHaveBeenCalledWith("add-dark-mode"));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole("combobox", { name: "添加前置" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["add-auth"]);
  });

  it("local 清单项带齐调度字段时，调度分页的重叠卡与封存顺序卡显示其内容", async () => {
    // spec client-protocol「变更清单的调度字段」的宿主面：list_changes payload 原样进抽屉——
    // add-b 与 add-c 同动「看板与任务」，add-b 排在 add-c 之后封存。
    const item = (name: string, other: string, archiveAfter: string[]) => ({
      name,
      status: "in-progress",
      totalTasks: 3,
      completedTasks: 0,
      wave: 1,
      blockedBy: [],
      dependsOn: [],
      overlaps: [{ change: other, capabilities: ["desktop-app"] }],
      requirementOverlap: [sharedBoardRequirement(other)],
      archiveAfter,
    });
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([item("add-c", "add-b", []), item("add-b", "add-c", ["add-c"])])),
    });
    renderApp(ds);
    fireEvent.click(await within(await screen.findByTestId("board-cards")).findByText("add-b"));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /调度/ }));
    const section = (name: string) => document.querySelector(`[data-plan-section="${name}"]`) as HTMLElement;
    await waitFor(() => expect(section("archive")).toBeTruthy());
    const overlaps = section("overlaps");
    expect(within(overlaps).getByText("add-c")).toBeTruthy();
    expect(within(overlaps).getByText("desktop-app › 看板与任务")).toBeTruthy();
    expect(within(overlaps).getAllByText("修改")).toHaveLength(2);
    const archive = section("archive");
    expect(within(archive).getByText("add-c")).toBeTruthy();
    expect(within(archive).getByText("先封存它们，再对照正式规格重写同名 requirement 后封存本变更")).toBeTruthy();
    // design Implementation Contract 行为 2：第 1 波、可以开工、尚无前置与添加下拉。
    expect(within(section("wave")).getByText("第 1 波")).toBeTruthy();
    const depends = section("depends");
    expect(within(depends).getByText("可以开工")).toBeTruthy();
    expect(within(depends).getByText("尚无前置")).toBeTruthy();
    expect(within(depends).getByRole("combobox", { name: "添加前置" })).toBeTruthy();
  });

  it("delete flow: 详情页「⋯」删除 → confirm dialog → deleteChange called", async () => {
    // 阶段守门后删除项仅提案中可选（archive-readiness-gating）——改用提案中 fixture。
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 0 },
      ])),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(screen.getByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // 变更层动作经插槽进主区标题列（desktop-detail-doc-tree design D3）。
    await user.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "更多动作" }));
    await user.click(await screen.findByRole("menuitem", { name: /删除/ }));
    // 确认对话框
    await waitFor(() => screen.getByText("删除变更？"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(ds.deleteChange).toHaveBeenCalledWith("desktop-shell-and-browser"));
  });

  it("revert flow: 进行中卡「退回提案中」→ 确认 → revertChangeToProposed called", async () => {
    // spec Scenario「零痕迹变更确认后退回提案中栏」的前半:点击先出确认,
    // 确认后才调用 adapter(UI 不预判守门)。
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "oops-started", status: "in-progress", totalTasks: 10, completedTasks: 0, startedAt: "2026-07-30" },
      ])),
    });
    renderApp(ds);
    const card = (await screen.findByText("oops-started")).closest("[data-change]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /退回提案中/ }));
    // 点击先出确认——adapter 尚未被调用。
    expect(ds.revertChangeToProposed).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "退回" }));
    await waitFor(() => expect(ds.revertChangeToProposed).toHaveBeenCalledWith("oops-started"));
  });

  it("revert blocked: 守门拒绝开对话框列证据,无任何清理或强制退回按钮", async () => {
    // spec Scenario「有工作痕迹时显示守门对话框」。
    const { RevertBlockedError } = await import("@specseal/ui");
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "oops-started", status: "in-progress", totalTasks: 10, completedTasks: 3, startedAt: "2026-07-30" },
      ])),
      revertChangeToProposed: vi
        .fn()
        .mockRejectedValue(
          new RevertBlockedError({ checkedTasks: 3, touchedFiles: ["src/a.rs", "src/b.ts"] }),
        ),
    });
    renderApp(ds);
    const card = (await screen.findByText("oops-started")).closest("[data-change]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /退回提案中/ }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "退回" }));
    // 守门对话框:列出已勾任务数与 touched 文档清单。
    await waitFor(() => expect(screen.getByText(/src\/a\.rs/)).toBeTruthy());
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("3");
    expect(dialog.textContent).toContain("src/b.ts");
    // 无清理/强制退回的机械出路——唯一按钮只负责关闭。
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    // 卡片停留在进行中栏。
    expect(document.querySelector('[data-column="in-progress"]')?.textContent).toContain(
      "oops-started",
    );
  });

  it("封存失败时详情页维持打开；确认在途时 Esc 不关页", async () => {
    let rejectArchive!: (reason: unknown) => void;
    const ds = fakeDataSource({
      runVerb: vi.fn().mockImplementation(
        () => new Promise((_, reject) => {
          rejectArchive = reject;
        }),
      ),
    });
    renderApp(ds);
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    // 变更层动作经插槽进主区标题列（desktop-detail-doc-tree design D3）。
    fireEvent.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "封存" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser"));
    // 确认在途：确认框收合的 Esc 尾巴不得关页，成功／失败由 store 决定。
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getByTestId("detail-page")).toBeTruthy();
    await act(async () => {
      rejectArchive(new Error("archive prerequisites missing"));
    });
    expect(screen.getByTestId("detail-page")).toBeTruthy();
  });

  it("passes an increasing refreshGen generation to the open detail pages", async () => {
    // design D1：世代自 store 经 props 下发，内容组件据此重载（重载行为由 packages/ui 测试承载）。
    renderApp(
      fakeDataSource({
        listDiscussions: vi.fn().mockResolvedValue({
          active: [
            { slug: "topic-a", topic: "Topic A", status: "open", rounds: 1, created: "2026-07-17", promotedTo: [] },
          ],
          archived: [],
        }),
      }),
    );
    await waitFor(() => expect(workspaceHandlers.length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await waitFor(() => expect(pageSpy.change.length).toBeGreaterThan(0));
    const before = pageSpy.change[pageSpy.change.length - 1].refreshGen as number;
    expect(typeof before).toBe("number");
    workspaceHandlers.forEach((h) => h());
    await waitFor(() =>
      expect(pageSpy.change[pageSpy.change.length - 1].refreshGen as number).toBeGreaterThan(before),
    );
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    fireEvent.click(await screen.findByText("Topic A"));
    await waitFor(() => expect(pageSpy.disc.length).toBeGreaterThan(0));
    const discBefore = pageSpy.disc[pageSpy.disc.length - 1].refreshGen as number;
    workspaceHandlers.forEach((h) => h());
    await waitFor(() =>
      expect(pageSpy.disc[pageSpy.disc.length - 1].refreshGen as number).toBeGreaterThan(discBefore),
    );
  });

  it("workspace-changed event triggers a full refresh (external writers reflected)", async () => {
    const ds = fakeDataSource();
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    await waitFor(() => expect(workspaceHandlers.length).toBeGreaterThan(0));
    const before = (ds.listChanges as Mock).mock.calls.length;
    // 仿真文档监看发出的 Tauri 事件（外部 CLI/agent 写入后）。
    workspaceHandlers.forEach((h) => h());
    await waitFor(() =>
      expect((ds.listChanges as Mock).mock.calls.length).toBeGreaterThan(before)
    );
    expect((ds.listArchived as Mock).mock.calls.length).toBeGreaterThan(1);
  });

  it("GUI 撤除 promote：concluded 讨论卡无「转为变更」，且无转为变更确认框（D3）", async () => {
    const ds = fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          { slug: "settled", topic: "Settled topic", status: "concluded", rounds: 2, created: "2026-07-01", promotedTo: [] },
        ],
        archived: [],
      }),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("Settled topic"));
    // 转为变更动词与确认框皆已撤除；转出改由 CLI／agent。
    expect(screen.queryByRole("button", { name: /转为变更/ })).toBeNull();
    expect(screen.queryByText("转为变更？")).toBeNull();
    expect(ds.promoteDiscussion).not.toHaveBeenCalled();
    // 封存动词仍在（concluded 卡）。
    const card = screen.getByText("Settled topic").closest("[data-discussion]") as HTMLElement;
    expect(within(card).getByRole("button", { name: /封存/ })).toBeTruthy();
  });

  it("archive-discussion flow: 讨论卡「封存」→ 确认（用户语言）→ archiveDiscussion called", async () => {
    const ds = fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          { slug: "settled", topic: "Settled topic", status: "concluded", rounds: 2, created: "2026-07-01", promotedTo: [] },
        ],
        archived: [],
      }),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("Settled topic"));
    const card = screen.getByText("Settled topic").closest("[data-discussion]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /^封存$/ }));
    await waitFor(() => screen.getByText("封存讨论？"));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("已封存页");
    expect(dialog.textContent).not.toContain("discussions/archive");
    fireEvent.click(within(dialog).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.archiveDiscussion).toHaveBeenCalledWith("settled"));
  });

  it("零分页（注入 workspace）：显示空状态引导页，经 chooser 沿用本机打开", async () => {
    const ws = fakeWorkspace();
    const ds = fakeDataSource({ listChanges: vi.fn().mockResolvedValue(changeList([])) });
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    // 空状态与图标列「＋」皆汇流至添加项目对话框，选本机卡后按「选择文档夹…」。
    const openButtons = screen.getAllByText("添加项目");
    fireEvent.click(openButtons[openButtons.length - 1]);
    const chooser = await screen.findByRole("alertdialog");
    fireEvent.click(within(chooser).getByRole("button", { name: /本机文档夹/ }));
    fireEvent.click(within(chooser).getByRole("button", { name: "选择文档夹…" }));
    await waitFor(() => expect(ws.pickFolder).toHaveBeenCalled());
  });

  it("零分页空状态「连接 Server」开对话框并直接呈现 Server 步骤（步骤条第 2 步）", async () => {
    const ws = fakeWorkspace();
    render(<App createSession={makeSession(fakeDataSource())} workspace={ws as never} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 Server" }));
    const chooser = await screen.findByRole("alertdialog");
    expect(within(chooser).getByText("选择 Server")).toBeTruthy();
    expect(within(chooser).getByText("步骤 2 / 4")).toBeTruthy();
  });

  // spec「表单控制项与按钮以主题化组件呈现」Scenario「初始化对话框工具多选主题化」
  it("初始化对话框的工具多选为主题化 checkbox：缺省勾 claude、可独立切换", async () => {
    const ws = fakeWorkspace();
    ws.pickFolder = vi.fn().mockResolvedValue("D:/newproj");
    ws.openProject = vi.fn().mockResolvedValue({ status: "uninitialized", dir: "D:/newproj" });
    const ds = fakeDataSource({ listChanges: vi.fn().mockResolvedValue(changeList([])) });
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    const openButtons = await screen.findAllByText("添加项目");
    fireEvent.click(openButtons[openButtons.length - 1]);
    const chooser = await screen.findByRole("alertdialog");
    fireEvent.click(within(chooser).getByRole("button", { name: /本机文档夹/ }));
    fireEvent.click(within(chooser).getByRole("button", { name: "选择文档夹…" }));
    // chooser 关闭有离场动画；等待初始化框的专属控制项，避免抓到尚未卸载的 chooser。
    const claude = await screen.findByRole("checkbox", { name: "claude" });
    const dialog = claude.closest('[role="alertdialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    // spec「未初始化目录经确认后自动初始化」：说明文本写明会创建 specseal/。
    expect(dialog.textContent).toContain("specseal/");
    expect(dialog.textContent).not.toContain("openspec/");
    const codex = within(dialog).getByRole("checkbox", { name: "codex" });
    // spec「未初始化目录经确认后自动初始化」：多选含 copilot，缺省只勾 claude。
    const copilot = within(dialog).getByRole("checkbox", { name: "copilot" });
    // 主题化原语（button 元素）而非原生 input。
    expect(claude.tagName).not.toBe("INPUT");
    // 缺省勾选状态与替换前相同：claude 勾、codex 未勾。
    expect(claude.getAttribute("aria-checked")).toBe("true");
    expect(codex.getAttribute("aria-checked")).toBe("false");
    expect(copilot.getAttribute("aria-checked")).toBe("false");
    // 五个勾选依 claude、codex、copilot、pi、cursor 顺序出现，缺省只勾 claude。
    expectToolCheckboxes(dialog, ["claude"]);
    // 可独立切换：勾 codex 不影响 claude；取消 claude 不影响 codex。
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(claude.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(claude);
    expect(claude.getAttribute("aria-checked")).toBe("false");
    expect(codex.getAttribute("aria-checked")).toBe("true");
  });

  // spec「未激活文档夹经确认后补齐激活」：激活确认框与初始化框同型、独立状态（决策 3）
  it("激活确认对话框：unadopted 探测开框、缺省勾 claude、确认以所选工具调用 adopt", async () => {
    const ws = fakeWorkspace();
    ws.pickFolder = vi.fn().mockResolvedValue("D:/migrated");
    ws.openProject = vi.fn().mockResolvedValue({ status: "unadopted", root: "D:/migrated", needsImport: false });
    ws.adoptProject = vi
      .fn()
      .mockResolvedValue({ status: "project", root: "D:/migrated", name: "migrated" });
    const ds = fakeDataSource({ listChanges: vi.fn().mockResolvedValue(changeList([])) });
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    const openButtons = await screen.findAllByText("添加项目");
    fireEvent.click(openButtons[openButtons.length - 1]);
    const chooser = await screen.findByRole("alertdialog");
    fireEvent.click(within(chooser).getByRole("button", { name: /本机文档夹/ }));
    fireEvent.click(within(chooser).getByRole("button", { name: "选择文档夹…" }));
    // chooser 关闭有离场动画；等待激活框的专属控制项。
    const claude = await screen.findByRole("checkbox", { name: "claude" });
    const dialog = claude.closest('[role="alertdialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    // 激活语意文案（非初始化文案）。
    expect(within(dialog).getByText("激活 specseal？")).toBeTruthy();
    // 规格文档夹已是 specseal/：没有改名说明。
    expect(dialog.textContent).not.toContain("OpenSpec CLI");
    // 工具多选缺省勾 claude、codex 未勾。
    expect(claude.getAttribute("aria-checked")).toBe("true");
    const codex = within(dialog).getByRole("checkbox", { name: "codex" });
    expect(codex.getAttribute("aria-checked")).toBe("false");
    // 多选含 copilot、缺省未勾。
    const copilot = within(dialog).getByRole("checkbox", { name: "copilot" });
    expect(copilot.getAttribute("aria-checked")).toBe("false");
    // 五个勾选依 claude、codex、copilot、pi、cursor 顺序出现，缺省只勾 claude。
    expectToolCheckboxes(dialog, ["claude"]);
    // 确认 → 以所选工具调用 adopt（而非 init）。
    fireEvent.click(within(dialog).getByRole("button", { name: "激活" }));
    await waitFor(() => expect(ws.adoptProject).toHaveBeenCalledWith("D:/migrated", ["claude"]));
    expect(ws.initProject).not.toHaveBeenCalled();
  });

  it("激活确认对话框：OpenSpec 项目写明 openspec/ 会改名为 specseal/、OpenSpec CLI 之后读不到", async () => {
    // spec「未激活文档夹经确认后补齐激活」Scenario「OpenSpec 项目确认激活后导入并切入」。
    const ws = fakeWorkspace();
    ws.pickFolder = vi.fn().mockResolvedValue("D:/legacy");
    ws.openProject = vi.fn().mockResolvedValue({ status: "unadopted", root: "D:/legacy", needsImport: true });
    const ds = fakeDataSource({ listChanges: vi.fn().mockResolvedValue(changeList([])) });
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    const openButtons = await screen.findAllByText("添加项目");
    fireEvent.click(openButtons[openButtons.length - 1]);
    const chooser = await screen.findByRole("alertdialog");
    fireEvent.click(within(chooser).getByRole("button", { name: /本机文档夹/ }));
    fireEvent.click(within(chooser).getByRole("button", { name: "选择文档夹…" }));
    const claude = await screen.findByRole("checkbox", { name: "claude" });
    const dialog = claude.closest('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("openspec/ 会改名为 specseal/");
    expect(dialog.textContent).toContain("OpenSpec CLI 之后读不到这个项目");
  });

  it("激活确认对话框：取消关框且零写入调用", async () => {
    const ws = fakeWorkspace();
    ws.pickFolder = vi.fn().mockResolvedValue("D:/migrated");
    ws.openProject = vi.fn().mockResolvedValue({ status: "unadopted", root: "D:/migrated", needsImport: false });
    const ds = fakeDataSource({ listChanges: vi.fn().mockResolvedValue(changeList([])) });
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    const openButtons = await screen.findAllByText("添加项目");
    fireEvent.click(openButtons[openButtons.length - 1]);
    const chooser = await screen.findByRole("alertdialog");
    fireEvent.click(within(chooser).getByRole("button", { name: /本机文档夹/ }));
    fireEvent.click(within(chooser).getByRole("button", { name: "选择文档夹…" }));
    const claude = await screen.findByRole("checkbox", { name: "claude" });
    const dialog = claude.closest('[role="alertdialog"]') as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "claude" })).toBeNull());
    expect(ws.adoptProject).not.toHaveBeenCalled();
    expect(ws.initProject).not.toHaveBeenCalled();
  });

  it("图标列方块：点背景方块切换后作用中标示、标题列项目名与面包屑同步更新", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        tabs: [
          { root: "A", name: "proj-a" },
          { root: "B", name: "proj-b" },
        ],
        activeRoot: "A",
      }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi
      .fn()
      .mockImplementation((p: string) =>
        Promise.resolve({ status: "project", root: p, name: p === "A" ? "proj-a" : "proj-b" }),
      );
    render(<App createSession={makeSession(fakeDataSource())} workspace={ws as never} />);
    const squareOf = (key: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-tab]")).find(
        (el) => el.getAttribute("data-tab") === key,
      ) as HTMLElement;
    await waitFor(() => expect(squareOf("local:A").getAttribute("data-active")).toBe("true"));
    expect(within(screen.getByTestId("left-titlebar")).getByText("proj-a")).toBeTruthy();
    fireEvent.click(squareOf("local:B"));
    await waitFor(() => expect(squareOf("local:B").getAttribute("data-active")).toBe("true"));
    expect(within(screen.getByTestId("left-titlebar")).getByText("proj-b")).toBeTruthy();
    expect(screen.getByTestId("main-titlebar").textContent).toBe("proj-b/变更");
  });

  it("切换 UI 语言即时全接口生效、持久化于本机且不触碰 config.yaml（spec 互不影响）", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({ tabs: [{ root: "A", name: "proj-a" }], activeRoot: "A" }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi
      .fn()
      .mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    const settings = fakeSettings();
    render(<App createSession={makeSession(fakeDataSource(), settings)} workspace={ws as never} />);
    // 开应用进程设置（缺省一般页）→ 显示语言列切 English。
    await waitFor(() => expect(crumbText()).toBe("proj-a/变更"));
    fireEvent.click(settingsGear());
    await pickOption("显示语言", "English");
    // 即时全接口生效：标题列、齿轮与设置分类栏改为英文。
    expect((await screen.findAllByText("Settings")).length).toBeGreaterThan(0);
    const rail = document.querySelector("[data-project-rail]") as HTMLElement;
    expect(within(rail).getByRole("button", { name: "Settings" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getByRole("button", { name: "General" })).toBeTruthy();
    // 持久化于 app 本机；config.yaml 未被触碰。
    expect(localStorage.getItem("specseal.uiLocale")).toBe("en");
    expect(settings.writeWorkflowConfig).not.toHaveBeenCalled();
  });

  it("写入 config locale 不改 UI 语言（spec 互不影响的反向）", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({ tabs: [{ root: "A", name: "proj-a" }], activeRoot: "A" }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi
      .fn()
      .mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    const settings = fakeSettings();
    render(<App createSession={makeSession(fakeDataSource(), settings)} workspace={ws as never} />);
    fireEvent.click(await screen.findByText("项目设置"));
    // locale 在产出流程页的产出政策卡。
    fireEvent.click(within(projectSettingsColumn()).getByRole("button", { name: "产出流程" }));
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByLabelText("locale"));
    await user.click(await screen.findByRole("option", { name: /^ja/ }));
    fireEvent.click(screen.getByTestId("save-workflow"));
    await waitFor(() =>
      expect(settings.writeWorkflowConfig).toHaveBeenCalledWith(
        expect.objectContaining({ locale: "ja" }),
      ),
    );
    // UI 语言不受影响：接口仍为 zh-CN、偏好键未被改动。
    expect(settingsGear()).toBeTruthy();
    expect(localStorage.getItem("specseal.uiLocale")).toBe("zh-CN");
  });

  it("archived entry in the sidebar jumps to the archived list", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-04-old-change", date: "2026-07-04", name: "old-change" },
      ]),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(screen.getByLabelText("已封存"));
    await waitFor(() => expect(screen.getByText("已封存的变更")).toBeTruthy());
    expect(screen.getByText("old-change")).toBeTruthy();
    expect(screen.getByText("2026-07-04")).toBeTruthy();
  });
});

describe("board search wiring（看板搜索接线）", () => {
  it("看板页以页标题区开头：标题「变更」与说明，搜索输入在同一列", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const heading = screen.getByRole("heading", { level: 2, name: "变更" });
    const header = heading.closest("[data-page-header]") as HTMLElement;
    expect(header.textContent).toContain("依生命周期分栏；拖曳排序，点卡片开详情。");
    expect(within(header).getByPlaceholderText("搜索看板卡片…")).toBeTruthy();
  });

  it("kanban view renders a search input that filters cards and reflects boardQuery", async () => {
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const input = screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    // 受控输入反映 store.boardQuery 的更新；卡片被过滤。
    expect(input.value).toBe("zzz-no-match");
    expect(screen.queryByText("desktop-shell-and-browser")).toBeNull();
    // 清空还原全量。
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("desktop-shell-and-browser")).toBeTruthy();
  });

  it("the archived page search input does not contain the board query (independence)", async () => {
    // spec「搜索字符串不跨启动保留且与已封存页独立」的独立性半边；
    // 不跨启动由 store 无 persist 保证（store.test.ts 1.x）。
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.change(screen.getByPlaceholderText("搜索看板卡片…"), {
      target: { value: "kanban-only" },
    });
    fireEvent.click(screen.getByLabelText("已封存"));
    await waitFor(() => expect(screen.getByText("已封存的变更")).toBeTruthy());
    const archInput = screen.getByPlaceholderText("搜索已封存的变更与讨论…") as HTMLInputElement;
    expect(archInput.value).toBe("");
  });
});

describe("sidebar navigation structure（侧栏导览结构）", () => {
  it("项目栏依序为变更/已封存/规格/手册与底部项目设置，不含设置与备忘；设置在图标列底部", async () => {
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    // 已封存项以 aria-label 为无障碍名称（徽章数字不污染），其余取文本内容。
    const labels = within(aside)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    expect(labels).toEqual(["变更", "已封存", "规格", "手册", "项目设置"]);
    expect(leftSide().className).toContain("w-[256px]");
    expect(screen.queryByText("备忘")).toBeNull();
    const rail = document.querySelector("[data-project-rail]") as HTMLElement;
    expect(rail.contains(settingsGear())).toBe(true);
    // 齿轮是图标列最后一个按钮（沉底的一组：更新钮＋齿轮，更新钮无事时不渲染）。
    const railButtons = within(rail).getAllByRole("button");
    expect(railButtons[railButtons.length - 1]).toBe(settingsGear());
    expect(rail.lastElementChild?.contains(settingsGear())).toBe(true);
    // 左侧标题列：作用中项目名与「⋯」项目动作钮。
    const titleBar = screen.getByTestId("left-titlebar");
    expect(within(titleBar).getByText("proj-a").getAttribute("title")).toBe("A");
    expect(within(titleBar).getByRole("button", { name: "项目动作" })).toBeTruthy();
  });

  it("项目设置沉底（自动上边距）；点齿轮进设置模式：项目栏换成设置分类栏、左侧标题列为「设置」、齿轮作用中", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const aside = projectColumn();
    const projectSettingsNav = within(aside).getByRole("button", { name: "项目设置" });
    // 弹性区隔：jsdom 无版面计算，以等效自动上边距 class 断言——沉底的是「提示卡＋项目设置」
    // 这一组（desktop-notice-relocation：技能档提示卡落在弹性空白与项目设置之间）。
    expect(projectSettingsNav.parentElement?.className).toContain("mt-auto");
    const changesNav = within(aside).getByRole("button", { name: "变更" });
    expect(changesNav.className).toContain("bg-primary");

    fireEvent.click(settingsGear());
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeNull());
    expect(settingsGear().className).toContain("bg-primary");
    expect(screen.queryByRole("navigation", { name: "项目导览" })).toBeNull();
    expect(within(settingsColumn()).getByRole("button", { name: "一般" }).getAttribute("aria-current")).toBe("page");
    const titleBar = screen.getByTestId("left-titlebar");
    expect(titleBar.textContent).toBe("设置");
    expect(within(titleBar).queryByRole("button", { name: "项目动作" })).toBeNull();
    // 面包屑「设置 / 分类名」，「设置」点回一般页。
    expect(crumbText()).toBe("设置/一般");
    fireEvent.click(within(settingsColumn()).getByRole("button", { name: "CLI" }));
    expect(crumbText()).toBe("设置/CLI");
    fireEvent.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "设置" }));
    expect(crumbText()).toBe("设置/一般");
    // 左侧标题列「← 设置」离开设置模式回看板。
    fireEvent.click(within(titleBar).getByRole("button", { name: "设置" }));
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(crumbText()).toBe("proj-a/变更");
    expect(settingsGear().className).not.toContain("bg-primary");
  });

  it("标题列「⋯」开项目动作菜单（与方块右键同一份）；选「关闭项目」关掉作用中项目", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    // Radix 菜单开着时 body 为 pointer-events: none（内容层照常可点）。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(
      within(screen.getByTestId("left-titlebar")).getByRole("button", { name: "项目动作" }),
    );
    const items = screen.getAllByRole("menuitem").map((i) => i.querySelector("span")?.textContent);
    expect(items).toEqual([
      "在文档管理员显示",
      "在终端机打开",
      "以编辑器打开",
      "拷贝路径",
      "刷新",
      "关闭项目",
    ]);
    await user.click(screen.getByRole("menuitem", { name: /^关闭项目/ }));
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "项目导览" })).toBeNull();
  });

  it("背景方块右键选「刷新」：切到该项目（切换即重新加载），不是重载作用中项目", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        tabs: [
          { root: "A", name: "proj-a" },
          { root: "B", name: "proj-b" },
        ],
        activeRoot: "A",
      }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi
      .fn()
      .mockImplementation((p: string) =>
        Promise.resolve({ status: "project", root: p, name: p === "A" ? "proj-a" : "proj-b" }),
      );
    render(<App createSession={makeSession(fakeDataSource())} workspace={ws as never} />);
    const squareOf = (key: string) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-tab]")).find(
        (el) => el.getAttribute("data-tab") === key,
      ) as HTMLElement;
    await waitFor(() => expect(squareOf("local:A").getAttribute("data-active")).toBe("true"));
    fireEvent.contextMenu(squareOf("local:B"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^刷新/ }));
    await waitFor(() => expect(squareOf("local:B").getAttribute("data-active")).toBe("true"));
  });

  it("Ctrl+R 刷新作用中项目、Ctrl+W 关闭作用中项目（Windows／Linux 的菜单快捷键）", async () => {
    const { ds } = renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const before = vi.mocked(ds.listChanges).mock.calls.length;
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    await waitFor(() => expect(vi.mocked(ds.listChanges).mock.calls.length).toBeGreaterThan(before));
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
  });

  it("macOS：⌘R 刷新；⌘W 不在网页层接（交给原生菜单），项目仍开着", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    try {
      const { ds } = renderApp();
      await screen.findByText("desktop-shell-and-browser");
      const before = vi.mocked(ds.listChanges).mock.calls.length;
      fireEvent.keyDown(window, { key: "r", metaKey: true });
      await waitFor(() =>
        expect(vi.mocked(ds.listChanges).mock.calls.length).toBeGreaterThan(before),
      );
      fireEvent.keyDown(window, { key: "w", metaKey: true });
      fireEvent.keyDown(window, { key: "w", ctrlKey: true });
      expect(screen.queryByText("打开一个项目开始")).toBeNull();
      expect(screen.getByTestId("left-titlebar").textContent).toContain("proj-a");
    } finally {
      ua.mockRestore();
    }
  });

  it("有新版本时窗口顶端无更新横幅：主区顶列之下直接是主内容（spec「窗口顶端 SHALL NOT 出现更新横幅」）", async () => {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    render(
      <App
        createSession={makeSession(fakeDataSource())}
        workspace={ws as never}
        updater={{
          check: vi.fn().mockResolvedValue({ version: "9.9.9", download: vi.fn(), install: vi.fn() }),
          relaunch: vi.fn(),
        }}
      />,
    );
    await screen.findByRole("button", { name: /有新版本 9\.9\.9/ });
    const titleBar = screen.getByTestId("main-titlebar");
    expect(titleBar.parentElement?.firstElementChild).toBe(titleBar);
    expect(titleBar.nextElementSibling?.tagName).toBe("MAIN");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("有新版本时图标列齿轮上方出现更新钮（提示带版号）；点击进设置页、齿轮作用中（spec「桌面自动更新」）", async () => {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    render(
      <App
        createSession={makeSession(fakeDataSource())}
        workspace={ws as never}
        updater={{
          check: vi.fn().mockResolvedValue({ version: "9.9.9", download: vi.fn(), install: vi.fn() }),
          relaunch: vi.fn(),
        }}
      />,
    );
    const button = await screen.findByRole("button", { name: /有新版本 9\.9\.9/ });
    const rail = document.querySelector("[data-project-rail]") as HTMLElement;
    expect(rail.contains(button)).toBe(true);
    // 齿轮上方：更新钮在文档顺序上先于齿轮。
    expect(button.compareDocumentPosition(settingsGear()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    // 进更新页，「下载与安装」卡承载下载控制。
    await waitFor(() => expect(screen.getByRole("region", { name: "下载与安装" })).toBeTruthy());
    expect(crumbText()).toBe("设置/更新");
    expect(settingsGear().className).toContain("bg-primary");
  });

  it("面包屑随页面切换，点项目名回看板", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const crumbs = screen.getByTestId("main-titlebar");
    expect(crumbs.textContent).toBe("proj-a/变更");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(crumbs.textContent).toBe("proj-a/规格"));
    fireEvent.click(within(crumbs).getByRole("button", { name: "proj-a" }));
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(crumbs.textContent).toBe("proj-a/变更");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "手册" }));
    await waitFor(() => expect(crumbs.textContent).toBe("proj-a/手册"));
  });

  it("面包屑随项目切换：A / 规格 → B / 规格（切项目保留所在页）", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        tabs: [
          { root: "A", name: "proj-a" },
          { root: "B", name: "proj-b" },
        ],
        activeRoot: "A",
      }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi
      .fn()
      .mockImplementation((p: string) =>
        Promise.resolve({ status: "project", root: p, name: p === "A" ? "proj-a" : "proj-b" }),
      );
    render(<App createSession={makeSession(fakeDataSource())} workspace={ws as never} />);
    const crumbs = await screen.findByTestId("main-titlebar");
    await waitFor(() => expect(crumbs.textContent).toBe("proj-a/变更"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(crumbs.textContent).toBe("proj-a/规格"));
    const squareB = Array.from(document.querySelectorAll<HTMLElement>("[data-tab]")).find(
      (el) => el.getAttribute("data-tab") === "local:B",
    ) as HTMLElement;
    fireEvent.click(squareB);
    await waitFor(() => expect(crumbs.textContent).toBe("proj-b/规格"));
  });

  it("点项目设置进项目设置模式：分类栏、面包屑三段、「← 项目设置」返回看板（spec「项目设置模式的分类栏与返回」）", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));

    const column = await waitFor(() => projectSettingsColumn());
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
    expect(screen.queryByRole("navigation", { name: "项目导览" })).toBeNull();
    expect(
      within(column)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["项目说明", "产出规则", "品质关卡", "审查规则", "子代理模型", "产出流程", "AI 工具"]);
    expect(within(column).getByRole("button", { name: "项目说明" }).getAttribute("aria-current")).toBe("page");
    expect(crumbText()).toBe("proj-a/项目设置/项目说明");
    // 两个子项的页在「项目设置」与页名之间多一段「品质关卡」，点了开审查规则页。
    fireEvent.click(within(column).getByRole("button", { name: "子代理模型" }));
    expect(crumbText()).toBe("proj-a/项目设置/品质关卡/子代理模型");
    fireEvent.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "品质关卡" }));
    expect(crumbText()).toBe("proj-a/项目设置/品质关卡/审查规则");
    expect(within(column).getByRole("button", { name: "审查规则" }).getAttribute("aria-current")).toBe("page");
    // 先离开审查规则页，点分类栏的「品质关卡」才分得出它有没有开审查规则页。
    fireEvent.click(within(column).getByRole("button", { name: "项目说明" }));
    expect(crumbText()).toBe("proj-a/项目设置/项目说明");
    fireEvent.click(within(column).getByRole("button", { name: "品质关卡" }));
    expect(crumbText()).toBe("proj-a/项目设置/品质关卡/审查规则");
    fireEvent.click(within(column).getByRole("button", { name: "产出流程" }));
    expect(crumbText()).toBe("proj-a/项目设置/产出流程");
    fireEvent.click(within(column).getByRole("button", { name: "AI 工具" }));
    // crumbText 会去掉所有空白，「AI 工具」比对成「AI工具」。
    expect(crumbText()).toBe("proj-a/项目设置/AI工具");
    // 「项目设置」段点回项目说明页。
    fireEvent.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "项目设置" }));
    expect(crumbText()).toBe("proj-a/项目设置/项目说明");

    const titleBar = screen.getByTestId("left-titlebar");
    expect(within(titleBar).getByText("proj-a").className).toContain("font-mono");
    fireEvent.click(within(titleBar).getByRole("button", { name: "项目设置" }));
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(within(projectColumn()).getByRole("button", { name: "变更" }).className).toContain("bg-primary");
    expect(crumbText()).toBe("proj-a/变更");
  });

  it("旧布局项目的项目设置分类栏组名仍是「工作流程」，规格文档夹只出现在页标题下的注记（spec「画面依实际规格文档夹与数据文档名显示」）", async () => {
    const settings = fakeSettings();
    const snap = await settings.readSettings();
    settings.readSettings.mockResolvedValue({ ...snap, specDir: "openspec" });
    renderApp(fakeDataSource(), { settings });
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));
    await waitFor(() => expect(screen.getByTestId("file-note-config").textContent).toBe("openspec/config.yaml · context"));
    const column = projectSettingsColumn();
    expect(within(column).getByText("工作流程")).toBeTruthy();
    expect(column.textContent).not.toContain("config.yaml");
  });

  it("项目设置停在 AI 工具时切到 remote 项目：退回项目说明（remote 没有该页）", async () => {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        version: 2,
        tabs: [
          { locator: { kind: "local", root: "A" }, name: "proj-a" },
          {
            locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
            name: "Demo/backend",
          },
        ],
        activeKey: REMOTE_KEY,
      }),
    );
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    const remote = {
      ...fakeRemoteSession(fakeRemoteDs()),
      settings: { ...fakeSettings(), kind: "remote", policyWrite: true },
    } as unknown as WorkspaceSession;
    render(
      <App
        createSession={makeSession(fakeDataSource())}
        openRemote={vi.fn(async () => remote)}
        workspace={ws as never}
      />,
    );
    // 先让 remote session 开好（没有 session 的 remote 分页切过去会重连并回看板）。
    await screen.findByText("remote-change");
    fireEvent.click(document.querySelector('[data-tab="local:A"]') as HTMLElement);
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));
    fireEvent.click(within(await waitFor(() => projectSettingsColumn())).getByRole("button", { name: "AI 工具" }));
    // crumbText 会去掉所有空白，「AI 工具」比对成「AI工具」。
    expect(crumbText()).toBe("proj-a/项目设置/AI工具");

    fireEvent.click(document.querySelector(`[data-tab="${REMOTE_KEY}"]`) as HTMLElement);
    await screen.findByTestId("context-page");
    expect(crumbText()).toBe("Demo/backend/项目设置/项目说明");
    expect(within(projectSettingsColumn()).getByRole("button", { name: "项目说明" }).getAttribute("aria-current")).toBe("page");
  });

  it("零分页：左侧只有图标列（无项目栏、无项目设置）；齿轮仍进入应用进程设置页", async () => {
    const ws = fakeWorkspace();
    render(<App createSession={makeSession(fakeDataSource())} workspace={ws as never} />);
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "项目导览" })).toBeNull();
    expect(screen.queryByRole("button", { name: "项目设置" })).toBeNull();
    // 左侧只剩 56px 图标列（macOS 标题列的红绿灯留白不得把它撑宽）。
    expect(leftSide().className).toContain("w-14");
    expect(screen.getByTestId("left-titlebar").textContent).toBe("");
    expect(screen.getByTestId("main-titlebar").textContent).toBe("");

    fireEvent.click(settingsGear());
    // 设置模式左侧恒为图标列加设置分类栏（零项目亦然；spec「零分页仍可进入应用进程设置」）。
    expect(within(settingsColumn()).getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByText("打开一个项目开始")).toBeNull();
    expect(settingsGear().className).toContain("bg-primary");
    expect(leftSide().className).toContain("w-[256px]");
    expect(screen.getByTestId("left-titlebar").textContent).toBe("设置");
    expect(crumbText()).toBe("设置/一般");
    // 零项目也能经「← 设置」离开，回到空状态。
    fireEvent.click(within(screen.getByTestId("left-titlebar")).getByRole("button", { name: "设置" }));
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    expect(leftSide().className).toContain("w-14");
  });

  it("macOS 设置模式与项目设置模式：触摸板向右滑过门槛、手指离开的当下等同返回钮，回到进入前的页面；看板上滑动不作用", () =>
    onPlatform(MAC_UA, async () => {
      renderApp();
      await screen.findByText("desktop-shell-and-browser");

      fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
      await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));
      fireEvent.click(settingsGear());
      await waitFor(() => settingsColumn());
      // 指示自主区左缘外推出：所在的主区栏要裁掉左缘外那段，否则会叠到分类栏上。
      expect(swipeIndicator().parentElement!.className).toContain("overflow-hidden");
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-armed")).toBe("true");
      expect(crumbText()).toBe("设置/一般");
      gesture("ended");
      expect(crumbText()).toBe("proj-a/规格");

      fireEvent.click(within(projectColumn()).getByRole("button", { name: "手册" }));
      fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));
      await waitFor(() => projectSettingsColumn());
      gesture("began");
      swipeRight();
      gesture("ended");
      expect(crumbText()).toBe("proj-a/手册");

      fireEvent.click(within(projectColumn()).getByRole("button", { name: "变更" }));
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-progress")).toBe("0.00");
      gesture("ended");
    }));

  it("Windows 设置模式：触摸板滑动不出现指示、不离开设置；Alt+← 才回到进入前的页面", () =>
    onPlatform(WINDOWS_UA, async () => {
      renderApp();
      await screen.findByText("desktop-shell-and-browser");
      fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
      await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));
      fireEvent.click(settingsGear());
      await waitFor(() => settingsColumn());
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-progress")).toBe("0.00");
      gesture("ended");
      expect(crumbText()).toBe("设置/一般");
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
      });
      await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));
    }));

  it("项目设置有未存修改时，返回先问要不要舍弃：取消留在原页且草稿还在，舍弃才回进入前的页面", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));
    fireEvent.click(await screen.findByTestId("context-edit"));
    typeInEditor(screen.getByTestId("context-input"), "新的说明");

    // 焦点已离开编辑器：Esc 走返回，先跳确认框。
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("要舍弃未保存的修改吗？")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(editorText(screen.getByTestId("context-input"))).toBe("新的说明");
    expect(crumbText()).toBe("proj-a/项目设置/项目说明");

    // 返回钮同样先问；舍弃后回到进入前的规格页。
    fireEvent.click(within(screen.getByTestId("left-titlebar")).getByRole("button", { name: "项目设置" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "舍弃" }));
    await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));
  });

  it("项目设置只开了编辑、没有改动时，返回不问直接离开", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "项目设置" }));
    fireEvent.click(await screen.findByTestId("context-edit"));
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(crumbText()).toBe("proj-a/变更"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("macOS 设置模式有对话框开着时，鼠标侧键与触摸板滑动不离开设置、不收掉对话框", () =>
    onPlatform(MAC_UA, async () => {
      renderApp();
      await screen.findByText("desktop-shell-and-browser");
      fireEvent.click(settingsGear());
      await waitFor(() => settingsColumn());
      const rail = document.querySelector("[data-project-rail]") as HTMLElement;
      fireEvent.click(within(rail).getByRole("button", { name: "添加项目" }));
      await screen.findByTestId("workspace-chooser");
      act(() => {
        fireEvent.mouseUp(window, { button: 3 });
      });
      gesture("began");
      swipeRight();
      gesture("ended");
      expect(screen.getByTestId("workspace-chooser")).toBeTruthy();
      expect(crumbText()).toBe("设置/一般");

      // 对话框关掉后滑动返回照常（开关不得卡在对话框还在时的判断）。
      fireEvent.click(within(screen.getByTestId("workspace-chooser")).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByTestId("workspace-chooser")).toBeNull());
      gesture("began");
      swipeRight();
      gesture("ended");
      expect(crumbText()).toBe("proj-a/变更");
    }));

  it("外观选深色：写入偏好、根元素套 data-theme、通知系统匣面板（spec「明示深色即时生效并持久化」）", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(settingsGear());
    await pickOption("外观", "深色");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("specseal.theme")).toBe("dark");
    expect(emit).toHaveBeenCalledWith("specseal:theme-changed", "dark");
    await pickOption("外观", "跟随系统");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("specseal.theme")).toBeNull();
    expect(emit).toHaveBeenLastCalledWith("specseal:theme-changed", null);
  });

  it("设置模式的 Esc、Alt+←（非 macOS）与鼠标侧键同返回钮；焦点在文本输入时不作用", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    const enterSettings = async () => {
      fireEvent.click(settingsGear());
      await waitFor(() => settingsColumn());
    };

    await enterSettings();
    fireEvent.keyDown(screen.getByPlaceholderText("搜索设置"), { key: "Escape" });
    expect(settingsColumn()).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));

    await enterSettings();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    });
    await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));

    await enterSettings();
    act(() => {
      fireEvent.mouseUp(window, { button: 3 });
    });
    await waitFor(() => expect(crumbText()).toBe("proj-a/规格"));

    // 没有返回去处的页面（规格清单本身）：返回操作都不作用。
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.mouseUp(window, { button: 3 });
    });
    expect(crumbText()).toBe("proj-a/规格");
  });

  it("已封存导览项带封存数量徽章，无障碍标签为「已封存」", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-04-old-change", date: "2026-07-04", name: "old-change" },
        { datedName: "2026-07-05-other-change", date: "2026-07-05", name: "other-change" },
      ]),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    const nav = within(aside).getByRole("button", { name: "已封存" });
    await waitFor(() => expect(nav.textContent).toContain("2"));
  });

  it("封存清单变动后徽章即时更新（workspace-changed 触发 refresh）", async () => {
    const archived: Array<{ datedName: string; date: string; name: string }> = [];
    const ds = fakeDataSource({
      listArchived: vi.fn().mockImplementation(() => Promise.resolve([...archived])),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    const nav = within(aside).getByRole("button", { name: "已封存" });
    expect(nav.textContent).toContain("0");
    // 仿真外部终端封存一个变更：文档监看发 workspace-changed → 整批 refresh。
    archived.push({ datedName: "2026-07-07-just-archived", date: "2026-07-07", name: "just-archived" });
    workspaceHandlers.forEach((h) => h());
    await waitFor(() => expect(nav.textContent).toContain("1"));
  });

  it("已封存导览为切页而非 toggle：再点停留在已封存页，点变更才返回看板", async () => {
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    const archivedNav = within(aside).getByRole("button", { name: "已封存" });
    fireEvent.click(archivedNav);
    await waitFor(() => expect(screen.getByText("已封存的变更")).toBeTruthy());
    // 再点一次：停留（非 toggle 返回看板），现行项维持高亮。
    fireEvent.click(archivedNav);
    expect(screen.getByText("已封存的变更")).toBeTruthy();
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
    expect(archivedNav.className).toContain("bg-primary");
    // 点「变更」返回看板：高亮转移到变更项、已封存项恢复未选采样式。
    const changesNav = within(aside).getByRole("button", { name: "变更" });
    fireEvent.click(changesNav);
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(changesNav.className).toContain("bg-primary");
    expect(archivedNav.className).not.toContain("bg-primary");
  });

  it("点导览「规格」进入规格页：主内容出现规格清单、导览项 active", async () => {
    // spec Scenario「进入规格页显卡片清单」：切页语意（与已封存页同型），
    // 主内容渲染 SpecList（正式规格卡片＋搜索列），返回看板点「变更」。
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    const specsNav = within(aside).getByRole("button", { name: "规格" });
    fireEvent.click(specsNav);
    await waitFor(() => expect(screen.getByText("desktop-app")).toBeTruthy());
    expect(screen.getByPlaceholderText("搜索规格…")).toBeTruthy();
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
    expect(specsNav.className).toContain("bg-primary");
    // 点「变更」返回看板。
    const changesNav = within(aside).getByRole("button", { name: "变更" });
    fireEvent.click(changesNav);
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(specsNav.className).not.toContain("bg-primary");
  });

  it("规格页改每页 50 后重开 app 仍为每页 50，已封存变更节仍为 20（desktop-list-pages-reskin design D7）", async () => {
    // spec scenario「每页笔数跨启动记住」：记忆存在 app 本机，重建 App（新 store）后读回。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.getByText("desktop-app")).toBeTruthy());
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    await user.click(await screen.findByRole("option", { name: "每页 50 个" }));
    expect(screen.getByRole("combobox", { name: "每页 50 个" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("specseal.list.pageSizes")!).specs).toBe(50);
    // 重开 app：卸载后以新 store 重建（给一笔封存变更，已封存页才有工具列）。
    cleanup();
    renderApp(
      fakeDataSource({
        listArchived: vi.fn().mockResolvedValue([
          { datedName: "2026-07-04-old-change", date: "2026-07-04", name: "old-change" },
        ]),
      }),
    );
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.getByText("desktop-app")).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "每页 50 个" })).toBeTruthy();
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "已封存" }));
    await waitFor(() => expect(screen.getByText("old-change")).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "每页 20 个" })).toBeTruthy();
  });

  it("切到规格页与已封存页各有对应页标题 h2 与全圆搜索框，列表卡填满主区（desktop-list-pages-reskin）", async () => {
    // spec「规格页提供清单、搜索与展开查看」「已封存页含讨论节」：App 传 title／description，
    // 页标题区在列表卡之上；已封存页的列表卡以卡片标头式分页接在顶部。
    renderApp();
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const aside = projectColumn();
    fireEvent.click(within(aside).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.getByText("desktop-app")).toBeTruthy());
    const specsHeader = document.querySelector("main [data-page-header]") as HTMLElement;
    expect(within(specsHeader).getByRole("heading", { level: 2 }).textContent).toBe("规格");
    expect(within(specsHeader).getByPlaceholderText("搜索规格…").className).toContain("rounded-full");
    expect(document.querySelector("main [data-list-card]")).toBeTruthy();
    expect(document.querySelector("main")!.className).toContain("p-5");
    fireEvent.click(within(aside).getByRole("button", { name: "已封存" }));
    await waitFor(() => expect(screen.getByText("已封存的变更")).toBeTruthy());
    const archivedHeader = document.querySelector("main [data-page-header]") as HTMLElement;
    expect(within(archivedHeader).getByRole("heading", { level: 2 }).textContent).toBe("已封存");
    expect(within(archivedHeader).getByPlaceholderText("搜索已封存的变更与讨论…").className).toContain("rounded-full");
    expect(document.querySelector("main [data-list-card]")!.className).toContain("rounded-t-none");
    expect(document.querySelector("main")!.className).toContain("p-5");
  });

  it("规格页点列开规格详情页：宿主为规格页且 inert、面包屑「项目 / 规格 / 名称」、Esc 后规格页搜索字符串不变", async () => {
    // spec Scenario「选定 spec 以详情页显示需求分段」的接线面：App 于页层挂 SpecDetailPage，
    // 经 dataSource.getSpecDocument 加载正式规格全文；清单无行内展开。
    const ds = fakeDataSource({
      getSpecDocument: vi
        .fn()
        .mockResolvedValue("# desktop-app Specification\n\n## Purpose\n\n目的。\n\n### Requirement: 甲\n\n正典内文段落。\n"),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => screen.getByText("desktop-app"));
    const search = screen.getByPlaceholderText("搜索规格…");
    fireEvent.change(search, { target: { value: "desk" } });
    expect(ds.getSpecDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("desktop-app"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("正典内文段落。")).toBeTruthy());
    expect(ds.getSpecDocument).toHaveBeenCalledWith("desktop-app");
    expect(layer.querySelector("[data-spec-detail]")).toBeTruthy();
    const host = screen.getByTestId("host-page");
    expect(host.hasAttribute("inert")).toBe(true);
    expect(within(host).getByPlaceholderText("搜索规格…")).toBeTruthy();
    expect(crumbText()).toBe("proj-a/规格/desktop-app");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("detail-page")).toBeNull());
    expect((screen.getByPlaceholderText("搜索规格…") as HTMLInputElement).value).toBe("desk");
  });

  it("已封存页点封存变更列开已封存详情页，宿主为已封存页（spec「已封存项目以详情页查看」）", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        {
          datedName: "2026-07-04-old",
          date: "2026-07-04",
          name: "old",
          tasksTotal: 2,
          tasksDone: 2,
          specCount: 1,
          createdBy: null,
          fromDiscussions: [],
        },
      ]),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const archivedNav = within(projectColumn()).getByRole("button", { name: /已封存/ });
    fireEvent.click(archivedNav);
    await waitFor(() => screen.getByText("old"));
    expect(ds.getArchivedDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("old"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("封存提案内文。")).toBeTruthy());
    expect(layer.querySelector('[data-archived-detail="change"]')).toBeTruthy();
    expect(within(layer).getByRole("tab", { name: /提案/ })).toBeTruthy();
    expect(ds.getArchivedDocument).toHaveBeenCalledWith("2026-07-04-old", "proposal.md");
    expect(screen.getByTestId("host-page").hasAttribute("inert")).toBe(true);
    expect(archivedNav.className).toContain("bg-primary");
    expect(crumbText()).toBe("proj-a/已封存/old");
  });

  it("封存变更详情页点来源讨论签，该讨论的已封存详情页取代显示、宿主维持已封存页", async () => {
    // spec Scenario「自封存变更详情页跳转来源讨论」的接线面：fromDiscussions →
    // 出身列「来自」签 → openArchived({ kind: "discussion" })。
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        {
          datedName: "2026-07-04-old",
          date: "2026-07-04",
          name: "old",
          specCount: 1,
          createdBy: null,
          fromDiscussions: ["old-topic"],
        },
      ]),
      listDiscussions: vi.fn().mockResolvedValue({
        active: [],
        archived: [
          { slug: "old-topic", topic: "Old topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: ["x"] },
        ],
      }),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
      getDiscussionDocument: vi
        .fn()
        .mockResolvedValue({
          content:
            "---\ntopic: Old topic\nslug: old-topic\nstatus: promoted\ncreated: 2026-06-30\n---\n\n# Discussion: Old topic\n\n## Context\n\n封存背景内文。\n\n## Rounds\n\n## Conclusion\n\n**Decision**: 收工\n",
          cuts: [],
        }),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const archivedNav = within(projectColumn()).getByRole("button", { name: /已封存/ });
    fireEvent.click(archivedNav);
    await waitFor(() => screen.getByText("old"));
    fireEvent.click(screen.getByText("old"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("封存提案内文。")).toBeTruthy());
    fireEvent.click(within(layer).getByRole("button", { name: /old-topic/ }));
    await waitFor(() => expect(screen.getByText(/收工/)).toBeTruthy());
    expect(ds.getDiscussionDocument).toHaveBeenCalledWith("old-topic");
    expect(document.querySelector('[data-archived-detail="discussion"]')).toBeTruthy();
    expect(screen.getByText("Old topic")).toBeTruthy();
    expect(archivedNav.className).toContain("bg-primary");
    expect(crumbText()).toBe("proj-a/已封存/old-topic");
  });

  it("封存变更的来源讨论仍在作用中（保留在途）时，点来源讨论签同样开已封存详情页、宿主维持已封存页", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-04-old", date: "2026-07-04", name: "old", specCount: 1, createdBy: null, fromDiscussions: ["held-topic"] },
      ]),
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          { slug: "held-topic", topic: "Held topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: ["old"], hold: true },
        ],
        archived: [],
      }),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
      getDiscussionDocument: vi
        .fn()
        .mockResolvedValue({
          content:
            "---\ntopic: Held topic\nslug: held-topic\nstatus: promoted\ncreated: 2026-06-30\n---\n\n# Discussion: Held topic\n\n## Context\n\n背景。\n\n## Rounds\n\n## Conclusion\n\n**Decision**: 收工\n",
          cuts: [],
        }),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    const archivedNav = within(projectColumn()).getByRole("button", { name: /已封存/ });
    fireEvent.click(archivedNav);
    fireEvent.click(await screen.findByText("old"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("封存提案内文。")).toBeTruthy());
    fireEvent.click(within(layer).getByRole("button", { name: /held-topic/ }));
    await waitFor(() => expect(document.querySelector('[data-archived-detail="discussion"]')).toBeTruthy());
    expect(document.querySelector("[data-discussion-detail]")).toBeNull();
    expect(archivedNav.className).toContain("bg-primary");
  });

  it("已封存页点封存讨论列开已封存讨论详情页（阶段列现站「已封存」）", async () => {
    const ds = fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [],
        archived: [
          { slug: "old-topic", topic: "Old topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: ["x"] },
        ],
      }),
      getDiscussionDocument: vi
        .fn()
        .mockResolvedValue({
          content:
            "---\ntopic: Old topic\nslug: old-topic\nstatus: promoted\ncreated: 2026-06-30\n---\n\n# Discussion: Old topic\n\n## Context\n\n封存背景内文。\n\n## Rounds\n\n## Conclusion\n\n**Decision**: 收工\n",
          cuts: [],
        }),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: /已封存/ }));
    // 已封存页为「变更／讨论」子页签：讨论列在「已封存的讨论」子页签下。
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /已封存的讨论/ }));
    await waitFor(() => screen.getByText("Old topic"));
    fireEvent.click(screen.getByText("Old topic"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText(/收工/)).toBeTruthy());
    expect(ds.getDiscussionDocument).toHaveBeenCalledWith("old-topic");
    expect(layer.querySelector('[data-status-stage] [aria-current="step"]')!.textContent).toBe("已封存");
    expect(within(layer).getByRole("tab", { name: /讨论过程/ })).toBeTruthy();
  });

  it("i18n 两语系键集合相等，备忘键已自两语系移除", () => {
    expect(dictionaryProblems(APP_MESSAGES)).toEqual([]);
    expect(Object.keys(APP_MESSAGES["zh-CN"])).not.toContain("app.navNotes");
  });
});

// spec 需求「清单最新在前与换页浏览」（填满高度增补）：规格页与已封存页的内部
// 卷动容器高度须受窗口约束——main 带 overflow-hidden 而非整页卷动；设置页不受
// 影响、维持 overflow-y-auto 整页卷动。
describe("main content scroll containment（主内容区卷动约束）", () => {
  it("看板/规格/已封存页 main 为 overflow-hidden，设置页维持 overflow-y-auto", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const main = () => document.querySelector("main") as HTMLElement;
    const aside = projectColumn();
    // 看板（缺省）：既有 overflow-hidden。
    expect(main().className).toContain("overflow-hidden");
    // 规格页：改 overflow-hidden，清单于内部容器卷动。
    fireEvent.click(within(aside).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.getByText("desktop-app")).toBeTruthy());
    expect(main().className).toContain("overflow-hidden");
    expect(main().className).not.toContain("overflow-y-auto");
    // 已封存页：同上。
    fireEvent.click(within(aside).getByRole("button", { name: "已封存" }));
    await waitFor(() => expect(screen.getByText("已封存的变更")).toBeTruthy());
    expect(main().className).toContain("overflow-hidden");
    expect(main().className).not.toContain("overflow-y-auto");
    // 设置页：维持整页卷动。
    fireEvent.click(settingsGear());
    await waitFor(() => expect(main().className).toContain("overflow-y-auto"));
    expect(main().className).not.toContain("overflow-hidden");
  });

  // spec「指令档过期提示」「指令档过期提示卷动钉选」（desktop-notice-relocation）：提示卡住在
  // 项目栏、不属主区任何卷动容器；跨页常驻；主区无旧横幅、无 sticky 包裹层、卷动约束不因提示
  // 改变。jsdom 无版面计算，这里钉的是 DOM 归属与 class 契约。
  it("技能档提示卡渲染在项目栏内、主区无旧横幅与钉选包裹层；切规格、已封存与项目设置页仍在", async () => {
    const ws = staleWorkspace();
    renderApp(fakeDataSource(), { ws });
    await screen.findByText("desktop-shell-and-browser");
    const card = await screen.findByTestId("asset-notice-card");
    const main = () => document.querySelector("main") as HTMLElement;
    const aside = projectColumn();
    expect(aside.contains(card)).toBe(true);
    expect(card.textContent).toContain("3 个文档");
    // 主区：旧横幅退场、无钉选包裹层、卷动约束照旧。
    expect(main().querySelector('[data-testid="asset-notice-card"]')).toBeNull();
    expect(main().querySelector(".sticky")).toBeNull();
    expect(main().classList.contains("overflow-hidden")).toBe(true);
    // Scenario「提示卡跨页常驻」：规格、手册、已封存、项目设置依序切（手册页是旧实作有特例的页）。
    const crumbs = screen.getByTestId("main-titlebar");
    for (const label of ["规格", "手册", "已封存"] as const) {
      fireEvent.click(within(aside).getByRole("button", { name: label }));
      await waitFor(() => expect(crumbs.textContent).toBe(`proj-a/${label}`));
      expect(projectColumn().contains(screen.getByTestId("asset-notice-card"))).toBe(true);
      expect(main().classList.contains("overflow-hidden")).toBe(true);
    }
    fireEvent.click(within(aside).getByRole("button", { name: "项目设置" }));
    await waitFor(() => expect(main().className).toContain("overflow-y-auto"));
    // 项目设置模式换成项目设置分类栏：提示卡沉在分类栏底部，同一位置。
    expect(projectSettingsColumn().contains(screen.getByTestId("asset-notice-card"))).toBe(true);
    expect(main().querySelector(".sticky")).toBeNull();
  });

  it("点提示卡开确认框；打开变更详情页时确认框关闭（可取消浮层互斥）", async () => {
    renderApp(fakeDataSource(), { ws: staleWorkspace() });
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(await screen.findByTestId("asset-notice-card"));
    const dialog = await screen.findByTestId("asset-notice-dialog");
    expect(within(dialog).getByRole("button", { name: "更新技能档" })).toBeTruthy();
    // 看板卡片走 store openDetail；fireEvent 不送 pointerdown，不会误走对话框的点外关闭。
    fireEvent.click(screen.getByText("desktop-shell-and-browser"));
    await waitFor(() => expect(screen.queryByTestId("asset-notice-dialog")).toBeNull());
    expect(screen.getByTestId("detail-page")).toBeTruthy();
    // 被详情页顶掉等同「稍后」：提示卡仍在项目栏。
    expect(screen.getByTestId("asset-notice-card")).toBeTruthy();
  });

  /** 以一个 remote 分页（REMOTE_KEY）启动 App；`checkoutRoot` 有值时它绑了 checkout。 */
  function renderRemoteTab(ws: ReturnType<typeof remoteStaleWorkspace>, checkoutRoot?: string) {
    const locator = {
      kind: "remote" as const,
      connectionId: "c1",
      projectId: "demo",
      repoId: "backend",
      ...(checkoutRoot ? { checkoutRoot } : {}),
    };
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({ version: 2, tabs: [{ locator, name: "Demo/backend" }], activeKey: REMOTE_KEY }),
    );
    const ds = fakeRemoteDs();
    render(
      <App
        createSession={() => {
          throw new Error("remote 流程不应触发 local 工厂");
        }}
        openRemote={vi.fn(async () => ({ ...fakeRemoteSession(ds), locator }))}
        workspace={ws as never}
      />,
    );
    return ds;
  }

  /** remote 项目的技能和 Server 提供的不同（1 个文档）的 workspace 面。checkout 的监看
   * 以 `checkoutChanged()` 仿真通知；`unsubscribe` 是订阅回传的退订函数。 */
  function remoteStaleWorkspace() {
    const handlers: Array<() => void> = [];
    const unsubscribe = vi.fn();
    return {
      ...staleWorkspace(),
      probeRemoteAssets: vi.fn().mockResolvedValue(REMOTE_STALE_PROBE),
      updateRemoteAssets: vi.fn().mockResolvedValue({ migrated: { movedFolder: false, renamed: 0 } }),
      watchCheckoutSkills: vi.fn().mockResolvedValue(undefined),
      onCheckoutSkillsChanged: vi.fn((_checkout: string, handler: () => void) => {
        handlers.push(handler);
        return unsubscribe;
      }),
      unsubscribe,
      checkoutChanged: () => handlers.forEach((handler) => handler()),
    };
  }

  it("没有 checkout 的 remote 分页不探测技能档、项目栏无提示卡", async () => {
    const ws = remoteStaleWorkspace();
    renderRemoteTab(ws);
    await screen.findByText("remote-change");
    expect(projectColumn()).toBeTruthy();
    expect(ws.probeAssets).not.toHaveBeenCalled();
    expect(ws.probeRemoteAssets).not.toHaveBeenCalled();
    expect(screen.queryByTestId("asset-notice-card")).toBeNull();
  });

  it("有 checkout 的 remote 分页：技能和 Server 不同时出现提示卡；确认框有 Server 的版本，更新后提示消失", async () => {
    const ws = remoteStaleWorkspace();
    renderRemoteTab(ws, "/work/demo");
    await screen.findByText("remote-change");
    const card = await screen.findByTestId("asset-notice-card");
    expect(projectColumn().contains(card)).toBe(true);
    expect(ws.probeRemoteAssets).toHaveBeenCalledWith(REMOTE_CHECKOUT);
    expect(ws.probeAssets).not.toHaveBeenCalled();

    fireEvent.click(card);
    const dialog = await screen.findByTestId("asset-notice-dialog");
    const rows = within(dialog).getByTestId("asset-notice-rows");
    expect(rows.textContent).toContain("Server 提供的技能版本");
    expect(rows.textContent).toContain("v1.58.0");

    // 更新后 checkout 等于 Server 的回应：下一次探测是现版。
    ws.probeRemoteAssets.mockResolvedValue({ ...REMOTE_STALE_PROBE, status: "current", differingFiles: [] });
    fireEvent.click(within(dialog).getByRole("button", { name: "更新技能档" }));
    await waitFor(() => expect(ws.updateRemoteAssets).toHaveBeenCalledWith(REMOTE_CHECKOUT));
    expect(ws.updateAssets).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("asset-notice-card")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("asset-notice-dialog")).toBeNull());
  });

  // design D8／spec「remote 项目的技能档被外部改动后提示自动更新」。
  it("有 checkout 的 remote 分页：checkout 的技能档被改动后重新探测，提示卡跟着出现与消失，数据不重新加载", async () => {
    const ws = remoteStaleWorkspace();
    const current = { ...REMOTE_STALE_PROBE, status: "current" as const, differingFiles: [] };
    ws.probeRemoteAssets.mockResolvedValue(current);
    const ds = renderRemoteTab(ws, "/work/demo");
    await screen.findByText("remote-change");
    await waitFor(() => expect(ws.onCheckoutSkillsChanged).toHaveBeenCalledWith("/work/demo", expect.any(Function)));
    await waitFor(() => expect(ws.watchCheckoutSkills).toHaveBeenCalledWith("/work/demo"));
    expect(ws.watchWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("asset-notice-card")).toBeNull();
    const loads = vi.mocked(ds.listChanges).mock.calls.length;
    const probes = ws.probeRemoteAssets.mock.calls.length;

    // 用户在终端机改坏一个技能档。
    ws.probeRemoteAssets.mockResolvedValue(REMOTE_STALE_PROBE);
    act(() => ws.checkoutChanged());
    expect(await screen.findByTestId("asset-notice-card")).toBeTruthy();
    expect(ws.probeRemoteAssets.mock.calls.length).toBe(probes + 1);

    // 改回 Server 的内容。
    ws.probeRemoteAssets.mockResolvedValue(current);
    act(() => ws.checkoutChanged());
    await waitFor(() => expect(screen.queryByTestId("asset-notice-card")).toBeNull());
    expect(vi.mocked(ds.listChanges).mock.calls.length).toBe(loads);

    // 分页卸载后退订。
    cleanup();
    expect(ws.unsubscribe).toHaveBeenCalled();
  });

  it("没有 checkout 的 remote 分页不订阅 checkout 的监看", async () => {
    const ws = remoteStaleWorkspace();
    renderRemoteTab(ws);
    await screen.findByText("remote-change");
    expect(ws.onCheckoutSkillsChanged).not.toHaveBeenCalled();
    expect(ws.watchCheckoutSkills).not.toHaveBeenCalled();
  });

  it("有 checkout 的 remote 分页：Server 没有提供技能、或探测失败时没有提示", async () => {
    const silent = remoteStaleWorkspace();
    silent.probeRemoteAssets.mockResolvedValue(null);
    renderRemoteTab(silent, "/work/demo");
    await screen.findByText("remote-change");
    await waitFor(() => expect(silent.probeRemoteAssets).toHaveBeenCalled());
    expect(screen.queryByTestId("asset-notice-card")).toBeNull();
    expect(localStorage.getItem("specseal.instructionSkips")).toBeNull();
    cleanup();

    const failing = remoteStaleWorkspace();
    failing.probeRemoteAssets.mockRejectedValue("server unreachable");
    renderRemoteTab(failing, "/work/demo");
    await screen.findByText("remote-change");
    await waitFor(() => expect(failing.probeRemoteAssets).toHaveBeenCalled());
    expect(screen.queryByTestId("asset-notice-card")).toBeNull();
    expect(localStorage.getItem("specseal.instructionSkips")).toBeNull();
  });
});

describe("侧栏无常驻版号（desktop-app 规格「侧栏导览结构」）", () => {
  it("注入 updater 面时侧栏任何位置仍无版号文本；app 版号在设置的更新页版本卡", async () => {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    render(
      <App
        createSession={makeSession(fakeDataSource())}
        workspace={ws as never}
        updater={{ check: vi.fn().mockResolvedValue(null), relaunch: vi.fn() }}
      />,
    );
    const aside = (await screen.findByTestId("left-titlebar")).parentElement as HTMLElement;
    await waitFor(() => expect(settingsGear()).toBeTruthy());
    expect(aside.textContent).not.toContain("v0.1.0");

    // 更新页版本卡显示目前版本（一般页不再重复）。
    fireEvent.click(settingsGear());
    expect(screen.queryByRole("group", { name: "目前版本" })).toBeNull();
    fireEvent.click(within(settingsColumn()).getByRole("button", { name: "更新" }));
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "目前版本" })).getByText("0.1.0")).toBeTruthy(),
    );
  });

  it("未注入 updater 面时同样无版号文本", async () => {
    renderApp();
    await waitFor(() => expect(leftSide()).toBeTruthy());
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });
});

// 前景重检（desktop-app「回到前景逾一小时即重检」「回到前景未满一小时不重检」；
// design D3）：App 于启动 effect 订阅主窗口焦点，只对 focused=true 反应、经 1 小时
// 节流；卸载取消订阅。焦点事件经 updater adapter 的可选方法注入，这里以假 adapter
// 捕获 handler 手动触发。
describe("主窗口回到前景时重检更新", () => {
  const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  function focusAdapter() {
    let handler: ((focused: boolean) => void) | null = null;
    const unlisten = vi.fn();
    const adapter = {
      check: vi.fn().mockResolvedValue(null),
      relaunch: vi.fn(),
      onFocusChanged: vi.fn((h: (focused: boolean) => void) => {
        handler = h;
        return Promise.resolve(unlisten);
      }),
    };
    return { adapter, unlisten, focus: (focused: boolean) => act(() => handler?.(focused)) };
  }

  function renderWith(adapter: object) {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    return render(
      <App
        createSession={makeSession(fakeDataSource())}
        workspace={ws as never}
        updater={adapter as never}
      />,
    );
  }

  it("启动检查后：focused=false 不查、未满 1 小时的 focused=true 不查、满 1 小时才再查一次；卸载取消订阅", async () => {
    // 只假 Date：setSystemTime 控制节流判定，setTimeout 等维持真实以免卡住 waitFor。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { adapter, unlisten, focus } = focusAdapter();
    const { unmount } = renderWith(adapter);

    await waitFor(() => expect(adapter.check).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(adapter.onFocusChanged).toHaveBeenCalledTimes(1));

    vi.setSystemTime(T0 + 30 * 60 * 1000);
    await focus(true);
    expect(adapter.check).toHaveBeenCalledTimes(1);

    // 满 1 小时后先送失焦：节流已放行，仍不可查——证明只对取得焦点反应。
    vi.setSystemTime(T0 + HOUR);
    await focus(false);
    expect(adapter.check).toHaveBeenCalledTimes(1);

    await focus(true);
    await waitFor(() => expect(adapter.check).toHaveBeenCalledTimes(2));

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("假 adapter 未提供 onFocusChanged：启动检查照常一次、不订阅、无错误", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const adapter = { check: vi.fn().mockResolvedValue(null), relaunch: vi.fn() };
      renderWith(adapter);
      await waitFor(() => expect(adapter.check).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(leftSide()).toBeTruthy());
      expect(adapter.check).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

// 看板骨架只在「活跃 workspace 正在加载」时出现。持久化分页探测失败时
// activeKey 恒 null、loaded 恒 false，整批加载根本不会发生——若只看 loaded，
// 看板会永久停在骨架卡，比改动前可辨识的空看板更糟。
describe("看板骨架的终止条件", () => {
  it("有分页但探测失败（无活跃 workspace）→ 不出骨架卡", async () => {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockRejectedValue("目录已不存在");
    renderApp(fakeDataSource(), { ws });
    await waitFor(() => expect(ws.openProject).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
  });
});

// 看板失败终态的接线闸门 loadFailed={!s.loaded && s.loadFailed}：首访失败显示
// 提示；已有真值的重载失败维持旧快照静默呈现，不得误挂提示。
describe("看板首访失败终态的接线", () => {
  it("首访整批加载失败 → 骨架收掉，卡片区显示加载失败提示", async () => {
    const ds = fakeDataSource({
      listChanges: vi.fn().mockRejectedValue(new Error("offline")),
    });
    renderApp(ds);
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="column-load-failed"]').length).toBeGreaterThan(0),
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText("尚无讨论")).toBeNull();
  });

  it("已有旧缓存的重载失败 → 照常显示旧数据，无失败提示", async () => {
    const ds = fakeDataSource({
      listChanges: vi
        .fn()
        .mockResolvedValueOnce(changeList([
          { name: "kept-change", status: "in-progress", totalTasks: 2, completedTasks: 1 },
        ]))
        .mockRejectedValue(new Error("offline")),
    });
    renderApp(ds);
    await waitFor(() => expect(screen.getByText("kept-change")).toBeTruthy());
    // 挂载后补读那一发以失败收场——旧快照仍在，不得出现失败提示。
    await waitFor(() => expect(vi.mocked(ds.listChanges).mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText("kept-change")).toBeTruthy();
    expect(document.querySelector('[data-testid="column-load-failed"]')).toBeNull();
  });
});

// desktop-app「侧栏导览结构」Scenario「手册导览项切页与零分页空状态」＋
// desktop-manual-page「内页渲染与出处跳规格」「手册页随外部变更即时更新」的 App 半边。
describe("手册页接线（desktop-manual-page）", () => {
  it("点导览「手册」切至手册页且高亮：主内容出现侧栏树与内文；点「变更」返回看板", async () => {
    const ds = fakeDataSource({
      listManualPages: vi.fn().mockResolvedValue(MANUAL_INDEX),
      getManualPage: vi.fn().mockResolvedValue("# 手册\n\n欢迎使用。"),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    // 进手册页前不读索引（只在手册视图活跃时读）。
    expect(ds.listManualPages).not.toHaveBeenCalled();
    const aside = projectColumn();
    const manualNav = within(aside).getByRole("button", { name: "手册" });
    const changesNav = within(aside).getByRole("button", { name: "变更" });
    fireEvent.click(manualNav);
    await screen.findByText("欢迎使用。");
    expect(screen.getByPlaceholderText("搜索手册…")).toBeTruthy();
    expect(document.querySelector('[data-manual-page="boards"] [data-manual-stale]')?.textContent).toBe("过期");
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
    expect(manualNav.className).toContain("bg-primary");
    expect(changesNav.className).not.toContain("bg-primary");
    expect(ds.getManualPage).toHaveBeenCalledWith("index");
    // 再点手册停留（切页而非 toggle）；点「变更」才返回看板。
    fireEvent.click(manualNav);
    expect(screen.getByText("欢迎使用。")).toBeTruthy();
    fireEvent.click(changesNav);
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeTruthy());
    expect(manualNav.className).not.toContain("bg-primary");
  });

  it("无手册目录时主内容为尚无手册空状态，手册项高亮、无错误弹窗", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    const aside = projectColumn();
    const manualNav = within(aside).getByRole("button", { name: "手册" });
    fireEvent.click(manualNav);
    expect(await screen.findByText("尚无手册")).toBeTruthy();
    expect(manualNav.className).toContain("bg-primary");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("零分页时手册不可达：无项目栏、不读手册索引，主区为空状态", async () => {
    const ws = fakeWorkspace();
    const ds = fakeDataSource();
    render(<App createSession={makeSession(ds)} workspace={ws as never} />);
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "手册" })).toBeNull();
    expect(ds.listManualPages).not.toHaveBeenCalled();
  });

  it("点手册出处在手册页上开规格详情页：面包屑「项目 / 手册 / 名称」、Esc 回手册页且不切页", async () => {
    // spec Scenario「点出处打开规格详情页」：共用规格页的同一个详情页，宿主维持手册页。
    const ds = fakeDataSource({
      listManualPages: vi.fn().mockResolvedValue(MANUAL_INDEX),
      getManualPage: vi
        .fn()
        .mockResolvedValue("# 看板\n\n看板说明。\n\n**出处**：`desktop-app`、`ghost-cap`"),
      getSpecDocument: vi.fn().mockResolvedValue("# desktop-app Specification\n\n正典内文段落。"),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    const aside = projectColumn();
    const manualNav = within(aside).getByRole("button", { name: "手册" });
    const specsNav = within(aside).getByRole("button", { name: "规格" });
    fireEvent.click(manualNav);
    await screen.findByText("看板说明。");
    // 出处列以索引的 sources 为准：首页 sources 为空，切到带 sources 的「看板」页。
    fireEvent.click(document.querySelector('[data-manual-page="boards"]') as HTMLElement);
    const sources = await waitFor(() => {
      const el = document.querySelector("[data-manual-sources]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    // 不在索引 sources 的名称不进出处列（内文出处行只剥掉、不重解）。
    expect(within(sources).queryByRole("button", { name: "ghost-cap" })).toBeNull();
    expect(within(sources).queryByText("ghost-cap")).toBeNull();
    fireEvent.click(within(sources).getByRole("button", { name: "desktop-app" }));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("正典内文段落。")).toBeTruthy());
    expect(ds.getSpecDocument).toHaveBeenCalledWith("desktop-app");
    // 不切页：手册项仍高亮、规格项未高亮，手册页留在宿主层。
    expect(manualNav.className).toContain("bg-primary");
    expect(specsNav.className).not.toContain("bg-primary");
    expect(within(screen.getByTestId("host-page")).getByText("看板说明。")).toBeTruthy();
    expect(crumbText()).toBe("proj-a/手册/desktop-app");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("detail-page")).toBeNull());
    expect(manualNav.className).toContain("bg-primary");
    expect(screen.getByText("看板说明。")).toBeTruthy();
  });

  it("手册页阅读卡标题列有「打开 ▾」，展开后首列为 specseal/manual/tray.md，选「拷贝路径」写入绝对路径；过期提示框读出处规格", async () => {
    // spec desktop-app Scenario「手册页的打开菜单」＋desktop-manual-page「来源更新后标示可能过期」的 App 半边。
    const tray = {
      slug: "tray",
      title: "系统匣菜单",
      section: "桌面 app",
      order: 10,
      keywords: [],
      sources: ["tray-status-menu"],
      generated: "2026-09-17T16:05:41+08:00",
      stale: true,
    };
    const ds = fakeDataSource({
      listManualPages: vi.fn().mockResolvedValue({ ...MANUAL_INDEX, pages: [tray] }),
      getManualPage: vi.fn().mockResolvedValue("# 系统匣菜单\n\n系统匣内文。"),
      getSpecDocument: vi
        .fn()
        .mockResolvedValue(
          "# tray-status-menu Specification\n\n## Purpose\n\np\n\n### Requirement: 甲\n\n内文。\n\n<!-- @trace\nsource: tray-panel-restyle\nupdated: 2026-10-12T16:18:33+08:00\n-->\n",
        ),
    });
    const location = { path: "/work/app/specseal/manual/tray.md", relative: "specseal/manual/tray.md" };
    const fsActions: FsActionsAdapter = {
      reveal: vi.fn().mockResolvedValue(undefined),
      openDefault: vi.fn().mockResolvedValue(undefined),
      openTerminal: vi.fn().mockResolvedValue(undefined),
      openEditor: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      locate: vi.fn().mockResolvedValue(location),
    };
    renderApp(ds, { fsActions });
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "手册" }));
    await screen.findByText("系统匣内文。");
    const header = document.querySelector("[data-manual-card] [data-doc-header]") as HTMLElement;
    // 出处行首段是 core 解析的同一相对路径。
    await waitFor(() =>
      expect(header.querySelector("[data-doc-provenance]")!.textContent).toContain("specseal/manual/tray.md"),
    );
    const u = userEvent.setup({ pointerEventsCheck: 0 });
    await u.click(within(header).getByRole("button", { name: /打开/ }));
    // 出处行也有同一路径：首列只在菜单内找。
    const menu = await screen.findByRole("menu");
    expect(await within(menu).findByText("specseal/manual/tray.md")).toBeTruthy();
    expect(fsActions.locate).toHaveBeenCalledWith("A", { manual: "tray" });
    await u.click(screen.getByRole("menuitem", { name: "拷贝路径" }));
    await waitFor(() => expect(fsActions.copyText).toHaveBeenCalledWith("/work/app/specseal/manual/tray.md"));
    // 过期提示框经 dataSource.getSpecDocument 读出处规格的最近 @trace。
    await waitFor(() =>
      expect(document.querySelector('[data-callout="stale"]')?.textContent).toContain(
        "出处 tray-status-menu 于 2026-10-12 由变更 tray-panel-restyle 更新",
      ),
    );
    expect(ds.getSpecDocument).toHaveBeenCalledWith("tray-status-menu");
  });

  it("规格页点列开规格详情页后主区为三栏骨架（左栏文档节点规格／溯源、右栏本页目录容器）", async () => {
    const ds = fakeDataSource({
      getSpecDocument: vi
        .fn()
        .mockResolvedValue("# desktop-app Specification\n\n## Purpose\n\n目的。\n\n### Requirement: 甲\n\n正典内文段落。\n"),
    });
    // 项目改过 spec 目录名：出处行照 core 解析的实际相对路径显示。
    const fsActions: FsActionsAdapter = {
      reveal: vi.fn().mockResolvedValue(undefined),
      openDefault: vi.fn().mockResolvedValue(undefined),
      openTerminal: vi.fn().mockResolvedValue(undefined),
      openEditor: vi.fn().mockResolvedValue(undefined),
      copyText: vi.fn().mockResolvedValue(undefined),
      locate: vi
        .fn()
        .mockResolvedValue({ path: "/work/app/docs/specs/specs/desktop-app/spec.md", relative: "docs/specs/specs/desktop-app/spec.md" }),
    };
    renderApp(ds, { fsActions });
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    fireEvent.click(await screen.findByText("desktop-app"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("正典内文段落。")).toBeTruthy());
    const shell = layer.querySelector("[data-spec-detail][data-detail-shell]") as HTMLElement;
    expect(shell).toBeTruthy();
    const tree = shell.querySelector("[data-detail-tree]") as HTMLElement;
    const nodes = within(tree).getAllByRole("tab").map((tab) => tab.textContent);
    expect(nodes).toEqual([expect.stringContaining("规格"), expect.stringContaining("溯源")]);
    expect(within(tree).getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");
    expect(shell.querySelector("[data-detail-toc]")).toBeTruthy();
    await waitFor(() =>
      expect(shell.querySelector("[data-doc-provenance]")!.textContent).toContain("docs/specs/specs/desktop-app/spec.md"),
    );
    expect(fsActions.locate).toHaveBeenCalledWith("A", { spec: "desktop-app" });
  });

  it("手册页开着时 workspace-changed 触发索引重取与目前页内文重载", async () => {
    // spec Scenario「外部重生一页后内容更新」：沿用既有监看事件，不添加监看目标。
    const ds = fakeDataSource({
      listManualPages: vi.fn().mockResolvedValue(MANUAL_INDEX),
      getManualPage: vi.fn().mockResolvedValue("# 手册\n\n第一版内文。"),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    await waitFor(() => expect(workspaceHandlers.length).toBeGreaterThan(0));
    const aside = projectColumn();
    fireEvent.click(within(aside).getByRole("button", { name: "手册" }));
    await screen.findByText("第一版内文。");
    const indexCalls = (ds.listManualPages as Mock).mock.calls.length;
    const pageCalls = (ds.getManualPage as Mock).mock.calls.length;
    (ds.getManualPage as Mock).mockResolvedValue("# 手册\n\n重生后的内文。");
    workspaceHandlers.forEach((h) => h());
    await screen.findByText("重生后的内文。");
    expect((ds.listManualPages as Mock).mock.calls.length).toBeGreaterThan(indexCalls);
    expect((ds.getManualPage as Mock).mock.calls.length).toBeGreaterThan(pageCalls);
  });
});

// 规格详情页的溯源列→已封存详情页（宿主不切页）；封存讨论详情页衍生变更列三态（已封存→
// 已封存详情页、活跃→变更详情页且宿主落回看板、已删除→不可点）的 App 接线面。
describe("溯源与衍生变更接线（desktop-readonly-detail-pages）", () => {
  const DISCUSSION_DOC =
    "---\ntopic: Old topic\nslug: old-topic\nstatus: promoted\ncreated: 2026-06-30\n---\n\n# Discussion: Old topic\n\n## Context\n\n封存背景内文。\n\n## Rounds\n\n## Conclusion\n\n**Decision**: 收工\n";

  it("手册页开规格详情页后点溯源列：已封存详情页取代、宿主仍为手册页；Esc 回手册页", async () => {
    // spec Scenario「点击溯源列打开已封存详情页且宿主不切页」。
    const ds = fakeDataSource({
      listManualPages: vi.fn().mockResolvedValue(MANUAL_INDEX),
      getManualPage: vi.fn().mockResolvedValue("# 看板\n\n看板说明。\n\n**出处**：`desktop-app`"),
      getSpecDocument: vi
        .fn()
        .mockResolvedValue(
          "# desktop-app Specification\n\n### Requirement: 甲\n\n正典内文段落。\n\n<!-- @trace\nsource: old\nupdated: 2026-07-04\n-->\n",
        ),
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-04-old", date: "2026-07-04", name: "old", createdBy: null, fromDiscussions: [] },
      ]),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    const manualNav = within(projectColumn()).getByRole("button", { name: "手册" });
    fireEvent.click(manualNav);
    await screen.findByText("看板说明。");
    fireEvent.click(document.querySelector('[data-manual-page="boards"]') as HTMLElement);
    const sources = await waitFor(() => {
      const el = document.querySelector("[data-manual-sources]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(within(sources).getByRole("button", { name: "desktop-app" }));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("正典内文段落。")).toBeTruthy());
    fireEvent.mouseDown(within(layer).getByRole("tab", { name: /溯源/ }));
    const row = await waitFor(() => {
      const el = layer.querySelector('[data-trace-row="old"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(ds.getArchivedDocument).toHaveBeenCalledWith("2026-07-04-old", "proposal.md");
    // 详情页互斥：规格详情页关闭；宿主不切页：手册项仍高亮、看板栏不存在。
    expect(document.querySelector("[data-spec-detail]")).toBeNull();
    expect(document.querySelector('[data-archived-detail="change"]')).toBeTruthy();
    expect(manualNav.className).toContain("bg-primary");
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("detail-page")).toBeNull());
    expect(screen.getByText("看板说明。")).toBeTruthy();
  });

  it("封存讨论详情页衍生变更列三态：已封存者副标封存日期、活跃者阶段词、已删除者不可点；点已封存者开其已封存详情页", async () => {
    // spec Scenario「封存讨论详情页列出衍生变更并跳转封存变更」「衍生变更签的三态」。
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 30 },
        { name: "live-child", status: "in-progress", totalTasks: 3, completedTasks: 1 },
      ])),
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-09-02-arch-child", date: "2026-09-02", name: "arch-child", createdBy: null, fromDiscussions: ["old-topic"] },
      ]),
      listDiscussions: vi.fn().mockResolvedValue({
        active: [],
        archived: [
          {
            slug: "old-topic",
            topic: "Old topic",
            status: "promoted",
            rounds: 1,
            created: "2026-06-30",
            promotedTo: ["arch-child", "live-child", "gone-child"],
          },
        ],
      }),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
      getDiscussionDocument: vi.fn().mockResolvedValue({ content: DISCUSSION_DOC, cuts: [] }),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    const archivedNav = within(projectColumn()).getByRole("button", { name: /已封存/ });
    fireEvent.click(archivedNav);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /已封存的讨论/ }));
    await screen.findByText("Old topic");
    fireEvent.click(screen.getByText("Old topic"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText(/收工/)).toBeTruthy());
    const chip = (name: string) => layer.querySelector(`[data-promoted-chip="${name}"]`) as HTMLElement;
    expect(chip("arch-child").textContent).toContain("2026-09-02");
    expect(chip("live-child").textContent).toContain("进行中");
    expect(chip("gone-child").textContent).toContain("无封存记录");
    expect((within(chip("gone-child")).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(chip("arch-child")).getByRole("button"));
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(ds.getArchivedDocument).toHaveBeenCalledWith("2026-09-02-arch-child", "proposal.md");
    expect(archivedNav.className).toContain("bg-primary");
    expect(document.querySelector('[data-column="ready"]')).toBeNull();
  });

  it("封存讨论详情页点活跃子变更签：开其变更详情页且宿主落回看板", async () => {
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 30 },
        { name: "live-child", status: "in-progress", totalTasks: 3, completedTasks: 1 },
      ])),
      listDiscussions: vi.fn().mockResolvedValue({
        active: [],
        archived: [
          { slug: "old-topic", topic: "Old topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: ["live-child"] },
        ],
      }),
      getDiscussionDocument: vi.fn().mockResolvedValue({ content: DISCUSSION_DOC, cuts: [] }),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    const aside = projectColumn();
    const archivedNav = within(aside).getByRole("button", { name: /已封存/ });
    const changesNav = within(aside).getByRole("button", { name: "变更" });
    fireEvent.click(archivedNav);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /已封存的讨论/ }));
    await screen.findByText("Old topic");
    fireEvent.click(screen.getByText("Old topic"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText(/收工/)).toBeTruthy());
    const chip = layer.querySelector('[data-promoted-chip="live-child"]') as HTMLElement;
    fireEvent.click(within(chip).getByRole("button"));
    // 变更详情页打开（加载其提案），已封存详情页关闭，宿主落回看板。
    await waitFor(() => expect(ds.getDocument).toHaveBeenCalledWith("live-child", "proposal.md"));
    await waitFor(() => expect(document.querySelector("[data-archived-detail]")).toBeNull());
    expect((pageSpy.change[pageSpy.change.length - 1]?.change as { name: string }).name).toBe("live-child");
    expect(changesNav.className).toContain("bg-primary");
    expect(archivedNav.className).not.toContain("bg-primary");
    expect(screen.getByTestId("host-page").querySelector('[data-column="ready"]')).toBeTruthy();
  });

  // desktop-discussion-doc-views design D8：宿主把规格名、讨论 slug 与开页动作接进讨论详情页。
  it("开讨论详情页后点背景内文的规格签：主区为该规格的规格详情页、面包屑末段为该规格名", async () => {
    const ds = fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          { slug: "topic-a", topic: "Topic A", status: "concluded", rounds: 1, created: "2026-07-17", promotedTo: [] },
        ],
        archived: [],
      }),
      getDiscussionDocument: vi
        .fn()
        .mockResolvedValue({ content: DISCUSSION_DOC.replace("封存背景内文。", "背景提到 desktop-app 的需求。"), cuts: [] }),
      getSpecDocument: vi.fn().mockResolvedValue("# desktop-app Specification\n\n### Requirement: 甲\n\n正典内文段落。"),
    });
    renderApp(ds);
    fireEvent.click(await screen.findByText("Topic A"));
    const layer = await screen.findByTestId("detail-page");
    fireEvent.mouseDown(await within(layer).findByRole("tab", { name: /背景/ }));
    const chip = await waitFor(() => {
      const el = layer.querySelector('[data-name-chip="spec:desktop-app"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText("正典内文段落。")).toBeTruthy());
    expect(ds.getSpecDocument).toHaveBeenCalledWith("desktop-app");
    expect(document.querySelector("[data-discussion-detail]")).toBeNull();
    expect(document.querySelector("[data-spec-detail]")).toBeTruthy();
    expect(crumbText()).toBe("proj-a/变更/desktop-app");
  });

  it("开已封存讨论页后衍生变更列呈现任务进度 n/m 与打开钮，点钮打开该封存变更的已封存详情页且宿主维持已封存页", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        {
          datedName: "2026-09-02-arch-child",
          date: "2026-09-02",
          name: "arch-child",
          createdBy: null,
          fromDiscussions: ["old-topic"],
          tasksDone: 5,
          tasksTotal: 5,
        },
      ]),
      listDiscussions: vi.fn().mockResolvedValue({
        active: [],
        archived: [
          { slug: "old-topic", topic: "Old topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: ["arch-child"] },
        ],
      }),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
      getDiscussionDocument: vi.fn().mockResolvedValue({ content: DISCUSSION_DOC, cuts: [] }),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    const archivedNav = within(projectColumn()).getByRole("button", { name: /已封存/ });
    fireEvent.click(archivedNav);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /已封存的讨论/ }));
    fireEvent.click(await screen.findByText("Old topic"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText(/收工/)).toBeTruthy());
    fireEvent.mouseDown(within(layer).getByRole("tab", { name: /衍生变更/ }));
    const row = layer.querySelector('[data-promoted-row="arch-child"]') as HTMLElement;
    expect(row.textContent).toContain("5/5");
    fireEvent.click(within(row).getByRole("button", { name: "打开卡片" }));
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(ds.getArchivedDocument).toHaveBeenCalledWith("2026-09-02-arch-child", "proposal.md");
    expect(document.querySelector('[data-archived-detail="change"]')).toBeTruthy();
    expect(archivedNav.className).toContain("bg-primary");
  });

  it("已封存讨论页背景内文的作用中讨论签开讨论详情页，已封存讨论签开已封存讨论页", async () => {
    const ds = fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          { slug: "topic-a", topic: "Topic A", status: "open", rounds: 1, created: "2026-07-17", promotedTo: [] },
        ],
        archived: [
          { slug: "old-topic", topic: "Old topic", status: "promoted", rounds: 1, created: "2026-06-30", promotedTo: [] },
          { slug: "older-topic", topic: "Older topic", status: "concluded", rounds: 1, created: "2026-06-01", promotedTo: [] },
        ],
      }),
      getDiscussionDocument: vi
        .fn()
        .mockResolvedValue({ content: DISCUSSION_DOC.replace("封存背景内文。", "接续 topic-a 与 older-topic 的讨论。"), cuts: [] }),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(within(projectColumn()).getByRole("button", { name: /已封存/ }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /已封存的讨论/ }));
    fireEvent.click(await screen.findByText("Old topic"));
    const layer = await screen.findByTestId("detail-page");
    fireEvent.mouseDown(await within(layer).findByRole("tab", { name: /背景/ }));
    const chip = (slug: string) =>
      waitFor(() => {
        const el = document.querySelector(`[data-name-chip="discussion:${slug}"]`) as HTMLElement | null;
        expect(el).toBeTruthy();
        return el!;
      });
    fireEvent.click(await chip("older-topic"));
    await waitFor(() => expect(document.querySelector('[data-archived-detail="discussion"]')).toBeTruthy());
    expect(document.querySelector("[data-discussion-detail]")).toBeNull();
    fireEvent.mouseDown(await within(await screen.findByTestId("detail-page")).findByRole("tab", { name: /背景/ }));
    fireEvent.click(await chip("topic-a"));
    await waitFor(() => expect(document.querySelector("[data-discussion-detail]")).toBeTruthy());
    expect(document.querySelector("[data-archived-detail]")).toBeNull();
  });
});

// 更新日志弹窗的 App 层接线（desktop-app 规格「更新日志弹窗」）：把纯判定、对话框与
// 已看过记录接起来的胶水——模式切换、关闭才写版号、dev 不弹不写、浏览模式不写。
describe("更新日志弹窗接线（desktop-app「更新日志弹窗」）", () => {
  const KEY = "specseal.lastSeenVersion";
  const TOP = RELEASE_NOTES[0].version;

  beforeEach(() => {
    localStorage.removeItem(KEY);
    vi.mocked(getVersion).mockResolvedValue(TOP);
    vi.stubEnv("DEV", false);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(getVersion).mockResolvedValue("0.1.0");
  });

  function renderWithUpdater(ds: SpecsealDataSource = fakeDataSource()) {
    const ws = fakeWorkspace();
    ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
    render(
      <App
        createSession={makeSession(ds)}
        workspace={ws as never}
        updater={{ check: vi.fn().mockResolvedValue(null), relaunch: vi.fn() }}
      />,
    );
  }

  /** 预置项目分页 A，让看板有卡片可点（抽屉相关案例用）。 */
  function seedProjectTab() {
    localStorage.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        version: 2,
        tabs: [{ locator: { kind: "local", root: "A" }, name: "proj-a" }],
        activeKey: "local:A",
      }),
    );
  }

  it("版号变更后首次启动弹出「X.Y.Z 更新内容」，按「知道了」关闭并记下现版号", async () => {
    localStorage.setItem(KEY, "0.1.0");
    renderWithUpdater();
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(within(dialog).getByText(`${TOP} 更新内容`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect(localStorage.getItem(KEY)).toBe(TOP);
  });

  it("macOS 原生菜单的「更新日志」开浏览模式", async () => {
    localStorage.setItem(KEY, TOP);
    renderWithUpdater();
    await screen.findByTestId("left-titlebar");
    expect(screen.queryByTestId("release-notes-dialog")).toBeNull();
    act(() => appMenuSpy.deps[appMenuSpy.deps.length - 1].dispatch("releaseNotes"));
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(within(dialog).getByText("更新日志")).toBeTruthy();
  });

  it("写入已看过记录失败时对话框仍关得掉", async () => {
    localStorage.setItem(KEY, "0.1.0");
    // vitest.setup 挂的 localStorage 来自另一个 jsdom window，全域 Storage.prototype 拦不到；
    // 对实例直接赋值又会被 jsdom 当成存一个叫 setItem 的 key——spy 要落在该实例的 prototype。
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const setItem = proto.setItem;
    const spy = vi.spyOn(proto, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === KEY) throw new Error("storage disabled");
      setItem.call(this, key, value);
    });
    try {
      renderWithUpdater();
      const dialog = await screen.findByTestId("release-notes-dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
      await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
      expect(spy).toHaveBeenCalledWith(KEY, TOP);
      // app 没有整个炸掉：左侧还在。
      expect(leftSide()).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("首次安装（无记录）不弹出，直接记下现版号", async () => {
    renderWithUpdater();
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe(TOP));
    expect(screen.queryByTestId("release-notes-dialog")).toBeNull();
  });

  it("dev 建置不弹出也不写记录", async () => {
    vi.stubEnv("DEV", true);
    renderWithUpdater();
    await waitFor(() => expect(screen.getByText(/目前版本/)).toBeTruthy(), { timeout: 100 }).catch(() => {});
    await screen.findByTestId("left-titlebar");
    expect(screen.queryByTestId("release-notes-dialog")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("更新页「全部更新日志」开浏览模式，关闭后已看过记录不变", async () => {
    localStorage.setItem(KEY, TOP);
    renderWithUpdater();
    const aside = (await screen.findByTestId("left-titlebar")).parentElement as HTMLElement;
    await waitFor(() => expect(settingsGear()).toBeTruthy());
    fireEvent.click(settingsGear());
    fireEvent.click(within(settingsColumn()).getByRole("button", { name: "更新" }));
    const notesCard = await screen.findByRole("region", { name: "更新日志" });
    fireEvent.click(within(notesCard).getByRole("button", { name: "全部更新日志" }));
    const dialog = await screen.findByTestId("release-notes-dialog");
    expect(within(dialog).getByText("更新日志")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect(localStorage.getItem(KEY)).toBe(TOP);
  });

  it("打开详情页时更新日志关闭且不记为已看过（规格「详情页互斥」）", async () => {
    localStorage.setItem(KEY, "0.1.0");
    seedProjectTab();
    renderWithUpdater();
    await screen.findByTestId("release-notes-dialog");

    // 看板卡片走 store openDetail；fireEvent 不送 pointerdown，不会误走对话框的点外关闭。
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));

    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect(screen.getByTestId("detail-page")).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBe("0.1.0");
  });

  it("whatsNew 打开中打开讨论：对话框关闭、讨论详情页打开且不记为已看过", async () => {
    // 规格 Example「更新日志（whatsNew）｜打开讨论」。
    localStorage.setItem(KEY, "0.1.0");
    seedProjectTab();
    renderWithUpdater(
      fakeDataSource({
        listDiscussions: vi.fn().mockResolvedValue({
          active: [
            { slug: "topic-a", topic: "Topic A", status: "open", rounds: 1, created: "2026-07-17", promotedTo: [] },
          ],
          archived: [],
        }),
      }),
    );
    await screen.findByTestId("release-notes-dialog");

    fireEvent.click(await screen.findByText("Topic A"));

    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect(pageSpy.disc[pageSpy.disc.length - 1]?.discussion).toMatchObject({ slug: "topic-a" });
    expect(screen.getByTestId("detail-page")).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBe("0.1.0");
  });

  it("详情页已开着时 whatsNew 才弹出：以 › 换开另一个 change 仍收掉更新日志", async () => {
    localStorage.setItem(KEY, "0.1.0");
    seedProjectTab();
    let resolveVersion!: (version: string) => void;
    vi.mocked(getVersion).mockReturnValueOnce(new Promise((resolve) => (resolveVersion = resolve)));
    renderWithUpdater(
      fakeDataSource({
        listChanges: vi.fn().mockResolvedValue(
          changeList([
            { name: "change-a", status: "in-progress", totalTasks: 3, completedTasks: 1 },
            { name: "change-b", status: "in-progress", totalTasks: 3, completedTasks: 1 },
          ]),
        ),
      }),
    );
    fireEvent.click(await screen.findByText("change-a"));
    await screen.findByTestId("detail-page");
    await act(async () => resolveVersion(TOP));
    await screen.findByTestId("release-notes-dialog");

    // 对话框打开时其余区域被标为 aria-hidden，角色查找需含隐藏节点。
    fireEvent.click(screen.getByRole("button", { name: "下一个", hidden: true }));

    await waitFor(() => expect(screen.queryByTestId("release-notes-dialog")).toBeNull());
    expect((pageSpy.change[pageSpy.change.length - 1]?.change as { name: string }).name).toBe("change-b");
    expect(localStorage.getItem(KEY)).toBe("0.1.0");
  });
});

// spec desktop-app「详情抽屉的工单分页」「已封存抽屉的工单分页」的宿主接线
// （drawer-quality-ticket-tab D3／D5）：两个抽屉的 loadStationTicket 各接数据源的
// getStationTicket／getArchivedStationTicket，与 loadDocument 同款包装。
describe("工单分页接线（drawer-quality-ticket-tab）", () => {
  const HASH = `sha256:${"a".repeat(64)}`;
  const TICKET = {
    rounds: [
      {
        index: 1,
        phase: "discovery",
        patchHash: HASH,
        scope: ["src/a.rs"],
        findings: [{ severity: "WARNING", path: "src/a.rs", text: "Correctness: 未处理空清单" }],
      },
    ],
  };

  it("inReview 变更的抽屉出现「审查」分页，工单经 dataSource.getStationTicket 加载", async () => {
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(
        changeList([
          { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 30, reviewStatus: "inReview" },
        ]),
      ),
      getStationTicket: vi.fn().mockResolvedValue(TICKET),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    expect(ds.getStationTicket).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("desktop-shell-and-browser"));
    await waitFor(() => screen.getByRole("tab", { name: /审查/ }));
    await waitFor(() => expect(ds.getStationTicket).toHaveBeenCalledWith("desktop-shell-and-browser", "review"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /审查/ }));
    // 段标题列已撤（desktop-change-doc-views design D8）：轮数与阶段词在阅读卡签槽、计数在数字砖。
    await waitFor(() =>
      expect((document.querySelector("[data-doc-badges]")?.textContent ?? "").replace(/\s+/g, " ")).toBe("第 1 轮首轮"),
    );
    expect(
      Array.from(document.querySelectorAll("[data-doc-tile]")).map((tile) => tile.textContent?.replace(/\s+/g, "")),
    ).toEqual(["1轮", "0CRITICAL（末轮）", "1WARNING（末轮）", "0SUGGESTION（末轮）"]);
  });

  it("reviewedNotPassed 的已封存详情页出现「审查」分页，工单经 dataSource.getArchivedStationTicket 加载", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        {
          datedName: "2026-07-04-old",
          date: "2026-07-04",
          name: "old",
          tasksTotal: 2,
          tasksDone: 2,
          specCount: 1,
          createdBy: null,
          fromDiscussions: [],
          reviewStatus: "reviewedNotPassed",
          verifyStatus: "none",
        },
      ]),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
      getArchivedStationTicket: vi.fn().mockResolvedValue(TICKET),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: /已封存/ }));
    await waitFor(() => screen.getByText("old"));
    fireEvent.click(screen.getByText("old"));
    await waitFor(() => screen.getByRole("tab", { name: /审查/ }));
    await waitFor(() => expect(ds.getArchivedStationTicket).toHaveBeenCalledWith("2026-07-04-old", "review"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /审查/ }));
    await waitFor(() => expect(document.querySelector("[data-ticket-view]")).toBeTruthy());
  });
});

// desktop-board-reskin design D2：App 把 store 的 promotedExpanded／setPromotedExpanded 接给看板；
// 点讨论栏底的收合列即写回 app 本机键，重启（键已存在）时启动即展开。App 的 store 是
// 内部创建的，store 状态以其可观察结果断言：收合列 aria-expanded 与 localStorage 键。
describe("看板讨论栏收合列的展开记忆接线（desktop-board-reskin）", () => {
  const KEY = "specseal.board.promotedExpanded";
  const promotedOnly = () =>
    fakeDataSource({
      listDiscussions: vi.fn().mockResolvedValue({
        active: [
          {
            slug: "fanout",
            topic: "Fanout topic",
            status: "promoted",
            rounds: 4,
            created: "2026-07-03",
            promotedTo: ["desktop-shell-and-browser"],
          },
        ],
        archived: [],
      }),
    });

  afterEach(() => {
    localStorage.removeItem(KEY);
  });

  it('点收合列后 store 的 promotedExpanded 为 true：细列展开且键写为 "true"', async () => {
    localStorage.removeItem(KEY);
    renderApp(promotedOnly());
    const bar = await screen.findByRole("button", { name: /已转出/ });
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Fanout topic")).toBeNull();
    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fanout topic")).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBe("true");
  });

  it('键已为 "true" 时启动即展开（跨启动保留）', async () => {
    localStorage.setItem(KEY, "true");
    renderApp(promotedOnly());
    const bar = await screen.findByRole("button", { name: /已转出/ });
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fanout topic")).toBeTruthy();
  });
});

// desktop-app「macOS 原生菜单」的 App 层接线（desktop-native-menu design D3）：语言与
// 项目有无改变时 rebuild、菜单动作派发到 store 既有动作或外部浏览器。
describe("macOS 原生菜单接线（desktop-app「macOS 原生菜单」）", () => {
  const menuDeps = () => appMenuSpy.deps[appMenuSpy.deps.length - 1];
  const searchInput = () => screen.getByPlaceholderText("搜索看板卡片…");

  it("切换 UI 语言后以新语言重装菜单（取消上一次），切回 zh-CN 变回繁中", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    expect(menuDeps().t("menu.file.title")).toBe("文档");
    fireEvent.click(settingsGear());
    const cancelsBefore = appMenuSpy.cancel.mock.calls.length;
    await pickOption("显示语言", "English");
    await waitFor(() => expect(menuDeps().t("menu.file.title")).toBe("File"));
    expect(appMenuSpy.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    await pickOption("Display language", "繁体中文");
    await waitFor(() => expect(menuDeps().t("menu.file.title")).toBe("文档"));
  });

  it("dispatch(\"viewSpecs\") 切到规格页且项目栏「规格」为作用中；dispatch(\"viewBoard\") 回到看板", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("viewSpecs"));
    await waitFor(() => expect(screen.getByTestId("main-titlebar").textContent).toBe("proj-a/规格"));
    expect(within(projectColumn()).getByRole("button", { name: "规格" }).className).toContain(
      "bg-primary",
    );
    act(() => menuDeps().dispatch("viewBoard"));
    await waitFor(() => expect(screen.getByTestId("main-titlebar").textContent).toBe("proj-a/变更"));
    expect(document.querySelector('[data-column="ready"]')).toBeTruthy();
  });

  it("零项目时安装收到 hasProject=false；dispatch(\"openProject\") 开添加项目对话框", async () => {
    render(<App createSession={makeSession(fakeDataSource())} workspace={fakeWorkspace() as never} />);
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    expect(menuDeps().hasProject).toBe(false);
    act(() => menuDeps().dispatch("openProject"));
    const chooser = await screen.findByRole("alertdialog");
    expect(within(chooser).getByRole("button", { name: /本机文档夹/ })).toBeTruthy();
  });

  it("dispatch(\"closeProject\") 关掉作用中项目后重装收到 hasProject=false", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    expect(menuDeps().hasProject).toBe(true);
    act(() => menuDeps().dispatch("closeProject"));
    expect(await screen.findByText("打开一个项目开始")).toBeTruthy();
    await waitFor(() => expect(menuDeps().hasProject).toBe(false));
  });

  it("主窗口不在焦点（系统匣面板在前景）时 dispatch(\"closeProject\") 不关项目", async () => {
    windowSpy.isFocused.mockResolvedValue(false);
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("closeProject"));
    await waitFor(() => expect(windowSpy.isFocused).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("打开一个项目开始")).toBeNull();
    expect(menuDeps().hasProject).toBe(true);
  });

  it("看板显示时 dispatch(\"focusSearch\") 让看板搜索输入取得焦点", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("focusSearch"));
    expect(document.activeElement).toBe(searchInput());
  });

  it("规格页 dispatch(\"focusSearch\") 先切回看板再聚焦搜索输入", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("viewSpecs"));
    await waitFor(() => expect(screen.getByTestId("main-titlebar").textContent).toBe("proj-a/规格"));
    act(() => menuDeps().dispatch("focusSearch"));
    await waitFor(() => expect(document.activeElement).toBe(searchInput()));
    expect(screen.getByTestId("main-titlebar").textContent).toBe("proj-a/变更");
  });

  it("dispatch(\"checkUpdates\") 进设置模式的更新页并运行手动检查", async () => {
    const updater = { check: vi.fn().mockResolvedValue(null), relaunch: vi.fn() };
    renderApp(fakeDataSource(), { updater });
    await screen.findByText("desktop-shell-and-browser");
    const checksBefore = updater.check.mock.calls.length;
    act(() => menuDeps().dispatch("checkUpdates"));
    await waitFor(() => expect(updater.check.mock.calls.length).toBeGreaterThan(checksBefore));
    expect(screen.getByTestId("main-titlebar").textContent).toBe("设置/更新");
    expect(await screen.findByRole("region", { name: "版本" })).toBeTruthy();
  });

  it("dispatch(\"settings\")／dispatch(\"installCli\") 分别进设置模式的一般页与 CLI 页", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("installCli"));
    expect(crumbText()).toBe("设置/CLI");
    act(() => menuDeps().dispatch("settings"));
    expect(crumbText()).toBe("设置/一般");
  });

  it("Scenario「菜单关于直达页」：dispatch(\"about\") 进设置模式的关于页，分类栏关于为作用中、品牌卡带版本列", async () => {
    const loadAppInfo = vi.fn().mockResolvedValue({
      appVersion: "0.8.0",
      engineVersion: "v1.44.0",
      platform: "macOS",
      arch: "arm64",
    });
    renderApp(fakeDataSource(), { loadAppInfo });
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("about"));
    expect(crumbText()).toBe("设置/关于Specseal");
    const column = screen.getByRole("navigation", { name: "设置分类" });
    expect(within(column).getByRole("button", { name: "关于 Specseal" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2, name: "关于 Specseal" })).toBeTruthy();
    const brand = screen.getByTestId("about-brand");
    expect(await within(brand).findByText("0.8.0 · 引擎 v1.44.0 · macOS arm64")).toBeTruthy();
    expect(within(brand).getByText("让 AI 写的每个变更，都对得上规格、查得到证据")).toBeTruthy();
    expect(loadAppInfo).toHaveBeenCalledTimes(1);
  });

  it("Scenario「版本列状态签与更新页同步并可点入」：更新页检查后切到关于页，状态签为已是最新，点签进更新页", async () => {
    const updater = { check: vi.fn().mockResolvedValue(null), relaunch: vi.fn() };
    renderApp(fakeDataSource(), { updater });
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("checkUpdates"));
    expect(await within(screen.getByRole("group", { name: "最新版本" })).findByText("已是最新")).toBeTruthy();
    const column = screen.getByRole("navigation", { name: "设置分类" });
    fireEvent.click(within(column).getByRole("button", { name: "关于 Specseal" }));
    expect(screen.queryByRole("group", { name: "检查更新" })).toBeNull();
    fireEvent.click(within(screen.getByTestId("about-brand")).getByRole("button", { name: "更新状态：已是最新" }));
    expect(crumbText()).toBe("设置/更新");
    expect(within(screen.getByRole("group", { name: "最新版本" })).getByText("已是最新")).toBeTruthy();
  });

  it("dispatch(\"github\")／dispatch(\"reportIssue\") 以 openUrl 开 repo 网址", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    vi.mocked(openUrl).mockClear();
    act(() => menuDeps().dispatch("github"));
    act(() => menuDeps().dispatch("reportIssue"));
    expect(vi.mocked(openUrl).mock.calls).toEqual([
      ["https://github.com/MomoChenisMe/speclink"],
      ["https://github.com/MomoChenisMe/speclink/issues/new"],
    ]);
  });

  it("openUrl 失败时 toast 错误原文", async () => {
    const error = vi.spyOn(toast, "error");
    vi.mocked(openUrl).mockRejectedValueOnce("no default browser");
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    act(() => menuDeps().dispatch("github"));
    await waitFor(() => expect(error).toHaveBeenCalledWith("no default browser"));
    error.mockRestore();
  });
});

// 快捷键卡与实际按键不漂移（desktop-native-menu design D5）：非 macOS 卡片的每一列，按下去
// 都要有 App 的 keydown 或看板搜索列接手（preventDefault）。改了按键却没改卡片时这里会红。
describe("非 macOS 快捷键卡与 keydown 一致", () => {
  const zhT = (key: string) => APP_MESSAGES["zh-CN"][key] ?? key;
  const platform = detectPlatform();
  /** 卡片按键字符串转成要按的键：`Ctrl+W` → w、`Ctrl+Tab` → Tab、`Ctrl+1–9` → 1 与 9。 */
  const keysOf = (keys: string) => {
    const key = keys.replace(/^Ctrl\+/, "");
    if (key.includes("–")) return key.split("–");
    return [key.length === 1 ? key.toLowerCase() : key];
  };

  it("jsdom 以非 macOS 平台渲染", () => {
    expect(platform).not.toBe("macos");
  });

  it.each(buildShortcutList({ t: zhT, platform }).map((row) => [row.text, row.keys] as const))(
    "「%s」%s 有人接手",
    async (_text, keys) => {
      renderApp();
      await screen.findByText("desktop-shell-and-browser");
      for (const key of keysOf(keys)) {
        expect(fireEvent.keyDown(window, { key, ctrlKey: true })).toBe(false);
      }
    },
  );
});

// spec desktop-app「详情页的导览与返回」「变更与讨论详情页的宿主为看板」「详情页与浮层的
// 进出动画」（design D1／D2／D9）：页层覆盖主区、宿主页保持挂载但 inert；面包屑三段、
// ‹ n／m › 与 Esc／⌥↑／⌥↓。
describe("详情页层与导览（desktop-detail-page）", () => {
  const twoChanges = () =>
    fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(
        changeList([
          { name: "change-a", status: "in-progress", totalTasks: 3, completedTasks: 0 },
          { name: "change-b", status: "in-progress", totalTasks: 3, completedTasks: 0 },
        ]),
      ),
    });
  const page = () => screen.queryByTestId("detail-page");
  const host = () => screen.getByTestId("host-page");
  const currentChange = () => (pageSpy.change[pageSpy.change.length - 1]?.change as { name: string } | null)?.name;
  const titlebar = () => screen.getByTestId("main-titlebar");

  // desktop-detail-doc-tree design D3／D4：变更层动作经插槽进主区标题列，「打开 ▾」留在阅读卡标题列。
  it("开已就绪变更：标题列依序为 ‹ n／m ›、分析、封存、更多动作；主区无 card 分页列", async () => {
    renderApp(
      fakeDataSource({
        listChanges: vi.fn().mockResolvedValue(
          changeList([{ name: "ready-one", status: "in-progress", totalTasks: 3, completedTasks: 3 }]),
        ),
      }),
    );
    fireEvent.click(await screen.findByText("ready-one"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(titlebar()).getByRole("button", { name: "封存" })).toBeTruthy());
    const names = within(titlebar())
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "");
    const order = ["上一个", "下一个", "分析", "封存", "更多动作"].map((n) => names.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(within(titlebar()).getByText("1 / 1")).toBeTruthy();
    // 动作不在页层内；页层的 tablist 只有左栏的文档树（直向）。
    expect(within(layer).queryByRole("button", { name: "更多动作" })).toBeNull();
    for (const list of within(layer).getAllByRole("tablist")) {
      expect(list.getAttribute("aria-orientation")).toBe("vertical");
      expect(list.closest("[data-detail-tree]")).toBeTruthy();
    }
  });

  it("标题列动作区：‹ n／m › 之后先一条细线，「分析」为 outline、「封存」为实心主色", async () => {
    renderApp(
      fakeDataSource({
        listChanges: vi.fn().mockResolvedValue(
          changeList([{ name: "ready-one", status: "in-progress", totalTasks: 3, completedTasks: 3 }]),
        ),
      }),
    );
    fireEvent.click(await screen.findByText("ready-one"));
    await screen.findByTestId("detail-page");
    const slot = await waitFor(() => {
      const el = titlebar().querySelector("[data-detail-actions]") as HTMLElement | null;
      expect(el?.firstElementChild).toBeTruthy();
      return el!;
    });
    expect(slot.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(within(slot).getByRole("button", { name: "分析" }).className).toContain("border-input");
    expect(within(slot).getByRole("button", { name: "封存" }).className).toContain("bg-primary");
  });

  it("开 concluded 讨论：「封存」经插槽进主区标题列、不在页层内", async () => {
    renderApp(
      fakeDataSource({
        listDiscussions: vi.fn().mockResolvedValue({
          active: [
            { slug: "settled", topic: "Settled topic", status: "concluded", rounds: 2, created: "2026-07-01", promotedTo: [] },
          ],
          archived: [],
        }),
      }),
    );
    fireEvent.click(await screen.findByText("Settled topic"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(titlebar()).getByRole("button", { name: "封存" })).toBeTruthy());
    expect(within(layer).queryByRole("button", { name: "封存" })).toBeNull();
  });

  it("「打开 ▾」位于阅读卡标题列，不在主区标题列", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    const layer = await screen.findByTestId("detail-page");
    const header = await waitFor(() => {
      const el = layer.querySelector("[data-doc-header]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const open = await within(header).findByRole("button", { name: /打开/ });
    expect(open.className).toContain("border");
    expect(within(titlebar()).queryByRole("button", { name: /^打开/ })).toBeNull();
  });

  it("开已封存变更：标题列只有 ‹ n／m ›，无分析、封存与更多动作", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-04-old", date: "2026-07-04", name: "old", tasksTotal: 2, tasksDone: 2, specCount: 1, createdBy: null, fromDiscussions: [] },
      ]),
      getArchivedDocument: vi.fn().mockResolvedValue("## Why\n\n封存提案内文。"),
    });
    renderApp(ds);
    await waitFor(() => screen.getByText("desktop-shell-and-browser"));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: /已封存/ }));
    fireEvent.click(await screen.findByText("old"));
    const layer = await screen.findByTestId("detail-page");
    await waitFor(() => expect(within(layer).getByText("封存提案内文。")).toBeTruthy());
    expect(within(titlebar()).getByText("1 / 1")).toBeTruthy();
    for (const name of ["分析", "封存", "更多动作"]) {
      expect(within(titlebar()).queryByRole("button", { name })).toBeNull();
    }
  });

  it("开卡后页层覆盖主区、宿主页 inert 且不可见；面包屑三段、项目名等宽", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    const layer = await screen.findByTestId("detail-page");
    expect(layer.className).toContain("absolute");
    expect(layer.className).toContain("inset-0");
    expect(layer.className).toContain("motion-reduce:animate-none");
    expect(host().hasAttribute("inert")).toBe(true);
    expect(host().getAttribute("aria-hidden")).toBe("true");
    expect(host().className).toContain("invisible");
    expect(crumbText()).toBe("proj-a/变更/desktop-shell-and-browser");
    const item = within(screen.getByTestId("main-titlebar")).getByText("desktop-shell-and-browser");
    expect(item.className).toContain("font-mono");
    expect(item.tagName).not.toBe("BUTTON");
  });

  it("Esc 关页回看板，搜索字符串原样保留；宿主页恢复可交互", async () => {
    renderApp();
    const search = await screen.findByPlaceholderText("搜索看板卡片…");
    // 以全名搜索：命中高亮整段包住，卡片名称仍是单一元素。
    fireEvent.change(search, { target: { value: "desktop-shell-and-browser" } });
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(page()).toBeNull());
    expect(host().hasAttribute("inert")).toBe(false);
    expect((screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement).value).toBe(
      "desktop-shell-and-browser",
    );
    expect(crumbText()).toBe("proj-a/变更");
  });

  it("Esc 先给浮层：菜单开着时第一次 Esc 只关菜单，第二次才关页", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(within(titlebar()).getByRole("button", { name: "更多动作" }));
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(page()).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(page()).toBeNull());
  });

  it("⌥↓ 依看板顺序切到下一张卡、到头不循环；‹ n／m › 同步", async () => {
    renderApp(twoChanges());
    fireEvent.click(await screen.findByText("change-a"));
    await screen.findByTestId("detail-page");
    expect(screen.getByText("1 / 2")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    });
    await waitFor(() => expect(currentChange()).toBe("change-b"));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "下一个" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    });
    expect(currentChange()).toBe("change-b");
    fireEvent.click(screen.getByRole("button", { name: "上一个" }));
    await waitFor(() => expect(currentChange()).toBe("change-a"));
  });

  it("焦点在文本输入时 ⌥↓ 与 Esc 都不作用", async () => {
    renderApp(twoChanges());
    fireEvent.click(await screen.findByText("change-a"));
    await screen.findByTestId("detail-page");
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(currentChange()).toBe("change-a");
    expect(page()).toBeTruthy();
  });

  it("切换项目时页层卷回顶端，不沿用上一项的卷动位置", async () => {
    renderApp(twoChanges());
    fireEvent.click(await screen.findByText("change-a"));
    const layer = await screen.findByTestId("detail-page");
    layer.scrollTop = 300;
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    });
    await waitFor(() => expect(currentChange()).toBe("change-b"));
    expect(screen.getByTestId("detail-page").scrollTop).toBe(0);
  });

  it("封存确认在途时 ⌥↓ 不切换（成功后的关页不得关掉切过去的新页）", async () => {
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue(
        changeList([
          { name: "change-a", status: "in-progress", totalTasks: 3, completedTasks: 3 },
          { name: "change-b", status: "in-progress", totalTasks: 3, completedTasks: 3 },
        ]),
      ),
      runVerb: vi.fn(() => new Promise<never>(() => {})),
    });
    renderApp(ds);
    fireEvent.click(await screen.findByText("change-a"));
    await screen.findByTestId("detail-page");
    fireEvent.click(within(titlebar()).getByRole("button", { name: "封存" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.runVerb).toHaveBeenCalledWith("archive", "change-a"));
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    });
    expect(currentChange()).toBe("change-a");
  });

  it("macOS 确认框开着（尚未按确认）时 ⌘[、侧键、触摸板滑动与 ⌥↓ 都不作用", () =>
    onPlatform(MAC_UA, async () => {
      // 确认框属于目前详情页：关页或换页会连同确认框一起收掉。
      renderApp(
        fakeDataSource({
          listChanges: vi.fn().mockResolvedValue(
            changeList([
              { name: "change-a", status: "in-progress", totalTasks: 3, completedTasks: 3 },
              { name: "change-b", status: "in-progress", totalTasks: 3, completedTasks: 3 },
            ]),
          ),
        }),
      );
      fireEvent.click(await screen.findByText("change-a"));
      await screen.findByTestId("detail-page");
      fireEvent.click(within(titlebar()).getByRole("button", { name: "封存" }));
      await screen.findByRole("alertdialog");
      act(() => {
        fireEvent.keyDown(window, { key: "[", metaKey: true });
        fireEvent.mouseUp(window, { button: 3 });
      });
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-progress")).toBe("0.00");
      gesture("ended");
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
      });
      expect(page()).toBeTruthy();
      expect(currentChange()).toBe("change-a");
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    }));

  it("详情页开着时点项目栏「规格」：详情页关闭、主区换成规格页", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    fireEvent.click(screen.getByRole("button", { name: /^规格/ }));
    await waitFor(() => expect(page()).toBeNull());
    expect(crumbText()).toBe("proj-a/规格");
    expect(host().hasAttribute("inert")).toBe(false);
  });

  it("返回钮：只在详情页打开时出现、名称「返回规格」，点击回规格页且搜索字符串保留", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /^规格/ }));
    await screen.findByText("desktop-app");
    expect(screen.queryByRole("button", { name: /^返回/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("搜索规格…"), { target: { value: "desk" } });
    fireEvent.click(screen.getByText("desktop-app"));
    await screen.findByTestId("detail-page");
    const back = within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "返回规格" });
    expect(back.getAttribute("title")).toBe("返回规格（Esc 或 Alt+←）");
    fireEvent.click(back);
    await waitFor(() => expect(page()).toBeNull());
    expect((screen.getByPlaceholderText("搜索规格…") as HTMLInputElement).value).toBe("desk");
    expect(crumbText()).toBe("proj-a/规格");
  });

  it("Alt+←（非 macOS）关页；⌘[ 在非 macOS 不作用；焦点在文本输入时不作用", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    act(() => {
      fireEvent.keyDown(window, { key: "[", metaKey: true });
    });
    expect(page()).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText("搜索看板卡片…"), { key: "ArrowLeft", altKey: true });
    expect(page()).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    });
    await waitFor(() => expect(page()).toBeNull());
  });

  it("鼠标侧键「上一页」（mouseup button 3）关页；其他键不作用", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    act(() => {
      fireEvent.mouseUp(window, { button: 4 });
    });
    expect(page()).toBeTruthy();
    act(() => {
      fireEvent.mouseUp(window, { button: 3 });
    });
    await waitFor(() => expect(page()).toBeNull());
  });

  it("macOS 触摸板两指向右滑过门槛：左缘「←」指示转实心，手指离开的当下关页", () =>
    onPlatform(MAC_UA, async () => {
      renderApp();
      fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
      await screen.findByTestId("detail-page");
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-armed")).toBe("true");
      expect(page()).toBeTruthy();
      gesture("ended");
      expect(page()).toBeNull();
    }));

  it("Windows 详情页：触摸板滑动不出现指示、不关页；Alt+← 才关页", () =>
    onPlatform(WINDOWS_UA, async () => {
      renderApp();
      fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
      await screen.findByTestId("detail-page");
      gesture("began");
      swipeRight();
      expect(swipeIndicator().getAttribute("data-progress")).toBe("0.00");
      gesture("ended");
      expect(page()).toBeTruthy();
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
      });
      await waitFor(() => expect(page()).toBeNull());
    }));

  it("规格详情页与已封存详情页开着时点项目栏切页：详情页先关闭再呈现该页", async () => {
    // spec「详情页的导览与返回」：经项目栏切换主区页面 SHALL 先关闭详情页——四种详情页一体适用。
    renderApp(
      fakeDataSource({
        listArchived: vi.fn().mockResolvedValue([
          { datedName: "2026-07-04-old", date: "2026-07-04", name: "old", createdBy: null, fromDiscussions: [] },
        ]),
      }),
    );
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /^规格/ }));
    fireEvent.click(await screen.findByText("desktop-app"));
    await screen.findByTestId("detail-page");
    fireEvent.click(screen.getByRole("button", { name: /^已封存/ }));
    await waitFor(() => expect(page()).toBeNull());
    expect(crumbText()).toBe("proj-a/已封存");
    fireEvent.click(await screen.findByText("old"));
    await screen.findByTestId("detail-page");
    fireEvent.click(screen.getByRole("button", { name: "手册" }));
    await waitFor(() => expect(page()).toBeNull());
    expect(crumbText()).toBe("proj-a/手册");
    expect(host().hasAttribute("inert")).toBe(false);
  });

  it("面包屑「变更」点击关页、看板可见", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    fireEvent.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "变更" }));
    await waitFor(() => expect(page()).toBeNull());
    expect(document.querySelector('[data-column="ready"]')).toBeTruthy();
  });

  it("系统匣「打开此变更」自已封存页打开：宿主切回看板、落到详情页", async () => {
    renderApp();
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /已封存/ }));
    await waitFor(() => expect(document.querySelector('[data-column="ready"]')).toBeNull());
    await waitFor(() => expect(traySpy.store).not.toBeNull());
    act(() => traySpy.store!.getState().openDetail("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    expect(document.querySelector('[data-column="ready"]')).toBeTruthy();
  });

  it("封存成功后详情页关闭", async () => {
    const ds = fakeDataSource();
    renderApp(ds);
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    fireEvent.click(within(titlebar()).getByRole("button", { name: "封存" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.runVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser"));
    await waitFor(() => expect(page()).toBeNull());
  });

  it("目前变更被外部删除：刷新后详情页关闭、无错误弹窗", async () => {
    const ds = fakeDataSource();
    renderApp(ds);
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    await screen.findByTestId("detail-page");
    await waitFor(() => expect(workspaceHandlers.length).toBeGreaterThan(0));
    (ds.listChanges as Mock).mockResolvedValue(changeList([]));
    workspaceHandlers.forEach((h) => h());
    await waitFor(() => expect(page()).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("规格页宿主时 ‹ n／m › 为规格页过滤后的顺序，⌥↓ 切到下一份规格", async () => {
    const ds = fakeDataSource({
      listSpecs: vi.fn().mockResolvedValue([{ id: "beta" }, { id: "alpha" }, { id: "zeta" }]),
      getSpecDocument: vi.fn(async (cap: string) => `# ${cap}\n\n### Requirement: R\n\n${cap} 内文。\n`),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /^规格/ }));
    await screen.findByText("zeta");
    fireEvent.change(screen.getByPlaceholderText("搜索规格…"), { target: { value: "a" } });
    fireEvent.click(screen.getByText("beta"));
    await screen.findByText("beta 内文。");
    // 过滤后（名称含 a）依名称排序：alpha、beta、zeta。
    expect(screen.getByText("2 / 3")).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    });
    await screen.findByText("zeta 内文。");
    expect(crumbText()).toBe("proj-a/规格/zeta");
  });

  it("手册页宿主时 ‹ n／m › 的 m 为全部规格数", async () => {
    const ds = fakeDataSource({
      listSpecs: vi.fn().mockResolvedValue([{ id: "zeta" }, { id: "desktop-app" }, { id: "alpha" }]),
      listManualPages: vi.fn().mockResolvedValue(MANUAL_INDEX),
      getManualPage: vi.fn().mockResolvedValue("# 看板\n\n看板说明。"),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: "手册" }));
    await screen.findByText("看板说明。");
    fireEvent.click(document.querySelector('[data-manual-page="boards"]') as HTMLElement);
    const sources = await waitFor(() => {
      const el = document.querySelector("[data-manual-sources]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(within(sources).getByRole("button", { name: "desktop-app" }));
    await screen.findByTestId("detail-page");
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("已封存页宿主时 ‹ › 在已封存清单（最新在前）内切换", async () => {
    const ds = fakeDataSource({
      listArchived: vi.fn().mockResolvedValue([
        { datedName: "2026-07-01-first", date: "2026-07-01", name: "first", createdBy: null, fromDiscussions: [] },
        { datedName: "2026-07-02-second", date: "2026-07-02", name: "second", createdBy: null, fromDiscussions: [] },
      ]),
      getArchivedDocument: vi.fn(async (d: string, a: string) => (a === "proposal.md" ? `## Why\n\n${d} 提案。` : null)),
    });
    renderApp(ds);
    await screen.findByText("desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /已封存/ }));
    fireEvent.click(await screen.findByText("second"));
    await screen.findByText("2026-07-02-second 提案。");
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一个" }));
    await screen.findByText("2026-07-01-first 提案。");
    expect(crumbText()).toBe("proj-a/已封存/first");
  });

  it("讨论卡开页：面包屑项目名为 slug", async () => {
    renderApp(
      fakeDataSource({
        listDiscussions: vi.fn().mockResolvedValue({
          active: [
            { slug: "topic-a", topic: "Topic A", status: "open", rounds: 1, created: "2026-07-17", promotedTo: [] },
          ],
          archived: [],
        }),
      }),
    );
    fireEvent.click(await screen.findByText("Topic A"));
    await screen.findByTestId("detail-page");
    expect(crumbText()).toBe("proj-a/变更/topic-a");
    expect(screen.getByText("1 / 1")).toBeTruthy();
  });

  // desktop-change-doc-views design D11：提案能力签切到规格文档；规格文档能力头的「看正式规格」开规格详情页。
  const docViewsSource = () =>
    fakeDataSource({
      getDocument: vi.fn(async (_c: string, artifact: string) =>
        artifact === "proposal.md"
          ? "## Why\n\n- 动机\n\n## Capabilities\n\n### Modified Capabilities\n\n- `desktop-app`: 改版\n"
          : artifact === "specs/desktop-app/spec.md"
            ? "## MODIFIED Requirements\n\n### Requirement: 看板\n\n内文。\n"
            : "# doc",
      ),
      getSpecDocument: vi.fn().mockResolvedValue("# desktop-app Specification\n\n正典内文段落。"),
    });

  it("点提案「能力」段的能力签：左栏「规格」节点作用中", async () => {
    renderApp(docViewsSource());
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    const layer = await screen.findByTestId("detail-page");
    const chip = await waitFor(() => {
      const el = layer.querySelector('[data-section="sections.capabilities"] button[data-capability-chip]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(within(layer).getByRole("tab", { name: /规格/ }).getAttribute("data-state")).toBe("active"),
    );
    expect(layer.querySelector('[data-spec-cap="desktop-app"] [data-capability-header]')).toBeTruthy();
  });

  it("macOS：提案影响段路径签的显示钮为「在 Finder 显示」", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    try {
      renderApp(
        fakeDataSource({
          getDocument: vi.fn(async (_c: string, artifact: string) =>
            artifact === "proposal.md"
              ? "## Impact\n\n- Affected code:\n  - New: a/new.ts\n  - Modified: (none)\n  - Removed: (none)\n"
              : "# doc",
          ),
        }),
      );
      fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
      const layer = await screen.findByTestId("detail-page");
      expect(await within(layer).findByRole("button", { name: "在 Finder 显示" })).toBeTruthy();
      expect(within(layer).queryByRole("button", { name: "在文档管理员显示" })).toBeNull();
    } finally {
      ua.mockRestore();
    }
  });

  it("点规格文档能力头的「看正式规格」：主区换成该能力的规格详情页", async () => {
    const ds = docViewsSource();
    renderApp(ds);
    fireEvent.click(await screen.findByText("desktop-shell-and-browser"));
    const layer = await screen.findByTestId("detail-page");
    fireEvent.mouseDown(await within(layer).findByRole("tab", { name: /规格/ }));
    fireEvent.click(await within(layer).findByRole("button", { name: "看正式规格" }));
    await waitFor(() => expect(within(screen.getByTestId("detail-page")).getByText("正典内文段落。")).toBeTruthy());
    expect(ds.getSpecDocument).toHaveBeenCalledWith("desktop-app");
    // 宿主仍是看板（openSpec 不切宿主页）：面包屑为「项目 / 变更 / 能力名」，Esc 回看板。
    expect(crumbText()).toBe("proj-a/变更/desktop-app");
  });
});

// spec desktop-roadmap「看板页的路线图查看」：卡片与路线图同时挂载，只显示 boardMode 指定的一个。
describe("看板页的路线图查看（desktop-roadmap）", () => {
  const planned = () =>
    fakeDataSource({
      listChanges: vi.fn().mockResolvedValue({
        ...changeList([
          { name: "add-a", status: "in-progress", totalTasks: 4, completedTasks: 0, wave: 1, blockedBy: [], dependsOn: [] },
          {
            name: "add-b",
            status: "in-progress",
            totalTasks: 3,
            completedTasks: 0,
            wave: 2,
            blockedBy: ["add-a"],
            dependsOn: ["add-a"],
          },
        ]),
        next: "add-a",
        unpromotedCuts: [],
      }),
    });

  it("切到路线图再切回看板（Scenario「切到路线图再切回看板」）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp(planned());
    const cards = await screen.findByTestId("board-cards");
    const roadmap = screen.getByTestId("board-roadmap");
    await within(cards).findByText("add-b");
    expect(roadmap.hidden).toBe(true);
    expect(roadmap.hasAttribute("inert")).toBe(true);
    fireEvent.change(within(cards).getByPlaceholderText("搜索看板卡片…"), { target: { value: "add" } });

    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    expect(cards.hidden).toBe(true);
    expect(cards.hasAttribute("inert")).toBe(true);
    expect(roadmap.hidden).toBe(false);
    expect(roadmap.hasAttribute("inert")).toBe(false);
    expect(within(roadmap).getByRole("tab", { name: "路线图" }).getAttribute("aria-selected")).toBe("true");
    expect(roadmap.querySelector('[data-station="add-b"]')).not.toBeNull();
    // 项目栏的「变更」项照旧高亮。
    expect(within(projectColumn()).getByRole("button", { name: "变更" }).className).toContain("bg-primary");

    await user.click(within(roadmap).getByRole("tab", { name: "看板" }));
    expect(cards.hidden).toBe(false);
    expect(roadmap.hidden).toBe(true);
    expect((within(cards).getByPlaceholderText("搜索看板卡片…") as HTMLInputElement).value).toBe("add");
    // 卷动位置与筛选靠「卡片查看一直挂着、不重新挂载」保留：切回后仍是同一个节点。jsdom 没有
    // 版面、量不到卷动，卷动位置由 [M] 6.1 在桌面窗口验收。
    expect(screen.getByTestId("board-cards")).toBe(cards);
  });

  it("自路线图开详情页时 ‹ n／m › 依看板卡片的顺序，不依路线图的列序", async () => {
    // add-a 已开工（进行中栏）、add-b 提案中（提案中栏在前）：卡片顺序 add-b、add-a，
    // 路线图的列序 add-a、add-b。
    const ds = fakeDataSource({
      listChanges: vi.fn().mockResolvedValue({
        ...changeList([
          { name: "add-a", status: "in-progress", totalTasks: 4, completedTasks: 1, wave: 1, blockedBy: [], dependsOn: [] },
          {
            name: "add-b",
            status: "in-progress",
            totalTasks: 3,
            completedTasks: 0,
            wave: 2,
            blockedBy: ["add-a"],
            dependsOn: ["add-a"],
          },
        ]),
        next: null,
      }),
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp(ds);
    const cards = await screen.findByTestId("board-cards");
    await within(cards).findByText("add-b");
    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    const roadmap = screen.getByTestId("board-roadmap");
    expect([...roadmap.querySelectorAll("[data-station]")].map((el) => el.getAttribute("data-station"))).toEqual([
      "add-a",
      "add-b",
    ]);
    fireEvent.click(roadmap.querySelector('[data-station="add-b"]') as HTMLElement);
    await screen.findByTestId("detail-page");
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("路线图显示中按 ⌘F 或菜单「搜索看板」：先切回卡片再聚焦看板搜索", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp(planned());
    const cards = await screen.findByTestId("board-cards");
    await within(cards).findByText("add-b");
    const input = within(cards).getByPlaceholderText("搜索看板卡片…");
    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    act(() => {
      fireEvent.keyDown(window, { key: "f", metaKey: true });
    });
    await waitFor(() => expect(cards.hidden).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(input));

    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    expect(cards.hidden).toBe(true);
    act(() => appMenuSpy.deps[appMenuSpy.deps.length - 1].dispatch("focusSearch"));
    await waitFor(() => expect(cards.hidden).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("以方向键切换查看后，焦点落在新显示那一页的切换上", async () => {
    renderApp(planned());
    const cards = await screen.findByTestId("board-cards");
    await within(cards).findByText("add-b");
    const roadmap = screen.getByTestId("board-roadmap");
    act(() => within(cards).getByRole("tab", { name: "看板" }).focus());
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(roadmap.hidden).toBe(false));
    expect(document.activeElement).toBe(within(roadmap).getByRole("tab", { name: "路线图" }));
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(cards.hidden).toBe(false));
    expect(document.activeElement).toBe(within(cards).getByRole("tab", { name: "看板" }));
  });

  it("自路线图开详情页，按 Esc 回到路线图（Scenario「自路线图开详情页后回到路线图」）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp(planned());
    const cards = await screen.findByTestId("board-cards");
    await within(cards).findByText("add-b");
    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    const roadmap = screen.getByTestId("board-roadmap");
    fireEvent.click(roadmap.querySelector('[data-station="add-b"]') as HTMLElement);
    await screen.findByTestId("detail-page");
    expect(crumbText()).toContain("add-b");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByTestId("detail-page")).toBeNull());
    expect(screen.getByTestId("board-roadmap").hidden).toBe(false);
    expect(screen.getByTestId("board-cards").hidden).toBe(true);
  });

  it("切到其他页再回到变更页时维持路线图（Scenario「切到其他页再回来维持路线图」）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderApp(planned());
    const cards = await screen.findByTestId("board-cards");
    await within(cards).findByText("add-b");
    await user.click(within(cards).getByRole("tab", { name: "路线图" }));
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.queryByTestId("board-roadmap")).toBeNull());
    fireEvent.click(within(projectColumn()).getByRole("button", { name: "变更" }));
    expect((await screen.findByTestId("board-roadmap")).hidden).toBe(false);
    expect(screen.getByTestId("board-cards").hidden).toBe(true);
  });
});

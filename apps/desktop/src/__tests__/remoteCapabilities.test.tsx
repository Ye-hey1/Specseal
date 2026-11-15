// capability 驱动停用（remote-data-source 规格「capability 驱动停用且不伪造
// 缺口」；design 决策 2）：remote 分页的封存／搜索／spec 内文直达，仍停用
// 拖排/validate/analyze/删除附繁中说明；本地分页全功能不变（回归断言）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../App";
import {
  applyRemoteConnectionState,
  createLocalSession,
  type RemoteConnectionStateEvent,
  type WorkspaceSession,
} from "../session";
import type { SpecsealDataSource } from "@specseal/ui";
import { changeList, sharedBoardRequirement } from "./helpers/changeList";
import { fakeRemoteDs, fakeRemoteSession, REMOTE_KEY } from "./helpers/remoteFixtures";

// reader 写入面的角色停用说明（server-reader-write-guard D5）。
const ROLE = "你的角色为查看者，只能查看";

// Tauri 事件层 mock（App 的 session 事件订阅走它）。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// sonner Toaster 需要 jsdom 没有的 matchMedia——以 marker 取代（比照 App.test）。
vi.mock("@specseal/ui", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@specseal/ui")>();
  return { ...mod, Toaster: () => <div data-testid="app-toaster" /> };
});

beforeEach(() => {
  localStorage.removeItem("specseal.projectTabs");
  localStorage.setItem("specseal.uiLocale", "zh-CN");
});

function fakeWorkspace() {
  return {
    openProject: vi.fn().mockRejectedValue("not a project"),
    initProject: vi.fn(),
    startupDir: vi.fn().mockRejectedValue("no startup dir"),
    projectStats: vi.fn().mockResolvedValue({ pendingWrapUp: 0 }),
    watchWorkspace: vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
  };
}

/** 以持久化 remote 分页启动 App：restoreTabs → activateTab → openRemote 重验。 */
function renderRemoteApp(
  ds: SpecsealDataSource,
  capsOver: Partial<import("../session").WorkspaceCapabilities> = {},
  sessionOver: Partial<WorkspaceSession> = {},
) {
  localStorage.setItem(
    "specseal.projectTabs",
    JSON.stringify({
      version: 2,
      tabs: [
        {
          locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "backend" },
          name: "Demo/backend",
        },
      ],
      activeKey: REMOTE_KEY,
    }),
  );
  const openRemote = vi.fn(async (): Promise<WorkspaceSession> => {
    const session = fakeRemoteSession(ds);
    return { ...session, ...sessionOver, capabilities: { ...session.capabilities, ...capsOver } };
  });
  render(
    <App
      createSession={() => {
        throw new Error("remote 流程不应触发 local 工厂");
      }}
      openRemote={openRemote}
      workspace={fakeWorkspace() as never}
    />,
  );
  return { openRemote };
}

/** 本地对照组：持久化 local 分页＋全真 capability 的 local session。 */
function renderLocalApp(ds: SpecsealDataSource) {
  localStorage.setItem(
    "specseal.projectTabs",
    JSON.stringify({
      version: 2,
      tabs: [{ locator: { kind: "local", root: "A" }, name: "proj-a" }],
      activeKey: "local:A",
    }),
  );
  const ws = fakeWorkspace();
  ws.openProject = vi.fn().mockResolvedValue({ status: "project", root: "A", name: "proj-a" });
  const invoke = (async () => null) as never;
  render(
    <App
      createSession={(root, name) => {
        const session = createLocalSession(root, { name, invoke });
        return { ...session, dataSource: ds };
      }}
      workspace={ws as never}
    />,
  );
}

/** 展开详情页的「⋯」菜单，回传「删除」项。 */
async function openDeleteItem(): Promise<HTMLElement> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  // 变更层动作经插槽进主区标题列（desktop-detail-doc-tree design D3）。
  await user.click(within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "更多动作" }));
  return screen.findByRole("menuitem", { name: /删除/ });
}

/** 收起「⋯」菜单（Esc 先给菜单，详情页维持打开）。 */
async function closeMenu() {
  await userEvent.setup({ pointerEventsCheck: 0 }).keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/** 「⋯」菜单项的停用原因（项目下方灰字）。 */
const menuReason = (item: HTMLElement) => item.querySelector("[data-menu-reason]")?.textContent ?? "";

describe("remote 分页的 capability 停用", () => {
  it("reader 看板不渲染拖排把手并显示繁中角色说明", async () => {
    renderRemoteApp(fakeRemoteDs());
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    expect(document.querySelector('[aria-roledescription="sortable"]')).toBeNull();
    expect(screen.getByText(ROLE)).toBeTruthy();
  });

  it("搜索输入激活并直达 server、看板照常呈现数据", async () => {
    const ds = fakeRemoteDs();
    renderRemoteApp(ds);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    const input = screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(ds.searchWorkspace).toHaveBeenCalledWith("needle"));
  });

  it("archived 页呈现 server 清单、不再显示缺口提示卡", async () => {
    const ds = fakeRemoteDs();
    renderRemoteApp(ds);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "已封存" }));
    await waitFor(() => expect(screen.getByText("remote-old")).toBeTruthy());
    expect(screen.queryByTestId("archived-unavailable")).toBeNull();
    expect(ds.listArchived).toHaveBeenCalled();
  });

  it("规格卡直达 server 正典内文、不再以提示文本代替", async () => {
    const ds = fakeRemoteDs();
    renderRemoteApp(ds);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    const aside = screen.getByRole("navigation", { name: "项目导览" });
    fireEvent.click(within(aside).getByRole("button", { name: "规格" }));
    await waitFor(() => expect(screen.getByText("auth")).toBeTruthy());
    fireEvent.click(screen.getByText("auth"));
    await waitFor(() => expect(screen.getByText("Remote canonical truth.")).toBeTruthy());
    expect(ds.getSpecDocument).toHaveBeenCalledWith("auth");
  });

  it("详情页的分析与删除停用附繁中说明、封存照常可用", async () => {
    renderRemoteApp(fakeRemoteDs());
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    const analyze = (await screen.findByRole("button", { name: /分析/ })) as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    expect(analyze.title).toContain("validate/analyze");
    const archive = within(screen.getByTestId("main-titlebar")).getByRole("button", { name: "封存" }) as HTMLButtonElement;
    expect(archive.disabled).toBe(false);
    // 删除在「⋯」菜单：停用时项目下方灰字为能力缺口原因。
    const del = await openDeleteItem();
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(menuReason(del)).toBe(ROLE);
  });

  it("详情抽屉的诠释数据与 capability 清单直达、不再呈现停用说明", async () => {
    // remote-read-parity「诠释数据与 capability 清单直达且诚实降级」：两读取
    // 走 dataSource 方法（status payload 映射），创建者列与本地同形呈现。
    const ds = fakeRemoteDs();
    renderRemoteApp(ds);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    await waitFor(() => expect(ds.changeMeta).toHaveBeenCalledWith("remote-change"));
    expect(ds.changeCapabilities).toHaveBeenCalledWith("remote-change");
    await waitFor(() => expect(screen.getByText("Remote Creator")).toBeTruthy());
    expect(screen.queryByText(/尚未提供「capability 清单」/)).toBeNull();
    expect(screen.queryByText(/尚未提供「change 诠释数据」/)).toBeNull();
  });

  it("旧 server 缺归属字段时对应列缺席且无错误", async () => {
    // 诚实降级：旧 server 的 status payload 无新字段——changeMeta 组出的字段
    // 为 null／缺席，UI 对应列不显示、抽屉照常呈现，不伪造任何值。
    const ds = fakeRemoteDs({
      changeMeta: vi.fn().mockResolvedValue({
        schema: "spec-driven",
        created: null,
        createdBy: null,
        createdWith: null,
        fromDiscussions: [],
        startedAt: null,
        startedBy: null,
      }),
      changeCapabilities: vi.fn().mockResolvedValue([]),
    });
    renderRemoteApp(ds);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    await waitFor(() => expect(ds.changeMeta).toHaveBeenCalledWith("remote-change"));
    // 抽屉正常打开（封存钮在）且创建者列缺席。
    await screen.findByRole("button", { name: "封存" });
    expect(screen.queryByText("Remote Creator")).toBeNull();
  });

  it("remote 封存沿用确认路径、描述指出 Project/Repo scope，取消不写入而确认会写 server", async () => {
    const ds = fakeRemoteDs();
    renderRemoteApp(ds);
    await screen.findByText("remote-change");
    fireEvent.click(screen.getByText("remote-change"));
    fireEvent.click(await screen.findByRole("button", { name: "封存" }));

    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/server 上的 scope：Demo\/backend/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(ds.runVerb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "封存" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.runVerb).toHaveBeenCalledWith("archive", "remote-change"));
  });

  // --- spec desktop-app「remote 项目的审查与验证标示」（station-status-and-landing D7）---

  /** remote 清单：四个已就绪的变更，审查站各一种状态；`verified` 另带验证站的章。 */
  function stationDs(over: Partial<SpecsealDataSource> = {}) {
    const ready = { status: "in-progress", totalTasks: 2, completedTasks: 2 } as const;
    return fakeRemoteDs({
      listChanges: vi.fn().mockResolvedValue(
        changeList([
          { name: "under-review", ...ready, reviewStatus: "inReview" },
          { name: "reviewed-change", ...ready, reviewStatus: "reviewed", verifyStatus: "verified" },
          { name: "changed-since", ...ready, reviewStatus: "reviewedStale" },
          { name: "no-station-data", ...ready },
        ]),
      ),
      // 审查中的变更详情页会读工单（remote 数据源直达 server）。
      getStationTicket: vi.fn().mockResolvedValue(null),
      ...over,
    });
  }

  /** 卡片：以变更名称找到它所在的 [data-change]；标示是带 aria-label 的图标。 */
  const cardOf = (name: string) => screen.getByText(name).closest("[data-change]") as HTMLElement;

  it("remote 卡片依关卡数据显示既有的标示，没有数据时没有标示", async () => {
    renderRemoteApp(stationDs());
    await screen.findByText("under-review");
    expect(within(cardOf("under-review")).getByLabelText("审查中")).toBeTruthy();
    expect(within(cardOf("reviewed-change")).getByLabelText("已审查")).toBeTruthy();
    expect(within(cardOf("reviewed-change")).getByLabelText("已验证")).toBeTruthy();
    expect(within(cardOf("changed-since")).getByLabelText("已审查·其后有变动")).toBeTruthy();
    const plain = cardOf("no-station-data");
    for (const label of ["审查中", "已审查", "已审查·其后有变动", "验证中", "已验证"]) {
      expect(within(plain).queryByLabelText(label), label).toBeNull();
    }
  });

  it("封存审查中的 remote 变更出现三选项对话框，选「照样带走」调用带旗标的封存", async () => {
    const archiveCarry = vi.fn().mockResolvedValue({});
    const ds = stationDs({ archiveCarry });
    renderRemoteApp(ds);
    fireEvent.click(await screen.findByText("under-review"));
    fireEvent.click(await screen.findByRole("button", { name: "封存" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("此变更审查中")).toBeTruthy();
    for (const option of ["前往完成盖章", "放弃审查", "照样带走"]) {
      expect(within(dialog).getByRole("button", { name: option })).toBeTruthy();
    }
    expect(archiveCarry).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "照样带走" }));
    await waitFor(() => expect(archiveCarry).toHaveBeenCalledWith("under-review", true, false));
    expect(ds.runVerb).not.toHaveBeenCalled();
  });

  it("没有关卡数据的 remote 变更封存走一般确认，不出现三选项对话框", async () => {
    const archiveCarry = vi.fn().mockResolvedValue({});
    const ds = stationDs({ archiveCarry });
    renderRemoteApp(ds);
    fireEvent.click(await screen.findByText("no-station-data"));
    fireEvent.click(await screen.findByRole("button", { name: "封存" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("button", { name: "照样带走" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "封存" }));
    await waitFor(() => expect(ds.runVerb).toHaveBeenCalledWith("archive", "no-station-data"));
    expect(archiveCarry).not.toHaveBeenCalled();
  });

  it("offline mask 同时维持 deleteChange 停用并关闭 archive 与前置编辑", () => {
    const base = fakeRemoteSession(fakeRemoteDs());
    const session = { ...base, capabilities: { ...base.capabilities, setDepends: true } };
    const offline = applyRemoteConnectionState(
      {
        ...session,
        baseCapabilities: session.capabilities,
        connectionState: { connectionId: "c1", state: "online", message: null },
      },
      { connectionId: "c1", state: "offline", message: "offline" },
    );
    expect(offline.capabilities.deleteChange).toBe(false);
    expect(offline.capabilities.archive).toBe(false);
    expect(offline.capabilities.setDepends).toBe(false);
  });
});

describe("reader 的停用说明依连接状态（server-reader-write-guard D5）", () => {
  const READER_CAPS = {
    deleteChange: false,
    setTaskDone: false,
    setAllTasks: false,
    moveTask: false,
    archive: false,
    promoteDiscussion: false,
    archiveDiscussion: false,
    reorderCard: false,
    setDepends: false,
    claim: false,
  };
  const OFFLINE = "目前为 stale 唯读状态——恢复连接后才能写入";

  it("online 时写入面说明指出角色，脱机后改为脱机版说明，恢复连接后回到角色说明", async () => {
    let pushState: ((event: RemoteConnectionStateEvent) => void) | undefined;
    renderRemoteApp(fakeRemoteDs({ claim: vi.fn() } as never), READER_CAPS, {
      events: {
        subscribe: (_onChange, onConnectionState) => {
          pushState = onConnectionState;
          return () => {};
        },
      },
    });
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    expect(screen.getByText(ROLE), "看板排序说明").toBeTruthy();

    fireEvent.click(screen.getByText("remote-change"));
    const archive = (await screen.findByRole("button", { name: "封存" })) as HTMLButtonElement;
    const claim = screen.getByRole("button", { name: /认领/ }) as HTMLButtonElement;
    for (const button of [archive, claim]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(ROLE);
    }
    const deleteReason = async () => {
      const item = await openDeleteItem();
      expect(item.getAttribute("aria-disabled")).toBe("true");
      const reason = menuReason(item);
      await closeMenu();
      return reason;
    };
    expect(await deleteReason()).toBe(ROLE);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    expect(await screen.findByTestId("tasks-unavailable")).toHaveProperty("textContent", ROLE);

    await waitFor(() => expect(pushState).toBeDefined());
    act(() => pushState!({ connectionId: "c1", state: "offline", message: null }));
    await waitFor(() => expect(archive.title).toBe(OFFLINE));
    expect(claim.title).toBe(OFFLINE);
    expect(await deleteReason()).toBe(OFFLINE);
    expect(screen.getByTestId("tasks-unavailable").textContent).toBe(OFFLINE);
    expect(screen.queryByText(ROLE)).toBeNull();

    act(() => pushState!({ connectionId: "c1", state: "online", message: null }));
    await waitFor(() => expect(archive.title).toBe(ROLE));
    for (const button of [archive, claim]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(ROLE);
    }
    expect(await deleteReason()).toBe(ROLE);
    expect(screen.getByTestId("tasks-unavailable").textContent).toBe(ROLE);
  });

  it("editor 的写入面没有角色停用说明", async () => {
    const editorCaps = Object.fromEntries(Object.keys(READER_CAPS).map((key) => [key, true]));
    renderRemoteApp(fakeRemoteDs({ claim: vi.fn() } as never), editorCaps);
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    const archive = (await screen.findByRole("button", { name: "封存" })) as HTMLButtonElement;
    expect(archive.disabled).toBe(false);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await screen.findAllByRole("checkbox");
    expect(screen.queryByTestId("tasks-unavailable")).toBeNull();
    expect(screen.queryByText(ROLE)).toBeNull();
  });
});

describe("调度分页的前置编辑依 role（add-change-plan-remote D7）", () => {
  /** 带 plan 调度字段的 remote 清单：remote-change 第 2 波、前置 base-change，
   * 与 other-change 同动「看板与任务」且排在它之后封存。 */
  function plannedDs() {
    const item = (name: string, wave: number, dependsOn: string[], overlapWith: string[], archiveAfter: string[]) => ({
      name,
      status: "in-progress",
      totalTasks: 2,
      completedTasks: 0,
      wave,
      blockedBy: dependsOn,
      dependsOn,
      overlaps: overlapWith.map((change) => ({ change, capabilities: ["desktop-app"] })),
      requirementOverlap: overlapWith.map(sharedBoardRequirement),
      archiveAfter,
    });
    const changes = [
      item("base-change", 1, [], [], []),
      item("other-change", 1, [], ["remote-change"], []),
      item("remote-change", 2, ["base-change"], ["other-change"], ["other-change"]),
    ];
    return fakeRemoteDs({
      listChanges: vi.fn().mockResolvedValue(changeList(changes)),
      setDepends: vi.fn().mockResolvedValue(undefined),
    } as never);
  }

  async function openPlanTab() {
    // 带波次的变更也是隐藏路线图上的站（desktop-roadmap）：点卡片查看的卡。
    const cards = () => within(screen.getByTestId("board-cards"));
    await waitFor(() => expect(cards().getByText("remote-change")).toBeTruthy());
    fireEvent.click(cards().getByText("remote-change"));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /调度/ }));
    // 状态卡的调度列也写「第 2 波」——以调度分页的波次卡为准。
    await waitFor(() =>
      expect(document.querySelector('[data-plan-section="wave"]')?.textContent).toContain("第 2 波"),
    );
  }

  it("editor 可在调度分页添加与移除前置，写入走数据源 setDepends", async () => {
    const ds = plannedDs();
    renderRemoteApp(ds, { setDepends: true });
    await openPlanTab();
    expect(screen.getByRole("combobox", { name: "添加前置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除前置 base-change" }));
    await waitFor(() =>
      expect(ds.setDepends).toHaveBeenCalledWith("remote-change", ["base-change"], true),
    );
  });

  it("reader 的调度分页四卡照常显示、没有编辑控制项", async () => {
    // Scenario「remote 分页唯读」：清单的调度字段照样进四张卡片，只是不长移除钮与添加下拉。
    const ds = plannedDs();
    renderRemoteApp(ds, { setDepends: false });
    await openPlanTab();
    const section = (name: string) => document.querySelector(`[data-plan-section="${name}"]`) as HTMLElement;
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-plan-section]"));
    expect(cards.map((c) => c.dataset.planSection)).toEqual(["wave", "depends", "overlaps", "archive"]);
    const depends = section("depends");
    expect(within(depends).getByText("base-change")).toBeTruthy();
    expect(within(depends).getByText("等 1 项")).toBeTruthy();
    expect(within(depends).queryByRole("button", { name: /移除前置/ })).toBeNull();
    expect(within(depends).queryByRole("combobox", { name: "添加前置" })).toBeNull();
    expect(within(section("overlaps")).getByText("other-change")).toBeTruthy();
    expect(within(section("overlaps")).getByText("desktop-app › 看板与任务")).toBeTruthy();
    expect(within(section("archive")).getByText("other-change")).toBeTruthy();
  });
});

describe("认领面依 capability 与模式呈现（remote-claim-ownership）", () => {
  it("editor 的 remote 抽屉提供可点的认领操作", async () => {
    const claim = vi.fn().mockResolvedValue(undefined);
    renderRemoteApp(fakeRemoteDs({ claim } as never));
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    const button = (await screen.findByRole("button", { name: /认领/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(claim).toHaveBeenCalledWith("remote-change"));
  });

  it("reader 的认领操作停用并附繁中角色说明", async () => {
    const claim = vi.fn();
    renderRemoteApp(
      fakeRemoteDs({ claim } as never),
      { claim: false },
    );
    await waitFor(() => expect(screen.getByText("remote-change")).toBeTruthy());
    fireEvent.click(screen.getByText("remote-change"));
    const button = (await screen.findByRole("button", { name: /认领/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(ROLE);
    fireEvent.click(button);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("本地分页不受影响（回归）", () => {
  it("搜索照常可用、分析与删除照常可点", async () => {
    const ds = fakeRemoteDs({
      // 本地全功能：改用可解析的本地行为样本。
      listChanges: vi.fn().mockResolvedValue(changeList([
        { name: "local-change", status: "in-progress", totalTasks: 2, completedTasks: 0 },
      ])),
      listArchived: vi.fn().mockResolvedValue([]),
      changeCapabilities: vi.fn().mockResolvedValue([]),
      changeMeta: vi.fn().mockResolvedValue(null),
      // 本地后端没有 claim（RemoteOnly）——镜射真实 tauriDataSource 的形状。
      claim: undefined,
    } as never);
    renderLocalApp(ds);
    await waitFor(() => expect(screen.getByText("local-change")).toBeTruthy());
    const input = screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement;
    expect(input.disabled).toBe(false);

    fireEvent.click(screen.getByText("local-change"));
    const analyze = (await screen.findByRole("button", { name: /分析/ })) as HTMLButtonElement;
    expect(analyze.disabled).toBe(false);
    // claim 是 RemoteOnly 动词——本地分页连停用的入口都不长出来。
    expect(screen.queryByRole("button", { name: /认领/ })).toBeNull();
    const del = await openDeleteItem();
    expect(del.getAttribute("aria-disabled")).toBeNull();
    expect(menuReason(del)).toBe("");
    expect(screen.queryByRole("button", { name: /认领/ })).toBeNull();
    // 本地照常打 listArchived（capability 全真）。
    expect(ds.listArchived).toHaveBeenCalled();
  });
});

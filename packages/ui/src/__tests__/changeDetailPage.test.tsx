import { describe, it, expect, vi, type Mock } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

import { ChangeDetailPage } from "../components/ChangeDetailPage";
import type { DocumentTarget } from "../components/DetailHeader";
import { DELTA_COLORS } from "../components/DeltaBadges";
import type { ChangeItem } from "../adapter";

// 拦截 TaskList props 以验证详情页→拖放回呼的接线（jsdom 无法真拖）。
const { taskListProps } = vi.hoisted(() => ({
  taskListProps: [] as Array<Record<string, unknown>>,
}));
vi.mock("../components/TaskList", () => ({
  TaskList: (props: Record<string, unknown>) => {
    taskListProps.push(props);
    return <div data-testid="tasklist-stub" />;
  },
}));

const change: ChangeItem = {
  name: "desktop-shell-and-browser",
  status: "in-progress",
  totalTasks: 30,
  completedTasks: 30,
};

const SPEC_MD = "## ADDED Requirements\n\n### Requirement: a\nb\n\n### Requirement: c\nd\n";

function makeProps(over: Record<string, unknown> = {}) {
  return {
    change,
    loadDocument: vi.fn(async (_c: string, artifact: string) =>
      artifact.startsWith("specs/") ? SPEC_MD : `# doc for ${artifact}`,
    ),
    loadCapabilities: vi.fn(async () => ["desktop-app"]),
    loadMeta: vi.fn(async () => ({ created: "2026-07-05", createdBy: "MomoChen", createdWith: "claude" })),
    onRunVerb: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

/** 规格文档里需求段的标题（delta 查看的需求段标题为 h3）。 */
const requirementTitles = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("[data-requirement] h3")).map((h) => h.textContent);

/** 展开标题列右端的「⋯」菜单（封存／删除两项）。 */
async function openMoreMenu() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByRole("button", { name: "更多动作" }));
  await screen.findByRole("menu");
  return user;
}

/** 「⋯」菜单项的停用原因（项目下方灰字）。 */
const menuReason = (item: HTMLElement) => item.querySelector("[data-menu-reason]")?.textContent ?? "";

// spec 需求「规格分页 delta 区段以色标呈现」的渲染面（design D4 色标区段、配色对齐 DeltaBadges）。
describe("规格分页 delta 区段色标", () => {
  const DELTA_MD =
    "## ADDED Requirements\n\n### Requirement: a\nb\n\n## MODIFIED Requirements\n\n### Requirement: c\nd\n\n## REMOVED Requirements\n\n### Requirement: e\nf\n\n## RENAMED Requirements\n\n### Requirement: g\nh\n";

  async function openSpecsTab(specMd: string) {
    const props = makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) =>
        artifact.startsWith("specs/") ? specMd : `# doc for ${artifact}`,
      ),
    });
    const result = render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => screen.getByRole("tab", { name: /规格/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    return result;
  }

  it("delta 区段呈现色标标头（配色与 DeltaBadges 同一常数来源），原始标题文本不直出", async () => {
    const { baseElement } = await openSpecsTab(DELTA_MD);
    await waitFor(() =>
      expect(baseElement.querySelector('[data-delta-section="added"]')).toBeTruthy(),
    );
    const added = baseElement.querySelector('[data-delta-section="added"]') as HTMLElement;
    const modified = baseElement.querySelector('[data-delta-section="modified"]') as HTMLElement;
    expect(within(added).getByText("添加")).toBeTruthy();
    expect(within(modified).getByText("修改")).toBeTruthy();
    expect(added.className).toContain(DELTA_COLORS.added);
    expect(modified.className).toContain(DELTA_COLORS.modified);
    // spec「章节标题为 16px 粗体」：色标标头与章节标题同款、保留各色（desktop-change-doc-views design D6）。
    expect(added.className).toContain("text-base");
    expect(added.className).toContain("font-semibold");
    expect(added.className).not.toContain("text-xs");
    // Example「四种 delta 区段的色标对应」其余两列：移除红、更名蓝。
    const removed = baseElement.querySelector('[data-delta-section="removed"]') as HTMLElement;
    const renamed = baseElement.querySelector('[data-delta-section="renamed"]') as HTMLElement;
    expect(within(removed).getByText("移除")).toBeTruthy();
    expect(within(renamed).getByText("更名")).toBeTruthy();
    expect(removed.className).toContain(DELTA_COLORS.removed);
    expect(renamed.className).toContain(DELTA_COLORS.renamed);
    expect(screen.queryByText(/REMOVED Requirements/)).toBeNull();
    expect(screen.queryByText(/RENAMED Requirements/)).toBeNull();
    // 原始机器标题不以标题文本直出。
    expect(screen.queryByText(/ADDED Requirements/)).toBeNull();
    expect(screen.queryByText(/MODIFIED Requirements/)).toBeNull();
    // ADDED／MODIFIED 的需求成需求段；REMOVED／RENAMED 照 prose。
    expect(requirementTitles(baseElement)).toEqual(["a", "c"]);
    // prose 的 h3 同时是本页目录的锚点：断言限定在阅读卡内文。
    const body = baseElement.querySelector("[data-doc-body]") as HTMLElement;
    expect(within(body).getByText(/Requirement: e/)).toBeTruthy();
  });

  it("无 delta 标记的规格整篇照常渲染（无色标标头）", async () => {
    const { baseElement } = await openSpecsTab("# 正式规格\n\n### Requirement: plain\n本文。\n");
    await waitFor(() => expect(screen.getByText(/Requirement: plain/)).toBeTruthy());
    expect(baseElement.querySelector("[data-delta-section]")).toBeNull();
  });
});

// spec 需求「提案与设计章节以中文标签呈现」的接线面（design D3）。
describe("提案／设计分页章节标签", () => {
  it("提案分页呈现中文章节标签，英文模板标题不直出", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) =>
        artifact === "proposal.md" ? "## Why\n\n动机内文。\n\n## What Changes\n\n- 变更项\n" : SPEC_MD,
      ),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("动机内文。")).toBeTruthy());
    // 章节标签同时是本页目录的锚点：断言限定在阅读卡内文。
    const body = within(document.querySelector("[data-doc-body]") as HTMLElement);
    expect(body.getByText("为什幺")).toBeTruthy();
    expect(body.getByText("变更内容")).toBeTruthy();
    expect(screen.queryByText("Why")).toBeNull();
    expect(screen.queryByText("What Changes")).toBeNull();
  });
});

// remote-data-source 手动验证回归：空壳 change（server 上尚无 proposal 文档）
// loadDocument 回 null——「不存在」须呈现尚无文案，不得与「加载中」共用同一字样。
describe("提案分页加载中／不存在分流", () => {
  it("loadDocument 回 null 时显示尚无提案文案，而非加载中", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async () => null),
      loadCapabilities: vi.fn(async () => []),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("（此 change 尚无提案内容）")).toBeTruthy());
    expect(screen.queryByText("加载中…")).toBeNull();
  });

  // 原意图不变（加载中 ≠ 不存在）；呈现面自「加载中…」文本改为文档骨架
  // （spec「抽屉文档加载以 skeleton 呈现」，desktop-loading-skeleton-ux）。
  it("加载未完成（promise 未解决）时显示文档骨架", async () => {
    const props = makeProps({
      loadDocument: vi.fn(() => new Promise<string>(() => {})),
      loadCapabilities: vi.fn(async () => []),
      loadMeta: vi.fn(() => new Promise<never>(() => {})),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（此 change 尚无提案内容）")).toBeNull();
  });
});

describe("ChangeDetailPage", () => {
  it("renders metadata row (author, agent, task count) and progress", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("MomoChen")).toBeTruthy());
    expect(screen.getByText(/claude/)).toBeTruthy();
    expect(screen.getAllByText(/30\/30/).length).toBeGreaterThan(0);
  });

  it("标头拷贝名称钮写入变更名，成功以 status 声明「已拷贝」（共用 CopyButton）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    fireEvent.click(screen.getByRole("button", { name: "拷贝名称" }));
    expect(writeText).toHaveBeenCalledWith("desktop-shell-and-browser");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已拷贝"));
  });

  it("shows spec delta counts on the specs tab", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText(/\+2/)).toBeTruthy());
  });

  it("forwards a drag-reorder drop to onMoveTask; reload rides the refreshGen bump", async () => {
    const props = makeProps({ onMoveTask: vi.fn().mockResolvedValue(undefined) });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    // TaskList 挂在任务分页下——先切分页（Radix TabsTrigger 以 mousedown 触发）。
    await waitFor(() => screen.getByRole("tab", { name: /任务/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.length).toBeGreaterThan(0));
    const latest = taskListProps[taskListProps.length - 1] as {
      onReorder?: (from: number, to: number, before?: boolean) => Promise<void> | void;
    };
    expect(typeof latest.onReorder).toBe("function");
    const tasksReads = () =>
      (props.loadDocument as Mock).mock.calls.filter((c) => c[1] === "tasks.md").length;
    const before = tasksReads();
    // onReorder 直呼绕过事件系统，内部 state 更新须明确包 act。
    await act(async () => {
      await latest.onReorder!(2, 5);
    });
    // 一次到位转发 from/to（侧别未指定）。
    expect((props as { onMoveTask: Mock }).onMoveTask).toHaveBeenCalledWith(
      "desktop-shell-and-browser",
      2,
      5,
      undefined,
    );
    // design D2：独立局部重读已移除——重载由宿主 refresh 后的世代递增驱动。
    expect(tasksReads()).toBe(before);
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(tasksReads()).toBeGreaterThan(before));
    // 标题落点（design D7 moveTask 侧别）：before=true 转发至第四参数。
    await act(async () => {
      await latest.onReorder!(1, 3, true);
    });
    expect((props as { onMoveTask: Mock }).onMoveTask).toHaveBeenCalledWith(
      "desktop-shell-and-browser",
      1,
      3,
      true,
    );
  });

  it("reloads documents and meta in place when refreshGen advances (external change)", async () => {
    const props = makeProps();
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => expect(screen.getByText("MomoChen")).toBeTruthy());
    expect(screen.queryByText(/开工/)).toBeNull();
    const docCalls = () => (props.loadDocument as Mock).mock.calls.length;
    const metaCalls = () => (props.loadMeta as Mock).mock.calls.length;
    const d0 = docCalls();
    const m0 = metaCalls();
    // 外部写者盖开工章后 watcher 触发 refresh → 世代递增 → 开着的抽屉重载至磁盘现况。
    (props.loadMeta as Mock).mockResolvedValue({
      created: "2026-07-05",
      createdBy: "MomoChen",
      createdWith: "claude",
      startedAt: "2026-07-07",
      startedBy: "Worker <w@example.com>",
    });
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(docCalls()).toBeGreaterThan(d0));
    await waitFor(() => expect(metaCalls()).toBeGreaterThan(m0));
    await waitFor(() => expect(screen.getByText(/开工 2026-07-07/)).toBeTruthy());
  });

  it("defers the refreshGen reload while a task interaction is in flight, catches up after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const props = makeProps({ onToggleTask: vi.fn(() => gate) });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => screen.getByRole("tab", { name: /任务/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.length).toBeGreaterThan(0));
    const latest = taskListProps[taskListProps.length - 1] as {
      onToggle?: (ordinal: number, done: boolean) => void;
    };
    const tasksReads = () =>
      (props.loadDocument as Mock).mock.calls.filter((c) => c[1] === "tasks.md").length;
    const before = tasksReads();
    act(() => latest.onToggle!(1, true)); // 交互进行中（onToggleTask 未 resolve）
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await new Promise((r) => setTimeout(r, 25));
    // 让路：交互未结束前外部世代不触发重载，不打断进行中操作。
    expect(tasksReads()).toBe(before);
    await act(async () => release()); // 交互结束 → 补载一次
    await waitFor(() => expect(tasksReads()).toBeGreaterThan(before));
  });

  it("defers the refreshGen reload while a drag gesture is active, catches up after drop", async () => {
    // spec：让路涵盖「拖曳排序进行中」（按住～放开），不只放开后的写回等待。
    const props = makeProps();
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => screen.getByRole("tab", { name: /任务/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.length).toBeGreaterThan(0));
    const latest = taskListProps[taskListProps.length - 1] as {
      onDragActiveChange?: (active: boolean) => void;
    };
    expect(typeof latest.onDragActiveChange).toBe("function");
    const tasksReads = () =>
      (props.loadDocument as Mock).mock.calls.filter((c) => c[1] === "tasks.md").length;
    const before = tasksReads();
    act(() => latest.onDragActiveChange!(true)); // 拖曳手势开始（尚未放开）
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await new Promise((r) => setTimeout(r, 25));
    expect(tasksReads()).toBe(before); // 拖曳中外部世代不重载
    act(() => latest.onDragActiveChange!(false)); // 放开
    await waitFor(() => expect(tasksReads()).toBeGreaterThan(before)); // 补载一次
  });

  it("discards stale responses when a newer refreshGen load raced ahead (latest-wins)", async () => {
    const pendingProposal: Array<(v: string) => void> = [];
    const props = makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) => {
        if (artifact === "proposal.md") return new Promise<string>((r) => pendingProposal.push(r));
        return artifact.startsWith("specs/") ? SPEC_MD : `# doc for ${artifact}`;
      }),
    });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => expect(pendingProposal.length).toBe(1)); // 初载请求（gen 0）
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(pendingProposal.length).toBe(2)); // 世代重载请求（gen 1）
    pendingProposal[1]("# proposal v2"); // 新世代回应先到
    await waitFor(() => expect(screen.getByText(/proposal v2/)).toBeTruthy());
    pendingProposal[0]("# proposal v1-stale"); // 旧世代回应后到——必须被丢弃
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByText(/v1-stale/)).toBeNull();
    expect(screen.getByText(/proposal v2/)).toBeTruthy();
  });

  it("toggle completion updates tasks and meta together via the refreshGen path only", async () => {
    const props = makeProps({ onToggleTask: vi.fn().mockResolvedValue(undefined) });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => screen.getByRole("tab", { name: /任务/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.length).toBeGreaterThan(0));
    const latest = taskListProps[taskListProps.length - 1] as {
      onToggle?: (ordinal: number, done: boolean) => void;
    };
    const tasksReads = () =>
      (props.loadDocument as Mock).mock.calls.filter((c) => c[1] === "tasks.md").length;
    const metaCalls = () => (props.loadMeta as Mock).mock.calls.length;
    const t0 = tasksReads();
    const m0 = metaCalls();
    act(() => latest.onToggle!(1, true));
    await waitFor(() => expect((props as { onToggleTask: Mock }).onToggleTask).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 25));
    // 独立局部重读路径已移除（design D2 单一数据流）。
    expect(tasksReads()).toBe(t0);
    // 宿主 onToggleTask 内 refresh → 世代递增（此处由测试仿真）→ tasks 与 meta 一并重载。
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(tasksReads()).toBeGreaterThan(t0));
    await waitFor(() => expect(metaCalls()).toBeGreaterThan(m0));
  });

  // spec「勾选任务即时回馈」（desktop-task-interactions）：乐观更新＋失败回滚＋不锁清单。
  describe("勾选乐观更新", () => {
    const TASKS_MD = "## 1. G\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n";
    const tasksLoader = () =>
      vi.fn(async (_c: string, artifact: string) => {
        if (artifact === "tasks.md") return TASKS_MD;
        return artifact.startsWith("specs/") ? SPEC_MD : `# doc for ${artifact}`;
      });
    const latestTL = () =>
      taskListProps[taskListProps.length - 1] as {
        markdown?: string | null;
        busy?: boolean;
        onToggle?: (o: number, d: boolean) => void;
      };
    const openTasksTab = async () => {
      await waitFor(() => screen.getByRole("tab", { name: /任务/ }));
      fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
      await waitFor(() => expect(latestTL().markdown).toContain("- [ ] 1.1 a"));
    };

    // spec「任务写回非阻塞且串行化」Scenario「旧加载回应不覆盖乐观状态」（design D4）
    it("更早发起的旧加载回应到达时不覆盖乐观勾选状态", async () => {
      const pending: Array<(v: string | null) => void> = [];
      let hangTasks = false;
      const loadDocument = vi.fn((_c: string, artifact: string) => {
        if (artifact === "tasks.md" && hangTasks) {
          return new Promise<string | null>((r) => pending.push(r));
        }
        if (artifact === "tasks.md") return Promise.resolve<string | null>(TASKS_MD);
        return Promise.resolve<string | null>(
          artifact.startsWith("specs/") ? SPEC_MD : `# doc for ${artifact}`,
        );
      });
      const props = makeProps({ loadDocument, onToggleTask: vi.fn().mockResolvedValue(undefined) });
      const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
      await openTasksTab();
      // 外部世代重载：tasks.md 加载悬挂（在途回应）。
      hangTasks = true;
      rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
      await waitFor(() => expect(pending.length).toBe(1));
      // 在途期间乐观勾选任务 1。
      act(() => latestTL().onToggle!(1, true));
      await waitFor(() => expect(latestTL().markdown).toContain("- [x] 1.1 a"));
      // 旧回应（未勾选内容）此刻才到达——不得覆盖乐观状态。
      await act(async () => {
        pending[0](TASKS_MD);
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(latestTL().markdown).toContain("- [x] 1.1 a");
    });

    it("optimistically flips the checkbox before the write resolves", async () => {
      const gate = new Promise<void>(() => {}); // 永不 resolve＝写回进行中
      const props = makeProps({ loadDocument: tasksLoader(), onToggleTask: vi.fn(() => gate) });
      render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
      await openTasksTab();
      act(() => latestTL().onToggle!(1, true));
      await waitFor(() => expect(latestTL().markdown).toContain("- [x] 1.1 a"));
      expect(latestTL().markdown).toContain("- [ ] 1.2 b");
    });

    it("rolls back and surfaces a one-line error when the write fails", async () => {
      const props = makeProps({
        loadDocument: tasksLoader(),
        onToggleTask: vi.fn().mockRejectedValue(new Error("disk full")),
      });
      render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
      await openTasksTab();
      act(() => latestTL().onToggle!(1, true));
      await waitFor(() => expect(screen.getByText(/写回失败/)).toBeTruthy());
      expect(screen.getByText(/disk full/)).toBeTruthy();
      expect(latestTL().markdown).toContain("- [ ] 1.1 a"); // 回滚至磁盘现况
    });

    it("keeps the list interactive during an in-flight single toggle", async () => {
      const releases: Array<() => void> = [];
      const props = makeProps({
        loadDocument: tasksLoader(),
        onToggleTask: vi.fn(() => new Promise<void>((r) => releases.push(r))),
      });
      render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
      await openTasksTab();
      act(() => latestTL().onToggle!(1, true));
      await waitFor(() => expect(latestTL().markdown).toContain("- [x] 1.1 a"));
      // 单发写回进行中不锁清单（busy 仅批量／拖放例外）。
      expect(latestTL().busy).toBe(false);
      // 第二勾不被挡、同样立即反映。
      act(() => latestTL().onToggle!(2, true));
      expect(props.onToggleTask as Mock).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(latestTL().markdown).toContain("- [x] 1.2 b"));
    });
  });

  it("shows the started date once the change is started; starter identity lives in the tooltip", async () => {
    // change-drawer-header-redesign：出身列单行让位——开工仅显日期，开工者（含 email）收提示。
    const props = makeProps({
      loadMeta: vi.fn(async () => ({
        created: "2026-07-05",
        createdBy: "MomoChen",
        createdWith: "claude",
        startedAt: "2026-07-06",
        startedBy: "Worker <w@example.com>",
        startedWith: "claude",
      })),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/开工 2026-07-06/)).toBeTruthy());
    expect(screen.queryByText(/w@example\.com/)).toBeNull();
  });

  it("hides the started row when the change has not been started", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("MomoChen")).toBeTruthy());
    expect(screen.queryByText(/开工/)).toBeNull();
  });

  it("fires onDelete when the delete item of the ⋯ menu is chosen", async () => {
    // 阶段守门后删除项仅提案中可选（archive-readiness-gating）——改用提案中 fixture。
    const props = makeProps({
      change: { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 30, completedTasks: 0 },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    // 先等初始 async 加载落地（loadMeta 的 MomoChen 为完成标记），避免 act 警告。
    await screen.findByText("MomoChen");
    const user = await openMoreMenu();
    await user.click(screen.getByRole("menuitem", { name: /删除/ }));
    expect(props.onDelete).toHaveBeenCalledWith("desktop-shell-and-browser");
  });

  it("fires onRunVerb for analyze / archive actions", async () => {
    const props = makeProps();
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    fireEvent.click(screen.getByRole("button", { name: /分析/ }));
    expect(props.onRunVerb).toHaveBeenCalledWith("analyze", "desktop-shell-and-browser");
    fireEvent.click(screen.getByRole("button", { name: /封存/ }));
    expect(props.onRunVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
  });

  it("unavailable 停用分析与删除并附繁中说明；封存照常（remote capability 缺口）", async () => {
    // 以实际 pointer enter/leave 验证 tooltip trigger。
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = makeProps({
      unavailable: {
        analyze: "此 server 尚未提供 validate/analyze——功能已停用",
        delete: "此 server 尚未提供删除变更——功能已停用",
      },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const analyze = screen.getByRole("button", { name: /分析/ }) as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    expect(analyze.title).toContain("validate/analyze");
    const analyzeTrigger = analyze.parentElement!;
    await user.hover(analyzeTrigger);
    await waitFor(() => expect(analyzeTrigger.getAttribute("data-state")).toContain("open"));
    expect(document.querySelector("[data-radix-popper-content-wrapper]")?.textContent).toContain("validate/analyze");
    // archive 是直达端点——已就绪时标题列主要钮照常可点。
    fireEvent.click(screen.getByRole("button", { name: /封存/ }));
    expect(props.onRunVerb).toHaveBeenCalledWith("archive", "desktop-shell-and-browser");
    await openMoreMenu();
    const del = screen.getByRole("menuitem", { name: /删除/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(menuReason(del)).toContain("删除变更");
  });

  it("未认领的 change 呈现认领操作，点击回呼带 change 名（remote-claim-ownership D4）", async () => {
    const props = makeProps({ onClaim: vi.fn() });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    fireEvent.click(screen.getByRole("button", { name: /认领/ }));
    expect(props.onClaim).toHaveBeenCalledWith("desktop-shell-and-browser");
  });

  it("已认领的 change 呈现认领人、不再提供认领操作", async () => {
    const props = makeProps({
      change: { ...change, claimedBy: "Alice <a@example.com>" },
      onClaim: vi.fn(),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /认领/ })).toBeNull();
  });

  it("onClaim 缺席时不渲染认领操作（本地分页无认领面）", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.queryByRole("button", { name: /认领/ })).toBeNull();
  });

  it("claim unavailable 停用认领钮并附繁中说明（reader）", async () => {
    const props = makeProps({
      onClaim: vi.fn(),
      unavailable: { claim: "此帐号为唯读成员，无法认领变更" },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const claim = screen.getByRole("button", { name: /认领/ }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    expect(claim.title).toContain("唯读成员");
    fireEvent.click(claim);
    expect(props.onClaim).not.toHaveBeenCalled();
  });

  it("onMoveTask 缺席时 TaskList 收到 onReorder undefined（把手整段停用）", async () => {
    taskListProps.length = 0;
    const props = makeProps({ onToggleTask: vi.fn(), onSetAllTasks: vi.fn() });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.length).toBeGreaterThan(0));
    const latest = taskListProps.at(-1)!;
    expect(latest.onReorder).toBeUndefined();
    expect(latest.onToggle).toBeDefined();
    expect(latest.onSetAll).toBeDefined();
  });
});

// spec 需求「详情页的封存与删除依阶段守门」（archive-readiness-gating D4）：
// 「⋯」菜单的封存项仅已就绪可选、删除项仅提案中可选，停用时项目下方灰字说明原因；
// 已就绪时标题列另有「封存」主要钮；unavailable（remote 能力缺失）原因优先于阶段原因。
describe("详情页封存/删除的阶段守门", () => {
  const proposed: ChangeItem = { name: "prop-c", status: "in-progress", totalTasks: 11, completedTasks: 0 };
  const inProgress: ChangeItem = {
    name: "wip-c",
    status: "in-progress",
    totalTasks: 19,
    completedTasks: 5,
    startedAt: "2026-07-06",
  };
  const ready: ChangeItem = { name: "ready-c", status: "done", totalTasks: 30, completedTasks: 30 };

  it("非已就绪的封存项停用附任务进度与出路、标题列无封存钮；已就绪时菜单项与主要钮照常可按", async () => {
    // spec scenario：提案中(0/11)与进行中(5/19)皆停用，项目下方载明进度。
    for (const [c, progress] of [
      [proposed, "0/11"],
      [inProgress, "5/19"],
    ] as const) {
      const r = render(<ChangeDetailPage {...(makeProps({ change: c }) as never)} />);
      await screen.findByText("MomoChen");
      expect(screen.queryByRole("button", { name: /^封存$/ })).toBeNull();
      await openMoreMenu();
      const item = screen.getByRole("menuitem", { name: /封存/ });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(menuReason(item)).toContain(progress);
      expect(menuReason(item)).toContain("完成后才能封存");
      r.unmount();
    }
    const p3 = makeProps({ change: ready });
    render(<ChangeDetailPage {...(p3 as never)} />);
    await screen.findByText("MomoChen");
    const primary = screen.getByRole("button", { name: /^封存$/ }) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    expect(p3.onRunVerb).toHaveBeenCalledWith("archive", "ready-c");
    const user = await openMoreMenu();
    const item = screen.getByRole("menuitem", { name: /封存/ });
    expect(item.getAttribute("aria-disabled")).toBeNull();
    expect(menuReason(item)).toBe("");
    await user.click(item);
    expect(p3.onRunVerb).toHaveBeenCalledTimes(2);
  });

  it("非提案中的删除项停用附开工痕迹与退回出路；提案中照常可选；删除项置底且为警示色", async () => {
    for (const c of [inProgress, ready]) {
      const r = render(<ChangeDetailPage {...(makeProps({ change: c }) as never)} />);
      await screen.findByText("MomoChen");
      await openMoreMenu();
      const del = screen.getByRole("menuitem", { name: /删除/ });
      expect(del.getAttribute("aria-disabled")).toBe("true");
      expect(menuReason(del)).toContain("开工痕迹");
      expect(menuReason(del)).toContain("退回提案中");
      r.unmount();
    }
    const p3 = makeProps({ change: proposed });
    render(<ChangeDetailPage {...(p3 as never)} />);
    await screen.findByText("MomoChen");
    const user = await openMoreMenu();
    const items = screen.getAllByRole("menuitem");
    const del = items.at(-1)!;
    expect(del.textContent).toContain("删除");
    expect(del.className).toContain("text-destructive");
    expect(screen.getByRole("menu").querySelector('[role="separator"]')).toBeTruthy();
    await user.click(del);
    expect(p3.onDelete).toHaveBeenCalledWith("prop-c");
  });

  it("unavailable 原因优先于阶段原因（能力缺失比阶段更硬）", async () => {
    const p = makeProps({
      change: inProgress,
      unavailable: {
        archive: "此 server 尚未提供封存——功能已停用",
        delete: "此 server 尚未提供删除变更——功能已停用",
      },
    });
    render(<ChangeDetailPage {...(p as never)} />);
    await screen.findByText("MomoChen");
    await openMoreMenu();
    const arch = screen.getByRole("menuitem", { name: /封存/ });
    expect(arch.getAttribute("aria-disabled")).toBe("true");
    expect(menuReason(arch)).toContain("server");
    expect(menuReason(arch)).not.toContain("5/19");
    const del = screen.getByRole("menuitem", { name: /删除/ });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(menuReason(del)).toContain("server");
    expect(menuReason(del)).not.toContain("开工痕迹");
  });
});

// spec 需求「桌面 app 提供动词操作面」：「分析」一键双动词的合并结果于详情页内、
// 「状态」卡之下的分析结果卡呈现；动作区不提供独立验证钮。
describe("详情页内分析结果呈现", () => {
  const region = () => document.querySelector("[data-verb-result]") as HTMLElement | null;
  const report = {
    change_id: "x",
    dimensions: [{ dimension: "Ambiguity", status: "1 issue(s) found", finding_count: 1 }],
    findings: [
      { id: "AMB-1", dimension: "Ambiguity", severity: "Suggestion", location: "specs", summary: "缺具体范例的情境", recommendation: "r" },
    ],
    artifacts_analyzed: [],
    artifacts_missing: [],
  };

  it("动作区不提供独立验证钮：分析＋依阶段钮＋「⋯」（封存／删除）", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.queryByRole("button", { name: "验证" })).toBeNull();
    expect(screen.getByRole("button", { name: /分析/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^封存$/ })).toBeTruthy();
    await openMoreMenu();
    expect(screen.getAllByRole("menuitem").map((el) => el.querySelector("[data-menu-label]")?.textContent)).toEqual([
      "封存",
      "删除",
    ]);
  });

  it("分析结果卡渲染于阅读区、阅读卡之上；状态栏在左栏", async () => {
    const props = makeProps({
      detailVerb: {
        change: "desktop-shell-and-browser",
        validate: { valid: true, errors: [] },
        analyze: report,
      },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const tree = document.querySelector("[data-detail-tree]")!;
    const reading = document.querySelector("[data-detail-reading]")!;
    const result = region()!;
    expect(tree.querySelector("[data-status-card]")).toBeTruthy();
    expect(reading.contains(result)).toBe(true);
    const header = reading.querySelector("[data-doc-header]")!;
    expect(result.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("合并结果呈现结构验证列、繁中维度摘要卡与发现卡", async () => {
    const props = makeProps({
      detailVerb: {
        change: "desktop-shell-and-browser",
        validate: { valid: true, errors: [] },
        analyze: report,
      },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    // 先等初始 async 加载落地（loadMeta 的 MomoChen 为完成标记），避免 act 警告。
    await screen.findByText("MomoChen");
    const r = region();
    expect(r).toBeTruthy();
    expect(within(r!).getByText("结构验证通过")).toBeTruthy();
    expect(within(r!).getByText("模糊度")).toBeTruthy();
    expect(within(r!).getByText(/缺具体范例的情境/)).toBeTruthy();
  });

  it("结构验证失败于面板逐条呈现错误", async () => {
    const props = makeProps({
      detailVerb: {
        change: "desktop-shell-and-browser",
        validate: { valid: false, errors: ["tasks.md: missing", "second error"] },
        analyze: report,
      },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const r = region();
    expect(within(r!).getByText(/结构验证 2 个错误/)).toBeTruthy();
    expect(within(r!).getByText(/tasks\.md: missing/)).toBeTruthy();
    expect(within(r!).getByText(/second error/)).toBeTruthy();
  });

  it("运行失败呈现 core 的单行错误", async () => {
    const props = makeProps({
      detailVerb: { change: "desktop-shell-and-browser", error: "parse boom" },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    expect(within(region()!).getByText(/parse boom/)).toBeTruthy();
  });

  it("动词结果属于别的 change 时不呈现", async () => {
    const props = makeProps({
      detailVerb: { change: "some-other-change", validate: { valid: true, errors: [] } },
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    expect(region()).toBeNull();
  });

  // design D2：分析钮为切换——结果打开时再点收合（onClearVerb）、不重跑动词。
  it("结果打开时分析钮 aria-pressed，再点调用 onClearVerb 而非重跑", async () => {
    const props = makeProps({
      detailVerb: {
        change: "desktop-shell-and-browser",
        validate: { valid: true, errors: [] },
        analyze: report,
      },
      onClearVerb: vi.fn(),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const btn = screen.getByRole("button", { name: "分析" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(props.onClearVerb).toHaveBeenCalledTimes(1);
    expect(props.onRunVerb).not.toHaveBeenCalled();
  });

  it("结果未打开时分析钮 aria-pressed=false，点按运行动词", async () => {
    const props = makeProps({ onClearVerb: vi.fn() });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const btn = screen.getByRole("button", { name: "分析" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(props.onRunVerb).toHaveBeenCalledWith("analyze", "desktop-shell-and-browser");
    expect(props.onClearVerb).not.toHaveBeenCalled();
  });

  it("面板关闭钮调用 onClearVerb 收合", async () => {
    const props = makeProps({
      detailVerb: {
        change: "desktop-shell-and-browser",
        validate: { valid: true, errors: [] },
        analyze: report,
      },
      onClearVerb: vi.fn(),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    fireEvent.click(screen.getByRole("button", { name: "关闭分析结果" }));
    expect(props.onClearVerb).toHaveBeenCalledTimes(1);
  });
});

// spec 需求「markdown 文档内容行宽有上限」（design D4）与「详情页的文档树、阅读卡与本页目录」：
// 阅读卡内文为共用置中容器（行宽上限＋水平置中），包住文档全部内容；阅读区内容栏置中、宽 768px。
describe("变更详情页阅读栏置中", () => {
  // spec「markdown 文档内容行宽有上限」（desktop-change-doc-views design D10）：阅读卡内以 768px 卡栏为上限，不再另套 96ch。
  it("阅读卡内文撑满卡栏（w-full、无 96ch）且包住文档内容；阅读区内容栏 768px 置中", async () => {
    const props = makeProps();
    const { baseElement } = render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/doc for proposal.md/)).toBeTruthy());
    const col = baseElement.querySelector("[data-doc-body]") as HTMLElement;
    expect(col).toBeTruthy();
    expect(col.className).toContain("w-full");
    expect(col.className).not.toContain("max-w-[96ch]");
    const reading = baseElement.querySelector("[data-detail-reading]") as HTMLElement;
    const frame = reading.firstElementChild as HTMLElement;
    expect(frame.className).toContain("max-w-[768px]");
    expect(frame.className).toContain("mx-auto");
    expect(frame.contains(col)).toBe(true);
    // 包住分页全部内容：提案分页内文在栏内。
    expect(within(col).getByText(/doc for proposal.md/)).toBeTruthy();
    // 任务分页：任务清单同栏（TaskList stub 在栏内）。
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    expect(within(col).getByTestId("tasklist-stub")).toBeTruthy();
  });
});

// spec 需求「抽屉标头标记受宽度约束且抽屉不产生水平滚动条」（change-drawer-header-redesign
// 改写）：来源讨论标记以 slug 直出（等宽字体、宽度上限截断）、topic 降为主题化提示、
// 抽屉面板关闭水平卷动。
describe("变更抽屉来源讨论标记（slug 直出）", () => {
  const LONG_TOPIC =
    "目前前端项目的设计，是完全纯文本的web服务，我希望可以设计一下，因为有好几个端点都要自己打URL才能够进去，完全不符合人性，所以请你帮我重新设计一下";

  it("标记面为 slug 而非 topic：等宽字体、宽度上限、截断", async () => {
    const props = makeProps({
      sourceDiscussions: [{ slug: "web-service-navigation-redesign", topic: LONG_TOPIC }],
      onOpenDiscussion: vi.fn(),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const label = await waitFor(() => {
      const el = document.querySelector("[data-source-discussion-label]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    // 签面文本是 slug，topic 全文不出现在可视文本。
    expect(label.textContent).toBe("web-service-navigation-redesign");
    expect(screen.queryByText(LONG_TOPIC)).toBeNull();
    expect(label.className).toContain("truncate");
    const chip = label.closest("button") as HTMLElement;
    expect(chip.className).toContain("font-mono");
    expect(chip.className).toContain("max-w-[140px]");
  });

  it("主题化提示呈现 slug 与 topic（取代原生 title）", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = makeProps({
      sourceDiscussions: [{ slug: "alpha-ux", topic: "Alpha UX 讨论" }],
      onOpenDiscussion: vi.fn(),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const chip = await screen.findByRole("button", { name: /alpha-ux/ });
    await user.hover(chip);
    await waitFor(() => {
      const tip = document.querySelector("[data-radix-popper-content-wrapper]");
      expect(tip?.textContent).toContain("alpha-ux");
      expect(tip?.textContent).toContain("Alpha UX 讨论");
    });
  });

  it("阅读区可压缩（min-w-0），出身行溢出裁切、来自列不撑宽左栏——页不产生水平滚动条", async () => {
    const props = makeProps({
      sourceDiscussions: [{ slug: "web-service-navigation-redesign", topic: LONG_TOPIC }],
    });
    const { baseElement } = render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() =>
      expect(document.querySelector("[data-source-discussion-label]")).toBeTruthy(),
    );
    const reading = baseElement.querySelector("[data-detail-reading]") as HTMLElement;
    expect(reading.className).toContain("min-w-0");
    const row = baseElement.querySelector("[data-identity-provenance]") as HTMLElement;
    expect(row.className).toContain("overflow-hidden");
    expect(row.className).toContain("min-w-0");
    const from = baseElement.querySelector("[data-relation-from]") as HTMLElement;
    expect(from.className).toContain("min-w-0");
    expect(from.querySelector("[data-source-discussion-label]")).toBeTruthy();
  });

  it("点击签打开对应讨论", async () => {
    const onOpenDiscussion = vi.fn();
    const props = makeProps({
      sourceDiscussions: [{ slug: "alpha-ux", topic: "Alpha UX 讨论" }],
      onOpenDiscussion,
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const chip = await screen.findByRole("button", { name: /alpha-ux/ });
    fireEvent.click(chip);
    expect(onOpenDiscussion).toHaveBeenCalledWith("alpha-ux");
  });
});

// spec 需求「变更的来源讨论多值呈现」（change-drawer-header-redesign 改写）：
// 固定显示出身（清单第一份）讨论签，其余收「+N」数字签，点击开浮层（slug 主行＋
// topic 副行）可跳讨论；同源签比照；单笔无 +N。
describe("来源讨论多值呈现（+N 浮层）", () => {
  const FOUR = [
    { slug: "code-review-stage", topic: "审查站落地" },
    { slug: "tray-station-badges", topic: "系统匣站章" },
    { slug: "code-review-convergence-boundary", topic: "审查收敛边界" },
    { slug: "apply-provenance-scope", topic: "apply 溯源范围" },
  ];

  it("四笔来源讨论：仅出身签直出，+3 签呈现溢出数，其余 slug 不直出", async () => {
    const props = makeProps({ sourceDiscussions: FOUR, onOpenDiscussion: vi.fn() });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByRole("button", { name: /code-review-stage/ });
    const overflow = screen.getByRole("button", { name: /其余 3 份/ });
    expect(overflow.getAttribute("data-source-overflow")).not.toBeNull();
    expect(overflow.textContent).toBe("+3");
    // 其余三笔不直接渲染于标头。
    expect(screen.queryByRole("button", { name: /tray-station-badges/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /apply-provenance-scope/ })).toBeNull();
  });

  it("点 +N 浮层列出其余讨论（slug 主行＋topic 副行），点项目跳讨论并关闭浮层", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenDiscussion = vi.fn();
    const props = makeProps({ sourceDiscussions: FOUR, onOpenDiscussion });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByRole("button", { name: /code-review-stage/ });
    await user.click(screen.getByRole("button", { name: /其余 3 份/ }));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-source-overflow-list]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    // slug 主行＋topic 副行。
    expect(popover.textContent).toContain("tray-station-badges");
    expect(popover.textContent).toContain("系统匣站章");
    expect(popover.textContent).toContain("code-review-convergence-boundary");
    expect(popover.textContent).toContain("apply-provenance-scope");
    await user.click(within(popover).getByRole("button", { name: /tray-station-badges/ }));
    expect(onOpenDiscussion).toHaveBeenCalledWith("tray-station-badges");
    await waitFor(() =>
      expect(document.querySelector("[data-source-overflow-list]")).toBeNull(),
    );
  });

  it("单笔来源讨论无 +N 签", async () => {
    const props = makeProps({
      sourceDiscussions: [{ slug: "alpha-ux", topic: "Alpha UX 讨论" }],
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByRole("button", { name: /alpha-ux/ });
    expect(document.querySelector("[data-source-overflow]")).toBeNull();
  });

  it("同源签比照：首签直出、其余收 +N，浮层项点击互跳", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenSibling = vi.fn();
    const props = makeProps({
      sourceDiscussions: [{ slug: "alpha-ux", topic: "Alpha UX 讨论" }],
      siblingChanges: ["sib-one", "sib-two", "sib-three"],
      onOpenSibling,
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByRole("button", { name: /sib-one/ });
    expect(screen.queryByRole("button", { name: /sib-two/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /其余 2 份/ }));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-source-overflow-list]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    await user.click(within(popover).getByRole("button", { name: /sib-two/ }));
    expect(onOpenSibling).toHaveBeenCalledWith("sib-two");
  });
});

// spec 需求「变更详情页的标头与状态卡」：左栏身分区（名称＋拷贝＋签、单行出身、关联列）／
// 「文档」节点／「状态」列三列（任务进度、品质关卡、调度）；变更层动作在标题列（无宿主时原地）。
describe("标头与状态卡", () => {
  const identity = () => document.querySelector("[data-detail-identity]") as HTMLElement;
  const actions = () => document.querySelector("[data-detail-actions]") as HTMLElement;
  const statusRow = (name: "tasks" | "quality" | "plan") =>
    document.querySelector(`[data-status-${name}]`) as HTMLElement;
  const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  it("左栏由上而下为身分区、「文档」节点、「状态」列；身分区无任务计数", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    const tree = document.querySelector("[data-detail-tree]") as HTMLElement;
    const order = [identity(), within(tree).getByRole("tablist"), within(tree).getByText("状态"), tree.querySelector("[data-status-card]")!];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(tree).getByText("文档")).toBeTruthy();
    expect(flat(identity())).not.toMatch(/30\/30/);
    // 阶段签：已就绪。
    expect(within(identity()).getByText("已就绪")).toBeTruthy();
    // 任务进度由「状态」列与「任务」节点徽章承载。
    expect(flat(statusRow("tasks"))).toContain("30/30");
    expect(screen.getByRole("tab", { name: /任务/ }).textContent).toContain("30/30");
  });

  it("状态栏三列：任务进度 16/17、品质关卡两枚带日期章签、调度第 2 波等 1 项", async () => {
    const c: ChangeItem = {
      ...change,
      totalTasks: 17,
      completedTasks: 16,
      reviewStatus: "reviewed",
      reviewedAt: "2026-08-04",
      reviewedBy: "MomoChen <momochenisme@gmail.com>",
      verifyStatus: "verified",
      verifiedAt: "2026-08-06",
      verifiedBy: "MomoChen <momochenisme@gmail.com>",
      wave: 2,
      blockedBy: ["add-a"],
    };
    render(<ChangeDetailPage {...(makeProps({ change: c }) as never)} />);
    await screen.findByText("MomoChen");
    expect(within(statusRow("tasks")).getByText("任务进度")).toBeTruthy();
    expect(flat(statusRow("tasks"))).toContain("16/17");
    expect(flat(statusRow("tasks"))).not.toContain("94%");
    expect(statusRow("tasks").querySelector("[data-progress-track]")).toBeTruthy();
    const quality = flat(statusRow("quality"));
    expect(quality).toContain("品质关卡");
    expect(quality).toMatch(/已审查.*2026-08-04.*已验证.*2026-08-06/);
    expect(quality).not.toContain("momochenisme@gmail.com");
    const plan = flat(statusRow("plan"));
    expect(plan).toContain("调度");
    expect(plan).toContain("第 2 波");
    expect(plan).toContain("等 1 项");
  });

  it("两站皆 none：全页无章签、品质关卡列显示「尚未经过品质关卡」；可以开工与缺 wave 的说明词条", async () => {
    const r = render(
      <ChangeDetailPage {...(makeProps({ change: { ...change, wave: 1, blockedBy: [] } }) as never)} />,
    );
    await screen.findByText("MomoChen");
    expect(document.querySelector("[data-review-row]")).toBeNull();
    expect(document.querySelector("[data-verify-row]")).toBeNull();
    expect(flat(statusRow("quality"))).toContain("尚未经过品质关卡");
    expect(flat(statusRow("plan"))).toContain("可以开工");
    r.unmount();
    // wave 缺席：沿用调度分页的说明词条（remote 无 plan／成环两种）。
    const r2 = render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    expect(flat(statusRow("plan"))).toContain("此模式尚未提供调度信息");
    r2.unmount();
    render(<ChangeDetailPage {...(makeProps({ change: { ...change, dependsOn: ["add-a"] } }) as never)} />);
    await screen.findByText("MomoChen");
    expect(flat(statusRow("plan"))).toContain("依赖成环");
  });

  // spec Scenario「章签与品质关卡列」：身分区只有阶段签；章签只在「品质关卡」列，
  // 盖章日期与含 email 完整识别收进该章签的提示。
  it("身分区只有阶段签；品质关卡列的章签提示带日期与完整识别", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const stamped: ChangeItem = {
      ...change,
      reviewStatus: "reviewed",
      reviewedAt: "2026-08-04",
      reviewedBy: "MomoChen <momochenisme@gmail.com>",
      verifyStatus: "verified",
      verifiedAt: "2026-08-06",
      verifiedBy: "MomoChen <momochenisme@gmail.com>",
    };
    render(<ChangeDetailPage {...(makeProps({ change: stamped }) as never)} />);
    await screen.findByText("MomoChen");
    const row = identity();
    const text = row.textContent ?? "";
    expect(within(row).getByText("已就绪")).toBeTruthy();
    expect(text).not.toContain("已审查");
    expect(text).not.toContain("已验证");
    expect(row.querySelector("[data-review-row]")).toBeNull();
    expect(row.querySelector("[data-verify-row]")).toBeNull();
    expect(row.className).toContain("min-w-0");

    await user.hover(within(statusRow("quality")).getByText("已审查"));
    await waitFor(() => {
      const tip = document.querySelector("[data-radix-popper-content-wrapper]");
      expect(tip?.textContent).toContain("2026-08-04");
      expect(tip?.textContent).toContain("momochenisme@gmail.com");
    });
  });

  it("验证章签的提示带该站自己的盖章日期与完整识别", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const stamped: ChangeItem = {
      ...change,
      reviewStatus: "reviewed",
      reviewedAt: "2026-08-04",
      reviewedBy: "MomoChen <momochenisme@gmail.com>",
      verifyStatus: "verified",
      verifiedAt: "2026-08-06",
      verifiedBy: "Reviewer Two <two@example.com>",
    };
    render(<ChangeDetailPage {...(makeProps({ change: stamped }) as never)} />);
    await screen.findByText("MomoChen");
    await user.hover(within(statusRow("quality")).getByText("已验证"));
    await waitFor(() => {
      const tip = document.querySelector("[data-radix-popper-content-wrapper]");
      expect(tip?.textContent).toContain("2026-08-06");
      expect(tip?.textContent).toContain("two@example.com");
    });
  });

  it("有提示的章签可用键盘聚焦，聚焦即出提示", async () => {
    const stamped: ChangeItem = {
      ...change,
      reviewStatus: "reviewed",
      reviewedAt: "2026-08-04",
      reviewedBy: "MomoChen <momochenisme@gmail.com>",
    };
    render(<ChangeDetailPage {...(makeProps({ change: stamped }) as never)} />);
    await screen.findByText("MomoChen");
    const stamp = statusRow("quality").querySelector("[data-review-row]") as HTMLElement;
    // 提示触发点必带 data-state（进行中题以其缺席判定无提示）。
    expect(stamp.getAttribute("data-state")).toBe("closed");
    act(() => stamp.focus());
    expect(document.activeElement).toBe(stamp);
    await waitFor(() => {
      const tip = document.querySelector("[data-radix-popper-content-wrapper]");
      expect(tip?.textContent).toContain("2026-08-04");
      expect(tip?.textContent).toContain("momochenisme@gmail.com");
    });
  });

  it("进行中两站（inReview／inVerify）：身分区无章签；品质关卡列仅状态词、无日期、无提示", async () => {
    const running: ChangeItem = {
      ...change,
      reviewStatus: "inReview",
      verifyStatus: "inVerify",
    };
    render(<ChangeDetailPage {...(makeProps({ change: running }) as never)} />);
    await screen.findByText("MomoChen");
    expect(identity().textContent).not.toContain("审查中");
    expect(identity().textContent).not.toContain("验证中");
    const quality = statusRow("quality");
    expect(quality.textContent).toContain("审查中");
    expect(quality.textContent).toContain("验证中");
    expect(quality.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // 进行中无戳记：两站章签都不是提示触发点（无 data-state），也不进 Tab 序。
    for (const mark of ["[data-review-row]", "[data-verify-row]"]) {
      const stamp = quality.querySelector(mark)!;
      expect(stamp.hasAttribute("data-state")).toBe(false);
      expect(stamp.hasAttribute("tabindex")).toBe(false);
    }
  });

  it("已就绪时动作区有「封存」主要钮；进行中为「退回提案中」", async () => {
    const r = render(<ChangeDetailPage {...(makeProps({ onRevert: vi.fn() }) as never)} />);
    await screen.findByText("MomoChen");
    const archive = within(actions()).getByRole("button", { name: /^封存$/ });
    expect(archive.className).toContain("bg-primary");
    expect(within(actions()).queryByRole("button", { name: /退回提案中/ })).toBeNull();
    r.unmount();
    render(
      <ChangeDetailPage
        {...(makeProps({
          change: { ...change, completedTasks: 3, startedAt: "2026-07-30" },
          onRevert: vi.fn(),
        }) as never)}
      />,
    );
    await screen.findByText("MomoChen");
    expect(within(actions()).getByRole("button", { name: /退回提案中/ })).toBeTruthy();
    expect(within(actions()).queryByRole("button", { name: /^封存$/ })).toBeNull();
  });

  // spec Scenario「标题列的变更层动作」：无宿主插槽时原地渲染；顺序为分析、主要钮、⋯，「⋯」为 outline。
  it("动作钮在无 provider 时原地渲染且「⋯」为 outline、顺序为分析／封存／⋯", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    const buttons = within(actions()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.trim() || b.getAttribute("aria-label"))).toEqual(["分析", "封存", "更多动作"]);
    const more = within(actions()).getByRole("button", { name: "更多动作" });
    expect(more.className).toContain("border");
    expect(more.className).not.toContain("bg-muted");
    // 动作钮不在左栏与阅读卡内。
    expect(document.querySelector("[data-detail-tree]")!.contains(more)).toBe(false);
    expect(document.querySelector("[data-doc-header]")!.contains(more)).toBe(false);
  });

  it("创建者 email 不直出，仅显名字；提示保完整识别", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = makeProps({
      loadMeta: vi.fn(async () => ({
        created: "2026-07-05",
        createdBy: "MomoChen <momochenisme@gmail.com>",
        createdWith: "claude",
      })),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const name = await screen.findByText("MomoChen");
    expect(screen.queryByText(/momochenisme@gmail\.com/)).toBeNull();
    // 首字母圆标为静态 metadata：走中性（五处头像同款）。
    const avatar = name.querySelector("span") as HTMLElement;
    expect(avatar.textContent).toBe("M");
    expect(avatar.className).toContain("bg-muted");
    expect(avatar.className).not.toContain("bg-primary");
    await user.hover(screen.getByText("MomoChen"));
    await waitFor(() => {
      const tip = document.querySelector("[data-radix-popper-content-wrapper]");
      expect(tip?.textContent).toContain("momochenisme@gmail.com");
    });
  });

  it("worktree 映射时出身列显示分支与路径，无映射时整段缺席", async () => {
    // spec worktree-overlay「desktop 看板的 worktree 呈现」：抽屉显示分支名与
    // worktree 路径（OS 原生形式）。
    const wtChange: ChangeItem = {
      ...change,
      worktree: { branch: "specseal/demo", path: "/work/specseal.worktrees/demo" },
    };
    const { baseElement, unmount } = render(
      <ChangeDetailPage {...(makeProps({ change: wtChange }) as never)} />,
    );
    await screen.findByText("MomoChen");
    const row = baseElement.querySelector("[data-identity-provenance]") as HTMLElement;
    const branch = within(row).getByText(/specseal\/demo/);
    expect(branch).toBeTruthy();
    expect(within(row).getByTitle("/work/specseal.worktrees/demo")).toBeTruthy();
    // spec「worktree 标示以蓝呈现」下半句：抽屉的分支与路径维持中性——扫视层
    // （卡片）抢眼、阅读层（抽屉出身列）安静。
    expect(row.className).toContain("text-muted-foreground");
    expect(branch.className).not.toContain("status-progress");
    unmount();

    const plain = render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    const plainRow = plain.baseElement.querySelector("[data-identity-provenance]") as HTMLElement;
    expect(within(plainRow).queryByText(/specseal\//)).toBeNull();
  });

  it("出身行为不折行单行容器、关联列各自一行（4 笔来源讨论＋开工＋同源）", async () => {
    const props = makeProps({
      loadMeta: vi.fn(async () => ({
        created: "2026-07-05",
        createdBy: "MomoChen <momochenisme@gmail.com>",
        createdWith: "claude",
        startedAt: "2026-08-03",
        startedBy: "MomoChen <momochenisme@gmail.com>",
      })),
      sourceDiscussions: [
        { slug: "code-review-stage", topic: "审查站落地" },
        { slug: "tray-station-badges", topic: "系统匣站章" },
        { slug: "code-review-convergence-boundary", topic: "审查收敛边界" },
        { slug: "apply-provenance-scope", topic: "apply 溯源范围" },
      ],
      siblingChanges: ["sib-one", "sib-two"],
    });
    const { baseElement } = render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const row = baseElement.querySelector("[data-identity-provenance]") as HTMLElement;
    expect(row).toBeTruthy();
    // 恒定单行：不折行、溢出裁切兜底。
    expect(row.className).not.toContain("flex-wrap");
    expect(row.className).toContain("overflow-hidden");
    expect(row.className).toContain("whitespace-nowrap");
    expect(within(row).getByText("MomoChen")).toBeTruthy();
    expect(within(row).getByText(/开工 2026-08-03/)).toBeTruthy();
    // 关联列各自一行：「来自」首签＋「+3」、「同源」首签＋「+1」、「规格」能力签。
    const from = baseElement.querySelector("[data-relation-from]") as HTMLElement;
    expect(within(from).getByText("来自")).toBeTruthy();
    expect(within(from).getByRole("button", { name: /code-review-stage/ })).toBeTruthy();
    expect(within(from).getByRole("button", { name: /其余 3 份/ }).textContent).toBe("+3");
    const sibling = baseElement.querySelector("[data-relation-sibling]") as HTMLElement;
    expect(within(sibling).getByText("同源")).toBeTruthy();
    expect(within(sibling).getByRole("button", { name: /sib-one/ })).toBeTruthy();
    const specs = await waitFor(() => {
      const el = baseElement.querySelector("[data-relation-specs]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(specs).getByRole("button", { name: "desktop-app" })).toBeTruthy();
  });
});

// spec「进行中变更可自看板退回提案中」的抽屉半边:退回动作仅于派生进行中出现。
describe("退回提案中动作(标题列动作区)", () => {
  it("派生进行中的变更显示退回动作,点击触发 onRevert", async () => {
    const onRevert = vi.fn();
    const inProgress: ChangeItem = {
      name: "oops-started",
      status: "in-progress",
      totalTasks: 10,
      completedTasks: 0,
      startedAt: "2026-07-30",
    };
    render(<ChangeDetailPage {...(makeProps({ change: inProgress, onRevert }) as never)} />);
    const btn = await screen.findByRole("button", { name: /退回提案中/ });
    fireEvent.click(btn);
    expect(onRevert).toHaveBeenCalledWith("oops-started");
  });

  it("提案中的变更不显示退回动作", async () => {
    const proposed: ChangeItem = {
      name: "fresh-proposal",
      status: "in-progress",
      totalTasks: 10,
      completedTasks: 0,
    };
    render(<ChangeDetailPage {...(makeProps({ change: proposed, onRevert: vi.fn() }) as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.queryByRole("button", { name: /退回提案中/ })).toBeNull();
  });

  it("已就绪(全完成)的变更不显示退回动作", async () => {
    // 既有 fixture change 为 30/30 全完成——派生已就绪。
    render(<ChangeDetailPage {...(makeProps({ onRevert: vi.fn() }) as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.queryByRole("button", { name: /退回提案中/ })).toBeNull();
  });
});

// spec「抽屉文档加载以 skeleton 呈现」（design D3）：三态分流——加载中画骨架、
// 文档不存在才出空态文案、有内容走既有渲染。加载中不得显示「没有文档」。
describe("变更抽屉文档三态", () => {
  /** 永不完成的加载：停在「加载中」态供断言。 */
  const pending = () => new Promise<never>(() => {});

  async function openTab(name: RegExp) {
    await waitFor(() => screen.getByRole("tab", { name }));
    fireEvent.mouseDown(screen.getByRole("tab", { name }));
  }

  it("加载中 → 四个分页皆为文档骨架，且无任何空态文案", async () => {
    render(
      <ChangeDetailPage
        {...(makeProps({
          loadDocument: vi.fn(pending),
          loadCapabilities: vi.fn(pending),
        }) as never)}
      />,
    );
    // 提案分页（缺省）
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（此 change 尚无提案内容）")).toBeNull();

    for (const [tab, emptyText] of [
      [/设计/, "（此 change 无设计文档）"],
      [/规格/, "（此 change 无 delta 规格）"],
    ] as const) {
      await openTab(tab);
      expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
      expect(screen.queryByText(emptyText)).toBeNull();
    }
  });

  it("加载完成且文档不存在 → 各分页显示既有空态文案，无骨架", async () => {
    render(
      <ChangeDetailPage
        {...(makeProps({
          loadDocument: vi.fn(async () => null),
          loadCapabilities: vi.fn(async () => []),
        }) as never)}
      />,
    );
    await screen.findByText("（此 change 尚无提案内容）");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    await openTab(/设计/);
    expect(screen.getByText("（此 change 无设计文档）")).toBeTruthy();

    await openTab(/规格/);
    expect(screen.getByText("（此 change 无 delta 规格）")).toBeTruthy();
  });

  it("加载完成且有内容 → 显示内容，无骨架", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText(/doc for proposal.md/);
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

// 三态的 undefined 是「还在载」，不是「载不到」。capability 加载失败时若停在
// undefined，规格分页会永久挂骨架——改动前停在 {} 至少会诚实说「无 delta 规格」。
describe("规格分页加载失败的收敛", () => {
  it("loadCapabilities 失败 → 收敛为空态文案，不永久挂骨架", async () => {
    render(
      <ChangeDetailPage
        {...(makeProps({ loadCapabilities: vi.fn(async () => Promise.reject("读不到")) }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /规格/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(screen.getByText("（此 change 无 delta 规格）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("文档首载失败 → 落到既有空态文案，不停在骨架", async () => {
    render(
      <ChangeDetailPage
        {...(makeProps({ loadDocument: vi.fn().mockRejectedValue(new Error("offline")) }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("（此 change 尚无提案内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("规格分页重载失败 → 保留已载内容，不抹成假空态", async () => {
    let fail = false;
    const loadCapabilities = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return ["desktop-app"];
    });
    const props = makeProps({ loadCapabilities });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => screen.getByRole("tab", { name: /规格/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(requirementTitles(document.body)).toContain("a"));

    fail = true;
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await new Promise((r) => setTimeout(r, 25));
    // 抽屉开着时一次短暂失败不得把已载好的内容抹成「无 delta 规格」。
    expect(requirementTitles(document.body)).toContain("a");
    expect(screen.queryByText("（此 change 无 delta 规格）")).toBeNull();
  });
});

// spec desktop-app「详情抽屉的工单分页」：条件式「审查」「验证」分页（调度之后、
// 审查在前）、分页出现时以 (change, station) 加载、随 refreshGen 重载、状态翻为
// 非进行中即退场并切回「提案」、加载失败与无工单皆为空态文案而非错误。
describe("详情抽屉的工单分页", () => {
  const HASH = `sha256:${"a".repeat(64)}`;
  const SCOPE = ["src/a.rs", "src/b.rs", "src/c.rs"];
  const REVIEW_TICKET = {
    rounds: [
      {
        index: 1,
        phase: "discovery",
        patchHash: HASH,
        scope: SCOPE,
        findings: [
          { severity: "WARNING", path: "src/a.rs", text: "Correctness: 未处理空清单" },
          { severity: "WARNING", path: "src/b.rs", text: "Standards: 命名不一致" },
        ],
      },
      {
        index: 2,
        phase: "validation",
        patchHash: HASH,
        scope: SCOPE,
        findings: [
          { severity: "WARNING", path: "src/b.rs", text: "Standards: 命名不一致 (accepted)" },
          { severity: "SUGGESTION", path: "src/c.rs", text: "Style: 可简化" },
        ],
      },
    ],
  };
  const VERIFY_TICKET = {
    rounds: [
      {
        index: 1,
        phase: "discovery",
        patchHash: HASH,
        scope: ["src/a.rs"],
        findings: [{ severity: "CRITICAL", path: "src/a.rs", text: "Spec: 缺 Scenario 覆盖" }],
      },
    ],
  };
  const x = (over: Partial<ChangeItem>): ChangeItem => ({
    name: "x",
    status: "in-progress",
    totalTasks: 2,
    completedTasks: 1,
    ...over,
  });
  const tabNames = () => screen.getAllByRole("tab").map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  // 段标题列已撤（desktop-change-doc-views design D8）：站名在阅读卡标题、轮数与阶段词在签槽、计数在数字砖。
  const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const docHead = () => ({
    title: flat(document.querySelector("[data-doc-header] h2")),
    badges: flat(document.querySelector("[data-doc-badges]")),
    tiles: Array.from(document.querySelectorAll("[data-doc-tile]")).map(
      (tile) => `${flat(tile.lastElementChild)} ${flat(tile.firstElementChild)}`,
    ),
  });
  async function openTab(name: RegExp) {
    await waitFor(() => screen.getByRole("tab", { name }));
    fireEvent.mouseDown(screen.getByRole("tab", { name }));
  }

  it("inReview → 「审查」分页排在调度之后，工单以 (x, review) 加载并结构化呈现", async () => {
    const loadStationTicket = vi.fn(async () => REVIEW_TICKET);
    render(
      <ChangeDetailPage
        {...(makeProps({ change: x({ reviewStatus: "inReview", verifyStatus: "none" }), loadStationTicket }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /审查/ }));
    const names = tabNames();
    expect(names).toHaveLength(6);
    expect(names[4]).toMatch(/调度/);
    expect(names[5]).toMatch(/审查/);
    expect(screen.queryByRole("tab", { name: /验证/ })).toBeNull();
    // 分页出现即加载（不必等用户切过去）。
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledWith("x", "review"));

    await openTab(/审查/);
    await waitFor(() =>
      expect(docHead()).toEqual({
        title: "审查",
        badges: "第 2 轮复验",
        tiles: ["轮 2", "CRITICAL（末轮） 0", "WARNING（末轮） 1", "SUGGESTION（末轮） 1"],
      }),
    );
    // 末轮仍有 WARNING：不出「可以盖章」提示框。
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
    const r2 = document.querySelector('[data-ticket-round="2"]') as HTMLElement;
    expect(r2.querySelectorAll("[data-ticket-finding]")).toHaveLength(2);
    expect(within(r2).getByText("已接受")).toBeTruthy();
    expect(within(r2).queryByText(/\(accepted\)/)).toBeNull();
    const r1 = document.querySelector('[data-ticket-round="1"]') as HTMLElement;
    expect(r1.querySelector("[data-ticket-round-toggle]")?.getAttribute("aria-expanded")).toBe("false");
    expect((r1.querySelector("[data-ticket-round-header]")?.textContent ?? "").replace(/\s+/g, " ")).toContain(
      "第 1 轮 · 首轮 · 范围 3 档 · 2 条",
    );
  });

  it("审查／验证节点的徽章为末轮序号；调度节点有 wave 时带「第 N 波」", async () => {
    const loadStationTicket = vi.fn(async (_c: string, station: string) =>
      station === "review" ? REVIEW_TICKET : VERIFY_TICKET,
    );
    render(
      <ChangeDetailPage
        {...(makeProps({
          change: x({ reviewStatus: "inReview", verifyStatus: "inVerify", wave: 3, blockedBy: [] }),
          loadStationTicket,
        }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByRole("tab", { name: /审查/ }).textContent).toContain("第 2 轮"));
    expect(screen.getByRole("tab", { name: /验证/ }).textContent).toContain("第 1 轮");
    expect(screen.getByRole("tab", { name: /调度/ }).textContent).toContain("第 3 波");
  });

  it("两站皆进行中 → 「审查」「验证」依序出现、各载各站、内容互不混入", async () => {
    const loadStationTicket = vi.fn(async (_c: string, station: string) =>
      station === "review" ? REVIEW_TICKET : VERIFY_TICKET,
    );
    render(
      <ChangeDetailPage
        {...(makeProps({ change: x({ reviewStatus: "inReview", verifyStatus: "inVerify" }), loadStationTicket }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /验证/ }));
    const names = tabNames();
    expect(names).toHaveLength(7);
    expect(names[4]).toMatch(/调度/);
    expect(names[5]).toMatch(/审查/);
    expect(names[6]).toMatch(/验证/);
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledTimes(2));
    expect(loadStationTicket).toHaveBeenCalledWith("x", "review");
    expect(loadStationTicket).toHaveBeenCalledWith("x", "verify");

    await openTab(/验证/);
    await waitFor(() =>
      expect(docHead()).toEqual({
        title: "验证",
        badges: "第 1 轮首轮",
        tiles: ["轮 1", "CRITICAL（末轮） 1", "WARNING（末轮） 0", "SUGGESTION（末轮） 0"],
      }),
    );
    expect(document.querySelectorAll("[data-ticket-view]")).toHaveLength(1);
    await openTab(/审查/);
    await waitFor(() => expect(docHead()).toMatchObject({ title: "审查", badges: "第 2 轮复验" }));
  });

  it("reviewed／none → 两分页缺席，加载器未被调用", async () => {
    const loadStationTicket = vi.fn(async () => REVIEW_TICKET);
    render(
      <ChangeDetailPage
        {...(makeProps({ change: x({ reviewStatus: "reviewed", verifyStatus: "none" }), loadStationTicket }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /调度/ }));
    await screen.findByText(/doc for proposal.md/);
    expect(tabNames()).toHaveLength(5);
    expect(screen.queryByRole("tab", { name: /审查/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /验证/ })).toBeNull();
    expect(loadStationTicket).not.toHaveBeenCalled();
  });

  it("停在「审查」分页时状态翻为 reviewed → 分页消失、退回「提案」", async () => {
    const loadStationTicket = vi.fn(async () => REVIEW_TICKET);
    const props = makeProps({ change: x({ reviewStatus: "inReview", verifyStatus: "none" }), loadStationTicket });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} />);
    await openTab(/审查/);
    await waitFor(() => expect(docHead()).toMatchObject({ title: "审查", badges: "第 2 轮复验" }));
    expect(screen.getByRole("tab", { name: /审查/ }).getAttribute("data-state")).toBe("active");

    rerender(
      <ChangeDetailPage
        {...(props as never)}
        change={x({ reviewStatus: "reviewed", verifyStatus: "none", reviewedAt: "2026-09-22", reviewedBy: "Rev <r@example.com>" })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("tab", { name: /审查/ })).toBeNull());
    expect(screen.getByRole("tab", { name: /提案/ }).getAttribute("data-state")).toBe("active");
    await screen.findByText(/doc for proposal.md/);
    expect(document.querySelector("[data-ticket-view]")).toBeNull();
    // 「品质关卡」列的章签改为「已审查」。
    expect(document.querySelector("[data-status-quality] [data-review-row]")!.textContent).toContain("已审查");
  });

  it("refreshGen 递增 → 工单重载（追加轮后段标题更新）", async () => {
    let current = VERIFY_TICKET;
    const loadStationTicket = vi.fn(async () => current);
    const props = makeProps({ change: x({ reviewStatus: "inReview", verifyStatus: "none" }), loadStationTicket });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} />);
    await openTab(/审查/);
    await waitFor(() => expect(docHead().badges).toMatch(/^第 1 轮/));
    expect(loadStationTicket).toHaveBeenCalledTimes(1);

    current = REVIEW_TICKET;
    rerender(<ChangeDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(docHead()).toMatchObject({ badges: "第 2 轮复验", tiles: expect.arrayContaining(["轮 2"]) }));
    // spec Scenario「工单追加轮后分页更新」THEN：新末轮展开、旧轮收合。
    const expanded = (index: number) =>
      document
        .querySelector(`[data-ticket-round="${index}"] [data-ticket-round-toggle]`)
        ?.getAttribute("aria-expanded");
    expect(expanded(2)).toBe("true");
    expect(expanded(1)).toBe("false");
  });

  it("换 change 时在途的旧工单回应不落地：新 change 进入 inReview 先见骨架", async () => {
    let settleX: (t: typeof REVIEW_TICKET) => void = () => {};
    const loadStationTicket = vi.fn((change: string) =>
      change === "x"
        ? new Promise<typeof REVIEW_TICKET>((resolve) => {
            settleX = resolve;
          })
        : new Promise<never>(() => {}),
    );
    const props = makeProps({ change: x({ reviewStatus: "inReview", verifyStatus: "none" }), loadStationTicket });
    const { rerender } = render(<ChangeDetailPage {...(props as never)} />);
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledWith("x", "review"));

    // 切到没有工单的 y，x 的回应才到——必须被丢弃。
    rerender(<ChangeDetailPage {...(props as never)} change={x({ name: "y", reviewStatus: "none" })} />);
    await waitFor(() => expect(screen.queryByRole("tab", { name: /审查/ })).toBeNull());
    settleX(REVIEW_TICKET);
    await screen.findByText(/doc for proposal.md/);

    // y 进入 inReview：加载在途，分页该是骨架，不得先闪出 x 的工单。
    rerender(<ChangeDetailPage {...(props as never)} change={x({ name: "y", reviewStatus: "inReview" })} />);
    await openTab(/审查/);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(document.querySelector("[data-ticket-view]")).toBeNull();
  });

  it("加载中 → 骨架；加载器 reject 或回 null → 「工单尚未抵达或已被删除」，非错误", async () => {
    const pending = () => new Promise<never>(() => {});
    const first = render(
      <ChangeDetailPage
        {...(makeProps({ change: x({ reviewStatus: "inReview" }), loadStationTicket: vi.fn(pending) }) as never)}
      />,
    );
    await openTab(/审查/);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("工单尚未抵达或已被删除")).toBeNull();
    first.unmount();

    const second = render(
      <ChangeDetailPage
        {...(makeProps({
          change: x({ reviewStatus: "inReview" }),
          loadStationTicket: vi.fn(async () => Promise.reject(new Error("offline"))),
        }) as never)}
      />,
    );
    await openTab(/审查/);
    await screen.findByText("工单尚未抵达或已被删除");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    second.unmount();

    render(
      <ChangeDetailPage
        {...(makeProps({ change: x({ reviewStatus: "inReview" }), loadStationTicket: vi.fn(async () => null) }) as never)}
      />,
    );
    await openTab(/审查/);
    await screen.findByText("工单尚未抵达或已被删除");
  });
});

// spec 需求「详情页的文档动作」：内容卡标头右端由宿主渲染「打开 ▾」，页依作用中分页
// 回报作用中分页对应的文档（change＋artifact）与已加载原文；调度分页没有文档（null）；
// 工单分页只载解析后的回合、不带原文。磁盘位置由宿主解析，页不拼路径。
describe("详情页的文档动作槽", () => {
  async function openTab(name: RegExp) {
    await waitFor(() => screen.getByRole("tab", { name }));
    fireEvent.mouseDown(screen.getByRole("tab", { name }));
  }
  const lastCall = (fn: Mock) => (fn.mock.calls.at(-1) as [DocumentTarget | null])[0];
  const NAME = "desktop-shell-and-browser";
  const doc = (artifact: string) => ({ change: NAME, artifact });

  it("各文档回报对应文档；调度回报 null；回传节点渲染在阅读卡标题列", async () => {
    const renderDocumentActions = vi.fn((target: DocumentTarget | null) =>
      target && "change" in target.doc ? <button type="button">打开 {target.doc.artifact}</button> : null,
    );
    render(
      <ChangeDetailPage
        {...(makeProps({
          change: { ...change, reviewStatus: "inReview", verifyStatus: "inVerify" },
          renderDocumentActions,
          loadStationTicket: vi.fn(async () => null),
        }) as never)}
      />,
    );
    await waitFor(() =>
      expect(lastCall(renderDocumentActions)).toEqual({ doc: doc("proposal.md"), content: "# doc for proposal.md" }),
    );
    const docHeader = () => document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(docHeader()).getByRole("button", { name: "打开 proposal.md" })).toBeTruthy();
    expect(within(document.querySelector("[data-detail-tree]") as HTMLElement).queryByRole("button", { name: /^打开 / })).toBeNull();

    await openTab(/设计/);
    expect(lastCall(renderDocumentActions)).toEqual({ doc: doc("design.md"), content: "# doc for design.md" });
    await openTab(/任务/);
    expect(lastCall(renderDocumentActions)?.doc).toEqual(doc("tasks.md"));
    await openTab(/规格/);
    expect(lastCall(renderDocumentActions)).toEqual({ doc: doc("specs/desktop-app/spec.md"), content: SPEC_MD });
    await openTab(/调度/);
    expect(lastCall(renderDocumentActions)).toBeNull();
    expect(within(docHeader()).queryByRole("button", { name: /^打开 / })).toBeNull();
    await openTab(/审查/);
    expect(lastCall(renderDocumentActions)).toEqual({ doc: doc("review.md") });
    await openTab(/验证/);
    expect(lastCall(renderDocumentActions)).toEqual({ doc: doc("verify.md") });
  });

  it("文档加载中回报的原文为 null", async () => {
    const renderDocumentActions = vi.fn(() => null);
    render(
      <ChangeDetailPage
        {...(makeProps({
          loadDocument: vi.fn(() => new Promise<never>(() => {})),
          renderDocumentActions,
        }) as never)}
      />,
    );
    await waitFor(() => expect(renderDocumentActions).toHaveBeenCalled());
    expect(lastCall(renderDocumentActions as unknown as Mock)).toEqual({ doc: doc("proposal.md"), content: null });
  });

  it("页内无全屏幕切换钮", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    expect(screen.queryByRole("button", { name: /全屏幕|还原大小/ })).toBeNull();
  });
});

// spec「详情页的文档树、阅读卡与本页目录」：规格列能力签切到规格文档并选定该 capability；
// 切换文档时阅读区自顶端呈现、阅读卡标题换成该文档。
describe("文档树与阅读卡", () => {
  it("点规格列的能力签切到规格文档，「打开 ▾」指向该 capability", async () => {
    const renderDocumentActions = vi.fn((_target: DocumentTarget | null) => null);
    const props = makeProps({
      loadCapabilities: vi.fn(async () => ["auth", "desktop-app"]),
      renderDocumentActions,
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const specs = await waitFor(() => {
      const el = document.querySelector("[data-relation-specs]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(within(specs).getByRole("button", { name: "desktop-app" }));
    expect(screen.getByRole("tab", { name: /规格/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(document.querySelector("[data-doc-header]") as HTMLElement).getByRole("heading").textContent).toBe("规格");
    const last = renderDocumentActions.mock.calls.at(-1)![0];
    expect(last?.doc).toEqual({ change: "desktop-shell-and-browser", artifact: "specs/desktop-app/spec.md" });
  });

  it("能力签每点一次卷到该 capability 一次；自文档树切走再切回规格文档时自顶端呈现", async () => {
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.specCap ?? "");
    };
    try {
      const props = makeProps({ loadCapabilities: vi.fn(async () => ["auth", "desktop-app"]) });
      render(<ChangeDetailPage {...(props as never)} />);
      const specs = await waitFor(() => {
        const el = document.querySelector("[data-relation-specs]") as HTMLElement | null;
        expect(el).toBeTruthy();
        return el!;
      });
      fireEvent.click(within(specs).getByRole("button", { name: "desktop-app" }));
      await waitFor(() => expect(scrolled).toEqual(["desktop-app"]));
      fireEvent.mouseDown(screen.getByRole("tab", { name: /提案/ }));
      fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
      expect((document.querySelector("[data-detail-reading]") as HTMLElement).scrollTop).toBe(0);
      expect(scrolled).toEqual(["desktop-app"]);
      fireEvent.click(within(specs).getByRole("button", { name: "desktop-app" }));
      await waitFor(() => expect(scrolled).toEqual(["desktop-app", "desktop-app"]));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("阅读卡出处行：提案为相对变更目录的路径、调度为推算来源", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    const provenance = () => document.querySelector("[data-doc-header] [data-doc-provenance]")?.textContent;
    expect(provenance()).toBe("proposal.md");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /调度/ }));
    expect(provenance()).toBe("由 specseal plan 推算");
  });

  it("换变更（‹ ›）时即使同为提案文档，阅读区也卷回顶端", async () => {
    const props = makeProps();
    const { rerender } = render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const reading = document.querySelector("[data-detail-reading]") as HTMLElement;
    reading.scrollTop = 300;
    rerender(<ChangeDetailPage {...(makeProps({ change: { ...change, name: "another-change" } }) as never)} />);
    expect((document.querySelector("[data-detail-reading]") as HTMLElement).scrollTop).toBe(0);
    await screen.findByText("MomoChen");
  });

  it("切到内文未到的文档：节点立即标示、内文为 skeleton；左栏卷动位置不变", async () => {
    const props = makeProps({
      loadDocument: vi.fn((_c: string, artifact: string) =>
        artifact === "design.md"
          ? new Promise<string>(() => {})
          : Promise.resolve(artifact.startsWith("specs/") ? SPEC_MD : `# doc for ${artifact}`),
      ),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("MomoChen");
    const tree = document.querySelector("[data-detail-tree]") as HTMLElement;
    tree.scrollTop = 120;
    fireEvent.mouseDown(screen.getByRole("tab", { name: /设计/ }));
    expect(screen.getByRole("tab", { name: /设计/ }).getAttribute("data-state")).toBe("active");
    const body = document.querySelector("[data-doc-body]") as HTMLElement;
    expect(body.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(tree.scrollTop).toBe(120);
  });

  it("切换文档后阅读区卷回顶端、阅读卡标题立即换成该文档", async () => {
    render(<ChangeDetailPage {...(makeProps() as never)} />);
    await screen.findByText("MomoChen");
    const reading = document.querySelector("[data-detail-reading]") as HTMLElement;
    const heading = () => within(document.querySelector("[data-doc-header]") as HTMLElement).getByRole("heading");
    expect(heading().textContent).toBe("提案");
    reading.scrollTop = 240;
    fireEvent.mouseDown(screen.getByRole("tab", { name: /设计/ }));
    expect(screen.getByRole("tab", { name: /设计/ }).getAttribute("data-state")).toBe("active");
    expect(heading().textContent).toBe("设计");
    expect(reading.scrollTop).toBe(0);
  });
});

// design D5：各渲染器的区段标题带 data-doc-heading，右栏本页目录以它们为锚点。
describe("本页目录锚点", () => {
  it("提案含 Why／What Changes／Impact 时内文锚点依序为三个章节标签，本页目录列出同三笔", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) =>
        artifact === "proposal.md"
          ? "## Why\n\n因为。\n\n## What Changes\n\n改这个。\n\n## Impact\n\n影响面。\n"
          : artifact.startsWith("specs/")
            ? SPEC_MD
            : `# doc for ${artifact}`,
      ),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    await screen.findByText("因为。");
    const body = document.querySelector("[data-doc-body]") as HTMLElement;
    const heads = Array.from(body.querySelectorAll("[data-doc-heading]")).map((el) => el.textContent);
    expect(heads).toEqual(["为什幺", "变更内容", "影响"]);
    expect(body.querySelector("[data-doc-heading]")!.tagName).toBe("H2");
    const toc = document.querySelector("[data-detail-toc]") as HTMLElement;
    await waitFor(() =>
      expect(Array.from(toc.querySelectorAll("[data-manual-anchor]")).map((el) => el.textContent)).toEqual([
        "为什幺",
        "变更内容",
        "影响",
      ]),
    );
  });

  // 分页换文档时新内容晚一次画面更新才挂上：本页目录要跟着重扫，不得停在前一份文档的锚点。
  it("提案切到设计后，本页目录换成设计的章节锚点", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) =>
        artifact === "proposal.md"
          ? "## Why\n\n因为。\n\n## Impact\n\n影响面。\n"
          : artifact === "design.md"
            ? "## Context\n\n脉络。\n\n## Decisions\n\n决定。\n"
            : `# doc for ${artifact}`,
      ),
    });
    render(<ChangeDetailPage {...(props as never)} />);
    const anchors = () =>
      Array.from(document.querySelectorAll("[data-detail-toc] [data-manual-anchor]")).map((el) => el.textContent);
    await waitFor(() => expect(anchors()).toEqual(["为什幺", "影响"]));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /设计/ }));
    // 前提：设计文档在切换前已加载，切换当下内文即在画面上（不等待）。若改成切到分页才加载，加载完成时重扫键
    // 变动会强制重扫，拿掉内文监看也会绿——此断言先红，提醒本测试已失去守门作用。
    expect(screen.getByText("脉络。")).toBeTruthy();
    await waitFor(() => expect(anchors()).toEqual(["背景", "决策"]));
  });

  it("规格 delta 的色标区段标头与调度四卡标题为锚点", async () => {
    render(
      <ChangeDetailPage
        {...(makeProps({ change: { ...change, wave: 1, blockedBy: [], dependsOn: [] } }) as never)}
      />,
    );
    await screen.findByText("MomoChen");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(document.querySelector('[data-delta-section="added"]')).toBeTruthy());
    expect(document.querySelector('[data-delta-section="added"]')!.hasAttribute("data-doc-heading")).toBe(true);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /调度/ }));
    const titles = Array.from(document.querySelectorAll("[data-plan-card-header] [data-doc-heading]"));
    expect(titles).toHaveLength(4);
  });
});

// spec「提案与设计章节以中文标签呈现」「任务群组标题与章节标签同款式」「规格分页 delta 区段以色标呈现」
// 的阅读卡签槽、数字砖、提示框与跨文档跳转（desktop-change-doc-views design D9）。
describe("变更文档的签、数字砖、提示框与跳转", () => {
  const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const badges = () => flat(document.querySelector("[data-doc-badges]"));
  const tiles = () =>
    Array.from(document.querySelectorAll("[data-doc-tile]")).map((t) => `${flat(t.lastElementChild)} ${flat(t.firstElementChild)}`);
  const REFACTOR = [
    "## Summary",
    "",
    "一句话。",
    "",
    "## Motivation",
    "",
    "- 动机",
    "",
    "## Proposed Solution",
    "",
    ...[1, 2, 3, 4, 5, 6].map((n) => `${n}. 步骤 ${n}`),
    "",
    "## Non-Goals",
    "",
    ...[1, 2, 3, 4, 5].map((n) => `- 非目标 ${n}`),
    "",
    "## Alternatives Considered",
    "",
    ...[1, 2, 3, 4].map((n) => `- 方案 ${n}——理由 ${n}`),
    "",
    "## Capabilities",
    "",
    "### New Capabilities",
    "",
    "(none)",
    "",
    "### Modified Capabilities",
    "",
    "- `desktop-app`: 改版",
    "",
    "## Impact",
    "",
    "- Affected specs: desktop-app",
    "- Affected code:",
    "  - New: a.ts、b.ts",
    "  - Modified: c.ts、d.ts、e.ts、f.ts",
    "  - Removed: (none)",
  ].join("\n");
  const DESKTOP_DELTA = [
    "## MODIFIED Requirements",
    "",
    ...["甲", "乙", "丙"].flatMap((n) => [`### Requirement: ${n}`, "", `${n}需求文。`, ""]),
    "<!-- REMOVED-SCENARIO: 旧情境 -->",
  ].join("\n");
  const DESIGN = "## Decisions\n\n### D1 一\n\n- a\n\n### D3 三\n\n- c\n";
  const TASKS = [
    "## 1. 甲",
    "",
    "- [x] 1.1 a",
    "- [x] 1.2 b",
    "- [x] 1.3 c",
    "",
    "## 2. 乙",
    "",
    "- [x] 2.1 d",
    "- [x] 2.2 e",
    "- [x] 2.3 f",
    "",
    "## 3. 丙",
    "",
    "- [x] 3.1 g",
    "- [ ] [M] 3.2 手动验收 `dev:desktop` 画面",
    "- [ ] 3.3 h",
  ].join("\n");
  const docs: Record<string, string> = {
    "proposal.md": REFACTOR,
    "design.md": DESIGN,
    "tasks.md": TASKS,
    "specs/desktop-app/spec.md": DESKTOP_DELTA,
  };
  const props = (over: Record<string, unknown> = {}) =>
    makeProps({
      loadDocument: vi.fn(async (_c: string, artifact: string) => docs[artifact] ?? null),
      ...over,
    });

  it("提案文档：签槽为模板形状、四格砖依序、能力段之下的改写提示框", async () => {
    render(<ChangeDetailPage {...(props() as never)} />);
    await waitFor(() => expect(badges()).toBe("Refactor"));
    expect(tiles()).toEqual(["解法步骤 6", "非目标 5", "能力 1", "影响的文档 6"]);
    await waitFor(() =>
      expect(flat(document.querySelector('[data-section="sections.capabilities"] [data-doc-callout]'))).toContain(
        "desktop-app 有 3 条需求被改写，其中 1 个 scenario 以 REMOVED-SCENARIO 声明",
      ),
    );
  });

  it("点提案能力签后规格节点作用中，「打开 ▾」指向该能力的 delta 规格", async () => {
    const renderDocumentActions = vi.fn((_target: DocumentTarget | null) => null);
    render(<ChangeDetailPage {...(props({ renderDocumentActions }) as never)} />);
    const chip = await waitFor(() => {
      const el = document.querySelector('[data-section="sections.capabilities"] button[data-capability-chip]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByRole("tab", { name: /规格/ }).getAttribute("data-state")).toBe("active"));
    const target = renderDocumentActions.mock.calls.at(-1)![0];
    expect(target?.doc).toEqual({ change: change.name, artifact: "specs/desktop-app/spec.md" });
  });

  it("点任务的 D3 签后设计节点作用中且 D3 决策卡展开", async () => {
    render(<ChangeDetailPage {...(props() as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(taskListProps.at(-1)?.onJumpDecision).toBeTypeOf("function"));
    act(() => (taskListProps.at(-1)!.onJumpDecision as (id: string) => void)("D3"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /设计/ }).getAttribute("data-state")).toBe("active"));
    await waitFor(() =>
      expect(document.querySelector('[data-decision="D3"] button')?.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(document.querySelector('[data-decision="D1"] button')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("任务文档：数字砖 9／7／1／3 与手动提示框列出 3.2；全部勾选后签槽为「全部完成」", async () => {
    const first = render(<ChangeDetailPage {...(props() as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(tiles()).toEqual(["任务 9", "已完成 7", "手动 1", "群组 3"]));
    expect(badges()).toBe("7/9");
    const callout = document.querySelector("[data-doc-callout]")!;
    expect(flat(callout)).toContain("1 个手动任务");
    // spec「接口状态语意色分层」：手动任务提示框取暖黄手动色（design D14）。
    expect(callout.firstElementChild!.className).toContain("bg-status-manual/10");
    const manualRow = callout.querySelector("[data-manual-task]") as HTMLElement;
    expect(flat(manualRow)).toContain("3.2手动验收 dev:desktop 画面");
    // 标题的行内代码为等宽签（不直出反引号）。
    expect(manualRow.querySelector("code")?.textContent).toBe("dev:desktop");
    expect(flat(manualRow)).not.toContain("`");
    // 「前往」：TaskList 收到第 8 个任务（3.2）的定位请求。
    fireEvent.click(within(manualRow).getByRole("button", { name: "前往" }));
    await waitFor(() => expect((taskListProps.at(-1)?.locate as { ordinal: number } | null)?.ordinal).toBe(8));
    first.unmount();

    render(<ChangeDetailPage {...(props({ loadDocument: withTasks(TASKS.replace(/- \[ \]/g, "- [x]")) }) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(badges()).toBe("全部完成"));
    // 手动任务全部勾完：「手动」数字砖仍计总数，提示框缺席。
    expect(tiles()).toContain("手动 1");
    expect(manualCallout()).toBeNull();
  });

  /** tasks.md 换成指定内容、其余文档照 docs 的加载器。 */
  const withTasks = (tasksMd: string) =>
    vi.fn(async (_c: string, artifact: string) => (artifact === "tasks.md" ? tasksMd : (docs[artifact] ?? null)));
  // 手动任务 4.3、5.8、6.9、7.6 分属四个群组、各夹一条一般任务（序数 2、4、6、8）；checked 为已勾的手动任务。
  const manualTasks = (checked: string[]) =>
    ["4.3", "5.8", "6.9", "7.6"]
      .map((n) =>
        [`## ${n[0]}. 群组`, "", `- [ ] ${n[0]}.1 一般`, `- [${checked.includes(n) ? "x" : " "}] [M] ${n} 手动`].join("\n"),
      )
      .join("\n\n");
  const manualProps = (checked: string[], over: Record<string, unknown> = {}) =>
    props({ loadDocument: withTasks(manualTasks(checked)), ...over });
  const toggle = (ordinal: number, done: boolean) =>
    act(() => (taskListProps.at(-1)!.onToggle as (o: number, d: boolean) => void)(ordinal, done));
  const manualCallout = () => document.querySelector("[data-doc-callout]");
  const manualRows = () =>
    Array.from(document.querySelectorAll("[data-doc-callout] [data-manual-task]")).map((row) => flat(row.firstElementChild));

  // spec Example「勾选状态与提示框」：一列一题。
  it.each([
    { checked: [], title: "4 个手动任务", rows: ["4.3", "5.8", "6.9", "7.6"] },
    { checked: ["4.3"], title: "3 个手动任务", rows: ["5.8", "6.9", "7.6"] },
    { checked: ["4.3", "5.8", "6.9", "7.6"], title: null, rows: [] },
  ])("勾选状态与提示框：已勾 $checked → $title", async ({ checked, title, rows }) => {
    render(<ChangeDetailPage {...(manualProps(checked) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(tiles()).toContain("手动 4"));
    if (title) expect(flat(manualCallout())).toContain(title);
    else expect(manualCallout()).toBeNull();
    expect(manualRows()).toEqual(rows);
  });

  it("部分勾选时提示框只列未勾选的手动任务", async () => {
    render(<ChangeDetailPage {...(manualProps(["4.3"], { onToggleTask: vi.fn().mockResolvedValue(undefined) }) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(tiles()).toContain("手动 4"));
    expect(flat(manualCallout())).toContain("3 个手动任务");
    expect(manualRows()).toEqual(["5.8", "6.9", "7.6"]);

    toggle(4, true);
    toggle(6, true);
    toggle(8, true);
    await waitFor(() => expect(manualCallout()).toBeNull());
    expect(tiles()).toContain("手动 4");

    toggle(6, false);
    await waitFor(() => expect(manualRows()).toEqual(["6.9"]));
    expect(flat(manualCallout())).toContain("1 个手动任务");
    expect(tiles()).toContain("手动 4");
  });

  it("勾选写回失败时提示框跟着回滚", async () => {
    render(
      <ChangeDetailPage
        {...(manualProps(["4.3"], { onToggleTask: vi.fn().mockRejectedValue(new Error("disk full")) }) as never)}
      />,
    );
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(tiles()).toContain("手动 4"));
    toggle(4, true);
    // 乐观勾选先生效（写回的拒绝要到下一个 microtask 才回滚）。
    expect(manualRows()).toEqual(["6.9", "7.6"]);
    await waitFor(() => expect(screen.getByText(/写回失败/)).toBeTruthy());
    expect(flat(manualCallout())).toContain("3 个手动任务");
    expect(manualRows()).toEqual(["5.8", "6.9", "7.6"]);
  });

  it("「全部已完成」「重置任务」与外部变更：世代重载后提示框跟着 tasks.md", async () => {
    const { rerender } = render(<ChangeDetailPage {...(manualProps(["4.3"]) as never)} refreshGen={0} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(manualRows()).toEqual(["5.8", "6.9", "7.6"]));
    // 三者都由宿主 refresh 递增世代、重读 tasks.md 收敛。
    rerender(<ChangeDetailPage {...(manualProps(["4.3", "5.8", "6.9", "7.6"]) as never)} refreshGen={1} />);
    await waitFor(() => expect(manualCallout()).toBeNull());
    rerender(<ChangeDetailPage {...(manualProps([]) as never)} refreshGen={2} />);
    await waitFor(() => expect(manualRows()).toEqual(["4.3", "5.8", "6.9", "7.6"]));
    expect(tiles()).toContain("手动 4");
  });

  it("规格文档：签槽为各操作计数、数字砖 2／5／2／「1 ／ 0」", async () => {
    const twoCaps = [
      "## MODIFIED Requirements",
      "",
      ...[1, 2, 3, 4, 5].flatMap((n) => [`### Requirement: 改 ${n}`, "", "内文。", ""]),
      "<!-- REMOVED-SCENARIO: 旧一 -->",
      "<!-- REMOVED-SCENARIO: 旧二 -->",
    ].join("\n");
    const added = "## ADDED Requirements\n\n### Requirement: 新\n\n内文。\n";
    render(
      <ChangeDetailPage
        {...(props({
          loadCapabilities: vi.fn(async () => ["desktop-app", "client-protocol"]),
          loadDocument: vi.fn(async (_c: string, artifact: string) =>
            artifact === "specs/desktop-app/spec.md" ? twoCaps : artifact === "specs/client-protocol/spec.md" ? added : "# doc",
          ),
        }) as never)}
      />,
    );
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(tiles()).toEqual(["触及的能力 2", "修改的需求 5", "移除的 scenario 2", "添加／更名 1 ／ 0"]));
    expect(Array.from(document.querySelectorAll("[data-doc-badges] [data-delta-count]")).map((b) => flat(b))).toEqual([
      "修改 5",
      "添加 1",
    ]);
  });

  it("设计文档：数字砖依序为决策、目标／非目标、风险与取舍、开放问题（「无」算 0）", async () => {
    const design = [
      "## Goals / Non-Goals",
      "",
      "**Goals:**",
      "",
      ...["一", "二", "三", "四", "五"].map((n) => `- 目标${n}`),
      "",
      "**Non-Goals:**",
      "",
      ...["一", "二", "三"].map((n) => `- 非目标${n}`),
      "",
      "## Decisions",
      "",
      ...["面板底与卡片层", "二", "三", "四", "五", "六"].flatMap((title, i) => [`### D${i + 1} ${title}`, "", "- 点", ""]),
      "## Risks / Trade-offs",
      "",
      ...["一", "二", "三", "四"].map((n) => `- [风险${n}] → 对策`),
      "",
      "## Open Questions",
      "",
      "无",
    ].join("\n");
    const loadDocument = vi.fn(async (_c: string, artifact: string) => (artifact === "design.md" ? design : (docs[artifact] ?? null)));
    render(<ChangeDetailPage {...(props({ loadDocument }) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /设计/ }));
    await waitFor(() => expect(tiles()).toEqual(["决策 6", "目标／非目标 5 ／ 3", "风险与取舍 4", "开放问题 0"]));
    expect(document.querySelectorAll("[data-risk]")).toHaveLength(4);
  });

  it("提案列为新能力的规格段不出「看正式规格」（封存前没有正式规格），修改的能力照常", async () => {
    const proposal = "## Capabilities\n\n### New Capabilities\n\n- `doc-views`: 新能力\n\n### Modified Capabilities\n\n- `desktop-app`: 改版\n";
    const loadDocument = vi.fn(async (_c: string, artifact: string) =>
      artifact === "proposal.md"
        ? proposal
        : artifact === "specs/doc-views/spec.md"
          ? "## ADDED Requirements\n\n### Requirement: 新\n\n内文。\n"
          : (docs[artifact] ?? null),
    );
    const loadCapabilities = vi.fn().mockResolvedValue(["desktop-app", "doc-views"]);
    render(<ChangeDetailPage {...(props({ loadDocument, loadCapabilities, onOpenSpec: vi.fn() }) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(document.querySelector('[data-spec-cap="doc-views"]')).toBeTruthy());
    expect(document.querySelector('[data-spec-cap="doc-views"]')!.textContent).not.toContain("看正式规格");
    expect(within(document.querySelector('[data-spec-cap="desktop-app"]') as HTMLElement).getByRole("button", { name: "看正式规格" })).toBeTruthy();
  });

  it("规格文档能力头的「看正式规格」交宿主开规格详情页", async () => {
    const onOpenSpec = vi.fn();
    render(<ChangeDetailPage {...(props({ onOpenSpec }) as never)} />);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /规格/ }));
    fireEvent.click(await screen.findByRole("button", { name: "看正式规格" }));
    expect(onOpenSpec).toHaveBeenCalledWith("desktop-app");
  });
});


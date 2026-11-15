import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

// 捕捉 DndContext 的接线 props（onDragStart/onDragEnd）——jsdom 无法仿真真实
// pointer 拖曳手势，改直接驱动接线回呼验证落点渲染与 archived 分支守门；
// 组件本身仍以原 DndContext 渲染，既有测试不受影响。
const captured = vi.hoisted(() => ({ dnd: null as any, overlayChildren: false }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  const Wrapped = (props: any) => {
    captured.dnd = props;
    return <actual.DndContext {...props} />;
  };
  // DragOverlay 只在 dnd-kit 内部 active 存在时渲染子节点；直接驱动回呼的测试要看浮动卡时
  // 打开 overlayChildren，改为原样渲染子节点（缺省关闭，其余测试照旧）。
  const Overlay = (props: any) =>
    captured.overlayChildren ? <div data-drag-overlay>{props.children}</div> : <actual.DragOverlay {...props} />;
  return { ...actual, DndContext: Wrapped, DragOverlay: Overlay };
});

import { act } from "@testing-library/react";

import { KanbanBoard, DRAG_ACTIVATION_DISTANCE } from "../components/KanbanBoard";
import { archiveZoneVisible, cardDndId, invalidDropTargets, resolveCardDrop, type ColumnCards } from "../boardDnd";
import { parseTasks } from "../tasks";
import { SEMANTIC_TONE } from "../tone";
import type { ChangeItem, DiscussionLists } from "../adapter";

const changes: ChangeItem[] = [
  // 字段由生命周期标记驱动——全完成＝已就绪 ＞ started_at 或任务完成数>0＝进行中
  // ＞ 其余＝提案中（刚 propose 完、全未勾、未开工）。
  { name: "proposing-x", status: "in-progress", totalTasks: 28, completedTasks: 0 },
  { name: "working-y", status: "in-progress", totalTasks: 10, completedTasks: 4, startedAt: "2026-07-06" },
  // 无章有进度（手改 tasks.md / agent 直改 / git pull 等绕道）——派生管显示。
  { name: "progressed-w", status: "in-progress", totalTasks: 14, completedTasks: 2 },
  { name: "ready-z", status: "done", totalTasks: 5, completedTasks: 5 },
];

function column(id: string): HTMLElement {
  return document.querySelector(`[data-column="${id}"]`) as HTMLElement;
}

describe("KanbanBoard 生命周期四栏色相（spec「生命周期四栏各一色相」「看板栏与卡片的容器外观」；design D1）", () => {
  it("三栏为白底细框圆角容器：首子节点为 bg-stage-* 色相条、标头白底、栏名不全大写；图标与计数徽章取各自 stage token", () => {
    render(<KanbanBoard changes={changes} />);
    for (const stage of ["proposed", "in-progress", "ready"] as const) {
      const token = `stage-${stage}`;
      const col = column(stage);
      const cls = col.className.split(/\s+/);
      expect(cls).toContain("rounded-2xl");
      expect(cls).toContain("bg-sidebar");
      expect(cls).toContain("border");
      // 栏不再以 border-t-4 当色条：第一个子节点是 3px 色相条，取 STAGE_BAR 的纯 bg-stage-*。
      expect(cls.some((c) => c.startsWith("border-t-"))).toBe(false);
      expect(col.firstElementChild!.className).toContain(`bg-${token}`);
      const heading = col.querySelector("h2")!;
      expect(heading.className).not.toContain("uppercase");
      expect(heading.parentElement!.className).toContain("bg-card");
      const icon = heading.previousElementSibling as Element;
      expect(icon.getAttribute("class")).toContain(`text-${token}`);
      expect(within(col).getByTestId("column-count").className).toContain(token);
    }
  });

  it("栏列为等宽 grid：有讨论栏四栏、无讨论栏三栏", () => {
    const row = () => column("proposed").parentElement as HTMLElement;
    const { unmount } = render(<KanbanBoard changes={changes} discussions={{ active: [], archived: [] }} />);
    expect(row().className).toContain("grid-cols-[repeat(4,minmax(220px,1fr))]");
    expect(row().className).not.toContain("safe_center");
    unmount();
    render(<KanbanBoard changes={changes} />);
    expect(row().className).toContain("grid-cols-[repeat(3,minmax(220px,1fr))]");
  });

  it("零卡且非加载中的栏于卡片区置中显示空文案", () => {
    render(<KanbanBoard changes={[]} />);
    const empty = within(column("proposed")).getByText("没有提案中的变更");
    expect(empty.className).toContain("text-center");
    expect(empty.className).toContain("text-muted-foreground");
    expect(within(column("in-progress")).getByText("没有进行中的变更")).toBeTruthy();
    expect(within(column("ready")).getByText("没有已就绪的变更")).toBeTruthy();
  });

  it("搜索无命中时三栏各显示空文案（spec「空栏显示置中灰字」）", () => {
    render(<KanbanBoard changes={changes} query="zzz-no-match" onQuery={vi.fn()} />);
    expect(within(column("proposed")).getByText("没有提案中的变更")).toBeTruthy();
    expect(within(column("in-progress")).getByText("没有进行中的变更")).toBeTruthy();
    expect(within(column("ready")).getByText("没有已就绪的变更")).toBeTruthy();
  });

  it("已就绪零卡且搜索使进行中无命中：两栏各显示空文案、计数为 0（spec「空栏显示置中灰字」）", () => {
    const noReady = changes.filter((c) => c.name !== "ready-z");
    render(<KanbanBoard changes={noReady} query="proposing" onQuery={vi.fn()} />);
    const count = (id: string) => within(column(id)).getByTestId("column-count").textContent;
    expect(within(column("ready")).getByText("没有已就绪的变更")).toBeTruthy();
    expect(within(column("in-progress")).getByText("没有进行中的变更")).toBeTruthy();
    expect(count("ready")).toBe("0");
    expect(count("in-progress")).toBe("0");
    // 有命中的栏照常显卡片、不出空文案。
    expect(column("proposed").querySelector('[data-change="proposing-x"]')).toBeTruthy();
    expect(within(column("proposed")).queryByText("没有提案中的变更")).toBeNull();
  });

  it("有卡片的栏、加载中与加载失败的栏都不显示空文案", () => {
    const { unmount } = render(<KanbanBoard changes={changes} />);
    expect(screen.queryByText("没有提案中的变更")).toBeNull();
    expect(screen.queryByText("没有已就绪的变更")).toBeNull();
    unmount();
    const r2 = render(<KanbanBoard changes={[]} loading />);
    expect(screen.queryByText("没有提案中的变更")).toBeNull();
    r2.unmount();
    render(<KanbanBoard changes={[]} loadFailed />);
    expect(screen.queryByText("没有提案中的变更")).toBeNull();
  });

  it("en 空文案", () => {
    rtlRender(
      <I18nProvider locale="en">
        <KanbanBoard changes={[]} />
      </I18nProvider>,
    );
    expect(screen.getByText("No proposed changes")).toBeTruthy();
    expect(screen.getByText("No changes in progress")).toBeTruthy();
    expect(screen.getByText("No ready changes")).toBeTruthy();
  });

  it("变更卡与讨论卡为容器内小卡（nested＋interactive）：12px 圆角、无阴影", () => {
    render(
      <KanbanBoard
        changes={changes}
        discussions={{
          active: [{ slug: "d1", topic: "D1", status: "open", rounds: 1, created: "2026-10-08", promotedTo: [] }],
          archived: [],
        }}
      />,
    );
    for (const card of [
      document.querySelector('[data-change="working-y"]')!,
      document.querySelector('[data-discussion="d1"]')!,
    ]) {
      const cls = card.className.split(/\s+/);
      expect(cls).toContain("rounded-xl");
      expect(cls.some((c) => c.includes("shadow"))).toBe(false);
      expect(cls.some((c) => c.startsWith("hover:bg-"))).toBe(true);
    }
  });

  it("卡片波次章随所在栏色相，与栏计数徽章同色", () => {
    const waved: ChangeItem[] = [
      { name: "w-prop", status: "proposed", totalTasks: 3, completedTasks: 0, wave: 1 },
      { name: "w-prog", status: "in-progress", totalTasks: 3, completedTasks: 1, wave: 2 },
    ];
    render(<KanbanBoard changes={waved} />);
    const prop = within(column("proposed")).getByLabelText("第 1 波");
    const prog = within(column("in-progress")).getByLabelText("第 2 波");
    expect(prop.className).toContain("stage-proposed");
    expect(prop.className).not.toContain("stage-in-progress");
    expect(prog.className).toContain("stage-in-progress");
  });
});

describe("KanbanBoard", () => {
  it("places each change in its lifecycle column (Chinese labels, no archived column)", () => {
    render(<KanbanBoard changes={changes} />);
    expect(screen.getByText("提案中")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();
    expect(within(column("proposed")).getByText("proposing-x")).toBeTruthy();
    expect(within(column("in-progress")).getByText("working-y")).toBeTruthy();
    // 无 started_at 而有任务进度的卡片列于进行中栏（spec Scenario「无章而有任务进度列于进行中」）。
    expect(within(column("in-progress")).getByText("progressed-w")).toBeTruthy();
    expect(within(column("ready")).getByText("ready-z")).toBeTruthy();
    // 封存栏不在看板（拖曳时才浮现落点）
    expect(column("archived")).toBeNull();
  });

  it("栏内卡片顺序＝payload 顺序（spec「看板卡片顺序以 board_rank 字段为真相」：看板只按阶段过滤，不排序）", () => {
    // 顺序真相在引擎 plan（桌面 core 的清单 payload）；前端不得再依名称、创建日期
    // 或修改时间重排——这里刻意用反字典序、反日期序的 payload。
    const ordered: ChangeItem[] = [
      { name: "zeta", status: "in-progress", totalTasks: 4, completedTasks: 1, created: "2026-07-09", wave: 1 },
      { name: "alpha", status: "in-progress", totalTasks: 4, completedTasks: 1, created: "2026-07-01", wave: 2 },
      { name: "mid", status: "in-progress", totalTasks: 4, completedTasks: 1, created: "2026-07-05", wave: 2 },
    ];
    render(<KanbanBoard changes={ordered} />);
    const names = Array.from(column("in-progress").querySelectorAll("[data-change]")).map((el) =>
      el.getAttribute("data-change"),
    );
    expect(names).toEqual(["zeta", "alpha", "mid"]);
  });

  it("shows the archive button only on ready cards", () => {
    render(<KanbanBoard changes={changes} onArchive={vi.fn()} />);
    const readyCard = screen.getByText("ready-z").closest("[data-change]") as HTMLElement;
    expect(within(readyCard).getByRole("button", { name: /封存/ })).toBeTruthy();
    const workingCard = screen.getByText("working-y").closest("[data-change]") as HTMLElement;
    expect(within(workingCard).queryByRole("button", { name: /封存/ })).toBeNull();
  });

  it("fires onArchive from a ready card's archive button", () => {
    const onArchive = vi.fn();
    render(<KanbanBoard changes={changes} onArchive={onArchive} />);
    const readyCard = screen.getByText("ready-z").closest("[data-change]") as HTMLElement;
    fireEvent.click(within(readyCard).getByRole("button", { name: /封存/ }));
    expect(onArchive).toHaveBeenCalledWith("ready-z");
  });

  it("shows the revert action only on in-progress cards (spec: 退回动作仅于进行中变更出现)", () => {
    render(<KanbanBoard changes={changes} onRevert={vi.fn()} />);
    // 盖章的进行中卡与无章有进度的派生进行中卡皆显示。
    const workingCard = screen.getByText("working-y").closest("[data-change]") as HTMLElement;
    expect(within(workingCard).getByRole("button", { name: /退回提案中/ })).toBeTruthy();
    const progressedCard = screen.getByText("progressed-w").closest("[data-change]") as HTMLElement;
    expect(within(progressedCard).getByRole("button", { name: /退回提案中/ })).toBeTruthy();
    // 提案中与已就绪不显示。
    const proposedCard = screen.getByText("proposing-x").closest("[data-change]") as HTMLElement;
    expect(within(proposedCard).queryByRole("button", { name: /退回提案中/ })).toBeNull();
    const readyCard = screen.getByText("ready-z").closest("[data-change]") as HTMLElement;
    expect(within(readyCard).queryByRole("button", { name: /退回提案中/ })).toBeNull();
  });

  it("fires onRevert from an in-progress card's revert button without opening the card", () => {
    const onRevert = vi.fn();
    const onOpenChange = vi.fn();
    render(<KanbanBoard changes={changes} onRevert={onRevert} onOpenChange={onOpenChange} />);
    const workingCard = screen.getByText("working-y").closest("[data-change]") as HTMLElement;
    fireEvent.click(within(workingCard).getByRole("button", { name: /退回提案中/ }));
    expect(onRevert).toHaveBeenCalledWith("working-y");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("clicking the action row's blank area opens the card instead of being swallowed", () => {
    const onRevert = vi.fn();
    const onArchive = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <KanbanBoard changes={changes} onRevert={onRevert} onArchive={onArchive} onOpenChange={onOpenChange} />,
    );
    // 进行中卡退回钮列：点按钮旁空白 → 开卡、不触发退回。
    const workingCard = screen.getByText("working-y").closest("[data-change]") as HTMLElement;
    fireEvent.click(
      within(workingCard).getByRole("button", { name: /退回提案中/ }).parentElement as HTMLElement,
    );
    expect(onOpenChange).toHaveBeenCalledWith("working-y");
    expect(onRevert).not.toHaveBeenCalled();
    // 已就绪卡封存钮列同理。
    const readyCard = screen.getByText("ready-z").closest("[data-change]") as HTMLElement;
    fireEvent.click(
      within(readyCard).getByRole("button", { name: /封存/ }).parentElement as HTMLElement,
    );
    expect(onOpenChange).toHaveBeenCalledWith("ready-z");
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("opens a change when its card body is clicked", () => {
    const onOpenChange = vi.fn();
    render(<KanbanBoard changes={changes} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("working-y"));
    expect(onOpenChange).toHaveBeenCalledWith("working-y");
  });

  it("renders English strings under the en locale", () => {
    // 5.3：至少一个组件于 en 下渲染英文本串（i18n 生效的正向证明）。
    rtlRender(
      <I18nProvider locale="en">
        <KanbanBoard changes={changes} />
      </I18nProvider>,
    );
    expect(screen.getByText("Proposed")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText("提案中")).toBeNull();
  });

  it("card copy button copies the change name without opening the card", () => {
    const onOpenChange = vi.fn();
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<KanbanBoard changes={changes} onOpenChange={onOpenChange} />);
    const card = screen.getByText("working-y").closest("[data-change]") as HTMLElement;
    fireEvent.click(within(card).getByLabelText("拷贝名称"));
    expect(writeText).toHaveBeenCalledWith("working-y");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows the restale badge only on cards whose change carries a restaleFrom flag", () => {
    // 「待重新反映」徽章：restaleFrom 非空的卡片显示、为空/缺席不显示；不影响字段派生。
    const withFlag: ChangeItem[] = [
      { name: "stale-a", status: "in-progress", totalTasks: 4, completedTasks: 1, restaleFrom: ["alpha"] },
      { name: "fresh-b", status: "in-progress", totalTasks: 4, completedTasks: 1 },
    ];
    render(<KanbanBoard changes={withFlag} />);
    const staleCard = screen.getByText("stale-a").closest("[data-change]") as HTMLElement;
    const restale = within(staleCard).getByLabelText("待重新反映");
    expect(restale).toBeTruthy();
    // 警示语意走语意色表（深色值由 theme.css 的深色 token 承担）。
    expect(restale.className).toContain(SEMANTIC_TONE.warning);
    const freshCard = screen.getByText("fresh-b").closest("[data-change]") as HTMLElement;
    expect(within(freshCard).queryByLabelText("待重新反映")).toBeNull();
    // 两张皆在进行中栏——徽章与字段归属正交。
    expect(within(column("in-progress")).getByText("stale-a")).toBeTruthy();
    expect(within(column("in-progress")).getByText("fresh-b")).toBeTruthy();
  });

  it("shows the worktree marker only on cards whose change is mapped to a worktree", () => {
    // spec worktree-overlay「desktop 看板的 worktree 呈现」：有映射的卡片带标示，
    // 无映射不带——标示与字段归属正交。
    const withWorktree: ChangeItem[] = [
      {
        name: "wt-a",
        status: "in-progress",
        totalTasks: 4,
        completedTasks: 1,
        worktree: { branch: "specseal/wt-a", path: "/work/specseal.worktrees/wt-a" },
      },
      { name: "plain-b", status: "in-progress", totalTasks: 4, completedTasks: 1 },
    ];
    render(<KanbanBoard changes={withWorktree} />);
    const wtCard = screen.getByText("wt-a").closest("[data-change]") as HTMLElement;
    const marker = within(wtCard).getByLabelText("worktree");
    expect(marker).toBeTruthy();
    // spec「worktree 标示以蓝呈现」：worktree 挂着＝工作正于副本进行中，属状态
    // 而非静态 metadata，走「进行中」语意色，不用主色淡化。
    expect(marker.className).toContain(SEMANTIC_TONE.inProgress);
    expect(marker.className).not.toContain("text-primary/60");
    const plainCard = screen.getByText("plain-b").closest("[data-change]") as HTMLElement;
    expect(within(plainCard).queryByLabelText("worktree")).toBeNull();
    expect(within(column("in-progress")).getByText("wt-a")).toBeTruthy();
  });

  it("shows the invalid-metadata marker only on cards whose change carries metaError", () => {
    // spec「看板照常打开并标记损坏卡」：metaError 卡带最小 invalid 标记
    // （tooltip 载解析原因），有效卡不带；两张卡照常列于看板。
    const withInvalid: ChangeItem[] = [
      { name: "broken-a", status: "in-progress", totalTasks: 4, completedTasks: 1, metaError: "invalid type: sequence" },
      { name: "valid-b", status: "in-progress", totalTasks: 4, completedTasks: 1 },
    ];
    render(<KanbanBoard changes={withInvalid} />);
    const brokenCard = screen.getByText("broken-a").closest("[data-change]") as HTMLElement;
    const marker = within(brokenCard).getByLabelText("metadata 损坏");
    expect(marker).toBeTruthy();
    expect(marker.getAttribute("title")).toBeNull();
    const validCard = screen.getByText("valid-b").closest("[data-change]") as HTMLElement;
    expect(within(validCard).queryByLabelText("metadata 损坏")).toBeNull();
    expect(within(column("in-progress")).getByText("broken-a")).toBeTruthy();
  });

  it("变更卡显示创建者首字母圆标（有 createdBy）、无则省略（D3）", () => {
    const withAuthor: ChangeItem[] = [
      { name: "auth-a", status: "in-progress", totalTasks: 4, completedTasks: 1, createdBy: "Momo Chen <momo@example.com>" },
      { name: "anon-b", status: "in-progress", totalTasks: 4, completedTasks: 1 },
    ];
    render(<KanbanBoard changes={withAuthor} />);
    const authCard = screen.getByText("auth-a").closest("[data-change]") as HTMLElement;
    const avatar = within(authCard).getByLabelText("Momo Chen <momo@example.com>");
    expect(avatar.textContent).toBe("M");
    // 创建者是静态 metadata，走中性；主色留给链接／交互／进度。
    expect(avatar.className).toContain("bg-muted");
    expect(avatar.className).not.toContain("bg-primary");
    const anonCard = screen.getByText("anon-b").closest("[data-change]") as HTMLElement;
    expect(within(anonCard).queryByLabelText(/@/)).toBeNull();
  });

  it("已认领的变更卡显示认领人标记，未认领的卡片不显示（remote-claim-ownership D4）", () => {
    const claimed: ChangeItem[] = [
      { name: "held-a", status: "in-progress", totalTasks: 4, completedTasks: 1, claimedBy: "Alice <a@example.com>" },
      { name: "free-b", status: "in-progress", totalTasks: 4, completedTasks: 1 },
    ];
    render(<KanbanBoard changes={claimed} />);
    const heldCard = screen.getByText("held-a").closest("[data-change]") as HTMLElement;
    const badge = within(heldCard).getByLabelText("已由 Alice <a@example.com> 认领");
    expect(badge.textContent).toContain("A");
    const freeCard = screen.getByText("free-b").closest("[data-change]") as HTMLElement;
    expect(within(freeCard).queryByLabelText(/认领/)).toBeNull();
  });

  it("关系指示（来自讨论／待重新反映）改用主题化提示，不再带原生 title（D3）", () => {
    const rel: ChangeItem[] = [
      { name: "rel-a", status: "in-progress", totalTasks: 4, completedTasks: 1, fromDiscussions: ["alpha"], restaleFrom: ["beta"] },
    ];
    render(<KanbanBoard changes={rel} />);
    const card = screen.getByText("rel-a").closest("[data-change]") as HTMLElement;
    const from = within(card).getByLabelText("来自讨论");
    const restale = within(card).getByLabelText("待重新反映");
    // shadcn Tooltip 取代原生 title——指示组件不再带 title 属性。
    expect(from.getAttribute("title")).toBeNull();
    expect(restale.getAttribute("title")).toBeNull();
  });
});

describe("KanbanBoard search（看板搜索过滤卡片）", () => {
  // GIVEN 对齐 delta spec 的 Example 表：提案中栏两张变更卡＋讨论栏一张卡。
  const searchChanges: ChangeItem[] = [
    { name: "desktop-acp-agent", status: "in-progress", totalTasks: 8, completedTasks: 0, summary: "桌面版 ACP 代理" },
    { name: "web-role-views", status: "in-progress", totalTasks: 6, completedTasks: 0, summary: "情境 1 的角色查看" },
  ];
  const searchDiscussions: DiscussionLists = {
    active: [
      { slug: "gui-auto-stamp", topic: "GUI 勾任务自动盖开工章", status: "open", rounds: 2, created: "2026-07-06", promotedTo: [] },
    ],
    archived: [],
  };

  function renderBoard(query: string, onQuery = vi.fn()) {
    render(
      <KanbanBoard
        changes={searchChanges}
        discussions={searchDiscussions}
        query={query}
        onQuery={onQuery}
      />,
    );
    return onQuery;
  }

  function count(id: string): string {
    return within(column(id)).getByTestId("column-count").textContent ?? "";
  }

  it("renders a search input above the columns when query/onQuery are provided", () => {
    const onQuery = renderBoard("");
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    fireEvent.change(input, { target: { value: "desk" } });
    expect(onQuery).toHaveBeenCalledWith("desk");
  });

  it("renders the English search placeholder under the en locale", () => {
    // 同类搜索输入（已封存页、清单）皆已 i18n 化——看板不落单（verify SUGGESTION）。
    rtlRender(
      <I18nProvider locale="en">
        <KanbanBoard changes={searchChanges} discussions={searchDiscussions} query="" onQuery={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByPlaceholderText("Search board cards…")).toBeTruthy();
  });

  it("does not render a search input when query is not provided", () => {
    render(<KanbanBoard changes={searchChanges} discussions={searchDiscussions} />);
    expect(screen.queryByPlaceholderText("搜索看板卡片…")).toBeNull();
  });

  // spec Example 表逐行参数化：输入 → 提案中栏显示（计数）／讨论栏显示（计数）。
  // 卡片以 data-change／data-discussion 查找——命中字段经高亮 mark 拆分（design D7），
  // 完整文本节点断言不再适用。
  it.each([
    ["desktop", ["desktop-acp-agent"], "1", [], "0"], // 名称子字符串命中
    ["桌面", ["desktop-acp-agent"], "1", [], "0"], // 摘要命中
    [" GUI ", [], "0", ["gui-auto-stamp"], "1"], // 去头尾空白、不分大小写
    ["", ["desktop-acp-agent", "web-role-views"], "2", ["gui-auto-stamp"], "1"], // 清空还原全量
  ])(
    "query %j filters proposed column and discussion column per the spec example table",
    (query, proposedShown, proposedCount, discussionShown, discussionCount) => {
      renderBoard(query);
      for (const name of proposedShown) {
        expect(column("proposed").querySelector(`[data-change="${name}"]`)).toBeTruthy();
      }
      expect(column("proposed").querySelectorAll("[data-change]")).toHaveLength(proposedShown.length);
      expect(count("proposed")).toBe(proposedCount);
      for (const slug of discussionShown) {
        expect(column("discussions").querySelector(`[data-discussion="${slug}"]`)).toBeTruthy();
      }
      expect(column("discussions").querySelectorAll("[data-discussion]")).toHaveLength(discussionShown.length);
      expect(count("discussions")).toBe(discussionCount);
    },
  );

  it("matches case-insensitively and against the discussion slug", () => {
    // 需求文本：不分大小写；讨论卡以主题「与 slug」比对。
    renderBoard("gui");
    expect(column("discussions").querySelector('[data-discussion="gui-auto-stamp"]')).toBeTruthy();
    expect(count("discussions")).toBe("1");
  });

  it("matches against the discussion slug", () => {
    renderBoard("auto-stamp");
    expect(within(column("discussions")).getByText("GUI 勾任务自动盖开工章")).toBeTruthy();
    expect(count("discussions")).toBe("1");
    expect(count("proposed")).toBe("0");
  });

  it("whitespace-only query shows everything (treated as empty)", () => {
    renderBoard("   ");
    expect(count("proposed")).toBe("2");
    expect(count("discussions")).toBe("1");
  });

  it("no match leaves empty columns with zero counts but keeps the column structure", () => {
    renderBoard("zzz-no-match");
    for (const id of ["discussions", "proposed", "in-progress", "ready"]) {
      expect(column(id)).toBeTruthy();
      expect(count(id)).toBe("0");
      expect(column(id).querySelectorAll("[data-change], [data-discussion]")).toHaveLength(0);
    }
  });
});

// desktop-app「看板页的页标题区」（design D6）：title 选配；提供时搜索与筛选落在标题同一列右端。
describe("KanbanBoard 页标题区", () => {
  it("传 title 时出现 h2 标题与说明，搜索输入在同一列", () => {
    render(
      <KanbanBoard
        changes={changes}
        query=""
        onQuery={vi.fn()}
        title="变更"
        description="依生命周期分栏。"
      />,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "变更" });
    const header = heading.closest("[data-page-header]") as HTMLElement;
    expect(within(header).getByText("依生命周期分栏。")).toBeTruthy();
    expect(within(header).getByPlaceholderText("搜索看板卡片…")).toBeTruthy();
  });

  it("不传 title 时无页标题区，搜索列照旧", () => {
    render(<KanbanBoard changes={changes} query="" onQuery={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "变更" })).toBeNull();
    expect(document.querySelector("[data-page-header]")).toBeNull();
    expect(screen.getByPlaceholderText("搜索看板卡片…")).toBeTruthy();
  });
});

describe("KanbanBoard 拖排（design D6）", () => {
  // 每栏可见卡的识别码（视觉序）——resolveCardDrop 的输入形状。
  const cols: ColumnCards[] = [
    { kind: "discussion", ids: ["d-one", "d-two"] },
    { kind: "change", ids: ["a", "b", "c"] },
    { kind: "change", ids: ["x"] },
  ];

  // dragEnd 落点解析：同栏放开 → 以 arrayMove 后的相邻卡为 prevId/nextId。
  it.each([
    ["c", "a", null, "a"], // 拖到栏顶：prev=null
    ["a", "b", "b", "c"], // 向下一格：插于 b、c 之间
    ["a", "c", "c", null], // 拖到栏底：next=null
  ])(
    "same-column drop of %s over %s resolves prev=%s next=%s",
    (active, over, prev, next) => {
      const r = resolveCardDrop(cols, cardDndId("change", active), cardDndId("change", over));
      expect(r).toEqual({ kind: "change", id: active, prevId: prev, nextId: next });
    },
  );

  it("resolves discussion drops within the discussion column", () => {
    const r = resolveCardDrop(cols, cardDndId("discussion", "d-two"), cardDndId("discussion", "d-one"));
    expect(r).toEqual({ kind: "discussion", id: "d-two", prevId: null, nextId: "d-one" });
  });

  it("cross-column drops resolve to null (snap back, zero writes)", () => {
    // spec「跨栏拖曳不改变变更阶段」：跨栏放开不得产生 reorder 调用。
    expect(resolveCardDrop(cols, cardDndId("change", "a"), cardDndId("change", "x"))).toBeNull();
    expect(resolveCardDrop(cols, cardDndId("change", "a"), cardDndId("discussion", "d-one"))).toBeNull();
    expect(resolveCardDrop(cols, cardDndId("discussion", "d-one"), cardDndId("change", "b"))).toBeNull();
  });

  it("column containers and the archive drop zone resolve to null", () => {
    // 封存落点走既有 onArchive 路径、栏容器不成落点——皆不产生 reorder。
    expect(resolveCardDrop(cols, cardDndId("change", "a"), "archived")).toBeNull();
    expect(resolveCardDrop(cols, cardDndId("change", "a"), "proposed")).toBeNull();
    expect(resolveCardDrop(cols, cardDndId("change", "a"), cardDndId("change", "a"))).toBeNull();
  });

  it("带 hold 的已结论 promoted 讨论进可拖集，未保留者收合在外", () => {
    // 规格「讨论于看板第 0 栏两级呈现」的拖排判准：上区卡集与可拖集恒等——
    // 两者共用 isCollapsedPromoted，没有第二份判准。
    const base = { topic: "Fanout", status: "promoted", rounds: 2, created: "2026-07-06" };
    const discussions: DiscussionLists = {
      active: [
        { ...base, slug: "held-one", promotedTo: ["cut-a"], concluded: true, hold: true },
        { ...base, slug: "released-one", promotedTo: ["cut-b"], concluded: true, hold: false },
      ],
      archived: [],
    };
    render(<KanbanBoard changes={changes} discussions={discussions} onReorder={vi.fn()} />);
    const col = column("discussions");
    const held = col.querySelector('[data-discussion="held-one"]') as HTMLElement;
    expect(held).toBeTruthy();
    expect(held.closest('[aria-roledescription="sortable"]')).toBeTruthy();
    expect(col.querySelector('[data-discussion="released-one"]')).toBeNull();
  });

  it("change cards mount as sortables with a localized drag label", () => {
    render(<KanbanBoard changes={changes} onReorder={vi.fn()} />);
    const card = screen.getByText("working-y").closest('[aria-roledescription="sortable"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.getAttribute("aria-label")).toContain("working-y");
  });

  it("does not mount change cards as sortables when reorder is unavailable", () => {
    render(<KanbanBoard changes={changes} />);
    expect(document.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  });

  it("shows the provided reorder-unavailable reason without adding a drag handle", () => {
    render(
      <KanbanBoard
        changes={changes}
        reorderUnavailableReason="此 Workspace 目前为唯读状态——无法拖曳调整卡片顺序"
      />,
    );
    expect(screen.getByText(/唯读状态.*无法拖曳调整卡片顺序/)).toBeTruthy();
    expect(document.querySelector('[aria-roledescription="sortable"]')).toBeNull();
  });

  it("pins the pointer activation distance at 8 (click-through lesson)", () => {
    // dnd-kit 可拖曳元素必须设 distance 8，否则单击被拖曳监听吃掉（CLAUDE.md）。
    expect(DRAG_ACTIVATION_DISTANCE).toBe(8);
  });
});

describe("parseTasks", () => {
  it("parses checked and unchecked checkbox lines, ignoring other lines", () => {
    const md = "## Group\n\n- [x] done one\n- [ ] todo two\nsome prose\n- [X] done three\n";
    const tasks = parseTasks(md);
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((t) => t.done)).toHaveLength(2);
    expect(tasks[1]).toEqual({ done: false, text: "todo two" });
  });
});

// spec 需求「看板搜索过滤卡片」的命中呈现（design D7）：子字符串命中高亮、
// 仅模糊命中不高亮、全文命中卡片呈 snippet 行。
describe("命中高亮与 snippet（design D7）", () => {
  const one: ChangeItem[] = [
    { name: "engine-typed-core", status: "in-progress", totalTasks: 2, completedTasks: 0 },
  ];
  const cardEl = () =>
    document.querySelector('[data-change="engine-typed-core"]') as HTMLElement;

  it("子字符串命中于卡名以 mark 高亮命中原文", () => {
    render(<KanbanBoard changes={one} query="engine" onQuery={() => {}} />);
    const mark = cardEl().querySelector("mark");
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("engine");
    // 搜索高亮是「注意这里」的警示层级，不是交互——改琥珀 mark，不占用主色。
    expect(mark!.className).toContain("status-warning");
    expect(mark!.className).not.toContain("primary");
  });

  it("仅模糊命中（无连续子字符串）显卡片但不高亮", () => {
    render(<KanbanBoard changes={one} query="etc" onQuery={() => {}} />);
    expect(cardEl()).toBeTruthy();
    expect(cardEl().querySelector("mark")).toBeNull();
  });

  it("全文命中卡片呈 snippet 行：artifact 名＋裁切前后文＋命中高亮", () => {
    render(
      <KanbanBoard
        changes={one}
        query="dispatch"
        onQuery={() => {}}
        fulltextHits={[
          {
            kind: "change",
            id: "engine-typed-core",
            artifact: "design.md",
            snippet: "…唯一 dispatch 兼容层…",
          },
        ]}
      />,
    );
    const card = cardEl();
    const snippet = card.querySelector("[data-snippet]") as HTMLElement;
    expect(snippet).toBeTruthy();
    expect(within(snippet).getByText(/design\.md/)).toBeTruthy();
    expect(snippet.textContent).toContain("兼容层");
    const mark = snippet.querySelector("mark");
    expect(mark?.textContent).toBe("dispatch");
  });
});

// spec 需求「拖曳封存落点以浮层呈现」的 jsdom 可验部分（design D8＋
// archive-readiness-gating D3）：浮现条件纯函数＋接线经捕捉的 DndContext
// props 驱动；真实拖曳的栏宽零变动与放开行为属真窗口验证。
describe("封存落点浮层（design D8 + archive-readiness-gating D3）", () => {
  // 就绪名单：落点仅于拖曳已就绪变更卡时浮现（fixture 中仅 ready-z 就绪）。
  const readyIds: ReadonlySet<string> = new Set(["ready-z"]);

  it("archiveZoneVisible：已就绪变更卡拖曳才浮现、非就绪与讨论卡不浮现", () => {
    expect(archiveZoneVisible(cardDndId("change", "ready-z"), readyIds)).toBe(true);
    expect(archiveZoneVisible(cardDndId("change", "working-y"), readyIds)).toBe(false);
    expect(archiveZoneVisible(cardDndId("discussion", "collab"), readyIds)).toBe(false);
    expect(archiveZoneVisible("archived", readyIds)).toBe(false);
    expect(archiveZoneVisible(null, readyIds)).toBe(false);
  });

  it("未拖曳时看板不渲染封存落点", () => {
    render(<KanbanBoard changes={changes} />);
    expect(document.querySelector('[data-column="archived"]')).toBeNull();
  });

  const startDrag = (id: string) => act(() => captured.dnd.onDragStart({ active: { id } }));
  const endDrag = (id: string, overId: string | null) =>
    act(() =>
      captured.dnd.onDragEnd({ active: { id }, over: overId ? { id: overId } : null }),
    );

  it("拖曳进行中变更卡不渲染封存落点；已就绪卡渲染", () => {
    render(<KanbanBoard changes={changes} onArchive={vi.fn()} />);
    startDrag(cardDndId("change", "working-y"));
    expect(document.querySelector('[data-column="archived"]')).toBeNull();
    endDrag(cardDndId("change", "working-y"), null);
    startDrag(cardDndId("change", "ready-z"));
    expect(document.querySelector('[data-column="archived"]')).toBeTruthy();
  });

  it("未结论的 promoted 讨论卡在上区可拖排（落点清单与栏分区同判准）", () => {
    // conclusion-gated-discussion-archive R1：concluded === false 的 promoted 卡
    // 进上区全卡与 SortableContext，落点解析的栏清单必须用同一分区判准——
    // 否则拖它或落在它上面的手势整次被吞（resolveCardDrop 回 null、零写入）。
    const onReorder = vi.fn();
    const dnd: DiscussionLists = {
      active: [
        { slug: "aa-open", topic: "开放", status: "open", rounds: 1, created: "2026-07-01", promotedTo: [] },
        {
          slug: "mid-flight",
          topic: "未结论转出",
          status: "promoted",
          rounds: 2,
          created: "2026-07-02",
          promotedTo: ["cut-a"],
          concluded: false,
        },
      ],
      archived: [],
    };
    render(<KanbanBoard changes={changes} discussions={dnd} onReorder={onReorder} />);
    startDrag(cardDndId("discussion", "mid-flight"));
    endDrag(cardDndId("discussion", "mid-flight"), cardDndId("discussion", "aa-open"));
    expect(onReorder).toHaveBeenCalledWith("discussion", "mid-flight", null, "aa-open");
  });

  it("dragEnd 于 over=archived 且卡非就绪时不触发 onArchive；就绪卡照常", () => {
    const onArchive = vi.fn();
    render(<KanbanBoard changes={changes} onArchive={onArchive} />);
    // 落点不可见时理论上不会 over，此守门防快速手势与测试路径（design D3）。
    startDrag(cardDndId("change", "working-y"));
    endDrag(cardDndId("change", "working-y"), "archived");
    expect(onArchive).not.toHaveBeenCalled();
    startDrag(cardDndId("change", "ready-z"));
    endDrag(cardDndId("change", "ready-z"), "archived");
    expect(onArchive).toHaveBeenCalledWith("ready-z");
  });

  // desktop-board-reskin design D3：落点浮层只用 theme token（主色虚线框＋主色淡底），
  // 不再半透明背景＋backdrop 模糊；语意（仅就绪卡拖曳时浮现）不变。
  it("拖曳已就绪卡时落点浮层为主色虚线框与淡底、无 backdrop 模糊", () => {
    render(<KanbanBoard changes={changes} onArchive={vi.fn()} />);
    startDrag(cardDndId("change", "ready-z"));
    const zone = document.querySelector('[data-column="archived"]') as HTMLElement;
    const cls = zone.className.split(/\s+/);
    expect(cls).toContain("rounded-2xl");
    expect(cls).toContain("border-dashed");
    expect(cls).toContain("border-primary/60");
    expect(cls).toContain("bg-primary/10");
    expect(cls).toContain("text-primary");
    expect(cls.some((c) => c.startsWith("backdrop-"))).toBe(false);
    expect(cls.some((c) => c.startsWith("bg-background"))).toBe(false);
  });

  it("拖曳中的浮动卡带阴影（浮层）；放开后浮动卡消失（spec「卡片无阴影而浮动卡有阴影」）", () => {
    captured.overlayChildren = true;
    try {
      render(<KanbanBoard changes={changes} onReorder={vi.fn()} />);
      startDrag(cardDndId("change", "ready-z"));
      const overlay = document.querySelector("[data-drag-overlay]") as HTMLElement;
      const floating = overlay.firstElementChild as HTMLElement;
      expect(floating.className.split(/\s+/)).toEqual(expect.arrayContaining(["rounded-xl", "shadow-lg"]));
      expect(floating.querySelector('[data-change="ready-z"]')).toBeTruthy();
      endDrag(cardDndId("change", "ready-z"), null);
      expect(overlay.childElementCount).toBe(0);
    } finally {
      captured.overlayChildren = false;
    }
  });

  it("静置的变更卡与其 sortable 包装层都无阴影（阴影只在拖曳浮动卡）", () => {
    render(<KanbanBoard changes={changes} onReorder={vi.fn()} />);
    const card = document.querySelector('[data-change="ready-z"]') as HTMLElement;
    expect(card.className.split(/\s+/).some((c) => c.includes("shadow"))).toBe(false);
    expect(card.parentElement!.className).not.toContain("shadow");
  });
});

// spec desktop-app「拖排时不合法落点灰化」（add-change-plan-desktop design D3 前端层）：
// 纯函数只看声明依赖（dependsOn）、不看重叠；接线在拖动中标记不合法目标，放开于
// 其上不触发写回。
describe("拖排时不合法落点灰化", () => {
  const col: ColumnCards = { kind: "change", ids: ["a", "b", "c"] };
  const deps = (m: Record<string, string[]>) => new Map(Object.entries(m));

  it("invalidDropTargets：拖依赖者 c 时，前置 a 及其上方为不合法落点，b 正常", () => {
    expect(invalidDropTargets(col, deps({ c: ["a"] }), "c")).toEqual(new Set(["a"]));
    // 前置上方的卡也不合法：落在 p 之上仍排到前置之前。
    const wide: ColumnCards = { kind: "change", ids: ["p", "q", "b", "x"] };
    expect(invalidDropTargets(wide, deps({ x: ["q"] }), "x")).toEqual(new Set(["p", "q"]));
  });

  it("invalidDropTargets：拖前置 a 时，依赖者 c 及其下方为不合法落点，b 正常", () => {
    expect(invalidDropTargets(col, deps({ c: ["a"] }), "a")).toEqual(new Set(["c"]));
    const wide: ColumnCards = { kind: "change", ids: ["x", "b", "d", "e"] };
    expect(invalidDropTargets(wide, deps({ d: ["x"] }), "x")).toEqual(new Set(["d", "e"]));
  });

  it("invalidDropTargets：重叠伙伴（无声明依赖）与缺字段时没有不合法落点", () => {
    expect(invalidDropTargets(col, deps({}), "b")).toEqual(new Set());
    expect(invalidDropTargets(col, new Map(), "a")).toEqual(new Set());
    // 不在栏内的卡（跨栏拖曳）没有落点可标。
    expect(invalidDropTargets(col, deps({ c: ["a"] }), "zzz")).toEqual(new Set());
  });

  // 同栏三卡（皆进行中）：c 声明前置 a；a 与 b 只因重叠而依序。
  const planned: ChangeItem[] = [
    { name: "a", status: "in-progress", totalTasks: 4, completedTasks: 1, wave: 1, blockedBy: [], dependsOn: [], overlaps: [{ change: "b", capabilities: ["cap"] }] },
    { name: "b", status: "in-progress", totalTasks: 4, completedTasks: 1, wave: 2, blockedBy: ["a"], dependsOn: [], overlaps: [{ change: "a", capabilities: ["cap"] }] },
    { name: "c", status: "in-progress", totalTasks: 4, completedTasks: 1, wave: 2, blockedBy: ["a"], dependsOn: ["a"], overlaps: [] },
  ];
  const startDrag = (id: string) => act(() => captured.dnd.onDragStart({ active: { id } }));
  const endDrag = (id: string, overId: string | null) =>
    act(() => captured.dnd.onDragEnd({ active: { id }, over: overId ? { id: overId } : null }));
  const sortable = (name: string) =>
    screen.getByText(name).closest('[aria-roledescription="sortable"]') as HTMLElement;

  it("拖动依赖者时前置带 data-drop-invalid 且降透明度，放开于其上不写回", () => {
    const onReorder = vi.fn();
    render(<KanbanBoard changes={planned} onReorder={onReorder} />);
    expect(sortable("a").getAttribute("data-drop-invalid")).toBeNull();
    startDrag(cardDndId("change", "c"));
    expect(sortable("a").getAttribute("data-drop-invalid")).toBe("true");
    expect(sortable("a").style.opacity).not.toBe("");
    expect(sortable("b").getAttribute("data-drop-invalid")).toBeNull();
    endDrag(cardDndId("change", "c"), cardDndId("change", "a"));
    expect(onReorder).not.toHaveBeenCalled();
    // 放开后标记清除。
    expect(sortable("a").getAttribute("data-drop-invalid")).toBeNull();
  });

  it("拖动前置时依赖者灰化；放开于中间卡照常写回（a 落在 b 之后、c 之前）", () => {
    const onReorder = vi.fn();
    render(<KanbanBoard changes={planned} onReorder={onReorder} />);
    startDrag(cardDndId("change", "a"));
    expect(sortable("c").getAttribute("data-drop-invalid")).toBe("true");
    expect(sortable("b").getAttribute("data-drop-invalid")).toBeNull();
    endDrag(cardDndId("change", "a"), cardDndId("change", "b"));
    expect(onReorder).toHaveBeenCalledWith("change", "a", "b", "c");
  });

  it("重叠伙伴不灰化，放开于其上触发写回", () => {
    const onReorder = vi.fn();
    render(<KanbanBoard changes={planned} onReorder={onReorder} />);
    startDrag(cardDndId("change", "b"));
    expect(sortable("a").getAttribute("data-drop-invalid")).toBeNull();
    endDrag(cardDndId("change", "b"), cardDndId("change", "a"));
    expect(onReorder).toHaveBeenCalledWith("change", "b", null, "a");
  });

  it("搜索过滤隐藏前置时仍以同栏全序判定：前置上方的可见卡灰化、放开不写回（审查 Round 1）", () => {
    // 同栏全序 beta-two、alpha-one、gamma-two（gamma 声明前置 alpha）；query「two」藏起
    // alpha。拖 gamma 时 alpha 及其上方的 beta 都是不合法落点——若只看可见栏，beta 会
    // 漏标、放开后才被引擎退回。
    const row = { status: "in-progress", totalTasks: 4, completedTasks: 1, overlaps: [] };
    const filtered: ChangeItem[] = [
      { name: "beta-two", ...row, wave: 1, blockedBy: [], dependsOn: [] },
      { name: "alpha-one", ...row, wave: 1, blockedBy: [], dependsOn: [] },
      { name: "gamma-two", ...row, wave: 2, blockedBy: ["alpha-one"], dependsOn: ["alpha-one"] },
    ];
    const onReorder = vi.fn();
    render(<KanbanBoard changes={filtered} onReorder={onReorder} query="two" onQuery={vi.fn()} />);
    const sortableOf = (name: string) =>
      (document.querySelector(`[data-change="${name}"]`) as HTMLElement).closest(
        '[aria-roledescription="sortable"]',
      ) as HTMLElement;
    expect(document.querySelector('[data-change="alpha-one"]')).toBeNull();
    startDrag(cardDndId("change", "gamma-two"));
    expect(sortableOf("beta-two").getAttribute("data-drop-invalid")).toBe("true");
    endDrag(cardDndId("change", "gamma-two"), cardDndId("change", "beta-two"));
    expect(onReorder).not.toHaveBeenCalled();
  });
});

// spec desktop-app「依赖成环时看板提示」（add-change-plan-desktop design D5）：planError
// 非 null 时字段上方一行提示（tw 前缀「依赖成环：」＋原文），null 时不渲染。
describe("依赖成环时看板提示", () => {
  it("planError 非 null → 字段上方出现「依赖成环：」＋消息原文，拖排照常挂载", () => {
    render(
      <KanbanBoard changes={changes} onReorder={vi.fn()} planError="dependency cycle: a -> b -> a" />,
    );
    const note = screen.getByText("依赖成环：dependency cycle: a -> b -> a");
    expect(note.getAttribute("role")).toBe("note");
    expect(document.querySelector('[aria-roledescription="sortable"]')).toBeTruthy();
  });

  it("planError 非 null 时没有不合法落点（即使项目仍带 dependsOn）", () => {
    const onReorder = vi.fn();
    const withDeps: ChangeItem[] = [
      { name: "a", status: "in-progress", totalTasks: 4, completedTasks: 1 },
      { name: "c", status: "in-progress", totalTasks: 4, completedTasks: 1, dependsOn: ["a"] },
    ];
    render(<KanbanBoard changes={withDeps} onReorder={onReorder} planError="dependency cycle: a -> c -> a" />);
    act(() => captured.dnd.onDragStart({ active: { id: cardDndId("change", "c") } }));
    const a = screen.getByText("a").closest('[aria-roledescription="sortable"]') as HTMLElement;
    expect(a.getAttribute("data-drop-invalid")).toBeNull();
    act(() =>
      captured.dnd.onDragEnd({ active: { id: cardDndId("change", "c") }, over: { id: cardDndId("change", "a") } }),
    );
    expect(onReorder).toHaveBeenCalledWith("change", "c", null, "a");
  });

  it("planError 为 null／缺席 → 不出现提示列", () => {
    render(<KanbanBoard changes={changes} planError={null} />);
    expect(screen.queryByText(/依赖成环/)).toBeNull();
  });

  it("en 前缀为 Dependency cycle:", () => {
    rtlRender(
      <I18nProvider locale="en">
        <KanbanBoard changes={changes} planError="dependency cycle: a -> b -> a" />
      </I18nProvider>,
    );
    expect(screen.getByText("Dependency cycle: dependency cycle: a -> b -> a")).toBeTruthy();
  });
});

// spec「看板卡片统一解剖学」的变更卡（board-card-anatomy design D1/D2）：
// 等宽标题单行截断、省略号收尾、拷贝钮行内尾随（钉住 desktop-ux-polish 落地的位置
// 不回退）、whyExcerpt 描述列、变更卡无状态 chip（所在栏即阶段）。
describe("看板卡片统一解剖学（变更卡）", () => {
  const anatomyChanges: ChangeItem[] = [
    {
      name: "with-desc",
      status: "in-progress",
      totalTasks: 21,
      completedTasks: 5,
      createdBy: "Momo <m@example.com>",
      whyExcerpt: "看板卡片各自演化、无共用骨架。",
    },
    { name: "no-desc", status: "in-progress", totalTasks: 4, completedTasks: 1, whyExcerpt: null },
  ];

  it("标题等宽字体、单行不折行、拷贝钮与标题同列尾随", () => {
    render(<KanbanBoard changes={anatomyChanges} />);
    const title = screen.getByText("with-desc");
    expect(title.className).toContain("font-mono");
    // 名称恒单行：过长就地截断、以省略号收尾（truncate 一并带入 nowrap），
    // 不折到次行把拷贝钮带下去。
    expect(title.className).toContain("truncate");
    // 行内尾随：拷贝钮与标题同在名称列容器内，不是被推到卡片右缘的兄弟元素。
    const nameRow = title.parentElement as HTMLElement;
    expect(within(nameRow).getByLabelText("拷贝名称")).toBeTruthy();
  });

  it("whyExcerpt 渲染为一行截断描述列，null 时整列缺席", () => {
    render(<KanbanBoard changes={anatomyChanges} />);
    const withDesc = screen.getByText("with-desc").closest("[data-change]") as HTMLElement;
    const desc = within(withDesc).getByText("看板卡片各自演化、无共用骨架。");
    expect(desc.className).toContain("truncate");
    const noDesc = screen.getByText("no-desc").closest("[data-change]") as HTMLElement;
    expect(noDesc.querySelector("[data-desc]")).toBeNull();
  });

  it("变更卡无状态 chip（所在栏即阶段）", () => {
    render(<KanbanBoard changes={anatomyChanges} />);
    const card = screen.getByText("with-desc").closest("[data-change]") as HTMLElement;
    expect(within(card).queryByText(/提案中|进行中|已就绪/)).toBeNull();
  });
});

// spec「看板首访以 skeleton 占位」（design D2）：首访 workspace 的整批加载未完成前，
// 空清单与「真的没东西」无法区分——以占位卡明示「有东西正在载」。
describe("看板首访 skeleton", () => {
  const emptyDiscussions: DiscussionLists = { active: [], archived: [] };

  it("加载中 → 四栏栏名照常，卡片区为占位卡", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loading />);
    expect(screen.getByText("提案中")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();
    for (const id of ["discussions", "proposed", "in-progress", "ready"]) {
      expect(column(id).querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    }
  });

  it("加载中 → 不显示讨论栏空态文案（加载中不冒充空）", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loading />);
    expect(screen.queryByText("尚无讨论")).toBeNull();
  });

  it("加载中 → 不显示计数徽章（不谎报 0 笔）", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loading />);
    expect(document.querySelector('[data-testid="column-count"]')).toBeNull();
  });

  it("加载完成且真的没东西 → 既有空态照旧，无占位卡", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} />);
    expect(screen.getByText("尚无讨论")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="column-count"]').length).toBeGreaterThan(0);
  });

  it("加载完成且有数据 → 显卡片，无占位卡", () => {
    render(<KanbanBoard changes={changes} discussions={emptyDiscussions} />);
    expect(within(column("ready")).getByText("ready-z")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("加载中 → 不渲染任何变更卡（旧数据不与占位卡并存）", () => {
    render(<KanbanBoard changes={changes} discussions={emptyDiscussions} loading />);
    expect(document.querySelector("[data-change]")).toBeNull();
  });
});

// spec「首访加载失败终态呈现」：读不到 ≠ 确认是空的——失败要与真空 workspace
// 可区分，且不得停在 skeleton（加载已经结束了）。
describe("看板首访加载失败终态", () => {
  const emptyDiscussions: DiscussionLists = { active: [], archived: [] };

  it("加载失败 → 四栏卡片区显示失败提示，栏名照常", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loadFailed />);
    expect(screen.getByText("提案中")).toBeTruthy();
    for (const id of ["discussions", "proposed", "in-progress", "ready"]) {
      expect(within(column(id)).getByTestId("column-load-failed")).toBeTruthy();
    }
  });

  it("加载失败 → 不显示空态文案、不留占位卡", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loadFailed />);
    expect(screen.queryByText("尚无讨论")).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("加载失败 → 不显示计数徽章（不谎报 0 笔）", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loadFailed />);
    expect(document.querySelector('[data-testid="column-count"]')).toBeNull();
  });

  it("加载中优先于失败提示（重试在途时不留旧提示）", () => {
    render(<KanbanBoard changes={[]} discussions={emptyDiscussions} loading loadFailed />);
    expect(document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid="column-load-failed"]')).toBeNull();
  });

  it("成功加载后 → 失败提示消失，回到既有呈现", () => {
    render(<KanbanBoard changes={changes} discussions={emptyDiscussions} />);
    expect(document.querySelector('[data-testid="column-load-failed"]')).toBeNull();
    expect(within(column("ready")).getByText("ready-z")).toBeTruthy();
  });
});

// spec「详情页的导览与返回」（design D2）：看板回报目前呈现顺序（含搜索与筛选），
// 供详情页 ‹ n／m › 与 ⌥↑／⌥↓ 切换——变更依栏序再栏内序；讨论为上区全卡依序、
// 其后接栏底「已转出」细列（不论收合）。
describe("KanbanBoard 呈现顺序回报", () => {
  const orderDiscussions: DiscussionLists = {
    active: [
      { slug: "promoted-done", topic: "已转出", status: "promoted", rounds: 3, created: "2026-07-01", promotedTo: ["x"], concluded: true },
      { slug: "talk-a", topic: "A", status: "open", rounds: 1, created: "2026-07-02", promotedTo: [] },
      { slug: "talk-b", topic: "B", status: "concluded", rounds: 2, created: "2026-07-03", promotedTo: [] },
    ],
    archived: [],
  };

  it("初次渲染回报三栏顺序与讨论顺序（上区卡后接已转出细列）", () => {
    const onVisibleOrderChange = vi.fn();
    render(
      <KanbanBoard changes={changes} discussions={orderDiscussions} onVisibleOrderChange={onVisibleOrderChange} />,
    );
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith({
      changes: ["proposing-x", "working-y", "progressed-w", "ready-z"],
      discussions: ["talk-a", "talk-b", "promoted-done"],
    });
  });

  it("输入搜索后回报过滤后顺序；顺序不变时不重复回报", () => {
    const onVisibleOrderChange = vi.fn();
    const { rerender } = render(
      <KanbanBoard
        changes={changes}
        discussions={orderDiscussions}
        query=""
        onQuery={vi.fn()}
        onVisibleOrderChange={onVisibleOrderChange}
      />,
    );
    const calls = onVisibleOrderChange.mock.calls.length;
    rerender(
      <KanbanBoard
        changes={changes}
        discussions={orderDiscussions}
        query=""
        onQuery={vi.fn()}
        onVisibleOrderChange={onVisibleOrderChange}
      />,
    );
    expect(onVisibleOrderChange.mock.calls.length).toBe(calls);
    rerender(
      <KanbanBoard
        changes={changes}
        discussions={orderDiscussions}
        query="ing"
        onQuery={vi.fn()}
        onVisibleOrderChange={onVisibleOrderChange}
      />,
    );
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith({
      changes: ["proposing-x", "working-y"],
      discussions: [],
    });
  });

  it("未传 discussions 时讨论串行为空数组", () => {
    const onVisibleOrderChange = vi.fn();
    render(<KanbanBoard changes={changes} onVisibleOrderChange={onVisibleOrderChange} />);
    expect(onVisibleOrderChange).toHaveBeenLastCalledWith({
      changes: ["proposing-x", "working-y", "progressed-w", "ready-z"],
      discussions: [],
    });
  });
});

// spec desktop-roadmap「看板页的路线图查看」：卡片查看的页眉放「看板｜路线图」切换。切换放在页眉
// 最右端（搜索列与筛选钮之后）——路线图的页眉只有切换，两种查看的切换才会停在同一个位置。
describe("KanbanBoard 页眉的查看切换", () => {
  it("viewSwitch 是页眉动作区的最后一个，排在搜索列与筛选钮之后", () => {
    render(
      <KanbanBoard
        changes={changes}
        title="变更"
        query=""
        onQuery={vi.fn()}
        viewSwitch={<span data-testid="view-switch" />}
      />,
    );
    const header = document.querySelector("[data-page-header]") as HTMLElement;
    const viewSwitch = within(header).getByTestId("view-switch");
    expect(viewSwitch.parentElement!.lastElementChild).toBe(viewSwitch);
    const search = within(header).getByPlaceholderText("搜索看板卡片…");
    const filters = within(header).getByRole("button", { name: "筛选" });
    for (const before of [search, filters]) {
      expect(before.compareDocumentPosition(viewSwitch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("没有页标题时切换与搜索列照样出现", () => {
    render(<KanbanBoard changes={changes} query="" onQuery={vi.fn()} viewSwitch={<span data-testid="view-switch" />} />);
    expect(screen.getByTestId("view-switch")).toBeTruthy();
    expect(screen.getByPlaceholderText("搜索看板卡片…")).toBeTruthy();
  });
});

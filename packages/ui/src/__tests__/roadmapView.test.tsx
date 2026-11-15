// spec desktop-roadmap「路线图依波次排列变更」「路线图列出尚未转出的刀」「路线图的成环与空状态」
// 「路线图画出依赖线并亮起路线」：版面与交互；线的座标由手动在 dev 窗口验收（jsdom 没有版面）。
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { BoardViewSwitch, RoadmapView } from "../components/RoadmapView";
import type { ChangeItem, DiscussionLists, UnpromotedCutItem } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

/** 范式空白后的文本内容。 */
function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function station(name: string): HTMLElement {
  return document.querySelector(`[data-station="${name}"]`) as HTMLElement;
}

function item(
  name: string,
  wave: number | undefined,
  tasks: [done: number, total: number],
  dependsOn: string[] = [],
  blockedBy: string[] = [],
): ChangeItem {
  const [completedTasks, totalTasks] = tasks;
  const base: ChangeItem = { name, status: "x", totalTasks, completedTasks };
  return wave === undefined ? base : { ...base, wave, dependsOn, blockedBy };
}

// Scenario「两波与下一个」：清单顺序即 plan 的配置序。
const TWO_WAVES: ChangeItem[] = [
  item("add-a", 1, [0, 4]),
  item("add-c", 1, [2, 5]),
  item("add-b", 2, [0, 3], ["add-a"], ["add-a"]),
];

const PANEL_CUT: UnpromotedCutItem = {
  discussion: "herdr-specseal-panel",
  cut: "cut 4",
  title: "讨论详情页改用引擎的刀",
  changes: ["discussion-cuts-from-engine"],
  unpromoted: ["discussion-cuts-from-engine"],
};

const PANEL_DISCUSSIONS: DiscussionLists = {
  active: [
    {
      slug: "herdr-specseal-panel",
      topic: "panel",
      status: "concluded",
      rounds: 3,
      created: "2026-11-01",
      promotedTo: ["desktop-deep-link"],
    },
  ],
  archived: [],
};

interface ViewProps {
  changes?: ChangeItem[];
  next?: string | null;
  unpromotedCuts?: UnpromotedCutItem[];
  planError?: string | null;
  discussions?: DiscussionLists;
  onOpenChange?: (name: string) => void;
  onOpenDiscussion?: (slug: string) => void;
  loading?: boolean;
  loadFailed?: boolean;
}

function view({
  changes = TWO_WAVES,
  next = "add-a",
  unpromotedCuts = [],
  planError = null,
  discussions = { active: [], archived: [] },
  onOpenChange = vi.fn(),
  onOpenDiscussion = vi.fn(),
  loading = false,
  loadFailed = false,
}: ViewProps = {}) {
  return render(
    <RoadmapView
      title="变更"
      description="说明"
      changes={changes}
      next={next}
      unpromotedCuts={unpromotedCuts}
      planError={planError}
      discussions={discussions}
      onOpenChange={onOpenChange}
      onOpenDiscussion={onOpenDiscussion}
      viewSwitch={<span data-testid="view-switch" />}
      loading={loading}
      loadFailed={loadFailed}
    />,
  );
}

describe("RoadmapView 波次栏与站（需求「路线图依波次排列变更」）", () => {
  it("表的每一波一栏，栏头写第 N 波、变更数与并行／等待提示；每个变更一列，圆点落在所属波次栏（Scenario「两波与下一个」）", () => {
    view();
    const heads = [...document.querySelectorAll("[data-roadmap-wave]")];
    expect(heads.map((w) => w.getAttribute("data-roadmap-wave"))).toEqual(["1", "2"]);
    expect(text(heads[0].querySelector("[data-wave-title]"))).toBe("第 1 波");
    expect(text(heads[0].querySelector("[data-wave-note]"))).toBe("2 · 可以并行");
    expect(text(heads[1].querySelector("[data-wave-title]"))).toBe("第 2 波");
    expect(text(heads[1].querySelector("[data-wave-note]"))).toBe("1 · 等第 1 波");
    const rows = [...document.querySelectorAll("[data-station]")].map((s) => s.getAttribute("data-station"));
    expect(rows).toEqual(["add-a", "add-c", "add-b"]);
    const nodeWave = (name: string) =>
      station(name).querySelector("[data-station-node]")!.closest("[data-wave-cell]")!.getAttribute("data-wave-cell");
    expect(nodeWave("add-a")).toBe("1");
    expect(nodeWave("add-c")).toBe("1");
    expect(nodeWave("add-b")).toBe("2");
    // 每列在每个波次栏各一格，圆点以外的格留白。
    expect(station("add-b").querySelectorAll("[data-wave-cell]")).toHaveLength(2);
    expect(station("add-b").querySelector('[data-wave-cell="1"]')!.children).toHaveLength(0);
  });

  it("页眉带页标题与宿主给的查看切换", () => {
    view();
    expect(screen.getByRole("heading", { name: "变更" })).toBeTruthy();
    expect(screen.getByTestId("view-switch")).toBeTruthy();
  });

  // Example「站的阶段文本」：站是一颗圆点，次行写「完成数/总数 · 状态」。
  it("站的圆点与次行依阶段：外框 n/m、进度圆圈 n/m、实心已就绪、被挡的站虚线圈、变淡并写出等谁", () => {
    view({
      changes: [
        item("add-a", 1, [0, 4]),
        item("add-c", 1, [2, 5]),
        item("add-d", 1, [6, 6]),
        item("add-b", 2, [0, 3], ["add-a"], ["add-a"]),
      ],
      next: null,
    });
    const status = (name: string) => text(station(name).querySelector("[data-station-status]"));
    const node = (name: string) => station(name).querySelector("[data-station-node]")!.getAttribute("data-station-node");
    expect(station("add-a").getAttribute("data-stage")).toBe("proposed");
    expect(node("add-a")).toBe("proposed");
    expect(status("add-a")).toBe("0/4 · 提案中");
    expect(station("add-c").getAttribute("data-stage")).toBe("in-progress");
    expect(node("add-c")).toBe("in-progress");
    expect(station("add-c").querySelector("[data-progress-ring]")).not.toBeNull();
    expect(status("add-c")).toBe("2/5 · 进行中");
    expect(station("add-d").getAttribute("data-stage")).toBe("ready");
    expect(node("add-d")).toBe("ready");
    expect(status("add-d")).toBe("6/6 · 已就绪");
    expect(node("add-b")).toBe("waiting");
    expect(status("add-b")).toBe("0/3 · 等待：add-a");
    expect(station("add-b").hasAttribute("data-blocked")).toBe(true);
    expect(text(station("add-b").querySelector("[data-station-blocked]"))).toBe("等待：add-a");
    for (const name of ["add-a", "add-c", "add-d"]) {
      expect(station(name).hasAttribute("data-blocked"), name).toBe(false);
      expect(station(name).querySelector("[data-progress-ring]") !== null, name).toBe(name === "add-c");
    }
  });

  it("已就绪圆点的勾以卡片底色画在 stage-ready 实心圆上（不借主色底的前景色）", () => {
    view({ changes: [item("add-d", 1, [6, 6])], next: null });
    const check = station("add-d").querySelector("[data-station-node] path")!;
    expect(check.getAttribute("class")).toContain("stroke-card");
    expect(check.getAttribute("class")).not.toContain("primary");
  });

  it("名称等于 next 的站带「下一个」签与光晕；next 为 null 时没有站带签", () => {
    const { unmount } = view();
    expect(text(station("add-a").querySelector("[data-station-status]"))).toBe("0/4 · 下一个");
    expect(text(station("add-a").querySelector("[data-next-badge]"))).toBe("下一个");
    expect(document.querySelectorAll("[data-next-badge]")).toHaveLength(1);
    expect(station("add-a").querySelector("[data-node-halo]")).not.toBeNull();
    expect(document.querySelectorAll("[data-node-halo]")).toHaveLength(1);
    unmount();
    view({ next: null });
    expect(document.querySelectorAll("[data-next-badge]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-node-halo]")).toHaveLength(0);
  });

  it("路线图下方有图例，说明每种圆点、尚未转出的方块与线", () => {
    view();
    const legend = document.querySelector("[data-roadmap-legend]")!;
    expect(legend.getAttribute("aria-label")).toBe("图例");
    expect([...legend.querySelectorAll("[data-legend-item]")].map(text)).toEqual([
      "已就绪",
      "进行中（圈＝任务进度）",
      "提案中",
      "下一个",
      "等待前置变更",
      "尚未转出",
      "线：前置 → 依赖者",
    ]);
  });

  it("只有尚未转出的刀时照样有表与图例", () => {
    view({ changes: [], next: null, unpromotedCuts: [PANEL_CUT] });
    expect(document.querySelector("[data-roadmap-table]")).not.toBeNull();
    expect(document.querySelector("[data-roadmap-legend]")).not.toBeNull();
  });

  it("成环、空状态与加载中没有图例", () => {
    // 成环时引擎不排波次：清单项都没有 wave。
    const cycle = view({
      changes: [item("add-a", undefined, [0, 1], ["add-b"]), item("add-b", undefined, [0, 1], ["add-a"])],
      next: null,
      planError: "dependency cycle: add-a -> add-b -> add-a",
    });
    expect(document.querySelector("[data-roadmap-legend]")).toBeNull();
    cycle.unmount();
    const empty = view({ changes: [] });
    expect(document.querySelector("[data-roadmap-legend]")).toBeNull();
    empty.unmount();
    view({ loading: true });
    expect(document.querySelector("[data-roadmap-legend]")).toBeNull();
  });

  it("点站与聚焦后按 Enter 都以变更名调用 onOpenChange", async () => {
    const onOpenChange = vi.fn();
    view({ onOpenChange });
    fireEvent.click(station("add-b"));
    expect(onOpenChange).toHaveBeenLastCalledWith("add-b");
    station("add-c").focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenChange).toHaveBeenLastCalledWith("add-c");
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("没有波次的变更不成为站，页眉下方一行说明（Scenario「无法调度的变更不成为站」）", () => {
    view({
      changes: [item("good-a", 1, [0, 1]), item("broken-meta", undefined, [0, 1]), item("good-b", 1, [0, 1])],
      next: null,
    });
    expect(document.querySelectorAll("[data-station]")).toHaveLength(2);
    expect(station("broken-meta")).toBeNull();
    expect(text(document.querySelector("[data-roadmap-unplaced]"))).toBe("1 个变更无法调度，只在看板显示");
  });

  it("每个变更都排得到时没有无法调度的说明", () => {
    view();
    expect(document.querySelector("[data-roadmap-unplaced]")).toBeNull();
  });
});

describe("RoadmapView 尚未转出栏（需求「路线图列出尚未转出的刀」）", () => {
  const writeText = vi.fn<(v: string) => Promise<void>>();
  afterEach(() => {
    vi.unstubAllGlobals();
    writeText.mockReset();
  });

  it("表最右一栏是尚未转出，每把刀一列排在站的列之下（Scenario「列出一把尚未转出的刀」）", async () => {
    writeText.mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    view({ unpromotedCuts: [PANEL_CUT], discussions: PANEL_DISCUSSIONS });
    const head = document.querySelector("[data-roadmap-cuts]")!;
    expect(head.parentElement!.lastElementChild).toBe(head);
    expect(text(head.querySelector("[data-cuts-title]"))).toBe("尚未转出");
    expect(text(head.querySelector("[data-cuts-count]"))).toBe("1 刀");
    const rows = [...document.querySelectorAll("[data-station], [data-roadmap-cut]")];
    const cut = rows[rows.length - 1] as HTMLElement;
    expect(cut.hasAttribute("data-roadmap-cut")).toBe(true);
    const name = cut.querySelector("[data-cut-unpromoted]")!;
    expect(text(name)).toBe("discussion-cuts-from-engine");
    expect(name.getAttribute("title")).toBe("讨论详情页改用引擎的刀");
    expect(text(cut.querySelector("[data-cut-head]"))).toBe("herdr-specseal-panel · cut 4");
    // 波次栏留白，虚线方块在尚未转出栏。
    const waveCells = [...cut.querySelectorAll("[data-wave-cell]")];
    expect(waveCells).toHaveLength(2);
    expect(waveCells.every((c) => c.children.length === 0)).toBe(true);
    expect(cut.querySelector("[data-cut-cell] [data-cut-marker]")).not.toBeNull();
    // 转出指令以讨论详情页同款的指令签写出，签上的钮拷贝它。
    const chip = cut.querySelector("[data-command-chip]")!;
    expect(text(chip)).toBe("/specseal-propose --from-discussion herdr-specseal-panel");
    fireEvent.click(within(chip as HTMLElement).getByRole("button", { name: "拷贝指令" }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("/specseal-propose --from-discussion herdr-specseal-panel");
  });

  it("刀的列顺序与 unpromotedCuts 相同；范围句为空字符串时没有提示", () => {
    const second: UnpromotedCutItem = { ...PANEL_CUT, discussion: "other-talk", cut: "cut 2", title: "" };
    view({ unpromotedCuts: [PANEL_CUT, second] });
    expect(text(document.querySelector("[data-cuts-count]"))).toBe("2 刀");
    const cuts = [...document.querySelectorAll("[data-roadmap-cut]")];
    expect(cuts.map((c) => text(c.querySelector("[data-cut-head]")))).toEqual([
      "herdr-specseal-panel · cut 4",
      "other-talk · cut 2",
    ]);
    expect(cuts[1].querySelector("[data-cut-unpromoted]")!.hasAttribute("title")).toBe(false);
  });

  it("讨论 slug 在讨论清单内时可点并开该讨论（Scenario「点讨论名称开讨论详情」）", () => {
    const onOpenDiscussion = vi.fn();
    view({ unpromotedCuts: [PANEL_CUT], discussions: PANEL_DISCUSSIONS, onOpenDiscussion });
    fireEvent.click(screen.getByRole("button", { name: "herdr-specseal-panel" }));
    expect(onOpenDiscussion).toHaveBeenCalledWith("herdr-specseal-panel");
  });

  it("讨论 slug 不在讨论清单内时是不可点的文本", () => {
    view({ unpromotedCuts: [PANEL_CUT] });
    expect(screen.queryByRole("button", { name: "herdr-specseal-panel" })).toBeNull();
    expect(text(document.querySelector("[data-cut-head]"))).toBe("herdr-specseal-panel · cut 4");
  });

  it("unpromotedCuts 为空时没有这一栏与刀的列（Scenario「全部刀都已转出时没有这一栏」）", () => {
    view();
    expect(document.querySelector("[data-roadmap-cuts]")).toBeNull();
    expect(document.querySelector("[data-roadmap-cut]")).toBeNull();
    expect(station("add-a").querySelector("[data-cut-cell]")).toBeNull();
  });
});

describe("RoadmapView 成环、空状态与加载中（需求「路线图的成环与空状态」）", () => {
  it("planError 非空时没有波次栏与线，显示成环提示与引擎消息（Scenario「依赖成环」）", () => {
    view({
      changes: [item("add-a", undefined, [0, 1], ["add-b"]), item("add-b", undefined, [0, 1], ["add-a"])],
      next: null,
      planError: "dependency cycle: add-a -> add-b -> add-a",
    });
    expect(document.querySelector("[data-roadmap-table]")).toBeNull();
    expect(document.querySelector("[data-roadmap-edge]")).toBeNull();
    expect(text(screen.getByRole("note"))).toBe("依赖成环：dependency cycle: add-a -> add-b -> add-a");
    expect(document.querySelector("[data-roadmap-unplaced]")).toBeNull();
    expect(screen.queryByText("没有进行中的变更")).toBeNull();
  });

  it("没有站也没有刀时显示「没有进行中的变更」（Scenario「没有进行中的变更」）", () => {
    view({ changes: [], next: null });
    expect(screen.getByText("没有进行中的变更")).toBeTruthy();
    expect(document.querySelector("[data-roadmap-wave]")).toBeNull();
  });

  it("只有尚未转出的刀时不显示空状态", () => {
    view({ changes: [], next: null, unpromotedCuts: [PANEL_CUT] });
    expect(screen.queryByText("没有进行中的变更")).toBeNull();
    expect(document.querySelector("[data-roadmap-cuts]")).not.toBeNull();
  });

  it("全部变更都无法调度时只留页眉下方的说明，不画表、不显示空状态（Scenario「全部变更都无法调度」）", () => {
    view({ changes: [item("add-a", undefined, [0, 1]), item("add-b", undefined, [0, 2])], next: null });
    expect(text(document.querySelector("[data-roadmap-unplaced]"))).toBe("2 个变更无法调度，只在看板显示");
    expect(screen.queryByText("没有进行中的变更")).toBeNull();
    expect(document.querySelector("[data-roadmap-table]")).toBeNull();
    expect(document.querySelector("[data-roadmap-legend]")).toBeNull();
  });

  it("首访加载失败时显示失败提示，不落回空状态", () => {
    view({ changes: [], next: null, loadFailed: true });
    expect(screen.getByTestId("column-load-failed")).toBeTruthy();
    expect(screen.queryByText("没有进行中的变更")).toBeNull();
    expect(document.querySelector("[data-roadmap-legend]")).toBeNull();
  });

  it("加载中呈现占位卡、不显示空状态", () => {
    view({ changes: [], next: null, loading: true });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("没有进行中的变更")).toBeNull();
  });
});

describe("RoadmapView 依赖线与路线高亮（需求「路线图画出依赖线并亮起路线」）", () => {
  // Scenario「停在中间的站亮起整条路线」：add-b depends_on add-a、add-c depends_on add-b、
  // add-x 与三者无依赖；另加 add-y→add-z 一条路线外的线。
  const ROUTE: ChangeItem[] = [
    item("add-a", 1, [0, 1]),
    item("add-x", 1, [0, 1]),
    item("add-y", 1, [0, 1]),
    item("add-b", 2, [0, 1], ["add-a"], ["add-a"]),
    item("add-z", 2, [0, 1], ["add-y"], ["add-y"]),
    item("add-c", 3, [0, 1], ["add-b"], ["add-b"]),
  ];

  function edge(key: string): Element | null {
    return document.querySelector(`[data-roadmap-edge="${key}"]`);
  }

  function dimmedStations(): string[] {
    return [...document.querySelectorAll("[data-station][data-dimmed]")].map((s) => s.getAttribute("data-station")!);
  }

  function expectRouteOfAddB() {
    expect(dimmedStations().sort()).toEqual(["add-x", "add-y", "add-z"]);
    for (const key of ["add-a→add-b", "add-b→add-c"]) {
      expect(edge(key)!.hasAttribute("data-active"), key).toBe(true);
      expect(edge(key)!.hasAttribute("data-dimmed"), key).toBe(false);
    }
    expect(edge("add-y→add-z")!.hasAttribute("data-dimmed")).toBe(true);
    expect(edge("add-y→add-z")!.hasAttribute("data-active")).toBe(false);
  }

  function expectNothingHighlighted() {
    expect(document.querySelectorAll("[data-dimmed]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-active]")).toHaveLength(0);
  }

  it("每条两端都在路线图上的依赖画一条线", () => {
    view({ changes: ROUTE, next: null });
    const keys = [...document.querySelectorAll("[data-roadmap-edge]")].map((p) => p.getAttribute("data-roadmap-edge"));
    expect(keys.sort()).toEqual(["add-a→add-b", "add-b→add-c", "add-y→add-z"]);
    for (const path of document.querySelectorAll("[data-roadmap-edge]")) {
      expect(path.tagName.toLowerCase()).toBe("path");
      expect(path.closest("svg")!.getAttribute("class")).toContain("pointer-events-none");
    }
  });

  // 版面替身：每个波次栏 88px、变更栏 200px，第 i 列的圆心高度 40 + 48i；画布在原点。
  function stubLayout() {
    let ready = true;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const rect = (left: number, top: number, size: number) =>
        ({ left, top, right: left + size, bottom: top + size, width: size, height: size, x: left, y: top }) as DOMRect;
      if (!ready || !this.matches("[data-station-node]")) return rect(0, 0, 0);
      const cell = this.closest("[data-wave-cell]")!;
      const column = [...cell.parentElement!.querySelectorAll("[data-wave-cell]")].indexOf(cell);
      const row = [...document.querySelectorAll("[data-station]")].indexOf(this.closest("[data-station]")!);
      return rect(200 + column * 88 + 44 - 16, 40 + row * 48 - 16, 32);
    });
    return {
      hide: () => (ready = false),
      show: () => (ready = true),
    };
  }

  /** 折线直线段的 x（路径里第一个 Q 的控制点）；还没量到位置、画成一条横线时为 NaN。 */
  function verticalX(key: string): number {
    const match = / Q (\S+) /.exec(edge(key)!.getAttribute("d")!);
    return match ? Number(match[1]) : NaN;
  }

  // add-c 依赖 add-a 与 add-b：add-a→add-c 跨过第 2 波。
  const SKIP: ChangeItem[] = [
    item("add-a", 1, [0, 1]),
    item("add-b", 2, [0, 1], ["add-a"], ["add-a"]),
    item("add-c", 3, [0, 1], ["add-a", "add-b"], ["add-a", "add-b"]),
  ];

  it("直线段走在依赖者所在波次栏的左边界，跨波的线不经过中间那一波的圆点", () => {
    stubLayout();
    view({ changes: SKIP, next: null });
    // 第 2 波栏左边界 288、第 3 波栏左边界 376；同一条边界上的两个前置站错开 6px。
    expect(verticalX("add-a→add-b")).toBe(288);
    expect(verticalX("add-a→add-c")).toBe(373);
    expect(verticalX("add-b→add-c")).toBe(379);
    vi.restoreAllMocks();
  });

  it("画布尺寸一变就同步重量，切回路线图的第一格画面已是新座标", () => {
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const layout = stubLayout();
    layout.hide();
    view({ changes: SKIP, next: null });
    expect(verticalX("add-a→add-b")).not.toBe(288);
    layout.show();
    // act 内一般的 state 更新要等 act 结束才画；同步重量则在回呼返回前就画好。
    act(() => {
      notify!();
      expect(verticalX("add-a→add-b")).toBe(288);
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("鼠标停在 add-b：路线外的站与线变淡、路在线的线强调；移出后恢复", () => {
    view({ changes: ROUTE, next: null });
    expectNothingHighlighted();
    fireEvent.mouseEnter(station("add-b"));
    expectRouteOfAddB();
    fireEvent.mouseLeave(station("add-b"));
    expectNothingHighlighted();
  });

  it("焦点落在 add-a 时同样亮起整条路线，失焦后恢复", () => {
    view({ changes: ROUTE, next: null });
    fireEvent.focus(station("add-a"));
    expectRouteOfAddB();
    fireEvent.blur(station("add-a"));
    expectNothingHighlighted();
  });

  it("鼠标移出但焦点仍在站上时维持焦点的路线", () => {
    view({ changes: ROUTE, next: null });
    fireEvent.focus(station("add-a"));
    fireEvent.mouseEnter(station("add-x"));
    expect(dimmedStations().sort()).toEqual(["add-a", "add-b", "add-c", "add-y", "add-z"]);
    fireEvent.mouseLeave(station("add-x"));
    expectRouteOfAddB();
  });

  it("高亮不调用任何回呼", () => {
    const onOpenChange = vi.fn();
    view({ changes: ROUTE, next: null, onOpenChange });
    fireEvent.mouseEnter(station("add-b"));
    fireEvent.focus(station("add-c"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("BoardViewSwitch（看板页页眉的「看板｜路线图」切换）", () => {
  it("两个分页标出目前的查看，点另一个以其值调用 onChange", async () => {
    const onChange = vi.fn();
    render(<BoardViewSwitch value="cards" onChange={onChange} />);
    expect(screen.getByRole("tablist", { name: "看板查看" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "看板" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "路线图" }).getAttribute("aria-selected")).toBe("false");
    await userEvent.click(screen.getByRole("tab", { name: "路线图" }));
    expect(onChange).toHaveBeenCalledWith("roadmap");
  });
});

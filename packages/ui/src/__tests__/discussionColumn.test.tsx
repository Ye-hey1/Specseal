import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, MESSAGES } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

import { KanbanBoard } from "../components/KanbanBoard";
import { DiscussionColumn, discussionChipStage } from "../components/DiscussionColumn";
import { DISCUSSION_TONE } from "../stage";
import type { ChangeItem, ArchivedItem, DiscussionItem, DiscussionLists } from "../adapter";

afterEach(() => {
  vi.useRealTimers();
});

// spec 需求「讨论于看板第 0 栏两级呈现」的 jsdom 可验部分。

const openD: DiscussionItem = {
  slug: "open-topic",
  topic: "Open topic",
  status: "open",
  rounds: 3,
  created: "2026-07-01",
  createdBy: "Momo Chen <momo@example.com>",
  promotedTo: [],
};
const concludedD: DiscussionItem = {
  slug: "settled",
  topic: "Settled topic",
  status: "concluded",
  rounds: 5,
  created: "2026-07-02",
  promotedTo: [],
};
const promotedD: DiscussionItem = {
  slug: "fanout",
  topic: "Fanout topic",
  status: "promoted",
  rounds: 4,
  created: "2026-07-03",
  promotedTo: ["cut-a", "cut-b", "cut-gone"],
};

// spec Example「chip 阶段派生矩阵」的 active 清单值。
const chipChanges: ChangeItem[] = [
  { name: "cut-a", status: "in-progress", totalTasks: 24, completedTasks: 0 },
  { name: "cut-b", status: "in-progress", totalTasks: 24, completedTasks: 13, startedAt: "2026-07-05" },
  { name: "cut-ready", status: "done", totalTasks: 24, completedTasks: 24 },
];
const chipArchived: ArchivedItem[] = [
  { datedName: "2026-07-05-cut-arch", date: "2026-07-05", name: "cut-arch" },
];

function column(id: string): HTMLElement | null {
  return document.querySelector(`[data-column="${id}"]`);
}

describe("DiscussionColumn 拖排（design D6）", () => {
  it("sortable 打开时全卡挂 sortable 与拖曳标签；promoted 收合列不可拖", () => {
    render(
      <DiscussionColumn
        discussions={[openD, concludedD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
        sortable
      />,
    );
    const openCard = screen
      .getByText("Open topic")
      .closest('[aria-roledescription="sortable"]') as HTMLElement;
    expect(openCard).toBeTruthy();
    expect(openCard.getAttribute("aria-label")).toContain("Open topic");
    // D3：promoted 收于栏底收合列，展开后衍生树细列不参与拖排。
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    expect(
      screen.getByText("Fanout topic").closest('[aria-roledescription="sortable"]'),
    ).toBeNull();
  });

  it("未开 sortable 时卡片不挂 sortable（既有独立渲染不受影响）", () => {
    render(<DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />);
    expect(
      screen.getByText("Open topic").closest('[aria-roledescription="sortable"]'),
    ).toBeNull();
  });
});

describe("DiscussionColumn（两级呈现）", () => {
  it("open 全卡以 slug 为题、topic 为描述、显示创建者、带拷贝钮、无动词按钮", () => {
    render(
      <DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />,
    );
    const card = screen.getByText("open-topic").closest("[data-discussion]") as HTMLElement;
    expect(card).toBeTruthy();
    // D1：slug 为标题、topic 降为卡身描述。
    expect(within(card).getByText("open-topic")).toBeTruthy();
    expect(within(card).getByText("Open topic")).toBeTruthy();
    // 创建者仅圆点（anatomy：全名进 tooltip、卡面不直出）与轮数。
    expect(within(card).getByLabelText("Momo Chen <momo@example.com>")).toBeTruthy();
    expect(within(card).queryByText("Momo Chen <momo@example.com>")).toBeNull();
    expect(within(card).getByText(/3 轮/)).toBeTruthy();
    // 有拷贝 slug 钮，但无动词（封存／转为变更）按钮。
    expect(within(card).getByRole("button", { name: /拷贝/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /封存/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /转为变更/ })).toBeNull();
  });

  it("识别列与 meta 列（看板卡片统一解剖学）：拷贝钮行内尾随、圆点 hover 全名、轮数与创建时间并排", () => {
    render(<DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />);
    const card = screen.getByText("open-topic").closest("[data-discussion]") as HTMLElement;
    // 行内尾随（钉住 desktop-ux-polish 落地的位置）：拷贝钮与 slug 同在名称列容器内。
    const title = within(card).getByText("open-topic");
    const nameRow = title.parentElement as HTMLElement;
    expect(within(nameRow).getByRole("button", { name: /拷贝/ })).toBeTruthy();
    // 创建者圆点为静态 metadata：走中性，不占用主色（与变更卡同款）。
    const avatar = within(card).getByLabelText("Momo Chen <momo@example.com>");
    expect(avatar.className).toContain("bg-muted");
    expect(avatar.className).not.toContain("bg-primary");
    // 创建者圆点缺席时不渲染（createdBy 为 undefined 的卡）。
    // meta 列：轮数与创建时间并排。
    expect(within(card).getByText(/3 轮/)).toBeTruthy();
    expect(within(card).getByText("2026-07-01")).toBeTruthy();
  });

  it("createdBy 缺席时圆点缺席", () => {
    const anonymous = { ...openD, slug: "anon-topic", createdBy: undefined };
    render(<DiscussionColumn discussions={[anonymous]} changes={[]} archived={[]} />);
    const card = screen.getByText("anon-topic").closest("[data-discussion]") as HTMLElement;
    // 圆点以 createdBy 全文为 aria-label（含 @）；缺席时整颗不渲染。
    expect(within(card).queryByLabelText(/@/)).toBeNull();
  });

  it("点拷贝钮把讨论 slug 写入剪贴板且不开讨论抽屉", () => {
    const writeText = vi.fn();
    const onOpenDiscussion = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <DiscussionColumn
        discussions={[openD]}
        changes={[]}
        archived={[]}
        onOpenDiscussion={onOpenDiscussion}
      />,
    );
    const card = screen.getByText("open-topic").closest("[data-discussion]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /拷贝/ }));
    expect(writeText).toHaveBeenCalledWith("open-topic");
    expect(onOpenDiscussion).not.toHaveBeenCalled();
  });

  it("concluded 讨论为全卡带「封存」按钮但无「转为变更」；旧词「促转」「归档」不出现", () => {
    // D3：promote 已自 GUI 撤除——concluded 卡仅保留封存动词，转为变更改由 CLI／agent。
    const onArchiveDiscussion = vi.fn();
    render(
      <DiscussionColumn
        discussions={[concludedD]}
        changes={[]}
        archived={[]}
        onArchiveDiscussion={onArchiveDiscussion}
      />,
    );
    const card = screen.getByText("Settled topic").closest("[data-discussion]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /封存/ }));
    expect(onArchiveDiscussion).toHaveBeenCalledWith("settled");
    // 转为变更（promote）已撤除。
    expect(within(card).queryByRole("button", { name: /转为变更/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /促转/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /归档/ })).toBeNull();
  });

  it("点封存钮列的空白处打开讨论而非被吞掉", () => {
    const onArchiveDiscussion = vi.fn();
    const onOpenDiscussion = vi.fn();
    render(
      <DiscussionColumn
        discussions={[concludedD]}
        changes={[]}
        archived={[]}
        onArchiveDiscussion={onArchiveDiscussion}
        onOpenDiscussion={onOpenDiscussion}
      />,
    );
    const card = screen.getByText("Settled topic").closest("[data-discussion]") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /封存/ }).parentElement as HTMLElement);
    expect(onOpenDiscussion).toHaveBeenCalledWith("settled");
    expect(onArchiveDiscussion).not.toHaveBeenCalled();
  });

  it("点全卡打开讨论（动词按钮除外）", () => {
    const onOpenDiscussion = vi.fn();
    render(
      <DiscussionColumn
        discussions={[openD]}
        changes={[]}
        archived={[]}
        onOpenDiscussion={onOpenDiscussion}
      />,
    );
    fireEvent.click(screen.getByText("Open topic"));
    expect(onOpenDiscussion).toHaveBeenCalledWith("open-topic");
  });

  it("promoted 细列：slug 首行带拷贝钮、topic 次行、树状子项带阶段、点列打开", () => {
    const onOpenDiscussion = vi.fn();
    render(
      <DiscussionColumn
        discussions={[openD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
        onOpenDiscussion={onOpenDiscussion}
      />,
    );
    // D3：promoted 收于栏底收合列，展开后 active 全卡仍同屏可见。
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    expect(screen.getByText("Open topic")).toBeTruthy();
    expect(screen.queryByText(/已促转/)).toBeNull();
    // D4：slug（文档名）为细列首行锚点、topic 降为次行描述、带拷贝 slug 钮。
    const row = screen.getByText("fanout").closest("[data-discussion]") as HTMLElement;
    expect(within(row).getByText("Fanout topic")).toBeTruthy();
    expect(within(row).getByRole("button", { name: /拷贝/ })).toBeTruthy();
    // 树状前缀：末列 └、其余 ├（三个子变更 → 2 个 ├、1 个 └）。
    expect(within(row).getAllByText("├")).toHaveLength(2);
    expect(within(row).getAllByText("└")).toHaveLength(1);
    expect(within(row).getByText("cut-a")).toBeTruthy();
    expect(within(row).getByText("cut-b")).toBeTruthy();
    expect(within(row).getByText("cut-gone")).toBeTruthy();
    // 子项带阶段标示：cut-a 提案中、cut-b 进行中、cut-gone 已删除。
    expect(within(row).getByText("提案中")).toBeTruthy();
    expect(within(row).getByText("进行中")).toBeTruthy();
    expect(within(row).getByText("已删除")).toBeTruthy();
    fireEvent.click(screen.getByText("Fanout topic"));
    expect(onOpenDiscussion).toHaveBeenCalledWith("fanout");
  });

  it("细列拷贝钮行内尾随 slug 文本，非推至列右缘的 flex 兄弟（tasks 4.4）", () => {
    render(
      <DiscussionColumn
        discussions={[promotedD]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const row = screen.getByText("fanout").closest("[data-discussion]") as HTMLElement;
    const slugSpan = screen.getByText("fanout");
    const copyBtn = within(row).getByRole("button", { name: /拷贝/ });
    // 行内尾随（design D4 拷贝钮位置规则）：按钮是 slug 文本容器的子元素，
    // 直接跟在最后一个字符后流动。
    expect(slugSpan.contains(copyBtn)).toBe(true);
  });

  // spec「共用组件唯一来源」：看板卡片的拷贝钮与系统匣、已封存清单同一组件——主色勾号 1.5 秒。
  it("细列拷贝钮来自共用 CopyButton：主色勾号维持 1.5 秒，并以 status 声明已拷贝", async () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(
      <DiscussionColumn
        discussions={[promotedD]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const row = screen.getByText("fanout").closest("[data-discussion]") as HTMLElement;
    const copyBtn = within(row).getByRole("button", { name: "拷贝 slug" });
    fireEvent.click(copyBtn);
    await act(async () => {});
    expect(copyBtn.querySelector("svg.lucide-check")).toBeTruthy();
    expect(within(row).getByRole("status").textContent).toBe("已拷贝");
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(copyBtn.querySelector("svg.lucide-check")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(copyBtn.querySelector("svg.lucide-check")).toBeNull();
  });

  it("点细列拷贝钮把 slug 写入剪贴板、不打开抽屉", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const onOpenDiscussion = vi.fn();
    render(
      <DiscussionColumn
        discussions={[promotedD]}
        changes={chipChanges}
        archived={chipArchived}
        onOpenDiscussion={onOpenDiscussion}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const row = screen.getByText("fanout").closest("[data-discussion]") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /拷贝/ }));
    expect(writeText).toHaveBeenCalledWith("fanout");
    expect(onOpenDiscussion).not.toHaveBeenCalled();
  });

  it("空清单显示栏空状态", () => {
    render(<DiscussionColumn discussions={[]} changes={[]} archived={[]} />);
    expect(screen.getByText("尚无讨论")).toBeTruthy();
  });
});

describe("DiscussionColumn 栏底已转出收合列（design D3）", () => {
  it("缺省收合带 promoted 计数；点按就地展开且 active 卡维持可见；再点收合", () => {
    render(
      <DiscussionColumn
        discussions={[openD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    const bar = screen.getByRole("button", { name: /已转出/ });
    expect(bar.textContent).toContain("1");
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    // 缺省收合：细列不呈现、active 全卡照常。
    expect(screen.queryByText("Fanout topic")).toBeNull();
    expect(screen.getByText("Open topic")).toBeTruthy();
    // 展开：细列就地出现、active 全卡仍在（同屏、不互斥）。
    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fanout topic")).toBeTruthy();
    expect(screen.getByText("Open topic")).toBeTruthy();
    // 栏标题不切换。
    expect(screen.getByText("讨论")).toBeTruthy();
    expect(screen.queryByText("已转出讨论")).toBeNull();
    // 再点收合。
    fireEvent.click(bar);
    expect(screen.queryByText("Fanout topic")).toBeNull();
  });

  it("无 promoted 讨论时栏底收合列缺席", () => {
    render(<DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />);
    expect(screen.queryByRole("button", { name: /已转出/ })).toBeNull();
  });
});

describe("DiscussionColumn 计数只算 active 与空状态（design D3）", () => {
  it("栏计数徽章恒显 active 数，展开已转出收合列不改变", () => {
    render(
      <DiscussionColumn
        discussions={[openD, concludedD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    // active 2（open＋concluded）；promoted 计数呈于收合列、不进栏徽章。
    expect(screen.getByTestId("column-count").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    expect(screen.getByTestId("column-count").textContent).toBe("2");
  });

  it("无 active 但有 promoted 时栏体不显「尚无讨论」，计数为 0", () => {
    render(
      <DiscussionColumn
        discussions={[promotedD]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    expect(screen.queryByText("尚无讨论")).toBeNull();
    expect(screen.getByTestId("column-count").textContent).toBe("0");
  });

  it("栏头图标、顶部色条与计数徽章取讨论专属的桃紫（DISCUSSION_TONE）", () => {
    // spec「生命周期四栏各一色相」：讨论栏有自己的色相，与系统匣讨论分区同一来源。
    render(<DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />);
    const col = document.querySelector('[data-column="discussions"]') as HTMLElement;
    // 与三个阶段栏同一套容器（design D1）：首子节点为 3px 色相条，不再以 border-t 当色条。
    expect(col.firstElementChild!.className).toContain("bg-stage-discussion");
    expect(col.className).not.toContain("border-t-");
    const count = screen.getByTestId("column-count");
    for (const cls of DISCUSSION_TONE.badge.split(" ")) expect(count.className).toContain(cls);
    const heading = screen.getByText("讨论");
    const icon = heading.previousElementSibling as HTMLElement;
    expect(icon.getAttribute("class")).toContain(DISCUSSION_TONE.icon);
  });

  it("已转出收合列维持中性", () => {
    render(<DiscussionColumn discussions={[promotedD]} changes={[]} archived={[]} />);
    const toggle = screen.getByRole("button", { name: /已转出/ });
    expect(toggle.className).toContain("text-muted-foreground");
    expect(toggle.className).not.toContain("stage-");
  });
});

describe("DiscussionColumn 结论分区三态（conclusion-gated-discussion-archive）", () => {
  const promotedUnconcluded: DiscussionItem = {
    slug: "mid-flight",
    topic: "Mid flight",
    status: "promoted",
    rounds: 2,
    created: "2026-07-04",
    promotedTo: ["cut-a"],
    concluded: false,
  };
  const promotedConcluded: DiscussionItem = { ...promotedD, concluded: true };

  it("concluded === false 的 promoted 留上区全卡：带「已转出・尚无结论」标、无动词按钮、计入栏徽章", () => {
    render(
      <DiscussionColumn
        discussions={[promotedUnconcluded, promotedConcluded]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    const col = column("discussions")!;
    // 收合列缺省收合 → 可见的 mid-flight 即上区全卡。
    const card = col.querySelector('[data-discussion="mid-flight"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText("已转出・尚无结论")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "封存" })).toBeNull();
    // 栏徽章计上区卡数（含未结论 promoted）；收合列只计已有结论的 promoted。
    expect(screen.getByTestId("column-count").textContent).toBe("1");
    expect(screen.getByText("已转出 1")).toBeTruthy();
  });

  it("concluded === true 的 promoted 收进栏底收合列，不出上区", () => {
    render(
      <DiscussionColumn discussions={[promotedConcluded]} changes={chipChanges} archived={chipArchived} />,
    );
    const col = column("discussions")!;
    expect(col.querySelector('[data-discussion="fanout"]')).toBeNull();
    expect(screen.getByText("已转出 1")).toBeTruthy();
    expect(screen.getByTestId("column-count").textContent).toBe("0");
  });

  it("concluded 缺席（旧 server）退回现行：promoted 一律收合、无尚无结论标", () => {
    render(<DiscussionColumn discussions={[promotedD]} changes={chipChanges} archived={chipArchived} />);
    const col = column("discussions")!;
    expect(col.querySelector('[data-discussion="fanout"]')).toBeNull();
    expect(screen.queryByText("已转出・尚无结论")).toBeNull();
    expect(screen.getByText("已转出 1")).toBeTruthy();
  });
});

describe("DiscussionColumn hold 分区（discussion-hold-until-release）", () => {
  const heldPromoted: DiscussionItem = { ...promotedD, concluded: true, hold: true };
  const releasedPromoted: DiscussionItem = {
    ...promotedD,
    slug: "released",
    concluded: true,
    hold: false,
  };

  it("hold 为 true 的已结论 promoted 留上区全卡：带「已转出・保留中」标、无动词按钮、不列衍生变更、计入栏徽章、收合列不列", () => {
    render(
      <DiscussionColumn
        discussions={[heldPromoted, releasedPromoted]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    const col = column("discussions")!;
    const card = col.querySelector('[data-discussion="fanout"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText("已转出・保留中")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "封存" })).toBeNull();
    expect(within(card).queryByText("cut-a")).toBeNull();
    // 徽章计上区卡数（含保留中）；收合列只计已释放的 promoted。
    expect(screen.getByTestId("column-count").textContent).toBe("1");
    expect(screen.getByText("已转出 1")).toBeTruthy();
    expect(col.querySelector('[data-discussion="released"]')).toBeNull();
  });

  it("hold 缺席（旧 server）沿既有收合：已结论 promoted 收进收合列、无保留中标", () => {
    render(
      <DiscussionColumn
        discussions={[{ ...promotedD, concluded: true }]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    const col = column("discussions")!;
    expect(col.querySelector('[data-discussion="fanout"]')).toBeNull();
    expect(screen.queryByText("已转出・保留中")).toBeNull();
    expect(screen.getByText("已转出 1")).toBeTruthy();
  });

  it("concluded 为 false 时不论 hold 仍标「已转出・尚无结论」", () => {
    render(
      <DiscussionColumn
        discussions={[{ ...promotedD, concluded: false, hold: true }]}
        changes={chipChanges}
        archived={chipArchived}
      />,
    );
    const card = column("discussions")!.querySelector('[data-discussion="fanout"]') as HTMLElement;
    expect(within(card).getByText("已转出・尚无结论")).toBeTruthy();
    expect(within(card).queryByText("已转出・保留中")).toBeNull();
  });
});

describe("DiscussionColumn promoted chip 阶段配色（design D2）", () => {
  it("chip 沿看板 STAGE_BADGE 配色：提案中/进行中/已就绪各阶段色相、已封存中性、已删除 destructive 加删除线", () => {
    // 五态各一子变更：提案中/进行中/已就绪（active 清单）、已封存、已删除。
    const d: DiscussionItem = {
      ...promotedD,
      promotedTo: ["cut-a", "cut-b", "cut-ready", "cut-arch", "cut-gone"],
    };
    render(<DiscussionColumn discussions={[d]} changes={chipChanges} archived={chipArchived} />);
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const chipCls = (label: string) => screen.getByText(label).className;
    // 提案中/进行中沿 STAGE_BADGE 的各阶段淡底实色字。
    expect(chipCls("提案中")).toContain("bg-stage-proposed/10");
    expect(chipCls("进行中")).toContain("bg-stage-in-progress/10");
    // 已就绪为实心（以 text-primary-foreground 辨识，与淡底区隔）。
    expect(chipCls("已就绪")).toContain("bg-stage-ready");
    expect(chipCls("已就绪")).toContain("text-primary-foreground");
    // 已封存中性色。
    expect(chipCls("已封存")).toContain("bg-muted");
    // 已删除 destructive 加删除线。
    expect(chipCls("已删除")).toContain("text-destructive");
    expect(chipCls("已删除")).toContain("line-through");
  });
});

describe("discussionChipStage（spec Example「chip 阶段派生矩阵」）", () => {
  // | promoted_to 子 change 的所在 | chip 标示 |
  const rows: Array<[string, string]> = [
    ["cut-a", "提案中"], // active 清单，无 started、0/24
    ["cut-b", "进行中"], // active 清单，有 started、13/24
    ["cut-ready", "已就绪"], // active 清单，24/24
    ["cut-arch", "已封存"], // 封存清单（dated name 尾码命中）
    ["cut-gone", "已删除"], // 两清单皆无（讨论维持已促转）
  ];
  // 函数回传 i18n key；断言值仍为 spec Example 的 zh-CN 标示（经字典解析）。
  it.each(rows)("%s → %s", (name, label) => {
    const key = discussionChipStage(name, chipChanges, chipArchived);
    expect(MESSAGES["zh-CN"][key]).toBe(label);
  });
});

describe("KanbanBoard 四栏集成", () => {
  const lists: DiscussionLists = {
    active: [openD, concludedD],
    archived: [
      {
        slug: "done-topic",
        topic: "Done archived topic",
        status: "promoted",
        rounds: 2,
        created: "2026-06-01",
        promotedTo: ["old-cut"],
      },
    ],
  };
  const changes: ChangeItem[] = [
    { name: "working-y", status: "in-progress", totalTasks: 10, completedTasks: 4, startedAt: "2026-07-06" },
  ];

  it("讨论栏为第 0 栏（最左），与既有三栏并列", () => {
    render(<KanbanBoard changes={changes} discussions={lists} />);
    const discussionsCol = column("discussions");
    expect(discussionsCol).toBeTruthy();
    expect(column("proposed")).toBeTruthy();
    // 第 0 栏在 DOM 序位于 proposed 之前。
    const cols = Array.from(document.querySelectorAll("[data-column]")).map((el) =>
      el.getAttribute("data-column"),
    );
    expect(cols.indexOf("discussions")).toBeLessThan(cols.indexOf("proposed"));
    expect(within(discussionsCol as HTMLElement).getByText("Open topic")).toBeTruthy();
  });

  it("封存讨论不出现于讨论栏", () => {
    render(<KanbanBoard changes={changes} discussions={lists} />);
    expect(screen.queryByText("Done archived topic")).toBeNull();
  });

  it("无讨论的项目显示栏空状态", () => {
    render(
      <KanbanBoard changes={changes} discussions={{ active: [], archived: [] }} />,
    );
    expect(within(column("discussions") as HTMLElement).getByText("尚无讨论")).toBeTruthy();
  });

  it("未传 discussions 时维持三栏（向后兼容）", () => {
    render(<KanbanBoard changes={changes} />);
    expect(column("discussions")).toBeNull();
  });
});

// spec「看板栏与卡片的容器外观」＋「讨论于看板第 0 栏两级呈现」（desktop-board-reskin design D1／D2）：
// 讨论栏与阶段栏共用容器卡；栏底收合列为白底上缘细线列、› 展开旋转；展开状态可由宿主受控。
describe("DiscussionColumn 容器卡与受控收合列（desktop-board-reskin）", () => {
  it("栏为白底细框 16px 圆角容器：淡灰卡片区、白底标头、栏名不全大写", () => {
    render(<DiscussionColumn discussions={[openD]} changes={[]} archived={[]} />);
    const col = document.querySelector('[data-column="discussions"]') as HTMLElement;
    const cls = col.className.split(/\s+/);
    expect(cls).toContain("rounded-2xl");
    expect(cls).toContain("bg-sidebar");
    expect(cls).toContain("border");
    const heading = screen.getByText("讨论");
    expect(heading.className).not.toContain("uppercase");
    expect(heading.parentElement!.className).toContain("bg-card");
  });

  it("「尚无讨论」置中灰字，与其他栏的空文案同款", () => {
    render(<DiscussionColumn discussions={[]} changes={[]} archived={[]} />);
    const empty = screen.getByText("尚无讨论");
    expect(empty.className).toContain("text-center");
    expect(empty.className).toContain("text-muted-foreground");
  });

  it("收合列为白底上缘细线列，右端收合时为 ›、展开时朝上（指向其上方展开的细列）；promoted 细列为白底细框 8px 圆角", () => {
    render(<DiscussionColumn discussions={[openD, promotedD]} changes={chipChanges} archived={chipArchived} />);
    const bar = screen.getByRole("button", { name: /已转出/ });
    expect(bar.className).toContain("bg-card");
    expect(bar.className).toContain("border-t");
    const chevron = () => (bar.querySelector("svg.lucide-chevron-right")!.getAttribute("class") ?? "").split(/\s+/);
    expect(chevron()).not.toContain("-rotate-90");
    expect(chevron()).not.toContain("rotate-90");
    fireEvent.click(bar);
    expect(chevron()).toContain("-rotate-90");
    expect(chevron()).not.toContain("rotate-90");
    // 收合后恢复 ›，再展开供下方细列断言。
    fireEvent.click(bar);
    expect(chevron()).not.toContain("-rotate-90");
    expect(chevron()).not.toContain("rotate-90");
    fireEvent.click(bar);
    const row = document.querySelector('[data-discussion="fanout"]') as HTMLElement;
    const rowCls = row.className.split(/\s+/);
    expect(rowCls).toContain("rounded-lg");
    expect(rowCls).toContain("bg-card");
    expect(rowCls).toContain("border-border");
    expect(rowCls.some((c) => c.startsWith("bg-background"))).toBe(false);
  });

  it("受控：点收合列调用 onPromotedExpandedChange(true) 且不自行展开", () => {
    const onChange = vi.fn();
    render(
      <DiscussionColumn
        discussions={[openD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
        promotedExpanded={false}
        onPromotedExpandedChange={onChange}
      />,
    );
    const bar = screen.getByRole("button", { name: /已转出/ });
    fireEvent.click(bar);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Fanout topic")).toBeNull();
  });

  it("受控：promotedExpanded={true} 时细列可见，点收合列回报 false", () => {
    const onChange = vi.fn();
    render(
      <DiscussionColumn
        discussions={[openD, promotedD]}
        changes={chipChanges}
        archived={chipArchived}
        promotedExpanded
        onPromotedExpandedChange={onChange}
      />,
    );
    const bar = screen.getByRole("button", { name: /已转出/ });
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fanout topic")).toBeTruthy();
    expect(screen.getByText("Open topic")).toBeTruthy();
    fireEvent.click(bar);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("非受控（两个 props 皆缺席）：点收合列仍自行展开", () => {
    render(<DiscussionColumn discussions={[openD, promotedD]} changes={chipChanges} archived={chipArchived} />);
    const bar = screen.getByRole("button", { name: /已转出/ });
    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fanout topic")).toBeTruthy();
  });

  it("KanbanBoard 同名透传 promotedExpanded／onPromotedExpandedChange", () => {
    const onChange = vi.fn();
    render(
      <KanbanBoard
        changes={[]}
        discussions={{ active: [openD, promotedD], archived: [] }}
        archivedChanges={chipArchived}
        promotedExpanded
        onPromotedExpandedChange={onChange}
      />,
    );
    expect(screen.getByText("Fanout topic")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

// 品质关卡 round 1 修补（review R-C1／R-C2、R-S1）：展开的 promoted 细列落在收合列正上方的
// 有界区块（栏内卡片再多也看得到）；受控 props 两者同进同出；阶段栏与讨论栏共用同一栏壳。
describe("DiscussionColumn 收合列展开区与栏壳（quality round 1）", () => {
  const manyOpen: DiscussionItem[] = Array.from({ length: 12 }, (_, i) => ({
    ...openD,
    slug: `open-${i}`,
    topic: `Open ${i}`,
  }));

  it("展开的 promoted 细列在收合列正上方的有界区块，不在可卷动的卡片区底部", () => {
    render(
      <DiscussionColumn discussions={[...manyOpen, promotedD]} changes={chipChanges} archived={chipArchived} />,
    );
    const bar = screen.getByRole("button", { name: /已转出/ });
    fireEvent.click(bar);
    const block = bar.previousElementSibling as HTMLElement;
    const blockCls = block.className.split(/\s+/);
    expect(blockCls).toEqual(expect.arrayContaining(["max-h-64", "overflow-y-auto"]));
    // 不带 shrink-0：窗口很矮时区块可被压缩，收合列不会被栏外框的 overflow-hidden 切掉（review round 2）。
    expect(blockCls).not.toContain("shrink-0");
    expect(within(block).getByText("Fanout topic")).toBeTruthy();
    // 卡片区（flex-1 卷动区）只放全卡，不再包含 promoted 细列。
    const cardArea = block.previousElementSibling as HTMLElement;
    expect(cardArea.className).toContain("flex-1");
    expect(within(cardArea).queryByText("Fanout topic")).toBeNull();
    expect(within(cardArea).getByText("Open 11")).toBeTruthy();
  });

  it("收合时没有展开区块，收合列紧接在卡片区之后", () => {
    render(<DiscussionColumn discussions={[openD, promotedD]} changes={chipChanges} archived={chipArchived} />);
    const bar = screen.getByRole("button", { name: /已转出/ });
    expect((bar.previousElementSibling as HTMLElement).className).toContain("flex-1");
  });

  it("只给受控 props 其一：类型层挡下；运行期退回内部状态（缺省收合、点按自行展开）", () => {
    render(
      // @ts-expect-error — promotedExpanded 与 onPromotedExpandedChange 必须同进同出
      <DiscussionColumn discussions={[openD, promotedD]} changes={chipChanges} archived={chipArchived} promotedExpanded />,
    );
    const bar = screen.getByRole("button", { name: /已转出/ });
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
  });

  it("阶段栏与讨论栏共用同一栏壳：外框、色相条高度、标头、卡片区 class 一致", () => {
    render(<KanbanBoard changes={[]} discussions={{ active: [], archived: [] }} />);
    const disc = column("discussions") as HTMLElement;
    const prop = column("proposed") as HTMLElement;
    const strip = (cls: string) => cls.split(/\s+/).filter((c) => !c.startsWith("bg-stage-")).sort();
    expect(disc.className).toBe(prop.className);
    expect(strip(disc.children[0].className)).toEqual(strip(prop.children[0].className));
    expect(disc.children[1].className).toBe(prop.children[1].className);
    expect(disc.children[2].className).toBe(prop.children[2].className);
    expect(screen.getByText("尚无讨论").className).toBe(screen.getByText("没有提案中的变更").className);
  });
});

// spec desktop-app「变更与讨论详情页的宿主为看板」Scenario「宿主页不推动详情页外框」：
// 卷动区不是定位容器时，卡片里没钉位置的 absolute 元素会跳出它的裁切、撑高 desktop 的 main。
// 这是 class 字面守门（jsdom 不算版面），版面本身由该 Scenario 的 Mac 实机手动任务确认。
describe("看板卷动区是定位容器（copy-button-live-region-pin）", () => {
  it("grid、各栏卡片区与已转出展开区都带 relative", () => {
    render(
      <KanbanBoard
        changes={chipChanges}
        discussions={{ active: [openD, promotedD], archived: [] }}
        archivedChanges={chipArchived}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /已转出/ }));
    const grid = column("proposed")!.closest(".overflow-x-auto") as HTMLElement;
    const scrollers = [grid, ...Array.from(grid.querySelectorAll<HTMLElement>(".overflow-y-auto"))];
    // grid＋四栏卡片区＋已转出展开区。
    expect(scrollers).toHaveLength(6);
    for (const el of scrollers) expect(el.classList).toContain("relative");
  });
});

// fix-english-status-labels-and-plurals：desktop-config「数量为 1 时用单数」的讨论卡情境。
describe("英文接口的讨论卡轮数", () => {
  it("只有 1 轮时写「1 round」", () => {
    rtlRender(<DiscussionColumn discussions={[{ ...openD, rounds: 1 }]} changes={[]} archived={[]} />, {
      wrapper: ({ children }: { children: ReactNode }) => <I18nProvider locale="en">{children}</I18nProvider>,
    });
    const card = screen.getByText("open-topic").closest("[data-discussion]") as HTMLElement;
    expect(within(card).getByText(/1 round/).textContent).not.toContain("rounds");
  });
});

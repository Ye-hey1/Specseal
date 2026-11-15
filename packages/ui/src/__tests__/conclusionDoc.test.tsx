// spec「讨论结论以字段标签呈现」的结论渲染器（desktop-discussion-doc-views design D2）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ConclusionDoc } from "../components/ConclusionDoc";
import { engineCut } from "./engineCuts";

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="zh-CN">{children}</I18nProvider>;
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const section = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-section="${key}"]`) as HTMLElement;
const countOf = (el: HTMLElement) => el.querySelector("h2")!.parentElement!.querySelector(".tabular-nums")?.textContent;

// spec Scenario「决定主句放大与细节收合」：一句定论＋27 条顶层列点（其中 7 条为分刀列）。
// 每 3 条细节后插一条分刀列，最后一刀接在尾端：20 条细节＋7 条分刀。
const MANY_CUT_AT = Array.from({ length: 20 }, (_, i) => i).filter((i) => i % 3 === 2 || i === 19);
const manyCutLine = (i: number) => `**cut ${Math.floor(i / 3)} \`chg-${i}\`**: 范围 ${i}`;
const MANY = [
  "**Decision**: 一句定论。",
  ...Array.from({ length: 20 }, (_, i) => [`- 细节 ${i + 1}`, ...(MANY_CUT_AT.includes(i) ? [`- ${manyCutLine(i)}`] : [])]).flat(),
].join("\n");
// 引擎对 MANY 回的七把刀（promoted_to 为空）。
const MANY_CUTS = MANY_CUT_AT.map((i) =>
  engineCut(manyCutLine(i), {
    cut: `cut ${Math.floor(i / 3)}`,
    title: `范围 ${i}`,
    changes: [`chg-${i}`],
    changesInBold: true,
    unpromoted: [`chg-${i}`],
  }),
);

// spec Scenario「分刀卡与变更签」：detail-content-redesign 的三条分刀列，前两刀已封存、第三刀未转出。
const CUTS = [
  "**Decision**: 分三刀落地。",
  "- 范围与验收：只改 UI 渲染",
  "- **cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏",
  "  - 文档树栏",
  "  - 分页列退场",
  "- **cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法",
  "  - 章节白名单",
  "- **cut 3 `desktop-discussion-doc-views`**: 讨论文档渲染器——结论分刀卡",
  "**Rationale**: 理由一段。",
  "**Rejected alternatives**:",
  ...Array.from({ length: 14 }, (_, i) => `- 方案 ${i} — 理由 ${i}`),
  "**Deferred**:",
  "- 搁置甲 — 等第二个消费者",
  "- 搁置乙——不在范围",
  "- 搁置丙没有理由",
  "- 搁置丁 — 理由丁",
  "- 搁置戊 — 理由戊",
  "**Capture to**: proposal、design、spec（desktop-app MODIFIED）、tasks",
  "**Next**: /specseal-propose --from-discussion detail-content-redesign（先建 cut 1）",
].join("\n");
// 引擎对 CUTS 回的三把刀：promoted_to 含前两刀的变更。
const CUTS_ENGINE = [
  engineCut("**cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏", {
    cut: "cut 1",
    title: "骨架",
    note: "三种详情页改三栏",
    changes: ["desktop-detail-doc-tree"],
    changesInBold: true,
  }),
  engineCut("**cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法", {
    cut: "cut 2",
    title: "变更文档渲染器",
    note: "提案、设计的新画法",
    changes: ["desktop-change-doc-views"],
    changesInBold: true,
  }),
  engineCut("**cut 3 `desktop-discussion-doc-views`**: 讨论文档渲染器——结论分刀卡", {
    cut: "cut 3",
    title: "讨论文档渲染器",
    note: "结论分刀卡",
    changes: ["desktop-discussion-doc-views"],
    changesInBold: true,
    unpromoted: ["desktop-discussion-doc-views"],
  }),
];

describe("ConclusionDoc", () => {
  it("27 条细节含 7 条分刀：细线列 4 条、钮文本「展开其余 16 项定案细节」、点后 20 条、计数 20", () => {
    const { container } = render(<ConclusionDoc text={MANY} cuts={MANY_CUTS} />);
    const decision = section(container, "conclusion.decision");
    expect(decision.querySelector("[data-verdict]")!.textContent).toBe("一句定论。");
    const rows = () => decision.querySelectorAll("[data-row-list] > li");
    expect(rows().length).toBe(4);
    expect(countOf(decision)).toBe("20");
    fireEvent.click(within(decision).getByRole("button", { name: "展开其余 16 项定案细节" }));
    expect(rows().length).toBe(20);
    expect(within(decision).queryByRole("button", { name: /展开其余/ })).toBeNull();
    expect(container.querySelectorAll("[data-cut]").length).toBe(7);
  });

  it("三张分刀卡的识别签与范围句、前两张变更签带阶段签且点击调用 stageOf 回的 onOpen、第三张不可点", () => {
    const opened = vi.fn();
    const stageOf = (name: string) =>
      name === "desktop-detail-doc-tree" || name === "desktop-change-doc-views"
        ? { label: "已封存", tone: "neutral" as const, onOpen: () => opened(name) }
        : null;
    const { container } = render(<ConclusionDoc text={CUTS} cuts={CUTS_ENGINE} stageOf={stageOf} />);
    const cuts = section(container, "conclusion.cuts");
    expect(countOf(cuts)).toBe("3");
    const cards = Array.from(cuts.querySelectorAll<HTMLElement>("[data-cut]"));
    expect(cards.map((c) => c.getAttribute("data-cut"))).toEqual(["cut 1", "cut 2", "cut 3"]);
    const header = cards[0].querySelector("header")!;
    expect(header.textContent).toContain("cut 1");
    expect(header.textContent).toContain("骨架");
    expect(header.textContent).toContain("1 个变更");
    expect(header.textContent).not.toContain("三种详情页");
    // 「——」之后的文本成为卡内第一条细线列，其后是嵌套子项。
    expect(Array.from(cards[0].querySelectorAll("[data-row-list] > li")).map((li) => li.textContent)).toEqual([
      "三种详情页改三栏",
      "文档树栏",
      "分页列退场",
    ]);
    expect(within(cards[0]).getByText("已封存")).toBeTruthy();
    fireEvent.click(within(cards[1]).getByRole("button", { name: "desktop-change-doc-views" }));
    expect(opened).toHaveBeenCalledWith("desktop-change-doc-views");
    expect(within(cards[2]).queryByRole("button", { name: "desktop-discussion-doc-views" })).toBeNull();
    expect(within(cards[2]).getByText("desktop-discussion-doc-views")).toBeTruthy();
    expect(within(cards[2]).queryByText("已封存")).toBeNull();
    // 第三刀整刀未转出：橄榄色虚线框、卡头「尚未转出」签；前两刀照旧。
    expect(cards[2].hasAttribute("data-cut-todo")).toBe(true);
    expect(cards[2].className).toContain("border-dashed");
    expect(cards[2].className).toContain("border-status-manual/40");
    expect(cards[2].querySelector("header")!.textContent).toContain("尚未转出");
    for (const card of cards.slice(0, 2)) {
      expect(card.hasAttribute("data-cut-todo")).toBe(false);
      expect(card.textContent).not.toContain("尚未转出");
    }
    // 分刀列不再出现在定案细节。
    expect(section(container, "conclusion.decision").querySelectorAll("[data-row-list] > li").length).toBe(1);
  });

  it("部分转出：卡无 data-cut-todo，只有 unpromoted 内的变更名签之后有「尚未转出」", () => {
    const stageOf = (name: string) => (name === "a-one" ? { label: "进行中", tone: "progress" as const } : null);
    const cut = engineCut("**cut 2 `a-one` `b-two`**: 外壳", {
      cut: "cut 2",
      title: "外壳",
      changes: ["a-one", "b-two"],
      changesInBold: true,
      unpromoted: ["b-two"],
    });
    const { container } = render(
      <ConclusionDoc text={"**Decision**: 定。\n- **cut 2 `a-one` `b-two`**: 外壳"} cuts={[cut]} stageOf={stageOf} />,
    );
    const card = container.querySelector<HTMLElement>("[data-cut]")!;
    expect(card.hasAttribute("data-cut-todo")).toBe(false);
    expect(card.className).not.toContain("border-dashed");
    expect(card.querySelector("header")!.textContent).not.toContain("尚未转出");
    const promoted = card.querySelector<HTMLElement>('[data-cut-change="a-one"]')!;
    expect(promoted.textContent).toBe("a-one进行中");
    const todo = card.querySelector<HTMLElement>('[data-cut-change="b-two"]')!;
    expect(todo.textContent).toBe("b-two尚未转出");
    expect(todo.lastElementChild!.className).toContain("text-status-manual");
  });

  it("清单的 promotedTo 与文档不同步（stageOf 对 unpromoted 内的名称也回阶段）：签的转出状态只依引擎的 unpromoted", () => {
    const stageOf = () => ({ label: "进行中", tone: "progress" as const, onOpen: () => {} });
    const partial = engineCut("**cut 2 `a-one` `b-two`**: 外壳", {
      cut: "cut 2",
      title: "外壳",
      changes: ["a-one", "b-two"],
      changesInBold: true,
      unpromoted: ["b-two"],
    });
    const none = engineCut("**cut 3 `c-three`**: 收尾", {
      cut: "cut 3",
      title: "收尾",
      changes: ["c-three"],
      changesInBold: true,
      unpromoted: ["c-three"],
    });
    const { container } = render(
      <ConclusionDoc
        text={"**Decision**: 定。\n- **cut 2 `a-one` `b-two`**: 外壳\n- **cut 3 `c-three`**: 收尾"}
        cuts={[partial, none]}
        stageOf={stageOf}
      />,
    );
    const [p, n] = container.querySelectorAll<HTMLElement>("[data-cut]");
    expect(p.querySelector('[data-cut-change="a-one"]')!.textContent).toBe("a-one进行中");
    const todo = p.querySelector<HTMLElement>('[data-cut-change="b-two"]')!;
    expect(todo.textContent).toBe("b-two尚未转出");
    expect(todo.querySelector("button")).toBeNull();
    expect(n.querySelector("header")!.textContent).toContain("尚未转出");
    expect(n.querySelector('[data-cut-change="c-three"]')!.textContent).toBe("c-three");
  });

  it("刀列没有变更名签时卡无 data-cut-todo、无「尚未转出」", () => {
    const cut = engineCut("**刀三**：系统匣面板", { cut: "刀三", title: "系统匣面板" });
    const { container } = render(
      <ConclusionDoc text={"**Decision**: 定。\n- **刀三**：系统匣面板"} cuts={[cut]} stageOf={() => null} />,
    );
    const card = container.querySelector<HTMLElement>("[data-cut]")!;
    expect(card.getAttribute("data-cut")).toBe("刀三");
    expect(card.hasAttribute("data-cut-todo")).toBe(false);
    expect(card.textContent).not.toContain("尚未转出");
  });

  it("名称只写在粗体之后的旧式刀列（反引号里是识别字与文档名）卡无 data-cut-todo、无「尚未转出」", () => {
    const line = "**刀一（候选 1＋2）**：`KeyLines` 原语＋`DiscussionHead`。文档面：`util.rs`";
    const cut = engineCut(line, {
      cut: "刀一",
      title: "（候选 1＋2）",
      note: "`KeyLines` 原语＋`DiscussionHead`。文档面：`util.rs`",
      changes: ["KeyLines", "DiscussionHead", "util.rs"],
    });
    const { container } = render(<ConclusionDoc text={`**Decision**: 定。\n- ${line}`} cuts={[cut]} stageOf={() => null} />);
    const card = container.querySelector<HTMLElement>("[data-cut]")!;
    expect(card.getAttribute("data-cut")).toBe("刀一");
    expect(card.querySelector('[data-cut-change="KeyLines"]')).toBeTruthy();
    expect(card.hasAttribute("data-cut-todo")).toBe(false);
    expect(card.textContent).not.toContain("尚未转出");
  });

  it("jump 请求把该刀卡卷到画面中央并调用 onJumped", () => {
    const targets: Element[] = [];
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      targets.push(this);
    });
    const onJumped = vi.fn();
    const { container } = render(
      <ConclusionDoc text={CUTS} cuts={CUTS_ENGINE} jump={{ id: "cut 2", seq: 1 }} onJumped={onJumped} />,
    );
    expect(targets).toEqual([container.querySelector('[data-cut="cut 2"]')]);
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(onJumped).toHaveBeenCalledTimes(1);
  });

  it("jump 的目标刀卡不存在时不卷动、照样调用 onJumped", () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const onJumped = vi.fn();
    render(<ConclusionDoc text={CUTS} cuts={CUTS_ENGINE} jump={{ id: "cut 9", seq: 1 }} onJumped={onJumped} />);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(onJumped).toHaveBeenCalledTimes(1);
  });

  it("否决 14 列方案／理由、搁置其中一列无理由行且每列有时钟图标", () => {
    const { container } = render(<ConclusionDoc text={CUTS} />);
    const rejected = section(container, "conclusion.rejected");
    expect(countOf(rejected)).toBe("14");
    const rejectedRows = rejected.querySelectorAll("[data-alternative]");
    expect(rejectedRows.length).toBe(14);
    expect(rejectedRows[0].querySelector("[data-alternative-option]")!.textContent).toBe("方案 0");
    expect(rejectedRows[0].querySelector("[data-alternative-reason]")!.textContent).toBe("理由 0");
    const deferred = section(container, "conclusion.deferred");
    expect(countOf(deferred)).toBe("5");
    const deferredRows = Array.from(deferred.querySelectorAll("[data-alternative]"));
    expect(deferredRows.map((r) => r.querySelector("[data-alternative-reason]")?.textContent ?? null)).toEqual([
      "等第二个消费者",
      "不在范围",
      null,
      "理由丁",
      "理由戊",
    ]);
    for (const row of deferredRows) expect(row.querySelector("svg.lucide-clock")).toBeTruthy();
    expect(rejectedRows[0].querySelector("svg.lucide-clock")).toBeNull();
  });

  it("记录去向 desktop-app 签调用 onOpenSpec、proposal 签不可点；下一步指令签拷贝后剪贴板为指令原文", async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onOpenSpec = vi.fn();
    const { container } = render(<ConclusionDoc text={CUTS} specNames={["desktop-app"]} onOpenSpec={onOpenSpec} />);
    const capture = section(container, "conclusion.captureTo");
    expect(Array.from(capture.querySelectorAll("[data-capture-chip]")).map((c) => c.textContent)).toEqual([
      "proposal",
      "design",
      "spec（desktop-app MODIFIED）",
      "tasks",
    ]);
    fireEvent.click(within(capture).getByRole("button", { name: "desktop-app" }));
    expect(onOpenSpec).toHaveBeenCalledWith("desktop-app");
    expect(within(capture).queryByRole("button", { name: "proposal" })).toBeNull();
    const next = section(container, "conclusion.next");
    const chips = next.querySelectorAll("[data-command-chip]");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("/specseal-propose --from-discussion detail-content-redesign");
    fireEvent.click(within(chips[0] as HTMLElement).getByRole("button", { name: "拷贝指令" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("/specseal-propose --from-discussion detail-content-redesign");
  });

  it("记录去向的长句签可折行、不撑出卡片；整颗规格签维持不换行", () => {
    const long = "design 的 D3 补一段说明背景文档名称签的键盘操作与焦点顺序";
    const { container } = render(
      <ConclusionDoc text={`**Decision**: 定\n**Capture to**: desktop-app、${long}`} specNames={["desktop-app"]} onOpenSpec={() => {}} />,
    );
    const chips = Array.from(section(container, "conclusion.captureTo").querySelectorAll<HTMLElement>("[data-capture-chip]"));
    expect(chips.map((c) => c.textContent)).toEqual(["desktop-app", long]);
    expect(chips[1].className).not.toContain("shrink-0");
    expect(chips[1].className).toContain("break-words");
    expect(chips[1].className).toContain("max-w-full");
  });

  it("[data-doc-heading] 依序为决定、分刀、理由、否决替代案、搁置、记录去向、下一步", () => {
    const { container } = render(<ConclusionDoc text={CUTS} cuts={CUTS_ENGINE} />);
    expect(Array.from(container.querySelectorAll("[data-doc-heading]")).map((h) => h.textContent)).toEqual([
      "决定",
      "分刀",
      "理由",
      "否决替代案",
      "搁置",
      "记录去向",
      "下一步",
    ]);
  });

  it("以 `*` 起头的刀列不是引擎的刀：留在定案细节、没有分刀区段", () => {
    const { container } = render(<ConclusionDoc text={"**Decision**: 定。\n* **cut 3 `add-x`**: 范围"} cuts={[]} />);
    expect(section(container, "conclusion.cuts")).toBeNull();
    const decision = section(container, "conclusion.decision");
    expect(countOf(decision)).toBe("1");
    expect(decision.querySelector("[data-row-list] > li")!.textContent).toContain("cut 3");
  });

  it("旧 server 没有分刀数据（cuts 为空）：没有分刀区段，3 条刀列与 5 条细节都在定案细节", () => {
    const md = [
      "**Decision**: 定论。",
      ...Array.from({ length: 5 }, (_, i) => `- 细节 ${i + 1}`),
      "- **cut 1 `a-one`**: 一",
      "- **cut 2 `b-two`**: 二",
      "- **cut 3 `c-three`**: 三",
    ].join("\n");
    const { container } = render(<ConclusionDoc text={md} cuts={[]} />);
    expect(section(container, "conclusion.cuts")).toBeNull();
    expect(container.querySelector("[data-cut]")).toBeNull();
    expect(countOf(section(container, "conclusion.decision"))).toBe("8");
  });

  it("缺席字段不渲染空区段；记录去向切不出签时照 markdown", () => {
    const { container } = render(<ConclusionDoc text={"**Decision**: 只有决定\n**Capture to**: 写进设计文档。"} />);
    expect(section(container, "conclusion.decision")).toBeTruthy();
    expect(section(container, "conclusion.deferred")).toBeNull();
    expect(section(container, "conclusion.cuts")).toBeNull();
    const capture = section(container, "conclusion.captureTo");
    expect(capture.querySelector("[data-capture-chip]")).toBeNull();
    expect(capture.textContent).toContain("写进设计文档。");
  });

  it("自由格式整篇 Markdown、无 data-section", () => {
    const { container } = render(<ConclusionDoc text="就这样定了，大家都同意这个方向。" />);
    expect(container.querySelector("[data-section]")).toBeNull();
    expect(container.textContent).toContain("就这样定了");
  });
});

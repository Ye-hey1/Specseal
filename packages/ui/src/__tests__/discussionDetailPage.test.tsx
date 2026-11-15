import { afterEach, describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, MESSAGES, useI18n } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

afterEach(() => {
  vi.restoreAllMocks();
});

import { DiscussionDetailPage } from "../components/DiscussionDetailPage";
import type { DocumentTarget } from "../components/DetailHeader";
import { SECTION_HEADING_CLS } from "../components/DocParts";
import { ChangeCard } from "../components/ChangeCard";
import { ChangeDetailPage } from "../components/ChangeDetailPage";
import type { ChangeItem, ArchivedItem, DiscussionCut, DiscussionItem } from "../adapter";
import { DocHeader, DocTiles } from "../components/DetailShell";
import {
  discussionDocData,
  discussionDocProvenance,
  discussionDocSummary,
  type DiscussionDocData,
  type DiscussionTab,
} from "../components/discussionDocSummary";
import { promotedRows, type PromotedRow } from "../components/PromotedDoc";
import { discussionDoc, engineCut } from "./engineCuts";

// spec 需求「讨论详情页查看与转出变更」的 jsdom 可验部分。

const DOC = `---
topic: Alpha search
slug: alpha-search
status: concluded
created: 2026-07-01
---

# Discussion: Alpha search

## Context

框架脉络内容。

## Rounds

### Round 1 — assumptions (2026-07-01)

**Focus**: 范围界定

## Conclusion

**Decision**: 建置 alpha 搜索
`;

const concludedD: DiscussionItem = {
  slug: "alpha-search",
  topic: "Alpha search",
  status: "concluded",
  rounds: 1,
  created: "2026-07-01",
  promotedTo: [],
};
const promotedD: DiscussionItem = {
  ...concludedD,
  status: "promoted",
  promotedTo: ["cut-a", "cut-gone"],
};
const openD: DiscussionItem = { ...concludedD, status: "open", promotedTo: [] };

const changes: ChangeItem[] = [
  { name: "cut-a", status: "in-progress", totalTasks: 24, completedTasks: 0 },
];
const archivedChanges: ArchivedItem[] = [];

function makeProps(over: Record<string, unknown> = {}) {
  return {
    discussion: concludedD,
    loadDocument: vi.fn(async () => discussionDoc(DOC)),
    changes,
    archivedChanges,
    onOpenChangeCard: vi.fn(),
    ...over,
  };
}

// spec 需求「讨论轮以卡片呈现」的轮切分（design D1/D2）。
const ROUNDS_TEXT = `
<!-- \`### Round N — <mode> (<date>)\` entries are appended here by the CLI. -->

### Round 1 — assumptions (2026-07-08)

**Focus**: 第一轮焦点
**Position**: 总绾一句：
- 列点甲
- 列点乙
**Open**: 未解之一

### Round 2 — interview (2026-07-09)

**Focus**: 第二轮焦点
**Position**: 直答
**Note**: 这行不是字段
**Ruled out**: 淘汰项
**Open**: 无
`;

// spec 需求「讨论轮以卡片呈现」的渲染面（design D1/D2 轮卡片＋字段标签区块）。
const CARDS_DOC = `---
topic: Alpha search
slug: alpha-search
status: concluded
created: 2026-07-01
---

# Discussion: Alpha search

## Context

框架脉络内容。

## Rounds
${ROUNDS_TEXT}
## Conclusion

**Decision**: 建置 alpha 搜索
`;

describe("轮卡片渲染（讨论轮以卡片呈现）", () => {
  async function openRoundsTab(doc: string) {
    const props = makeProps({ loadDocument: vi.fn(async () => discussionDoc(doc)) });
    const result = render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => screen.getByRole("tab", { name: /讨论过程/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /讨论过程/ }));
    return result;
  }

  it("scaffold 记录逐轮成卡：卡头含 Round N、mode、日期", async () => {
    const { baseElement } = await openRoundsTab(CARDS_DOC);
    await waitFor(() =>
      expect(baseElement.querySelectorAll("[data-round]").length).toBe(2),
    );
    const card1 = baseElement.querySelector('[data-round="1"]') as HTMLElement;
    const roundChip = within(card1).getByText("Round 1");
    expect(roundChip).toBeTruthy();
    expect(within(card1).getByText("assumptions")).toBeTruthy();
    expect(within(card1).getByText("2026-07-08")).toBeTruthy();
    // 轮次签是静态编号，与同列 mode／日期同层级：走中性，不占用主色。
    expect(roundChip.className).toContain("bg-muted");
    expect(roundChip.className).not.toContain("primary");
  });

  it("卡头含焦点、字段以标签呈现，「**Focus**:」粗体前缀原文不出现", async () => {
    const { baseElement } = await openRoundsTab(CARDS_DOC);
    await waitFor(() => screen.getByText("第一轮焦点"));
    const card1 = baseElement.querySelector('[data-round="1"]') as HTMLElement;
    expect(card1.querySelector("button[aria-expanded]")!.textContent).toContain("第一轮焦点");
    expect(within(card1).getByText("立场")).toBeTruthy();
    expect(within(card1).getByText("未解")).toBeTruthy();
    // 旧行为把 **Focus**: 渲染成粗体 Focus 文本；卡片模式下英文前缀不再出现。
    expect(screen.queryByText("Focus")).toBeNull();
    expect(screen.queryByText("Position")).toBeNull();
  });

  it("缺席字段不渲染空标签", async () => {
    const { baseElement } = await openRoundsTab(CARDS_DOC);
    await waitFor(() => screen.getByText("第一轮焦点"));
    const card1 = baseElement.querySelector('[data-round="1"]') as HTMLElement;
    const card2 = baseElement.querySelector('[data-round="2"]') as HTMLElement;
    expect(within(card1).queryByText("淘汰")).toBeNull();
    expect(within(card2).getByText("淘汰")).toBeTruthy();
  });

  it("非标准轮标题整篇以单一 markdown 查看退回", async () => {
    const bad = CARDS_DOC.replace("### Round 2 — interview (2026-07-09)", "### 插入的手写标题");
    const { baseElement } = await openRoundsTab(bad);
    await waitFor(() => screen.getByText("插入的手写标题"));
    expect(baseElement.querySelectorAll("[data-round]").length).toBe(0);
  });

  // spec「详情页的文档树、阅读卡与本页目录」的「讨论文档的本页目录锚点」：本页目录自 DOM 推导，跟着轮卡由新到旧。
  it("本页目录的轮次锚点与轮卡同序：Round 2 在前、Round 1 在后", async () => {
    const { baseElement } = await openRoundsTab(CARDS_DOC);
    const toc = () => baseElement.querySelector("[data-detail-toc]") as HTMLElement;
    await waitFor(() =>
      expect(Array.from(toc().querySelectorAll("[data-manual-anchor]")).map((a) => a.textContent)).toEqual([
        "Round 2",
        "Round 1",
      ]),
    );
    expect(baseElement.querySelector("[data-round-timeline] [data-round]")!.getAttribute("data-round")).toBe("2");
  });
});

// spec 需求「讨论结论以字段标签呈现」（design D7 六词白名单共用字段解析）。
function docWithConclusion(conclusion: string): string {
  return DOC.replace("**Decision**: 建置 alpha 搜索", conclusion);
}

// spec Scenario「未转出刀的提示框与前往」：cut 1 已转出、cut 2 尚未转出。
const WAD_DECISION = [
  "**Decision**: 分两刀。",
  "- **cut 1 `add-team-plugin-library`**: 团队插件库",
  "- **cut 2 `remove-builtin-wad-work`**: 移除内置 wad-work",
].join("\n");

/** 引擎对 WAD_DECISION 回的两把刀：`promoted` 之外的变更名尚未转出。 */
const wadCuts = (promoted: string[]) =>
  [
    ["**cut 1 `add-team-plugin-library`**: 团队插件库", "cut 1", "团队插件库", "add-team-plugin-library"],
    ["**cut 2 `remove-builtin-wad-work`**: 移除内置 wad-work", "cut 2", "移除内置 wad-work", "remove-builtin-wad-work"],
  ].map(([line, cut, title, name]) =>
    engineCut(line, { cut, title, changes: [name], changesInBold: true, unpromoted: promoted.includes(name) ? [] : [name] }),
  );

const FULL_CONCLUSION = [
  "**Decision**: 拍板做 A",
  "**Rationale**: 因为证据充分",
  "**Rejected alternatives**: B 案——太贵",
  "**Deferred**: 无",
  "**Capture to**: proposal",
  "**Next**: /specseal-propose --from-discussion alpha-search",
].join("\n");

describe("结论字段标签化（讨论结论以字段标签呈现）", () => {
  // 字段标签同时是本页目录的锚点：断言限定在阅读卡内文。
  const body = () => within(document.querySelector("[data-doc-body]") as HTMLElement);
  it("scaffold 结论六字段成标签区块，粗体前缀原文不出现", async () => {
    const props = makeProps({ loadDocument: vi.fn(async () => discussionDoc(docWithConclusion(FULL_CONCLUSION))) });
    render(<DiscussionDetailPage {...(props as never)} />);
    // 结论非空 → 缺省分页即结论。
    await waitFor(() => expect(screen.getByText("拍板做 A")).toBeTruthy());
    for (const label of ["决定", "理由", "否决替代案", "搁置", "记录去向", "下一步"]) {
      expect(body().getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText("Decision")).toBeNull();
    expect(screen.queryByText("Rationale")).toBeNull();
  });

  it("缺席字段不渲染空标签", async () => {
    const doc = docWithConclusion("**Decision**: 只有决定\n**Rationale**: 与理由");
    const props = makeProps({ loadDocument: vi.fn(async () => discussionDoc(doc)) });
    render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("只有决定")).toBeTruthy());
    expect(body().getByText("决定")).toBeTruthy();
    expect(body().getByText("理由")).toBeTruthy();
    expect(screen.queryByText("搁置")).toBeNull();
    expect(screen.queryByText("下一步")).toBeNull();
  });

  // 段落标签从 20px 粗体大标改为 16px 章节标题（detail-content-redesign 结论）。
  it("结论字段的区段标题为 16px 粗体章节标题", async () => {
    const props = makeProps({ loadDocument: vi.fn(async () => discussionDoc(docWithConclusion(FULL_CONCLUSION))) });
    render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => expect(body().getByText("决定")).toBeTruthy());
    const conclusionLabel = body().getByText("决定");
    for (const cls of SECTION_HEADING_CLS.split(" ")) expect(conclusionLabel.className).toContain(cls);
    expect(conclusionLabel.className).not.toContain("text-xl");
  });

  it("结论的分刀卡变更签点击打开已封存详情页（onOpenArchivedChange 收到 datedName）", async () => {
    const onOpenArchivedChange = vi.fn();
    const props = makeProps({
      discussion: { ...concludedD, status: "promoted", promotedTo: ["cut-old"] },
      archivedChanges: [{ datedName: "2026-07-20-cut-old", date: "2026-07-20", name: "cut-old" }],
      onOpenArchivedChange,
      loadDocument: vi.fn(async () =>
        discussionDoc(docWithConclusion("**Decision**: 一刀\n- **cut 1 `cut-old`**: 骨架"), [
          engineCut("**cut 1 `cut-old`**: 骨架", { cut: "cut 1", title: "骨架", changes: ["cut-old"], changesInBold: true }),
        ]),
      ),
    });
    render(<DiscussionDetailPage {...(props as never)} />);
    const card = await waitFor(() => {
      const el = document.querySelector('[data-cut="cut 1"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(card).getByText("已封存")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "cut-old" }));
    expect(onOpenArchivedChange).toHaveBeenCalledWith("2026-07-20-cut-old");
  });

  it("点提示框的「前往」后 cut 2 的刀卡被卷动", async () => {
    const targets: Element[] = [];
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      targets.push(this);
    });
    const props = makeProps({
      discussion: {
        ...concludedD,
        slug: "wad-plugins-merge-or-split",
        status: "promoted",
        concluded: true,
        hold: true,
        promotedTo: ["add-team-plugin-library"],
      },
      changes: [{ name: "add-team-plugin-library", status: "in-progress", totalTasks: 3, completedTasks: 1 }],
      loadDocument: vi.fn(async () => discussionDoc(docWithConclusion(WAD_DECISION), wadCuts(["add-team-plugin-library"]))),
    });
    render(<DiscussionDetailPage {...(props as never)} />);
    const row = await waitFor(() => {
      const el = document.querySelector("[data-doc-callout] [data-unpromoted-cut]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    // cut 1 已转出：一般外框、变更名签附「进行中」阶段签。
    const cut1 = document.querySelector('[data-cut="cut 1"]') as HTMLElement;
    expect(cut1.hasAttribute("data-cut-todo")).toBe(false);
    expect(within(cut1).getByText("进行中")).toBeTruthy();
    targets.length = 0;
    scrollSpy.mockClear();
    fireEvent.click(within(row).getByRole("button", { name: /前往/ }));
    await waitFor(() => expect(targets).toEqual([document.querySelector('[data-cut="cut 2"]')]));
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
  });

  it("自由格式结论整篇以单一 markdown 查看退回", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async () => discussionDoc(docWithConclusion("就这样定了，大家都同意这个方向。"))),
    });
    render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/就这样定了/)).toBeTruthy());
    expect(screen.queryByText("决定")).toBeNull();
  });
});

const OPEN_DOC = `---
topic: Alpha search
slug: alpha-search
status: open
created: 2026-07-01
---

# Discussion: Alpha search

## Context

开放讨论的背景内容。

## Rounds

### Round 1 — assumptions (2026-07-01)

**Focus**: 范围界定

## Conclusion

<!-- Written by specseal discuss conclude -->
`;

describe("DiscussionDetailPage", () => {
  it("分页依序为 结论/讨论过程 N/背景/衍生变更，结论非空时缺省呈现结论", async () => {
    render(<DiscussionDetailPage {...(makeProps() as never)} />);
    // 缺省分页＝结论（读者第一想看的），无需切换即可见。
    await waitFor(() => expect(screen.getByText(/建置 alpha 搜索/)).toBeTruthy());
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    expect(tabs[0]).toContain("结论");
    expect(tabs[1]).toContain("讨论过程");
    expect(tabs[1]).toContain("1");
    expect(tabs[2]).toContain("背景");
    expect(tabs[3]).toContain("衍生变更");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /讨论过程/ }));
    expect(screen.getByText(/范围界定/)).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /背景/ }));
    expect(screen.getByText(/框架脉络内容/)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /脉络/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /^促转$/ })).toBeNull();
  });

  it("创建者圆标为中性，不占用主色（五处头像同款）", async () => {
    const withAuthor = { ...concludedD, createdBy: "Momo Chen" };
    render(<DiscussionDetailPage {...(makeProps({ discussion: withAuthor }) as never)} />);
    const avatar = await waitFor(() => {
      const el = Array.from(document.querySelectorAll("span")).find(
        (s) => s.textContent === "M" && s.className.includes("rounded-full"),
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(avatar.className).toContain("bg-muted");
    expect(avatar.className).not.toContain("bg-primary");
  });

  it("结论为空（仅鹰架注解）时缺省呈现背景", async () => {
    const props = makeProps({ discussion: openD, loadDocument: vi.fn(async () => discussionDoc(OPEN_DOC)) });
    render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/开放讨论的背景内容/)).toBeTruthy());
  });

  it("状态卡阶段列：四站可见且现站可辨（已封存站保留给已封存讨论页）", async () => {
    const stageRow = () => document.querySelector("[data-status-stage]") as HTMLElement;
    // concluded → 现站「已结论」。
    const { unmount } = render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(stageRow()).toBeTruthy());
    const row = stageRow();
    for (const label of ["讨论中", "已结论", "已转出", "已封存"]) expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).getByText("已结论").closest("[aria-current]")).toBeTruthy();
    expect(within(row).getByText("讨论中").closest("[aria-current]")).toBeNull();
    unmount();
    // promoted → 现站「已转出」。
    render(<DiscussionDetailPage {...(makeProps({ discussion: promotedD }) as never)} />);
    await waitFor(() => expect(stageRow()).toBeTruthy());
    expect(within(stageRow()).getByText("已转出").closest("[aria-current]")).toBeTruthy();
    expect(within(stageRow()).getByText("已封存").closest("[aria-current]")).toBeNull();
  });

  it("非预期格式整篇以单一查看退回（无背景分页、全文可见）", async () => {
    const props = makeProps({
      loadDocument: vi.fn(async () => discussionDoc("手写的自由格式记录，没有标准区段。")),
    });
    render(<DiscussionDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/自由格式记录/)).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /背景/ })).toBeNull();
  });

  it("衍生变更分页列出子变更现况；存活者可跳转、已删除者不可", async () => {
    const props = makeProps({ discussion: promotedD });
    render(<DiscussionDetailPage {...(props as never)} />);
    // 先等文档加载落定（section 分页组挂上、背景分页出现）再切衍生变更：否则
    // loadDocument resolve 会把 fallback 分页组换成 sections 分页组（key 变、重新
    // mount），选中分页重置回缺省，衍生变更面板被隐藏、cut-a 从 DOM 消失。与本档
    // 其他分页测试一致的等待。
    await screen.findByRole("tab", { name: /背景/ });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    // 状态卡的衍生变更签也列同名——分页内的列以分页面板为范围。
    const panel = screen.getByRole("tabpanel");
    const rowA = within(panel).getByText("cut-a").closest("[data-promoted-row]") as HTMLElement;
    expect(within(rowA).getByText("提案中")).toBeTruthy();
    fireEvent.click(within(rowA).getByRole("button", { name: /打开卡片/ }));
    expect(props.onOpenChangeCard).toHaveBeenCalledWith("cut-a");
    const rowGone = within(panel).getByText("cut-gone").closest("[data-promoted-row]") as HTMLElement;
    expect(within(rowGone).getByText("已删除")).toBeTruthy();
    expect(within(rowGone).queryByRole("button", { name: /打开卡片/ })).toBeNull();
  });

  it("衍生变更分页唯读：concluded／promoted 皆无「转为变更／再转出一个变更」动作（D3）", async () => {
    // promote 已自 GUI 撤除——衍生变更分页只列子变更与跳转，无任何转出钮。
    // 各实例先等初始加载落地（标准格式解析出「背景」分页），避免 act 警告。
    const { unmount } = render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(screen.queryByRole("button", { name: /转为变更/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /促转/ })).toBeNull();
    unmount();

    const { unmount: unmount2 } = render(
      <DiscussionDetailPage {...(makeProps({ discussion: promotedD }) as never)} />,
    );
    await screen.findByRole("tab", { name: /背景/ });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(screen.queryByRole("button", { name: /再转出一个变更/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /转为变更/ })).toBeNull();
    unmount2();

    const props3 = makeProps({ discussion: openD, loadDocument: vi.fn(async () => discussionDoc(OPEN_DOC)) });
    render(<DiscussionDetailPage {...(props3 as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(screen.queryByRole("button", { name: /转为变更/ })).toBeNull();
  });
});

describe("change 侧同源链接", () => {
  it("来自讨论的 change 卡带单一讨论徽章；无来源者不带", () => {
    const withSource: ChangeItem = {
      name: "cut-a",
      status: "in-progress",
      totalTasks: 24,
      completedTasks: 0,
      fromDiscussions: ["alpha-search"],
    };
    const { unmount } = render(<ChangeCard change={withSource} />);
    expect(screen.getByLabelText("来自讨论")).toBeTruthy();
    unmount();
    render(<ChangeCard change={{ ...withSource, fromDiscussions: [] }} />);
    expect(screen.queryByLabelText("来自讨论")).toBeNull();
  });

  it("多来源的 change 卡仍是单一徽章、以主题化提示取代原生 title（D3）", () => {
    const multi: ChangeItem = {
      name: "cut-a",
      status: "in-progress",
      totalTasks: 24,
      completedTasks: 0,
      fromDiscussions: ["alpha-search", "beta-cache"],
    };
    render(<ChangeCard change={multi} />);
    // 单一徽章（不因多来源而增生）。
    expect(screen.getAllByLabelText("来自讨论")).toHaveLength(1);
    // D3：改用 shadcn Tooltip——徽章不再带原生 title（提示列出全部来源于 hover 呈现，实窗验证）。
    expect(screen.getByLabelText("来自讨论").getAttribute("title")).toBeNull();
  });

  it("change 详情页列出全部来源讨论与同源清单并可互跳", async () => {
    const onOpenDiscussion = vi.fn();
    const onOpenSibling = vi.fn();
    const change: ChangeItem = {
      name: "cut-a",
      status: "in-progress",
      totalTasks: 24,
      completedTasks: 0,
      fromDiscussions: ["alpha-search", "beta-cache"],
    };
    render(
      <ChangeDetailPage
        change={change}
        loadDocument={vi.fn(async () => "# doc")}
        loadCapabilities={vi.fn(async () => [])}
        loadMeta={vi.fn(async () => ({ created: "2026-07-05" }))}
        sourceDiscussions={[
          { slug: "alpha-search", topic: "Alpha search" },
          { slug: "beta-cache", topic: "Beta cache" },
        ]}
        siblingChanges={["cut-b"]}
        onOpenDiscussion={onOpenDiscussion}
        onOpenSibling={onOpenSibling}
      />,
    );
    await waitFor(() => expect(screen.getByText("来自")).toBeTruthy());
    // 全部来源讨论可及并互跳（change-drawer-header-redesign：首签 slug 直出、其余经 +N 浮层）。
    fireEvent.click(screen.getByRole("button", { name: /alpha-search/ }));
    expect(onOpenDiscussion).toHaveBeenCalledWith("alpha-search");
    fireEvent.click(screen.getByRole("button", { name: /其余 1 份/ }));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-source-overflow-list]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(within(popover).getByRole("button", { name: /beta-cache/ }));
    expect(onOpenDiscussion).toHaveBeenCalledWith("beta-cache");
    fireEvent.click(screen.getByRole("button", { name: /cut-b/ }));
    expect(onOpenSibling).toHaveBeenCalledWith("cut-b");
  });
});

describe("DiscussionDetailPage 世代重载（spec：外部推进讨论后页内容更新）", () => {
  it("refreshGen 递增时重载记录，回合分页呈现新回合且分页选择不重置", async () => {
    const props = makeProps();
    const { rerender } = render(<DiscussionDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => screen.getByRole("tab", { name: /讨论过程/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /讨论过程/ }));
    await waitFor(() => expect(screen.getByText(/范围界定/)).toBeTruthy());
    const calls = () => (props.loadDocument as ReturnType<typeof vi.fn>).mock.calls.length;
    const c0 = calls();
    // 外部 specseal discuss add-round 后 watcher 触发 refresh → 世代递增。
    const DOC2 = DOC.replace(
      "## Conclusion",
      "### Round 2 — assumptions (2026-07-02)\n\n**Focus**: 第二轮新内容\n\n## Conclusion",
    );
    (props.loadDocument as ReturnType<typeof vi.fn>).mockResolvedValue(discussionDoc(DOC2));
    rerender(<DiscussionDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(calls()).toBeGreaterThan(c0));
    await waitFor(() => expect(screen.getByText(/第二轮新内容/)).toBeTruthy());
    // 旧回合仍在、分页停留在讨论过程——重载为就地替换，非重开页。
    expect(screen.getByText(/范围界定/)).toBeTruthy();
  });
});

// spec 需求「讨论详情页查看与转出变更」：页标题以 slug 为题（等宽）＋拷贝钮、
// topic 为标题下方一行（LANGUAGE.md 受控例外）。
describe("DiscussionDetailPage 标题 slug 化（design D4）", () => {
  it("标题呈 slug（等宽字体）、topic 降为副标、拷贝钮写入剪贴板", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    const title = screen.getByText("alpha-search");
    expect(title.className).toContain("font-mono");
    expect(screen.getByText("Alpha search")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "拷贝 slug" }));
    expect(writeText).toHaveBeenCalledWith("alpha-search");
    // 共用 CopyButton：成功以 status 声明「已拷贝」。
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已拷贝"));
  });
});

// spec 需求「markdown 文档内容行宽有上限」（design D4）与「详情页的文档树、阅读卡与本页目录」：
// 阅读卡内文为共用置中容器，讨论轮卡片与内文同栏对齐置中；阅读区内容栏 768px 置中。
describe("讨论详情页阅读栏置中", () => {
  // spec「markdown 文档内容行宽有上限」（desktop-change-doc-views design D10）：阅读卡内以 768px 卡栏为上限，不再另套 96ch。
  it("阅读卡内文撑满卡栏（w-full、无 96ch）且轮卡片在栏内", async () => {
    const { baseElement } = render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /讨论过程/ });
    const col = baseElement.querySelector("[data-doc-body]") as HTMLElement;
    expect(col).toBeTruthy();
    expect(col.className).toContain("w-full");
    expect(col.className).not.toContain("max-w-[96ch]");
    const page = baseElement.querySelector("[data-discussion-detail]") as HTMLElement;
    const frame = page.querySelector("[data-detail-reading]")!.firstElementChild as HTMLElement;
    expect(frame.className).toContain("max-w-[768px]");
    expect(frame.contains(col)).toBe(true);
    // 结论分页（缺省）内文在栏内。
    expect(within(col).getByText("建置 alpha 搜索")).toBeTruthy();
    // 讨论过程分页：轮卡片同栏。
    fireEvent.mouseDown(screen.getByRole("tab", { name: /讨论过程/ }));
    expect(col.querySelector("[data-round]")).toBeTruthy();
  });
});

// spec「讨论详情页查看与转出变更」页内封存场景:concluded 且未封存(宿主提供
// handler)才出现;走与讨论卡同一 onArchiveDiscussion 调用(确认流程在宿主)。
describe("页内封存动词", () => {
  it("concluded 讨论显示封存动作,点击触发 onArchiveDiscussion", async () => {
    const onArchiveDiscussion = vi.fn();
    render(<DiscussionDetailPage {...(makeProps({ onArchiveDiscussion }) as never)} />);
    const btn = await screen.findByRole("button", { name: /封存/ });
    fireEvent.click(btn);
    expect(onArchiveDiscussion).toHaveBeenCalledWith("alpha-search");
  });

  it("非 concluded(open/promoted)不显示封存动作", async () => {
    render(
      <DiscussionDetailPage
        {...(makeProps({ discussion: openD, onArchiveDiscussion: vi.fn() }) as never)}
      />,
    );
    await screen.findByText("Alpha search");
    expect(screen.queryByRole("button", { name: /封存/ })).toBeNull();

    render(
      <DiscussionDetailPage
        {...(makeProps({ discussion: promotedD, onArchiveDiscussion: vi.fn() }) as never)}
      />,
    );
    expect(screen.queryByRole("button", { name: /封存/ })).toBeNull();
  });

  it("已封存(宿主不提供 handler)不显示封存动作", async () => {
    render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByText("Alpha search");
    expect(screen.queryByRole("button", { name: /封存/ })).toBeNull();
  });
});

// spec「详情页文档加载以 skeleton 呈现」：讨论详情页加载中画骨架。
describe("讨论详情页文档三态", () => {
  it("加载中 → 文档骨架，不出空态文案", async () => {
    render(
      <DiscussionDetailPage
        {...(makeProps({ loadDocument: vi.fn(() => new Promise<never>(() => {})) }) as never)}
      />,
    );
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（无内容）")).toBeNull();
  });

  it("加载完成且记录不存在 → 空态文案，无骨架", async () => {
    render(<DiscussionDetailPage {...(makeProps({ loadDocument: vi.fn(async () => null) }) as never)} />);
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("首载失败 → 落到空态文案，不停在骨架", async () => {
    render(
      <DiscussionDetailPage
        {...(makeProps({ loadDocument: vi.fn().mockRejectedValue(new Error("offline")) }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

// spec「讨论详情页查看与转出变更」Scenario「状态卡的保留与衍生列」（design D7）：
// 标题列状态签、阶段列现站、保留在途列与衍生变更签列。
describe("讨论详情页状态卡的保留与衍生列", () => {
  const heldD: DiscussionItem = {
    ...concludedD,
    status: "promoted",
    concluded: true,
    hold: true,
    promotedTo: ["cut-old", "cut-b"],
  };
  const liveChanges: ChangeItem[] = [
    { name: "cut-b", status: "in-progress", totalTasks: 10, completedTasks: 3 },
  ];
  const archived: ArchivedItem[] = [{ datedName: "2026-07-20-cut-old", date: "2026-07-20", name: "cut-old" }];
  const row = (mark: string) => document.querySelector(`[data-status-${mark}]`) as HTMLElement | null;

  it("promoted＋hold＋两项衍生：保留中状态签、现站已转出、保留列、两颗签带阶段、点进行中签跳转、封存停用", async () => {
    const onOpenChangeCard = vi.fn();
    const onArchiveDiscussion = vi.fn();
    render(
      <DiscussionDetailPage
        {...(makeProps({
          discussion: heldD,
          changes: liveChanges,
          archivedChanges: archived,
          onOpenChangeCard,
          onArchiveDiscussion,
        }) as never)}
      />,
    );
    await screen.findByRole("tab", { name: /背景/ });
    const status = document.querySelector("[data-discussion-status]") as HTMLElement;
    expect(status.textContent).toBe("已转出・保留中");
    expect(status.className).toContain("text-status-warning");
    expect(within(row("stage")!).getByText("已转出").closest("[aria-current]")).toBeTruthy();
    expect(row("hold")!.textContent).toContain("结论保留在途；最后一刀转出后自动封存");
    const old = document.querySelector('[data-promoted-chip="cut-old"]') as HTMLElement;
    const live = document.querySelector('[data-promoted-chip="cut-b"]') as HTMLElement;
    expect(row("promoted")!.contains(old) && row("promoted")!.contains(live)).toBe(true);
    expect(within(old).getByText("已封存")).toBeTruthy();
    expect(within(live).getByText("进行中")).toBeTruthy();
    fireEvent.click(within(live).getByRole("button", { name: "cut-b" }));
    expect(onOpenChangeCard).toHaveBeenCalledWith("cut-b");
    expect((within(old).getByRole("button", { name: "cut-old" }) as HTMLButtonElement).disabled).toBe(true);
    const archive = screen.getByRole("button", { name: /封存/ }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    fireEvent.click(archive);
    expect(onArchiveDiscussion).not.toHaveBeenCalled();
  });

  // spec Scenario「状态卡的保留与衍生列」「尚无结论的已转出讨论的步骤列」「已转出且未保留的讨论现站为主色」：
  // 步骤列现站与身分区状态签同色；尚无结论时「已结论」站不打勾。
  const current = () => row("stage")!.querySelector('[aria-current="step"]') as HTMLElement;
  const station = (label: string) => within(row("stage")!).getByText(label);

  it("hold 为 true 的已转出讨论：现站为 warning 色、「已结论」站打勾", async () => {
    render(<DiscussionDetailPage {...(makeProps({ discussion: heldD, changes: liveChanges, archivedChanges: archived }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(current().textContent).toBe("已转出");
    expect(current().className).toContain("status-warning");
    expect(station("已结论").querySelector("svg.lucide-check")).toBeTruthy();
  });

  it("concluded 为 false 的已转出讨论：现站为 warning 色、「已结论」站为未到站灰圈", async () => {
    const unconcluded: DiscussionItem = { ...concludedD, status: "promoted", concluded: false, promotedTo: ["cut-b"] };
    render(<DiscussionDetailPage {...(makeProps({ discussion: unconcluded, changes: liveChanges }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect((document.querySelector("[data-discussion-status]") as HTMLElement).textContent).toBe("已转出・尚无结论");
    expect(current().textContent).toBe("已转出");
    expect(current().className).toContain("status-warning");
    const concluded = station("已结论");
    expect(concluded.querySelector("svg.lucide-check")).toBeNull();
    expect(concluded.querySelector("svg.lucide-circle")).toBeTruthy();
    expect(concluded.className).toContain("text-muted-foreground/50");
    expect(station("讨论中").querySelector("svg.lucide-check")).toBeTruthy();
    expect(station("已封存").querySelector("svg.lucide-circle")).toBeTruthy();
  });

  it("hold 为 false、已结论的已转出讨论：现站为主色", async () => {
    const collapsed: DiscussionItem = { ...heldD, hold: false };
    render(<DiscussionDetailPage {...(makeProps({ discussion: collapsed, changes: liveChanges, archivedChanges: archived }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(current().className).toContain("primary");
    expect(current().className).not.toContain("status-warning");
    expect(station("已结论").querySelector("svg.lucide-check")).toBeTruthy();
  });

  it("无 hold 无 promoted_to 时保留列与衍生列缺席", async () => {
    render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(row("stage")).toBeTruthy();
    expect(row("hold")).toBeNull();
    expect(row("promoted")).toBeNull();
  });

  it("分页标头：讨论过程 N 与衍生变更 N 带计数", async () => {
    render(<DiscussionDetailPage {...(makeProps({ discussion: promotedD }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(screen.getByRole("tab", { name: /讨论过程/ }).textContent).toContain("1");
    expect(screen.getByRole("tab", { name: /衍生变更/ }).textContent).toContain("2");
  });
});

// spec「详情页的文档动作」：讨论各分页皆为讨论记录档（磁盘位置——含已封存的日期文档名——由宿主解析）。
describe("讨论详情页的文档动作槽", () => {
  it("回报讨论 slug 与记录原文，渲染在阅读卡标题列", async () => {
    const renderDocumentActions = vi.fn((target: DocumentTarget | null) =>
      target ? <button type="button">打开记录</button> : null,
    );
    render(<DiscussionDetailPage {...(makeProps({ renderDocumentActions }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(renderDocumentActions).toHaveBeenLastCalledWith({ doc: { discussion: "alpha-search" }, content: DOC });
    const docHeader = document.querySelector("[data-doc-header]") as HTMLElement;
    expect(within(docHeader).getByRole("button", { name: "打开记录" })).toBeTruthy();
  });
});

// spec「讨论详情页查看与转出变更」：身分区「关联」列（自背景的 Prior discussions 行计数、
// none 或缺行时缺席、点击切到背景）；封存动作经 DetailActions 进标题列（无宿主时原地）。
describe("讨论详情页的关联列与标题列动作", () => {
  const withPrior = (line: string) => DOC.replace("框架脉络内容。", `框架脉络内容。\n\n${line}`);

  it("Prior discussions 三笔时关联列显示「先前讨论 3」，点击切到背景", async () => {
    const props = makeProps({ loadDocument: vi.fn(async () => discussionDoc(withPrior("Prior discussions: a-one, b-two, c-three"))) });
    render(<DiscussionDetailPage {...(props as never)} />);
    const related = await waitFor(() => {
      const el = document.querySelector("[data-relation-related]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(related).getByText("关联")).toBeTruthy();
    // 缺省文档为结论；点关联签切到背景。
    expect(screen.getByRole("tab", { name: /结论/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(related).getByRole("button", { name: "先前讨论 3" }));
    expect(screen.getByRole("tab", { name: /背景/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/框架脉络内容/)).toBeTruthy();
  });

  it("顿号分隔且带括号备注时依项目计数（括号内的逗号不算）", async () => {
    const line = "Prior discussions: alpha-one（备注，含逗号）、beta-two（另一则）";
    render(<DiscussionDetailPage {...(makeProps({ loadDocument: vi.fn(async () => discussionDoc(withPrior(line))) }) as never)} />);
    const related = await waitFor(() => {
      const el = document.querySelector("[data-relation-related]") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(related).getByRole("button").textContent).toBe("先前讨论 2");
  });

  it("Prior discussions 为 none 或缺行时无关联列", async () => {
    const r = render(
      <DiscussionDetailPage
        {...(makeProps({ loadDocument: vi.fn(async () => discussionDoc(withPrior("Prior discussions: none"))) }) as never)}
      />,
    );
    await screen.findByRole("tab", { name: /背景/ });
    expect(document.querySelector("[data-relation-related]")).toBeNull();
    r.unmount();
    render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(document.querySelector("[data-relation-related]")).toBeNull();
  });

  it("记录路径依数据源的规格文档夹组成（spec Scenario「讨论详情的记录路径」）", async () => {
    const r = render(
      <DiscussionDetailPage
        {...(makeProps({ discussion: { ...promotedD, slug: "board-search-bar" }, specDir: "specseal" }) as never)}
      />,
    );
    await screen.findByRole("tab", { name: /背景/ });
    const provenance = () => document.querySelector("[data-doc-header] [data-doc-provenance]")?.textContent;
    expect(provenance()).toContain("specseal/discussions/board-search-bar.md");
    r.unmount();
    render(<DiscussionDetailPage {...(makeProps({ discussion: promotedD, specDir: "openspec" }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    expect(provenance()).toContain("openspec/discussions/alpha-search.md");
  });

  it("阅读卡出处行依文档切换", async () => {
    render(<DiscussionDetailPage {...(makeProps({ discussion: promotedD }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    const provenance = () => document.querySelector("[data-doc-header] [data-doc-provenance]")?.textContent;
    // 数据源没带规格文档夹时以缺省 specseal 组成。
    expect(provenance()).toBe("specseal/discussions/alpha-search.md·1 轮之后写入");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /讨论过程/ }));
    expect(provenance()).toBe("2026-07-01·assumptions 1 轮");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /背景/ }));
    expect(provenance()).toBe("记录创建时写入一次·2026-07-01");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(provenance()).toBe("依转出顺序");
  });

  it("背景的规格签调用 onOpenSpec、讨论签调用 onOpenDiscussion", async () => {
    const onOpenSpec = vi.fn();
    const onOpenDiscussion = vi.fn();
    const doc = DOC.replace("框架脉络内容。", "框架脉络提到 desktop-app 与 beta-talk，也提到自己 alpha-search。");
    render(
      <DiscussionDetailPage
        {...(makeProps({
          loadDocument: vi.fn(async () => discussionDoc(doc)),
          specNames: ["desktop-app"],
          discussionSlugs: ["alpha-search", "beta-talk"],
          onOpenSpec,
          onOpenDiscussion,
        }) as never)}
      />,
    );
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /背景/ }));
    const chip = await waitFor(() => {
      const el = document.querySelector('[data-name-chip="spec:desktop-app"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(chip);
    expect(onOpenSpec).toHaveBeenCalledWith("desktop-app");
    fireEvent.click(document.querySelector('[data-name-chip="discussion:beta-talk"]')!);
    expect(onOpenDiscussion).toHaveBeenCalledWith("beta-talk");
    expect(document.querySelector('[data-name-chip="discussion:alpha-search"]')).toBeNull();
  });

  it("换讨论时即使同为结论文档，阅读区也卷回顶端", async () => {
    const { rerender } = render(<DiscussionDetailPage {...(makeProps() as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    const reading = document.querySelector("[data-detail-reading]") as HTMLElement;
    reading.scrollTop = 300;
    rerender(<DiscussionDetailPage {...(makeProps({ discussion: { ...concludedD, slug: "beta-search" } }) as never)} />);
    expect((document.querySelector("[data-detail-reading]") as HTMLElement).scrollTop).toBe(0);
    await screen.findByRole("tab", { name: /背景/ });
  });

  it("封存钮在 DetailActions 内，不在左栏与阅读卡", async () => {
    render(<DiscussionDetailPage {...(makeProps({ onArchiveDiscussion: vi.fn() }) as never)} />);
    await screen.findByRole("tab", { name: /背景/ });
    const actions = document.querySelector("[data-detail-actions]") as HTMLElement;
    const archive = within(actions).getByRole("button", { name: /封存/ });
    expect(document.querySelector("[data-detail-tree]")!.contains(archive)).toBe(false);
    expect(document.querySelector("[data-doc-header]")!.contains(archive)).toBe(false);
  });
});


// spec「讨论结论以字段标签呈现」「讨论轮以卡片呈现」「讨论详情页查看与转出变更」的数字砖、出处行与提示框
// （desktop-discussion-doc-views design D6）：推导入口的输出直接画进阅读卡的标题区零件。
describe("数字砖、出处行与提示框", () => {
  const NAMES = { specs: [], active: [], archived: [], discussions: [] };
  const t = (key: string) => MESSAGES["zh-CN"][key] ?? key;
  const live = (name: string, done: number, total: number): ChangeItem => ({
    name,
    status: "ready",
    totalTasks: total,
    completedTasks: done,
  });
  const roundsOf = (modes: string[], dates: string[], lastOpen = "无：写入结论") =>
    modes
      .map(
        (mode, i) =>
          `### Round ${i + 1} — ${mode} (${dates[i]})\n\n**Focus**: 第 ${i + 1} 轮\n**Position**: 立场${
            i === modes.length - 1 ? `\n**Open**: ${lastOpen}` : ""
          }`,
      )
      .join("\n\n");
  const record = (rounds: string, conclusion: string, context = "背景。") =>
    `# Discussion\n\n## Context\n\n${context}\n\n## Rounds\n\n${rounds}\n\n## Conclusion\n\n${conclusion}\n`;

  function Harness({ tab, data }: { tab: DiscussionTab; data: DiscussionDocData }) {
    const { t, tn } = useI18n();
    const summary = discussionDocSummary(tab, data, { t, tn });
    return (
      <>
        <DocHeader title="文档" provenance={discussionDocProvenance(tab, data, { t, tn })} />
        <DocTiles tiles={summary.tiles} />
        {summary.callout && <div data-doc-callout>{summary.callout}</div>}
      </>
    );
  }
  const tiles = () =>
    Array.from(document.querySelectorAll("[data-doc-tile]")).map((tile) =>
      Array.from(tile.children).map((c) => c.textContent),
    );
  const provenance = () => document.querySelector("[data-doc-provenance]")?.textContent ?? null;
  const callout = () => document.querySelector("[data-doc-callout]") as HTMLElement | null;

  it("讨论过程的数字砖、出处行与已收敛提示框", () => {
    const modes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "assumptions" : "interview"));
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(modes, Array(20).fill("2026-10-08")), "**Decision**: 定案")),
      status: "concluded",
      hold: false,
      created: "2026-10-08",
      recordPath: "openspec/discussions/demo.md",
      rows: [],
      names: NAMES,
    });
    render(<Harness tab="rounds" data={data} />);
    expect(tiles()).toEqual([
      ["20", "轮"],
      ["1", "天"],
      ["10", "assumptions"],
      ["10", "interview"],
    ]);
    expect(provenance()).toBe("2026-10-08·assumptions 10 轮·interview 10 轮");
    expect(callout()!.textContent).toContain("讨论已收敛");
    expect(callout()!.textContent).toContain("第 20 轮之后写入结论");
    expect(callout()!.textContent).toContain("最后一轮待决：无");
  });

  it("结论文档的数字砖与出处行", () => {
    const decision = [
      "**Decision**: 一句定论。",
      ...Array.from({ length: 20 }, (_, i) => `- 细节 ${i}`),
      ...[1, 2, 3].map((n) => `- **cut ${n} \`chg-${n}\`**: 第 ${n} 刀`),
      "**Rejected alternatives**:",
      ...Array.from({ length: 11 }, (_, i) => `- 方案 ${i} — 理由`),
      "**Deferred**:",
      ...Array.from({ length: 4 }, (_, i) => `- 搁置 ${i}`),
    ].join("\n");
    // 引擎对三条刀列回的刀（三刀的变更皆在 promoted_to）。
    const cuts = [1, 2, 3].map((n) =>
      engineCut(`**cut ${n} \`chg-${n}\`**: 第 ${n} 刀`, {
        cut: `cut ${n}`,
        title: `第 ${n} 刀`,
        changes: [`chg-${n}`],
        changesInBold: true,
      }),
    );
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(Array(11).fill("interview"), Array(11).fill("2026-10-12")), decision), cuts),
      status: "concluded",
      hold: false,
      created: "2026-10-12",
      recordPath: "openspec/discussions/demo.md",
      rows: promotedRows(["chg-1", "chg-2", "chg-3"], [1, 2, 3].map((n) => live(`chg-${n}`, n, n)), [], t),
      names: NAMES,
    });
    render(<Harness tab="conclusion" data={data} />);
    expect(provenance()).toBe("openspec/discussions/demo.md·11 轮之后写入");
    expect(tiles()).toEqual([
      ["20", "定案细节"],
      ["3", "分刀 · 3 个变更"],
      ["11", "否决的替代方案"],
      ["4", "搁置"],
    ]);
    expect(callout()).toBeNull();
  });

  // spec Scenario「未转出刀的提示框与前往」「没有整刀未转出的刀时无提示框」「已封存讨论页不出未转出提示框」。
  const wadData = (
    decision: string,
    promoted: string[],
    status = "promoted",
    hold = true,
    cuts: DiscussionCut[] = wadCuts(promoted),
  ) =>
    discussionDocData({
      doc: discussionDoc(record(roundsOf(["interview"], ["2026-10-12"]), decision), cuts),
      status,
      hold,
      created: "2026-10-12",
      recordPath: "openspec/discussions/wad-plugins-merge-or-split.md",
      rows: promotedRows(promoted, promoted.map((name) => live(name, 1, 3)), [], t),
      names: { ...NAMES, self: "wad-plugins-merge-or-split" },
    });

  it("结论有整刀未转出的刀时有橄榄色提示框", () => {
    render(<Harness tab="conclusion" data={wadData(WAD_DECISION, ["add-team-plugin-library"])} />);
    const box = callout()!;
    expect(box).toBeTruthy();
    expect(box.querySelector(".markdown-alert-title")!.textContent).toBe("1 刀尚未转出");
    expect(box.firstElementChild!.className).toContain("status-manual");
    const rows = Array.from(box.querySelectorAll("[data-unpromoted-cut]"));
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("cut 2");
    expect(rows[0].textContent).toContain("移除内置 wad-work");
    expect(box.querySelector("[data-command-chip]")!.textContent).toBe(
      "/specseal-propose --from-discussion wad-plugins-merge-or-split",
    );
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(box).getByRole("button", { name: "拷贝指令" }));
    expect(writeText).toHaveBeenCalledWith("/specseal-propose --from-discussion wad-plugins-merge-or-split");
  });

  // 引擎只拒绝从已封存的记录转出：已转出、未保留的 live 讨论仍可再转出下一刀。
  it("已转出、未保留（hold 为 false）的 live 讨论仍有提示框", () => {
    render(<Harness tab="conclusion" data={wadData(WAD_DECISION, ["add-team-plugin-library"], "promoted", false)} />);
    expect(callout()!.querySelectorAll("[data-unpromoted-cut]").length).toBe(1);
  });

  it("名称只写在粗体之后的旧式刀列不列入提示框", () => {
    const line = "**刀一（候选 1＋2）**：`KeyLines` 原语＋`DiscussionHead`。文档面：`util.rs`";
    const cut = engineCut(line, {
      cut: "刀一",
      title: "（候选 1＋2）",
      note: "`KeyLines` 原语＋`DiscussionHead`。文档面：`util.rs`",
      changes: ["KeyLines", "DiscussionHead", "util.rs"],
    });
    render(<Harness tab="conclusion" data={wadData(`**Decision**: 一刀。\n- ${line}`, ["lifecycle-discussion-head"], "promoted", true, [cut])} />);
    expect(callout()).toBeNull();
  });

  it("名称清单没有本讨论的 slug 时提示框照列刀、不出指令签", () => {
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(["interview"], ["2026-10-12"]), WAD_DECISION), wadCuts(["add-team-plugin-library"])),
      status: "promoted",
      hold: true,
      created: "2026-10-12",
      recordPath: "openspec/discussions/wad-plugins-merge-or-split.md",
      rows: promotedRows(["add-team-plugin-library"], [live("add-team-plugin-library", 1, 3)], [], t),
      names: NAMES,
    });
    render(<Harness tab="conclusion" data={data} />);
    const box = callout()!;
    expect(box.querySelectorAll("[data-unpromoted-cut]").length).toBe(1);
    expect(box.querySelector("[data-command-chip]")).toBeNull();
    expect(box.textContent).not.toContain("undefined");
  });

  it("全部刀已转出或只部分转出时无提示框", () => {
    const decision = [
      "**Decision**: 三刀。",
      "- **cut 1 `a-one` `b-two`**: 部分转出",
      "- **cut 2 `c-three`**: 已转出",
      "- **刀三**：没有变更名",
    ].join("\n");
    const cuts = [
      engineCut("**cut 1 `a-one` `b-two`**: 部分转出", {
        cut: "cut 1",
        title: "部分转出",
        changes: ["a-one", "b-two"],
        changesInBold: true,
        unpromoted: ["b-two"],
      }),
      engineCut("**cut 2 `c-three`**: 已转出", { cut: "cut 2", title: "已转出", changes: ["c-three"], changesInBold: true }),
      engineCut("**刀三**：没有变更名", { cut: "刀三", title: "没有变更名" }),
    ];
    render(<Harness tab="conclusion" data={wadData(decision, ["a-one", "c-three"], "promoted", true, cuts)} />);
    expect(tiles()[1]).toEqual(["3", "分刀 · 3 个变更"]);
    expect(callout()).toBeNull();
  });

  it("status 为 archived 时无提示框", () => {
    render(<Harness tab="conclusion" data={wadData(WAD_DECISION, ["add-team-plugin-library"], "archived")} />);
    expect(tiles()[1]).toEqual(["2", "分刀 · 2 个变更"]);
    expect(callout()).toBeNull();
  });

  // spec Scenario「旧 server 没有分刀数据时刀列留在定案细节」：3 条刀列＋5 条其他细节、cuts 为空。
  it("没有分刀数据时没有「分刀」数字砖与提示框，定案细节含刀列共 8 条", () => {
    const decision = [
      "**Decision**: 定论。",
      ...Array.from({ length: 5 }, (_, i) => `- 细节 ${i + 1}`),
      "- **cut 1 `add-team-plugin-library`**: 团队插件库",
      "- **cut 2 `remove-builtin-wad-work`**: 移除内置 wad-work",
      "- **cut 3 `add-z`**: 路线图",
    ].join("\n");
    render(<Harness tab="conclusion" data={wadData(decision, [], "promoted", true, [])} />);
    expect(tiles()).toEqual([["8", "定案细节"]]);
    expect(callout()).toBeNull();
  });

  it("背景的数字砖、出处行与「没有 grill 阶段」提示框", () => {
    const context = [
      "提到 desktop-app、tray-status-menu、add-copilot-tool 与 tray-panel-card-design。",
      "",
      "Related specs: desktop-app（79 条）、tray-status-menu",
      "Prior discussions: card-drawer-header-colors, admin-console-redesign",
      "Source doc: none",
    ].join("\n");
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(["assumptions", "interview"], ["2026-10-08", "2026-10-08"]), "", context)),
      status: "open",
      hold: false,
      created: "2026-10-08",
      recordPath: "openspec/discussions/demo.md",
      rows: [],
      names: {
        specs: ["desktop-app", "tray-status-menu"],
        active: ["add-copilot-tool"],
        archived: ["tray-panel-card-design"],
        discussions: ["card-drawer-header-colors", "admin-console-redesign"],
      },
    });
    render(<Harness tab="context" data={data} />);
    expect(tiles()).toEqual([
      ["2", "命中的正式规格"],
      ["1", "在途变更"],
      ["1", "相关已封存变更"],
      ["2", "先前讨论"],
    ]);
    expect(provenance()).toBe("记录创建时写入一次·2026-10-08");
    expect(callout()!.textContent).toContain("没有 grill 阶段");
    expect(callout()!.textContent).toContain("首轮直接列假设");
  });

  // spec Scenario「非标准格式整篇退回」「自由格式结论整篇退回」「结论缺席字段不渲染空标签」讲数字砖的半句。
  it("区段切得开、但轮标题不符 scaffold 时讨论过程无数字砖、无提示框", () => {
    const rounds = roundsOf(["interview", "interview"], ["2026-10-08", "2026-10-09"]).replace(
      "### Round 2 — interview (2026-10-09)",
      "### 插入的手写标题",
    );
    const data = discussionDocData({
      doc: discussionDoc(record(rounds, "**Decision**: 定案")),
      status: "concluded",
      hold: false,
      created: null,
      recordPath: null,
      rows: [],
      names: NAMES,
    });
    expect(data.sections).not.toBeNull();
    render(<Harness tab="rounds" data={data} />);
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
    expect(callout()).toBeNull();
  });

  it("自由格式结论整篇退回时结论无数字砖", () => {
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(["interview"], ["2026-10-08"]), "就这样定了，大家都同意这个方向。")),
      status: "concluded",
      hold: false,
      created: null,
      recordPath: null,
      rows: [],
      names: NAMES,
    });
    render(<Harness tab="conclusion" data={data} />);
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
  });

  it("结论缺 Deferred 时数字砖没有「搁置」格", () => {
    const data = discussionDocData({
      doc: discussionDoc(
        record(roundsOf(["interview"], ["2026-10-08"]), "**Decision**: 定论。\n- 细节一\n**Rejected alternatives**:\n- 方案 — 理由"),
      ),
      status: "concluded",
      hold: false,
      created: null,
      recordPath: null,
      rows: [],
      names: NAMES,
    });
    render(<Harness tab="conclusion" data={data} />);
    expect(tiles()).toEqual([
      ["1", "定案细节"],
      ["1", "否决的替代方案"],
    ]);
  });

  it("背景无关联时数字砖整列缺席；首轮不是 assumptions 时无提示框", () => {
    const data = discussionDocData({
      doc: discussionDoc(record(roundsOf(["interview"], ["2026-10-08"]), "", "两段纯散文。\n\n第二段。")),
      status: "open",
      hold: false,
      created: null,
      recordPath: null,
      rows: [],
      names: NAMES,
    });
    render(<Harness tab="context" data={data} />);
    expect(document.querySelector("[data-doc-tiles]")).toBeNull();
    expect(callout()).toBeNull();
    expect(provenance()).toBe("记录创建时写入一次");
  });

  describe("衍生变更", () => {
    const gone = (name: string, n: number): ArchivedItem => ({
      datedName: `2026-10-0${n}-${name}`,
      date: `2026-10-0${n}`,
      name,
      tasksDone: n,
      tasksTotal: n,
    });
    const docData = (rows: PromotedRow[], over: Partial<{ status: string; hold: boolean; cuts: boolean }> = {}) =>
      discussionDocData({
        doc: over.cuts
          ? discussionDoc(record(roundsOf(["interview"], ["2026-10-08"]), "**Decision**: 定案\n- **cut 1 `a-one`**: 一"), [
              engineCut("**cut 1 `a-one`**: 一", { cut: "cut 1", title: "一", changes: ["a-one"], changesInBold: true }),
            ])
          : discussionDoc(record(roundsOf(["interview"], ["2026-10-08"]), "**Decision**: 定案")),
        status: over.status ?? "promoted",
        hold: over.hold ?? false,
        created: "2026-10-08",
        recordPath: null,
        rows,
        names: NAMES,
      });

    it("只差最后一刀提示框：已转出、hold 为 false、恰一个作用中子变更", () => {
      const rows = promotedRows(
        ["a-one", "b-two", "tray-panel-restyle"],
        [live("tray-panel-restyle", 9, 9)],
        [gone("a-one", 3), gone("b-two", 4)],
        t,
      );
      render(<Harness tab="promote" data={docData(rows, { cuts: true })} />);
      expect(tiles()).toEqual([
        ["3", "变更"],
        ["2", "已封存"],
        ["1", "作用中"],
        ["16 / 16", "任务"],
      ]);
      expect(provenance()).toBe("依结论的分刀分组");
      expect(callout()!.textContent).toContain("只差最后一刀");
      expect(callout()!.textContent).toContain("tray-panel-restyle（已就绪）");
    });

    it("hold 为 true、或作用中子变更有两个时无此提示框；读不到分刀时出处行为依转出顺序", () => {
      const one = promotedRows(["a-one", "tray-panel-restyle"], [live("tray-panel-restyle", 1, 2)], [gone("a-one", 3)], t);
      const { unmount } = render(<Harness tab="promote" data={docData(one, { hold: true })} />);
      expect(callout()).toBeNull();
      expect(provenance()).toBe("依转出顺序");
      unmount();
      const two = promotedRows(["x-one", "y-two"], [live("x-one", 1, 2), live("y-two", 0, 3)], [], t);
      render(<Harness tab="promote" data={docData(two)} />);
      expect(callout()).toBeNull();
    });

    it("结论未写入时无「讨论已收敛」提示框；衍生变更为空时无数字砖与出处行", () => {
      const { unmount } = render(<Harness tab="rounds" data={docData([], { status: "open" })} />);
      expect(callout()!.textContent).toContain("讨论已收敛");
      unmount();
      const open = discussionDocData({
        doc: discussionDoc(
          record(roundsOf(["interview", "interview", "interview"], ["2026-10-08", "2026-10-09", "2026-10-10"]), "<!-- scaffold -->"),
        ),
        status: "open",
        hold: false,
        created: null,
        recordPath: null,
        rows: [],
        names: NAMES,
      });
      const r = render(<Harness tab="rounds" data={open} />);
      expect(callout()).toBeNull();
      expect(tiles()[0]).toEqual(["3", "轮"]);
      expect(provenance()).toBe("2026-10-08 – 2026-10-10·interview 3 轮");
      r.unmount();
      render(<Harness tab="promote" data={open} />);
      expect(document.querySelector("[data-doc-tiles]")).toBeNull();
      expect(provenance()).toBeNull();
    });
  });

  it("记录切分失败时三者皆空", () => {
    const data = discussionDocData({
      doc: discussionDoc("手写的自由格式记录。"),
      status: "open",
      hold: false,
      created: "2026-10-08",
      recordPath: "openspec/discussions/demo.md",
      rows: [],
      names: NAMES,
    });
    for (const tab of ["conclusion", "rounds", "context", "record"] as const) {
      const { unmount } = render(<Harness tab={tab} data={data} />);
      expect(document.querySelector("[data-doc-tiles]")).toBeNull();
      expect(provenance()).toBeNull();
      expect(callout()).toBeNull();
      unmount();
    }
  });
});

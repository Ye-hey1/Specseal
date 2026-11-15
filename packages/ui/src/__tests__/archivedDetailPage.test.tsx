// 已封存详情页（spec「已封存项目以详情页查看」「已封存详情页的工单分页」「已封存侧的审查标示」
// 「已封存侧的验证标示」；desktop-readonly-detail-pages design D3）：封存变更——标题列（变更名＋
// 拷贝封存目录名＋结局签）、出身列、「状态」卡三列、提案／设计／任务／规格＋条件式工单分页、
// 任务唯读；封存讨论——slug＋「已封存」签、阶段列现站「已封存」、衍生变更三态、结论／讨论过程／
// 背景／衍生变更分页、「打开 ▾」只能拷贝内容。两者皆无写入动词。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ArchivedDetailPage } from "../components/ArchivedDetailPage";
import { discussionDoc, engineCut } from "./engineCuts";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const PROPOSAL = "## Why\n\n封存提案内文。\n";
const TASKS_MD = "## 1. G\n\n- [x] 1.1 done-task\n- [ ] 1.2 open-task\n";
const SPEC_DELTA = "## ADDED Requirements\n\n### Requirement: 新需求\n\n内文。\n";
const DISCUSSION_DOC = `---
topic: Alpha topic
slug: alpha-search
status: promoted
created: 2026-01-02
---

# Discussion: Alpha topic

## Context

讨论背景内文。

## Rounds

### Round 1 — assumptions (2026-01-02)

**Focus**: scope

## Conclusion

**Decision**: 就这幺办
`;

function makeProps(over: Record<string, unknown> = {}) {
  return {
    target: { kind: "change", datedName: "2026-07-04-old-change" },
    loadDocument: vi.fn(async (_d: string, artifact: string) => {
      if (artifact === "proposal.md") return PROPOSAL;
      if (artifact === "design.md") return null; // 缺件样本
      if (artifact === "tasks.md") return TASKS_MD;
      return artifact.startsWith("specs/") ? SPEC_DELTA : null;
    }),
    loadCapabilities: vi.fn(async () => ["cap-x"]),
    loadDiscussionDocument: vi.fn(async () => discussionDoc(DISCUSSION_DOC)),
    ...over,
  };
}
const discussionProps = (over: Record<string, unknown> = {}) =>
  makeProps({ target: { kind: "discussion", slug: "alpha-search" }, discussionTopic: "Alpha topic", ...over });

const provenanceRow = () => document.querySelector("[data-identity-provenance]") as HTMLElement | null;
const identity = () => document.querySelector("[data-detail-identity]") as HTMLElement;
const statusRow = (mark: string) => document.querySelector(`[data-status-${mark}]`) as HTMLElement | null;
const clipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};
const tabNames = () => screen.getAllByRole("tab").map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());

describe("ArchivedDetailPage（封存变更）", () => {
  it("标题为变更名、分页提案／设计／任务／规格，缺省呈现提案", async () => {
    const props = makeProps();
    render(<ArchivedDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("old-change");
    expect(tabNames().map((n) => n.replace(/\s*\d.*$/, ""))).toEqual(["提案", "设计", "任务", "规格"]);
    expect(props.loadDocument).toHaveBeenCalledWith("2026-07-04-old-change", "proposal.md");
  });

  it("拷贝钮写入含日期前缀的封存目录名并显示已拷贝回馈", async () => {
    const writeText = clipboard();
    render(<ArchivedDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("拷贝封存名称"));
    expect(writeText).toHaveBeenCalledWith("2026-07-04-old-change");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已拷贝"));
  });

  it("身分区只带已封存签；状态栏三列为任务 n/m、品质关卡结局、封存日期；无进度条与动作区", async () => {
    // spec Scenario「封存变更详情页的标题列、出身列与状态卡」：结局签只在「品质关卡」列。
    render(
      <ArchivedDetailPage
        {...(makeProps({
          reviewStatus: "reviewed",
          verifyStatus: "verifiedNotPassed",
          archivedDate: "2026-07-04",
        }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    const title = identity();
    expect(title.querySelector("[data-archived-status]")!.textContent).toBe("已封存");
    expect(title.querySelector("[data-review-outcome]")).toBeNull();
    expect(title.querySelector("[data-verify-outcome]")).toBeNull();
    expect(document.querySelectorAll("[data-review-outcome]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-verify-outcome]")).toHaveLength(1);
    await waitFor(() => expect(statusRow("tasks")!.textContent).toContain("1/2"));
    expect(statusRow("quality")!.textContent).toContain("已审查");
    expect(statusRow("quality")!.textContent).toContain("曾验证未通过");
    expect(statusRow("archived")!.textContent).toContain("2026-07-04");
    expect(document.querySelector("[data-progress-track]")).toBeNull();
    for (const name of ["封存", "删除", "分析", "转为变更", "退回提案中"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("皆无结局时品质关卡列显示「未经品质关卡」、身分区无结局签；无 tasks.md 时任务列为「—」", async () => {
    const loadDocument = vi.fn(async (_d: string, artifact: string) => (artifact === "proposal.md" ? PROPOSAL : null));
    render(<ArchivedDetailPage {...(makeProps({ loadDocument }) as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(statusRow("quality")!.textContent).toContain("未经品质关卡");
    expect(document.querySelector("[data-review-outcome]")).toBeNull();
    await waitFor(() => expect(statusRow("tasks")!.textContent).toContain("—"));
  });

  it("出身列：创建者首字母圆标＋名字、创建日期、「封存 日期」", async () => {
    render(
      <ArchivedDetailPage
        {...(makeProps({
          createdBy: "MomoChen <momo@example.com>",
          created: "2026-06-20",
          archivedDate: "2026-07-04",
        }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    const row = provenanceRow()!;
    expect(row.className).toContain("whitespace-nowrap");
    expect(within(row).getByText("M").className).toContain("rounded-full");
    expect(within(row).getByText("MomoChen")).toBeTruthy();
    expect(row.textContent).toContain("2026-06-20");
    expect(row.textContent).toContain("封存 2026-07-04");
  });

  it("出身列字段缺席时该栏缺席、其余照常（创建日期不可得）", async () => {
    // spec Scenario「出身列字段缺席时其余照常」。
    render(
      <ArchivedDetailPage
        {...(makeProps({ createdBy: "MomoChen <momo@example.com>", archivedDate: "2026-07-04" }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    const row = provenanceRow()!;
    expect(row.textContent).toBe("MMomoChen·封存 2026-07-04");
  });

  it("来源讨论签：首签直出、点击以 slug 调用 onOpenDiscussion；缺席时不显示", async () => {
    const onOpenDiscussion = vi.fn();
    const props = makeProps({ sourceDiscussions: [{ slug: "alpha-ux", topic: "Alpha UX 讨论" }], onOpenDiscussion });
    const { unmount } = render(<ArchivedDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    const from = document.querySelector("[data-relation-from]") as HTMLElement;
    expect(from.textContent).toContain("来自");
    fireEvent.click(within(from).getByRole("button", { name: /alpha-ux/ }));
    expect(onOpenDiscussion).toHaveBeenCalledWith("alpha-ux");
    unmount();
    render(<ArchivedDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(document.querySelector("[data-source-discussion-label]")).toBeNull();
  });

  it("任务分页唯读：核取方块 disabled、无把手、无批量工具列", async () => {
    render(<ArchivedDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(screen.getByText("done-task")).toBeTruthy());
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect((box as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("全部已完成")).toBeNull();
    expect(screen.queryByText("重置任务")).toBeNull();
    expect(document.querySelector(".lucide-grip-vertical")).toBeNull();
    fireEvent.click(screen.getByText("open-task"));
    expect((boxes[1] as HTMLButtonElement).getAttribute("data-state")).toBe("unchecked");
  });

  it("规格分页呈现 delta 规格；缺件设计分页显示空状态而非错误", async () => {
    render(<ArchivedDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(screen.getByText(/新需求/)).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /设计/ }));
    await waitFor(() => expect(screen.getByText("（此变更无设计文档）")).toBeTruthy());
  });

  it("「打开 ▾」依作用中分页收到封存目录内的对应文档", async () => {
    const renderDocumentActions = vi.fn(() => null);
    render(<ArchivedDetailPage {...(makeProps({ renderDocumentActions }) as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(renderDocumentActions).toHaveBeenLastCalledWith({
      doc: { archived: "2026-07-04-old-change", artifact: "proposal.md" },
      content: PROPOSAL,
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() =>
      expect(renderDocumentActions).toHaveBeenLastCalledWith({
        doc: { archived: "2026-07-04-old-change", artifact: "specs/cap-x/spec.md" },
        content: SPEC_DELTA,
      }),
    );
  });

  it("refreshGen 递增时就地重载至磁盘现况", async () => {
    let body = "第一版提案。";
    const loadDocument = vi.fn(async (_d: string, artifact: string) =>
      artifact === "proposal.md" ? `## Why\n\n${body}\n` : null,
    );
    const props = makeProps({ loadDocument, loadCapabilities: vi.fn(async () => []) });
    const { rerender } = render(<ArchivedDetailPage {...(props as never)} refreshGen={0} />);
    await waitFor(() => expect(screen.getByText("第一版提案。")).toBeTruthy());
    body = "第二版提案。";
    rerender(<ArchivedDetailPage {...(props as never)} refreshGen={1} />);
    await waitFor(() => expect(screen.getByText("第二版提案。")).toBeTruthy());
    expect(screen.queryByText("第一版提案。")).toBeNull();
  });

  it("换目标时清空并重载、分页回到提案", async () => {
    const loadDocument = vi.fn(async (d: string, artifact: string) =>
      artifact === "proposal.md" ? `## Why\n\n${d} 的提案。\n` : null,
    );
    const props = makeProps({ loadDocument });
    const { rerender } = render(<ArchivedDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText("2026-07-04-old-change 的提案。")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /设计/ }));
    rerender(<ArchivedDetailPage {...(props as never)} target={{ kind: "change", datedName: "2026-08-01-next" }} />);
    await waitFor(() => expect(screen.getByText("2026-08-01-next 的提案。")).toBeTruthy());
    expect(screen.getByRole("tab", { name: /提案/ }).getAttribute("data-state")).toBe("active");
  });
});

// spec「详情页的文档树、阅读卡与本页目录」Scenario「已封存详情页的唯读变体」：同骨架、无标题列动作。
describe("已封存详情页的唯读骨架", () => {
  it("已封存详情页无 data-detail-actions 子节点、身分区含已封存签、文档节点在左栏", async () => {
    const { unmount } = render(<ArchivedDetailPage {...(makeProps({ archivedDate: "2026-07-04" }) as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(document.querySelector("[data-detail-actions]")).toBeNull();
    expect(within(identity()).getByText("已封存")).toBeTruthy();
    expect(provenanceRow()!.textContent).toContain("封存 2026-07-04");
    const tree = document.querySelector("[data-detail-tree]") as HTMLElement;
    expect(within(tree).getByRole("tablist")).toBeTruthy();
    expect(document.querySelector("[data-doc-header]")!.textContent).toContain("提案");
    unmount();
    render(<ArchivedDetailPage {...(discussionProps() as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(document.querySelector("[data-detail-actions]")).toBeNull();
    expect(within(identity()).getByText("已封存")).toBeTruthy();
  });

  it("阅读卡出处行：封存变更为相对变更目录的路径，封存讨论的结论出处行为「N 轮之后写入」且无路径段", async () => {
    const { unmount } = render(<ArchivedDetailPage {...(makeProps() as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(document.querySelector("[data-doc-header] [data-doc-provenance]")!.textContent).toBe("proposal.md");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    expect(document.querySelector("[data-doc-header] [data-doc-provenance]")!.textContent).toBe("specs/cap-x/spec.md");
    unmount();
    render(<ArchivedDetailPage {...(discussionProps() as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(document.querySelector("[data-doc-header] [data-doc-provenance]")!.textContent).toBe("1 轮之后写入");
  });
});

describe("ArchivedDetailPage（封存讨论）", () => {
  it("标题为 slug＋「已封存」签、topic 为副标；阶段列现站「已封存」；分页结论／讨论过程／背景／衍生变更；无写入动词", async () => {
    const props = discussionProps({ discussionKind: "improve" });
    render(<ArchivedDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(props.loadDiscussionDocument).toHaveBeenCalledWith("alpha-search");
    const title = identity();
    expect(within(title).getByRole("heading", { level: 1 }).textContent).toBe("alpha-search");
    expect(title.querySelector("[data-archived-status]")!.textContent).toBe("已封存");
    expect(title.querySelector('[data-discussion-kind="improve"]')).toBeTruthy();
    expect(screen.getByText("Alpha topic")).toBeTruthy();
    expect(statusRow("stage")!.querySelector('[aria-current="step"]')!.textContent).toBe("已封存");
    expect(tabNames().map((n) => n.replace(/\s*\d+$/, ""))).toEqual(["结论", "讨论过程", "背景", "衍生变更"]);
    for (const name of ["转为变更", "封存", "删除"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("出身列：创建者与创建日期；清单数据不带封存日期时「封存」栏缺席、其余照常", async () => {
    render(
      <ArchivedDetailPage
        {...(discussionProps({ createdBy: "MomoChen <momo@example.com>", created: "2026-01-02" }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(provenanceRow()!.textContent).toBe("MMomoChen·2026-01-02");
  });

  it("拷贝钮写入 slug", async () => {
    const writeText = clipboard();
    render(<ArchivedDetailPage {...(discussionProps() as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText("拷贝 slug"));
    expect(writeText).toHaveBeenCalledWith("alpha-search");
  });

  it("衍生变更列三态：依转出顺序、副标与可点性；点可点者以变更名调用，点已删除者无动作", async () => {
    // spec Example「三态对照」。
    const onOpenPromotedChange = vi.fn();
    const props = discussionProps({
      promotedChanges: [
        { slug: "child-a", topic: "2026-09-02" },
        { slug: "child-b", topic: "进行中" },
        { slug: "child-c", topic: "无封存记录", disabled: true },
      ],
      onOpenPromotedChange,
    });
    render(<ArchivedDetailPage {...(props as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    const row = statusRow("promoted")!;
    const chips = Array.from(row.querySelectorAll<HTMLElement>("[data-promoted-chip]"));
    expect(chips.map((c) => c.textContent)).toEqual(["child-a2026-09-02", "child-b进行中", "child-c无封存记录"]);
    fireEvent.click(within(chips[0]).getByRole("button"));
    expect(onOpenPromotedChange).toHaveBeenCalledWith("child-a");
    fireEvent.click(within(chips[1]).getByRole("button"));
    expect(onOpenPromotedChange).toHaveBeenCalledWith("child-b");
    const gone = within(chips[2]).getByRole("button") as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
    fireEvent.click(gone);
    expect(onOpenPromotedChange).toHaveBeenCalledTimes(2);
  });

  it("无衍生变更时衍生列缺席；封存变更页即使传入也无该列", async () => {
    const { unmount } = render(<ArchivedDetailPage {...(discussionProps({ promotedChanges: [] }) as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(statusRow("promoted")).toBeNull();
    expect(statusRow("stage")).toBeTruthy();
    unmount();
    render(<ArchivedDetailPage {...(makeProps({ promotedChanges: [{ slug: "x", topic: "y" }] }) as never)} />);
    await waitFor(() => expect(screen.getByText("封存提案内文。")).toBeTruthy());
    expect(statusRow("promoted")).toBeNull();
  });

  const LINKS = [
    { slug: "child-a", topic: "2026-09-02" },
    { slug: "child-b", topic: "进行中" },
    { slug: "child-c", topic: "无封存记录", disabled: true },
  ];
  const LISTS = {
    changes: [
      {
        name: "child-b",
        status: "in-progress",
        totalTasks: 4,
        completedTasks: 2,
        reviewStatus: "reviewed",
        reviewedAt: "2026-09-05T10:00:00+08:00",
      },
    ],
    archivedChanges: [
      {
        datedName: "2026-09-02-child-a",
        date: "2026-09-02",
        name: "child-a",
        tasksDone: 5,
        tasksTotal: 5,
        reviewStatus: "reviewed",
        verifyStatus: "verified",
      },
    ],
  };
  const promotedRow = (name: string) => document.querySelector(`[data-promoted-row="${name}"]`) as HTMLElement;
  const stamps = (name: string) => Array.from(promotedRow(name).querySelectorAll("[data-stamp]")).map((s) => s.textContent);

  it("传入两份清单时衍生列有任务进度与两章、未传时退回副标三态", async () => {
    const onOpenPromotedChange = vi.fn();
    const { unmount } = render(
      <ArchivedDetailPage {...(discussionProps({ promotedChanges: LINKS, onOpenPromotedChange, ...LISTS }) as never)} />,
    );
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(promotedRow("child-a").textContent).toContain("5/5");
    expect(promotedRow("child-a").textContent).toContain("2026-09-02");
    expect(stamps("child-a")).toEqual(["审", "验"]);
    expect(promotedRow("child-b").textContent).toContain("2/4");
    expect(stamps("child-b")).toEqual(["审"]);
    expect(promotedRow("child-c").textContent).toContain("已删除");
    expect(promotedRow("child-c").querySelector("button")).toBeNull();
    fireEvent.click(within(promotedRow("child-a")).getByRole("button", { name: "打开卡片" }));
    expect(onOpenPromotedChange).toHaveBeenCalledWith("child-a");
    fireEvent.click(within(promotedRow("child-b")).getByRole("button", { name: "打开卡片" }));
    expect(onOpenPromotedChange).toHaveBeenCalledWith("child-b");
    unmount();

    render(<ArchivedDetailPage {...(discussionProps({ promotedChanges: LINKS, onOpenPromotedChange }) as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(promotedRow("child-a").textContent).toContain("2026-09-02");
    expect(promotedRow("child-a").textContent).not.toMatch(/\d+\/\d+/);
    expect(promotedRow("child-b").textContent).toContain("进行中");
    expect(promotedRow("child-c").querySelector("button")).toBeNull();
  });

  it("封存讨论的背景无文档列、衍生变更无「只差最后一刀」提示框", async () => {
    render(
      <ArchivedDetailPage {...(discussionProps({ promotedChanges: LINKS, onOpenPromotedChange: vi.fn(), ...LISTS }) as never)} />,
    );
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("tab", { name: /衍生变更/ }));
    expect(document.querySelector("[data-doc-tiles]")).toBeTruthy();
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /背景/ }));
    expect(document.querySelector('[data-context-row="kind"]')).toBeTruthy();
    expect(document.querySelector('[data-context-row="file"]')).toBeNull();
  });

  it("封存讨论的结论：未转出的刀卡带 data-cut-todo、没有 [data-unpromoted-cut] 提示框列", async () => {
    const doc = DISCUSSION_DOC.replace(
      "**Decision**: 就这幺办",
      "**Decision**: 就这幺办\n- **cut 1 `child-a`**: 一\n- **cut 2 `child-z`**: 二",
    );
    // 引擎对两条刀列回的刀：child-a 已转出、child-z 不在 promoted_to。
    const cuts = [
      engineCut("**cut 1 `child-a`**: 一", { cut: "cut 1", title: "一", changes: ["child-a"], changesInBold: true }),
      engineCut("**cut 2 `child-z`**: 二", {
        cut: "cut 2",
        title: "二",
        changes: ["child-z"],
        changesInBold: true,
        unpromoted: ["child-z"],
      }),
    ];
    render(
      <ArchivedDetailPage
        {...(discussionProps({
          promotedChanges: LINKS,
          ...LISTS,
          loadDiscussionDocument: vi.fn(async () => discussionDoc(doc, cuts)),
        }) as never)}
      />,
    );
    const todo = await waitFor(() => {
      const el = document.querySelector('[data-cut="cut 2"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(todo.hasAttribute("data-cut-todo")).toBe(true);
    expect(todo.className).toContain("border-dashed");
    expect(todo.querySelector("header")!.textContent).toContain("尚未转出");
    expect(document.querySelector('[data-cut="cut 1"]')!.hasAttribute("data-cut-todo")).toBe(false);
    expect(document.querySelector("[data-unpromoted-cut]")).toBeNull();
    expect(document.querySelector("[data-doc-callout]")).toBeNull();
  });

  it("「打开 ▾」收到不带文档的目标（只能拷贝内容）", async () => {
    const renderDocumentActions = vi.fn(() => null);
    render(<ArchivedDetailPage {...(discussionProps({ renderDocumentActions }) as never)} />);
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(renderDocumentActions).toHaveBeenLastCalledWith({ doc: null, content: DISCUSSION_DOC });
  });

  it("记录缺席显示空状态而非错误", async () => {
    render(<ArchivedDetailPage {...(discussionProps({ loadDiscussionDocument: vi.fn(async () => null) }) as never)} />);
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
  });

  it("封存讨论不显示来源讨论签（即使 props 带值）", async () => {
    render(
      <ArchivedDetailPage
        {...(discussionProps({ sourceDiscussions: [{ slug: "alpha-ux", topic: "x" }], onOpenDiscussion: vi.fn() }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText(/就这幺办/)).toBeTruthy());
    expect(document.querySelector("[data-source-discussion-label]")).toBeNull();
  });
});

// spec「详情页文档加载以 skeleton 呈现」：各分页加载中画骨架、失败收敛到空态。
describe("已封存详情页文档三态", () => {
  const pending = () => new Promise<never>(() => {});

  it("封存变更加载中 → 骨架，且不出假空态", async () => {
    render(
      <ArchivedDetailPage {...(makeProps({ loadDocument: vi.fn(pending), loadCapabilities: vi.fn(pending) }) as never)} />,
    );
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（此变更无设计文档）")).toBeNull();
  });

  it("封存讨论加载中 → 骨架，不出空态文案", async () => {
    render(<ArchivedDetailPage {...(discussionProps({ loadDiscussionDocument: vi.fn(pending) }) as never)} />);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());
    expect(screen.queryByText("（无内容）")).toBeNull();
  });

  it("封存变更文档首载失败 → 空态文案，不停在骨架", async () => {
    render(
      <ArchivedDetailPage {...(makeProps({ loadDocument: vi.fn().mockRejectedValue(new Error("offline")) }) as never)} />,
    );
    await waitFor(() => expect(screen.getByText("（无提案文档）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("封存讨论首载失败 → 空态文案，不停在骨架", async () => {
    render(
      <ArchivedDetailPage
        {...(discussionProps({ loadDiscussionDocument: vi.fn().mockRejectedValue(new Error("offline")) }) as never)}
      />,
    );
    await waitFor(() => expect(screen.getByText("（无内容）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("loadCapabilities 失败 → 规格分页收敛为空态文案", async () => {
    render(
      <ArchivedDetailPage {...(makeProps({ loadCapabilities: vi.fn(async () => Promise.reject("读不到")) }) as never)} />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /规格/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    await waitFor(() => expect(screen.getByText("（此变更无 delta 规格）")).toBeTruthy());
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

// desktop-change-doc-views design D9：已封存变更共用同一批渲染器与推导（唯读、无调度）。
describe("已封存变更的文档渲染器", () => {
  const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const docs: Record<string, string> = {
    "proposal.md": "## Why\n\n- 动机\n\n## What Changes\n\n- 第一步\n- 第二步\n\n## Non-Goals\n\n- 不做\n",
    "tasks.md": "## 1. 甲\n\n- [x] 1.1 已做（design D2）：内文；验证：npm test\n- [ ] 1.2 未做\n- [ ] [M] 1.3 手动看画面\n",
    "specs/cap-x/spec.md": SPEC_DELTA,
  };
  const props = () => makeProps({ loadDocument: vi.fn(async (_d: string, artifact: string) => docs[artifact] ?? null) });

  it("提案文档有签与数字砖；任务卡勾选框 disabled 而展开钮可用", async () => {
    render(<ArchivedDetailPage {...(props() as never)} />);
    await waitFor(() => expect(flat(document.querySelector("[data-doc-badges]"))).toBe("Feature"));
    expect(Array.from(document.querySelectorAll("[data-doc-tile]")).map((t) => flat(t))).toEqual(["2解法步骤", "1非目标"]);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    const expand = await screen.findByRole("button", { name: "展开任务 1" });
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLButtonElement).disabled).toBe(true);
    expect((expand as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(expand);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(flat(document.querySelector("[data-doc-badges]"))).toBe("1/3");
  });

  it("手动提示框的「前往」使该任务列高亮（唯读照常）", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<ArchivedDetailPage {...(props() as never)} />);
    await screen.findByText("动机");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    const go = await screen.findByRole("button", { name: "前往" });
    fireEvent.click(go);
    await waitFor(() =>
      expect(document.querySelector("[data-task-manual]")?.getAttribute("data-highlight")).toBe("true"),
    );
  });

  it("手动提示框只列未勾的手动任务，「手动」数字砖仍计总数", async () => {
    const tasks = "## 1. 甲\n\n- [x] [M] 1.1 已验手动\n- [ ] [M] 1.2 待验手动\n";
    const loadDocument = vi.fn(async (_d: string, artifact: string) =>
      artifact === "tasks.md" ? tasks : (docs[artifact] ?? null),
    );
    render(<ArchivedDetailPage {...(makeProps({ loadDocument }) as never)} />);
    await screen.findByText("动机");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    await waitFor(() => expect(flat(document.querySelector("[data-doc-callout]"))).toContain("1 个手动任务"));
    expect(Array.from(document.querySelectorAll("[data-manual-task]")).map((row) => flat(row.firstElementChild))).toEqual([
      "1.2",
    ]);
    expect(Array.from(document.querySelectorAll("[data-doc-tile]")).map((t) => flat(t))).toContain("2手动");
  });

  it("任务的 D 签切到设计文档；规格文档能力头有「看正式规格」", async () => {
    const onOpenSpec = vi.fn();
    render(<ArchivedDetailPage {...(makeProps({ ...props(), onOpenSpec }) as never)} />);
    await screen.findByText("动机");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /任务/ }));
    fireEvent.click((await waitFor(() => document.querySelector('[data-task-decision="D2"]'))) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("tab", { name: /设计/ }).getAttribute("data-state")).toBe("active"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /规格/ }));
    fireEvent.click(await screen.findByRole("button", { name: "看正式规格" }));
    expect(onOpenSpec).toHaveBeenCalledWith("cap-x");
  });
});

// spec「已封存详情页的工单分页」：reviewedNotPassed／verifiedNotPassed 于「规格」之后出现对应
// 分页（审查在前），以 (datedName, station) 加载化石工单；reviewed／verified／none 不出分页、不发请求。
describe("已封存详情页的工单分页", () => {
  const HASH = `sha256:${"a".repeat(64)}`;
  const TICKET = {
    rounds: [
      {
        index: 1,
        phase: "discovery",
        patchHash: HASH,
        scope: ["src/a.rs", "src/b.rs"],
        findings: [{ severity: "CRITICAL", path: "src/a.rs", text: "Correctness: 未处理空清单" }],
      },
      {
        index: 2,
        phase: "validation",
        patchHash: HASH,
        scope: ["src/a.rs", "src/b.rs"],
        findings: [{ severity: "CRITICAL", path: "src/a.rs", text: "Correctness: 未处理空清单" }],
      },
    ],
  };
  // 段标题列已撤（desktop-change-doc-views design D8）：轮数与阶段词在签槽、计数在数字砖。
  const flat = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const badges = () => flat(document.querySelector("[data-doc-badges]"));
  const tiles = () =>
    Array.from(document.querySelectorAll("[data-doc-tile]")).map((t) => `${flat(t.lastElementChild)} ${flat(t.firstElementChild)}`);

  it("reviewedNotPassed → 「审查」分页排在规格之后，以 (datedName, review) 加载并呈现末轮", async () => {
    const loadStationTicket = vi.fn(async () => TICKET);
    render(
      <ArchivedDetailPage
        {...(makeProps({ reviewStatus: "reviewedNotPassed", verifyStatus: "verified", loadStationTicket }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /审查/ }));
    const names = tabNames();
    expect(names).toHaveLength(5);
    expect(names[3]).toMatch(/规格/);
    expect(names[4]).toMatch(/审查/);
    expect(screen.queryByRole("tab", { name: /验证/ })).toBeNull();
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledWith("2026-07-04-old-change", "review"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /审查/ }));
    await waitFor(() => expect(badges()).toBe("第 2 轮复验"));
    expect(tiles()).toEqual(["轮 2", "CRITICAL（末轮） 1", "WARNING（末轮） 0", "SUGGESTION（末轮） 0"]);
    const r2 = document.querySelector('[data-ticket-round="2"]') as HTMLElement;
    expect(r2.querySelector("[data-ticket-round-toggle]")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("verifiedNotPassed → 「验证」分页以 (datedName, verify) 加载", async () => {
    const loadStationTicket = vi.fn(async () => TICKET);
    render(
      <ArchivedDetailPage
        {...(makeProps({ reviewStatus: "reviewed", verifyStatus: "verifiedNotPassed", loadStationTicket }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /验证/ }));
    expect(screen.queryByRole("tab", { name: /审查/ })).toBeNull();
    await waitFor(() => expect(loadStationTicket).toHaveBeenCalledWith("2026-07-04-old-change", "verify"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /验证/ }));
    await waitFor(() => expect(badges()).toBe("第 2 轮复验"));
  });

  it("两站皆带走 → 「审查」「验证」依序；reviewed／none → 皆缺席且未发请求", async () => {
    const both = vi.fn(async () => TICKET);
    const first = render(
      <ArchivedDetailPage
        {...(makeProps({ reviewStatus: "reviewedNotPassed", verifyStatus: "verifiedNotPassed", loadStationTicket: both }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /验证/ }));
    const names = tabNames();
    expect(names).toHaveLength(6);
    expect(names[4]).toMatch(/审查/);
    expect(names[5]).toMatch(/验证/);
    first.unmount();

    const none = vi.fn(async () => TICKET);
    render(
      <ArchivedDetailPage
        {...(makeProps({ reviewStatus: "reviewed", verifyStatus: "none", loadStationTicket: none }) as never)}
      />,
    );
    await screen.findByText("封存提案内文。");
    expect(tabNames()).toHaveLength(4);
    expect(none).not.toHaveBeenCalled();
  });

  it("加载器回 null 或 reject → 分页显示「工单尚未抵达或已被删除」", async () => {
    const first = render(
      <ArchivedDetailPage
        {...(makeProps({ reviewStatus: "reviewedNotPassed", loadStationTicket: vi.fn(async () => null) }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /审查/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /审查/ }));
    await screen.findByText("工单尚未抵达或已被删除");
    first.unmount();

    render(
      <ArchivedDetailPage
        {...(makeProps({
          verifyStatus: "verifiedNotPassed",
          loadStationTicket: vi.fn(async () => Promise.reject(new Error("offline"))),
        }) as never)}
      />,
    );
    await waitFor(() => screen.getByRole("tab", { name: /验证/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /验证/ }));
    await screen.findByText("工单尚未抵达或已被删除");
  });
});

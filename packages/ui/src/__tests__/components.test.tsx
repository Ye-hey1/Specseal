import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";

// 既有中文断言包 I18nProvider locale zh-CN 后照旧断言（i18n 抽 key 的回归保护）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

import { DocumentTree } from "../components/DocumentTree";
import { DocumentViewer } from "../components/DocumentViewer";
import { Markdown } from "../components/Markdown";
import { SECTION_HEADING_CLS } from "../components/DocParts";
import { ProposalDoc } from "../components/ProposalDoc";
import type { ChangeItem, SpecItem } from "../adapter";

const changes: ChangeItem[] = [
  { name: "desktop-shell-and-browser", status: "in-progress", totalTasks: 17, completedTasks: 11 },
  { name: "web-server-postgres", status: "pending", totalTasks: 0, completedTasks: 0 },
];
const specs: SpecItem[] = [{ id: "verb-contract" }, { id: "desktop-app" }];

describe("DocumentTree", () => {
  it("renders changes and specs, and calls onSelect on click", () => {
    const onSelect = vi.fn();
    render(<DocumentTree changes={changes} specs={specs} onSelect={onSelect} />);
    expect(screen.getByText("verb-contract")).toBeTruthy();
    fireEvent.click(screen.getByText("web-server-postgres"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "change", id: "web-server-postgres" });
  });
});

// spec「markdown 内容保留文档结构呈现」「raw HTML 不以原文呈现」（desktop-reading-experience）
describe("Markdown", () => {
  it("renders a single newline as a line break (soft break → <br>)", () => {
    const { container } = render(<Markdown content={"**Focus**: 甲\n**Position**: 乙"} />);
    expect(container.querySelector("br")).toBeTruthy();
  });

  it("does not render HTML comment text", () => {
    const { container } = render(
      <Markdown content={"<!-- secret-anchor entries appended by CLI -->\n\n正文段落"} />,
    );
    expect(container.textContent).not.toContain("secret-anchor");
    expect(container.textContent).toContain("正文段落");
  });

  it("keeps HTML inside code fences verbatim", () => {
    const { container } = render(<Markdown content={"```\n<div>x</div>\n```"} />);
    expect(container.textContent).toContain("<div>x</div>");
  });

  // 文档正文常把 `<name>` 当占位字写；占位字刚好是 HTML 标签名时，原始 HTML 若被解析，
  // <summary>／<details> 会把后文包进收合区块、<template> 会吞掉后文。原始 HTML 一律丢弃。
  it("drops raw HTML so placeholder-like tags do not hide or swallow the following text", () => {
    const { container } = render(
      <Markdown
        content={"- 格式 specseal(<change-name>): <summary> 与字段\n- 第二项 <template> 之后\n- 第三项 <details> 收合"}
      />,
    );
    expect(container.querySelector("summary, details, template")).toBeNull();
    for (const text of ["与字段", "之后", "第三项", "收合"]) expect(container.textContent).toContain(text);
  });

  it("does not render raw HTML elements or their id attributes", () => {
    const { container } = render(<Markdown content={'前 <span id="manual-h-1">中</span> 后'} />);
    expect(container.querySelector("#manual-h-1")).toBeNull();
    expect(container.textContent).toContain("中");
  });

  // spec「宽表格于容器内横卷」：表格外层容器横向可卷、不设高度上限。
  it("wraps wide tables in a horizontally scrollable container without a height cap", () => {
    const { container } = render(<Markdown content={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
    const scroller = container.querySelector('[data-streamdown="table"]')?.parentElement as HTMLElement;
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.style.maxHeight).toBe("");
  });

  it("renders inside the markdown hook class without typography prose (desktop-design-foundation D10)", () => {
    const { container } = render(<Markdown content={"hello"} />);
    const root = container.querySelector(".markdown");
    expect(root).toBeTruthy();
    expect(root?.className).not.toContain("prose");
  });

  // spec「markdown 文档内容行宽有上限」（design D3 文档容器）：
  // 固定行宽上限（96ch ≈ 48 全角字 @16px），抽屉全屏幕时行宽不随之增长。
  it("caps content line width instead of stretching full-bleed (markdown 文档内容行宽有上限)", () => {
    const { container } = render(<Markdown content={"hello"} />);
    const root = container.querySelector(".markdown");
    expect(root?.className).not.toContain("max-w-none");
    expect(root?.className).toContain("max-w-[96ch]");
  });
});

// spec 需求「提案与设计章节以中文标签呈现」（desktop-change-doc-views design D1 章节模型、D3 提案渲染器）。
describe("ProposalDoc 章节标签", () => {
  const PROPOSAL_MD = [
    "## Why",
    "",
    "动机段落。",
    "",
    "## What Changes",
    "",
    "- 第一项变更",
    "",
    "## Non-Goals",
    "",
    "- 不做的事",
    "",
    "## Capabilities",
    "",
    "### Modified Capabilities",
    "",
    "- desktop-app: 章节呈现",
    "",
    "## Impact",
    "",
    "- Affected specs: desktop-app",
  ].join("\n");

  it("提案模板章节渲染中文标签，英文标题不直出", () => {
    render(<ProposalDoc content={PROPOSAL_MD} deltaCaps={[]} />);
    for (const label of ["为什幺", "变更内容", "非目标", "能力", "影响"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("动机段落。")).toBeTruthy();
    expect(screen.queryByText("Why")).toBeNull();
    expect(screen.queryByText("What Changes")).toBeNull();
    expect(screen.queryByText("Impact")).toBeNull();
  });

  it("设计模板章节渲染中文标签（含斜线复合词）", () => {
    const md = "## Context\n\n背景内文。\n\n## Decisions\n\n决策内文。\n\n## Risks / Trade-offs\n\n风险内文。\n";
    render(<ProposalDoc content={md} deltaCaps={[]} />);
    expect(screen.getByText("背景")).toBeTruthy();
    expect(screen.getByText("决策")).toBeTruthy();
    expect(screen.getByText("风险与取舍")).toBeTruthy();
    expect(screen.queryByText("Context")).toBeNull();
    expect(screen.queryByText(/Trade-offs/)).toBeNull();
  });

  it("白名单外标题以原文成段（不翻译），内文照排", () => {
    const md = "## Decisions\n\n### D1 章节切分：白名单映射\n\n决策细节。\n\n## 自订章节\n\n自订内文。\n";
    render(<ProposalDoc content={md} deltaCaps={[]} />);
    expect(screen.getByText("决策")).toBeTruthy();
    // 自订决策标题照 prose 渲染；自订章节以原文为段标题。
    expect(screen.getByText(/D1 章节切分/)).toBeTruthy();
    expect(screen.getByText("自订章节")).toBeTruthy();
    expect(screen.getByText("自订内文。")).toBeTruthy();
  });

  it("模板附注 (optional) 于比对前剥除", () => {
    render(<ProposalDoc content={"## Non-Goals (optional)\n\n- 不做\n"} deltaCaps={[]} />);
    expect(screen.getByText("非目标")).toBeTruthy();
    expect(screen.queryByText(/Non-Goals/)).toBeNull();
  });

  // spec「章节标题为 16px 粗体」（desktop-change-doc-views design D2 单一常数）。
  it("章节标题为 16px 粗体款式（引用共用常数）", () => {
    render(<ProposalDoc content={PROPOSAL_MD} deltaCaps={[]} />);
    const label = screen.getByText("为什幺");
    for (const cls of SECTION_HEADING_CLS.split(" ")) expect(label.className).toContain(cls);
    expect(label.className).toContain("text-base");
    expect(label.className).toContain("font-semibold");
    for (const stale of ["text-xs", "uppercase", "tracking-wider", "text-muted-foreground"]) {
      expect(label.className).not.toContain(stale);
    }
  });

  it("没有任何二级标题时整篇退回单一 markdown 查看", () => {
    const { container } = render(<ProposalDoc content={"# 自由文档\n\n段落内容而已。\n"} deltaCaps={[]} />);
    expect(screen.getByText("段落内容而已。")).toBeTruthy();
    expect(container.querySelectorAll("[data-section]").length).toBe(0);
  });
});

describe("DocumentViewer", () => {
  it("renders the given document content", () => {
    render(<DocumentViewer content={"## Why\nbecause"} />);
    expect(screen.getByText(/because/)).toBeTruthy();
  });

  it("shows an empty state when content is null", () => {
    render(<DocumentViewer content={null} />);
    expect(screen.getByText(/选择|no document|select/i)).toBeTruthy();
  });
});

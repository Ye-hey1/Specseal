// spec 需求「看板搜索过滤卡片」的搜索列（design D5）：搜索图标、输入非空时的
// 清除钮（清空后保持聚焦）与即时命中数、Cmd+F／Ctrl+F 聚焦快捷键。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement, type ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { KanbanBoard } from "../components/KanbanBoard";
import type { ChangeItem, DiscussionLists } from "../adapter";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const changes: ChangeItem[] = [
  {
    name: "engine-typed-core",
    status: "in-progress",
    totalTasks: 18,
    completedTasks: 0,
    summary: "typed 命令层",
    createdBy: "Momo Chen <momo@example.com>",
    fromDiscussions: ["collab"],
  },
  {
    name: "web-role-views",
    status: "in-progress",
    totalTasks: 5,
    completedTasks: 5,
    summary: "情境 1",
    createdBy: "Ann <ann@example.com>",
  },
];
const discussions: DiscussionLists = {
  active: [
    { slug: "board-search", topic: "看板搜索", status: "open", rounds: 1, created: "2026-07-10", promotedTo: [] },
    {
      slug: "collab",
      topic: "多人协作",
      status: "promoted",
      rounds: 9,
      created: "2026-07-01",
      promotedTo: ["engine-typed-core"],
    },
  ],
  archived: [],
};

/** 受控 query 的宿主——仿真 App 的 store 接线。 */
function Host() {
  const [q, setQ] = useState("");
  return <KanbanBoard changes={changes} discussions={discussions} query={q} onQuery={setQ} />;
}

describe("BoardSearchBar（搜索列，design D5）", () => {
  it("空 query 无清除钮与命中数；输入后显示；点清除还原全量且输入保持聚焦", () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    fireEvent.change(input, { target: { value: "engine" } });
    // 命中数＝过滤后卡片总数（engine-typed-core 1 张）。
    expect(screen.getByText("1 张卡")).toBeTruthy();
    expect(screen.queryByText("web-role-views")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("web-role-views")).toBeTruthy();
  });

  it("Cmd+F（或 Ctrl+F）聚焦搜索输入", () => {
    render(<Host />);
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("macOS 原生菜单的「搜索看板」以 specseal:focus-search 事件聚焦搜索输入", () => {
    render(<Host />);
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    expect(document.activeElement).not.toBe(input);
    fireEvent(window, new CustomEvent("specseal:focus-search"));
    expect(document.activeElement).toBe(input);
  });

  it("卡片查看被藏起来时（宿主给 onRevealSearch）快捷键与菜单事件改调用它，不聚焦藏起来的输入", () => {
    const onRevealSearch = vi.fn();
    render(<KanbanBoard changes={changes} discussions={discussions} query="" onQuery={() => {}} onRevealSearch={onRevealSearch} />);
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    fireEvent(window, new CustomEvent("specseal:focus-search"));
    expect(onRevealSearch).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(input);
  });

  it("搜索图标呈现于输入框内", () => {
    render(<Host />);
    expect(document.querySelector("svg.lucide-search")).toBeTruthy();
  });
});

// spec 需求「看板搜索过滤卡片」的筛选面板（design D5）：收于漏斗开关的弹出面板、
// 三维度菜单、与搜索字符串 AND 交集、可单独清除与全部清除、关闭不清除过滤。
//
// 三个维度改用 Radix Select 后不再是原生 <select>，操作路径是「点开 trigger → 点击项」。
// Radix 打开时会把 body 的 pointer-events 关掉（避免背景误触），jsdom 没有真实命中测试，
// 所以关掉 userEvent 的 pointer-events 检查。
const pointer = () => userEvent.setup({ pointerEventsCheck: 0 });

/** 点开某个维度的下拉并选中一个选项。 */
async function pick(dimension: string, option: string) {
  const user = pointer();
  await user.click(screen.getByLabelText(dimension));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("筛选面板（design D5）", () => {
  it("面板缺省关闭；点筛选钮弹出三维度；关闭后过滤持续且钮带激活计数", async () => {
    render(<Host />);
    // 缺省：单列只有搜索框与筛选钮，面板不占版面。
    expect(screen.queryByLabelText("创建者")).toBeNull();
    const toggle = screen.getByRole("button", { name: "筛选" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // 弹出：三个维度菜单可见。
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("创建者")).toBeTruthy();
    expect(screen.getByLabelText("创建时间")).toBeTruthy();
    expect(screen.getByLabelText("来源讨论")).toBeTruthy();
    // 激活一个维度后关闭面板：面板消失、过滤持续、钮带计数。
    await pick("创建时间", "近 7 天");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("创建时间")).toBeNull();
    expect(toggle.textContent).toContain("1");
    // 过滤持续生效：变更卡无 created → 被近 7 天窗过滤。
    expect(document.querySelector('[data-change="engine-typed-core"]')).toBeNull();
  });

  it("按 Esc 关闭面板", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByLabelText("创建者")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("创建者")).toBeNull();
  });

  it("创建者筛选过滤卡片；与搜索字符串 AND 交集；选回全部即单独清除", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await pick("创建者", "Momo Chen <momo@example.com>");
    expect(screen.getByText("engine-typed-core")).toBeTruthy();
    expect(screen.queryByText("web-role-views")).toBeNull();
    // AND 交集：query 命中另一张 → 两张皆不可见。
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    fireEvent.change(input, { target: { value: "web" } });
    expect(document.querySelector('[data-change="engine-typed-core"]')).toBeNull();
    expect(document.querySelector('[data-change="web-role-views"]')).toBeNull();
    // 单独清除（选回全部）：回到仅以字符串过滤（卡名经高亮 mark 拆分，改以 data-change 查找）。
    await pick("创建者", "全部");
    expect(document.querySelector('[data-change="web-role-views"]')).toBeTruthy();
  });

  it("面板内全部清除还原所有维度", async () => {
    render(<Host />);
    const toggle = screen.getByRole("button", { name: "筛选" });
    fireEvent.click(toggle);
    await pick("创建者", "Momo Chen <momo@example.com>");
    await pick("创建时间", "近 7 天");
    fireEvent.click(screen.getByRole("button", { name: "清除全部筛选" }));
    expect(document.querySelector('[data-change="web-role-views"]')).toBeTruthy();
    expect(document.querySelector('[data-change="engine-typed-core"]')).toBeTruthy();
    expect(toggle.textContent).not.toContain("2");
  });

  it("来源讨论筛选：显示该讨论卡自身与其衍生变更卡", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await pick("来源讨论", "collab");
    expect(screen.getByText("engine-typed-core")).toBeTruthy();
    expect(screen.queryByText("web-role-views")).toBeNull();
    // 非来源的 open 讨论卡也被过滤。
    expect(screen.queryByText("board-search")).toBeNull();
    // 该讨论自身（promoted）计入栏底收合列。
    expect(screen.getByRole("button", { name: /已转出/ }).textContent).toContain("1");
  });

  it("创建时间筛选提供三窗选项", async () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await pointer().click(screen.getByLabelText("创建时间"));
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(labels).toContain("近 7 天");
    expect(labels).toContain("近 30 天");
    expect(labels).toContain("更早");
  });
});

// spec 需求「看板搜索过滤卡片」的全文与模糊比对层（design D6/D7）。
describe("全文命中与名称层模糊比对并入可见集合", () => {
  it("字段不命中但全文命中的卡片显示；字段与全文皆不命中者隐藏", () => {
    render(
      <KanbanBoard
        changes={changes}
        discussions={discussions}
        query="dispatch"
        onQuery={() => {}}
        fulltextHits={[
          { kind: "change", id: "web-role-views", artifact: "design.md", snippet: "…唯一 dispatch 兼容层…" },
        ]}
      />,
    );
    expect(screen.getByText("web-role-views")).toBeTruthy();
    expect(screen.queryByText("engine-typed-core")).toBeNull();
  });

  it("名称层 subsequence 模糊命中（etc → engine-typed-core）", () => {
    render(
      <KanbanBoard changes={changes} discussions={discussions} query="etc" onQuery={() => {}} />,
    );
    expect(screen.getByText("engine-typed-core")).toBeTruthy();
    expect(screen.queryByText("web-role-views")).toBeNull();
  });

  it("searchUnavailableReason 停用搜索输入并附说明（remote capability 缺口）", () => {
    render(
      <KanbanBoard
        changes={changes}
        discussions={discussions}
        query=""
        onQuery={() => {}}
        searchUnavailableReason="此 server 尚未提供全文搜索——功能已停用"
      />,
    );
    const input = screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.title).toBe("此 server 尚未提供全文搜索——功能已停用");
  });

  it("未提供 searchUnavailableReason 时搜索照常可用（本地不受影响）", () => {
    render(
      <KanbanBoard changes={changes} discussions={discussions} query="" onQuery={() => {}} />,
    );
    const input = screen.getByPlaceholderText("搜索看板卡片…") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});

// desktop-board-reskin design D4：搜索输入为 280px 全圆（左留搜索图标位、输入非空时右留命中数
// 与清除钮位）、筛选钮为 32px 圆角图标钮，两者同列置于页标题区右端；容器不再填满整列。
describe("搜索列外观（desktop-board-reskin D4）", () => {
  it("输入为 h-8 w-[280px] rounded-full pl-8；输入非空时改 pr-24（三位数命中数与清除钮放得下）", () => {
    render(<Host />);
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    const cls = () => input.className.split(/\s+/);
    expect(cls()).toContain("rounded-full");
    expect(cls()).toContain("w-[280px]");
    expect(cls()).toContain("h-8");
    expect(cls()).toContain("pl-8");
    expect(cls()).not.toContain("pr-24");
    fireEvent.change(input, { target: { value: "engine" } });
    expect(cls()).toContain("pr-24");
  });

  it("容器不再 w-full；筛选钮为 32px rounded-lg 图标钮、激活计数角标照旧", async () => {
    render(<Host />);
    const input = screen.getByPlaceholderText("搜索看板卡片…");
    const container = input.parentElement!.parentElement as HTMLElement;
    expect(container.className.split(/\s+/)).not.toContain("w-full");
    const toggle = screen.getByRole("button", { name: "筛选" });
    const cls = toggle.className.split(/\s+/);
    expect(cls).toContain("rounded-lg");
    expect(cls).toContain("h-8");
    expect(cls).toContain("w-8");
    fireEvent.click(toggle);
    await pick("创建时间", "近 7 天");
    expect(toggle.textContent).toContain("1");
  });

  it("筛选钮走 toggle 变体：展开态底色由 aria-expanded 带出，调用端不随开阖切换颜色 class", () => {
    render(<Host />);
    const toggle = screen.getByRole("button", { name: "筛选" });
    const staticCls = () => toggle.className.split(/\s+/).filter((c) => !c.includes(":"));
    expect(toggle.className).toContain("aria-expanded:bg-muted");
    expect(staticCls()).toContain("text-muted-foreground");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(staticCls()).not.toContain("bg-muted");
    expect(staticCls()).toContain("text-muted-foreground");
  });

  it("传 title 时搜索列直接落在页标题区动作槽，没有 22rem 的包裹层", () => {
    render(
      <KanbanBoard changes={changes} discussions={discussions} query="" onQuery={() => {}} title="变更" />,
    );
    const header = screen.getByRole("heading", { level: 2, name: "变更" }).closest("[data-page-header]") as HTMLElement;
    expect(header.innerHTML).not.toContain("w-[22rem]");
    expect(screen.getByPlaceholderText("搜索看板卡片…").closest("[data-page-header]")).toBe(header);
  });
});

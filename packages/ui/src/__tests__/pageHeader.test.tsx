// 页标题区原语（design D6）：24px 一般字重标题＋灰字说明＋右侧动作槽。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PageHeader } from "../components/ui/page-header";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("PageHeader", () => {
  it("标题为 2xl 一般字重的 h2、说明为 13px 灰字、动作槽在右侧", () => {
    render(
      <PageHeader title="变更" description="依生命周期分栏。" actions={<button>搜索</button>} />,
    );
    const title = screen.getByRole("heading", { level: 2, name: "变更" });
    expect(classes(title)).toEqual(expect.arrayContaining(["text-2xl", "font-normal"]));
    expect(classes(screen.getByText("依生命周期分栏。"))).toEqual(
      expect.arrayContaining(["text-[13px]", "text-muted-foreground"]),
    );
    const slot = screen.getByRole("button", { name: "搜索" }).parentElement as HTMLElement;
    expect(classes(slot)).toEqual(expect.arrayContaining(["flex", "items-center", "shrink-0"]));
    const root = title.closest("[data-page-header]") as HTMLElement;
    expect(classes(root)).toEqual(expect.arrayContaining(["flex", "items-end", "justify-between"]));
  });

  it("level={1} 渲染 h1、未给时仍为 h2，样式相同", () => {
    const { unmount } = render(<PageHeader level={1} title="用户" />);
    const h1 = screen.getByRole("heading", { level: 1, name: "用户" });
    expect(classes(h1)).toEqual(expect.arrayContaining(["text-2xl", "font-normal"]));
    unmount();
    render(<PageHeader title="用户" />);
    expect(screen.getByRole("heading", { level: 2, name: "用户" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("说明与动作槽皆选配", () => {
    render(<PageHeader title="规格" />);
    const root = screen.getByRole("heading", { name: "规格" }).closest("[data-page-header]") as HTMLElement;
    expect(root.querySelector("p")).toBeNull();
    expect(root.children).toHaveLength(1);
  });

  // server-web-detail-pages design D8：详情页的状态签接在标题文本后面，标题仍是同一个 heading。
  it("给 badge 时状态签与标题同一列、标题仍是唯一 heading 且字级不变", () => {
    render(<PageHeader level={1} title="Member" badge={<span>有效</span>} />);
    const headings = screen.getAllByRole("heading");
    expect(headings).toHaveLength(1);
    const title = screen.getByRole("heading", { level: 1, name: "Member" });
    expect(classes(title)).toEqual(expect.arrayContaining(["text-2xl", "font-normal"]));
    const row = screen.getByText("有效").parentElement as HTMLElement;
    expect(title.parentElement).toBe(row);
    expect(classes(row)).toEqual(expect.arrayContaining(["flex", "items-center", "gap-2"]));
  });

  it("不给 badge 时标题直接在标题栏内（DOM 与加槽前相同）", () => {
    render(<PageHeader level={1} title="用户" description="说明" />);
    const title = screen.getByRole("heading", { level: 1, name: "用户" });
    const column = title.parentElement as HTMLElement;
    expect(classes(column)).toEqual(expect.arrayContaining(["min-w-0", "grow", "basis-64"]));
    expect(column.children).toHaveLength(2);
  });

  // server-web-list-pages design D1：放不下时动作槽换到标题下方一列，槽内控件再各自换行。
  it("根节点与动作槽带 flex-wrap，动作槽宽度不超过整列", () => {
    render(<PageHeader title="用户" actions={<button>邀请用户</button>} />);
    const slot = screen.getByRole("button", { name: "邀请用户" }).parentElement as HTMLElement;
    const root = slot.closest("[data-page-header]") as HTMLElement;
    expect(classes(root)).toContain("flex-wrap");
    expect(classes(slot)).toEqual(expect.arrayContaining(["flex-wrap", "max-w-full"]));
  });
});

// 共用面包屑（server-web-shell-alignment design D4）：desktop 主区顶列与 server 后台共用一份。
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Breadcrumbs } from "../components/Breadcrumbs";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("Breadcrumbs", () => {
  it("项与项之间是「/」，最后一项为前景色，外层 nav 标为页面路径", () => {
    render(<Breadcrumbs crumbs={[{ label: "项目" }, { label: "变更" }, { label: "add-auth" }]} />);
    const nav = screen.getByRole("navigation", { name: "页面路径" });
    expect(nav.textContent).toBe("项目/变更/add-auth");
    expect(screen.getAllByText("/")).toHaveLength(2);
    expect(classes(screen.getByText("add-auth"))).toContain("text-foreground");
    expect(classes(screen.getByText("项目"))).not.toContain("text-foreground");
  });

  it("有 onClick 的项是按钮且点击调用回呼，没有的项不是按钮", async () => {
    const user = userEvent.setup();
    const onHome = vi.fn();
    render(<Breadcrumbs crumbs={[{ label: "后台", onClick: onHome }, { label: "用户" }]} />);
    await user.click(screen.getByRole("button", { name: "后台" }));
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "用户" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // 键盘聚焦时显示 2px focus ring（共用 ring token），不靠浏览器缺省外框。
    expect(classes(screen.getByRole("button", { name: "后台" }))).toEqual(
      expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-ring"]),
    );
  });

  it("mono 项用等宽字体", () => {
    render(<Breadcrumbs crumbs={[{ label: "变更" }, { label: "add-auth", mono: true }]} />);
    expect(classes(screen.getByText("add-auth"))).toContain("font-mono");
    expect(classes(screen.getByText("变更"))).not.toContain("font-mono");
  });
});

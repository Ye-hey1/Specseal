// 共用导览项（design D4）：desktop 项目栏与 server-web 管理面导览同一份。
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Archive } from "lucide-react";

import { NavItem } from "../components/NavItem";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("NavItem", () => {
  it("32px 高、8px 圆角；作用中为主色淡底主色字", () => {
    render(<NavItem icon={<Archive />} label="变更" active onClick={() => {}} />);
    const item = screen.getByRole("button", { name: "变更" });
    expect(classes(item)).toEqual(
      expect.arrayContaining(["h-8", "rounded-lg", "bg-primary/12", "text-primary", "font-medium"]),
    );
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("非作用中为一般字色、无主色淡底", () => {
    render(<NavItem icon={<Archive />} label="规格" />);
    const item = screen.getByRole("button", { name: "规格" });
    expect(classes(item)).toContain("text-foreground");
    expect(classes(item)).not.toContain("bg-primary/12");
    expect(item.getAttribute("aria-current")).toBeNull();
  });

  it("计数徽章渲染在右端；ariaLabel 让无障碍名称不含数字", () => {
    const onClick = vi.fn();
    render(<NavItem icon={<Archive />} label="已封存" ariaLabel="已封存" count={7} onClick={onClick} />);
    const item = screen.getByRole("button", { name: "已封存" });
    const badge = screen.getByText("7");
    expect(item.contains(badge)).toBe(true);
    expect(classes(badge)).toEqual(expect.arrayContaining(["ml-auto", "rounded-full", "text-[11px]"]));
    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("count 为 0 仍显示徽章（数字本身是信息）", () => {
    render(<NavItem icon={<Archive />} label="已封存" count={0} />);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("asChild：渲染成子元素（如路由链接），图标与标签落在子元素内", () => {
    render(
      <NavItem asChild icon={<Archive data-testid="icon" />} label="成员" active>
        <a href="/admin/members" />
      </NavItem>,
    );
    const link = screen.getByRole("link", { name: "成员" });
    expect(link.getAttribute("href")).toBe("/admin/members");
    expect(classes(link)).toEqual(expect.arrayContaining(["h-8", "text-primary"]));
    expect(link.contains(screen.getByTestId("icon"))).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // desktop-subagent-model-page design「NavItem 的子项变体」：设置分类栏上层分类底下的子项。
  it("子项变体：不渲染图标、28px 高、文本左缘对齐缺省变体的文本；选中带 aria-current", () => {
    render(<NavItem variant="sub" icon={<Archive data-testid="icon" />} label="审查规则" active onClick={() => {}} />);
    const item = screen.getByRole("button", { name: "审查规则" });
    expect(screen.queryByTestId("icon")).toBeNull();
    expect(item.querySelector("svg")).toBeNull();
    expect(classes(item)).toEqual(expect.arrayContaining(["h-7", "pl-[34px]", "bg-primary/12", "text-primary"]));
    expect(classes(item)).not.toContain("h-8");
    expect(item.getAttribute("aria-current")).toBe("page");
  });

  it("子项变体未选中时为一般字色、无 aria-current", () => {
    render(<NavItem variant="sub" label="子代理模型" />);
    const item = screen.getByRole("button", { name: "子代理模型" });
    expect(classes(item)).toContain("text-foreground");
    expect(item.getAttribute("aria-current")).toBeNull();
  });

  it("不传 variant 时维持缺省变体：32px 高、渲染图标、左右同内距", () => {
    render(<NavItem icon={<Archive data-testid="icon" />} label="变更" />);
    const item = screen.getByRole("button", { name: "变更" });
    expect(classes(item)).toEqual(expect.arrayContaining(["h-8", "px-2.5"]));
    expect(classes(item)).not.toContain("pl-[34px]");
    expect(item.contains(screen.getByTestId("icon"))).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Input } from "../components/ui/input";

// spec 需求「共用设计系统维持高密度可访问体验」添加的控件契约：接口上的下拉列表一律
// 使用这个 Select 原语，不再有未套用 theme 的原生 <select>。原生控件展开后的清单由作业
// 系统绘制，focus ring、选中态与圆角都跟不上 theme——被换掉的正是那一层。
// 这里钉住的是「键盘路径不因换掉原生控件而退化」：打开、移动、选取三步都要可键盘完成。

function Fixture({ onValueChange }: { onValueChange?: (value: string) => void }) {
  return (
    <Select defaultValue="active" onValueChange={onValueChange}>
      <SelectTrigger aria-label="状态">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="active">有效</SelectItem>
        <SelectItem value="suspended">已停权</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select 原语", () => {
  it("以 role=combobox 呈现且显示当前选中值", () => {
    render(<Fixture />);
    const trigger = screen.getByRole("combobox", { name: "状态" });
    expect(trigger.textContent).toContain("有效");
    // 原生 select 不得残留：整份画面上没有 <select> 标签。
    expect(document.querySelector("select")).toBeNull();
  });

  it("Enter 打开菜单、方向键移动、Enter 选取后回报选中值", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox", { name: "状态" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("listbox")).toBeTruthy();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("suspended");
    expect(screen.getByRole("combobox", { name: "状态" }).textContent).toContain("已停权");
  });

  it("Space 亦可打开菜单", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    screen.getByRole("combobox", { name: "状态" }).focus();
    await user.keyboard("{ }");
    expect(await screen.findByRole("listbox")).toBeTruthy();
  });
});

describe("Select 与 Input 的视觉一致", () => {
  it("trigger 与 Input 共用高度、内距、圆角、无阴影与聚焦样式（design D5）", () => {
    render(
      <>
        <Input />
        <Fixture />
      </>,
    );
    const input = screen.getByRole("textbox");
    const trigger = screen.getByRole("combobox", { name: "状态" });
    // 并排时看得出差异的几项：高度、水平内距、圆角、聚焦框；两者都不带阴影。
    for (const cls of [
      "h-8",
      "px-3",
      "rounded-lg",
      "focus-visible:border-ring",
      "focus-visible:ring-2",
      "focus-visible:ring-ring/30",
    ]) {
      expect(input.className.split(/\s+/), `Input 应有 ${cls}`).toContain(cls);
      expect(trigger.className.split(/\s+/), `SelectTrigger 应有 ${cls}`).toContain(cls);
    }
    expect(input.className).not.toContain("shadow");
    expect(trigger.className).not.toContain("shadow");
  });

  it("菜单面板 12px 圆角带淡阴影、选项 8px 圆角 hover 灰底、选取只呈勾号不填主色", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("combobox", { name: "状态" }));
    // Radix 的 SelectContent 本身就是 role=listbox 的元素。
    const contentCls = (await screen.findByRole("listbox")).className.split(/\s+/);
    for (const cls of ["min-w-56", "rounded-xl", "p-1.5", "shadow-lg", "shadow-black/5"]) {
      expect(contentCls, `SelectContent 应有 ${cls}`).toContain(cls);
    }
    const option = screen.getAllByRole("option")[0];
    const optionCls = option.className.split(/\s+/);
    for (const cls of ["rounded-lg", "px-2.5", "py-1.5", "text-[13px]", "focus:bg-muted"]) {
      expect(optionCls, `SelectItem 应有 ${cls}`).toContain(cls);
    }
    expect(option.className).not.toContain("bg-primary");
    expect(option.className).not.toContain("bg-accent");
  });
});

describe("@specseal/ui 导出面", () => {
  it("导出 shadcn 命名的 Select 家族", async () => {
    const ui = await import("../index");
    for (const name of ["Select", "SelectTrigger", "SelectValue", "SelectContent", "SelectItem"]) {
      expect(name in ui, `@specseal/ui 应导出 ${name}`).toBe(true);
    }
  });

  it("不再导出 NativeSelect", async () => {
    const ui = await import("../index");
    expect("NativeSelect" in ui).toBe(false);
  });
});

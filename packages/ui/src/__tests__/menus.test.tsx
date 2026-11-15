// 下拉列表、右键菜单与 Kbd 原语（design D5）：两套菜单共用同一组 class 常数。
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { Kbd, MenuShortcut } from "../components/ui/kbd";

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("DropdownMenu", () => {
  it("触发后 Content 为 12px 圆角浮层、Item 8px 圆角、destructive 红字、Shortcut 为 <kbd>、有分隔线", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>开</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>标签</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onRefresh}>
            刷新
            <MenuShortcut>⌘R</MenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">关闭项目</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByText("开"));

    const menu = screen.getByRole("menu");
    expect(classes(menu)).toEqual(expect.arrayContaining(["rounded-xl", "shadow-lg", "bg-card"]));
    const refresh = screen.getByRole("menuitem", { name: /刷新/ });
    expect(classes(refresh)).toEqual(expect.arrayContaining(["rounded-lg", "h-8"]));
    expect(screen.getByText("⌘R").tagName).toBe("KBD");
    expect(classes(screen.getByRole("menuitem", { name: "关闭项目" }))).toContain("text-destructive");
    expect(classes(refresh)).not.toContain("text-destructive");
    expect(screen.getByRole("separator")).toBeTruthy();

    await user.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("单选群组的项角色为 menuitemradio，选中项 aria-checked，选另一项触发 onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>语言</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="zh-CN" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="zh-CN">繁体中文</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByText("语言"));

    const zh = screen.getByRole("menuitemradio", { name: "繁体中文" });
    const en = screen.getByRole("menuitemradio", { name: "English" });
    expect(zh.getAttribute("aria-checked")).toBe("true");
    expect(en.getAttribute("aria-checked")).toBe("false");
    expect(classes(en)).toEqual(expect.arrayContaining(["rounded-lg", "h-8"]));

    await user.click(en);
    expect(onValueChange).toHaveBeenCalledWith("en");
  });
});

describe("ContextMenu", () => {
  it("右键打开，Content／Item／destructive 与下拉列表同一组 class", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>方块</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>错误</ContextMenuLabel>
          <ContextMenuItem>在 Finder 显示</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">
            关闭项目
            <MenuShortcut>⌘W</MenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("方块"));

    expect(classes(screen.getByRole("menu"))).toEqual(
      expect.arrayContaining(["rounded-xl", "shadow-lg", "bg-card"]),
    );
    expect(classes(screen.getByRole("menuitem", { name: "在 Finder 显示" }))).toEqual(
      expect.arrayContaining(["rounded-lg", "h-8"]),
    );
    expect(classes(screen.getByRole("menuitem", { name: /^关闭项目/ }))).toContain("text-destructive");
    expect(screen.getByRole("separator")).toBeTruthy();
    // 快捷键槽两套菜单共用同一个组件：右端对齐的 <kbd>。
    const shortcut = screen.getByText("⌘W");
    expect(shortcut.tagName).toBe("KBD");
    expect(classes(shortcut)).toContain("ml-auto");
  });
});

describe("Kbd", () => {
  it("等宽 11px 灰字", () => {
    render(<Kbd>Ctrl+W</Kbd>);
    const kbd = screen.getByText("Ctrl+W");
    expect(kbd.tagName).toBe("KBD");
    expect(classes(kbd)).toEqual(
      expect.arrayContaining(["font-mono", "text-[11px]", "text-muted-foreground"]),
    );
  });

  it("variant=inherit 跟随所在元素的字色（放在按钮内）", () => {
    render(<Kbd variant="inherit">Ctrl+S</Kbd>);
    const cls = classes(screen.getByText("Ctrl+S"));
    expect(cls).toEqual(expect.arrayContaining(["font-mono", "text-[11px]", "opacity-80"]));
    expect(cls).not.toContain("text-muted-foreground");
  });
});

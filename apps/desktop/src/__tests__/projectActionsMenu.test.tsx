// 项目动作菜单（desktop-app「项目层文档系统动作」，design D5）：标题列「⋯」与
// 图标列方块右键渲染同一份项目。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  I18nProvider,
} from "@specseal/ui";

import { ProjectActionItems, type ProjectActions } from "../components/ProjectActionsMenu";
import { APP_MESSAGES } from "../i18n/messages";
import type { Platform } from "../platform";
import type { ProjectTab } from "../tabs";

const zh = APP_MESSAGES["zh-CN"];
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const LOCAL: ProjectTab = { locator: { kind: "local", root: "/work/alpha" }, name: "alpha" };
const REMOTE_NO_CHECKOUT: ProjectTab = {
  locator: { kind: "remote", connectionId: "c1", projectId: "demo", repoId: "api" },
  name: "Demo/api",
};
const REMOTE_CHECKOUT: ProjectTab = {
  locator: {
    kind: "remote",
    connectionId: "c1",
    projectId: "demo",
    repoId: "web",
    checkoutRoot: "/work/web",
  },
  name: "Demo/web",
};

function fakeActions(): ProjectActions {
  return {
    reveal: vi.fn(),
    openTerminal: vi.fn(),
    openEditor: vi.fn(),
    copyPath: vi.fn(),
    refresh: vi.fn(),
    close: vi.fn(),
  };
}

/** 受控开着的下拉列表：点项目不会关闭，可逐项点击。 */
function renderDropdown(
  tab: ProjectTab,
  { platform = "macos", error }: { platform?: Platform; error?: string } = {},
) {
  const actions = fakeActions();
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>⋯</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ProjectActionItems menu="dropdown" tab={tab} platform={platform} actions={actions} error={error} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return actions;
}

const itemNames = () =>
  screen.getAllByRole("menuitem").map((item) => item.querySelector("span")?.textContent ?? "");

describe("ProjectActionItems", () => {
  it("本机项目：六个动作项与一条分隔线，顺序固定", () => {
    renderDropdown(LOCAL);
    expect(itemNames()).toEqual([
      "在 Finder 显示",
      "在终端机打开",
      "以编辑器打开",
      "拷贝路径",
      "刷新",
      "关闭项目",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("各项点击调用对应动作一次，带该项目的 locator key", () => {
    const actions = renderDropdown(LOCAL);
    const key = "local:/work/alpha";
    for (const [label, fn] of [
      ["在 Finder 显示", actions.reveal],
      ["在终端机打开", actions.openTerminal],
      ["以编辑器打开", actions.openEditor],
      ["拷贝路径", actions.copyPath],
      ["刷新", actions.refresh],
      ["关闭项目", actions.close],
    ] as const) {
      fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${label}`) }));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(key);
    }
  });

  it("拷贝路径右端显示路径尾段；快捷键以 <kbd> 显示；关闭项目为红字", () => {
    renderDropdown(LOCAL);
    expect(screen.getByRole("menuitem", { name: /^拷贝路径/ }).textContent).toContain("alpha");
    expect(screen.getByText("⌘R").tagName).toBe("KBD");
    expect(screen.getByText("⌘W").tagName).toBe("KBD");
    expect(screen.getByRole("menuitem", { name: /^关闭项目/ }).className).toContain("text-destructive");
  });

  it("remote 无 checkout：只有刷新与关闭项目", () => {
    renderDropdown(REMOTE_NO_CHECKOUT);
    expect(itemNames()).toEqual(["刷新", "关闭项目"]);
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("remote 有 checkout：四个文档系统项目在、路径尾段取 checkout", () => {
    const actions = renderDropdown(REMOTE_CHECKOUT);
    expect(itemNames()).toHaveLength(6);
    expect(screen.getByRole("menuitem", { name: /^拷贝路径/ }).textContent).toContain("web");
    fireEvent.click(screen.getByRole("menuitem", { name: /^以编辑器打开/ }));
    expect(actions.openEditor).toHaveBeenCalledWith("remote:c1/demo/web");
  });

  it("错误变体：首列为错误消息，其后只有「自项目列移除」", () => {
    const actions = renderDropdown(LOCAL, { error: "目录不存在" });
    const label = screen.getByText("目录不存在");
    expect(label.className).toContain("text-destructive");
    expect(itemNames()).toEqual([zh["app.removeTab"]]);
    fireEvent.click(screen.getByRole("menuitem", { name: zh["app.removeTab"] }));
    expect(actions.close).toHaveBeenCalledWith("local:/work/alpha");
  });

  it.each([
    ["macos", "在 Finder 显示", "⌘R"],
    ["windows", "在文档总管显示", "Ctrl+R"],
    ["linux", "在文档管理员显示", "Ctrl+R"],
  ] as const)("%s：文档管理员名称与快捷键随平台", (platform, reveal, shortcut) => {
    renderDropdown(LOCAL, { platform });
    expect(itemNames()[0]).toBe(reveal);
    expect(screen.getByText(shortcut)).toBeTruthy();
  });

  it("右键菜单渲染同一份项目", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>alpha</ContextMenuTrigger>
        <ContextMenuContent>
          <ProjectActionItems menu="context" tab={LOCAL} platform="macos" actions={fakeActions()} />
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("alpha"));
    expect(itemNames()).toHaveLength(6);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });
});

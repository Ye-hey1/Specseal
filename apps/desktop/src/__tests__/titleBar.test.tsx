// 三平台标题列（desktop-app「隐藏原生标题列与三平台窗口壳」，design D1／D6）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { LeftTitleBar, MainTitleBar } from "../components/TitleBar";
import { APP_MESSAGES } from "../i18n/messages";
import defaultCapsRaw from "../../src-tauri/capabilities/default.json?raw";
import baseConfRaw from "../../src-tauri/tauri.conf.json?raw";
import macConfRaw from "../../src-tauri/tauri.macos.conf.json?raw";
import winConfRaw from "../../src-tauri/tauri.windows.conf.json?raw";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

function mockWindow(maximized = false) {
  let onResized: (() => void) | undefined;
  const win = {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(maximized),
    onResized: vi.fn(async (handler: () => void) => {
      onResized = handler;
      return () => {};
    }),
  };
  vi.mocked(getCurrentWindow).mockReturnValue(win as unknown as ReturnType<typeof getCurrentWindow>);
  return { win, resize: () => onResized?.() };
}

beforeEach(() => {
  vi.mocked(getCurrentWindow).mockReset();
});

describe("LeftTitleBar", () => {
  it("项目名左缘对齐下方项目栏导览文本（98px）、可拖拽、纯文本标题 hover 显示路径", () => {
    render(<LeftTitleBar title="specseal" path="/Users/a/specseal" menu={<button>⋯</button>} />);
    const bar = screen.getByTestId("left-titlebar");
    // 图标列 56＋项目栏内距 8＋导览项内距 10＋图标 16＋间距 8＝导览文本左缘。
    expect(bar.className).toContain("pl-[98px]");
    expect(bar.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(screen.getByText("specseal").getAttribute("title")).toBe("/Users/a/specseal");
    expect(screen.getByRole("button", { name: "⋯" })).toBeTruthy();
  });

  it("项目设置模式：左端「← 项目设置」返回钮、右端等宽小字项目名（desktop-settings-mode D2）", () => {
    const onBack = vi.fn();
    render(
      <LeftTitleBar
        back={{ label: "项目设置", onClick: onBack }}
        trailing={<span>specseal</span>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目设置" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    const trailing = screen.getByText("specseal").parentElement as HTMLElement;
    expect(trailing.className).toContain("font-mono");
    expect(trailing.className).toContain("text-[11px]");
  });

  it("下缘与主区顶列同一条细线，顶列横贯整个窗口", () => {
    render(<LeftTitleBar />);
    const left = screen.getByTestId("left-titlebar");
    expect(left.className).toContain("border-b");
    expect(left.className).toContain("border-border");
    expect(left.className).toContain("h-12");
  });
});

describe("MainTitleBar", () => {
  it("面包屑三段渲染、第一段可点、最后一段深字", () => {
    const onProject = vi.fn();
    render(
      <MainTitleBar
        platform="macos"
        crumbs={[{ label: "specseal", onClick: onProject }, { label: "规格" }, { label: "desktop-app" }]}
      />,
    );
    const bar = screen.getByTestId("main-titlebar");
    expect(bar.getAttribute("data-tauri-drag-region")).toBe("deep");
    fireEvent.click(screen.getByRole("button", { name: "specseal" }));
    expect(onProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText("规格").tagName).not.toBe("BUTTON");
    expect(screen.getByText("desktop-app").className).toContain("text-foreground");
    expect(screen.getByText("规格").className).not.toContain("text-foreground");
  });

  it("trailing 槽渲染在面包屑右侧、窗口钮之前", () => {
    mockWindow(false);
    render(
      <MainTitleBar
        platform="windows"
        crumbs={[{ label: "specseal" }, { label: "变更" }, { label: "add-auth" }]}
        trailing={<span data-testid="trail">‹ 1 / 2 ›</span>}
      />,
    );
    const bar = screen.getByTestId("main-titlebar");
    const nav = bar.querySelector("nav")!;
    const trail = screen.getByTestId("trail");
    const close = screen.getByRole("button", { name: "关闭窗口" });
    expect(nav.compareDocumentPosition(trail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trail.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.contains(trail)).toBe(false);
  });

  it("mono 段以等宽字体呈现（详情页的项目名）", () => {
    render(
      <MainTitleBar
        platform="macos"
        crumbs={[{ label: "specseal" }, { label: "变更" }, { label: "add-auth", mono: true }]}
      />,
    );
    expect(screen.getByText("add-auth").className).toContain("font-mono");
    expect(screen.getByText("变更").className).not.toContain("font-mono");
  });

  it("macOS 与 Linux 无自绘窗口钮", () => {
    const { unmount } = render(<MainTitleBar platform="macos" crumbs={[{ label: "A" }]} />);
    expect(screen.queryByRole("button", { name: "缩到最小" })).toBeNull();
    unmount();
    render(<MainTitleBar platform="linux" crumbs={[]} />);
    expect(screen.queryByRole("button", { name: "关闭窗口" })).toBeNull();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("Windows：三颗窗口钮各调用对应的 window API", async () => {
    const { win } = mockWindow(false);
    render(<MainTitleBar platform="windows" crumbs={[{ label: "A" }]} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "缩到最小" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("Windows：最大化后钮换成「还原」（依 isMaximized 与 onResized）", async () => {
    const { win, resize } = mockWindow(false);
    render(<MainTitleBar platform="windows" crumbs={[]} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();

    win.isMaximized.mockResolvedValue(true);
    await act(async () => {
      resize();
    });
    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("Windows：API 被拒时按钮不抛错、记 console.error", async () => {
    const { win } = mockWindow(false);
    win.minimize.mockRejectedValue(new Error("not allowed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MainTitleBar platform="windows" crumbs={[]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "缩到最小" }));
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// 设置档守门：窗口钮与拖拽所需权限、平台覆盖档不得因合并取代掉主窗口尺寸。
describe("Tauri 窗口设置", () => {

  it("capabilities/default.json 含拖拽与三颗窗口钮所需的五条权限", () => {
    const { permissions } = JSON.parse(defaultCapsRaw);
    for (const p of [
      "core:window:allow-start-dragging",
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-close",
      "core:window:allow-is-maximized",
    ]) {
      expect(permissions).toContain(p);
    }
  });

  it("平台覆盖档的 main 窗口保留基础设置的标题与尺寸（数组整个取代）", () => {
    const base = JSON.parse(baseConfRaw).app.windows[0];
    const mac = JSON.parse(macConfRaw).app.windows[0];
    const win = JSON.parse(winConfRaw).app.windows[0];
    for (const override of [mac, win]) {
      expect(override).toMatchObject(base);
    }
    expect(mac).toMatchObject({
      titleBarStyle: "Overlay",
      hiddenTitle: true,
      trafficLightPosition: { x: 16, y: 26 },
    });
    expect(mac.decorations).toBeUndefined();
    expect(win).toMatchObject({ decorations: false, shadow: true });
  });
});

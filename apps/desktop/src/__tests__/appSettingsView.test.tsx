// 应用进程设置（desktop-settings-mode design D5；desktop-about-page design D7）：依所在分类渲染
// 一页——一般、CLI 于此档；更新页、服务器页与关于页各有自己的测试档。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { AppSettingsView, type AppSettingsUpdaterProps } from "../views/AppSettingsView";
import type { UpdaterState } from "../core/updater";
import { APP_MESSAGES } from "../i18n/messages";
import type { CliInstallView } from "../store";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

/** 软件更新面的最小注入：状态＋回呼。 */
function updaterProps(state: UpdaterState, over: Partial<AppSettingsUpdaterProps> = {}): AppSettingsUpdaterProps {
  return {
    state,
    onCheck: vi.fn(),
    onShowReleaseNotes: vi.fn(),
    onAccept: vi.fn(),
    onCancel: vi.fn(),
    onRelaunch: vi.fn(),
    autoCheck: true,
    onAutoCheckChange: vi.fn(),
    ...over,
  };
}

function cliView(over: Partial<CliInstallView> = {}): CliInstallView {
  return {
    platform: "macos",
    status: { kind: "not-installed" },
    canDeploy: true,
    pathHint: false,
    deployDir: "/Users/u/.local/bin",
    busy: false,
    error: null,
    ...over,
  };
}

type ViewProps = ComponentProps<typeof AppSettingsView>;
function view(over: Partial<ViewProps> = {}) {
  return (
    <AppSettingsView
      section="general"
      platform="macos"
      localePref={null}
      onLocalePrefChange={vi.fn()}
      themePref={null}
      onThemePrefChange={vi.fn()}
      {...over}
    />
  );
}

const cardTitles = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const row = (label: string) => screen.getByRole("group", { name: label });

describe("一般页", () => {
  it("页标题「一般」、「仅存于此设备」注记；只有语言与外观、键盘快捷键两卡，语言与外观卡两列依序为显示语言与外观", () => {
    render(view());
    expect(screen.getByRole("heading", { level: 2, name: "一般" })).toBeTruthy();
    expect(screen.getByText("此页内容仅存于此设备，不写入版本库")).toBeTruthy();
    expect(cardTitles()).toEqual(["语言与外观", "键盘快捷键"]);
    const card = screen.getByRole("region", { name: "语言与外观" });
    expect(within(card).getAllByRole("group").map((g) => g.querySelector("span, label")?.textContent)).toEqual([
      "显示语言",
      "外观",
    ]);
  });

  it("注入更新与 CLI 面时一般页也不重复其他分类页的列（目前版本、检查更新、更新日志、specseal CLI）", () => {
    render(view({ updater: updaterProps({ phase: "upToDate" }), cliInstall: { view: cliView(), onInstall: vi.fn() } }));
    expect(cardTitles()).toEqual(["语言与外观", "键盘快捷键"]);
    for (const label of ["目前版本", "检查更新", "更新日志", "specseal CLI"]) {
      expect(screen.queryByRole("group", { name: label })).toBeNull();
    }
  });

  it("显示语言列三选回呼本机偏好（跟随系统＝null）", async () => {
    const onLocalePrefChange = vi.fn();
    const user = userEvent.setup();
    render(view({ onLocalePrefChange }));
    const trigger = within(row("显示语言")).getByRole("combobox", { name: "显示语言" });
    expect(trigger.textContent).toContain("跟随系统");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "English" }));
    expect(onLocalePrefChange).toHaveBeenCalledWith("en");
  });

  it("外观列三选回呼 onThemePrefChange（跟随系统／浅色／深色）", async () => {
    const onThemePrefChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(view({ themePref: "dark", onThemePrefChange }));
    const trigger = within(row("外观")).getByRole("combobox", { name: "外观" });
    expect(trigger.textContent).toContain("深色");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "浅色" }));
    expect(onThemePrefChange).toHaveBeenLastCalledWith("light");
    rerender(view({ themePref: "light", onThemePrefChange }));
    await user.click(within(row("外观")).getByRole("combobox", { name: "外观" }));
    await user.click(await screen.findByRole("option", { name: "跟随系统" }));
    expect(onThemePrefChange).toHaveBeenLastCalledWith(null);
  });

  it("面板创建失败时，页底以独立警示行浮出错误", () => {
    render(view({ trayPanelError: "tray panel window creation failed: boom" }));
    expect(screen.getByRole("alert").textContent).toContain("tray panel window creation failed: boom");
  });
});

describe("CLI 页的 CLI 指令卡", () => {
  const card = () => screen.getByRole("region", { name: "CLI 指令" });
  const withCli = (over: Partial<CliInstallView>, onInstall = vi.fn(), platform: ViewProps["platform"] = "macos") =>
    view({ section: "cli", platform, cliInstall: { view: cliView(over), onInstall } });

  it("未安装且可布署：列「specseal CLI」显示未安装与安装钮，点击回呼 onInstall", () => {
    const onInstall = vi.fn();
    render(withCli({}, onInstall));
    expect(within(row("specseal CLI")).getByText("未安装")).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: "安装 CLI 指令" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("已安装同版：显示已安装与版本、不出现安装钮", () => {
    render(withCli({ status: { kind: "installed", version: "0.2.0" } }));
    expect(card().textContent).toContain("已安装");
    expect(card().textContent).toContain("0.2.0");
    expect(screen.queryByRole("button", { name: "安装 CLI 指令" })).toBeNull();
  });

  it("版本不符且可布署：显示版本不符与重新安装钮", () => {
    const onInstall = vi.fn();
    render(withCli({ status: { kind: "version-mismatch", version: "0.1.0" } }, onInstall));
    expect(card().textContent).toContain("版本不符");
    fireEvent.click(screen.getByRole("button", { name: "重新安装" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("布署目录不在 PATH：提示加入方式", () => {
    render(withCli({ status: { kind: "installed", version: "0.2.0" }, pathHint: true }));
    const hint = screen.getByTestId("cli-path-hint");
    expect(hint.textContent).toContain("/Users/u/.local/bin");
    expect(hint.textContent).toContain("PATH");
  });

  it("Windows 仅回报状态：无安装钮、说明由安装器管理", () => {
    render(
      withCli(
        { platform: "windows", canDeploy: false, deployDir: null, status: { kind: "installed", version: "0.2.0" } },
        vi.fn(),
        "windows",
      ),
    );
    expect(card().textContent).toContain("安装器");
    expect(screen.queryByRole("button", { name: "安装 CLI 指令" })).toBeNull();
  });

  it("Linux 非 AppImage 运行仅回报状态：无安装钮、说明没有可布署的 CLI", () => {
    render(withCli({ platform: "linux-unpackaged", canDeploy: false, deployDir: null }, vi.fn(), "linux"));
    expect(card().textContent).toContain("没有可布署的 CLI");
    expect(screen.queryByRole("button", { name: "安装 CLI 指令" })).toBeNull();
  });

  it("布署失败错误浮出于卡内", () => {
    render(withCli({ error: "permission denied" }));
    expect(card().textContent).toContain("permission denied");
  });
});

describe("一般页的键盘快捷键卡（desktop-native-menu design D5）", () => {
  const card = () => screen.getByRole("region", { name: "键盘快捷键" });

  it("macOS：最后一张卡为「键盘快捷键」，11 列（动作名左、按键右）含 ⌘, 与 ⌃1–9", () => {
    render(view({ updater: updaterProps({ phase: "idle" }), cliInstall: { view: cliView(), onInstall: vi.fn() } }));
    const titles = cardTitles();
    expect(titles[titles.length - 1]).toBe("键盘快捷键");
    expect(within(card()).getAllByRole("group")).toHaveLength(11);
    expect(within(row("设置…")).getByText("⌘,")).toBeTruthy();
    expect(card().textContent).toContain("⌃1–9");
  });

  it("en 接口：卡片标题为 Keyboard Shortcuts", () => {
    rtlRender(view({ localePref: "en" }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nProvider locale="en" messages={APP_MESSAGES}>
          {children}
        </I18nProvider>
      ),
    });
    expect(screen.getByRole("region", { name: "Keyboard Shortcuts" })).toBeTruthy();
  });

  it("Windows：5 列，整张卡没有 ⌘", () => {
    render(view({ platform: "windows" }));
    expect(within(card()).getAllByRole("group")).toHaveLength(5);
    expect(card().textContent).not.toContain("⌘");
  });
});

describe("CLI 页", () => {
  it("specseal CLI 列与等宽布署位置列", () => {
    render(view({ section: "cli", cliInstall: { view: cliView({ status: { kind: "installed", version: "0.2.0" } }), onInstall: vi.fn() } }));
    expect(screen.getByRole("heading", { level: 2, name: "CLI" })).toBeTruthy();
    expect(within(row("specseal CLI")).getByText(/已安装/)).toBeTruthy();
    const dir = within(row("布署位置")).getByText("/Users/u/.local/bin");
    expect(dir.className).toContain("font-mono");
  });

  it("布署位置未知（null）时该列缺席", () => {
    render(view({ section: "cli", cliInstall: { view: cliView({ platform: "windows", canDeploy: false, deployDir: null }), onInstall: vi.fn() } }));
    expect(screen.queryByRole("group", { name: "布署位置" })).toBeNull();
  });
});

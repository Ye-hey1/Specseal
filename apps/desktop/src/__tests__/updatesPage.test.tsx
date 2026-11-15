// 更新页（desktop-settings-mode design D6；spec「桌面自动更新」「更新日志弹窗」「更新日志依接口语言呈现」）。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider, type UiLocale } from "@specseal/ui";

import { UpdatesPage } from "../views/settings/UpdatesPage";
import type { AppSettingsUpdaterProps } from "../views/AppSettingsView";
import type { UpdaterState } from "../core/updater";
import { APP_MESSAGES } from "../i18n/messages";
import { RELEASE_NOTES } from "../release-notes/release-notes";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });
const inLocale = (locale: UiLocale, ui: ReactElement) => (
  <I18nProvider locale={locale} messages={APP_MESSAGES}>
    {ui}
  </I18nProvider>
);
const KIND_LABELS = {
  "zh-CN": { features: "新功能", fixes: "修正", improvements: "改善" },
  en: { features: "New features", fixes: "Fixes", improvements: "Improvements" },
} as const;

function updaterProps(state: UpdaterState, over: Partial<AppSettingsUpdaterProps> = {}): AppSettingsUpdaterProps {
  return {
    state,
    currentVersion: "0.1.0",
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

const row = (label: string) => screen.getByRole("group", { name: label });
const installCard = () => screen.queryByRole("region", { name: "下载与安装" });

describe("UpdatesPage", () => {
  it("页标题「更新」右侧「检查更新」回调 onCheck、检查中停用；版本卡有目前版本列（等宽）", () => {
    const onCheck = vi.fn();
    const { rerender } = render(<UpdatesPage updater={updaterProps({ phase: "idle" }, { onCheck })} />);
    expect(screen.getByRole("heading", { level: 2, name: "更新" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(within(row("目前版本")).getByText("0.1.0").className).toContain("font-mono");
    rerender(<UpdatesPage updater={updaterProps({ phase: "checking", manual: true })} />);
    expect((screen.getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each<[string, UpdaterState, string, string]>([
    ["闲置", { phase: "idle" }, "—", "尚未检查"],
    ["检查中", { phase: "checking", manual: true }, "", "检查中"],
    ["已是最新", { phase: "upToDate" }, "0.1.0", "已是最新"],
    ["检查失败", { phase: "checkFailed" }, "", "无法检查"],
    ["待同意", { phase: "available", version: "0.2.0" }, "0.2.0", "有新版本"],
    ["下载中", { phase: "downloading", version: "0.2.0" }, "0.2.0", "有新版本"],
    ["待重启", { phase: "restartPending", version: "0.2.0" }, "0.2.0", "有新版本"],
  ])("最新版本列：%s", (_name, state, version, pill) => {
    render(<UpdatesPage updater={updaterProps(state)} />);
    const latest = row("最新版本");
    expect(within(latest).getByText(pill)).toBeTruthy();
    if (version) expect(within(latest).getByText(version).className).toContain("font-mono");
  });

  it("待同意时出现「下载与安装」卡：标题 Specseal 目标版本与「下载」钮；闲置时缺席", () => {
    const updater = updaterProps({ phase: "available", version: "0.2.0" });
    const { rerender } = render(<UpdatesPage updater={updater} />);
    const card = installCard()!;
    expect(within(card).getByRole("group", { name: "Specseal 0.2.0" })).toBeTruthy();
    expect(card.textContent).toContain("安装后会重新启动");
    fireEvent.click(within(card).getByRole("button", { name: "下载" }));
    expect(updater.onAccept).toHaveBeenCalledTimes(1);
    rerender(<UpdatesPage updater={updaterProps({ phase: "idle" })} />);
    expect(installCard()).toBeNull();
  });

  it("下载中、待重启与失败：卡内承载对应控制", () => {
    for (const [state, label] of [
      [{ phase: "downloading", version: "0.2.0" }, "取消"],
      [{ phase: "restartPending", version: "0.2.0" }, "安装并重新启动"],
      [{ phase: "error", message: "invalid signature" }, "重试"],
    ] as const) {
      const { unmount } = render(<UpdatesPage updater={updaterProps(state)} />);
      expect(within(installCard()!).getByRole("button", { name: label })).toBeTruthy();
      unmount();
    }
  });

  it("更新日志卡：最新版本为第一列并展开分组列点；较旧版本每列「查看」与底列「全部更新日志」开浏览模式", () => {
    const onShowReleaseNotes = vi.fn();
    render(<UpdatesPage updater={updaterProps({ phase: "idle" }, { onShowReleaseNotes })} />);
    const card = screen.getByRole("region", { name: "更新日志" });
    const [latest, ...older] = RELEASE_NOTES;
    const first = within(card).getAllByRole("group")[0];
    expect(first.textContent).toContain(latest.version);
    expect(first.textContent).toContain(latest.date);
    for (const section of latest.sections) {
      expect(within(first).getByText(KIND_LABELS["zh-CN"][section.kind])).toBeTruthy();
      expect(first.textContent).toContain(section.items[0]["zh-CN"]);
    }
    // 旧版本列的摘要是该版首条的繁中文本。
    expect(within(card).getAllByRole("group")[1].textContent).toContain(older[0].sections[0].items[0]["zh-CN"]);
    const views = within(card).getAllByRole("button", { name: "查看" });
    expect(views).toHaveLength(older.length);
    // 旧版本列的「查看」带该列版号（打开后卷到该版）；「全部更新日志」不带版号（自顶端呈现）。
    fireEvent.click(views[0]);
    fireEvent.click(within(card).getByRole("button", { name: "全部更新日志" }));
    expect(onShowReleaseNotes.mock.calls).toEqual([[older[0].version], []]);
  });

  it("英文接口的更新日志卡：最新版本展开英文分组标题与英文条目，旧版本列摘要为英文首条", () => {
    rtlRender(inLocale("en", <UpdatesPage updater={updaterProps({ phase: "idle" })} />));
    const card = screen.getByRole("region", { name: "Changelog" });
    const [latest, ...older] = RELEASE_NOTES;
    const [first, second] = within(card).getAllByRole("group");
    for (const section of latest.sections) {
      expect(within(first).getByText(KIND_LABELS.en[section.kind])).toBeTruthy();
      for (const item of section.items) {
        expect(first.textContent).toContain(item.en);
        expect(first.textContent).not.toContain(item["zh-CN"]);
      }
    }
    expect(second.textContent).toContain(older[0].sections[0].items[0].en);
    expect(second.textContent).not.toContain(older[0].sections[0].items[0]["zh-CN"]);
  });

  it("切换接口语言后，更新日志卡改以新语言呈现", () => {
    const page = <UpdatesPage updater={updaterProps({ phase: "idle" })} />;
    const { rerender } = rtlRender(inLocale("zh-CN", page));
    const top = RELEASE_NOTES[0].sections[0];
    expect(screen.getByRole("region", { name: "更新日志" }).textContent).toContain(top.items[0]["zh-CN"]);
    rerender(inLocale("en", page));
    const card = screen.getByRole("region", { name: "Changelog" });
    expect(card.textContent).toContain(top.items[0].en);
    expect(within(card).getAllByText(KIND_LABELS.en[top.kind]).length).toBeGreaterThan(0);
    expect(card.textContent).not.toContain(top.items[0]["zh-CN"]);
  });

  it("自动检查卡：开关反映偏好、切换回调 onAutoCheckChange", () => {
    const onAutoCheckChange = vi.fn();
    const { rerender } = render(<UpdatesPage updater={updaterProps({ phase: "idle" }, { onAutoCheckChange })} />);
    const sw = screen.getByRole("switch", { name: "启动时在背景检查新版本" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(row("启动时在背景检查新版本").textContent).toContain("只检查，不会自动下载");
    fireEvent.click(sw);
    expect(onAutoCheckChange).toHaveBeenCalledWith(false);
    rerender(<UpdatesPage updater={updaterProps({ phase: "idle" }, { autoCheck: false, onAutoCheckChange })} />);
    expect(screen.getByRole("switch", { name: "启动时在背景检查新版本" }).getAttribute("aria-checked")).toBe("false");
  });

  it("focus 为 true 时卷到「下载与安装」卡一次并回调；无该卡时卷到版本卡", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const onFocusHandled = vi.fn();
    const available = { phase: "available", version: "0.2.0" } as const;
    const { rerender, unmount } = render(<UpdatesPage updater={updaterProps(available, { focus: false, onFocusHandled })} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<UpdatesPage updater={updaterProps(available, { focus: true, onFocusHandled })} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect((scrollIntoView.mock.instances[0] as unknown as HTMLElement).contains(installCard())).toBe(true);
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    unmount();

    scrollIntoView.mockClear();
    render(<UpdatesPage updater={updaterProps({ phase: "idle" }, { focus: true, onFocusHandled })} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.instances[0] as unknown as HTMLElement;
    expect(target.contains(screen.getByRole("region", { name: "版本" }))).toBe(true);
  });
});

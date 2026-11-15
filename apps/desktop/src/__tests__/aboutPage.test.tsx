// 关于页（desktop-about-page design D2；spec「关于页」）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";
import { openUrl } from "@tauri-apps/plugin-opener";

import { AboutPage, type AboutPageProps } from "../views/settings/AboutPage";
import type { UpdaterState } from "../core/updater";
import { APP_MESSAGES } from "../i18n/messages";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: toastError }) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: zhWrapper });

const INFO = {
  appVersion: "0.8.0",
  engineVersion: "v1.44.0",
  platform: "macOS",
  arch: "arm64",
};
const THREE_LINES = "Specseal 0.8.0\nEngine v1.44.0\nPlatform macOS arm64";

function aboutProps(over: Partial<AboutPageProps> = {}): AboutPageProps {
  return {
    appInfo: INFO,
    onLoadAppInfo: vi.fn(),
    updaterState: { phase: "idle" },
    onOpenUpdates: vi.fn(),
    thirdPartyLicenses: null,
    ...over,
  };
}

const row = (label: string) => screen.getByRole("group", { name: label });
const brandCard = () => screen.getByTestId("about-brand");

beforeEach(() => {
  vi.mocked(openUrl).mockClear().mockResolvedValue(undefined);
  toastError.mockClear();
});

describe("AboutPage", () => {
  it("页标题与说明；进页即要求加载版本信息", () => {
    const onLoadAppInfo = vi.fn();
    render(<AboutPage {...aboutProps({ onLoadAppInfo })} />);
    expect(screen.getByRole("heading", { level: 2, name: "关于 Specseal" })).toBeTruthy();
    expect(screen.getByText("版本、授权与链接。")).toBeTruthy();
    expect(onLoadAppInfo).toHaveBeenCalledTimes(1);
  });

  it("品牌卡：锁版、版本列「0.8.0 · 引擎 v1.44.0 · macOS arm64」与状态签、产品描述，无裸标记", () => {
    render(<AboutPage {...aboutProps({ updaterState: { phase: "upToDate" } })} />);
    const card = brandCard();
    expect(within(card).getAllByRole("img", { name: "Specseal" })[0].className).toContain("h-10");
    expect(within(card).getByText("0.8.0 · 引擎 v1.44.0 · macOS arm64")).toBeTruthy();
    expect(within(card).getByText("已是最新")).toBeTruthy();
    expect(within(card).getByText("让 AI 写的每个变更，都对得上规格、查得到证据")).toBeTruthy();
    expect(card.querySelector("[role=img] svg")).toBeNull();
  });

  it.each<[string, UpdaterState, string]>([
    ["未检查", { phase: "idle" }, "尚未检查"],
    ["检查中", { phase: "checking", manual: true }, "检查中"],
    ["有新版本", { phase: "available", version: "0.9.0" }, "有新版本"],
    ["无法检查", { phase: "checkFailed" }, "无法检查"],
  ])("版本列状态签：%s", (_name, state, pill) => {
    render(<AboutPage {...aboutProps({ updaterState: state })} />);
    expect(within(brandCard()).getByText(pill)).toBeTruthy();
  });

  it("状态签是按钮：点击进更新页（调用 onOpenUpdates 一次）；未注入更新状态时不显示", () => {
    const onOpenUpdates = vi.fn();
    const { rerender } = render(<AboutPage {...aboutProps({ updaterState: { phase: "upToDate" }, onOpenUpdates })} />);
    fireEvent.click(within(brandCard()).getByRole("button", { name: "更新状态：已是最新" }));
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
    rerender(<AboutPage {...aboutProps({ updaterState: undefined })} />);
    expect(within(brandCard()).queryByRole("button", { name: /更新状态/ })).toBeNull();
  });

  it("页内没有版本卡、检查更新列与更新日志列", () => {
    render(<AboutPage {...aboutProps()} />);
    expect(screen.queryByRole("region", { name: "版本" })).toBeNull();
    expect(screen.queryByRole("group", { name: "检查更新" })).toBeNull();
    expect(screen.queryByRole("group", { name: "更新日志" })).toBeNull();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("版本信息尚未取得时版本列为「—」、拷贝钮缺席", () => {
    render(<AboutPage {...aboutProps({ appInfo: null })} />);
    expect(within(brandCard()).getByText("—")).toBeTruthy();
    expect(within(brandCard()).queryByRole("button", { name: "拷贝版本信息" })).toBeNull();
  });

  it("Scenario「拷贝版本信息」：品牌卡版本列旁的钮写入三行到剪贴板并短暂显示已拷贝", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AboutPage {...aboutProps()} />);
    const copy = within(brandCard()).getByRole("button", { name: "拷贝版本信息" });
    expect(copy.textContent).toBe("拷贝");
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(THREE_LINES);
    await waitFor(() => expect(copy.textContent).toBe("已拷贝"));
  });

  it("链接卡三列整列可点：原代码、说明文档、回报问题（网址含版本三行）", () => {
    render(<AboutPage {...aboutProps()} />);
    const links = screen.getByRole("region", { name: "链接" });
    const source = within(links).getByRole("button", { name: /原代码/ });
    expect(within(source).getByText("github.com/MomoChenisMe/speclink").className).toContain("font-mono");
    fireEvent.click(source);
    fireEvent.click(within(links).getByRole("button", { name: /说明文档/ }));
    fireEvent.click(within(links).getByRole("button", { name: /回报问题/ }));
    expect(vi.mocked(openUrl).mock.calls).toEqual([
      ["https://github.com/MomoChenisMe/speclink"],
      ["https://github.com/MomoChenisMe/speclink/tree/main/docs"],
      [`https://github.com/MomoChenisMe/speclink/issues/new?body=${encodeURIComponent(THREE_LINES)}`],
    ]);
  });

  it("Scenario「链接外开」：打开失败以失败 toast 呈现错误", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce("not allowed by scope");
    render(<AboutPage {...aboutProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /回报问题/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("not allowed by scope"));
  });

  it("Scenario「授权对话框」：授权条款显示 LICENSE 全文；关闭后第三方授权分 npm 与 cargo 两节", async () => {
    const thirdPartyLicenses = {
      npm: [
        { name: "react", version: "19.2.7", license: "MIT" },
        { name: "zustand", version: "5.0.14", license: null },
      ],
      cargo: [
        { name: "anyhow", version: "1.0.80", license: "MIT OR Apache-2.0" },
        { name: "serde", version: "1.0.200", license: "MIT OR Apache-2.0" },
      ],
    };
    render(<AboutPage {...aboutProps({ thirdPartyLicenses })} />);
    expect(within(row("授权条款")).getByText("MIT License · © 2026 MomoChen")).toBeTruthy();
    fireEvent.click(within(row("授权条款")).getByRole("button", { name: "查看" }));
    const license = await screen.findByRole("alertdialog", { name: "授权条款" });
    expect(license.textContent).toContain("Permission is hereby granted, free of charge");
    fireEvent.click(within(license).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(within(row("第三方授权")).getByRole("button", { name: "查看" }));
    const dialog = await screen.findByRole("alertdialog", { name: "第三方授权" });
    const sections = within(dialog).getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["npm", "cargo"]);
    expect(within(sections[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "react 19.2.7 · MIT",
      "zustand 5.0.14 · 未标示",
    ]);
    expect(within(sections[1]).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "anyhow 1.0.80 · MIT OR Apache-2.0",
      "serde 1.0.200 · MIT OR Apache-2.0",
    ]);
  });

  it("第三方清单档缺席时对话框显示「清单尚未产生」而非错误；cargo 节为空时该节同样标示", async () => {
    const { unmount } = render(<AboutPage {...aboutProps({ thirdPartyLicenses: null })} />);
    fireEvent.click(within(row("第三方授权")).getByRole("button", { name: "查看" }));
    const dialog = await screen.findByRole("alertdialog", { name: "第三方授权" });
    expect(within(dialog).getByText("清单尚未产生")).toBeTruthy();
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
    unmount();

    render(
      <AboutPage
        {...aboutProps({ thirdPartyLicenses: { npm: [{ name: "react", version: "19.2.7", license: "MIT" }], cargo: [] } })}
      />,
    );
    fireEvent.click(within(row("第三方授权")).getByRole("button", { name: "查看" }));
    const partial = await screen.findByRole("alertdialog", { name: "第三方授权" });
    const cargo = within(partial).getByRole("region", { name: "cargo" });
    expect(within(cargo).getByText("清单尚未产生")).toBeTruthy();
  });
});

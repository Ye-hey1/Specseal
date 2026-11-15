// 「有新版本」图标钮（desktop-app spec「桌面自动更新」；desktop-notice-relocation design D2）：
// 图标列齿轮上方的状态钮——待同意＝下载箭头＋琥珀点、下载中＝转圈、待重启＝重启箭头＋琥珀点、
// 失败＝红色警示；其他状态不出现。提示文本带目标版本与「到设置 › 更新」；点击进设置的更新页。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider, TooltipProvider } from "@specseal/ui";

import { RAIL_SQUARE } from "../components/projectTile";
import { UpdateRailButton } from "../components/UpdateRailButton";
import type { UpdaterState } from "../core/updater";
import { APP_MESSAGES } from "../i18n/messages";

const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    <TooltipProvider>{children}</TooltipProvider>
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper });
}

const button = () => screen.getByTestId("update-rail-button") as HTMLButtonElement;
const dot = () => button().querySelector("[data-update-dot]");
const icon = () => button().querySelector("svg") as SVGElement;

describe("UpdateRailButton", () => {
  it("待同意：下载箭头＋右上琥珀点；aria-label 含版号与「到设置 › 更新」", () => {
    render(<UpdateRailButton state={{ phase: "available", version: "0.5.1" }} onClick={vi.fn()} />);
    expect(icon().classList.contains("lucide-download")).toBe(true);
    expect(dot()?.className).toContain("bg-status-warning");
    expect(button().getAttribute("aria-label")).toBe("有新版本 0.5.1 — 到设置 › 更新");
  });

  it("下载中：转圈、无点", () => {
    render(<UpdateRailButton state={{ phase: "downloading", version: "0.5.1" }} onClick={vi.fn()} />);
    expect(icon().classList.contains("lucide-loader-circle")).toBe(true);
    expect(icon().classList.contains("animate-spin")).toBe(true);
    expect(dot()).toBeNull();
    expect(button().getAttribute("aria-label")).toBe("正在下载 0.5.1");
  });

  it("待重启：重启箭头＋琥珀点", () => {
    render(<UpdateRailButton state={{ phase: "restartPending", version: "0.5.1" }} onClick={vi.fn()} />);
    expect(icon().classList.contains("lucide-rotate-cw")).toBe(true);
    expect(dot()?.className).toContain("bg-status-warning");
    expect(button().getAttribute("aria-label")).toBe("0.5.1 已就绪，到设置安装并重新启动");
  });

  it("失败：红色警示、无点（spec「错误态以红呈现」）", () => {
    render(<UpdateRailButton state={{ phase: "error", message: "invalid signature" }} onClick={vi.fn()} />);
    expect(icon().classList.contains("lucide-triangle-alert")).toBe(true);
    expect(icon().getAttribute("class")).toContain("text-destructive");
    expect(dot()).toBeNull();
    expect(button().getAttribute("aria-label")).toBe("更新失败 — 到设置 › 更新查看");
  });

  it.each<[string, UpdaterState]>([
    ["闲置", { phase: "idle" }],
    ["检查中", { phase: "checking", manual: true }],
    ["已是最新", { phase: "upToDate" }],
    ["检查失败", { phase: "checkFailed" }],
  ])("%s：不渲染", (_label, state) => {
    render(<UpdateRailButton state={state} onClick={vi.fn()} />);
    expect(screen.queryByTestId("update-rail-button")).toBeNull();
  });

  it("与图标列方块同一套尺寸样式、hover 与齿轮一致", () => {
    render(<UpdateRailButton state={{ phase: "available", version: "0.5.1" }} onClick={vi.fn()} />);
    for (const token of RAIL_SQUARE.split(" ")) expect(button().classList.contains(token)).toBe(true);
    expect(button().classList.contains("hover:bg-muted")).toBe(true);
  });

  it("点击调用 onClick", () => {
    const onClick = vi.fn();
    render(<UpdateRailButton state={{ phase: "available", version: "0.5.1" }} onClick={onClick} />);
    fireEvent.click(button());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("聚焦时显示 tooltip，文案带版号", async () => {
    render(<UpdateRailButton state={{ phase: "available", version: "0.5.1" }} onClick={vi.fn()} />);
    fireEvent.focus(button());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("0.5.1");
  });
});

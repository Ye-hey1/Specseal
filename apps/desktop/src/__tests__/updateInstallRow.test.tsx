// 更新页「下载与安装」卡的列（desktop-app spec「桌面自动更新」；desktop-settings-mode
// design D6）：待同意＝目标版本＋「下载」、下载中＝不确定进度列＋「取消」、待重启＝「更新已就绪」
// ＋「安装并重新启动」、失败＝错误＋「重试」；其他状态不出现。原 updateBanner.test.tsx 的案例搬到这里。
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@specseal/ui";

import { UpdateInstallRow, type UpdateInstallRowProps } from "../components/UpdateInstallRow";
import type { UpdaterState } from "../core/updater";
import { APP_MESSAGES } from "../i18n/messages";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN" messages={APP_MESSAGES}>
    {children}
  </I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

function props(state: UpdaterState): UpdateInstallRowProps {
  return { state, onAccept: vi.fn(), onCancel: vi.fn(), onRelaunch: vi.fn(), onRetry: vi.fn() };
}
const row = () => screen.getByTestId("update-install-row");
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("UpdateInstallRow", () => {
  it("待同意：显示目标版本与「下载」；同意才回调下载、不触发重启", () => {
    const p = props({ phase: "available", version: "0.2.0" });
    render(<UpdateInstallRow {...p} />);
    // 更新页「下载与安装」卡的列（desktop-settings-mode design D6）：标题 Specseal 目标版本。
    expect(screen.getByRole("group", { name: "Specseal 0.2.0" })).toBeTruthy();
    expect(row().textContent).toContain("安装后会重新启动");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(button("下载"));
    expect(p.onAccept).toHaveBeenCalledTimes(1);
    expect(p.onRelaunch).not.toHaveBeenCalled();
    expect(p.onCancel).not.toHaveBeenCalled();
  });

  it("下载中：不确定进度列（无 aria-valuenow）与「取消」；取消回调 onCancel", () => {
    const p = props({ phase: "downloading", version: "0.2.0" });
    render(<UpdateInstallRow {...p} />);
    expect(row().textContent).toContain("0.2.0");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    fireEvent.click(button("取消"));
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(p.onAccept).not.toHaveBeenCalled();
  });

  it("待重启：「更新已就绪」与「安装并重新启动」", () => {
    const p = props({ phase: "restartPending", version: "0.2.0" });
    render(<UpdateInstallRow {...p} />);
    expect(row().textContent).toContain("更新已就绪");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(button("安装并重新启动"));
    expect(p.onRelaunch).toHaveBeenCalledTimes(1);
  });

  it("失败：红字错误消息与「重试」；重试回调 onRetry（重新检查）", () => {
    const p = props({ phase: "error", message: "invalid signature" });
    render(<UpdateInstallRow {...p} />);
    const message = screen.getByText(/invalid signature/);
    expect(message.className).toContain("destructive");
    fireEvent.click(button("重试"));
    expect(p.onRetry).toHaveBeenCalledTimes(1);
    expect(p.onAccept).not.toHaveBeenCalled();
  });

  it.each<[string, UpdaterState]>([
    ["闲置", { phase: "idle" }],
    ["检查中", { phase: "checking", manual: true }],
    ["已是最新", { phase: "upToDate" }],
    ["检查失败", { phase: "checkFailed" }],
  ])("%s：该列不出现", (_label, state) => {
    render(<UpdateInstallRow {...props(state)} />);
    expect(screen.queryByTestId("update-install-row")).toBeNull();
  });
});

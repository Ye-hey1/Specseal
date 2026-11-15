// spec「进行中变更可自看板退回提案中」的守门对话框:渲染引擎证据(已勾任务数
// 与 touched 文档清单)与出路说明;不提供任何清理或强制退回的机械出路。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { RevertBlockedDialog } from "../components/RevertBlockedDialog";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const info = {
  change: "oops-started",
  checkedTasks: 3,
  touchedFiles: ["src/a.rs", "src/b.ts"],
};

describe("RevertBlockedDialog", () => {
  it("renders the engine evidence and the ways out (uncheck-and-retry / ask the agent)", () => {
    render(<RevertBlockedDialog info={info} onClose={vi.fn()} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("oops-started");
    expect(dialog.textContent).toContain("3");
    expect(dialog.textContent).toContain("src/a.rs");
    expect(dialog.textContent).toContain("src/b.ts");
    // 出路说明:已勾任务可于任务分页取消后重试;touched 需请 agent 判断。
    expect(dialog.textContent).toContain("取消勾选");
    expect(dialog.textContent).toContain("agent");
  });

  it("offers no cleanup or force-revert button — the single button just closes", () => {
    const onClose = vi.fn();
    render(<RevertBlockedDialog info={info} onClose={onClose} />);
    const dialog = screen.getByRole("alertdialog");
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders each evidence block only when present (checked-only case hides the file list)", () => {
    render(
      <RevertBlockedDialog
        info={{ change: "only-tasks", checkedTasks: 2, touchedFiles: [] }}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("2");
    expect(dialog.textContent).toContain("取消勾选");
    expect(dialog.textContent).not.toContain("agent");
  });

  it("null info renders nothing", () => {
    render(<RevertBlockedDialog info={null} onClose={vi.fn()} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

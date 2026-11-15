// 共用确认框（spec desktop-app「共用组件唯一来源」；design D7）：两键式确认框的
// 标题、说明、文案、危险变体与 busy／disabled 由调用端以属性提供，外观只此一份。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const base = {
  open: true,
  onOpenChange: () => {},
  title: "封存变更",
  description: "确定要封存 demo？",
  confirmLabel: "封存",
  onConfirm: () => {},
};

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ConfirmDialog", () => {
  it("渲染标题、说明与两键文案；取消缺省取 i18n common.cancel", () => {
    render(<ConfirmDialog {...base} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("封存变更");
    expect(dialog.textContent).toContain("确定要封存 demo？");
    expect(button("封存")).toBeTruthy();
    expect(button("取消")).toBeTruthy();
  });

  it("cancelLabel 覆写取消文案", () => {
    render(<ConfirmDialog {...base} cancelLabel="先不要" />);
    expect(button("先不要")).toBeTruthy();
  });

  it("children 渲染在说明之后、按钮之前", () => {
    render(
      <ConfirmDialog {...base}>
        <p>额外内容</p>
      </ConfirmDialog>,
    );
    const extra = screen.getByText("额外内容");
    const desc = screen.getByText("确定要封存 demo？");
    const confirm = button("封存");
    expect(desc.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extra.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("destructive 变体的确认钮为实心红，一般为主色", () => {
    const { unmount } = render(<ConfirmDialog {...base} destructive />);
    expect(button("封存").className).toContain("bg-destructive");
    expect(button("封存").className).not.toContain("bg-primary");
    unmount();
    render(<ConfirmDialog {...base} />);
    expect(button("封存").className).toContain("bg-primary");
    expect(button("封存").className).not.toContain("bg-destructive");
  });

  it("busy 时两键皆 disabled", () => {
    render(<ConfirmDialog {...base} busy />);
    expect(button("封存").disabled).toBe(true);
    expect(button("取消").disabled).toBe(true);
  });

  it("confirmDisabled 只停用确认钮，取消照常可按", () => {
    render(<ConfirmDialog {...base} confirmDisabled />);
    expect(button("封存").disabled).toBe(true);
    expect(button("取消").disabled).toBe(false);
  });

  it("按确认触发 onConfirm 并关闭；按取消只关闭", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onOpenChange={onOpenChange} />);
    fireEvent.click(button("封存"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.click(button("取消"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

import { describe, it, expect } from "vitest";
import { createRef, useState, type Ref } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// 对话框内的下拉（server-web-detail-pages design D4：邀请对话框挑项目）。AlertDialog 同样
// 是 modal，菜单若 portal 到 body 会落在它的 focus trap 外面——这支测试钉住「菜单挂进
// 对话框自己、可打开可选取、焦点不离开对话框」（同 selectInSheet.test.tsx 的抽屉版）。
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogTitle>对话框</AlertDialogTitle>
        <AlertDialogDescription>挑一个选项。</AlertDialogDescription>
        <Select defaultValue="a">
          <SelectTrigger aria-label="选项">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">甲</SelectItem>
            <SelectItem value="b">乙</SelectItem>
          </SelectContent>
        </Select>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("对话框内的 Select", () => {
  it("菜单挂在对话框内，可以打开并选取，焦点留在对话框", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Fixture />);
    const dialog = screen.getByRole("alertdialog");
    await user.click(screen.getByRole("combobox", { name: "选项" }));
    const listbox = await screen.findByRole("listbox");
    expect(dialog.contains(listbox)).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole("option", { name: "乙" }));
    expect(screen.getByRole("combobox", { name: "选项" }).textContent).toContain("乙");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // Select 与 AlertDialog 各自依赖不同版本的 Radix dismissable-layer，两边都以为自己在最上层：
  // 不挡的话一次 Esc 会同时关掉菜单与对话框，且 body 的 pointer-events 停在 none（整页点不动）。
  it("菜单开着时按 Esc 只收起菜单、对话框保留；再按 Esc 才关对话框，页面恢复可点", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Fixture />);
    await user.click(screen.getByRole("combobox", { name: "选项" }));
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.body.style.pointerEvents).toBe("");
  });
});

// 挂载点改以 callback ref 取 content 节点后，调用端传进来的 ref 仍要收到同一个节点
// （server-web-detail-pages 任务 1.3 的 sharp-edges 检查：函数 ref 与对象 ref 两种形式）。
describe("AlertDialogContent 的外部 ref", () => {
  function Dialog({ contentRef }: { contentRef: Ref<HTMLDivElement> }) {
    return (
      <AlertDialog open>
        <AlertDialogContent ref={contentRef} aria-describedby={undefined}>
          <AlertDialogTitle>对话框</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  it("对象 ref 收到对话框节点", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Dialog contentRef={ref} />);
    expect(ref.current).toBe(screen.getByRole("alertdialog"));
  });

  it("函数 ref 收到对话框节点，卸载时收到 null", () => {
    const calls: (HTMLDivElement | null)[] = [];
    const { unmount } = render(<Dialog contentRef={(node) => void calls.push(node)} />);
    expect(calls.at(-1)).toBe(screen.getByRole("alertdialog"));
    unmount();
    expect(calls.at(-1)).toBeNull();
  });
});

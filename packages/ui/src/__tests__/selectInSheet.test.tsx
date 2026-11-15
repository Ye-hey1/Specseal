import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// 抽屉内的下拉是管理面的常见组合（邀请抽屉挑项目、细节抽屉改角色）。Sheet 是 modal
// Dialog，它的 FocusScope 会把焦点锁在 content 内；Select 的菜单却 portal 到 body，
// 落在 content 外。两者对同一次 focus 事件各自反应就会互推到爆堆栈——这支测试钉住
// 「抽屉内的下拉可以正常打开与选取」。
function Fixture() {
  return (
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>抽屉</SheetTitle>
        </SheetHeader>
        <Select defaultValue="a">
          <SelectTrigger aria-label="选项">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">甲</SelectItem>
            <SelectItem value="b">乙</SelectItem>
          </SelectContent>
        </Select>
      </SheetContent>
    </Sheet>
  );
}

describe("抽屉内的 Select", () => {
  it("可以打开菜单并选取，不与 Sheet 的 focus trap 互推", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Fixture />);
    await user.click(screen.getByRole("combobox", { name: "选项" }));
    await user.click(await screen.findByRole("option", { name: "乙" }));
    expect(screen.getByRole("combobox", { name: "选项" }).textContent).toContain("乙");
  });
});

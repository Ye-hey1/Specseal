// shadcn Table 原语（跨 Desktop／Server Web 共用）：语意 <table> 结构、themed 边框、
// 窄容器横向卷动。server-web 管理页的多个表格改用此原语，不再手刻原生 <table>。
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

function sample() {
  return render(
    <Table>
      <TableCaption>用户清单</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>状态</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>alice</TableCell>
          <TableCell>激活</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
}

describe("Table 原语", () => {
  it("渲染语意 table／columnheader／cell 角色", () => {
    sample();
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    // <caption> 供屏幕阅读器辨识表格用途。
    expect(within(table).getByText("用户清单").tagName).toBe("CAPTION");
    expect(screen.getByRole("columnheader", { name: "名称" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "alice" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("以 themed border-border 画列边框（非 Tailwind v4 缺省的 currentColor 黑框）", () => {
    sample();
    // 数据列带 border-border——手刻裸 border 会落到 currentColor（≈黑），这正是要避免的。
    const bodyRow = screen.getByRole("cell", { name: "alice" }).closest("tr");
    expect(bodyRow?.className).toContain("border-border");
  });

  it("外层容器可横向卷动，窄窗口表格不撑破版面", () => {
    sample();
    const wrapper = screen.getByRole("table").parentElement;
    expect(wrapper?.className).toContain("overflow-x-auto");
  });

  // server-web-list-pages design D1、D7：调用端自己就是卷动区（列表卡）时不包外层容器——外层的
  // overflow-x-auto 会自成卷动容器，表头的 sticky 就黏在那层、随列表卡卷走。
  it("wrapped={false} 时不包外层卷动容器，表格直接在调用端的容器内", () => {
    const { container } = render(
      <div data-host>
        <Table wrapped={false}>
          <TableBody>
            <TableRow>
              <TableCell>x</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>,
    );
    const table = screen.getByRole("table");
    expect(table.parentElement).toBe(container.querySelector("[data-host]"));
    expect(table.className).toContain("w-full");
  });

  // 固定表头由组件提供（调用端不以 className 补底色）：卷动时表头留在顶端、带卡片底色盖住底下的列。
  it("TableHeader sticky 时表头固定在顶端并带卡片底色；未给时没有", () => {
    const { unmount } = render(
      <Table wrapped={false}>
        <TableHeader sticky>
          <TableRow>
            <TableHead>名称</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const head = screen.getByRole("table").querySelector("thead") as HTMLElement;
    expect(head.className.split(/\s+/)).toEqual(expect.arrayContaining(["sticky", "top-0", "bg-card"]));
    unmount();
    sample();
    expect((screen.getByRole("table").querySelector("thead") as HTMLElement).className).not.toContain("sticky");
  });

  it("className 并入 cn，不覆盖基底样式", () => {
    render(
      <Table className="custom-table">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole("table");
    expect(table.className).toContain("custom-table");
    expect(table.className).toContain("w-full");
  });

  // desktop-subagent-model-page：列里放控制项的表格（设置页）不要滑过底色，由组件提供开关、调用端不盖 className。
  it("TableRow hoverable={false} 不带滑过底色；未给时照常有", () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-testid="plain" hoverable={false}>
            <TableCell>a</TableCell>
          </TableRow>
          <TableRow data-testid="hover">
            <TableCell>b</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const hoverClasses = (id: string) => screen.getByTestId(id).className.split(/\s+/).filter((c) => c.startsWith("hover:"));
    expect(hoverClasses("plain")).toEqual([]);
    expect(hoverClasses("hover")).toEqual(["hover:bg-muted/50"]);
    expect(screen.getByTestId("plain").className).toContain("border-b");
  });
});

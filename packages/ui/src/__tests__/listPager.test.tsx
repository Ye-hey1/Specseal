// spec 需求「清单最新在前与换页浏览」的换页工具列（desktop-list-pages-reskin design D2：
// 自建受控组件）：左侧笔数范围＋每页笔数下拉、右侧 ‹ 页码 › 与跳页输入（总页数 > 1
// 才出现）、pageWindow 纯函数的省略号规则、total 为 0 不渲染。
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, renderHook, act, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ListPager, PAGE_SIZE, pageWindow, usePaging } from "../components/ListPager";

// 既有中文断言包 I18nProvider locale zh-CN（与 specList.test 同型）。
const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const noop = () => {};
const pageButtons = () =>
  screen.queryAllByRole("button", { name: /^第 \d+ 页$/ }).map((b) => b.textContent);

describe("pageWindow（页码窗口）", () => {
  // 总页数 ≤ 7 全列；否则恒列 1 与 M、中段为 page−1..page+1，与两端不相邻处插入 …。
  it.each<[number, number, Array<number | "…">]>([
    [1, 1, [1]],
    [3, 5, [1, 2, 3, 4, 5]],
    [4, 7, [1, 2, 3, 4, 5, 6, 7]],
    [1, 8, [1, 2, "…", 8]],
    [2, 8, [1, 2, 3, "…", 8]],
    [4, 8, [1, "…", 3, 4, 5, "…", 8]],
    [8, 8, [1, "…", 7, 8]],
  ])("page %i / %i → %j", (page, pageCount, expected) => {
    expect(pageWindow(page, pageCount)).toEqual(expected);
  });
});

describe("ListPager（换页工具列）", () => {
  it("PAGE_SIZE 共用常数为每页 20 笔", () => {
    expect(PAGE_SIZE).toBe(20);
  });

  it("total 为 0 时不渲染任何内容", () => {
    const { container } = render(
      <ListPager page={1} pageCount={1} total={0} pageSize={20} onPage={noop} onPageSize={noop} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("左侧显示笔数范围「第 21–40 笔，共 45 笔」与每页笔数下拉", () => {
    render(<ListPager page={2} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(screen.getByText("第 21–40 笔，共 45 笔")).toBeTruthy();
    const perPage = screen.getByRole("combobox", { name: "每页 20 个" });
    expect(perPage.textContent).toContain("每页 20 个");
  });

  it("末页范围以总笔数收尾：第 41–45 笔", () => {
    render(<ListPager page={3} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(screen.getByText("第 41–45 笔，共 45 笔")).toBeTruthy();
  });

  it("每页下拉选 50 调用 onPageSize(50)；选项为 20／50／100", async () => {
    const user = userEvent.setup();
    const onPageSize = vi.fn();
    render(<ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={onPageSize} />);
    await user.click(screen.getByRole("combobox", { name: "每页 20 个" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["每页 20 个", "每页 50 个", "每页 100 个"]);
    await user.click(screen.getByRole("option", { name: "每页 50 个" }));
    expect(onPageSize).toHaveBeenCalledWith(50);
  });

  it("总页数 > 1 时右侧有 ‹ 页码 › 与跳页输入；作用中页码主色淡底、其余无", () => {
    render(<ListPager page={2} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(pageButtons()).toEqual(["1", "2", "3"]);
    const active = screen.getByRole("button", { name: "第 2 页" });
    expect(active.className).toContain("bg-primary/12");
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "第 1 页" }).className).not.toContain("bg-primary/12");
    expect(screen.getByRole("spinbutton", { name: "跳到第几页" })).toBeTruthy();
  });

  it("第 1 页上一页钮 disabled、末页下一页钮 disabled；点击以正确页码调用 onPage", () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />,
    );
    const prev = () => screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    const next = () => screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    fireEvent.click(next());
    expect(onPage).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "第 3 页" }));
    expect(onPage).toHaveBeenCalledWith(3);
    rerender(<ListPager page={3} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(true);
    fireEvent.click(prev());
    expect(onPage).toHaveBeenLastCalledWith(2);
  });

  it("跳页输入 9 按 Enter 于 3 页时调用 onPage(3)（越界钳制）；0 钳制至 1；非数字不调用", () => {
    const onPage = vi.fn();
    render(<ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />);
    const jump = screen.getByRole("spinbutton", { name: "跳到第几页" }) as HTMLInputElement;
    fireEvent.change(jump, { target: { value: "9" } });
    fireEvent.keyDown(jump, { key: "Enter" });
    expect(onPage).toHaveBeenLastCalledWith(3);
    fireEvent.change(jump, { target: { value: "0" } });
    fireEvent.keyDown(jump, { key: "Enter" });
    expect(onPage).toHaveBeenLastCalledWith(1);
    onPage.mockClear();
    fireEvent.change(jump, { target: { value: "abc" } });
    fireEvent.keyDown(jump, { key: "Enter" });
    fireEvent.change(jump, { target: { value: "" } });
    fireEvent.keyDown(jump, { key: "Enter" });
    expect(onPage).not.toHaveBeenCalled();
  });

  it("工具列自带上缘分隔线（列表卡 footer 槽不画线，工具列不渲染时卡底不留空线）", () => {
    const { container } = render(
      <ListPager page={1} pageCount={1} total={13} pageSize={20} onPage={noop} onPageSize={noop} />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain("border-t");
  });

  it("跳页输入只认 Enter：打了数字后焦点移到页码钮时不提交并清空，点页码 2 只换到第 2 页", () => {
    const onPage = vi.fn();
    render(<ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />);
    const jump = screen.getByRole("spinbutton", { name: "跳到第几页" }) as HTMLInputElement;
    const page2 = screen.getByRole("button", { name: "第 2 页" });
    fireEvent.change(jump, { target: { value: "3" } });
    // 鼠标按下页码钮的那一刻输入框先失焦（relatedTarget＝页码钮），点击随后才到。
    fireEvent.blur(jump, { relatedTarget: page2 });
    fireEvent.click(page2);
    expect(onPage.mock.calls).toEqual([[2]]);
    expect(jump.value).toBe("");
  });

  it("跳页输入失焦时 relatedTarget 为 null 也不提交并清空（WebKit 点按钮不给焦点、点空白处皆同）", () => {
    const onPage = vi.fn();
    render(<ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />);
    const jump = screen.getByRole("spinbutton", { name: "跳到第几页" }) as HTMLInputElement;
    fireEvent.change(jump, { target: { value: "2" } });
    fireEvent.blur(jump);
    expect(onPage).not.toHaveBeenCalled();
    expect(jump.value).toBe("");
  });

  it("8 页时以省略号收拢中段，省略号不是按钮", () => {
    render(<ListPager page={4} pageCount={8} total={160} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(pageButtons()).toEqual(["1", "3", "4", "5", "8"]);
    const bar = screen.getByRole("navigation");
    expect(within(bar).getAllByText("…")).toHaveLength(2);
  });

  it("单页（总页数 1）时只有左侧：无页码钮、无 « ‹ › »、无跳页输入", () => {
    render(<ListPager page={1} pageCount={1} total={13} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(screen.getByText("第 1–13 笔，共 13 笔")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "每页 20 个" })).toBeTruthy();
    expect(pageButtons()).toEqual([]);
    expect(screen.queryByRole("button", { name: "第一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最后一页" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  // spec scenario「第一页与最后一页钮」：« 在 ‹ 左侧、» 在 › 右侧，首末页时停用。
  it("« 第一页钮与 » 最后一页钮：位于 ‹ › 外侧；第 1 页时 « 停用、末页时 » 停用", () => {
    const { rerender } = render(
      <ListPager page={1} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={noop} />,
    );
    const first = () => screen.getByRole("button", { name: "第一页" }) as HTMLButtonElement;
    const last = () => screen.getByRole("button", { name: "最后一页" }) as HTMLButtonElement;
    const nav = screen.getByRole("navigation");
    const order = within(nav)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(order).toEqual(["第一页", "上一页", "第 1 页", "第 2 页", "第 3 页", "下一页", "最后一页"]);
    expect(first().disabled).toBe(true);
    expect(last().disabled).toBe(false);
    rerender(<ListPager page={3} pageCount={3} total={45} pageSize={20} onPage={noop} onPageSize={noop} />);
    expect(first().disabled).toBe(false);
    expect(last().disabled).toBe(true);
  });

  it("第 2 页点 » 调用 onPage(3)、点 « 调用 onPage(1)", () => {
    const onPage = vi.fn();
    render(<ListPager page={2} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "最后一页" }));
    expect(onPage).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "第一页" }));
    expect(onPage).toHaveBeenLastCalledWith(1);
  });

  // server-web-list-pages design D1：窄版只留范围、‹、「目前页 / 总页数」、›。
  it("compact：只渲染范围、上一页、「2 / 3」与下一页；没有每页笔数下拉、页码钮、首末页钮与跳页输入", () => {
    const onPage = vi.fn();
    render(
      <ListPager compact page={2} pageCount={3} total={45} pageSize={20} onPage={onPage} onPageSize={noop} />,
    );
    expect(screen.getByText("第 21–40 笔，共 45 笔")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(pageButtons()).toEqual([]);
    expect(screen.queryByRole("button", { name: "第一页" })).toBeNull();
    expect(screen.queryByRole("button", { name: "最后一页" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["上一页", "下一页"]);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onPage).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onPage).toHaveBeenLastCalledWith(1);
  });

  it("compact 且总页数 1：只有范围，右侧缺席", () => {
    render(
      <ListPager compact page={1} pageCount={1} total={12} pageSize={20} onPage={noop} onPageSize={noop} />,
    );
    expect(screen.getByText("第 1–12 笔，共 12 笔")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("usePaging（清单换页状态）", () => {
  const ITEMS = Array.from({ length: 45 }, (_, i) => i);

  it("切出目前页；换页与改每页笔数调用 onMove；改每页笔数把页码钳制写回；清单缩短时页码派生钳制", () => {
    const onMove = vi.fn();
    const { result, rerender } = renderHook(({ list }) => usePaging(list, { onMove }), {
      initialProps: { list: ITEMS },
    });
    expect(result.current.pager).toMatchObject({ page: 1, pageCount: 3, total: 45, pageSize: PAGE_SIZE });
    act(() => result.current.pager.onPage(3));
    expect(result.current.pageItems).toEqual(ITEMS.slice(40, 45));
    expect(onMove).toHaveBeenCalledTimes(1);
    act(() => result.current.pager.onPageSize(50));
    expect(result.current.pager).toMatchObject({ page: 1, pageCount: 1, pageSize: 50 });
    expect(onMove).toHaveBeenCalledTimes(2);
    // 钳制已写回：改回 20 不弹回旧的第 3 页。
    act(() => result.current.pager.onPageSize(20));
    expect(result.current.pager.page).toBe(1);
    // 清单缩短：停在第 3 页时剩 25 笔 → 派生为第 2 页。
    act(() => result.current.pager.onPage(3));
    rerender({ list: ITEMS.slice(0, 25) });
    expect(result.current.pager).toMatchObject({ page: 2, pageCount: 2, total: 25 });
    // setPage 只改页码、不卷动（搜索重设与聚焦列用）。
    onMove.mockClear();
    act(() => result.current.setPage(1));
    expect(result.current.pager.page).toBe(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("值与回呼都给时受控：以 prop 为准，改每页笔数调用回呼", () => {
    const onPageSizeChange = vi.fn();
    const { result } = renderHook(() =>
      usePaging(ITEMS, { pageSize: 50, onPageSizeChange, onMove: () => {} }),
    );
    expect(result.current.pager.pageSize).toBe(50);
    expect(result.current.pageItems).toHaveLength(45);
    act(() => result.current.pager.onPageSize(100));
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });
});

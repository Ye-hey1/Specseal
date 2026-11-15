// 详情页顶列右端的 ‹ n／m ›（server-web-detail-pages design D3：由 desktop 搬进共用组件库，
// desktop 与 server 后台共用）。字符串改由内置字典提供，所以这里不带 app 字典。
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { DetailNav } from "../components/DetailNav";
import { I18nProvider } from "../i18n";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

afterEach(cleanup);

const prev = () => screen.getByRole("button", { name: "上一个" }) as HTMLButtonElement;
const next = () => screen.getByRole("button", { name: "下一个" }) as HTMLButtonElement;

describe("DetailNav", () => {
  it("2/3：两钮可按、序位文本为「2 / 3」且为等宽 11px", () => {
    render(<DetailNav index={1} total={3} onStep={() => {}} />);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(false);
    const pos = screen.getByText("2 / 3");
    expect(pos.className).toContain("font-mono");
    expect(pos.className).toContain("text-[11px]");
    expect(pos.getAttribute("aria-label")).toBe("第 2 个，共 3 个");
  });

  it("1/3：‹ 停用、› 可按", () => {
    render(<DetailNav index={0} total={3} onStep={() => {}} />);
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
  });

  it("3/3：› 停用、‹ 可按（不循环）", () => {
    render(<DetailNav index={2} total={3} onStep={() => {}} />);
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(true);
  });

  it("目前项目不在串行（index -1）或串行为空时整组缺席", () => {
    const { container, unmount } = render(<DetailNav index={-1} total={3} onStep={() => {}} />);
    expect(container.innerHTML).toBe("");
    unmount();
    const second = render(<DetailNav index={0} total={0} onStep={() => {}} />);
    expect(second.container.innerHTML).toBe("");
  });

  it("点 ‹ 调用 onStep(-1)、点 › 调用 onStep(1)", () => {
    const onStep = vi.fn();
    render(<DetailNav index={1} total={3} onStep={onStep} />);
    fireEvent.click(prev());
    fireEvent.click(next());
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
  });
});

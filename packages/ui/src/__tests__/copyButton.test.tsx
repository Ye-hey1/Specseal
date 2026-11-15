// 共用拷贝钮（spec desktop-app「共用组件唯一来源」Scenario「系统匣面板的拷贝钮来自
// 共用组件库」；design D8）：缺省写 navigator.clipboard、onCopy 可覆写，成功后主色勾号
// 1.5 秒，失败不抛错也不呈勾号。
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { CopyButton, REVEAL_ON_HOVER } from "../components/CopyButton";
import { REVEAL_ON_GROUP_HOVER } from "../reveal";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

const writeText = vi.fn<(v: string) => Promise<void>>();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  writeText.mockReset();
});

const btn = () => screen.getByRole("button", { name: "拷贝名称" });
const hasCheck = () => btn().querySelector("svg.lucide-check") !== null;
/** 让 promise 的 then 跑完（假计时器下也适用）。 */
const flush = () => act(async () => {});

describe("CopyButton", () => {
  it("缺省写入 navigator.clipboard，成功后呈勾号并以 status 声明已拷贝", async () => {
    writeText.mockResolvedValue();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopyButton value="demo" label="拷贝名称" />);
    expect(hasCheck()).toBe(false);
    fireEvent.click(btn());
    await flush();
    expect(writeText).toHaveBeenCalledWith("demo");
    expect(hasCheck()).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("已拷贝");
  });

  it("onCopy 覆写剪贴板路径：以 value 调用、不碰 navigator.clipboard", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onCopy = vi.fn();
    render(<CopyButton value="demo" label="拷贝名称" onCopy={onCopy} />);
    fireEvent.click(btn());
    await flush();
    expect(onCopy).toHaveBeenCalledWith("demo");
    expect(writeText).not.toHaveBeenCalled();
    expect(hasCheck()).toBe(true);
  });

  it("成功后勾号维持 1.5 秒内、之后复原", () => {
    vi.useFakeTimers();
    render(<CopyButton value="demo" label="拷贝名称" onCopy={() => {}} />);
    fireEvent.click(btn());
    expect(hasCheck()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(hasCheck()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(hasCheck()).toBe(false);
  });

  it("失败不抛错、不呈勾号：onCopy reject", async () => {
    render(
      <CopyButton value="demo" label="拷贝名称" onCopy={() => Promise.reject(new Error("denied"))} />,
    );
    fireEvent.click(btn());
    await flush();
    expect(hasCheck()).toBe(false);
  });

  it("失败不抛错、不呈勾号：没有 clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    render(<CopyButton value="demo" label="拷贝名称" />);
    expect(() => fireEvent.click(btn())).not.toThrow();
    await flush();
    expect(hasCheck()).toBe(false);
  });

  it("写入完成前组件已卸载：完成后不再开计时器", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const pending = () =>
      new Promise<void>((r) => {
        resolve = r;
      });
    const { unmount } = render(<CopyButton value="demo" label="拷贝名称" onCopy={pending} />);
    fireEvent.click(btn());
    unmount();
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("点击不冒泡到外层（列本体的打开不被触发）", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <CopyButton value="demo" label="拷贝名称" onCopy={() => {}} />
      </div>,
    );
    fireEvent.click(btn());
    expect(onRow).not.toHaveBeenCalled();
  });

  it("size=sm 呈外框小钮与「拷贝／已拷贝」文本", async () => {
    render(<CopyButton value="demo" label="拷贝名称" size="sm" onCopy={() => {}} />);
    expect(btn().textContent).toContain("拷贝");
    expect(btn().className).toContain("border");
    fireEvent.click(btn());
    await flush();
    expect(btn().textContent).toContain("已拷贝");
  });

  it("成功后标上 data-copied，调用端可据此让 hover 才显现的钮保持可见", () => {
    render(<CopyButton value="demo" label="拷贝名称" onCopy={() => {}} />);
    expect(btn().hasAttribute("data-copied")).toBe(false);
    fireEvent.click(btn());
    expect(btn().hasAttribute("data-copied")).toBe(true);
  });

  // 滑过才出现的共用基底（拷贝钮、server 撤销钮）：所在列滑过或键盘聚焦时出现，触摸设备恒常显示。
  it("REVEAL_ON_HOVER 以共用基底组成：列滑过、键盘聚焦、触摸恒显，拷贝后保持可见", () => {
    const base = REVEAL_ON_GROUP_HOVER.split(" ");
    expect(base).toEqual(
      expect.arrayContaining([
        "opacity-0",
        "group-hover:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      ]),
    );
    const copy = REVEAL_ON_HOVER.split(" ");
    expect(copy).toEqual(expect.arrayContaining([...base, "data-[copied]:opacity-100"]));
  });

  // spec desktop-app「变更与讨论详情页的宿主为看板」Scenario「宿主页不推动详情页外框」：
  // absolute 的朗读区不钉位置会停在卷动区外的深处，撑高 desktop 的 main。
  // 这是 class 字面守门（jsdom 不算版面），版面本身由该 Scenario 的 Mac 实机手动任务确认。
  it("隐藏朗读区钉在定位容器左上角（sr-only top-0 left-0）", () => {
    render(<CopyButton value="demo" label="拷贝名称" />);
    const live = screen.getByRole("status");
    expect(live.classList).toContain("sr-only");
    expect(live.classList).toContain("top-0");
    expect(live.classList).toContain("left-0");
  });
});

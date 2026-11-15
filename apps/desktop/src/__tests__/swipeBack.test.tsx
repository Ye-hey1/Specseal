// 触摸板滑动返回（spec desktop-app「详情页的导览与返回」；desktop-swipe-back-finger-lift design D4）：
// 只在原生层送来的手指按下（began）到离开（ended）之间累计朝返回方向的水平位移，左缘「←」指示
// 随之推出、达门槛转实心；手指离开的当下结算——已达门槛即返回、未达收回，不等惯性卷动。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";

import { SWIPE_THRESHOLD, SwipeBack } from "../components/SwipeBack";
import { type GestureHandler, gesture, gestureHandlers } from "./helpers/trackpadGesture";

// 拦下 Tauri 事件层：trackpad-gesture 的处理器交给共用替身，测试以 gesture() 仿真手指按下与离开。
vi.mock("@tauri-apps/api/event", async () => {
  const { subscribeGesture } = await import("./helpers/trackpadGesture");
  return { listen: vi.fn((_event: string, handler: GestureHandler) => subscribeGesture(handler)) };
});

// 假计时器且从不推进：结算若仍靠计时器，onBack 就不会在 ended 的当下被调用。
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  gestureHandlers.length = 0;
  vi.mocked(listen).mockClear();
});

const indicator = () => document.querySelector("[data-swipe-back]") as HTMLElement;

/** 送一个 wheel 事件；`inverted` 对应 WebKit 的自然卷动旗标（缺席＝不带此字段）。 */
function wheel(
  target: EventTarget,
  deltaX: number,
  { deltaY = 0, inverted, ctrlKey = false, shiftKey = false }: { deltaY?: number; inverted?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
) {
  const e = new WheelEvent("wheel", { deltaX, deltaY, ctrlKey, shiftKey, bubbles: true, cancelable: true });
  if (inverted !== undefined) Object.defineProperty(e, "webkitDirectionInvertedFromDevice", { value: inverted });
  act(() => {
    target.dispatchEvent(e);
  });
}

/** 一次完整手势：手指按下、依序送出位移（自然卷动下手指向右＝deltaX 为负）、手指离开。 */
function swipe(deltas: number[], target: EventTarget = window, inverted?: boolean) {
  gesture("began");
  for (const dx of deltas) wheel(target, dx, { inverted });
  gesture("ended");
}

describe("SwipeBack", () => {
  it("手指按着滑过门槛：指示转实心但不返回；手指离开的当下返回并收回指示", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    for (let i = 0; i < 4; i++) wheel(window, -50);
    expect(indicator().getAttribute("data-armed")).toBe("true");
    expect(onBack).not.toHaveBeenCalled();
    gesture("ended");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
  });

  // spec Example「放开时的结算（门槛 120px）」逐列；惯性是手指离开后才送的 wheel。
  it.each([
    { gesture: "向右滑 200px 后放开", result: "立即关闭详情页", moves: [-50, -50, -50, -50], momentum: [], backs: 1 },
    { gesture: "向右滑 80px 后放开", result: "指示收回、详情页维持", moves: [-40, -40], momentum: [], backs: 0 },
    {
      gesture: "向右滑 150px、未放开再往回滑到 80px 后放开",
      result: "指示收回、详情页维持",
      moves: [-50, -50, -50, 70],
      momentum: [],
      backs: 0,
    },
    {
      gesture: "向右滑 200px 后放开，惯性又卷了 300px",
      result: "放开当下关页，惯性不影响",
      moves: [-50, -50, -50, -50],
      momentum: [-100, -100, -100],
      backs: 1,
    },
  ])("$gesture → $result", ({ moves, momentum, backs }) => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    swipe(moves);
    expect(onBack).toHaveBeenCalledTimes(backs);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    for (const dx of momentum) wheel(window, dx);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    expect(onBack).toHaveBeenCalledTimes(backs);
  });

  it("放开前滑回门槛以下：指示由实心转回空心，放开不返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    for (let i = 0; i < 3; i++) wheel(window, -50);
    expect(indicator().getAttribute("data-armed")).toBe("true");
    wheel(window, 70);
    expect(indicator().hasAttribute("data-armed")).toBe(false);
    gesture("ended");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("没有手势阶段的输入（一般鼠标水平滚轮、Shift＋滚轮）不推进指示、不返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    for (let i = 0; i < 4; i++) wheel(window, -50);
    for (let i = 0; i < 4; i++) wheel(window, -50, { shiftKey: true });
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("系统设置不允许两指滑动（began 的 swipeEnabled 为 false）时不推进、不返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began", false);
    for (let i = 0; i < 4; i++) wheel(window, -50);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    gesture("ended");
    expect(onBack).not.toHaveBeenCalled();
    // 设置改回允许两指：下一次手势即可返回。
    swipe([-50, -50, -50, -50]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("同一手势的 MayBegin 与 Began 各送一次 began：第二次归零时尚未移动，放开照常返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    gesture("began");
    for (let i = 0; i < 4; i++) wheel(window, -50);
    gesture("ended");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // ended 遗失（系统没送 Cancelled）时，下一次 began 就是新手势；轻触不移动也是 began（MayBegin）→ended。
  it.each([
    { next: "允许两指滑动", swipeEnabled: true },
    { next: "系统设置已改为不允许", swipeEnabled: false },
  ])("ended 遗失、指示停在实心后，下一次 began（$next）从零开始：轻触放开不返回", ({ swipeEnabled }) => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    for (let i = 0; i < 4; i++) wheel(window, -50);
    expect(indicator().getAttribute("data-armed")).toBe("true");
    gesture("began", swipeEnabled);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    gesture("ended");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("先垂直卷动 40px 再向右滑 200px：整次手势取消，放开不返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    wheel(window, 0, { deltaY: 40 });
    for (let i = 0; i < 4; i++) wheel(window, -50);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    gesture("ended");
    expect(onBack).not.toHaveBeenCalled();
    // 取消只持续到手指离开：下一次手势重新判定。
    swipe([-50, -50, -50, -50]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("纯水平 200px 夹少量垂直晃动（累计 8px）不取消，放开即返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    for (let i = 0; i < 4; i++) wheel(window, -50, { deltaY: 2 });
    gesture("ended");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("往前方向的滑动与缩放（ctrl＋滚轮）都不理会", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    swipe([50, 50, 50, 50]);
    gesture("began");
    for (let i = 0; i < 4; i++) wheel(window, -50, { ctrlKey: true });
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    gesture("ended");
    expect(onBack).not.toHaveBeenCalled();
  });

  /** 宽 600、可视 200 的水平卷动区块（overflow 可卷动才算），回传其内的子元素当事件目标。 */
  function scroller(scrollLeft: number, overflowX = "auto") {
    const box = document.createElement("div");
    const cell = document.createElement("span");
    box.appendChild(cell);
    document.body.appendChild(box);
    box.style.overflowX = overflowX;
    Object.defineProperty(box, "scrollWidth", { value: 600 });
    Object.defineProperty(box, "clientWidth", { value: 200 });
    box.scrollLeft = scrollLeft;
    return { box, cell };
  }

  it("手势开始于仍可往左卷动的水平卷动区块时不接手；卷到最左才接手", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    const { box, cell } = scroller(50);
    swipe([-40, -40, -40, -40], cell);
    expect(onBack).not.toHaveBeenCalled();
    box.scrollLeft = 0;
    swipe([-40, -40, -40, -40], cell);
    expect(onBack).toHaveBeenCalledTimes(1);
    box.remove();
  });

  it("自然卷动关闭时手指向右是把区块往右卷：停在最左的宽表格仍可往右卷就不接手，卷到最右才接手", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    const { box, cell } = scroller(0);
    swipe([40, 40, 40, 40], cell, false);
    expect(onBack).not.toHaveBeenCalled();
    box.scrollLeft = 400;
    swipe([40, 40, 40, 40], cell, false);
    expect(onBack).toHaveBeenCalledTimes(1);
    box.remove();
  });

  it("只裁切不卷动的区块（overflow hidden，如截断的长名称）不挡返回", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    const { box, cell } = scroller(0, "hidden");
    swipe([40, 40, 40, 40], cell, false);
    expect(onBack).toHaveBeenCalledTimes(1);
    box.remove();
  });

  it("自然卷动关闭时方向反转：手指向右＝deltaX 为正", () => {
    const onBack = vi.fn();
    render(<SwipeBack enabled onBack={onBack} />);
    swipe([-40, -40, -40, -40], window, false);
    expect(onBack).not.toHaveBeenCalled();
    swipe([40, 40, 40, 40], window, false);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("停用时不订阅手势事件、也不监听 wheel", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const onBack = vi.fn();
    render(<SwipeBack enabled={false} onBack={onBack} />);
    expect(listen).not.toHaveBeenCalled();
    expect(addListener.mock.calls.some(([type]) => type === "wheel")).toBe(false);
    swipe([-50, -50, -50, -50]);
    expect(onBack).not.toHaveBeenCalled();
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    addListener.mockRestore();
  });

  it("手势中途停用（详情页关闭）：指示归零并解除订阅", async () => {
    const onBack = vi.fn();
    const { rerender } = render(<SwipeBack enabled onBack={onBack} />);
    gesture("began");
    wheel(window, -SWIPE_THRESHOLD / 2);
    expect(indicator().getAttribute("data-progress")).toBe("0.50");
    rerender(<SwipeBack enabled={false} onBack={onBack} />);
    expect(indicator().getAttribute("data-progress")).toBe("0.00");
    await act(async () => {});
    expect(gestureHandlers).toHaveLength(0);
  });
});

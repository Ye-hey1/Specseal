// desktop-app「抽屉与浮层的开关动画」Scenario「减少动态偏好下无动画」：jsdom 没有版面
// 与媒体查找，比照 skeleton.test 以 motion-reduce: 变体 class 断言（repo 既有惯例），
// 并确认进出两向的动画 class 都在（出场 class 缺席＝关闭时直接消失）。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { Sheet, SheetContent } from "../components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";

const REQUIRED = ["motion-reduce:animate-none", "data-[state=open]:animate-in", "data-[state=closed]:animate-out"];

describe("抽屉与浮层的减少动态变体", () => {
  it("Sheet 的遮罩与面板都带进出动画与 motion-reduce 变体", () => {
    render(
      <Sheet open>
        <SheetContent>面板</SheetContent>
      </Sheet>,
    );
    const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-state="open"]'));
    expect(layers.length).toBeGreaterThanOrEqual(2);
    for (const el of layers) for (const cls of REQUIRED) expect(el.className).toContain(cls);
  });

  it("Popover 与 Tooltip 的内容层同样带进出动画与 motion-reduce 变体", () => {
    render(
      <>
        <Popover open>
          <PopoverTrigger>p</PopoverTrigger>
          <PopoverContent>浮层</PopoverContent>
        </Popover>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>t</TooltipTrigger>
            <TooltipContent>提示</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </>,
    );
    // 两种内容层都由 Radix 标上 data-side；trigger 没有。Popover 的打开态是 open，
    // Tooltip 的是 delayed-open／instant-open——进场变体必须挂在实际会出现的值上。
    const layers = Array.from(document.querySelectorAll<HTMLElement>("[data-side]"));
    expect(layers.length).toBe(2);
    const popover = layers.find((el) => el.getAttribute("role") === "dialog") as HTMLElement;
    const tooltip = layers.find((el) => el !== popover) as HTMLElement;
    expect(popover.getAttribute("data-state")).toBe("open");
    for (const cls of REQUIRED) expect(popover.className).toContain(cls);
    const tooltipState = tooltip.getAttribute("data-state") ?? "";
    expect(["delayed-open", "instant-open"]).toContain(tooltipState);
    for (const cls of [
      "motion-reduce:animate-none",
      "data-[state=closed]:animate-out",
      `data-[state=${tooltipState}]:animate-in`,
      "data-[state=delayed-open]:animate-in",
      "data-[state=instant-open]:animate-in",
    ]) {
      expect(tooltip.className).toContain(cls);
    }
    expect(tooltip.className).not.toContain("data-[state=open]:");
  });
});

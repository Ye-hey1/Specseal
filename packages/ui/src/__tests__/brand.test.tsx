// 品牌标记与字标（spec desktop-app「共用组件唯一来源」Scenario「品牌资产只有一处」
// 「品牌标记随主题取主色」；design D8）。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

/** 外层 span 是无障碍图片；内嵌 SVG 原稿自带 role=img，为 role=img 的子节点、浏览器视为装饰。 */
const markEl = (container: HTMLElement) => container.firstElementChild as HTMLElement;

import { BrandMark, Wordmark } from "../components/Brand";

describe("BrandMark", () => {
  it("以 currentColor 内嵌 SVG 标记，颜色跟 text-primary 走", () => {
    const { container } = render(<BrandMark />);
    const mark = markEl(container);
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Specseal");
    expect(mark.className).toContain("text-primary");
    const svg = mark.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg!.innerHTML).toContain('fill="currentColor"');
    expect(svg!.outerHTML).not.toContain("#167873");
  });

  it("高度缺省 26px，size 可覆写", () => {
    const first = render(<BrandMark />);
    expect(markEl(first.container).style.height).toBe("26px");
    first.unmount();
    const second = render(<BrandMark size={20} />);
    expect(markEl(second.container).style.height).toBe("20px");
  });
});

describe("Wordmark", () => {
  // 深浅两版各一张 img、以 dark: 变体切换（desktop-settings-mode：dark: 与深色 token 同一套触发，
  // 明示外观也跟得上）；隐藏的那张不进无障碍树，同时只有一个「Specseal」。
  it("浅色版与深色版两张 img（alt=Specseal），以 dark: 切换显示，className 套到两张", () => {
    render(<Wordmark className="h-5" />);
    const [light, dark] = screen.getAllByAltText("Specseal") as HTMLImageElement[];
    expect(light.getAttribute("src")).toContain("logo-horizontal");
    expect(light.getAttribute("src")).not.toContain("logo-horizontal-dark");
    expect(light.className).toContain("dark:hidden");
    expect(dark.getAttribute("src")).toContain("logo-horizontal-dark");
    expect(dark.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "dark:block"]));
    for (const img of [light, dark]) expect(img.className).toContain("h-5");
  });
});

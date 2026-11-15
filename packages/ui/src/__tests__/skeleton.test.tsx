import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { Skeleton } from "../components/ui/skeleton";

// spec「看板首访以 skeleton 占位」「抽屉文档加载以 skeleton 呈现」的视觉基元
// （design D4）：圆角灰块＋pulse 动画，prefers-reduced-motion 下停用动画。
describe("Skeleton 基元", () => {
  it("以圆角灰块呈现并带 pulse 动画", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("rounded-md");
    expect(el.className).toContain("bg-muted");
  });

  // 逐处加 motion-reduce: 是本 repo 既有惯例（ProjectTabs、TrayPanel 等）；
  // jsdom 不求值 media query，故以 class 存在为断言面。
  it("带 motion-reduce 变体，减少动态效果时不动画", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("motion-reduce:animate-none");
  });

  it("接受外部 className 且与基底 class 合并", () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-24");
    expect(el.className).toContain("animate-pulse");
  });

  it("透传 HTML 属性（如 data-testid）", () => {
    const { getByTestId } = render(<Skeleton data-testid="bar" />);
    expect(getByTestId("bar")).toBeTruthy();
  });
});

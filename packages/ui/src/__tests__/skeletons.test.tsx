import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { CardSkeleton, DocSkeleton, RowSkeleton } from "../components/skeletons";

// spec「看板首访以 skeleton 占位」「面板分区首访 skeleton」「抽屉文档加载以
// skeleton 呈现」的三种占位组件（design D4）。aria-busy 标记加载中区块。
describe("CardSkeleton（看板占位卡）", () => {
  it("标记 aria-busy 并以卡形呈现名称条与摘要条", () => {
    const { container } = render(<CardSkeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-busy")).toBe("true");
    // 名称条＋摘要条：卡内至少两条占位灰块。
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(2);
  });

  it("不含任何文本内容（纯占位，不冒充空态文案）", () => {
    const { container } = render(<CardSkeleton />);
    expect(container.textContent).toBe("");
  });

  // 占位卡是「还没到的那张真卡片」，外框自刻就会与真实卡片分歧：裸写 border 在
  // Tailwind v4 落到 currentColor（近黑描边），正是这样飘掉的。锁的是 Card 的三个
  // 表面值——Card 换了样式，这里就该红一次让人回来看骨架还像不像真卡片。
  it("外框带 Card 的表面样式，不自刻描边", () => {
    const { container } = render(<CardSkeleton />);
    const el = container.firstElementChild as HTMLElement;
    // 看板卡片是容器内的小卡（Card size="nested"），占位卡同形：细框、12px 圆角、无阴影。
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("rounded-xl");
    expect(el.className).not.toContain("shadow");
    expect(el.className).toContain("bg-card");
  });
});

describe("RowSkeleton（面板占位列）", () => {
  it("标记 aria-busy 并以单行列形呈现", () => {
    const { container } = render(<RowSkeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(1);
  });

  it("不含任何文本内容", () => {
    const { container } = render(<RowSkeleton />);
    expect(container.textContent).toBe("");
  });
});

describe("DocSkeleton（文档占位）", () => {
  it("标记 aria-busy 并以标题条＋数行内文条呈现", () => {
    const { container } = render(<DocSkeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-busy")).toBe("true");
    // 标题条与内文条合计多于单行，才看得出是「一份文档」而非一条进度。
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(2);
  });

  it("不含任何文本内容（加载中不冒充「没有文档」空态）", () => {
    const { container } = render(<DocSkeleton />);
    expect(container.textContent).toBe("");
  });
});

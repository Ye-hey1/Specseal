// 波次章与被挡变淡（spec desktop-app「看板卡片的波次与阻挡标示」；add-change-plan-desktop
// design D4 改版）：清单项带 wave 时进度列最左浮现圆圈数字章，tooltip 合并前置清单；
// blockedBy 非空时整卡变淡（data-blocked），标题列不长任何调度章；缺 wave 时无章不变淡。
import { describe, it, expect, afterEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider, type UiLocale } from "../i18n";
import { ChangeCard } from "../components/ChangeCard";
import type { ChangeItem } from "../adapter";

function render(ui: ReactElement, locale: UiLocale = "zh-CN") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale={locale}>{children}</I18nProvider>
  );
  return rtlRender(ui, { wrapper });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function card(plan: Partial<ChangeItem>): ChangeItem {
  return { name: "add-c", status: "proposed", totalTasks: 3, completedTasks: 0, ...plan };
}

const cardEl = () => document.querySelector('[data-change="add-c"]') as HTMLElement;
/** 标题列＝Card 的第一个子元素（CardHeader）。 */
const headerEl = () => cardEl().firstElementChild as HTMLElement;

/** hover 章、推进 tooltip 延迟后回传浮层文本。 */
function hoverTooltip(badge: HTMLElement): string {
  fireEvent.pointerMove(badge, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(300);
  });
  return document.querySelector("[data-side]")?.textContent ?? "";
}

describe("ChangeCard 波次章与被挡变淡", () => {
  it("第一波无阻挡：进度列最左圆圈「1」，tooltip「第 1 波」，卡片不变淡", () => {
    vi.useFakeTimers();
    render(<ChangeCard change={card({ wave: 1, blockedBy: [], dependsOn: [], overlaps: [] })} />);
    const wave = screen.getByLabelText("第 1 波");
    expect(wave.textContent).toBe("1");
    expect(wave.getAttribute("title")).toBeNull();
    // 章在进度列内（任务数所在的那一列），且是该列第一个子元素（进度条之前）；
    // 以既有节点定位，不靠测试专用的 data 属性（缺 wave 时 DOM 才能逐比特不变）。
    const row = wave.parentElement as HTMLElement;
    expect(row.textContent).toContain("0/3");
    expect(row.firstElementChild).toBe(wave);
    expect(headerEl().contains(wave)).toBe(false);
    expect(cardEl().getAttribute("data-blocked")).toBeNull();
    expect(cardEl().className).not.toContain("opacity-60");
    expect(hoverTooltip(wave)).toContain("第 1 波");
  });

  it("第二波被两项挡住：圆圈「2」、tooltip「第 2 波 · 等待：add-a、add-b」、整卡变淡、标题列无「等 N 项」", () => {
    vi.useFakeTimers();
    render(
      <ChangeCard
        change={card({ wave: 2, blockedBy: ["add-a", "add-b"], dependsOn: ["add-a"], overlaps: [] })}
      />,
    );
    const wave = screen.getByLabelText("第 2 波");
    expect(wave.textContent).toBe("2");
    expect(cardEl().getAttribute("data-blocked")).toBe("true");
    expect(cardEl().className).toContain("opacity-60");
    expect(screen.queryByText(/等 \d+ 项/)).toBeNull();
    expect(headerEl().textContent).not.toMatch(/等待|波/);
    expect(hoverTooltip(wave)).toContain("第 2 波 · 等待：add-a、add-b");
  });

  it("缺 wave（remote 摘要或 plan 成环）时无章、不变淡", () => {
    render(<ChangeCard change={card({})} />);
    expect(screen.queryByLabelText(/^第 \d+ 波$/)).toBeNull();
    expect(cardEl().getAttribute("data-blocked")).toBeNull();
    expect(cardEl().className).not.toContain("opacity-60");
    // 其余呈现逐比特一致：DOM 不留任何调度痕迹（含测试用属性）。
    expect(cardEl().outerHTML).not.toMatch(/data-blocked|data-progress|opacity-60/);
    cleanup();
    // 只带 blockedBy 而无 wave（不合法组合）也不变淡。
    render(<ChangeCard change={card({ blockedBy: ["add-a"] })} />);
    expect(cardEl().getAttribute("data-blocked")).toBeNull();
  });

  it("requirement 级重叠与封存顺序不让卡片变淡、tooltip 不多出等待", () => {
    // blockedBy 只含声明前置；requirementOverlap 与 archiveAfter 只排封存先后、不挡开工
    // ——卡片只反映 blockedBy。
    vi.useFakeTimers();
    render(
      <ChangeCard
        change={card({
          wave: 1,
          blockedBy: [],
          dependsOn: [],
          overlaps: [],
          requirementOverlap: [
            {
              change: "add-b",
              capability: "desktop-app",
              requirement: "看板与任务",
              ownOperation: "MODIFIED",
              otherOperation: "MODIFIED",
              conflict: false,
            },
          ],
          archiveAfter: ["add-b"],
        })}
      />,
    );
    const wave = screen.getByLabelText("第 1 波");
    expect(cardEl().getAttribute("data-blocked")).toBeNull();
    expect(cardEl().className).not.toContain("opacity-60");
    const tip = hoverTooltip(wave);
    expect(tip).toContain("第 1 波");
    expect(tip).not.toContain("等待");
  });

  it("en 文案：Wave 2 · Waiting for: add-a, add-b", () => {
    vi.useFakeTimers();
    render(
      <ChangeCard change={card({ wave: 2, blockedBy: ["add-a", "add-b"], dependsOn: [], overlaps: [] })} />,
      "en",
    );
    const wave = screen.getByLabelText("Wave 2");
    expect(hoverTooltip(wave)).toContain("Wave 2 · Waiting for: add-a, add-b");
  });
});

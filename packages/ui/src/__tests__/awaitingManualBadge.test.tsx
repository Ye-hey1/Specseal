// 待手动章（spec desktop-app「看板卡片的待手动标示」；design D5）：写码任务全
// 完成、仅余未勾 `[M]` 时卡片浮现行内小章，tooltip 载明剩余项数。
import { describe, it, expect, afterEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { I18nProvider } from "../i18n";
import { ChangeCard } from "../components/ChangeCard";
import type { ChangeItem } from "../adapter";
import { SEMANTIC_TONE } from "../tone";

const zhWrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider locale="zh-CN">{children}</I18nProvider>
);
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: zhWrapper });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TOTAL = 10;

/** 一张写码进度已知的卡：remaining＝未勾任务数，codeRemaining 由调用端给。 */
function card(remaining: number, codeRemaining: number): ChangeItem {
  return {
    name: "c",
    status: "in-progress",
    totalTasks: TOTAL,
    completedTasks: TOTAL - remaining,
    codeTotal: TOTAL - remaining + codeRemaining,
    codeComplete: TOTAL - remaining,
    codeRemaining,
  };
}

describe("ChangeCard 待手动章", () => {
  it("浮现判定逐列成立（spec Example 表）", () => {
    // | codeRemaining | remaining | 待手动章 |
    const rows: [number, number, boolean][] = [
      [0, 1, true],
      [0, 3, true],
      [2, 3, false],
      [0, 0, false],
    ];
    for (const [codeRemaining, remaining, shown] of rows) {
      render(<ChangeCard change={card(remaining, codeRemaining)} />);
      const badge = screen.queryByLabelText("待手动");
      expect(Boolean(badge), `codeRemaining=${codeRemaining} remaining=${remaining}`).toBe(shown);
      cleanup();
    }
  });

  it("codeTotal=0 的全手动变更不浮现章（spec Example 表末列：空真值）", () => {
    // 尚无任何写码任务时「写码全完成」是空真值——没开工的卡不该声明待手动。
    render(
      <ChangeCard
        change={{
          name: "c",
          status: "proposed",
          totalTasks: 2,
          completedTasks: 0,
          codeTotal: 0,
          codeComplete: 0,
          codeRemaining: 0,
        }}
      />,
    );
    expect(screen.queryByLabelText("待手动")).toBeNull();
  });

  // spec「接口状态语意色分层」Scenario「待手动以暖黄呈现」（desktop-change-doc-views design D14）。
  it("待手动章取手动色、非进行中蓝", () => {
    render(<ChangeCard change={card(1, 0)} />);
    const badge = screen.getByLabelText("待手动");
    expect(badge.className).toContain(SEMANTIC_TONE.manual);
    expect(badge.className).not.toContain(SEMANTIC_TONE.inProgress);
  });

  it("tooltip 载明剩余项数（沿审查标示家族：无原生 title）", () => {
    // Scenario「待手动卡片浮现章」：codeTotal=9、codeComplete=9、total=10、complete=9。
    vi.useFakeTimers();
    render(<ChangeCard change={card(1, 0)} />);
    const badge = screen.getByLabelText("待手动");
    expect(badge.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(badge, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector("[data-side]")?.textContent).toContain("待手动·剩 1 项");
  });

  it("en 章文案为 Awaiting manual（放宽后不提 test）", () => {
    // 语意放宽后两语系的章文案都不得再把 `[M]` 说成只限测试。
    vi.useFakeTimers();
    rtlRender(
      <I18nProvider locale="en">
        <ChangeCard change={card(1, 0)} />
      </I18nProvider>,
    );
    const badge = screen.getByLabelText("Awaiting manual");
    // 与 zh 版同构：无原生 title、tooltip 精确比对（退回 "manual test" 即红灯）。
    expect(badge.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(badge, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector("[data-side]")?.textContent).toContain("Awaiting manual · 1 left");
  });

  it("remote 摘要缺写码进度字段时章缺席", () => {
    // Scenario「remote 模式无章」：缺字段＝数据源不供，不猜、不以全量计数代打。
    render(
      <ChangeCard change={{ name: "c", status: "in-progress", totalTasks: 10, completedTasks: 9 }} />,
    );
    expect(screen.queryByLabelText("待手动")).toBeNull();
  });
});

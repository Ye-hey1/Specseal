// spec desktop-app「已封存页的流程成本摘要」的呈现：四项、每个数字的样本数、
// 繁中与英文文案、没有数据时整个摘要不出现。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import type { ArchivedItem } from "../adapter";
import { I18nProvider, type UiLocale } from "../i18n";
import { ProcessCostSummary } from "../components/ProcessCostSummary";

function item(name: string, fields: Partial<ArchivedItem>): ArchivedItem {
  return { datedName: `2026-10-01-${name}`, date: "2026-10-01", name, ...fields };
}

function renderIn(locale: UiLocale, items: ArchivedItem[]) {
  return render(
    <I18nProvider locale={locale}>
      <ProcessCostSummary items={items} />
    </I18nProvider>,
  ).container;
}

/** 每一格（DocTiles 的砖）的 [大字, 小字]，依呈现顺序。 */
function tiles(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll("[data-process-cost] [data-doc-tile]")].map((tile) => {
    const [value, label] = [...tile.children].map((el) => el.textContent ?? "");
    return [value, label];
  });
}

// Scenario「显示中位数、P90 与样本数」。
const THREE = [
  item("a", { docLines: 100, tasksTotal: 4, leadDays: 0 }),
  item("b", { docLines: 200, tasksTotal: 6, leadDays: 0 }),
  item("c", { docLines: 400, tasksTotal: 9, leadDays: 3 }),
];

const WITH_ROUNDS = [
  item("a", { docLines: 100, tasksTotal: 4, leadDays: 0, leadHours: 6, reviewRounds: 3 }),
  item("b", { docLines: 200, tasksTotal: 6, leadDays: 1, leadHours: 30.5, reviewRounds: 1, verifyRounds: 2 }),
];

describe("ProcessCostSummary", () => {
  it("shows medians as the tile values with P90 and sample counts under a 流程成本（中位数） heading", () => {
    const container = renderIn("zh-CN", THREE);
    expect(container.querySelector("[data-process-cost] h3")!.textContent).toBe("流程成本（中位数）");
    expect(tiles(container)).toEqual([
      ["200", "文档行数（3 笔） · P90 400"],
      ["6", "任务数（3 笔）"],
      ["0 天", "创建到封存（3 笔）"],
    ]);
  });

  it("averages an even sample and pairs every number with its own sample count", () => {
    // Scenario「偶数笔取中间两值平均」＋轮数各自计样本。
    const container = renderIn("zh-CN", WITH_ROUNDS);
    expect(tiles(container).slice(2)).toEqual([
      ["0.5 天 · 18.3 小时", "创建到封存（2／2 笔）"],
      ["审查 2 · 验证 2", "品质关卡轮数（2／1 笔）"],
    ]);
  });

  it("follows the UI language", () => {
    const container = renderIn("en", WITH_ROUNDS);
    expect(container.querySelector("[data-process-cost] h3")!.textContent).toBe("Process cost (median)");
    expect(tiles(container)).toEqual([
      ["150", "Doc lines (2 changes) · P90 200"],
      ["5", "Tasks (2 changes)"],
      ["0.5 days · 18.3 hours", "Created to archived (2 / 2 changes)"],
      ["Review 2 · Verify 2", "Quality gate rounds (2 / 1 changes)"],
    ]);
  });

  it("uses the singular form for a single count of one", () => {
    const container = renderIn("en", [item("only", { docLines: 10, tasksTotal: 3 })]);
    expect(tiles(container)).toEqual([
      ["10", "Doc lines (1 change) · P90 10"],
      ["3", "Tasks (1 change)"],
    ]);
  });

  it("keeps every label short enough for a quarter of the default window", () => {
    // DocTiles 的小字会截断：1440px 缺省窗口扣掉侧栏后每格约 245px，11px 字约 40 个半角字符。
    // 标签超过就会把样本数截掉（spec「每个数字标出样本数」）。
    for (const locale of ["en", "zh-CN"] as const) {
      for (const [, label] of tiles(renderIn(locale, WITH_ROUNDS))) {
        expect(label.length, label).toBeLessThanOrEqual(36);
      }
    }
  });

  it("leaves out the quality gate tile when no change carries rounds", () => {
    // Scenario「旧记录没有轮数时不显示该项」。
    const container = renderIn("zh-CN", THREE);
    expect(tiles(container).map(([, label]) => label).some((l) => l.startsWith("品质关卡轮数"))).toBe(false);
  });

  it("renders nothing without process cost fields", () => {
    // Scenario「没有数据时整个摘要不出现」：没有封存变更，或远程清单只带任务数。
    expect(renderIn("zh-CN", []).innerHTML).toBe("");
    expect(renderIn("zh-CN", [item("remote", { tasksTotal: 4 })]).innerHTML).toBe("");
  });
});

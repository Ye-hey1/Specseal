import type { ArchivedItem } from "./adapter";

/** 一个数字的中位数与样本数（带有该字段的封存变更笔数）。 */
export interface CostStat {
  median: number;
  samples: number;
}

/**
 * 已封存页流程成本摘要的汇总结果（spec desktop-app「已封存页的流程成本摘要」）。
 * 样本数为 0 的数字缺席；没有任何封存变更带流程成本字段时为空对象——远程清单
 * 只带任务数，摘要因此整个不出现。
 */
export interface ProcessCostSummaryData {
  docLines?: CostStat & { p90: number };
  tasks?: CostStat;
  leadDays?: CostStat;
  leadHours?: CostStat;
  reviewRounds?: CostStat;
  verifyRounds?: CostStat;
}

const ascending = (values: number[]) => [...values].sort((a, b) => a - b);

/** 由小到大排序后的中间值；偶数笔取中间两值的平均。 */
export function median(values: number[]): number {
  const sorted = ascending(values);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 由小到大第 ⌈0.9 × n⌉ 个值（整数运算，避开 0.9 × n 的浮点误差）。 */
export function p90(values: number[]): number {
  return ascending(values)[Math.ceil((9 * values.length) / 10) - 1];
}

/** 四舍五入到一位小数——带单位的计数文案（tn）直接吃这个数字。 */
export function roundCost(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 最多一位小数，整数不带小数点。 */
export function formatCost(n: number): string {
  return String(roundCost(n));
}

/** 流程成本字段的单一清单：决定摘要出不出现，也决定摘要有哪些数字。 */
const COST_FIELDS = ["docLines", "leadDays", "leadHours", "reviewRounds", "verifyRounds"] as const;

const stat = (values: number[]): CostStat => ({ median: median(values), samples: values.length });

/** 以全部已封存变更算出摘要的每个数字（调用端不得先套搜索过滤）。缺席的数字不留 key。 */
export function summarizeProcessCost(items: ArchivedItem[]): ProcessCostSummaryData {
  const values = (field: (typeof COST_FIELDS)[number] | "tasksTotal") =>
    items.map((item) => item[field]).filter((v): v is number => v != null);
  const summary: ProcessCostSummaryData = {};
  for (const field of COST_FIELDS) {
    const v = values(field);
    if (v.length === 0) continue;
    if (field === "docLines") summary.docLines = { ...stat(v), p90: p90(v) };
    else summary[field] = stat(v);
  }
  // 没有任何流程成本字段时整个摘要不出现，任务数有样本也一样（远程清单只带任务数）。
  if (Object.keys(summary).length === 0) return {};
  const tasks = values("tasksTotal");
  if (tasks.length > 0) summary.tasks = stat(tasks);
  return summary;
}

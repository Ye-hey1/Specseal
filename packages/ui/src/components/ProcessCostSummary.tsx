import { useMemo } from "react";

import type { ArchivedItem } from "../adapter";
import { useI18n } from "../i18n";
import { formatCost, roundCost, summarizeProcessCost, type CostStat } from "../processCost";
import { DocTiles, type DocTile } from "./DetailShell";
import { Card } from "./ui/card";

/**
 * 已封存页的流程成本摘要（spec desktop-app「已封存页的流程成本摘要」）：唯读，沿用数字砖
 * DocTiles，最多四格——大字是中位数（标题注明），小字是项目名与每个数字的样本数（文档行数
 * 另附 P90）。DocTiles 的小字会截断，所以小字保持精简，样本数才不会被截掉。
 * 没有任何封存变更带流程成本字段时不渲染（远程清单只带任务数）。`items` 是全部封存
 * 变更——页内搜索不影响摘要。
 */
export function ProcessCostSummary({ items }: { items: ArchivedItem[] }) {
  const { t, tn } = useI18n();
  const summary = useMemo(() => summarizeProcessCost(items), [items]);
  if (Object.keys(summary).length === 0) return null;
  const { docLines, tasks, leadDays, leadHours, reviewRounds, verifyRounds } = summary;

  /** 小字：`<项目>（N 笔）`；一格两个数字时为 `<项目>（N／M 笔）`，依大字里数字的顺序。 */
  const label = (itemKey: string, ...stats: (CostStat | undefined)[]) => {
    const counts = stats.filter((s): s is CostStat => s != null).map((s) => s.samples);
    const samples =
      counts.length === 1
        ? tn("archived.cost.samples", counts[0])
        : t("archived.cost.samplesList").replace("{list}", counts.join(t("archived.cost.sampleSep")));
    return t("archived.cost.itemSamples").replace("{label}", t(itemKey)).replace("{samples}", samples);
  };
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");
  const withUnit = (stat: CostStat, unitKey: string) => tn(unitKey, roundCost(stat.median));
  const station = (key: string, stat: CostStat | undefined) =>
    stat && `${t(key)} ${formatCost(stat.median)}`;

  const tiles: DocTile[] = [];
  if (docLines) {
    tiles.push({
      value: formatCost(docLines.median),
      label: join(label("archived.cost.docLines", docLines), `${t("archived.cost.p90")} ${formatCost(docLines.p90)}`),
    });
  }
  if (tasks) tiles.push({ value: formatCost(tasks.median), label: label("archived.cost.tasks", tasks) });
  if (leadDays || leadHours) {
    tiles.push({
      value: join(
        leadDays && withUnit(leadDays, "archived.cost.days"),
        leadHours && withUnit(leadHours, "archived.cost.hours"),
      ),
      label: label("archived.cost.lead", leadDays, leadHours),
    });
  }
  if (reviewRounds || verifyRounds) {
    tiles.push({
      value: join(station("archived.cost.review", reviewRounds), station("archived.cost.verify", verifyRounds)),
      label: label("archived.cost.rounds", reviewRounds, verifyRounds),
    });
  }

  return (
    <Card data-process-cost role="region" aria-label={t("archived.cost.title")} className="shrink-0 px-4 py-3">
      <h3 className="mb-2 text-[13px] font-medium">{t("archived.cost.title")}</h3>
      <DocTiles tiles={tiles} />
    </Card>
  );
}

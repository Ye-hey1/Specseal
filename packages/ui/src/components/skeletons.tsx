// 加载中占位组件（design D4）：以 Skeleton 基元组合出三种形状，模仿其所替代的
// 真实内容轮廓——首访空窗期看得出「有东西正在载」，与真空态文案可区分。
// 全数 aria-busy，且不含任何文本（加载中不冒充空态文案）。
// 同档另收「加载失败」的终态列：它替代的是同一块卡片区，差别在加载已经结束。
import { CloudOff } from "lucide-react";

import { useI18n } from "../i18n";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

/** 看板占位卡：模仿 ChangeCard 的名称列＋进度条轮廓。外框直接用 Card 而非自刻。 */
export function CardSkeleton() {
  return (
    <Card aria-busy="true" size="nested" className="p-3 flex flex-col gap-2">
      <Skeleton className="h-3.5 w-2/3" />
      <Skeleton className="h-2 w-full" />
    </Card>
  );
}

/** 看板栏内的占位卡组：两张足以读出「这栏有内容正在载」，不假装知道实际笔数。 */
export function ColumnSkeleton() {
  return (
    <>
      <CardSkeleton />
      <CardSkeleton />
    </>
  );
}

/** 看板栏内的加载失败终态列（spec「首访加载失败终态呈现」）：读不到 ≠ 确认是
    空的，故取代空态文案；加载已结束，故不是 skeleton（无 aria-busy）。 */
export function ColumnLoadFailed() {
  const { t } = useI18n();
  return (
    <div
      data-testid="column-load-failed"
      role="status"
      className="flex items-start gap-1.5 px-1.5 pt-2 text-xs text-muted-foreground"
    >
      <CloudOff className="h-3.5 w-3.5 shrink-0" />
      <span>{t("kanban.loadFailed")}</span>
    </div>
  );
}

/** 面板占位列：模仿 tray 面板分区内单行变更／讨论列。 */
export function RowSkeleton() {
  return (
    <div aria-busy="true" className="flex items-center gap-2 px-2 py-1.5">
      <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />
      <Skeleton className="h-2.5 w-2/5" />
    </div>
  );
}

/** 文档占位：标题条＋数行内文条，模仿 markdown 文档的段落轮廓。 */
export function DocSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-2 py-2">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

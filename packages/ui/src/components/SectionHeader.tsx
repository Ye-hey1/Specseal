import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export interface SectionHeaderProps {
  icon?: ReactNode;
  label: string;
  /** 项目计数；未给（例如加载中、计数未知）则不出徽章，不谎报 0。 */
  count?: number;
  /** 计数徽章配色（例如生命周期 STAGE_BADGE）；未给为中性（Badge 的 secondary 变体）。 */
  countClassName?: string;
  /** 列尾动作。 */
  action?: ReactNode;
  className?: string;
}

/** 区段标题（spec desktop-app「共用组件唯一来源」；design D8）：xs 粗体灰字一列，计数为徽章。 */
export function SectionHeader({ icon, label, count, countClassName, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs font-semibold text-muted-foreground", className)}>
      {icon}
      {label}
      {count !== undefined && (
        <Badge
          data-testid="section-count"
          className={cn("ml-auto h-5 min-w-5 justify-center px-1.5 font-semibold tabular-nums", countClassName)}
        >
          {count}
        </Badge>
      )}
      {action && <div className={cn("flex items-center", count === undefined && "ml-auto")}>{action}</div>}
    </div>
  );
}

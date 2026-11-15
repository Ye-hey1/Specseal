import type { HTMLAttributes } from "react";

import { cn } from "../lib/utils";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";

/** 严重度色：CRITICAL 破坏色、WARNING 琥珀、SUGGESTION 中性；三红分工（tone.ts 表头）之外
 * 不另立一红。以小写比对——工单写 CRITICAL、分析报告写 Critical，同一级同一色。 */
const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive",
  warning: `${SEMANTIC_SURFACE.warning} ${SEMANTIC_TONE.warning}`,
  suggestion: "bg-muted text-muted-foreground",
};

/** 严重度色章：审查／验证工单、分析面板与 desktop 审查规则页共用同一个组件与尺寸。
 * 缺省显示严重度名称，`children` 可换成「WARNING 3」之类的内容；未知严重度走中性色。 */
export function SeverityTag({
  severity,
  className,
  children,
  ...rest
}: { severity: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium",
        SEVERITY_TONE[severity.toLowerCase()] ?? SEVERITY_TONE.suggestion,
        className,
      )}
    >
      {children ?? severity}
    </span>
  );
}

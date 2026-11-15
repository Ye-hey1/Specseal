import * as React from "react";

import { cn } from "../../lib/utils";

/** 状态签的语意色键：每个 tone 对应一个 theme token，neutral 走中性灰。 */
export type StatusPillTone =
  | "neutral"
  | "primary"
  | "progress"
  | "success"
  | "warning"
  | "destructive"
  | "stamp"
  | "improve"
  | "manual";

/** 以 i18n 键描述的状态签内容：状态对照函数回传它，呈现端以 t(key) 填进 StatusPill。 */
export interface StatusPillLabel {
  key: string;
  tone: StatusPillTone;
}

/* tone → token class：12% 淡底＋本色字。色值只在 theme.css，这里只对照 token。 */
const TONE_CLASS: Record<StatusPillTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary/12 text-primary",
  progress: "bg-status-progress/12 text-status-progress",
  success: "bg-status-success/12 text-status-success",
  warning: "bg-status-warning/12 text-status-warning",
  destructive: "bg-destructive/12 text-destructive",
  stamp: "bg-stamp/12 text-stamp",
  improve: "bg-improve/12 text-improve",
  manual: "bg-status-manual/12 text-status-manual",
};

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusPillTone;
  icon?: React.ReactNode;
}

/** 状态签（design D5）：圆角全圆、语意色淡底深字；详情页的章签、讨论状态签与
   衍生变更阶段签共用。`icon` 置于文本之前。转发 ref 与其余属性，可直接当提示的
   trigger（asChild）。 */
export const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(
  ({ tone, icon, children, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  ),
);
StatusPill.displayName = "StatusPill";

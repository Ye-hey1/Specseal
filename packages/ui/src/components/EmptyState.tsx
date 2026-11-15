import type { ComponentType, ReactNode } from "react";

import { cn } from "../lib/utils";

export interface EmptyStateProps {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  description?: string;
  /** 该页的 primary action（通常为 default 按钮）。 */
  action?: ReactNode;
  /** 只放版面（例如 h-full 填满主区）；外观由组件决定。 */
  className?: string;
}

/** 空状态（spec desktop-app「共用组件唯一来源」；design D8）：置中直栏的图标、标题、
 *  一句说明与动作。桌面零分页引导页与 server web 管理列表共用。 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center", className)}>
      <Icon aria-hidden="true" className="h-10 w-10 text-muted-foreground/40" />
      <h2 className="text-2xl font-normal">{title}</h2>
      {description && <p className="max-w-md text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

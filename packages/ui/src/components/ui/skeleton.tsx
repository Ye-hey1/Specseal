import * as React from "react";

import { cn } from "../../lib/utils";

/** 加载中占位灰块（shadcn 标准基元）。动画逐处加 motion-reduce: 是本 repo 惯例。 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse motion-reduce:animate-none rounded-md bg-muted", className)}
      {...props}
    />
  );
}

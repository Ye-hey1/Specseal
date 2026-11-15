// shadcn/ui tooltip 原语（Radix）——teal 设计系统的一部分。
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../../lib/utils";

// spec「主题化提示统一延迟」：停留延迟的单一缺省在此，个别接口不再自订。
// skipDelay 沿用 Radix 既有行为——连续于多个触发点间移动时第二个起立即显示。
const TooltipProvider = ({
  delayDuration = 300,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
);

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // 白底细框气泡（与浮层同一套）：主色实心气泡会与「已就绪」实心徽章撞色。
        "z-50 overflow-hidden rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-md",
        // Radix Tooltip 打开态的 data-state 是 delayed-open／instant-open（没有 open）：
        // 进场变体要挂这两个值，挂 data-[state=open] 永远不命中、进场动画直接消失。
        "data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

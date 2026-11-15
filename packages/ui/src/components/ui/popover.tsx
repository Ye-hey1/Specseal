// shadcn/ui popover 原语（Radix）——teal 设计系统的一部分。
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { usePortalContainer } from "./portal-container";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, ...props }, ref) => {
  // 在抽屉／对话框内时 portal 进该容器，否则维持 body（见 portal-container.tsx）。
  const container = usePortalContainer();
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // 浮层底色用 bg-card：这份 theme 没有 --popover，上游 shadcn 的 bg-popover
          // 会产出解析不到值的声明，浮层直接变透明。Select 与 Sheet 也是 bg-card。
          "z-50 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-md outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };

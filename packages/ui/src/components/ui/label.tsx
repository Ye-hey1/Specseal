import * as React from "react";

import { cn } from "../../lib/utils";

/** 表单标签。原生 `<label>`（`htmlFor` 已提供点击聚焦与可访问关联，毋需 Radix）。 */
export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none peer-disabled:cursor-default peer-disabled:opacity-70",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

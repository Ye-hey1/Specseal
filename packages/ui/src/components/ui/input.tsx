import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

/** 输入框：8px 圆角；搜索列的全圆胶囊用 shape="pill"。调用端不以 className 覆盖圆角与颜色。 */
const inputVariants = cva(
  "flex h-8 w-full border border-input bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-50",
  {
    variants: { shape: { default: "rounded-lg", pill: "rounded-full" } },
    defaultVariants: { shape: "default" },
  },
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, shape, ...props }, ref) => (
    <input type={type} ref={ref} className={cn(inputVariants({ shape }), className)} {...props} />
  ),
);
Input.displayName = "Input";

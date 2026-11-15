import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const kbdVariants = cva("font-mono text-[11px] tracking-wide", {
  variants: {
    variant: {
      default: "text-muted-foreground",
      /** 跟随所在元素的字色：放在按钮内（如「保存 ⌘S」）。 */
      inherit: "opacity-80",
    },
  },
  defaultVariants: { variant: "default" },
});

/** 键盘快捷键（design D5）：等宽 11px；缺省灰字，给菜单项右端的快捷键槽用；`inherit` 跟随
 *  所在元素的字色，给按钮内的快捷键提示用。 */
function Kbd({
  className,
  variant,
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return <kbd className={cn(kbdVariants({ variant }), className)} {...props} />;
}

/** 菜单项右端的快捷键槽（下拉列表与右键菜单共用）。 */
function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return <Kbd className={cn("ml-auto", className)} {...props} />;
}

export { Kbd, MenuShortcut };

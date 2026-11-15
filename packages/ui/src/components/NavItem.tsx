import type { ReactNode } from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "../lib/utils";

export interface NavItemProps {
  /** 子项变体不传。 */
  icon?: ReactNode;
  label: string;
  /** `sub`：上层分类底下的子项——无图标、28px 高、文本左缘与缺省变体的文本对齐
   *  （左内距 10px＋图标 16px＋间距 8px＝34px）。 */
  variant?: "default" | "sub";
  active?: boolean;
  /** 右端计数徽章（如已封存数）；未给即不渲染。 */
  count?: number;
  /** 标签之后的标记槽（如设置分类项的解析失败警示点）；不并入无障碍名称时由调用端设 aria-hidden。 */
  badge?: ReactNode;
  /** 设置时无障碍名称不被徽章数字污染。 */
  ariaLabel?: string;
  onClick?: () => void;
  /** 渲染成唯一子元素（如路由链接），图标与标签放进子元素内。 */
  asChild?: boolean;
  children?: ReactNode;
  /** 只放版面（如 mt-auto 沉底）。 */
  className?: string;
}

/** 导览项（design D4）：desktop 项目栏与 server-web 管理面导览共用。 */
export function NavItem({
  icon,
  label,
  variant = "default",
  active,
  count,
  badge,
  ariaLabel,
  onClick,
  asChild,
  children,
  className,
}: NavItemProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : "button"}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg text-[13px] transition-colors [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
        variant === "sub" ? "h-7 pl-[34px] pr-2.5" : "h-8 px-2.5",
        active ? "bg-primary/12 font-medium text-primary" : "text-foreground hover:bg-foreground/5",
        className,
      )}
    >
      {variant === "default" && icon}
      {asChild && <Slottable>{children}</Slottable>}
      <span className="truncate">{label}</span>
      {badge}
      {count !== undefined && (
        <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </Comp>
  );
}

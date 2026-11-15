import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind class：clsx 条件组合 + tailwind-merge 消解冲突。shadcn 标准工具。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

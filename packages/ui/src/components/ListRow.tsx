import { useId, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "../lib/utils";
import { CopyButton, REVEAL_ON_HOVER } from "./CopyButton";

interface ListRowBase {
  /** 标题（spec 名、change 名、讨论 slug；缺省等宽）。 */
  title: string;
  /** false 时标题改一般字（人名、项目名）；缺省 true 等宽。 */
  mono?: boolean;
  /** 给了就在标题后紧跟 hover 才显现的拷贝钮：value 写入剪贴板、label 为无障碍名称。 */
  copy?: { value: string; label: string };
  /** 标题下方一行截断的描述列；缺席时列退回单行。 */
  description?: ReactNode;
  /** 最左槽（已封存列的日期）。 */
  leading?: ReactNode;
  /** 右端 meta 槽（计数、徽章、相对时间），› 紧接其后。 */
  meta?: ReactNode;
  /** 不可点的列（规格溯源的无封存记录来源）：灰字、无 hover、无 ›，点击与按键不触发。 */
  disabled?: boolean;
  /** 拷贝钮之后的章（如改进小章）。 */
  children?: ReactNode;
  /** 调用端的 DOM 锚点（data-spec、data-archived…）。 */
  [dataAttr: `data-${string}`]: string | undefined;
}

/** 可点的列与带动作槽的静态列互斥：可点的列是 role=button，槽内再放按钮就成了嵌套交互元素。 */
export type ListRowProps = ListRowBase &
  (
    | { onClick: () => void; actions?: never }
    | {
        /** 不给就是静态列：没有按钮语意、不可聚焦、无 hover 与 ›。 */
        onClick?: never;
        /** 静态列 meta 之后的列尾动作槽（撤销钮）。 */
        actions?: ReactNode;
      }
  );

/**
 * 共用列（spec desktop-app「规格与封存卡片收合信息」；design D1）：整列可点、细线
 * 分隔、hover 微灰、右端 › 收尾。键盘 Enter／Space 触发打开——只认列本体上的按键，
 * 拷贝钮自己的 Enter 不冒成开列；拷贝钮点击由 CopyButton 停止冒泡。列的朗读名称只取
 * 标题（aria-labelledby），不把描述与 meta 串成一长串。不给 onClick 是静态列，可带列尾
 * 动作槽（server-web-list-pages design D1：凭证列、邀请列）。
 */
export function ListRow({
  title,
  mono = true,
  copy,
  description,
  leading,
  meta,
  actions,
  onClick,
  disabled = false,
  children,
  ...dataAttrs
}: ListRowProps) {
  const titleId = useId();
  const clickable = onClick !== undefined;
  const active = clickable && !disabled;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onClick?.();
  };
  return (
    <div
      {...dataAttrs}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? (disabled ? -1 : 0) : undefined}
      aria-labelledby={clickable ? titleId : undefined}
      aria-disabled={(clickable && disabled) || undefined}
      className={cn(
        "group flex items-center gap-4 border-b border-border/70 px-4 py-3 outline-none last:border-b-0",
        disabled && "cursor-default text-muted-foreground",
        active &&
          "cursor-(--cursor-interaction) hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      onClick={active ? onClick : undefined}
      onKeyDown={active ? onKeyDown : undefined}
    >
      {leading !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{leading}</span>
      )}
      <div className="min-w-0 flex-1">
        <div data-title-group className="flex items-center gap-1">
          <span id={titleId} className={cn("min-w-0 truncate text-sm font-semibold", mono && "font-mono")}>
            {title}
          </span>
          {copy && <CopyButton value={copy.value} label={copy.label} className={REVEAL_ON_HOVER} />}
          {children}
        </div>
        {description !== undefined && description !== null && (
          <div data-desc className="truncate text-[13px] text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {meta !== undefined && (
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">{meta}</span>
      )}
      {actions !== undefined && actions !== null && actions !== false && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
      {active && <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </div>
  );
}

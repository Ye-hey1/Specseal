import { useEffect, useRef } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";

import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * 看板搜索工具列（design D5，单列；desktop-board-reskin D4 改为页标题区右端的
 * 280px 全圆输入）：搜索输入带图标、输入非空时的清除钮与即时命中数，＋同高的
 * 32px 筛选开关图标钮（激活中筛选带计数徽章）。
 * 点开关于其下方弹出筛选面板（children，由宿主组装）；再点开关、点面板外或
 * 按 Esc 关闭——关闭不清除已激活筛选。Cmd+F／Ctrl+F 聚焦快捷键。
 * 纯受控组件——query 与面板开阖状态皆在宿主，本组件不持久化。
 */
export function BoardSearchBar({
  query,
  onQuery,
  hitCount,
  filtersOpen,
  onToggleFilters,
  onCloseFilters,
  activeFilterCount = 0,
  children,
  disabledReason,
  onReveal,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** 过滤后各栏卡片总数（仅 query 非空时呈现）。 */
  hitCount: number;
  /** 筛选面板是否打开（宿主状态）。 */
  filtersOpen?: boolean;
  /** 筛选开关钮（未提供时不渲染开关与面板）。 */
  onToggleFilters?: () => void;
  /** 关闭面板（Esc、点面板外）；未提供时退回 onToggleFilters。 */
  onCloseFilters?: () => void;
  /** 激活中的筛选维度数——开关钮上的计数徽章（0＝不显）。 */
  activeFilterCount?: number;
  /** 筛选面板内容（design D5）——三维度菜单与全部清除。 */
  children?: React.ReactNode;
  /** 搜索不可用的说明（remote capability 缺口）：提供时输入 disabled 并以其
   * 文本为 tooltip（title）、聚焦快捷键停用；缺席＝照常。 */
  disabledReason?: string;
  /** 搜索列所在的卡片查看被藏起来时由宿主提供：快捷键与 specseal:focus-search 改调用它（宿主切回
   * 卡片后再聚焦），不去聚焦藏起来的输入。 */
  onReveal?: () => void;
}) {
  const { t, tn } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  // 全域快捷键聚焦：macOS Cmd+F、其他平台 Ctrl+F（spec「快捷键聚焦搜索输入」）。
  // macOS 的 ⌘F 也是这里的 keydown 先收到（preventDefault 后原生菜单不再触发）；原生菜单的
  // 「搜索看板」项目（点击，或不在看板时按 ⌘F）改派 specseal:focus-search。
  useEffect(() => {
    if (disabledReason !== undefined) return; // 停用时快捷键一并不挂。
    const focus = () => (revealRef.current ? revealRef.current() : inputRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        focus();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("specseal:focus-search", focus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("specseal:focus-search", focus);
    };
  }, [disabledReason]);
  // 面板关闭路径：Esc 与点击面板外（开关钮在 popoverRef 内，点它走 toggle 不误关）。
  const close = onCloseFilters ?? onToggleFilters;
  useEffect(() => {
    if (!filtersOpen || !close) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // 面板内的 Select 展开后，菜单被 Radix portal 到 body，DOM 上不在 popoverRef 内。
      // 不排除它的话，选任何一个筛选值都会顺手把整个面板关掉——原生 select 由操作系统
      // 绘制、不产生 DOM 事件，换成 Radix 才浮现这条路径。
      if (target?.closest?.("[data-radix-popper-content-wrapper]")) return;
      if (popoverRef.current && !popoverRef.current.contains(target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [filtersOpen, close]);
  const active = query.trim().length > 0;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        {/* 280px 全圆（design D4）：圆角取 Input 的 pill 变体；命中数与清除钮在右端内侧，
            active 时留 pr-24 给它们（en 三位数命中数也放得下）。 */}
        <Input
          ref={inputRef}
          shape="pill"
          placeholder={t("kanban.searchPlaceholder")}
          value={query}
          disabled={disabledReason !== undefined}
          title={disabledReason}
          onChange={(e) => onQuery(e.target.value)}
          className={`w-[280px] pl-8 text-[13px] ${active ? "pr-24" : "pr-2"}`}
        />
        {active && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <span data-testid="search-hits" className="text-[11px] tabular-nums text-muted-foreground">
              {tn("kanban.hitCount", hitCount)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("kanban.clearSearch")}
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                onQuery("");
                inputRef.current?.focus();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {onToggleFilters && (
        <div ref={popoverRef} className="relative shrink-0">
          {/* 32px 开关图标钮：圆角与展开态底色取 Button 的 toggle 变体（随 aria-expanded）。 */}
          <Button
            type="button"
            variant="toggle"
            size="icon"
            aria-label={t("filter.toggle")}
            aria-expanded={!!filtersOpen}
            onClick={onToggleFilters}
            className="relative"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {filtersOpen && (
            <div
              data-filter-popover
              className="absolute right-0 top-full z-20 mt-1.5 flex w-64 flex-col gap-2.5 rounded-md border border-border bg-card p-3 shadow-md"
            >
              {children}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

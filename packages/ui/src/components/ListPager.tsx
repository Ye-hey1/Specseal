import { useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** 每页笔数默认值（spec「清单最新在前与换页浏览」）——清单组件与测试共用。 */
export const PAGE_SIZE = 20;

/** 每页笔数下拉的选项——也是桌面 store 读回记住的每页笔数时唯一接受的值。 */
export const PAGE_SIZE_OPTIONS: readonly number[] = [20, 50, 100];

/**
 * 清单换页状态（design D2、D7）——规格页与已封存两节共用。页码以 min(rawPage, pageCount)
 * 钳制派生，清单缩短不停在越界页；改每页笔数时把钳制后的页码写回（改回原笔数不弹回旧页）。
 * 每页笔数在值与回呼都给时受控（桌面 store 跨启动记住），否则组件自持（缺省 PAGE_SIZE；
 * server-web 与单元测试走这条）。`pager` 直接展开给 ListPager；换页与改每页笔数后调用
 * onMove（卷回顶部）。`setPage` 只改页码不调用 onMove（搜索重设、聚焦列用）。
 */
export function usePaging<T>(
  items: readonly T[],
  {
    pageSize,
    onPageSizeChange,
    onMove,
  }: { pageSize?: number; onPageSizeChange?: (size: number) => void; onMove: () => void },
) {
  const [rawPage, setPage] = useState(1);
  const [localSize, setLocalSize] = useState(PAGE_SIZE);
  const [size, setSize] =
    pageSize !== undefined && onPageSizeChange !== undefined
      ? [pageSize, onPageSizeChange]
      : [localSize, setLocalSize];
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(rawPage, pageCount);
  const pager: ListPagerProps = {
    page,
    pageCount,
    total: items.length,
    pageSize: size,
    onPage: (next) => {
      setPage(next);
      onMove();
    },
    onPageSize: (next) => {
      setSize(next);
      setPage((p) => Math.min(p, Math.max(1, Math.ceil(items.length / next))));
      onMove();
    },
  };
  return { pageItems: items.slice((page - 1) * size, page * size), setPage, pager };
}

/** 页码窗口要列的页数上限；超过时恒列首尾页、目前页前后各一页，其余以 … 收拢。 */
const FULL_WINDOW = 7;

/**
 * 页码窗口（design D2）：总页数 ≤ 7 全列；否则恒列 1 与 M，中段为 page−1..page+1，
 * 与两端不相邻处插入 "…"。纯函数。
 */
export function pageWindow(page: number, pageCount: number): Array<number | "…"> {
  if (pageCount <= FULL_WINDOW) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pageCount - 1, page + 1);
  const out: Array<number | "…"> = [1];
  if (lo > 2) out.push("…");
  for (let n = lo; n <= hi; n++) out.push(n);
  if (hi < pageCount - 1) out.push("…");
  out.push(pageCount);
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface ListPagerProps {
  /** 目前页码（1 起算）。 */
  page: number;
  /** 总页数。 */
  pageCount: number;
  /** 过滤后总笔数；0 时整条工具列不渲染。 */
  total: number;
  /** 每页笔数（受控，调用端持有）；选项固定为 PAGE_SIZE_OPTIONS。 */
  pageSize: number;
  /** 换页回呼——受控形态，页码状态由调用端持有。 */
  onPage: (next: number) => void;
  /** 改每页笔数回呼；调用端重算总页数并钳制页码。 */
  onPageSize: (size: number) => void;
  /** 窄版（server-web 窄屏幕）：左侧只留范围，右侧只留 ‹「目前页 / 总页数」›。 */
  compact?: boolean;
}

/**
 * 换页工具列（spec「清单最新在前与换页浏览」；design D2：自建受控组件，不采 shadcn
 * Pagination）：上缘自带分隔线；左侧「第 a–b 笔，共 N 笔」＋每页笔数下拉；总页数 > 1
 * 时右侧为 « ‹ 页码 › » 与跳页输入（只认 Enter、越界钳制、非数字忽略；失焦即舍弃输入）。
 * `compact` 收成范围与 ‹ n / m ›（server-web-list-pages design D1）。
 */
export function ListPager({ page, pageCount, total, pageSize, onPage, onPageSize, compact = false }: ListPagerProps) {
  const { t } = useI18n();
  const [jump, setJump] = useState("");
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const range = t("pager.range")
    .replace("{a}", String(first))
    .replace("{b}", String(last))
    .replace("{n}", String(total));
  const perPage = (n: number) => t("pager.perPage").replace("{n}", String(n));
  // 「跳到 {n} 页」拆成输入框前后的两段文本；缺 {n} 时整句在前。
  const [jumpPrefix, jumpSuffix = ""] = t("pager.jumpTo").split("{n}");

  // 跳页提交：空字符串与非数字忽略，其余钳制到 1..pageCount。
  const commitJump = () => {
    if (jump.trim() === "") return;
    const n = Number(jump);
    if (!Number.isFinite(n)) return;
    onPage(clamp(Math.trunc(n), 1, pageCount));
    setJump("");
  };
  const onJumpKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitJump();
  };

  const prev = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t("pager.prev")}
      disabled={page <= 1}
      onClick={() => onPage(page - 1)}
    >
      <ChevronLeft className="h-3.5 w-3.5" />
    </Button>
  );
  const next = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t("pager.next")}
      disabled={page >= pageCount}
      onClick={() => onPage(page + 1)}
    >
      <ChevronRight className="h-3.5 w-3.5" />
    </Button>
  );
  const bar = "flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground";

  if (compact) {
    return (
      <div className={bar}>
        <span className="tabular-nums">{range}</span>
        {pageCount > 1 && (
          <nav className="flex items-center gap-1">
            {prev}
            <span className="tabular-nums">
              {page} / {pageCount}
            </span>
            {next}
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className={bar}>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">{range}</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger aria-label={perPage(pageSize)} className="h-7 w-auto gap-1 text-xs">
            <SelectValue>{perPage(pageSize)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {perPage(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pageCount > 1 && (
        <nav className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("pager.first")}
            disabled={page <= 1}
            onClick={() => onPage(1)}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          {prev}
          {pageWindow(page, pageCount).map((item, i) =>
            item === "…" ? (
              <span key={`gap-${i}`} className="px-1 select-none">
                …
              </span>
            ) : (
              <Button
                key={item}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("pager.pageN").replace("{n}", String(item))}
                aria-current={item === page ? "page" : undefined}
                className={cn("tabular-nums", item === page && "bg-primary/12 font-medium text-primary")}
                onClick={() => onPage(item)}
              >
                {item}
              </Button>
            ),
          )}
          {next}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("pager.last")}
            disabled={page >= pageCount}
            onClick={() => onPage(pageCount)}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
          <label className="ml-2 flex items-center gap-1">
            <span>{jumpPrefix}</span>
            <Input
              type="number"
              min={1}
              max={pageCount}
              aria-label={t("pager.jump")}
              className="h-7 w-[3em] px-1 text-center text-xs"
              value={jump}
              onChange={(e) => setJump(e.target.value)}
              onKeyDown={onJumpKey}
              // 失焦一律舍弃输入、不换页：鼠标按下即失焦、早于点击，此时换页会让这次点击落空；
              // WebKit 点按钮不给焦点（relatedTarget 为 null），无从分辨点的是哪里，所以只认 Enter。
              onBlur={() => setJump("")}
            />
            <span>{jumpSuffix}</span>
          </label>
        </nav>
      )}
    </div>
  );
}

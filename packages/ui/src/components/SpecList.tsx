import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, History } from "lucide-react";

import type { SpecItem } from "../adapter";
import { useI18n } from "../i18n";
import { matchesQuery } from "../search";
import { relativeDays } from "../time";
import { SEMANTIC_TONE } from "../tone";
import { PageHeader } from "./ui/page-header";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { ListCard } from "./ListCard";
import { ListPager, usePaging } from "./ListPager";
import { ListRow } from "./ListRow";
import { SearchField } from "./SearchField";

/** 规格页的缺省顺序：最新在前（modifiedAt 降幂、缺席殿后、同值以名称字母升幂决胜）。
 * 宿主在规格页不是宿主时（手册页开规格详情页）以它排 ‹ › 的串行。 */
export function sortSpecs(specs: SpecItem[]): SpecItem[] {
  return [...specs].sort((a, b) => {
    if (a.modifiedAt && b.modifiedAt && a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
    if (!!a.modifiedAt !== !!b.modifiedAt) return a.modifiedAt ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

/** 规格列（spec「规格与封存卡片收合信息」；design D3）：等宽名称＋拷贝钮、描述列为
 * Purpose 摘要一行截断（占位时改显琥珀「Purpose 待补」警示）、meta 为需求数、溯源
 * 变更数（>0 才显示）与相对修改时间。点整列开唯读规格查看，无行内展开。 */
function SpecRow({ item, onOpen }: { item: SpecItem; onOpen: (capability: string) => void }) {
  const { t, tn } = useI18n();
  const rel = relativeDays(item.modifiedAt, { t, tn });
  const reqCount = item.requirementCount ?? 0;
  const traceCount = item.traceCount ?? 0;
  const reqLabel = tn("specs.requirementCount", reqCount);
  const traceLabel = tn("specs.traceCount", traceCount);
  return (
    <ListRow
      data-spec={item.id}
      title={item.id}
      copy={{ value: item.id, label: t("common.copyName") }}
      description={
        item.purposeTbd ? (
          <span className={`font-medium ${SEMANTIC_TONE.warning}`}>{t("specs.purposeTbd")}</span>
        ) : (
          (item.purposeExcerpt ?? undefined)
        )
      }
      meta={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={reqLabel} className="inline-flex items-center gap-1 tabular-nums">
                <FileText className="h-3 w-3" />
                {reqCount}
              </span>
            </TooltipTrigger>
            <TooltipContent>{reqLabel}</TooltipContent>
          </Tooltip>
          {traceCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={traceLabel} className="inline-flex items-center gap-1 tabular-nums">
                  <History className="h-3 w-3" />
                  {traceCount}
                </span>
              </TooltipTrigger>
              <TooltipContent>{traceLabel}</TooltipContent>
            </Tooltip>
          )}
          {rel && <span className="tabular-nums">{rel}</span>}
        </>
      }
      onClick={() => onOpen(item.id)}
    />
  );
}

export interface SpecListProps {
  specs: SpecItem[];
  /** 点列开唯读规格查看（capability 寻址）。 */
  onOpen: (capability: string) => void;
  /** 外部指定聚焦的 capability（手册出处跳规格）：翻到该列所在页并卷至该列；
   * 搜索字符串遮住它时清空搜索。 */
  focus?: string | null;
  /** 页标题区的标题；缺席时不渲染页标题区，只有搜索框。 */
  title?: string;
  /** 页标题区的灰字说明。 */
  description?: string;
  /** 受控每页笔数（design D7）：与 onPageSizeChange 一起给时以它为准；缺席时组件自持（缺省 20）。 */
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  /** 回报过滤后全部页的 capability 顺序（规格详情页 ‹ › 的串行）；顺序真的变了才回报。 */
  onVisibleOrderChange?: (ids: string[]) => void;
}

/** 规格页（spec「规格页提供清单、搜索与展开查看」；design D3）：页标题区（标题、说明、
 * 右端全圆搜索框——大小写不敏感子字符串、纯前端即打即滤）之下为一张列表卡，一列一份
 * 正式规格；点列开查看，无行内展开、无任何规格写入动词。清单最新在前（modifiedAt
 * 降幂、缺席殿后、名称升幂决胜）并依每页笔数换页（缺省 20；桌面 app 以受控 props
 * 跨启动记住）——排序与换页纯属呈现层。版面填满主区高度：页标题区固定顶部、列于卡内
 * 卷动、工具列固定卡底。 */
export function SpecList({
  specs,
  onOpen,
  focus,
  title,
  description,
  pageSize: controlledPageSize,
  onPageSizeChange,
  onVisibleOrderChange,
}: SpecListProps) {
  const { t } = useI18n();
  // 搜索字符串留组件内——规格页无跨视图保留需求（比对规则共用 matchesQuery）。
  const [query, setQuery] = useState("");
  // 内部卷动容器 ref——换页后归位（清单自己卷、页面不卷）。
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => sortSpecs(specs), [specs]);
  const filtered = sorted.filter((s) => matchesQuery(query, s.id));
  // 呈现顺序回报：以串行内容为依赖，顺序真的变了才通知宿主（换页不影响）。
  const order = filtered.map((s) => s.id);
  const orderKey = JSON.stringify(order);
  useEffect(() => {
    onVisibleOrderChange?.(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);
  const { pageItems, setPage, pager } = usePaging(filtered, {
    pageSize: controlledPageSize,
    onPageSizeChange,
    onMove: () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    },
  });

  useEffect(() => {
    if (!focus) return;
    const visible = filtered.some((s) => s.id === focus);
    const at = (visible ? filtered : sorted).findIndex((s) => s.id === focus);
    if (at < 0) return;
    if (!visible) setQuery("");
    setPage(Math.floor(at / pager.pageSize) + 1);
    // 换页后列才在 DOM：下一帧再卷至该列。
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-spec="${focus}"]`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const search = (
    <SearchField
      value={query}
      placeholder={t("specs.searchPlaceholder")}
      onChange={(value) => {
        setQuery(value);
        setPage(1);
      }}
    />
  );

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 w-full flex-col gap-4">
        {title ? <PageHeader title={title} description={description} actions={search} /> : search}
        <ListCard scrollRef={scrollRef} footer={<ListPager {...pager} />}>
          {specs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t("specs.empty")}</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t("specs.noResults")}</div>
          ) : (
            pageItems.map((s) => <SpecRow key={s.id} item={s} onOpen={onOpen} />)
          )}
        </ListCard>
      </div>
    </TooltipProvider>
  );
}

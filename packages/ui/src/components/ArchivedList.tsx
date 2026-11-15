import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, GitFork, MessageSquareText } from "lucide-react";

import type { ArchivedItem, DiscussionItem } from "../adapter";
import { useI18n } from "../i18n";
import { matchesQuery } from "../search";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { Badge } from "./ui/badge";
import { PageHeader } from "./ui/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import type { ArchivedTarget } from "./ArchivedDetailPage";
import { ImproveStamp } from "./ImproveStamp";
import { isImproveKind } from "./improveStyle";
import { ListCard } from "./ListCard";
import { ListPager, usePaging } from "./ListPager";
import { ListRow } from "./ListRow";
import { ProcessCostSummary } from "./ProcessCostSummary";
import { REVIEW_ICON, REVIEW_LABEL_KEY, REVIEW_TONE } from "./reviewStyle";
import { SearchField } from "./SearchField";
import { VERIFY_ICON, VERIFY_LABEL_KEY, VERIFY_TONE } from "./verifyStyle";

/** 封存变更列（spec「规格与封存卡片收合信息」；design D4）：日期在最左、等宽标题＋
 * 拷贝钮、Why 首句描述列（缺席时列退回单行）、meta 为任务徽章（全完成静默、未全完成
 * 琥珀警示：「没做完就封存」才是需要被看见的异常）、触及规格数、审查／验证结局、
 * createdBy 头像圆点、来源讨论标记。点整列开唯读抽屉。 */
function ArchivedRow({ item, onOpen }: { item: ArchivedItem; onOpen: (target: ArchivedTarget) => void }) {
  const { t, tn } = useI18n();
  const badge =
    item.tasksTotal != null && item.tasksDone != null ? `${item.tasksDone}/${item.tasksTotal}` : null;
  const incomplete = badge != null && item.tasksDone! < item.tasksTotal!;
  const specCount = item.specCount ?? 0;
  const discussions = item.fromDiscussions ?? [];
  const specLabel = tn("archived.specCount", specCount);
  return (
    <ListRow
      data-archived={item.datedName}
      leading={item.date}
      title={item.name}
      copy={{ value: item.datedName, label: t("archived.copyName") }}
      description={item.whyExcerpt}
      meta={
        <>
          {badge && (
            <Badge
              variant="secondary"
              className={`shrink-0 tabular-nums ${
                incomplete ? `${SEMANTIC_SURFACE.warning} ${SEMANTIC_TONE.warning}` : ""
              }`}
            >
              {badge}
            </Badge>
          )}
          {specCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={specLabel} className="inline-flex items-center gap-1 tabular-nums">
                  <Code2 className="h-3 w-3" />
                  {specCount}
                </span>
              </TooltipTrigger>
              <TooltipContent>{specLabel}</TooltipContent>
            </Tooltip>
          )}
          {/* 审查结局标示（spec「已封存侧的审查标示」）：带章＝已审查、化石工单
              ＝曾审查未通过（永久标示）、皆无＝无元素。 */}
          {(item.reviewStatus === "reviewed" || item.reviewStatus === "reviewedNotPassed") && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={t(REVIEW_LABEL_KEY[item.reviewStatus])}
                  className={`shrink-0 ${REVIEW_TONE[item.reviewStatus]}`}
                >
                  {REVIEW_ICON[item.reviewStatus]}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t(REVIEW_LABEL_KEY[item.reviewStatus])}</TooltipContent>
            </Tooltip>
          )}
          {/* 验证结局标示（spec「已封存侧的验证标示」）：与审查结局并存，顺序固定在其后。 */}
          {(item.verifyStatus === "verified" || item.verifyStatus === "verifiedNotPassed") && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={t(VERIFY_LABEL_KEY[item.verifyStatus])}
                  className={`shrink-0 ${VERIFY_TONE[item.verifyStatus]}`}
                >
                  {VERIFY_ICON[item.verifyStatus]}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t(VERIFY_LABEL_KEY[item.verifyStatus])}</TooltipContent>
            </Tooltip>
          )}
          {item.createdBy && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={item.createdBy}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground"
                >
                  {item.createdBy.charAt(0).toUpperCase()}
                </span>
              </TooltipTrigger>
              <TooltipContent>{item.createdBy}</TooltipContent>
            </Tooltip>
          )}
          {discussions.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={t("card.fromDiscussion")} className="shrink-0 text-primary/60">
                  <MessageSquareText className="h-3.5 w-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {t("card.fromDiscussionTitle").replace("{name}", discussions.join(", "))}
              </TooltipContent>
            </Tooltip>
          )}
        </>
      }
      onClick={() => onOpen({ kind: "change", datedName: item.datedName })}
    />
  );
}

/** 封存讨论列（design D4）：slug 为等宽标题＋拷贝 slug 钮、改进小章在标题旁、topic 降为
 * 描述列；meta 为日期、「N 轮」、衍生变更数（自既有 promotedTo 长度派生）——与看板讨论卡
 * 同构（slug 为 CLI 动词把手；LANGUAGE.md 受控例外）。点整列开唯读抽屉。 */
function ArchivedDiscussionRow({
  item,
  onOpen,
}: {
  item: DiscussionItem;
  onOpen: (target: ArchivedTarget) => void;
}) {
  const { t, tn } = useI18n();
  const promoted = item.promotedTo.length;
  const promotedLabel = tn("archived.promotedCount", promoted);
  return (
    <ListRow
      data-archived-discussion={item.slug}
      title={item.slug}
      copy={{ value: item.slug, label: t("discussion.copySlug") }}
      description={item.topic}
      meta={
        <>
          <span className="tabular-nums">{item.created}</span>
          <span className="tabular-nums">{tn("common.rounds", item.rounds)}</span>
          {promoted > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={promotedLabel} className="inline-flex items-center gap-1 tabular-nums">
                  <GitFork className="h-3 w-3" />
                  {promoted}
                </span>
              </TooltipTrigger>
              <TooltipContent>{promotedLabel}</TooltipContent>
            </Tooltip>
          )}
        </>
      }
      onClick={() => onOpen({ kind: "discussion", slug: item.slug })}
    >
      {/* 改进小章：封存后标示不变（spec「已封存的改进讨论维持标示」）。 */}
      {isImproveKind(item.kind) && <ImproveStamp />}
    </ListRow>
  );
}

export interface ArchivedListProps {
  archived: ArchivedItem[];
  query: string;
  onQuery: (q: string) => void;
  /** 封存讨论（讨论节；缺席时不显示该节，向后兼容）。 */
  archivedDiscussions?: DiscussionItem[];
  /** 点列开唯读封存抽屉（discriminated target：封存变更或封存讨论）。 */
  onOpen: (target: ArchivedTarget) => void;
  /** 页标题区的标题；缺席时不渲染页标题区，只有搜索框。 */
  title?: string;
  /** 页标题区的灰字说明。 */
  description?: string;
  /** 受控每页笔数（design D7），两节各自一组：值与回呼一起给时以它为准；缺席时组件自持（缺省 20）。 */
  changesPageSize?: number;
  onChangesPageSizeChange?: (size: number) => void;
  discussionsPageSize?: number;
  onDiscussionsPageSizeChange?: (size: number) => void;
  /** 回报两节各自过滤后全部页的顺序（已封存详情页 ‹ › 的串行）；顺序真的变了才回报。 */
  onVisibleOrderChange?: (order: { changes: string[]; discussions: string[] }) => void;
}

type Section = "changes" | "discussions";

const EMPTY_CLS = "py-8 text-center text-sm text-muted-foreground";

/** 已封存页（spec「已封存页含讨论节」；design D4）：页标题区（标题、说明、右端全圆
 * 搜索框）之下为一张列表卡，卡顶为卡片标头式分页「变更」「讨论」各带过滤后笔数徽章；
 * 两节皆为列式清单、点列开抽屉、无行内展开；搜索同时过滤两节、两节页码与每页笔数
 * 互相独立（spec「清单最新在前与换页浏览」）。清单最新在前：封存变更依 datedName
 * 字典序降幂、封存讨论依 created 降幂同日 slug 升幂；archivedDiscussions 缺席（向后
 * 兼容路径）时分页列缺席、列表卡维持完整圆角。版面填满主区高度：页标题区与分页列
 * 固定、列于卡内卷动、工具列固定卡底。 */
export function ArchivedList({
  archived,
  query,
  onQuery,
  archivedDiscussions,
  onOpen,
  title,
  description,
  changesPageSize,
  onChangesPageSizeChange,
  discussionsPageSize,
  onDiscussionsPageSizeChange,
  onVisibleOrderChange,
}: ArchivedListProps) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("changes");
  // 两节共用列表卡的卷动容器——换页后归位（清单自己卷、页面不卷）。
  const scrollRef = useRef<HTMLDivElement>(null);
  const resetScroll = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  // datedName 前缀 YYYY-MM-DD 使字典序＝时间序，降幂即封存日期新→旧（同日由字符串降幂涵盖）。
  const sortedChanges = useMemo(
    () => [...archived].sort((a, b) => (a.datedName < b.datedName ? 1 : a.datedName > b.datedName ? -1 : 0)),
    [archived],
  );
  // created 降幂；同日以 slug 字母升幂决胜。
  const sortedDiscussions = useMemo(
    () =>
      [...(archivedDiscussions ?? [])].sort((a, b) => {
        if (a.created !== b.created) return a.created < b.created ? 1 : -1;
        return a.slug.localeCompare(b.slug);
      }),
    [archivedDiscussions],
  );

  // 比对规则共用 matchesQuery（与看板一致的单一真相）。
  const filtered = sortedChanges.filter((a) => matchesQuery(query, a.name));
  const discussions = sortedDiscussions.filter((d) => matchesQuery(query, d.topic, d.slug));
  const showDiscussions = archivedDiscussions !== undefined;
  // 呈现顺序回报：以两节串行内容为依赖，顺序真的变了才通知宿主（换页、切子页签不影响）。
  const changeOrder = filtered.map((a) => a.datedName);
  const discussionOrder = discussions.map((d) => d.slug);
  const orderKey = JSON.stringify([changeOrder, discussionOrder]);
  useEffect(() => {
    onVisibleOrderChange?.({ changes: changeOrder, discussions: discussionOrder });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // 两节页码与每页笔数互相独立。
  const changes = usePaging(filtered, {
    pageSize: changesPageSize,
    onPageSizeChange: onChangesPageSizeChange,
    onMove: resetScroll,
  });
  const discs = usePaging(discussions, {
    pageSize: discussionsPageSize,
    onPageSizeChange: onDiscussionsPageSizeChange,
    onMove: resetScroll,
  });
  const { setPage: setChangePage } = changes;
  const { setPage: setDiscPage } = discs;

  // 搜索字符串变更（query 为外部受控 prop）：两侧页码皆回第 1 页。
  useEffect(() => {
    setChangePage(1);
    setDiscPage(1);
  }, [query, setChangePage, setDiscPage]);

  // 两节的工具列落在同一个卡底槽：各带 key，切换分页时不共用跳页输入的状态。
  const changesPager = <ListPager key="changes" {...changes.pager} />;
  const discussionsPager = <ListPager key="discussions" {...discs.pager} />;

  const changesRows =
    filtered.length === 0 ? (
      <div className={EMPTY_CLS}>{t("archived.noChanges")}</div>
    ) : (
      changes.pageItems.map((a) => <ArchivedRow key={a.datedName} item={a} onOpen={onOpen} />)
    );

  const search = (
    <SearchField value={query} placeholder={t("archived.searchPlaceholder")} onChange={onQuery} />
  );

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 w-full flex-col gap-4">
        {title ? <PageHeader title={title} description={description} actions={search} /> : search}
        {/* 流程成本摘要：页标题区与列表卡之间，以全部封存变更计算（不受搜索影响）。 */}
        <ProcessCostSummary items={archived} />
        {showDiscussions ? (
          <Tabs
            value={section}
            onValueChange={(v) => {
              setSection(v as Section);
              resetScroll();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <ListCard
              scrollRef={scrollRef}
              header={
                <TabsList variant="card">
                  <TabsTrigger value="changes" count={filtered.length}>
                    {t("archived.changesHeading")}
                  </TabsTrigger>
                  <TabsTrigger value="discussions" count={discussions.length}>
                    {t("archived.discussionsHeading")}
                  </TabsTrigger>
                </TabsList>
              }
              footer={section === "changes" ? changesPager : discussionsPager}
            >
              <TabsContent value="changes">{changesRows}</TabsContent>
              <TabsContent value="discussions">
                {discussions.length === 0 ? (
                  <div className={EMPTY_CLS}>{t("archived.noDiscussions")}</div>
                ) : (
                  discs.pageItems.map((d) => <ArchivedDiscussionRow key={d.slug} item={d} onOpen={onOpen} />)
                )}
              </TabsContent>
            </ListCard>
          </Tabs>
        ) : (
          // 向后兼容路径：无讨论清单数据，列表卡不带分页列、只有变更清单。
          <ListCard scrollRef={scrollRef} footer={changesPager}>
            {changesRows}
          </ListCard>
        )}
      </div>
    </TooltipProvider>
  );
}

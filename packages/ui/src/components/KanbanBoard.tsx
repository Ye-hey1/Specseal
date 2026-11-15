import { useEffect, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, CircleCheckBig, Hammer, Lightbulb } from "lucide-react";

import type { ArchivedItem, CardKind, ChangeItem, DiscussionLists, SearchHit } from "../adapter";
import {
  archiveZoneVisible,
  cardDndId,
  parseCardDndId,
  invalidDropTargets,
  resolveCardDrop,
  type ColumnCards,
} from "../boardDnd";
import { useI18n } from "../i18n";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import {
  EMPTY_FILTERS,
  matchesFilters,
  matchesFuzzy,
  matchesQuery,
  type BoardFilters,
} from "../search";
import { changeStage, STAGE_BADGE, STAGE_BAR, STAGE_ICON, STAGES, type Stage } from "../stage";
import { BoardColumn, type ColumnTone } from "./BoardColumn";
import { BoardSearchBar } from "./BoardSearchBar";
import { PageHeader } from "./ui/page-header";
import { ChangeCard } from "./ChangeCard";
import { ColumnLoadFailed, ColumnSkeleton } from "./skeletons";
import {
  DiscussionCard,
  DiscussionColumn,
  isCollapsedPromoted,
  type PromotedExpansionProps,
} from "./DiscussionColumn";
import { Button } from "./ui/button";
import { SELECT_ALL, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** 移动 8px 才视为拖曳——否则 dnd-kit 会吃掉单纯点击，导致卡片无法打开详情。 */
export const DRAG_ACTIVATION_DISTANCE = 8;

/** 各阶段的视觉主题——每阶一色相，全部取 stage.ts 的 stage-* token 对照；
 *  栏顶色相条与卡片进度条同用 bar（纯 bg-stage-*）。 */
const STAGE_STYLE: Record<Stage, ColumnTone> = {
  proposed: {
    icon: Lightbulb,
    badge: STAGE_BADGE.proposed,
    bar: STAGE_BAR.proposed,
    iconCls: STAGE_ICON.proposed,
  },
  "in-progress": {
    icon: Hammer,
    badge: STAGE_BADGE["in-progress"],
    bar: STAGE_BAR["in-progress"],
    iconCls: STAGE_ICON["in-progress"],
  },
  ready: {
    icon: CircleCheckBig,
    badge: STAGE_BADGE.ready,
    bar: STAGE_BAR.ready,
    iconCls: STAGE_ICON.ready,
  },
};

interface KanbanBoardBaseProps {
  changes: ChangeItem[];
  onOpenChange?: (name: string) => void;
  /** 封存请求：ready 卡的封存钮与拖曳落点皆经此触发（app 端接确认流程）。 */
  onArchive?: (name: string) => void;
  /** 退回提案中请求：派生进行中卡的退回钮经此触发（app 端接确认流程）。 */
  onRevert?: (name: string) => void;
  /** 讨论清单；提供时看板扩为四栏，active 进第 0 栏（封存讨论不上板）。 */
  discussions?: DiscussionLists;
  /** 已封存 change 清单（衍生树细列的已封存态派生）。 */
  archivedChanges?: ArchivedItem[];
  onOpenDiscussion?: (slug: string) => void;
  /** concluded 讨论卡的归档动词（app 端接确认流程）。转为变更已自 GUI 撤除。 */
  onArchiveDiscussion?: (slug: string) => void;
  /** 看板搜索字符串（选配，与 onQuery 成对提供时渲染搜索输入并过滤卡片）。 */
  query?: string;
  onQuery?: (q: string) => void;
  /** 全文搜索不可用的说明（remote capability 缺口）：提供时搜索输入 disabled
   * 并以其文本为 tooltip（title）；缺席＝照常（本地不受影响）。 */
  searchUnavailableReason?: string;
  /** 卡片查看被藏起来（看板页正显示路线图）时由宿主提供：搜索快捷键与「搜索看板」改调用它，
   * 由宿主切回卡片再聚焦，不去聚焦藏起来的输入。 */
  onRevealSearch?: () => void;
  /** workspace 全文查找命中（design D6）：命中卡片并入可见集合并呈 snippet 行。 */
  fulltextHits?: SearchHit[];
  /**
   * 栏内拖排写回（design D5/D6）：同栏放开时以 arrayMove 后的前后邻居回报
   * （null＝栏顶／栏底）；未提供时卡片不挂 sortable（封存拖放照旧）。
   */
  onReorder?: (kind: CardKind, id: string, prevId: string | null, nextId: string | null) => void;
  /** 拖排不可用时的用户可见说明；文本由宿主依 capability 与语系提供。 */
  reorderUnavailableReason?: string;
  /** 清单 payload 的顶层 planError（spec「依赖成环时看板提示」）：非 null 时字段
   * 上方一行「依赖成环：」＋原文；卡片因字段缺席自然无波次章，拖排照常。 */
  planError?: string | null;
  /** 拖曳手势期间（按住～放开）回报 true——宿主据此让外部刷新让路（任务列同款）。 */
  onDragActiveChange?: (active: boolean) => void;
  /** 首访 workspace 的整批加载未完成：各栏以占位卡呈现，栏名照常、不出空态文案。
   * 已有旧缓存时为 false——旧数据照常显示、刷新完成静默换新（design D2）。 */
  loading?: boolean;
  /** 首访整批加载以失败收场：各栏卡片区显示加载失败提示，取代空态文案。
   * 读不到 ≠ 确认是空的；loading 为真时不生效（重试在途，先画骨架）。 */
  loadFailed?: boolean;
  /** 页标题（design D6）：提供时以页标题区包住搜索列（搜索与筛选在标题同一列右端）；
   * 缺席＝搜索列照旧单独一列。 */
  title?: string;
  description?: string;
  /** 页眉的「看板｜路线图」切换（宿主给 BoardViewSwitch）：放在页眉最右端、搜索列之后——
   * 路线图的页眉只有这个切换，两种查看的切换才停在同一个位置。 */
  viewSwitch?: ReactNode;
  /** 看板目前呈现顺序（含搜索与筛选；design D2）——详情页 ‹ n／m › 与 ⌥↑／⌥↓ 的串行。
   * 变更依栏序（提案中 → 进行中 → 已就绪）再依栏内顺序；讨论为上区全卡依序、其后接
   * 栏底「已转出」细列（不论收合）。顺序改变时才回报。 */
  onVisibleOrderChange?: (order: { changes: string[]; discussions: string[] }) => void;
}

/** 另含讨论栏底「已转出」收合列的展开状态（design D2）：同名透传 DiscussionColumn——
 * 两者同进同出时受控（桌面 app 跨启动保留），皆缺席时栏内部状态、不持久化。 */
export type KanbanBoardProps = KanbanBoardBaseProps & PromotedExpansionProps;

/**
 * 拖曳变更卡时才浮现的封存落点（design D8）：绝对定位浮层叠于看板右缘上方、
 * 不参与栏列布局——浮现与消失时栏宽零变动。外观只取 theme token（主色虚线框
 * ＋主色淡底，isOver 时底色加深；desktop-board-reskin D3）。
 */
function ArchiveDropZone() {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: "archived" });
  return (
    <div
      ref={setNodeRef}
      data-column="archived"
      className={`absolute inset-y-2 right-2 z-10 flex w-[120px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/60 text-primary transition-colors ${
        isOver ? "bg-primary/20" : "bg-primary/10"
      }`}
    >
      <Archive className="h-5 w-5" />
      <span className="text-xs font-medium">{t("kanban.dropToArchive")}</span>
    </div>
  );
}

function SortableCard({
  change,
  barClass,
  highlight,
  hit,
  invalidTarget,
  ...rest
}: {
  change: ChangeItem;
  barClass: string;
  highlight?: string;
  hit?: SearchHit;
  /** 拖动中此卡为不合法落点（会跨越声明依赖）：降透明度并标 data-drop-invalid。 */
  invalidTarget?: boolean;
} & Pick<KanbanBoardProps, "onOpenChange" | "onArchive" | "onRevert">) {
  const { t } = useI18n();
  // 拖曳时原卡片留在原位变淡；移动的视觉由 DragOverlay 呈现（不受字段 overflow 裁切）。
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardDndId("change", change.name),
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.35 } : invalidTarget ? { opacity: 0.4 } : undefined),
      }}
      {...attributes}
      {...listeners}
      aria-label={t("kanban.dragCard").replace("{name}", change.name)}
      data-drop-invalid={invalidTarget ? "true" : undefined}
    >
      <ChangeCard
        change={change}
        barClass={barClass}
        highlight={highlight}
        hit={hit}
        onOpen={rest.onOpenChange}
        onArchive={rest.onArchive}
        onRevert={rest.onRevert}
      />
    </div>
  );
}

/** 依赖成环的提示：看板的卡片查看与路线图共用同一个（含引擎的成环消息）。 */
export function PlanCycleNote({ planError }: { planError: string }) {
  const { t } = useI18n();
  return (
    <div role="note" className={`rounded-md border px-3 py-2 text-xs ${SEMANTIC_SURFACE.warning} ${SEMANTIC_TONE.warning}`}>
      {t("board.planCycle")}
      {planError}
    </div>
  );
}

/**
 * 生命周期看板：讨论（第 0 栏，传入 discussions 时）＋提案中／进行中／已就绪
 * 三栏（彩色主题）；栏内拖排（onReorder 提供时）、拖曳时浮现封存落点。
 */
export function KanbanBoard({
  changes,
  onOpenChange,
  onArchive,
  onRevert,
  discussions,
  archivedChanges,
  onOpenDiscussion,
  onArchiveDiscussion,
  query,
  onQuery,
  fulltextHits,
  searchUnavailableReason,
  onRevealSearch,
  onReorder,
  reorderUnavailableReason,
  planError,
  onDragActiveChange,
  loading,
  loadFailed,
  title,
  description,
  viewSwitch,
  onVisibleOrderChange,
  ...promotedExpansion
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const { t } = useI18n();
  // 加载中优先于失败提示：重试在途时先画骨架，不留上一轮的失败残影。
  const failed = !loading && !!loadFailed;
  // 搜索过滤（spec「看板搜索过滤卡片」）：变更卡以名称与摘要、讨论卡以主题与
  // slug 比对；比对规则共用 matchesQuery（与已封存页一致）。空（或仅空白）即全量。
  // 筛选 chips（design D5）：组件 local、不持久化；与搜索字符串 AND 交集。
  const showSearch = query !== undefined && onQuery !== undefined;
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  // 筛选 chips 的展开状态（design D5）：缺省收合、不持久化；激活中维度数供开关钮徽章。
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = [filters.createdBy, filters.createdWithin, filters.fromDiscussion].filter(
    (v) => v !== null,
  ).length;
  const today = new Date().toISOString().slice(0, 10);
  // 三层比对任一命中即显示（spec）：字段子字符串、名称层 fuzzy（仅名称／slug，
  // design D7）、全文命中集合（design D6）——再与筛选 chips 取 AND。
  const q = query ?? "";
  const hitByCard = new Map((fulltextHits ?? []).map((h) => [`${h.kind}:${h.id}`, h]));
  const visibleChanges = changes.filter(
    (c) =>
      (matchesQuery(q, c.name, c.summary) ||
        matchesFuzzy(q, c.name) ||
        hitByCard.has(`change:${c.name}`)) &&
      matchesFilters(filters, c, today),
  );
  const visibleDiscussions = discussions?.active.filter(
    (d) =>
      (matchesQuery(q, d.topic, d.slug) ||
        matchesFuzzy(q, d.slug) ||
        hitByCard.has(`discussion:${d.slug}`)) &&
      matchesFilters(filters, d, today),
  );
  // chip 选项自现有清单派生：创建者去重、来源讨论取 promoted_to 非空者。
  const creators = Array.from(
    new Set(
      [...changes.map((c) => c.createdBy), ...(discussions?.active ?? []).map((d) => d.createdBy)].filter(
        (x): x is string => !!x,
      ),
    ),
  );
  const sourceDiscussions = (discussions?.active ?? []).filter((d) => d.promotedTo.length > 0);
  const byStage: Record<Stage, ChangeItem[]> = { proposed: [], "in-progress": [], ready: [] };
  for (const c of visibleChanges) byStage[changeStage(c)].push(c);
  // 就绪名单自全清单派生（不经搜索过滤）：落点浮现与 dragEnd 的 archived 分支
  // 共用同一判定（archive-readiness-gating D3）。
  const readyIds: ReadonlySet<string> = new Set(
    changes.filter((c) => changeStage(c) === "ready").map((c) => c.name),
  );
  const dragging = activeId !== null;
  const activeCard = activeId ? parseCardDndId(activeId) : null;
  const activeChange =
    activeCard?.kind === "change" ? changes.find((c) => c.name === activeCard.id) ?? null : null;
  const activeDiscussion =
    activeCard?.kind === "discussion"
      ? discussions?.active.find((d) => d.slug === activeCard.id) ?? null
      : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  );

  // 呈现顺序回报（design D2）：以串行内容为依赖，顺序真的变了才通知宿主。
  const changeOrder = STAGES.flatMap((stage) => byStage[stage].map((c) => c.name));
  const discussionOrder = visibleDiscussions
    ? [
        ...visibleDiscussions.filter((d) => !isCollapsedPromoted(d)),
        ...visibleDiscussions.filter(isCollapsedPromoted),
      ].map((d) => d.slug)
    : [];
  const orderKey = JSON.stringify([changeOrder, discussionOrder]);
  useEffect(() => {
    onVisibleOrderChange?.({ changes: changeOrder, discussions: discussionOrder });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // 落点解析输入：每栏「可见」卡的识别码（视觉序）——搜索过滤中拖排沿同一语意
  //（spec：新键介于可见前后邻居之间）。讨论栏只有全卡参与（promoted 收合列不拖）。
  const columns: ColumnCards[] = [
    ...(visibleDiscussions
      ? [
          {
            kind: "discussion" as const,
            ids: visibleDiscussions.filter((d) => !isCollapsedPromoted(d)).map((d) => d.slug),
          },
        ]
      : []),
    ...STAGES.map((stage) => ({ kind: "change" as const, ids: byStage[stage].map((c) => c.name) })),
  ];

  // 不合法落点（spec「拖排时不合法落点灰化」；design D3 前端层）：只用声明依赖
  // ——payload 缺 dependsOn（remote、plan 成环）时集合为空，判定归 boardDnd 纯函数。
  // 同栏全序自全清单派生（不经搜索过滤，与 readyIds 同款）：被过滤隐藏的前置仍决定
  // 其上方位置不合法，集合只多含隐藏卡、不影响可见卡的标记。
  const invalidTargets: ReadonlySet<string> = (() => {
    // 成环时没有可信的顺序可守（spec：planError 非 null 时无不合法落点）。
    if (!activeChange || planError) return new Set<string>();
    const stage = changeStage(activeChange);
    const column: ColumnCards = {
      kind: "change",
      ids: changes.filter((c) => changeStage(c) === stage).map((c) => c.name),
    };
    const deps = new Map(changes.map((c) => [c.name, c.dependsOn ?? []]));
    return invalidDropTargets(column, deps, activeChange.name);
  })();

  const handleDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    onDragActiveChange?.(true);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    // 放开即结束手势；同一事件内 onReorder 使宿主写回＋refresh，让路无缝接手。
    onDragActiveChange?.(false);
    if (!e.over) return;
    const over = String(e.over.id);
    const active = String(e.active.id);
    if (over === "archived") {
      // 落点不可见时理论上不会 over，就绪判定守住快速手势与测试路径（D3）。
      const card = parseCardDndId(active);
      if (card?.kind === "change" && readyIds.has(card.id)) onArchive?.(card.id);
      return;
    }
    // 同栏放开才写回；跨栏、栏容器、原位一律 null → 弹回、零写入。
    const drop = resolveCardDrop(columns, active, over);
    if (!drop) return;
    // 放开于不合法落点：卡片回到原位、零写回（引擎另守一次）。
    if (drop.kind === "change" && invalidTargets.has(parseCardDndId(over)?.id ?? "")) return;
    onReorder?.(drop.kind, drop.id, drop.prevId, drop.nextId);
  };

  const searchBar = showSearch && (
    <BoardSearchBar
      query={query}
      onQuery={onQuery}
      disabledReason={searchUnavailableReason}
      onReveal={onRevealSearch}
      hitCount={visibleChanges.length + (visibleDiscussions?.length ?? 0)}
      filtersOpen={filtersOpen}
      onToggleFilters={() => setFiltersOpen((v) => !v)}
      onCloseFilters={() => setFiltersOpen(false)}
      activeFilterCount={activeFilterCount}
    >
      {/* 筛选面板内容（design D5）：三维度菜单直栏堆栈，选回「全部」即单独清除。 */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("filter.createdBy")}</span>
        <Select
          value={filters.createdBy ?? SELECT_ALL}
          onValueChange={(v) =>
            setFilters({ ...filters, createdBy: v === SELECT_ALL ? null : v })
          }
        >
          <SelectTrigger aria-label={t("filter.createdBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_ALL}>{t("filter.all")}</SelectItem>
            {creators.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("filter.createdWithin")}</span>
        <Select
          value={filters.createdWithin ?? SELECT_ALL}
          onValueChange={(v) =>
            setFilters({
              ...filters,
              createdWithin: (v === SELECT_ALL
                ? null
                : v) as BoardFilters["createdWithin"],
            })
          }
        >
          <SelectTrigger aria-label={t("filter.createdWithin")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_ALL}>{t("filter.all")}</SelectItem>
            <SelectItem value="7d">{t("filter.range7d")}</SelectItem>
            <SelectItem value="30d">{t("filter.range30d")}</SelectItem>
            <SelectItem value="earlier">{t("filter.rangeEarlier")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("filter.fromDiscussion")}</span>
        <Select
          value={filters.fromDiscussion ?? SELECT_ALL}
          onValueChange={(v) =>
            setFilters({ ...filters, fromDiscussion: v === SELECT_ALL ? null : v })
          }
        >
          <SelectTrigger aria-label={t("filter.fromDiscussion")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECT_ALL}>{t("filter.all")}</SelectItem>
            {sourceDiscussions.map((d) => (
              <SelectItem key={d.slug} value={d.slug}>
                {d.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {activeFilterCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 justify-center text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setFilters(EMPTY_FILTERS)}
        >
          {t("filter.clearAll")}
        </Button>
      )}
    </BoardSearchBar>
  );

  const headerActions =
    viewSwitch || searchBar ? (
      <>
        {searchBar}
        {viewSwitch}
      </>
    ) : undefined;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        onDragActiveChange?.(false);
      }}
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
      {reorderUnavailableReason && (
        <div
          role="note"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          {reorderUnavailableReason}
        </div>
      )}
      {planError && <PlanCycleNote planError={planError} />}
      {title ? (
        <PageHeader title={title} description={description} actions={headerActions} />
      ) : (
        headerActions
      )}
      {/* relative wrapper 供封存落点浮层锚定于「可视」右缘（design D8）——浮层
          在卷动容器之外、不进 flex 流，栏宽零变动且不随水平卷动漂移。 */}
      <div className="relative flex-1 min-h-0">
      {/* 等宽 grid 填满主区（design D1）：栏最小 220px，再窄才水平卷动；讨论栏缺席时三栏。
          relative：栏内 absolute 元素至少被 grid 裁切，不落到外层 wrapper 撑高主区。 */}
      <div
        className={`relative grid h-full min-h-0 gap-3 overflow-x-auto ${
          discussions
            ? "grid-cols-[repeat(4,minmax(220px,1fr))]"
            : "grid-cols-[repeat(3,minmax(220px,1fr))]"
        }`}
      >
        {discussions && (
          <DiscussionColumn
            discussions={visibleDiscussions ?? []}
            changes={changes}
            archived={archivedChanges ?? []}
            onOpenDiscussion={onOpenDiscussion}
            onArchiveDiscussion={onArchiveDiscussion}
            sortable={!!onReorder}
            highlight={q}
            fulltextHits={fulltextHits}
            loading={loading}
            loadFailed={failed}
            {...promotedExpansion}
          />
        )}
        {STAGES.map((stage) => (
          <BoardColumn
            key={stage}
            id={stage}
            title={t(`stage.${stage}`)}
            tone={STAGE_STYLE[stage]}
            count={loading || failed ? null : byStage[stage].length}
            // 空栏（过滤后零卡且非加载中／失败）：置中灰字；搜索无命中时同样显示。
            empty={
              !loading && !failed && byStage[stage].length === 0
                ? t(`board.emptyColumn.${stage}`)
                : null
            }
          >
            {loading ? (
              <ColumnSkeleton />
            ) : failed ? (
              <ColumnLoadFailed />
            ) : onReorder ? (
              <SortableContext
                items={byStage[stage].map((c) => cardDndId("change", c.name))}
                strategy={verticalListSortingStrategy}
              >
                {byStage[stage].map((c) => (
                  <SortableCard
                    key={c.name}
                    change={c}
                    barClass={STAGE_STYLE[stage].bar}
                    highlight={q}
                    hit={hitByCard.get(`change:${c.name}`)}
                    invalidTarget={invalidTargets.has(c.name)}
                    onOpenChange={onOpenChange}
                    onArchive={onArchive}
                    onRevert={onRevert}
                  />
                ))}
              </SortableContext>
            ) : (
              byStage[stage].map((c) => (
                <ChangeCard
                  key={c.name}
                  change={c}
                  barClass={STAGE_STYLE[stage].bar}
                  highlight={q}
                  hit={hitByCard.get(`change:${c.name}`)}
                  onOpen={onOpenChange}
                  onArchive={onArchive}
                  onRevert={onRevert}
                />
              ))
            )}
          </BoardColumn>
        ))}
      </div>
      {/* 仅拖曳已就绪变更卡时浮现（archiveZoneVisible）：非就绪卡＝纯排序、
          讨论卡不可封存，皆不得造成布局变动。 */}
      {dragging && archiveZoneVisible(activeId, readyIds) && <ArchiveDropZone />}
      </div>
      </div>
      {/* 拖曳浮动复本：渲染在最上层，不受字段 overflow 裁切 */}
      <DragOverlay dropAnimation={null}>
        {activeChange ? (
          <div className="rounded-xl shadow-lg rotate-2 cursor-grabbing">
            <ChangeCard change={activeChange} barClass={STAGE_STYLE[changeStage(activeChange)].bar} />
          </div>
        ) : activeDiscussion ? (
          <div className="rounded-xl shadow-lg rotate-2 cursor-grabbing">
            <DiscussionCard d={activeDiscussion} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

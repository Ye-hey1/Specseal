import { useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ChevronRight, MessageSquareText } from "lucide-react";

import type { ArchivedItem, ChangeItem, DiscussionItem, SearchHit } from "../adapter";
import { cardDndId } from "../boardDnd";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { changeStage, DISCUSSION_TONE, STAGE_BADGE } from "../stage";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { Button } from "./ui/button";
import { BoardColumn, type ColumnTone } from "./BoardColumn";
import { ColumnLoadFailed, ColumnSkeleton } from "./skeletons";
import { Card, CardContent, CardHeader } from "./ui/card";
import { CardNameRow } from "./CardNameRow";
import { HighlightText } from "./HighlightText";
import { ImproveStamp } from "./ImproveStamp";
import { isImproveKind } from "./improveStyle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { CopyButton, REVEAL_ON_HOVER } from "./CopyButton";

/**
 * promoted_to 子变更的阶段标示（纯前端由清单存在性派生）——active 清单命中
 * 依看板字段规则；封存清单命中为已封存；两者皆无为已删除（讨论维持已转出
 * 不回退，历史事实不回滚）。回传 i18n key，调用端以 t() 取显示字符串。
 */
export function discussionChipStage(
  name: string,
  changes: ChangeItem[],
  archived: ArchivedItem[],
): string {
  const active = changes.find((c) => c.name === name);
  if (active) return `stage.${changeStage(active)}`;
  if (archived.some((a) => a.name === name)) return "discussion.chipArchived";
  return "discussion.chipDeleted";
}

/**
 * promoted 子变更 chip 的配色（design D2）——与 discussionChipStage 同分类规则：
 * active 命中取看板阶段的 STAGE_BADGE 色相、封存命中为中性色、皆无为
 * destructive 加删除线（已删除）。与看板栏配色同一来源，不引入新色轮。
 */
export function discussionChipClass(
  name: string,
  changes: ChangeItem[],
  archived: ArchivedItem[],
): string {
  const active = changes.find((c) => c.name === name);
  if (active) return STAGE_BADGE[changeStage(active)];
  if (archived.some((a) => a.name === name)) return "bg-muted text-muted-foreground";
  return "bg-destructive/15 text-destructive line-through";
}

interface DiscussionColumnBaseProps {
  /** 看板上的讨论（active 清单；封存讨论不进此栏）。 */
  discussions: DiscussionItem[];
  /** active change 清单（chips 阶段派生）。 */
  changes: ChangeItem[];
  /** 已封存 change 清单（chips 已封存态派生）。 */
  archived: ArchivedItem[];
  onOpenDiscussion?: (slug: string) => void;
  /** concluded 卡的封存动词（app 端接确认流程）。转为变更（promote）已自 GUI 撤除。 */
  onArchiveDiscussion?: (slug: string) => void;
  /**
   * 栏内拖排（design D6）：true 时全卡（open／concluded）挂 sortable——
   * 需在宿主的 DndContext 内；promoted 收合列是衍生树查看，不参与拖排。
   */
  sortable?: boolean;
  /** 搜索字符串（design D7）：slug 子字符串命中时高亮。 */
  highlight?: string;
  /** 全文命中（design D6）：命中的讨论卡呈 snippet 行。 */
  fulltextHits?: SearchHit[];
  /** 首访加载中：以占位卡呈现，栏名照常、不出空态文案与计数（design D2）。 */
  loading?: boolean;
  /** 首访加载失败：卡片区显示加载失败提示，取代空态文案（调用端已排除 loading）。 */
  loadFailed?: boolean;
}

/**
 * 栏底「已转出」收合列的展开状态（design D2）：两者同进同出——皆提供时受控（展开状态
 * 由宿主持有，桌面 app 存于 app 本机跨启动保留）；皆缺席时组件内部状态、不持久化。
 * 只给其一在类型层就挡下，免得值被忽略或回呼永不触发。
 */
export type PromotedExpansionProps =
  | { promotedExpanded: boolean; onPromotedExpandedChange: (expanded: boolean) => void }
  | { promotedExpanded?: undefined; onPromotedExpandedChange?: undefined };

export type DiscussionColumnProps = DiscussionColumnBaseProps & PromotedExpansionProps;

/** 讨论栏的色相组：桃紫专属，与系统匣讨论分区同一来源（DISCUSSION_TONE）。 */
const DISCUSSION_COLUMN_TONE: ColumnTone = {
  icon: MessageSquareText,
  bar: "bg-stage-discussion",
  iconCls: DISCUSSION_TONE.icon,
  badge: DISCUSSION_TONE.badge,
};

const STATUS_BADGE: Record<string, { labelKey: string; cls: string }> = {
  open: { labelKey: "discussion.statusOpen", cls: "bg-primary/8 text-primary/70" },
  concluded: { labelKey: "discussion.statusConcluded", cls: "bg-primary/12 text-primary" },
  // 上区的 promoted 卡有两种：尚无结论的，与已有结论但保留在途（hold）的。
  // 两者同为 warning 语意色（沿 tone.ts 单一来源），标示由 statusBadge 选。
  promoted: {
    labelKey: "discussion.statusPromotedUnconcluded",
    cls: `${SEMANTIC_SURFACE.warning} ${SEMANTIC_TONE.warning}`,
  },
};

/**
 * 全卡的状态标：尚无结论（concluded 为 false）的 promoted 卡标「已转出・尚无结论」；
 * 其余还留在上区的 promoted 卡只可能是被 hold 留下的（判准与收合列同一份），
 * 换标为「已转出・保留中」、色系不变。非 promoted 态沿状态表。
 */
function statusBadge(d: DiscussionItem): { labelKey: string; cls: string } {
  const base = STATUS_BADGE[d.status] ?? STATUS_BADGE.open;
  if (d.status === "promoted" && d.concluded !== false && !isCollapsedPromoted(d)) {
    return { ...base, labelKey: "discussion.statusPromotedHeld" };
  }
  return base;
}

/**
 * 收合列判准：只收「引擎会自动收走的讨论」——promoted、已有结论（concluded 非
 * false）且未保留（hold 非 true）。这正是最后一刀封存时引擎会随行封存的集合；
 * 带 hold 的讨论整个分期系列都留在上区全卡。concluded 或 hold 缺席（旧 server）
 * 一律退回既有分区：缺席不得补成「尚无结论」或「保留中」。KanbanBoard 的拖排
 * 落点清单共用此判准——上区卡集与可拖集必须恒等，否则落点解析吞手势。
 */
export function isCollapsedPromoted(d: DiscussionItem): boolean {
  return d.status === "promoted" && d.concluded !== false && d.hold !== true;
}

export function DiscussionCard({
  d,
  onOpenDiscussion,
  onArchiveDiscussion,
  highlight,
  hit,
}: { d: DiscussionItem; hit?: SearchHit } & Pick<
  DiscussionColumnProps,
  "onOpenDiscussion" | "onArchiveDiscussion" | "highlight"
>) {
  const { t, tn } = useI18n();
  const badge = statusBadge(d);
  return (
    <Card
      data-discussion={d.slug}
      size="nested"
      interactive
      className="group cursor-(--cursor-interaction)"
      onClick={() => onOpenDiscussion?.(d.slug)}
    >
      <CardHeader className="p-3 flex-row items-start gap-1.5">
        {/* slug（文件名）为标题——CLI 动词把手，等宽强调；topic 降为卡身描述（LANGUAGE.md
            受控例外）。名称列与变更卡共用（骨架统一）。 */}
        <CardNameRow text={d.slug} copyLabel={t("discussion.copySlug")} highlight={highlight} />
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
          {t(badge.labelKey)}
        </span>
        {/* 改进小章（spec「看板讨论卡片的改进标示」）：随 kind 恒定——已转出与
            已封存侧同样显示，不随生命周期状态变化或消失。 */}
        {isImproveKind(d.kind) && <ImproveStamp />}
        {/* 创建者圆点（anatomy 识别列右端）：全名进 tooltip、卡面不直出——与变更卡同款。 */}
        {d.createdBy && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={d.createdBy}
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-muted-foreground"
                >
                  {d.createdBy.charAt(0).toUpperCase()}
                </span>
              </TooltipTrigger>
              <TooltipContent>{d.createdBy}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </CardHeader>
      <CardContent className="p-3 pt-0 gap-2">
        <span className="text-xs leading-snug text-foreground/80">
          <HighlightText text={d.topic} query={highlight} />
        </span>
        {/* meta 列（anatomy 三列骨架）：轮数与创建时间并排；创建者圆点已上移识别列。 */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{tn("common.rounds", d.rounds)}</span>
          <span className="tabular-nums">{d.created}</span>
        </div>
        {/* stopPropagation 挂在按钮自身而非整列：钮旁空白仍冒泡开讨论抽屉。 */}
        {d.status === "concluded" && (
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onArchiveDiscussion?.(d.slug);
              }}
            >
              <Archive className="h-3 w-3" /> {t("common.archive")}
            </Button>
          </div>
        )}
        {/* 全文命中 snippet 行（design D6/D7）：记录全文命中时呈前后文＋高亮。 */}
        {hit && (
          <div
            data-snippet
            className="flex items-start gap-1 border-t border-border/40 pt-1.5 text-[11px] leading-snug text-muted-foreground"
          >
            <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0">
              <span className="font-mono">{hit.artifact}</span>{" "}
              <HighlightText text={hit.snippet} query={highlight} />
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 可拖排的全卡包装：拖曳时原卡留在原位变淡，移动视觉由宿主 DragOverlay 呈现。 */
function SortableDiscussionCard({
  d,
  ...rest
}: { d: DiscussionItem; hit?: SearchHit } & Pick<
  DiscussionColumnProps,
  "onOpenDiscussion" | "onArchiveDiscussion" | "highlight"
>) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardDndId("discussion", d.slug),
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.35 } : undefined),
      }}
      {...attributes}
      {...listeners}
      aria-label={t("kanban.dragCard").replace("{name}", d.topic)}
    >
      <DiscussionCard d={d} {...rest} />
    </div>
  );
}

function PromotedRow({
  d,
  changes,
  archived,
  onOpenDiscussion,
}: { d: DiscussionItem } & Pick<DiscussionColumnProps, "changes" | "archived" | "onOpenDiscussion">) {
  const { t } = useI18n();
  // 衍生树细列：slug（文件名）为首行锚点——CLI 动词把手，带拷贝钮（LANGUAGE.md
  // 受控例外，desktop-ux-polish 扩充）；topic 降为次行描述；子变更以树状前缀
  // 逐列列出——父子（讨论→衍生变更）关系一眼可读。
  return (
    <div
      role="button"
      tabIndex={0}
      data-discussion={d.slug}
      className="group cursor-(--cursor-interaction) rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-foreground/20"
      onClick={() => onOpenDiscussion?.(d.slug)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpenDiscussion?.(d.slug);
      }}
    >
      {/* 拷贝钮行内尾随（design D4 拷贝钮位置规则）：break-all 多行 slug 的按钮
          直接跟在最后一个字符后流动，不以 flex 推至列右缘。 */}
      <span className="min-w-0 break-all font-mono text-xs font-semibold leading-tight">
        {d.slug}
        {/* 小章随 kind 恒定（design「标示不随生命周期变化」）——promoted 收合列同样要带。 */}
        {isImproveKind(d.kind) && (
          <span className="ml-1 inline-flex align-text-bottom">
            <ImproveStamp />
          </span>
        )}
        <CopyButton
          value={d.slug}
          label={t("discussion.copySlug")}
          className={cn("ml-1 align-text-bottom", REVEAL_ON_HOVER)}
        />
      </span>
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{d.topic}</span>
      <span className="mt-1 flex flex-col gap-0.5">
        {d.promotedTo.map((name, i) => (
          <span key={name} className="flex items-center gap-1 text-[11px] leading-tight">
            <span className="shrink-0 font-mono text-muted-foreground">
              {i === d.promotedTo.length - 1 ? "└" : "├"}
            </span>
            <span className="min-w-0 truncate font-medium">{name}</span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${discussionChipClass(name, changes, archived)}`}
            >
              {t(discussionChipStage(name, changes, archived))}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * 看板第 0 栏「讨论」（两级呈现，上下两区同屏、不互斥切换；design D3）：
 * - 上区：open／concluded 全尺寸卡（open 唯读、concluded 带「封存」动词——
 *   转为变更已自 GUI 撤除）。
 * - 栏底：「已转出 N ›」常驻收合列（有 promoted 时呈现、缺省收合），点按就地在
 *   收合列正上方展开 promoted 衍生树细列（slug 首行＋topic＋衍生变更树＋阶段 chip）；
 *   展开状态可由宿主受控（桌面 app 跨启动保留），缺席时组件内部状态、不持久化。
 */
export function DiscussionColumn({
  discussions,
  changes,
  archived,
  onOpenDiscussion,
  onArchiveDiscussion,
  sortable,
  highlight,
  fulltextHits,
  loading,
  loadFailed,
  promotedExpanded,
  onPromotedExpandedChange,
}: DiscussionColumnProps) {
  const { t } = useI18n();
  const full = discussions.filter((d) => !isCollapsedPromoted(d));
  const promoted = discussions.filter(isCollapsedPromoted);
  // 收合列展开状态（design D2）：两个 props 皆提供时受控，否则内部状态、缺省收合。
  const controlled = promotedExpanded !== undefined && onPromotedExpandedChange !== undefined;
  const [localOpen, setLocalOpen] = useState(false);
  const promotedOpen = controlled ? promotedExpanded : localOpen;
  const togglePromoted = () => {
    if (controlled) onPromotedExpandedChange(!promotedOpen);
    else setLocalOpen((v) => !v);
  };
  const hitBySlug = new Map(
    (fulltextHits ?? []).filter((h) => h.kind === "discussion").map((h) => [h.id, h]),
  );
  const fullCards = full.map((d) =>
    sortable ? (
      <SortableDiscussionCard
        key={d.slug}
        d={d}
        highlight={highlight}
        hit={hitBySlug.get(d.slug)}
        onOpenDiscussion={onOpenDiscussion}
        onArchiveDiscussion={onArchiveDiscussion}
      />
    ) : (
      <DiscussionCard
        key={d.slug}
        d={d}
        highlight={highlight}
        hit={hitBySlug.get(d.slug)}
        onOpenDiscussion={onOpenDiscussion}
        onArchiveDiscussion={onArchiveDiscussion}
      />
    ),
  );
  // 栏壳与三个阶段栏共用（BoardColumn，design D1）。
  return (
    <BoardColumn
      id="discussions"
      title={t("discussion.heading")}
      tone={DISCUSSION_COLUMN_TONE}
      count={loading || loadFailed ? null : full.length}
      empty={
        !loading && !loadFailed && full.length === 0 && promoted.length === 0
          ? t("discussion.none")
          : null
      }
      footer={
        !loading &&
        promoted.length > 0 && (
          <>
            {/* 展开的 promoted 细列落在收合列正上方的有界区块（淡灰底上、自卷）：栏内全卡
                再多也看得到，不会被挤到卡片卷动区的最底部。不加 shrink-0——窗口很矮时区块
                可被压缩，收合列不会被栏外框的 overflow-hidden 切掉。relative 同卡片区：细列
                内的 absolute 元素受本区裁切。 */}
            {promotedOpen && (
              <div className="relative flex max-h-64 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                {promoted.map((d) => (
                  <PromotedRow
                    key={d.slug}
                    d={d}
                    changes={changes}
                    archived={archived}
                    onOpenDiscussion={onOpenDiscussion}
                  />
                ))}
              </div>
            )}
            <button
              type="button"
              aria-expanded={promotedOpen}
              onClick={togglePromoted}
              className="flex w-full shrink-0 items-center gap-2 border-t border-border/70 bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span className="flex-1 text-left tabular-nums">
                {t("discussion.promotedBar").replace("{n}", String(promoted.length))}
              </span>
              {/* 收合 ›、展开时指向展开出来的内容：细列展开在收合列上方，故朝上。 */}
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 transition-transform ${promotedOpen ? "-rotate-90" : ""}`}
              />
            </button>
          </>
        )
      }
    >
      {loading ? (
        <ColumnSkeleton />
      ) : loadFailed ? (
        <ColumnLoadFailed />
      ) : sortable ? (
        <SortableContext
          items={full.map((d) => cardDndId("discussion", d.slug))}
          strategy={verticalListSortingStrategy}
        >
          {fullCards}
        </SortableContext>
      ) : (
        fullCards
      )}
    </BoardColumn>
  );
}

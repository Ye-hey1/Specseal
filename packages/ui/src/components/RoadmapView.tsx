import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Route } from "lucide-react";

import type { ChangeItem, DiscussionLists, UnpromotedCutItem } from "../adapter";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import {
  roadmapEdgeKey,
  roadmapModel,
  roadmapRoute,
  type RoadmapEdge,
  type RoadmapStation,
} from "../roadmapModel";
import { planBlockedLabel, planWaveLabel } from "../stage";
import { SEMANTIC_SURFACE } from "../tone";
import { CommandChip } from "./DocParts";
import { EmptyState } from "./EmptyState";
import { PlanCycleNote } from "./KanbanBoard";
import { ColumnLoadFailed, ColumnSkeleton } from "./skeletons";
import { PageHeader } from "./ui/page-header";
import { StatusPill } from "./ui/status-pill";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

/** 看板页的两种查看（spec desktop-roadmap「看板页的路线图查看」）：卡片看板与路线图。 */
export type BoardMode = "cards" | "roadmap";

/** 切换时焦点在切换钮上：切换后由新显示那一页的切换接回焦点（两页各有一个切换）。 */
let refocusSwitch = false;

/** 看板页页眉的「看板｜路线图」切换：卡片查看与路线图的页眉放同一个，都在最右端。外框高度与
 * 搜索框、筛选钮同为 32px：路线图的页眉只有切换，高度一致才不会在切换查看时上下跳。
 * 切换后原本那颗钮所在的查看被藏起来（hidden＋inert），焦点会掉回 body——键盘用户因此由
 * 新显示那一页的切换接回焦点。 */
export function BoardViewSwitch({ value, onChange }: { value: BoardMode; onChange: (mode: BoardMode) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!refocusSwitch || !root || root.closest("[inert]")) return;
    refocusSwitch = false;
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [value]);
  return (
    <Tabs
      ref={ref}
      value={value}
      onValueChange={(mode) => {
        refocusSwitch = ref.current?.contains(document.activeElement) ?? false;
        onChange(mode as BoardMode);
      }}
      className="flex h-8 items-center"
    >
      <TabsList variant="segmented" aria-label={t("roadmap.viewSwitch")}>
        <TabsTrigger value="cards">{t("roadmap.view.cards")}</TabsTrigger>
        <TabsTrigger value="roadmap">{t("roadmap.view.roadmap")}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export interface RoadmapViewProps {
  /** 页标题与说明：与卡片查看同一页，宿主给同一个标题。 */
  title: string;
  description: string;
  /** 清单项（plan 的配置序）；带 wave 的成为站。 */
  changes: ChangeItem[];
  /** plan 的 next：同名的站带「下一个」签。 */
  next: string | null;
  unpromotedCuts: UnpromotedCutItem[];
  /** 非 null（依赖成环）时不画波次栏、站与线，改显示成环提示。 */
  planError: string | null;
  /** 目前项目的讨论清单：尚未转出卡的讨论 slug 在清单内时可点。 */
  discussions: DiscussionLists;
  onOpenChange: (name: string) => void;
  onOpenDiscussion: (slug: string) => void;
  /** 页眉右侧的「看板｜路线图」切换（宿主给 BoardViewSwitch）。 */
  viewSwitch?: ReactNode;
  /** 与卡片查看相同的加载状态：首访加载中画占位卡、首访失败画失败提示。 */
  loading?: boolean;
  loadFailed?: boolean;
}

/** 站的圆点：画布 32px、圆半径 11、线宽 3。依赖线接在圆的外缘（圆心 ± NODE_EDGE）。 */
const NODE_SIZE = 32;
const NODE_R = 11;
const NODE_STROKE = 3;
const NODE_EDGE = NODE_R + NODE_STROKE / 2;

/** 圆点样式：已就绪实心打勾、进行中进度圈、提案中外框；被挡的提案中站改虚线圈。 */
type NodeKind = "ready" | "in-progress" | "proposed" | "waiting";

function nodeKind(station: RoadmapStation): NodeKind {
  if (station.stage === "proposed" && station.blockedBy.length > 0) return "waiting";
  return station.stage;
}

function StationNode({
  station,
  nodeRef,
  className,
}: {
  station: RoadmapStation;
  nodeRef: (el: SVGSVGElement | null) => void;
  className?: string;
}) {
  const kind = nodeKind(station);
  const c = NODE_SIZE / 2;
  const circumference = 2 * Math.PI * NODE_R;
  const ratio = station.totalTasks > 0 ? station.completedTasks / station.totalTasks : 0;
  return (
    <svg
      ref={nodeRef}
      data-station-node={kind}
      data-progress-ring={kind === "in-progress" ? "" : undefined}
      viewBox={`0 0 ${NODE_SIZE} ${NODE_SIZE}`}
      aria-hidden="true"
      className={cn("relative z-[2] h-8 w-8 shrink-0 overflow-visible", className)}
    >
      {station.next && <circle data-node-halo cx={c} cy={c} r={c} className="fill-primary/15" />}
      {kind === "ready" && (
        <>
          <circle cx={c} cy={c} r={NODE_EDGE} className="fill-stage-ready" />
          <path
            d="M 11 16.5 l 3.5 3.5 l 6.5 -7"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-card"
          />
        </>
      )}
      {kind === "in-progress" && (
        <>
          <circle cx={c} cy={c} r={NODE_R} strokeWidth={NODE_STROKE} className="fill-card stroke-stage-in-progress/20" />
          {ratio > 0 && (
            <circle
              cx={c}
              cy={c}
              r={NODE_R}
              fill="none"
              strokeWidth={NODE_STROKE}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - ratio)}
              transform={`rotate(-90 ${c} ${c})`}
              className="stroke-stage-in-progress"
            />
          )}
        </>
      )}
      {kind === "proposed" && (
        <circle cx={c} cy={c} r={NODE_R} strokeWidth={NODE_STROKE} className="fill-card stroke-stage-proposed" />
      )}
      {kind === "waiting" && (
        <circle
          cx={c}
          cy={c}
          r={NODE_R}
          strokeWidth="2"
          strokeDasharray="3 3"
          className="fill-muted stroke-muted-foreground/60"
        />
      )}
    </svg>
  );
}

/** 站与路线高亮之间的接线：量测用的 DOM 登记与鼠标／焦点进出。 */
interface StationWiring {
  register: (name: string, el: Element | null) => void;
  setHovered: (name: string | null) => void;
  setFocused: (name: string | null) => void;
}

/* 表的栏宽：变更栏至少 200px 并吃掉剩余宽度，每个波次栏 88px，尚未转出栏 80px。波次再多也只是
   往右加窄栏；变更再多只是往下长。 */
const NAME_COL_MIN = 200;
const WAVE_COL = 88;
const CUT_COL = 80;

/** 表的字段：各列共用的波次编号、有没有尚未转出栏，以及由两者算出的 grid 栏宽。 */
interface TableLayout {
  waves: number[];
  withCuts: boolean;
  columns: string;
}

function tableLayout(waves: number[], withCuts: boolean): TableLayout {
  const cols = [`minmax(${NAME_COL_MIN}px, 1fr)`];
  if (waves.length > 0) cols.push(`repeat(${waves.length}, ${WAVE_COL}px)`);
  if (withCuts) cols.push(`${CUT_COL}px`);
  return { waves, withCuts, columns: cols.join(" ") };
}

/* 波次栏的格子：第 1 波（现在就能开工）带主色淡底，之后各波为中性底；停在列上时跟着列的 hover
   底色变透明。格子不定位，依赖线画在格子之上、圆点之下。 */
function waveCellCls(wave: number): string {
  return cn(
    "flex items-center justify-center border-l border-border group-hover:bg-transparent",
    wave === 1 ? "bg-primary/5" : "bg-sidebar",
  );
}
const CUT_CELL_CLS = "flex items-center justify-center border-l border-border bg-status-manual/5";
/** 尚未转出的虚线方块：与讨论详情页「尚未转出」的刀卡同一组语意色。 */
const CUT_MARKER_CLS = `h-[18px] w-[18px] rounded-[5px] border-[1.5px] border-dashed ${SEMANTIC_SURFACE.manual}`;
const HEAD_CELL_CLS = "border-l border-border px-1 py-2 text-center leading-snug";

function StationRow({
  station,
  wave,
  layout,
  waveStart,
  dimmed,
  wiring,
  onOpen,
}: {
  station: RoadmapStation;
  wave: number;
  layout: TableLayout;
  waveStart: boolean;
  dimmed: boolean;
  wiring: StationWiring;
  onOpen: (name: string) => void;
}) {
  const { t } = useI18n();
  const blocked = station.blockedBy.length > 0;
  let tail: ReactNode;
  if (blocked) {
    tail = <span data-station-blocked>{planBlockedLabel(station.blockedBy, t)}</span>;
  } else if (station.next) {
    tail = (
      <StatusPill data-next-badge tone="primary" className="h-4 px-1.5 align-[1px] text-[10px]">
        {t("roadmap.next")}
      </StatusPill>
    );
  } else {
    tail = t(`stage.${station.stage}`);
  }
  // 被挡与路线外的站变淡：只淡圆点与字，格子底色不变。
  const fade = cn("transition-opacity", blocked && "opacity-55", dimmed && "opacity-25");
  return (
    <button
      type="button"
      data-station={station.name}
      data-stage={station.stage}
      data-next={station.next ? "" : undefined}
      data-blocked={blocked ? "" : undefined}
      data-dimmed={dimmed ? "" : undefined}
      onClick={() => onOpen(station.name)}
      onMouseEnter={() => wiring.setHovered(station.name)}
      onMouseLeave={() => wiring.setHovered(null)}
      onFocus={() => wiring.setFocused(station.name)}
      onBlur={() => wiring.setFocused(null)}
      style={{ gridTemplateColumns: layout.columns }}
      className={cn(
        "group grid w-full border-t text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        waveStart ? "border-border" : "border-border/60",
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
        <span className={cn("font-mono text-xs text-foreground [overflow-wrap:anywhere]", fade)}>{station.name}</span>
        <span
          data-station-status
          className={cn("text-[11px] tabular-nums text-muted-foreground [overflow-wrap:anywhere]", fade)}
        >
          {`${station.completedTasks}/${station.totalTasks} · `}
          {tail}
        </span>
      </span>
      {layout.waves.map((w) => (
        <span key={w} data-wave-cell={w} className={waveCellCls(w)}>
          {w === wave && (
            <StationNode station={station} nodeRef={(el) => wiring.register(station.name, el)} className={fade} />
          )}
        </span>
      ))}
      {layout.withCuts && <span data-cut-cell className={CUT_CELL_CLS} />}
    </button>
  );
}

function CutRow({
  cut,
  layout,
  first,
  canOpen,
  onOpenDiscussion,
}: {
  cut: UnpromotedCutItem;
  layout: TableLayout;
  first: boolean;
  canOpen: boolean;
  onOpenDiscussion: (slug: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-roadmap-cut
      style={{ gridTemplateColumns: layout.columns }}
      className={cn("grid border-t", first ? "border-border" : "border-border/60")}
    >
      <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
        {/* 范围句只在停留时以提示呈现，列上不写。 */}
        <span
          data-cut-unpromoted
          title={cut.title || undefined}
          className="font-mono text-xs text-foreground [overflow-wrap:anywhere]"
        >
          {cut.unpromoted.join(t("common.listSeparator"))}
        </span>
        <span data-cut-head className="min-w-0 truncate text-[11px] text-muted-foreground">
          {canOpen ? (
            <button
              type="button"
              className="font-mono text-primary underline-offset-2 hover:underline"
              onClick={() => onOpenDiscussion(cut.discussion)}
            >
              {cut.discussion}
            </button>
          ) : (
            <span className="font-mono">{cut.discussion}</span>
          )}
          {` · ${cut.cut}`}
        </span>
        {/* 转出指令与讨论详情页同一个指令签；栏窄时指令在签内折行。 */}
        <span className="mt-1 block min-w-0 [overflow-wrap:anywhere]">
          <CommandChip command={`/specseal-propose --from-discussion ${cut.discussion}`} />
        </span>
      </span>
      {layout.waves.map((w) => (
        <span key={w} data-wave-cell={w} className={waveCellCls(w)} />
      ))}
      <span data-cut-cell className={CUT_CELL_CLS}>
        <i data-cut-marker aria-hidden="true" className={CUT_MARKER_CLS} />
      </span>
    </div>
  );
}

/** 站的圆点在画布座标系内的左右外缘与圆心高度。 */
interface StationBox {
  left: number;
  right: number;
  mid: number;
}

/** 折线的转角半径；同一条栏界上的前置站各自的直线段相距 6px，最多偏离栏界 20px（圆点离栏界 31.5px）。 */
const ELBOW_R = 8;
const ELBOW_GAP = 6;
const ELBOW_MAX_OFFSET = 20;

/**
 * 依赖线叠层：不接收指针事件。每条线自前置站圆点的右外缘水平出发，在依赖者所在波次栏的左边界
 * 转成直线往下，再水平接到依赖者圆点的左外缘——圆点都在栏的正中，栏界上没有圆点，跨过几波的线
 * 也不会从中间那几波的圆点底下穿过。同一条栏界上有多个前置站时，各自的直线段错开，不叠成一条。
 * 叠层画在格子底色之上、圆点之下（z-[1] 介于两者之间）。
 */
function EdgeLayer({
  edges,
  boxes,
  route,
  offsets,
}: {
  edges: RoadmapEdge[];
  boxes: Map<string, StationBox>;
  route: Set<string> | null;
  offsets: Map<string, number>;
}) {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible">
      {edges.map((edge) => {
        const from = boxes.get(edge.from);
        const to = boxes.get(edge.to);
        if (!from || !to) return null;
        const key = roadmapEdgeKey(edge);
        const active = route !== null && route.has(key);
        const dimmed = route !== null && !active;
        const xm = (to.left + to.right) / 2 - WAVE_COL / 2 + (offsets.get(key) ?? 0);
        const r = Math.min(ELBOW_R, Math.abs(to.mid - from.mid) / 2);
        const d =
          to.mid === from.mid
            ? `M ${from.right} ${from.mid} H ${to.left}`
            : `M ${from.right} ${from.mid} H ${xm - r} Q ${xm} ${from.mid} ${xm} ${from.mid + r} V ${to.mid - r} Q ${xm} ${to.mid} ${xm + r} ${to.mid} H ${to.left}`;
        return (
          <path
            key={key}
            data-roadmap-edge={key}
            data-active={active ? "" : undefined}
            data-dimmed={dimmed ? "" : undefined}
            d={d}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              "transition-opacity",
              active ? "stroke-primary" : "stroke-muted-foreground/35",
              dimmed && "opacity-30",
            )}
          />
        );
      })}
    </svg>
  );
}

/**
 * 每条线直线段的水平偏移（以线的 key 查）：直线段走在依赖者波次栏的左边界，同一条栏界上的前置站
 * 依清单顺序由左而右排开；同一个前置站连到同一波的几个依赖者时共用一条直线段。
 */
function elbowOffsets(edges: RoadmapEdge[], waveOf: Map<string, number>): Map<string, number> {
  const sourcesAt = new Map<number, string[]>();
  for (const { from, to } of edges) {
    const wave = waveOf.get(to);
    if (wave === undefined) continue;
    const list = sourcesAt.get(wave) ?? [];
    if (!list.includes(from)) list.push(from);
    sourcesAt.set(wave, list);
  }
  const offsets = new Map<string, number>();
  for (const edge of edges) {
    const list = sourcesAt.get(waveOf.get(edge.to)!)!;
    const raw = (list.indexOf(edge.from) - (list.length - 1) / 2) * ELBOW_GAP;
    offsets.set(roadmapEdgeKey(edge), Math.max(-ELBOW_MAX_OFFSET, Math.min(ELBOW_MAX_OFFSET, raw)));
  }
  return offsets;
}

const SKELETON_COLUMN_CLS = "flex w-64 shrink-0 flex-col gap-2";

/** 图例：说明每种圆点、尚未转出的方块与线。 */
function RoadmapLegend() {
  const { t } = useI18n();
  const dot = "h-3 w-3 rounded-full";
  const items: Array<[mark: string, label: string]> = [
    [`${dot} bg-stage-ready`, t("stage.ready")],
    [`${dot} border-2 border-stage-in-progress bg-card`, t("roadmap.legend.inProgress")],
    [`${dot} border-2 border-stage-proposed bg-card`, t("stage.proposed")],
    [`${dot} border-2 border-stage-proposed bg-card ring-[3px] ring-primary/15`, t("roadmap.next")],
    [`${dot} border-2 border-dashed border-muted-foreground/60 bg-muted`, t("roadmap.legend.waiting")],
    [`h-3 w-3 rounded-[3px] border-[1.5px] border-dashed ${SEMANTIC_SURFACE.manual}`, t("conclusion.notPromoted")],
    ["h-[3px] w-4 rounded-full bg-muted-foreground/35", t("roadmap.legend.edge")],
  ];
  return (
    <ul
      data-roadmap-legend
      aria-label={t("roadmap.legend")}
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-[11px] text-muted-foreground"
    >
      {items.map(([mark, label]) => (
        <li key={label} data-legend-item className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("inline-block shrink-0", mark)} />
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * 看板页的路线图查看（spec desktop-roadmap）：一张表，每个变更一列、每一波一个窄栏，圆点落在所属
 * 的波次栏；最右一栏与最后几列是尚未转出的刀。只看不写——点站开变更详情、点讨论 slug 开讨论详情，
 * 其余都在详情页。
 */
export function RoadmapView({
  title,
  description,
  changes,
  next,
  unpromotedCuts,
  planError,
  discussions,
  onOpenChange,
  onOpenDiscussion,
  viewSwitch,
  loading,
  loadFailed,
}: RoadmapViewProps) {
  const { t, tn } = useI18n();
  const model = roadmapModel(changes, next);
  const { waves } = model;
  // 成环时引擎不排波次：清单项全部没有 wave，不是 metadata 坏掉，不另写无法调度。
  const unplaced = planError ? [] : model.unplaced;

  // 路线高亮：鼠标停留优先、其次键盘焦点；两者都离开才恢复。只改呈现。停留中的站因
  // 刷新离开路线图时（另一个 session 封存了它）不再算数，免得整张图一直变淡。
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const waveOf = new Map(waves.flatMap((w) => w.stations.map((s) => [s.name, w.wave] as const)));
  const highlighted = [hovered, focused].find((name) => name !== null && waveOf.has(name));
  const route = highlighted ? roadmapRoute(model, highlighted) : null;

  // 依赖线的座标：量测每个圆点相对于画布的位置。画布随卷动一起移动，卷动不需重算；
  // 数据变动与画布尺寸改变（ResizeObserver）时重算。
  const canvasRef = useRef<HTMLDivElement>(null);
  const stationEls = useRef(new Map<string, Element>());
  const [boxes, setBoxes] = useState(() => new Map<string, StationBox>());
  const wiring: StationWiring = {
    register: (name, el) => {
      if (el) stationEls.current.set(name, el);
      else stationEls.current.delete(name);
    },
    setHovered,
    setFocused,
  };
  const layoutKey = JSON.stringify([waves.map((w) => w.stations.map((s) => s.name)), model.edges, unpromotedCuts.length]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const base = canvas.getBoundingClientRect();
      const measured = new Map<string, StationBox>();
      for (const [name, el] of stationEls.current) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left - base.left + rect.width / 2;
        measured.set(name, {
          left: cx - NODE_EDGE,
          right: cx + NODE_EDGE,
          mid: rect.top - base.top + rect.height / 2,
        });
      }
      setBoxes(measured);
    };
    measure();
    // 尺寸改变时同步画出新座标：路线图是隐藏着挂上的（量到全是 0），切过来那一刻若等下一轮
    // 调度才更新，第一格画面会在左上角闪出几条短线。
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(canvas);
    return () => observer.disconnect();
    // 画布只在加载结束后挂上：加载状态一变就重新接上量测。
  }, [layoutKey, loading, loadFailed]);
  const openable = new Set(discussions.active.map((d) => d.slug));
  const failed = !loading && !!loadFailed;
  // 有站或有刀才有表；成环时没有站，引擎也不给刀。全部变更都无法调度时只留页眉下方那一行说明，
  // 不算「没有进行中的变更」。
  const hasTable = waves.length > 0 || unpromotedCuts.length > 0;
  const empty = !planError && !hasTable && unplaced.length === 0;

  let body: ReactNode = null;
  if (loading) {
    body = (
      <div className="flex gap-6">
        <section className={SKELETON_COLUMN_CLS}>
          <ColumnSkeleton />
        </section>
        <section className={SKELETON_COLUMN_CLS}>
          <ColumnSkeleton />
        </section>
      </div>
    );
  } else if (failed) {
    body = <ColumnLoadFailed />;
  } else if (empty) {
    body = <EmptyState icon={Route} title={t("roadmap.empty")} className="h-full" />;
  } else if (hasTable) {
    const layout = tableLayout(
      waves.map((w) => w.wave),
      unpromotedCuts.length > 0,
    );
    const minWidth = NAME_COL_MIN + layout.waves.length * WAVE_COL + (layout.withCuts ? CUT_COL : 0) + 2;
    body = (
      <div ref={canvasRef} className="relative" style={{ minWidth }}>
        <div data-roadmap-table className="overflow-hidden rounded-xl border border-border bg-card">
          <div
            data-roadmap-head
            style={{ gridTemplateColumns: layout.columns }}
            className="grid border-b border-border text-xs text-muted-foreground"
          >
            <div className="px-3 py-2">{t("roadmap.colChange")}</div>
            {waves.map((wave) => (
              <div
                key={wave.wave}
                data-roadmap-wave={wave.wave}
                className={cn(HEAD_CELL_CLS, wave.wave === 1 && "shadow-[inset_0_3px_0_var(--primary)]")}
              >
                <span data-wave-title className="block font-semibold text-foreground">
                  {planWaveLabel(wave.wave, t)}
                </span>
                <span data-wave-note className="block">
                  {`${wave.stations.length} · ${
                    wave.wave === 1 ? t("roadmap.parallel") : t("roadmap.waitsFor").replace("{n}", String(wave.wave - 1))
                  }`}
                </span>
              </div>
            ))}
            {layout.withCuts && (
              <div data-roadmap-cuts className={cn(HEAD_CELL_CLS, "shadow-[inset_0_3px_0_var(--status-manual)]")}>
                <span data-cuts-title className="block font-semibold text-status-manual">
                  {t("conclusion.notPromoted")}
                </span>
                <span data-cuts-count className="block">
                  {tn("roadmap.cutCount", unpromotedCuts.length)}
                </span>
              </div>
            )}
          </div>
          {waves.flatMap((wave) =>
            wave.stations.map((station, i) => (
              <StationRow
                key={station.name}
                station={station}
                wave={wave.wave}
                layout={layout}
                waveStart={i === 0 && wave.wave !== layout.waves[0]}
                dimmed={route !== null && !route.stations.has(station.name)}
                wiring={wiring}
                onOpen={onOpenChange}
              />
            )),
          )}
          {unpromotedCuts.map((cut, i) => (
            <CutRow
              key={`${cut.discussion}/${cut.cut}`}
              cut={cut}
              layout={layout}
              first={i === 0 && waves.length > 0}
              canOpen={openable.has(cut.discussion)}
              onOpenDiscussion={onOpenDiscussion}
            />
          ))}
        </div>
        {waves.length > 0 && (
          <EdgeLayer
            edges={model.edges}
            boxes={boxes}
            route={route ? route.edges : null}
            offsets={elbowOffsets(model.edges, waveOf)}
          />
        )}
      </div>
    );
  }
  // 图例说明表上的记号：有表才有图例。
  const showLegend = !loading && !failed && hasTable;

  return (
    <div data-roadmap className="flex h-full min-h-0 flex-col gap-3">
      {planError && <PlanCycleNote planError={planError} />}
      <PageHeader title={title} description={description} actions={viewSwitch} />
      {unplaced.length > 0 && (
        <p data-roadmap-unplaced className="text-xs text-muted-foreground">
          {tn("roadmap.unplaced", unplaced.length)}
        </p>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto">{body}</div>
      {showLegend && <RoadmapLegend />}
    </div>
  );
}

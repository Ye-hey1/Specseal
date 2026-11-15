import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type Ref } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCheck, ChevronDown, ChevronRight, GripVertical, Hand, LocateFixed, RotateCcw } from "lucide-react";

import { splitTaskText } from "../docModel";
import { useI18n } from "../i18n";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { InlineMarks, NAME_CHIP_CLS, SECTION_HEADING_CLS } from "./DocParts";
import { Markdown } from "./Markdown";
import { parseTaskDoc, resolveDropTarget, taskKey, type TaskDocItem } from "../tasks";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";

export interface TaskListProps {
  markdown: string | null;
  /** 勾选/取消第 ordinal 个任务（1-based）；带 ID 任务同时回报 stableId
   * （tsk_ 前缀），勾选请求以它寻址、无 ID 旧档走 ordinal 兼容路径。 */
  onToggle?: (ordinal: number, done: boolean, stableId?: string) => void;
  /**
   * 拖放落点：把第 from 个任务移到以第 to 个任务为锚的位置（皆 1-based、一次
   * 到位）。before=true＝插锚前（群组标题落点解析为组首）；省略＝方向推断。
   * 未提供＝拖排停用（remote capability 缺口）：不渲染把手、不挂 DndContext，
   * 勾选与批量工具列照常。
   */
  onReorder?: (from: number, to: number, before?: boolean) => void;
  /** 写入进行中时锁定交互。 */
  busy?: boolean;
  /** 拖曳手势期间（按住～放开）回报 true——宿主据此让外部内容重载让路。 */
  onDragActiveChange?: (active: boolean) => void;
  /** 唯读呈现（封存查看）：核取方块 disabled、不渲染拖曳把手与工具列。 */
  readOnly?: boolean;
  /** 批量设置全部任务完成状态（true＝全部已完成、false＝重置任务）。 */
  onSetAll?: (done: boolean) => void;
  /** 点任务标题后的 D 签（design D5）：宿主切到设计文档并展开该决策卡；缺席时 D 签不可点。 */
  onJumpDecision?: (id: string) => void;
  /** 定位请求（页的手动提示框「前往」；design D14）：卷到第 ordinal 个任务并短暂高亮，唯读时也可；
   * seq 递增让同一列可重复定位。 */
  locate?: { ordinal: number; seq: number } | null;
  /** 定位处理完——页据此清掉请求。 */
  onLocated?: () => void;
}

type TaskItem = Extract<TaskDocItem, { kind: "task" }>;

/** 群组标题开头的「N.」（任务描述的「X.Y」序号由 splitTaskText 切）。 */
const GROUP_ORDINAL_RE = /^(\d+)\.\s*([\s\S]*)$/;

/** 序号签：任务列与群组卡头共用。 */
const ORDINAL_CHIP_CLS = "mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted-foreground";

/** 列内的按钮在 label 里：点击不得冒到列上触发勾选。 */
function inRow(action: () => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  };
}

/**
 * 任务列内容（spec「任务群组标题与章节标签同款式」；design D5）——一般列与 DragOverlay 共用。
 * 描述拆「标题／内文／验证」三层：标题层有勾选框、序号签与标题，视内容再加 D 签、手动签，
 * 有内文或验证时另有列尾展开钮；展开时在标题下方画内文与验证。展开与否由 `TaskList` 决定
 * （`open`／`onToggleOpen`）。`titleOnly`（拖曳浮起列）只画标题层。
 */
function TaskRowBody({
  item,
  checkboxId,
  disabled,
  onToggle,
  onJumpDecision,
  open = false,
  onToggleOpen,
  titleOnly,
}: {
  item: TaskItem;
  checkboxId?: string;
  disabled?: boolean;
  onToggle?: (ordinal: number, done: boolean, stableId?: string) => void;
  onJumpDecision?: (id: string) => void;
  open?: boolean;
  onToggleOpen?: () => void;
  titleOnly?: boolean;
}) {
  const { t } = useI18n();
  const parts = splitTaskText(item.text);
  const detail = [parts.note, parts.body].filter(Boolean).join("\n\n");
  const expandable = !titleOnly && (detail !== "" || parts.verify !== null);
  const n = String(item.ordinal);
  return (
    <>
      <Checkbox
        id={checkboxId}
        aria-label={t("tasks.checkbox").replace("{n}", n)}
        className="mt-1"
        checked={item.done}
        disabled={disabled}
        onCheckedChange={(v) => onToggle?.(item.ordinal, v === true, item.stableId)}
      />
      {/* 描述栏：标题那一行＋展开层。手动任务的徽章不进这一栏的文本流（spec「任务列的
          手动任务徽章」；design D14）——它在标题列尾，序号与标题的起始栏与无标记列同位。 */}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span data-task-title-row className="flex min-w-0 items-start gap-2">
          {parts.number && <span className={ORDINAL_CHIP_CLS}>{parts.number}</span>}
          <span
            data-task-title
            className={`min-w-0 flex-1 text-[15px] leading-relaxed ${
              item.done ? "text-muted-foreground line-through decoration-muted-foreground/50" : ""
            }`}
          >
            <InlineMarks text={parts.title} />
          </span>
          {parts.decisions.map((id) =>
            onJumpDecision ? (
              <button
                key={id}
                type="button"
                data-task-decision={id}
                className={`${NAME_CHIP_CLS} mt-0.5 text-primary hover:bg-accent hover:underline`}
                onClick={inRow(() => onJumpDecision(id))}
              >
                {id}
              </button>
            ) : (
              <span key={id} data-task-decision={id} className={`${NAME_CHIP_CLS} mt-0.5`}>
                {id}
              </span>
            ),
          )}
          {item.manual && (
            <span
              aria-label={t("tasks.manual")}
              // 手动语意色（暖黄，面色＋文本色），与看板「待手动」章、手动任务提示框同一个 token。
              className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none ${SEMANTIC_SURFACE.manual} ${SEMANTIC_TONE.manual}`}
            >
              <Hand className="h-3 w-3" />
              {t("tasks.manual")}
            </span>
          )}
          {expandable && (
            <Button
              type="button"
              variant="subtle"
              size="icon-xs"
              data-task-expand
              aria-expanded={open}
              aria-label={t(open ? "tasks.collapse" : "tasks.expand").replace("{n}", n)}
              className="mt-0.5 h-5 w-5 shrink-0"
              onClick={inRow(() => onToggleOpen?.())}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </Button>
          )}
        </span>
        {expandable && open && (
          // 展开层仍在列的 label 里：点内文不勾选（链接照常可点），选字拷贝不受影响。
          <span
            data-task-detail
            className="flex cursor-auto flex-col gap-2 pb-1 text-[15px]"
            onClick={(e) => {
              if (!(e.target instanceof Element && e.target.closest("a"))) e.preventDefault();
            }}
          >
            {detail && <Markdown content={detail} className="[&_p]:my-0" />}
            {parts.verify && (
              <span className="flex flex-col gap-0.5">
                <span className="text-xs font-semibold text-muted-foreground">{t("tasks.verifyLabel")}</span>
                <Markdown content={parts.verify} className="[&_p]:my-0" />
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );
}

/** 任务列外框共用样式。 */
const ROW_CLS = "group/task flex items-start gap-2 py-1 pl-1 rounded-md";

/** 列的底色：「下一个未完成」高亮优先；未勾的手动任务整列暖黄淡底（design D14）；其余 hover 才淡灰。
 * 唯读列点了没反应，不给 hover 底色。 */
function rowSurface(item: TaskItem, interactive: boolean, highlight?: boolean): string {
  if (highlight) return "bg-accent ring-1 ring-primary/40";
  if (item.manual && !item.done) return interactive ? "bg-status-manual/12 hover:bg-status-manual/20" : "bg-status-manual/12";
  return interactive ? "hover:bg-foreground/5" : "";
}

/** 手动任务列的标记（未勾与已勾都带）。 */
const manualMark = (item: TaskItem) => (item.manual ? { "data-task-manual": "" } : {});

/** 整列为勾选框的 label（design D8）：可写时 htmlFor 指向勾选框、光标取共用变量；唯读与
 * 批量写回中（busy）不带 htmlFor、光标缺省，勾选框同时停用——隐式关联也不会触发。 */
function rowLabelProps(checkboxId: string, interactive: boolean) {
  return {
    htmlFor: interactive ? checkboxId : undefined,
    className: interactive ? "cursor-(--cursor-interaction)" : "cursor-default",
    onClick: ignoreClickAfterSelecting,
  };
}

/** 拖选文本后放开，click 仍会经 label 转送到勾选框——页面有选取文本时不转送，选字不等于
 * 勾选。双击选字的第二下照常放行：第一下按下时尚无选取、已切换一次，两下互相抵销。
 * 直接点在勾选框上照常切换。 */
function ignoreClickAfterSelecting(e: MouseEvent<HTMLLabelElement>) {
  if (e.detail >= 2) return;
  if (e.target instanceof Element && e.target.closest('[role="checkbox"]')) return;
  if (window.getSelection()?.toString()) e.preventDefault();
}

/** 不可拖排的任务列（唯读或拖排停用）：保留高亮与定位卷动。 */
function PlainTaskRow({
  item,
  interactive,
  onToggle,
  onJumpDecision,
  open,
  onToggleOpen,
  highlight,
  rowRef,
}: {
  item: TaskItem;
  interactive: boolean;
  onToggle?: (ordinal: number, done: boolean, stableId?: string) => void;
  onJumpDecision?: (id: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  highlight?: boolean;
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const checkboxId = useId();
  const label = rowLabelProps(checkboxId, interactive);
  return (
    <label
      ref={rowRef}
      htmlFor={label.htmlFor}
      onClick={label.onClick}
      data-highlight={highlight ? "true" : "false"}
      {...manualMark(item)}
      className={`${ROW_CLS} ${label.className} transition-colors ${rowSurface(item, interactive, highlight)}`}
    >
      <TaskRowBody
        item={item}
        checkboxId={checkboxId}
        disabled={!interactive}
        onToggle={onToggle}
        onJumpDecision={onJumpDecision}
        open={open}
        onToggleOpen={onToggleOpen}
      />
    </label>
  );
}

/** 群组卡头：左端序号签、16px 粗体标题（本页目录锚点）、右端小进度「已完成/总数」。 */
function GroupHeader({
  text,
  done,
  total,
  nodeRef,
  style,
}: {
  text: string;
  done: number;
  total: number;
  nodeRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const numbered = GROUP_ORDINAL_RE.exec(text);
  return (
    <div ref={nodeRef} style={style} className="flex items-start gap-2 border-b border-border/70 px-4 py-3">
      {numbered && <span className={ORDINAL_CHIP_CLS}>{numbered[1]}</span>}
      <h3 data-doc-heading className={`min-w-0 flex-1 ${SECTION_HEADING_CLS}`}>
        {numbered ? numbered[2] : text}
      </h3>
      <span data-task-group-progress className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {`${done}/${total}`}
      </span>
    </div>
  );
}

/** 可拖排时的群组卡头：不可拖，但以 disabled sortable 项参与让位串行（design D6）——
 * 拖曳中任务与标题保持相对顺序、让位视觉不穿越群组边界；卡头本身可为落点（组首）。 */
function SortableGroupHeader({ id, ...props }: { id: string; text: string; done: number; total: number }) {
  const { setNodeRef, transform, transition } = useSortable({ id, disabled: true });
  return <GroupHeader {...props} nodeRef={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} />;
}

/** 可拖曳任务列：拖曳监听只绑 ⠿ 把手——点击核取方块与文本不经过拖曳；点把手不切换勾选。 */
function SortableTaskRow({
  item,
  interactive,
  onToggle,
  onJumpDecision,
  open,
  onToggleOpen,
  highlight,
  rowRef,
}: {
  item: TaskItem;
  interactive: boolean;
  onToggle?: (ordinal: number, done: boolean, stableId?: string) => void;
  onJumpDecision?: (id: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  /** 「下一个未完成」的短暂高亮标记。 */
  highlight?: boolean;
  /** 列元素回报（定位卷动用）。 */
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  const checkboxId = useId();
  const label = rowLabelProps(checkboxId, interactive);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.ordinal,
  });
  return (
    <label
      ref={(el) => {
        setNodeRef(el);
        rowRef?.(el);
      }}
      htmlFor={label.htmlFor}
      onClick={label.onClick}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-highlight={highlight ? "true" : "false"}
      {...manualMark(item)}
      className={`${ROW_CLS} ${label.className} transition-colors ${rowSurface(item, interactive, highlight)} ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("tasks.drag").replace("{n}", String(item.ordinal))}
        className="mt-1 h-4 w-4 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-foreground"
        {...attributes}
        {...listeners}
        // 把手在 label 内：点击不得冒到列上触发勾选。
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </Button>
      <TaskRowBody
        item={item}
        checkboxId={checkboxId}
        disabled={!interactive}
        onToggle={onToggle}
        onJumpDecision={onJumpDecision}
        open={open}
        onToggleOpen={onToggleOpen}
      />
    </label>
  );
}

/** 交互任务清单：顶部批量工具列＋群组卡＋可勾选 checkbox＋⠿ 把手拖放排序，
 * 与 tasks.md 联动。 */
export function TaskList({
  markdown,
  onToggle,
  onReorder,
  busy,
  onDragActiveChange,
  readOnly,
  onSetAll,
  onJumpDecision,
  locate,
  onLocated,
}: TaskListProps) {
  const { t } = useI18n();
  const items = parseTaskDoc(markdown);
  const taskItems = items.filter((i): i is TaskItem => i.kind === "task");
  const [activeOrdinal, setActiveOrdinal] = useState<number | null>(null);
  // 列的展开（spec「任务群组标题与章节标签同款式」）：缺省未勾展开、已勾收合；列尾钮的手动选择以
  // taskKey 记在清单层——列因拖到别组或群组卡重建而重挂也不丢——连同当时的勾选状态。勾选状态一变，
  // 那笔就在同一次渲染内作废（不走 effect：避免勾下去先画一帧展开再收合）。没有稳定 ID 的任务以
  // 序数为键，手动选择留在原位置。
  const [manualOpen, setManualOpen] = useState<ReadonlyMap<string, { open: boolean; done: boolean }>>(new Map());
  const staleKeys = taskItems
    .filter((i) => {
      const m = manualOpen.get(taskKey(i));
      return m !== undefined && m.done !== i.done;
    })
    .map(taskKey);
  if (staleKeys.length > 0) {
    const next = new Map(manualOpen);
    staleKeys.forEach((k) => next.delete(k));
    setManualOpen(next);
  }
  const isOpen = (item: TaskItem) => manualOpen.get(taskKey(item))?.open ?? !item.done;
  const toggleOpen = (item: TaskItem) =>
    setManualOpen(new Map(manualOpen).set(taskKey(item), { open: !isOpen(item), done: item.done }));
  // 「下一个未完成」的短暂高亮（ordinal）；列元素表供定位卷动。
  const [highlightOrdinal, setHighlightOrdinal] = useState<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  // PointerSensor distance 8：位移门槛内的按放是点击，不启动拖曳（看板同款教训）。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const allDone = taskItems.length > 0 && taskItems.every((i) => i.done);

  // 卷到某列并短暂高亮——「下一个未完成」与页的「前往」共用。
  const highlightRow = (ordinal: number) => {
    rowRefs.current.get(ordinal)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightOrdinal(ordinal);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightOrdinal(null), 1600);
  };

  const locateNext = () => {
    const next = taskItems.find((i) => !i.done);
    if (next) highlightRow(next.ordinal);
  };

  // 页的定位请求：列在这一轮 commit 后已挂上 ref，effect 里卷动才找得到。
  useEffect(() => {
    if (!locate) return;
    highlightRow(locate.ordinal);
    onLocated?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate]);

  // n 快捷键（任务分页挂载中即作用；分页未激活时本组件未挂载，自然不抢键）。
  // 输入组件内打字不触发；无依赖数组＝每次渲染重挂，回呼永远读到最新解析结果。
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      locateNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 拖曳进行中按 Esc 只取消拖曳：PointerSensor 不标记已处理，Esc 会冒到详情页的关页快捷键。
  // 捕获阶段先标记，宿主的 window 监听见 defaultPrevented 即让路。
  useEffect(() => {
    if (activeOrdinal === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeOrdinal]);

  // 高亮计时器卸载清理。
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  if (items.length === 0) {
    return <div className="text-muted-foreground text-sm py-6">{t("tasks.empty")}</div>;
  }

  // 可拖排＝交互且宿主供拖排写回；capability 缺口（remote）时把手与 DndContext
  // 一并不上——绝不渲染点了没事的假 affordance。
  const sortable = !readOnly && onReorder !== undefined;

  // 列可回应点击＝非唯读且不在批量写回中（busy）。
  const interactive = !readOnly && !busy;
  const rowRef = (ordinal: number) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(ordinal, el);
    else rowRefs.current.delete(ordinal);
  };

  const renderRow = (item: TaskItem) =>
    !sortable ? (
      // 唯读或无拖排：无把手；交互时保留高亮与定位卷动（「下一个未完成」照常）。
      <PlainTaskRow
        key={`t-${taskKey(item)}`}
        item={item}
        interactive={interactive}
        onToggle={onToggle}
        onJumpDecision={onJumpDecision}
        open={isOpen(item)}
        onToggleOpen={() => toggleOpen(item)}
        highlight={highlightOrdinal === item.ordinal}
        rowRef={rowRef(item.ordinal)}
      />
    ) : (
      <SortableTaskRow
        key={`t-${taskKey(item)}`}
        item={item}
        interactive={interactive}
        onToggle={onToggle}
        onJumpDecision={onJumpDecision}
        open={isOpen(item)}
        onToggleOpen={() => toggleOpen(item)}
        highlight={highlightOrdinal === item.ordinal}
        rowRef={rowRef(item.ordinal)}
      />
    );

  // 依群组标题切成卡（design D5）：第一个标题之前的任务为无卡头清单；卡头 id 沿用
  // `g-<items 索引>`，拖放落点解析（resolveDropTarget）不动。
  const segments: { index: number | null; text: string; tasks: TaskItem[] }[] = [];
  items.forEach((item, i) => {
    if (item.kind === "group") segments.push({ index: i, text: item.text, tasks: [] });
    else {
      if (segments.length === 0) segments.push({ index: null, text: "", tasks: [] });
      segments[segments.length - 1].tasks.push(item);
    }
  });
  const rows = (
    <div className="flex flex-col gap-3">
      {segments.map((seg) => {
        if (seg.index === null) {
          return (
            <div key="lead" className="flex flex-col">
              {seg.tasks.map(renderRow)}
            </div>
          );
        }
        const header = { text: seg.text, done: seg.tasks.filter((x) => x.done).length, total: seg.tasks.length };
        return (
          <Card key={`g-${seg.index}`} size="nested" data-task-group>
            {sortable ? <SortableGroupHeader id={`g-${seg.index}`} {...header} /> : <GroupHeader {...header} />}
            {seg.tasks.length > 0 && <div className="flex flex-col px-2 py-1.5">{seg.tasks.map(renderRow)}</div>}
          </Card>
        );
      })}
    </div>
  );

  // 唯读（封存查看）：无工具列、无把手、无 DndContext。
  if (readOnly) return rows;

  // 工具列键共通样式（design D3：ghost＋sm 变体，补齐近似现状的字级与字色）。
  const toolbarBtn = "gap-1.5 px-2 text-sm font-normal text-muted-foreground hover:text-foreground";
  const active = activeOrdinal != null ? taskItems.find((t) => t.ordinal === activeOrdinal) : null;
  // 让位串行＝视觉顺序（标题与任务交错）——标题入列使让位位移对齐群组边界。
  const sortableIds = items.map((item, i) => (item.kind === "group" ? `g-${i}` : item.ordinal));

  const handleDragStart = (e: DragStartEvent) => {
    setActiveOrdinal(Number(e.active.id));
    onDragActiveChange?.(true);
  };
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveOrdinal(null);
    // 放开即结束手势；同一事件内 onReorder 会使宿主进入写回 busy，让路无缝接手。
    onDragActiveChange?.(false);
    const { active: a, over } = e;
    if (!over) return;
    const target = resolveDropTarget(items, Number(a.id), over.id as number | string);
    if (!target) return;
    onReorder?.(Number(a.id), target.to, target.before);
  };

  /* 批量操作工具列（spec「任务分页提供批量操作工具列」）：全部已完成／下一个
     未完成（n）／重置任务；全完成时前两键不可用，批量写回期间整列 disabled。 */
  const toolbar = (
    <>
    <p className="mb-1.5 text-xs text-muted-foreground">{t(sortable ? "detail.tasksHint" : "detail.tasksHintToggle")}</p>
    <div className="mb-2 flex items-center gap-1 rounded-md border border-border px-2 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={toolbarBtn}
        disabled={allDone || busy}
        onClick={() => onSetAll?.(true)}
      >
        <CheckCheck className="h-3.5 w-3.5" /> {t("tasks.completeAll")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={toolbarBtn}
        disabled={allDone || busy}
        onClick={locateNext}
      >
        <LocateFixed className="h-3.5 w-3.5" /> {t("tasks.nextUndone")}
        <kbd className="rounded border border-border bg-muted px-1 text-[10px] text-muted-foreground">
          n
        </kbd>
      </Button>
      <div className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={toolbarBtn}
        disabled={busy}
        onClick={() => onSetAll?.(false)}
      >
        <RotateCcw className="h-3.5 w-3.5" /> {t("tasks.resetAll")}
      </Button>
    </div>
    </>
  );

  // 拖排停用（capability 缺口）：工具列与勾选照常、不挂 DndContext。
  if (!sortable) {
    return (
      <>
        {toolbar}
        <div className={`flex flex-col ${busy ? "opacity-60 pointer-events-none" : ""}`}>{rows}</div>
      </>
    );
  }

  return (
    <>
      {toolbar}
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveOrdinal(null);
        onDragActiveChange?.(false);
      }}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className={`flex flex-col ${busy ? "opacity-60 pointer-events-none" : ""}`}>{rows}</div>
      </SortableContext>
      {/* DragOverlay：浮起列逃出抽屉卷动容器的 overflow 裁切（看板同款）。 */}
      <DragOverlay>
        {active ? (
          <div className="flex items-start gap-2 py-1 pl-1 rounded-md border border-border bg-card shadow-lg">
            <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/50">
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <TaskRowBody item={active} titleOnly />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
    </>
  );
}

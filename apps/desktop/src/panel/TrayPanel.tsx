// 面板样式呈现层（spec「面板样式」；design D5）：主窗口推送的
// TraySnapshot 薄渲染——分区内容与原生菜单同源（同一 store 快照），不自建
// 数据查找路径。原生质感（vibrancy、不抢焦点、失焦收合、高度自适应）由
// Rust 侧面板窗口与入口层承担，此组件只负责结构与回调；拷贝钮常驻列尾、
// 分区图标沿用看板同款（KanbanBoard 的 stage 图标）。
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Button,
  changeStage,
  CopyButton,
  DISCUSSION_TONE,
  planBlockedBy,
  planBlockedLabel,
  planWave,
  planWaveLabel,
  REVIEW_ICON,
  REVIEW_LABEL_KEY,
  REVIEW_TONE,
  RowSkeleton,
  SEMANTIC_SURFACE,
  SEMANTIC_TONE,
  STAGE_BADGE,
  STAGE_BAR,
  STAGE_ICON,
  STAGES,
  VERIFY_ICON,
  VERIFY_LABEL_KEY,
  VERIFY_TONE,
  cn,
  SectionHeader,
  useI18n,
  type ChangeItem,
  type Stage,
} from "@specseal/ui";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  CircleCheckBig,
  Cloud,
  CloudOff,
  Folder,
  GitBranch,
  Hammer,
  Lightbulb,
  LoaderCircle,
  LogIn,
  MessageSquareText,
  Plus,
  Power,
  RefreshCw,
  Server,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import {
  ADD_TILE,
  PROJECT_TILE_ACTIVE,
  PROJECT_TILE_IDLE,
  RAIL_SQUARE,
  projectInitial,
} from "../components/projectTile";
import { OVERFLOW_LIMIT, type TraySnapshot, type TrayTabSnapshot } from "../tray";
import type { Platform } from "../platform";
import { readTrayPromotedExpanded, writeTrayPromotedExpanded } from "./promotedExpanded";
import {
  readTrayCollapsedSections,
  writeTrayCollapsedSections,
  type TraySectionId,
} from "./sectionCollapse";
import { tabRevealScrollLeft } from "./tabStrip";
import { edgeFade, edgeFadeMask, type EdgeFadeSide, type ScrollMetrics } from "./edgeFade";

/** 分区图标与看板字段同款（KanbanBoard）：提案中／进行中／已就绪。 */
const STAGE_ICONS: Record<Stage, LucideIcon> = {
  proposed: Lightbulb,
  "in-progress": Hammer,
  ready: CircleCheckBig,
};

export interface TrayPanelProps {
  /** 主窗口推送的快照；null＝尚未收到（lazy 建窗后的短暂空窗）。 */
  snapshot: TraySnapshot | null;
  /** 面板所在平台（tray-panel-windows design D2）：只决定根层外观——macOS 为毛玻璃补光
      与 13px 圆角，Windows 为不透明侧栏底色、不画圆角；其余呈现不分平台。 */
  platform: Platform;
  onOpenProject: (key: string) => void;
  onOpenChange: (name: string) => void;
  onOpenDiscussion: (slug: string) => void;
  onOpenApp: () => void;
  /** 开主窗口并切至作用中项目的项目设置页（动作区「项目设置」；与原生菜单同语意）。 */
  onOpenProjectSettings: () => void;
  /** 开主窗口并切至设置页（动作区「设置」；与原生菜单同语意）。 */
  onOpenSettings: () => void;
  /** 结束 app（动作区「结束」；面板端经 Rust 命令结束行程）。 */
  onQuit: () => void;
  /** 拷贝回调（面板入口接 clipboard 插件——Rust 端，不受焦点限制）。 */
  onCopy: (text: string) => void;
  /** 快速加入项目（design D7）：开文件夹选择器，选定即加入并切换、取消无事。 */
  onAddProject: () => void;
  /** 原地 retry：只回流主窗口 store，不显示或聚焦主窗口。 */
  onRetryWorkspace: (key: string) => void;
  /** 显式在主窗口显示对应 recovery destination。 */
  onOpenRecovery: (key: string) => void;
  /** 显式显示并聚焦对应 connection 的服务器设置。 */
  onOpenServerSettings: (connectionId: string) => void;
  /** 显式显示并聚焦对应 connection 的登录流程。 */
  onReauthenticate: (connectionId: string) => void;
}

/** 分区卡标头（tray-panel-restyle design D2）：12px 粗体前景色；其下有内容（列、骨架、
    失败提示、收合列）才画细线——空状态卡只有标头，不留一条孤线。 */
const sectionHeaderClass = (hasBody: boolean) =>
  cn("px-3 py-2 text-foreground", hasBody && "border-b border-border/70");

/** 面板卡片（spec「面板样式」；tray-panel-restyle design D1）：白底细框 12px
    圆角卡叠在补光层上——tab 条、各分区、动作区各一张。overflow-hidden 让最后一列的
    hover 底色被卡角裁切。 */
function PanelCard({
  testid,
  className,
  children,
}: {
  testid: string;
  /** 附加样式（空状态卡的最小高度与垂直置中，design D8）。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testid}
      className={cn("flex flex-col overflow-hidden rounded-xl border border-border bg-card", className)}
    >
      {children}
    </section>
  );
}

/** 空状态分区卡附加样式（design D8）：最小高度＋内容垂直置中——生命周期
    零笔阶段卡与讨论零笔卡共用，维持空状态同构。 */
const emptyCardClass = "min-h-12 justify-center";

/** role="button" 的 div 补上 Enter／Space 切换（与原生 button 一致：按住不放的自动重复不再切换）。 */
const toggleOnKey = (toggle: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (!event.repeat) toggle();
  }
};

/** 分区的加载状态（design D3）：四张内容卡同一个答案，由 store 导出的旗标换算。 */
type SectionLoad = "loading" | "failed" | "ready";

/**
 * 可收合的内容卡（spec「面板内容卡收合」）：生命周期三卡、讨论卡与已转出卡共用。
 * 整条分区标题为触发区（role="button"、tabIndex=-1、Enter／Space），
 * 箭头放 SectionHeader 的 action 插槽、在计数之后（展开朝下、收合朝右）。收合时只留
 * 标题一行——其下内容卸载（溢出列的展开暂态随之归零），不套空状态最小高度、标题下
 * 不画细线。
 *
 * 加载状态由卡片统一换算：加载中为占位列、失败为失败提示，两者都不出计数（不谎报 0）；
 * 有料时才显示 count 与 children。empty＝有料时其下也没有内容的空状态卡。
 */
function SectionCard({
  id,
  collapsed,
  onToggle,
  load,
  icon,
  label,
  count,
  countClassName,
  empty,
  children,
}: {
  /** 只用来组 testid；"promoted" 不属于收合集合（已转出卡的展开状态另存）。 */
  id: TraySectionId | "promoted";
  collapsed: boolean;
  onToggle: () => void;
  load: SectionLoad;
  icon: ReactNode;
  label: string;
  count: number;
  /** 未给为中性（Badge 的 secondary 变体），同 SectionHeader。 */
  countClassName?: string;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ready = load === "ready";
  const isEmpty = ready && empty;
  return (
    <PanelCard
      testid={`panel-section-${id}`}
      className={!collapsed && isEmpty ? emptyCardClass : undefined}
    >
      <div
        data-testid="panel-section-toggle"
        role="button"
        aria-expanded={!collapsed}
        tabIndex={-1}
        onClick={onToggle}
        onKeyDown={toggleOnKey(onToggle)}
      >
        <SectionHeader
          icon={icon}
          label={label}
          count={ready ? count : undefined}
          countClassName={countClassName}
          action={
            <ChevronRight
              className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")}
            />
          }
          className={sectionHeaderClass(!collapsed && !isEmpty)}
        />
      </div>
      {!collapsed &&
        (load === "loading" ? (
          <SectionSkeleton />
        ) : load === "failed" ? (
          <SectionLoadFailed label={t("tray.loadFailed")} />
        ) : (
          children
        ))}
    </PanelCard>
  );
}

/** 分区加载失败的终态列（spec「面板分区加载失败终态」）：读不到 ≠ 确认是空的，
    故不走空状态文案；亦不留骨架——加载已经结束了。 */
function SectionLoadFailed({ label }: { label: string }) {
  return (
    <div
      data-testid="panel-section-load-failed"
      role="status"
      className="flex min-h-8 items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground"
    >
      <CloudOff className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </div>
  );
}

/** 分区加载中的占位列组（design D5）：两列即读得出「有内容正在载」。 */
function SectionSkeleton() {
  return (
    <>
      <RowSkeleton />
      <RowSkeleton />
    </>
  );
}

/** 卷动停止后指示条淡出的延迟（ms）——比照 macOS overlay 滚动条的滞留时间。 */
const SCROLL_IDLE_MS = 800;

/**
 * 监看可卷区的卷动量测（tab 条与中段共用）：立即回报一次，之后于卷动时（scrolled=true）与
 * 可卷区或其直接子节点尺寸改变时（scrolled=false）再回报——中段的内容 wrapper 随收合与快照
 * 增减改变高度，可卷区本身被 flex 约束、外框不变。回传解除监看的函数。
 */
function watchScroll(
  el: HTMLElement,
  axis: "x" | "y",
  onMeasure: (metrics: ScrollMetrics, scrolled: boolean) => void,
): () => void {
  const measure = (scrolled: boolean) =>
    onMeasure(
      axis === "x"
        ? { position: el.scrollLeft, scrollSize: el.scrollWidth, viewportSize: el.clientWidth }
        : { position: el.scrollTop, scrollSize: el.scrollHeight, viewportSize: el.clientHeight },
      scrolled,
    );
  const onScroll = () => measure(true);
  const observer = new ResizeObserver(() => measure(false));
  measure(false);
  el.addEventListener("scroll", onScroll, { passive: true });
  observer.observe(el);
  for (const child of Array.from(el.children)) observer.observe(child);
  return () => {
    el.removeEventListener("scroll", onScroll);
    observer.disconnect();
  };
}

/** 遮罩挂在可卷区本身（不随内容卷动）；WebKit 仍认前缀属性，两个都给。 */
const edgeFadeStyle = (axis: "x" | "y", side: EdgeFadeSide) => {
  const mask = edgeFadeMask(axis, side);
  return { maskImage: mask, WebkitMaskImage: mask };
};

/**
 * 可卷中段（spec 三段式版面）：生命周期／讨论分区或复原卡；卷动面自 body 收敛至此容器，
 * overscroll-none 随迁防 rubber-band。一次监看同时供上下缘淡出与卷动指示条：
 * - 上下缘依是否还有被卷走的内容淡出（design「中段上下缘淡出：与 tab 条共用边缘淡出」），
 *   卡片不会在页眉／页脚边缘被硬切；遮罩挂在卷动容器上，指示条与页眉页脚都在它之外、不被淡出。
 * - 卷动指示条（spec：卷动时浮现、停止后自动隐去、不占版面宽度）自绘而非用原生滚动条——系统
 *   「总是显示滚动条」偏好会让原生滚动条常驻且占宽、无法淡出，而 spec 要求此行为不依赖系统偏好。
 *   内容未溢出时不渲染；指示条为卷动容器的兄弟节点，才不会随内容一起卷走。
 * 内层 wrapper 保持自然高度，入口层的 ResizeObserver 观察的是这层（高度量测依据）。卷动时只有
 * 本组件重绘：卡片是上层传入的 children，不随卷动重绘。
 */
function PanelScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<EdgeFadeSide>("none");
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unwatch = watchScroll(el, "y", (metrics, scrolled) => {
      setFade(edgeFade(metrics));
      const { position, scrollSize, viewportSize } = metrics;
      if (scrollSize <= viewportSize) {
        setThumb(null);
      } else {
        const height = Math.max(24, (viewportSize / scrollSize) * viewportSize);
        const top = (viewportSize - height) * (position / (scrollSize - viewportSize));
        setThumb({ top, height });
      }
      if (scrolled) {
        setActive(true);
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => setActive(false), SCROLL_IDLE_MS);
      }
    });
    return () => {
      unwatch();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        data-testid="panel-scroll"
        data-fade={fade}
        style={edgeFadeStyle("y", fade)}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div data-testid="panel-scroll-content" className="flex flex-col gap-2">
          {children}
        </div>
      </div>
      {thumb && (
        <div
          aria-hidden
          data-testid="panel-scroll-indicator"
          data-active={active ? "true" : "false"}
          className={cn(
            "pointer-events-none absolute right-0.5 w-1 rounded-full bg-foreground/35 transition-opacity duration-300",
            active ? "opacity-100" : "opacity-0",
          )}
          style={{ top: thumb.top, height: thumb.height }}
        />
      )}
    </div>
  );
}

/** 卡内的列（design D2）：细线分隔、hover 整列半透明前景色灰底——列内符号维持本色。
    变更列、讨论列与溢出列共用。 */
const rowClass =
  "flex w-full items-center gap-2 border-b border-border/70 px-3 py-1.5 text-left last:border-b-0 hover:bg-foreground/5";

/** 动作区块卡的按钮（文本钮与图标钮共用）：hover 半透明前景色灰底，与面板列同语汇。 */
const actionButtonClass = "flex items-center rounded-lg hover:bg-foreground/5";

/** 动作区块卡的图标钮：名称走 aria-label＋原生 title——面板是无焦点的一瞥接口，
    挂 Radix Tooltip 会多一层 portal 与焦点管理（同站章 tooltip 的做法）。 */
function ActionIconButton({
  label,
  Icon,
  onClick,
}: {
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(actionButtonClass, "h-7 w-7 shrink-0 justify-center text-muted-foreground")}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/** 分区溢出（spec「分区溢出折叠」）：直列前 5、其余收进「还有 N 个…」可展开列。 */
function OverflowGroup({
  rows,
  moreLabel,
  collapseLabel,
}: {
  rows: ReactNode[];
  moreLabel: (n: number) => string;
  collapseLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length <= OVERFLOW_LIMIT) return <>{rows}</>;
  return (
    <>
      {rows.slice(0, OVERFLOW_LIMIT)}
      {expanded && rows.slice(OVERFLOW_LIMIT)}
      <div className={rowClass} onClick={() => setExpanded((v) => !v)}>
        <span className="text-[12px] text-muted-foreground">
          {expanded ? collapseLabel : moreLabel(rows.length - OVERFLOW_LIMIT)}
        </span>
      </div>
    </>
  );
}

/** 项目 tab 与「加入项目」共用的直栏容器（方块＋其下文本，hover 灰底）。 */
const TAB_ITEM = "flex shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 hover:bg-foreground/5";

function tabStatusLabel(tab: TrayTabSnapshot, t: (key: string) => string): string {
  if (tab.source === "local") return "";
  if (tab.status === "restoring") return t("tray.recovery.restoring");
  if (tab.status === "offline") return t("tray.recovery.offline");
  if (tab.status === "needs-reauth" || tab.failureKind === "needs-reauth") {
    return t("tray.recovery.needsReauth");
  }
  if (tab.failureKind === "access-denied") return t("tray.recovery.accessDenied");
  if (tab.failureKind === "not-found") return t("tray.recovery.notFound");
  if (tab.failureKind === "unknown") return t("tray.recovery.unknown");
  if (tab.status === "error") return t("tray.recovery.unreachable");
  return "";
}

/**
 * 分页状态文本的语意色（spec「接口状态语意色分层」）：选取由首字母方块承载，
 * 状态则由方块下这行文本承载——还原中＝蓝、脱机／需重新登录＝琥珀警示、
 * 连不上＝红。无状态文本的本机分页走中性。
 */
function tabStatusTone(tab: TrayTabSnapshot): string {
  if (tab.source === "local") return "text-muted-foreground";
  if (tab.status === "restoring") return SEMANTIC_TONE.inProgress;
  if (tab.status === "offline" || tab.status === "needs-reauth" || tab.failureKind === "needs-reauth") {
    return SEMANTIC_TONE.warning;
  }
  if (tab.status === "error") return SEMANTIC_TONE.danger;
  return "text-muted-foreground";
}

function RemoteTabIcon({ tab }: { tab: Extract<TrayTabSnapshot, { source: "remote" }> }) {
  if (tab.status === "restoring") {
    return <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />;
  }
  if (tab.status === "offline") return <CloudOff className="h-4 w-4" />;
  if (tab.status === "needs-reauth" || tab.failureKind === "needs-reauth") {
    return <LogIn className="h-4 w-4" />;
  }
  if (tab.status === "error") return <AlertTriangle className="h-4 w-4" />;
  return <Cloud className="h-4 w-4" />;
}

function PanelRecoveryCard({
  tab,
  onRetry,
  onOpenRecovery,
  onOpenServerSettings,
  onReauthenticate,
}: {
  tab: Extract<TrayTabSnapshot, { source: "remote" }>;
  onRetry: () => void;
  onOpenRecovery: () => void;
  onOpenServerSettings: () => void;
  onReauthenticate: () => void;
}) {
  const { t } = useI18n();
  const restoring = tab.status === "restoring";
  const needsReauth = tab.failureKind === "needs-reauth";
  const summary = tabStatusLabel(tab, t);
  // 卡面依状态分色：还原中＝进行中的蓝、需重新登录＝警示琥珀、其余失败＝错误红。
  // （旧版一律涂琥珀，连不上与「等一下就好」看起来一样严重。）
  const tone = restoring ? "inProgress" : needsReauth ? "warning" : "danger";
  return (
    <section
      data-testid="panel-recovery-card"
      data-status={tab.status}
      role="status"
      aria-live="polite"
      // 白卡（tray-panel-restyle design D5），只借语意色的边框——故 surface 之后再盖回白底。
      className={cn("rounded-xl border p-3", SEMANTIC_SURFACE[tone], "bg-card")}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            SEMANTIC_SURFACE[tone],
            SEMANTIC_TONE[tone],
          )}
        >
          {restoring ? (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : needsReauth ? (
            <LogIn className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0">
          <div className="font-semibold">{summary}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{tab.name}</div>
        </div>
      </div>

      <dl className="mt-3 grid gap-2 rounded-lg bg-muted/50 p-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <Cloud className="h-3 w-3 shrink-0 text-muted-foreground" />
          <dt className="text-muted-foreground">{t("tray.recovery.workspace")}</dt>
          <dd className="ml-auto truncate font-medium">{tab.name}</dd>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
          <dt className="text-muted-foreground">{t("tray.recovery.server")}</dt>
          <dd className="ml-auto truncate font-medium">
            {tab.source === "remote" ? tab.serverLabel : ""}
            {tab.serverOrigin ? ` · ${tab.serverOrigin}` : ""}
          </dd>
        </div>
      </dl>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {!restoring &&
          (needsReauth ? (
            <Button size="sm" tabIndex={-1} onClick={onReauthenticate} className="col-span-2">
              <LogIn className="h-3.5 w-3.5" />
              {t("tray.recovery.reauthenticate")}
            </Button>
          ) : (
            <Button size="sm" tabIndex={-1} onClick={onRetry} className="col-span-2">
              <RefreshCw className="h-3.5 w-3.5" />
              {t("tray.recovery.retry")}
            </Button>
          ))}
        <Button variant="outline" size="sm" tabIndex={-1} onClick={onOpenRecovery}>
          <ArrowUpRight className="h-3 w-3" />
          {t("tray.recovery.open")}
        </Button>
        <Button variant="outline" size="sm" tabIndex={-1} onClick={onOpenServerSettings}>
          <Settings className="h-3 w-3" />
          {t("tray.recovery.settings")}
        </Button>
      </div>
    </section>
  );
}

export function TrayPanel({
  snapshot,
  platform,
  onOpenProject,
  onOpenChange,
  onOpenDiscussion,
  onOpenApp,
  onOpenProjectSettings,
  onOpenSettings,
  onQuit,
  onCopy,
  onAddProject,
  onRetryWorkspace,
  onOpenRecovery,
  onOpenServerSettings,
  onReauthenticate,
}: TrayPanelProps) {
  const { t } = useI18n();
  const tabStripRef = useRef<HTMLDivElement>(null);
  // 已转出卡的展开状态（design D4）：面板 webview 只建一次，重启 app 后由本机记忆读回。
  const [promotedExpanded, setPromotedExpanded] = useState(readTrayPromotedExpanded);
  const togglePromoted = () => {
    const next = !promotedExpanded;
    setPromotedExpanded(next);
    writeTrayPromotedExpanded(next);
  };
  const moreLabel = (n: number) => t("tray.more").replace("{n}", String(n));
  const discussionRow = (d: { slug: string; topic: string }) => (
    <DiscussionRow key={d.slug} d={d} onOpen={onOpenDiscussion} onCopy={onCopy} copyLabel={t("tray.copySlug")} />
  );
  const collapseLabel = t("tray.collapse");
  // 内容卡收合（spec「面板内容卡收合」）：本机记忆、所有项目共用一份——切换项目与快照更新
  // 都不改它，只有点击会改（收合中的卡有新项目也不自动展开）。
  const [collapsedSections, setCollapsedSections] = useState(readTrayCollapsedSections);
  const toggleSection = (id: TraySectionId) => {
    const next = new Set(collapsedSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedSections(next);
    writeTrayCollapsedSections(next);
  };
  // 收合状态与切换由分区 id 从同一份收合集合推出：调用端只写一次 id。
  const sectionCollapse = (id: TraySectionId) => ({
    id,
    collapsed: collapsedSections.has(id),
    onToggle: () => toggleSection(id),
  });
  const tabs = snapshot?.tabs ?? [];
  const changes = snapshot?.changes ?? [];
  const discussions = snapshot?.discussions ?? [];
  const openDiscussions = discussions.filter((d) => !d.promoted);
  const promotedDiscussions = discussions.filter((d) => d.promoted);
  const staged = STAGES.map((stage) => ({
    stage,
    Icon: STAGE_ICONS[stage],
    items: changes.filter((c) => changeStage(c) === stage),
  }));
  const pendingTabKey = snapshot?.pendingTabKey ?? null;
  // 首访加载中：分区以占位列呈现。条件整条由 store 导出（design D3）——面板
  // 不自行组合旗标，与主窗口看板恒为同一个答案。快照未到（null）同样算加载
  // 中——面板刚开、主窗口尚未推第一份快照，此时画空分区与画占位列是同一个问题。
  // 首访加载失败的终态：加载已结束（故不与骨架并存），但没有真值可画——
  // 显示失败提示而非空态文案。
  const sectionLoad: SectionLoad =
    !snapshot || snapshot.workspaceLoading ? "loading" : snapshot.workspaceLoadFailed ? "failed" : "ready";
  const activeKey = snapshot?.activeKey ?? null;

  // tab 条左右淡出（design「项目 tab 条：「＋」固定右端、边缘淡出、卷到作用中」）：tab 尺寸
  // 固定，改在 tab 清单改变时重新监看——新 tab 才被观察，且立即重算一次。
  const [tabFade, setTabFade] = useState<EdgeFadeSide>("none");
  const tabKeys = tabs.map((tab) => tab.key).join("\n");
  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    return watchScroll(strip, "x", (metrics) => setTabFade(edgeFade(metrics)));
  }, [tabKeys]);

  // 卷到作用中 tab：作用中项目改变时；面板窗口只建一次、之后隐藏／显示，再次打开时
  // 面板取得焦点，也卷一次。直接设 scrollLeft 而非 scrollIntoView——后者会连带卷动外层。
  useLayoutEffect(() => {
    const strip = tabStripRef.current;
    if (!strip || activeKey === null) return;
    const reveal = () => {
      const tab = strip.querySelector<HTMLElement>('[role="tab"][data-active="true"]');
      if (!tab) return;
      strip.scrollLeft = tabRevealScrollLeft({
        tabLeft: tab.offsetLeft,
        tabWidth: tab.offsetWidth,
        scrollLeft: strip.scrollLeft,
        viewportWidth: strip.clientWidth,
      });
    };
    reveal();
    window.addEventListener("focus", reveal);
    return () => window.removeEventListener("focus", reveal);
  }, [activeKey]);

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeRecovery =
    activeTab?.status === "restoring" || activeTab?.status === "error" ? activeTab : null;
  const activeStale =
    activeTab?.status === "offline" || activeTab?.status === "needs-reauth"
      ? activeTab
      : null;

  return (
    // macOS 补光层（tray-panel-content-priority「毛玻璃找回」）：HudWindow（NSVisualEffectView
    // 旧世代）无亮度自适应——卡内亮度改由不透明白卡锚定，根层只铺侧栏面色约六成（随深浅
    // 模式），毛玻璃自外框与卡片缝隙透出约四成（九成时几乎看不见）。六成是当初针对深色
    // 背景实测的浓度。圆角 13px 与 Rust 侧 apply_vibrancy 半径一致——补光画出圆角外会在
    // 顶角留下方形残料。Windows（tray-panel-windows design D1／D2）窗口不透明、无毛玻璃，
    // 根层铺不透明侧栏面色；圆角由 Windows 11 系统画，面板不自绘。
    // h-screen 撑满窗口：三段式版面的中段（flex-1）才有约束高度。
    // 卡与卡之间只以 gap 分隔，不画分割线。
    <div
      data-testid="panel-root"
      className={cn(
        "flex h-screen flex-col gap-2 p-2 text-[13px] text-foreground",
        platform === "windows" ? "bg-sidebar" : "rounded-[13px] bg-sidebar/60",
      )}
    >
      {/* 固定页眉（spec 三段式版面）：tab 条卡常驻、不随内容卷动。 */}
      <div data-testid="panel-header" className="shrink-0">
      <PanelCard testid="panel-project-card">
      <div className="flex">
      {/* 项目 tab 条（spec「面板样式」；tray-panel-restyle design D3）：首字母
          方块与主窗口图标列同形（取 projectTile 同一份常数，作用中实心主色）＋其下项目名，
          超宽横向卷动且隐藏滚动条，有 tab 被遮住的一侧以遮罩淡出；点 tab 沿用 open-project
          原地切换语意（不唤主窗口）。刻意用 div 非 button——面板中唯一可 tab 元素会吃到
          WebKit 的缺省焦点（design D4）。relative 让 tab 的 offsetLeft 以可卷区为基准
          （卷到作用中 tab 的计算依此）。 */}
      <div
        ref={tabStripRef}
        data-testid="panel-project-tabs"
        data-fade={tabFade}
        role="tablist"
        aria-label={t("app.projectRail")}
        style={edgeFadeStyle("x", tabFade)}
        className="relative flex min-w-0 flex-1 gap-1 overflow-x-auto p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
          {tabs.map((tab) => {
            // 识别与切换把手皆为 locator key（workspace-session 决策 6）。
            const active = tab.key === snapshot?.activeKey;
            return (
              <div
                key={tab.key}
                data-testid={`panel-project-${tab.key}`}
                data-active={active ? "true" : "false"}
                data-status={tab.status}
                role="tab"
                aria-selected={active}
                aria-label={`${tab.name}${
                  tab.key === pendingTabKey
                    ? `，${t("app.tabSwitching")}`
                    : tabStatusLabel(tab, t)
                      ? `，${tabStatusLabel(tab, t)}`
                      : ""
                }`}
                tabIndex={-1}
                onClick={() => onOpenProject(tab.key)}
                // 名称在方块下会截断（max-w-14），title 带出全名。
                title={tab.name}
                className={cn(TAB_ITEM, "w-16")}
              >
                {/* 选取只由方块承载：作用中不论 ready／restoring／error 皆实心主色（与图标列一致），
                    状态交给其下状态文本的语意色。 */}
                <span
                  aria-hidden
                  data-project-tile
                  className={cn(RAIL_SQUARE, active ? PROJECT_TILE_ACTIVE : PROJECT_TILE_IDLE)}
                >
                  {/* 切换中盖过首字母：探测挡在翻页前，此处是用户唯一的「有在动」信号。 */}
                  {tab.key === pendingTabKey ? (
                    <LoaderCircle
                      data-tab-pending="true"
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    />
                  ) : tab.source === "remote" ? (
                    <RemoteTabIcon tab={tab} />
                  ) : (
                    projectInitial(tab.name)
                  )}
                </span>
                <span
                  className={cn(
                    "max-w-14 truncate text-[11px] leading-none",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {tab.name}
                </span>
                {tab.source === "remote" && tab.status !== "ready" && (
                  <span className={cn("max-w-14 truncate text-[9px] leading-none", tabStatusTone(tab))}>
                    {tabStatusLabel(tab, t)}
                  </span>
                )}
              </div>
            );
          })}
      </div>
        {/* 快速加入项目（design D7）：固定在 tab 条卡右端、不随 tab 卷走——项目再多也看得到；
            位置与主窗口图标列「项目在前、＋在后」同序。与项目 tab 同构：虚线框「＋」（与
            图标列同形）＋其下名称——只留图标在一排带名称的 tab 旁显得突兀。文本不截断：
            英文「Add project」比项目 tab 宽，这一项跟着文本长（min-w 与项目 tab 对齐）。
            外层 py-1.5 对齐可卷区内距，「＋」与首字母方块同高。 */}
        <div className="shrink-0 py-1.5 pr-1.5">
          <div
            data-testid="panel-add-project"
            title={t("tray.addProject")}
            aria-label={t("tray.addProject")}
            onClick={onAddProject}
            className={cn(TAB_ITEM, "group min-w-16")}
          >
            <span
              aria-hidden
              data-project-tile
              className={cn(RAIL_SQUARE, ADD_TILE, "group-hover:bg-muted group-hover:text-foreground")}
            >
              <Plus className="h-4 w-4" />
            </span>
            <span className="whitespace-nowrap text-[11px] leading-none text-muted-foreground">
              {t("tray.addProject")}
            </span>
          </div>
        </div>
      </div>
      </PanelCard>
      </div>

      {/* 可卷中段（spec 三段式版面）：生命周期／讨论分区或复原卡。 */}
      <PanelScrollArea>
      {activeRecovery ? (
        <PanelRecoveryCard
          tab={activeRecovery}
          onRetry={() => onRetryWorkspace(activeRecovery.key)}
          onOpenRecovery={() => onOpenRecovery(activeRecovery.key)}
          onOpenServerSettings={() => onOpenServerSettings(activeRecovery.connectionId)}
          onReauthenticate={() => onReauthenticate(activeRecovery.connectionId)}
        />
      ) : (
        <>
          {activeStale && (
            <div
              data-testid="panel-stale-status"
              role="status"
              // 琥珀淡底卡（design D5）：与项目栏的提示卡同语意，保留淡底而非白卡。
              className={cn(
                "flex min-h-8 items-center gap-2 rounded-xl border px-3 py-2 text-[11px]",
                SEMANTIC_SURFACE.warning,
              )}
            >
              <CloudOff className={cn("h-3.5 w-3.5 shrink-0", SEMANTIC_TONE.warning)} />
              <span className="font-medium">{tabStatusLabel(activeStale, t)}</span>
              <span className="ml-auto text-muted-foreground">{t("tray.recovery.stale")}</span>
              {activeStale.status === "needs-reauth" && (
                // 中性 outline：警示由整列的琥珀底承载，按钮再涂琥珀只会两片颜色互抢。
                <Button
                  variant="outline"
                  size="sm"
                  tabIndex={-1}
                  onClick={() => onReauthenticate(activeStale.connectionId)}
                >
                  {t("tray.recovery.reauthenticate")}
                </Button>
              )}
            </div>
          )}

      {/* 生命周期分区：三阶段分区卡常驻（工作站常驻、衍生群组有料才现）——
          零笔阶段呈标题＋计数 0 的空状态卡（与讨论分区同构，design D8），
          分区位置固定不随数据增减跳动；原生菜单的全空占位文案不在此重现。
          生命周期在前、讨论在后（与原生菜单同序）：讨论一多也不会把三个阶段挤出第一屏。 */}
      {staged.map(({ stage, Icon, items }) => (
        <SectionCard
          key={stage}
          {...sectionCollapse(stage)}
          load={sectionLoad}
          icon={<Icon className={cn("h-3.5 w-3.5", STAGE_ICON[stage])} />}
          label={t(`stage.${stage}`)}
          count={items.length}
          countClassName={STAGE_BADGE[stage]}
          empty={items.length === 0}
        >
          <OverflowGroup
            moreLabel={moreLabel}
            collapseLabel={collapseLabel}
            rows={items.map((c) => (
              <ChangeRow
                key={c.name}
                c={c}
                stage={stage}
                onOpen={onOpenChange}
                onCopy={onCopy}
                copyLabel={t("tray.copyName")}
              />
            ))}
          />
        </SectionCard>
      ))}

      {/* 讨论卡（spec「讨论列表」）：计数与空状态只看讨论中，「还有 N 个…」是卡内最后一列。
          slug 为题、topic 为描述（识别锚点惯例，与看板讨论卡一致）。四种状态（加载中、失败、
          有料、空）共用同一标题，只差计数与其下内容：加载中为占位列、失败为失败提示（计数
          未知，不谎报 0）、空为计数 0 的空状态卡（与非空同构，design D8）。 */}
      <SectionCard
        {...sectionCollapse("discussions")}
        load={sectionLoad}
        icon={<MessageSquareText className={cn("h-3.5 w-3.5", DISCUSSION_TONE.icon)} />}
        label={t("tray.discussionsHeader")}
        count={openDiscussions.length}
        countClassName={DISCUSSION_TONE.badge}
        empty={openDiscussions.length === 0}
      >
        <OverflowGroup
          moreLabel={moreLabel}
          collapseLabel={collapseLabel}
          rows={openDiscussions.map(discussionRow)}
        />
      </SectionCard>

      {/* 已转出卡（spec「讨论列表」）：讨论卡正下方的独立卡，靠卡片间距与讨论中分开。
          收合外观与交互同其他内容卡，但展开状态走自己的记忆（缺省收合），不进收合集合。
          只在讨论清单 ready 且有料时呈现——加载中与失败时笔数未知，由讨论卡呈现占位或提示。
          图标与计数徽章为中性灰（desktop-app「接口状态语意色分层」）：徽章不传 countClassName，
          沿用 Badge 的 secondary 变体。不用 ArrowUpRight——页脚「打开 Specseal」已用同一图标。 */}
      {sectionLoad === "ready" && promotedDiscussions.length > 0 && (
        <SectionCard
          id="promoted"
          collapsed={!promotedExpanded}
          onToggle={togglePromoted}
          load="ready"
          icon={<MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />}
          label={t("tray.promotedHeader")}
          count={promotedDiscussions.length}
          empty={false}
        >
          <OverflowGroup
            moreLabel={moreLabel}
            collapseLabel={collapseLabel}
            rows={promotedDiscussions.map(discussionRow)}
          />
        </SectionCard>
      )}

        </>
      )}
      </PanelScrollArea>

      {/* 固定页脚（spec 三段式版面）：动作区卡常驻、不随内容卷动。
          动作区单列：「打开 Specseal」文本钮占满左侧（最常用、保留文本），右侧项目设置、
          设置、结束三颗图标钮（与原生菜单同序——项目层动作在前、app 层在后；图标沿用
          侧栏同款）；「设置」与「结束」之间以细直线分隔符隔开防误按——只留加宽空白看起来像
          排版出错。四颗皆 tabIndex=-1 退出 Tab 顺序（同拷贝钮）。 */}
      <div data-testid="panel-footer" className="shrink-0">
      <PanelCard testid="panel-actions-card">
      <div className="flex items-center gap-0.5 p-1">
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpenApp}
          className={cn(actionButtonClass, "min-w-0 flex-1 gap-2 px-2 py-1.5 text-left")}
        >
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("tray.open")}</span>
        </button>
        <ActionIconButton label={t("app.navProjectSettings")} Icon={SlidersHorizontal} onClick={onOpenProjectSettings} />
        <ActionIconButton label={t("tray.settings")} Icon={Settings} onClick={onOpenSettings} />
        <span aria-hidden data-testid="panel-action-separator" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <ActionIconButton label={t("tray.quit")} Icon={Power} onClick={onQuit} />
      </div>
      </PanelCard>
      </div>
    </div>
  );
}

function DiscussionRow({
  d,
  onOpen,
  onCopy,
  copyLabel,
}: {
  d: { slug: string; topic: string };
  onOpen: (slug: string) => void;
  onCopy: (text: string) => void;
  copyLabel: string;
}) {
  return (
    <div
      data-testid={`panel-discussion-${d.slug}`}
      onClick={() => onOpen(d.slug)}
      className={rowClass}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px]">{d.slug}</div>
        <div className="truncate text-[11px] text-muted-foreground">{d.topic}</div>
      </div>
      {/* 列尾常驻拷贝钮：tabIndex=-1 退出 tab 顺序（design D4）——面板成 key window 后 WebKit
          会把焦点给第一个可 tab 元素，拷贝钮不退出就吃到焦点框。变更列同理。 */}
      <CopyButton value={d.slug} label={copyLabel} onCopy={onCopy} tabIndex={-1} />
    </div>
  );
}

/**
 * 变更列的品质站章（spec tray-status-menu「面板变更列的品质站章」；design D7）：
 * 站章直接影响收尾动作（未结工单挡封存、降级章提示留意），所以进 tray；创建者
 * 头像、来源讨论标记、restale 与 metaError 是阅读脉络，留在看板。
 *
 * 图标、色调与 tooltip 词条全部取自 packages/ui 导出的两张站别样式表——面板不
 * 另建第二份对照，否则卡片改了色、tray 不会跟着改。tooltip 以 `title` 承载：
 * 面板是无焦点的一瞥接口，挂 Radix Tooltip 会多一层 portal 与焦点管理。
 */
function StationBadges({ c }: { c: ChangeItem }) {
  const { t } = useI18n();
  const review = c.reviewStatus && c.reviewStatus !== "none" ? c.reviewStatus : null;
  const verify = c.verifyStatus && c.verifyStatus !== "none" ? c.verifyStatus : null;
  if (!review && !verify) return null;
  return (
    <>
      {review && (
        <span
          aria-label={t(REVIEW_LABEL_KEY[review])}
          title={t(REVIEW_LABEL_KEY[review])}
          className={cn("shrink-0", REVIEW_TONE[review])}
        >
          {REVIEW_ICON[review]}
        </span>
      )}
      {verify && (
        <span
          aria-label={t(VERIFY_LABEL_KEY[verify])}
          title={t(VERIFY_LABEL_KEY[verify])}
          className={cn("shrink-0", VERIFY_TONE[verify])}
        >
          {VERIFY_ICON[verify]}
        </span>
      )}
    </>
  );
}

function ChangeRow({
  c,
  stage,
  onOpen,
  onCopy,
  copyLabel,
}: {
  c: ChangeItem;
  /** 所属生命周期阶段——进度条填色取 STAGE_BAR 深浅阶梯（design D3）。 */
  stage: Stage;
  onOpen: (name: string) => void;
  onCopy: (text: string) => void;
  copyLabel: string;
}) {
  const { t } = useI18n();
  const pct = c.totalTasks > 0 ? Math.round((c.completedTasks / c.totalTasks) * 100) : 0;
  // 波次与阻挡（spec tray-status-menu「变更列的波次标示与顺序同源」；design D7）：
  // 列首波次数字与看板卡片共用 card.wave 词条；被挡列整列变淡、title 列前置。
  // 判定归 planWave／planBlockedBy 单一入口，缺 wave（remote、成环）列与从前一致。
  const wave = planWave(c);
  const blockedBy = planBlockedBy(c);
  const blockedTitle = blockedBy.length > 0 ? planBlockedLabel(blockedBy, t) : undefined;
  return (
    <div
      data-testid={`panel-change-${c.name}`}
      onClick={() => onOpen(c.name)}
      // 淡化落在列的内容（直接子节点）上：列本身降透明度会连底部分隔线一起变淡。
      className={cn(rowClass, blockedBy.length > 0 && "[&>*]:opacity-60")}
      title={blockedTitle}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {wave !== null && (
            <span
              aria-label={planWaveLabel(wave, t)}
              title={planWaveLabel(wave, t)}
              className="shrink-0 text-[11px] font-semibold tabular-nums text-primary"
            >
              {wave}
            </span>
          )}
          <span className="truncate">{c.name}</span>
          <StationBadges c={c} />
          {/* worktree 标记：挂着＝工作正于副本进行中，与站章同属影响收尾动作
              的状态（merge 前不能封存），故进 tray；色调与 tooltip 词条沿看板
              卡片同款（SEMANTIC_TONE.inProgress＋card.worktree），不另建对照。 */}
          {c.worktree && (
            <span
              aria-label={t("card.worktree")}
              title={t("card.worktreeTitle").replace("{branch}", c.worktree.branch)}
              className={cn("shrink-0", SEMANTIC_TONE.inProgress)}
            >
              <GitBranch className="h-3.5 w-3.5" />
            </span>
          )}
          {c.totalTasks > 0 && (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {`${c.completedTasks}/${c.totalTasks}`}
            </span>
          )}
        </div>
        {c.totalTasks > 0 && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
            <div
              data-testid="panel-progress-fill"
              className={cn("h-full rounded-full", STAGE_BAR[stage])}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
      <CopyButton value={c.name} label={copyLabel} onCopy={onCopy} tabIndex={-1} />
    </div>
  );
}

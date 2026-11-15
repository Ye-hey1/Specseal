import {
  cloneElement,
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { CopyButton } from "./CopyButton";
import { DotSeparated } from "./DetailHeader";
import { ManualToc } from "./ManualToc";

/** 文档 → 阅读卡标题（与文档节点同一词条）：变更、讨论与已封存三页共用。 */
export const DOC_TITLE_KEYS: Record<string, string> = {
  proposal: "common.tabProposal",
  design: "common.tabDesign",
  tasks: "common.tabTasks",
  specs: "common.tabSpecs",
  plan: "drawer.tab.plan",
  review: "drawer.tab.review",
  verify: "drawer.tab.verify",
  conclusion: "ddrawer.tabConclusion",
  rounds: "ddrawer.tabRounds",
  context: "ddrawer.tabContext",
  promote: "ddrawer.tabPromote",
  record: "ddrawer.tabRecord",
};

/** 变更文档的本页目录重扫键：规格取全部 capability、工单取轮次，其余取该文档内容；任一变就重扫锚点。
 * 变更详情页与已封存变更页共用。 */
export function changeDocTocKey(
  tab: string,
  docs: { content: unknown; specs: unknown; tickets: Record<"review" | "verify", unknown> },
): string {
  const source = tab === "specs" ? docs.specs : tab === "review" || tab === "verify" ? docs.tickets[tab] : docs.content;
  return `${tab}\u0000${JSON.stringify(source)}`;
}

/** 本页目录收的标题：渲染器标出的区段标题，加上 Markdown 内文的 h2／h3。 */
const DOC_HEADINGS = "[data-doc-heading], .markdown h2, .markdown h3";

export interface DetailShellProps {
  /** 外框上的页标记（`data-change-detail` 等），供宿主与测试定位。 */
  [mark: `data-${string}`]: string | boolean | undefined;
  /** 左栏文档树的内容（身分区、「文档」节点、「状态」列）。 */
  tree: ReactNode;
  /** 目前文档（含项目识别）；一变阅读区就卷回顶端。 */
  activeDoc: string;
  /** 本页目录的重扫键：文档或其内容一变就重扫锚点。 */
  tocKey: string;
  /** 指向阅读卡的 `DocBody`——本页目录自它渲染后的 DOM 推导锚点。 */
  bodyRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * 详情页三栏骨架（design D1；spec「详情页的文档树、阅读卡与本页目录」）：左栏 240px 文档树
 * （独立卷动）、中栏阅读区（置中 768px，自己卷动）、右栏 200px 本页目录。右栏以 container
 * query 量主区宽，≥1200px 才显示；没有锚点时目录不渲染、右栏留空。无底部固定列。
 */
export function DetailShell({ tree, activeDoc, tocKey, bodyRef, children, ...marks }: DetailShellProps) {
  const { locale } = useI18n();
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 换文档：阅读区自顶端呈现（画面画出前就归零，不闪前一份的卷动位置）；左栏卷动位置不受影响。
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [activeDoc]);
  return (
    <div {...marks} data-detail-shell className="@container flex h-full min-h-0 w-full">
      <aside
        data-detail-tree
        className="flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-border px-2 pt-3.5 pb-3"
      >
        {tree}
      </aside>
      <div data-detail-reading ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-7">
        <div className="mx-auto flex w-full max-w-[768px] flex-col gap-5">{children}</div>
      </div>
      <aside data-detail-toc className="hidden w-[200px] shrink-0 @min-[1200px]:flex">
        {/* 锚点文本多为译文（章节标签、字段标签）：语系一换也重扫。 */}
        <ManualToc
          bodyRef={bodyRef}
          markdownBody={`${locale}\u0000${tocKey}`}
          headings={DOC_HEADINGS}
          className="flex border-l-0"
        />
      </aside>
    </div>
  );
}

/** 身分区的一列关联：标签＋内容（内容可折行），`data-relation-<mark>` 供测试定位。 */
export interface DetailRelation {
  mark: string;
  label: string;
  children: ReactNode;
}

export interface DetailIdentityProps {
  /** 名称或 slug：等宽 14px，过长折行、不撑宽左栏。 */
  title: string;
  copyLabel: string;
  /** 拷贝钮写入的值；缺席＝标题本身。 */
  copyValue?: string;
  /** 阶段签、章签等签列。 */
  badges?: ReactNode;
  /** 讨论 topic：最多三行、溢出截断。 */
  subtitle?: ReactNode;
  /** 出身行的各段：单行灰字、缺席段略过、溢出裁切。 */
  provenance?: ReactNode[];
  /** 关联列，各自一行；空数组＝无关联列。 */
  relations?: DetailRelation[];
}

/** 左栏身分区（design D1）：承接原标题列与出身列。 */
export function DetailIdentity({
  title,
  copyLabel,
  copyValue,
  badges,
  subtitle,
  provenance,
  relations,
}: DetailIdentityProps) {
  return (
    <section data-detail-identity className="flex min-w-0 flex-col gap-2 px-2 pb-1">
      <div className="flex min-w-0 items-start gap-1">
        <h1 className="min-w-0 break-all pt-0.5 font-mono text-sm font-semibold leading-snug">{title}</h1>
        <CopyButton value={copyValue ?? title} label={copyLabel} />
      </div>
      {badges && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{badges}</div>}
      {subtitle && <p className="line-clamp-3 text-[13px] text-foreground/80">{subtitle}</p>}
      {(provenance ?? []).some(Boolean) && (
        <div
          data-identity-provenance
          className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground"
        >
          <DotSeparated segments={provenance ?? []} />
        </div>
      )}
      {(relations ?? []).map((r) => (
        <div key={r.mark} {...{ [`data-relation-${r.mark}`]: "" }} className="flex min-w-0 items-start gap-2 text-xs">
          <span className="min-w-8 shrink-0 whitespace-nowrap leading-6 text-muted-foreground">{r.label}</span>
          <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-1">{r.children}</div>
        </div>
      ))}
    </section>
  );
}

/** 左栏小标（「文档」「状态」）：与手册页侧栏树的分组标题同款。 */
export function DetailTreeLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** 左栏「状态」列：承接原「状态」卡的内容（`DetailHeader` 的 `StatusRow` 清单，细线分隔）。两栏格线让各列以
 * subgrid 共用标签栏——栏宽取最长标签，英文单字标签不溢出、各列数值左缘对齐（desktop-app「详情页状态栏的标签栏
 * 依最长标签对齐」）。 */
export function DetailStatus({ children }: { children: ReactNode }) {
  return (
    <section data-status-card className="grid grid-cols-[max-content_minmax(0,1fr)] divide-y divide-border">
      {children}
    </section>
  );
}

export interface DocHeaderProps {
  /** 文档名（24px 一般字重）。 */
  title: ReactNode;
  badges?: ReactNode;
  /** 同列右端（「打开 ▾」）。 */
  actions?: ReactNode;
  /** 出处行：13px 灰字、「·」分隔、可折行。 */
  provenance?: ReactNode[];
}

/** 阅读卡标题区（design D1）。 */
export function DocHeader({ title, badges, actions, provenance }: DocHeaderProps) {
  return (
    <header data-doc-header className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 truncate text-2xl font-normal leading-tight">{title}</h2>
        {badges && (
          <div data-doc-badges className="flex shrink-0 items-center gap-1.5">
            {badges}
          </div>
        )}
        {actions && <div className="ml-auto flex shrink-0 items-center">{actions}</div>}
      </div>
      {(provenance ?? []).some(Boolean) && (
        <div data-doc-provenance className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
          <DotSeparated segments={provenance ?? []} />
        </div>
      )}
    </header>
  );
}

/** 一格数字砖：值与标签。 */
export interface DocTile {
  value: ReactNode;
  label: string;
  /** 不含内容的链接元素（react-router 的 `<Link to=… />`）：给了就以它渲染整格、可点；
   *  组件填入格子内容与样式，链接原有的子元素与 className 不采用。 */
  link?: ReactElement<{ className?: string; children?: ReactNode }>;
}

/** 阅读卡标题区的推导结果：签槽、数字砖、提示框（缺席时为空）。 */
export interface DocSummary {
  badges: ReactNode;
  tiles: DocTile[];
  callout: ReactNode;
}

const TILE_CLS = "flex min-w-0 flex-col gap-0.5 rounded-xl border border-border px-3 py-2.5";
const TILE_LINK_CLS =
  "cursor-(--cursor-interaction) outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring";

/** 数字砖：阅读卡标题下由文档结构推出的计数格，最多四格、依格数平分整列（每格一栏等宽；
 * `auto-cols-fr` 即 `minmax(0, 1fr)`，长标签截断、不撑宽栏）；空数组整列缺席。带 `link` 的格
 * 整格是链接（server 总览；server-web-list-pages design D1）。 */
export function DocTiles({ tiles }: { tiles: DocTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div data-doc-tiles className="grid grid-flow-col auto-cols-fr gap-2.5">
      {tiles.map((tile, i) => {
        const content = (
          <>
            <span className="text-xl font-semibold tabular-nums">{tile.value}</span>
            <span className="truncate text-[11px] text-muted-foreground">{tile.label}</span>
          </>
        );
        return tile.link ? (
          cloneElement(tile.link, {
            key: i,
            "data-doc-tile": "",
            className: cn(TILE_CLS, TILE_LINK_CLS),
            children: content,
          } as Record<string, unknown>)
        ) : (
          <div key={i} data-doc-tile className={TILE_CLS}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

/** 阅读卡内文：包住各文档渲染器的输出，本页目录自它推导锚点。内文 15px／行高 1.75，行宽以卡栏
 * （768px 扣内距）为上限（design D10；规格详情页与手册页不经这里）。index.css 的 `.markdown` 基准字级
 * 不在 cascade layer、一般声明就压过 Tailwind utilities 层，字级与行高的覆盖因此带 important（`!`）；
 * Markdown 自带的 96ch 同在 utilities 层，后代选择器的特异性就够。 */
const DOC_BODY_CLS =
  "w-full text-[15px] leading-[1.75] [&_.markdown]:max-w-none [&_.markdown]:text-[15px]! [&_.markdown]:leading-[1.75]!";

export const DocBody = forwardRef<HTMLDivElement, { children: ReactNode }>(({ children }, ref) => (
  <div ref={ref} data-doc-body className={DOC_BODY_CLS}>
    {children}
  </div>
));
DocBody.displayName = "DocBody";

/** 标题列动作插槽：undefined＝没有宿主（原地渲染）、null＝宿主的插槽尚未挂上。 */
const ActionsSlotContext = createContext<HTMLElement | null | undefined>(undefined);

/** 宿主提供插槽节点（design D3）：value 为宿主以 callback ref 取得的 [`DetailActionsSlot`] 节点。 */
export const DetailActionsSlotProvider = ActionsSlotContext.Provider;

/** 宿主标题列上的空插槽。 */
export const DetailActionsSlot = forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref} data-detail-actions className="flex shrink-0 items-center gap-1.5 pr-3" />
));
DetailActionsSlot.displayName = "DetailActionsSlot";

/**
 * 页的变更层动作（design D3）：有宿主时以 portal 送进标题列插槽，最前面带一条细线与
 * ‹ n／m › 分隔；没有宿主时原地渲染。
 */
export function DetailActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlotContext);
  if (slot === undefined) {
    return (
      <div data-detail-actions className="flex items-center justify-end gap-1.5">
        {children}
      </div>
    );
  }
  if (!slot) return null;
  return createPortal(
    <>
      <span aria-hidden="true" className="mx-1.5 h-5 w-px bg-border" />
      {children}
    </>,
    slot,
  );
}

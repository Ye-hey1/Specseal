import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BookOpen, ChevronLeft, ChevronRight, CloudOff } from "lucide-react";

import type { ManualIndex, ManualPageItem } from "../adapter";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { countHeadings, manualLinkSlug, splitLeadingHeading, stripSourcesLine } from "../manualDoc";
import { parseSpecSections } from "../specSections";
import { calendarDay, traceSpan, type TracePoint } from "../specSummary";
import type { DocumentRef, DocumentTarget } from "./DetailHeader";
import { DocBody, DocHeader, DocTiles, type DocTile } from "./DetailShell";
import { InlineMarks } from "./DocParts";
import { ManualToc } from "./ManualToc";
import { ManualTree } from "./ManualTree";
import { Markdown } from "./Markdown";
import { DocSkeleton, RowSkeleton } from "./skeletons";
import { Badge, badgeVariants } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { StatusPill } from "./ui/status-pill";

/** 手册阅读栏（design D5）：768px 置中；阅读卡与底列内容同宽对齐。 */
const MANUAL_COLUMN_CLS = "mx-auto w-full max-w-[768px]";

/** 手册内文的章节字级（desktop-spec-manual-pages design D6）：h2 16px、h3 14px，皆粗体。Streamdown 的
 * 标题尺寸在 utilities 层，后代选择器的特异性就够。 */
const MANUAL_HEADINGS_CLS =
  "[&_.markdown_h2]:text-base [&_.markdown_h2]:font-semibold [&_.markdown_h3]:text-sm [&_.markdown_h3]:font-semibold";

export interface ManualPageProps {
  /** 手册索引（已依阅读序排好）；null＝加载中（骨架）。 */
  index: ManualIndex | null;
  /** 读取一页去 frontmatter 的内文；不存在回 null、读取失败 reject。 */
  loadPage: (slug: string) => Promise<string | null>;
  /** 点页脚出处的 capability：在手册页上开该规格的抽屉、不切页（App 接线：store.openSpec）。 */
  onOpenSpec: (capability: string) => void;
  /** 正典 capability 清单——出处只对存在者可点，不存在者为纯文本。 */
  capabilities: string[];
  /** 刷新世代——变动时重载目前页内文（外部写入后的 workspace-changed）。 */
  refreshGen?: number;
  /** 阅读卡标题列右端的文档动作（「打开 ▾」，对应 `openspec/manual/<slug>.md`）；未传时缺席。 */
  renderDocumentActions?: (target: DocumentTarget | null) => ReactNode;
  /** 页档的实际相对路径（宿主向 core 查找，跟着项目的 spec 目录名走）：出处行首段；缺席或查无时该段缺席。 */
  locateDocument?: (doc: DocumentRef) => Promise<{ relative: string } | null>;
  /** 读一份正式规格全文：过期提示框取各出处规格的最近 @trace；缺席或失败时该行退回不带日期的句子。 */
  loadSpec?: (capability: string) => Promise<string | null>;
}

/** 已加载的页内文；body 为 null＝加载失败或页不存在。 */
interface LoadedDoc {
  slug: string;
  body: string | null;
}

/** 上一页／下一页两向的差异：DOM 锚点、aria-label、小字标签键与对齐。 */
const PAGE_NAV = {
  prev: { anchor: "data-manual-prev", ariaKey: "pager.prev", labelKey: "manual.prevLabel", align: "items-start" },
  next: { anchor: "data-manual-next", ariaKey: "pager.next", labelKey: "manual.nextLabel", align: "items-end" },
} as const;

/** 底列的上一页／下一页框线钮（design D5）：小字标签＋目标页标题；无目标时调用端不渲染。 */
function PageNavButton({
  direction,
  target,
  onSelect,
}: {
  direction: "prev" | "next";
  target: ManualPageItem;
  onSelect: (slug: string) => void;
}) {
  const { t } = useI18n();
  const nav = PAGE_NAV[direction];
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={t(nav.ariaKey)}
      className="h-auto gap-1.5 py-1"
      onClick={() => onSelect(target.slug)}
      {...{ [nav.anchor]: target.slug }}
    >
      {direction === "prev" && <ChevronLeft className="h-4 w-4" />}
      <span className={cn("flex flex-col leading-tight", nav.align)}>
        <span className="text-[11px] font-normal text-muted-foreground">{t(nav.labelKey)}</span>
        <span className="max-w-48 truncate">{target.title}</span>
      </span>
      {direction === "next" && <ChevronRight className="h-4 w-4" />}
    </Button>
  );
}

/** 出处签：正典存在者为可点的框线签（开该规格详情页），不存在者为纯文本。出处行与底列共用。 */
function SourceChips({
  names,
  canonical,
  onOpenSpec,
}: {
  names: string[];
  canonical: Set<string>;
  onOpenSpec: (capability: string) => void;
}) {
  return names.map((name) =>
    canonical.has(name) ? (
      <button
        key={name}
        type="button"
        className={cn(badgeVariants({ variant: "outline" }), "cursor-(--cursor-interaction) font-mono hover:bg-muted")}
        onClick={() => onOpenSpec(name)}
      >
        {name}
      </button>
    ) : (
      <span key={name} className="font-mono">
        {name}
      </span>
    ),
  );
}

/** 过期提示框的读取结果：该页各出处规格的最近 @trace（读不到或无 @trace 为 null）。 */
interface StaleSources {
  slug: string;
  latest: Record<string, TracePoint | null>;
}

/** 手册页（desktop-manual-page design「侧栏树、搜索与上下页在前端由索引推导」；
 * desktop-list-pages-reskin design D5 三栏：240px 目录树、768px 置中阅读栏、200px 本页
 * 目录）：中栏以共用 Markdown 于白底阅读卡内渲染选定页——卡由上而下为标题区（页标题、分区签、
 * 「可能过期」签、「打开 ▾」、出处行）、数字砖、过期提示框与内文（desktop-spec-manual-pages
 * design D6）；白底上缘细线的底列（出处签＋上一页／下一页）固定不随内文卷动。本组件只管选页、
 * 内文与过期提示框的加载（latest-wins）与切分；唯读、无任何写入操作。 */
export function ManualPage({
  index,
  loadPage,
  onOpenSpec,
  capabilities,
  refreshGen,
  renderDocumentActions,
  locateDocument,
  loadSpec,
}: ManualPageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [staleSources, setStaleSources] = useState<StaleSources | null>(null);
  const [location, setLocation] = useState<{ slug: string; relative: string } | null>(null);
  // 内文与过期提示框加载的 latest-wins 序号；加载函数以 ref 持有，宿主每次渲染换 lambda 不重载。
  const seq = useRef(0);
  const staleSeq = useRef(0);
  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  const loadSpecRef = useRef(loadSpec);
  loadSpecRef.current = loadSpec;
  const locateRef = useRef(locateDocument);
  locateRef.current = locateDocument;

  const pages = index?.present ? index.pages : [];
  // 目前页由索引现况推导：选定页消失（外部删除、索引重载）即回首页。
  const current = pages.find((p) => p.slug === selected) ?? pages[0] ?? null;
  const currentSlug = current?.slug ?? null;
  // 出处名以索引 sources 为单一真相；manual-pages 契约：一项可带 `#<Requirement 名>` 锚定，
  // 出处只看井号前的 capability 名——切掉锚定、去头尾空白（读取端也这么做）后再去重
  //（防撞 React key，也防同 capability 多锚定重复）。
  const sourceNames = Array.from(new Set((current?.sources ?? []).map((s) => s.split("#", 1)[0].trim())));

  useEffect(() => {
    if (!currentSlug) {
      // 索引清空（切换 workspace）：丢弃旧内文与选页，并作废在途的加载——新 workspace
      // 的首页 slug 多半同名（契约规定叫 index），旧内文不得当成新页显示或事后写回。
      seq.current++;
      setDoc(null);
      setSelected(null);
      return;
    }
    const mine = ++seq.current;
    loadPageRef.current(currentSlug).then(
      (body) => {
        if (seq.current === mine) setDoc({ slug: currentSlug, body });
      },
      () => {
        if (seq.current === mine) setDoc({ slug: currentSlug, body: null });
      },
    );
  }, [currentSlug, refreshGen]);

  // 出处行首段的页档路径：换页向 core 查一次（页档位置不随内文重载而变）；换页或卸载作废在途回应。
  // 索引清空（切换 workspace）时丢掉旧路径：新项目的同名页在自己的位置查到前不得沿用。
  useEffect(() => {
    const locate = locateRef.current;
    if (!currentSlug || !locate) {
      setLocation(null);
      return;
    }
    let live = true;
    void locate({ manual: currentSlug }).then(
      (found) => {
        if (live) setLocation(found && { slug: currentSlug, relative: found.relative });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [currentSlug]);

  // 过期提示框（design D6）：只在索引判为过期时读各出处规格全文，取其最近 @trace；换页作废、
  // latest-wins。过期与否只看索引的 stale，不在这里重判。sourceNames 每次渲染都是新数组，
  // effect 依赖改用换行相接的字符串（capability 名为 kebab-case、不含换行），内容不变就不重读。
  const staleSlug = current?.stale ? current.slug : null;
  const staleCaps = current?.stale ? sourceNames.join("\n") : "";
  useEffect(() => {
    const mine = ++staleSeq.current;
    const load = loadSpecRef.current;
    if (!staleSlug || !load) {
      // 离开过期页或索引清空（切换 workspace）：丢掉上一份出处日期——新项目的同名过期页
      // 在自己的规格读完前不得沿用。
      setStaleSources(null);
      return;
    }
    const read = (cap: string) =>
      load(cap).then(
        (md) => [cap, md ? traceSpan(parseSpecSections(md)).latest : null] as const,
        () => [cap, null] as const,
      );
    void Promise.all(staleCaps.split("\n").filter(Boolean).map(read)).then((entries) => {
      if (staleSeq.current === mine) setStaleSources({ slug: staleSlug, latest: Object.fromEntries(entries) });
    });
  }, [staleSlug, staleCaps, refreshGen]);

  const loaded = doc && current && doc.slug === current.slug ? doc : null;
  // 内文拆三段：尾端出处行剥掉（出处列改读索引 sources）、开头 H1 → 阅读卡标题、其余 → 内文。
  const parsed = loaded?.body != null ? splitLeadingHeading(stripSourcesLine(loaded.body)) : null;
  const markdownBody = parsed?.body ?? null;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 换页回顶；外部改内文的重载（refreshGen）不动卷动位置。
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [currentSlug]);

  if (index === null) {
    return (
      <div className="flex h-full min-h-0">
        <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-sidebar p-3">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </aside>
        <div className="flex-1 p-6">
          <DocSkeleton />
        </div>
      </div>
    );
  }

  if (!current) {
    const remote = index.reason === "remote";
    return (
      <div
        data-manual-empty={remote ? "remote" : "none"}
        className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center"
      >
        <BookOpen className="h-10 w-10 text-muted-foreground/40" />
        <h2 className="text-lg font-semibold">{remote ? t("manual.remoteTitle") : t("manual.emptyTitle")}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {remote ? t("manual.remoteDesc") : t("manual.emptyDesc")}
        </p>
      </div>
    );
  }

  const position = pages.indexOf(current);
  const prev = position > 0 ? pages[position - 1] : null;
  const next = position < pages.length - 1 ? pages[position + 1] : null;
  const canonical = new Set(capabilities);
  const heading = parsed?.heading ?? current.title;
  // 数字砖（design D6）：内文未加载或加载失败时整列缺席。
  const headingCounts = markdownBody !== null ? countHeadings(markdownBody) : null;
  const tiles: DocTile[] = headingCounts
    ? [
        { value: headingCounts.h2, label: t("manual.tileSections") },
        { value: headingCounts.h3, label: t("manual.tileSubsections") },
        { value: current.keywords.length, label: t("manual.tileKeywords") },
        { value: sourceNames.length, label: t("manual.tileSources") },
      ]
    : [];
  // 过期提示框：内文在、索引判为过期，且各出处规格读完（没有 loadSpec 时直接退回不带日期的句子）。
  const staleLatest = staleSources?.slug === current.slug ? staleSources.latest : null;
  const staleCallout = current.stale && markdownBody !== null && (!loadSpec || staleLatest) && (
    <div data-doc-callout>
      <Callout data-callout="stale" tone="warning" title={t("manual.stale")} className="my-0">
        <ul className="my-1 flex flex-col gap-0.5 text-sm">
          {sourceNames.map((cap) => {
            const latest = staleLatest?.[cap];
            return (
              <li key={cap}>
                {latest
                  ? t("manual.staleCalloutSource")
                      .replace("{cap}", cap)
                      .replace("{date}", calendarDay(latest.updated))
                      .replace("{change}", latest.source)
                  : t("manual.staleCalloutSourceUnknown").replace("{cap}", cap)}
              </li>
            );
          })}
        </ul>
        {current.generated && (
          <p className="text-sm">{t("manual.staleCalloutGenerated").replace("{generated}", current.generated)}</p>
        )}
        <p className="text-sm text-muted-foreground">
          <InlineMarks text={t("manual.staleCalloutHint")} />
        </p>
      </Callout>
    </div>
  );

  // 内文的跨页链接（契约：相对文件名 `layout.md`）在手册内切页——放给 WebView 直接导航
  // 会整页离开 app；连到不存在的页只挡下导航、停在原页。其他 href 不拦。
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    const slug = anchor ? manualLinkSlug(anchor.getAttribute("href") ?? "") : null;
    if (!slug) return;
    e.preventDefault();
    if (pages.some((p) => p.slug === slug)) setSelected(slug);
  };

  return (
    <div className="flex h-full min-h-0">
      <ManualTree
        pages={pages}
        currentSlug={current.slug}
        query={query}
        onQuery={setQuery}
        onSelect={setSelected}
        uncoveredCount={index.uncoveredNew.length}
      />

      <div data-manual-content className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={bodyRef}
            data-manual-body
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            onClick={onBodyClick}
          >
            <Card data-manual-card className={`${MANUAL_COLUMN_CLS} flex flex-col gap-5 p-6`}>
              <DocHeader
                title={heading}
                badges={
                  <>
                    <Badge variant="secondary">{current.section ?? t("manual.sectionOther")}</Badge>
                    {current.stale && (
                      <StatusPill data-manual-stale-pill tone="warning">
                        {t("manual.stale")}
                      </StatusPill>
                    )}
                  </>
                }
                actions={renderDocumentActions?.({ doc: { manual: current.slug }, content: loaded?.body ?? null })}
                provenance={[
                  location?.slug === current.slug && <span className="font-mono">{location.relative}</span>,
                  current.generated && (
                    <span data-manual-generated>{t("manual.generatedAt").replace("{generated}", current.generated)}</span>
                  ),
                  sourceNames.length > 0 && (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {t("manual.sources")}
                      <SourceChips names={sourceNames} canonical={canonical} onOpenSpec={onOpenSpec} />
                    </span>
                  ),
                ]}
              />
              <DocTiles tiles={tiles} />
              {staleCallout}
              <div className={MANUAL_HEADINGS_CLS}>
                <DocBody>
                  {!loaded ? (
                    <DocSkeleton />
                  ) : loaded.body === null ? (
                    <div
                      data-manual-load-failed
                      className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
                    >
                      <CloudOff className="h-4 w-4 shrink-0" />
                      <span>{t("manual.loadFailed")}</span>
                    </div>
                  ) : (
                    <Markdown content={markdownBody} />
                  )}
                </DocBody>
              </div>
            </Card>
          </div>
          <footer data-manual-footer className="shrink-0 border-t border-border bg-card px-6 py-2.5">
            <div className={`${MANUAL_COLUMN_CLS} flex items-center justify-between gap-3`}>
              {sourceNames.length > 0 ? (
                <div
                  data-manual-sources
                  className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span>{t("manual.sources")}</span>
                  <SourceChips names={sourceNames} canonical={canonical} onOpenSpec={onOpenSpec} />
                </div>
              ) : (
                <span />
              )}
              <div className="flex shrink-0 items-center gap-2">
                {prev && <PageNavButton direction="prev" target={prev} onSelect={setSelected} />}
                {next && <PageNavButton direction="next" target={next} onSelect={setSelected} />}
              </div>
            </div>
          </footer>
        </div>
        <ManualToc bodyRef={bodyRef} markdownBody={markdownBody} />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, History } from "lucide-react";

import type { ArchivedItem } from "../adapter";
import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { parseSpecSections } from "../specSections";
import { calendarDay, specStats, specTiles, traceTiles } from "../specSummary";
import { parseTraceSources } from "../trace";
import { settle, useGenerationLoad } from "../lib/useGenerationLoad";
import { Badge, badgeVariants } from "./ui/badge";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { StatusPill } from "./ui/status-pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { StatusRow, type DocumentRef, type DocumentTarget } from "./DetailHeader";
import { DetailIdentity, DetailShell, DetailStatus, DetailTreeLabel, DocBody, DocHeader, DocTiles } from "./DetailShell";
import { InlineMarks, Lead, SECTION_HEADING_CLS } from "./DocParts";
import { ListRow } from "./ListRow";
import { Markdown } from "./Markdown";
import { RequirementBlock } from "./RequirementBlock";
import { SearchField } from "./SearchField";
import { DocSkeleton } from "./skeletons";

export interface SpecDetailPageProps {
  /** 目标 capability id；null＝未选定（不渲染）。 */
  capability: string | null;
  /** 刷新世代——递增即就地重载（不清空、latest-wins；未传＝0）。 */
  refreshGen?: number;
  /** 读取正式规格 spec.md 全文（capability 寻址）；缺件回 null。 */
  loadDocument: (capability: string) => Promise<string | null>;
  /** 封存变更清单：把 @trace 来源变更名对应到封存目录名与封存日期；缺席／空＝溯源全部不可点。 */
  archivedChanges?: ArchivedItem[];
  /** 点可点的溯源列或需求锚点：宿主打开该封存变更的已封存详情页（带 datedName）。 */
  onOpenArchivedChange?: (datedName: string) => void;
  /** 「规格」阅读卡标题列右端的文档动作（「打开 ▾」，对应 spec.md）；溯源文档不对应文件、不放。 */
  renderDocumentActions?: (target: DocumentTarget | null) => ReactNode;
  /** spec.md 的实际相对路径（宿主向 core 查找，跟着项目的 spec 目录名走）：出处行首段与 Purpose 待补
   * 提示框引用它；缺席或查无时出处行不列路径、提示框改用不带路径的说法。 */
  locateDocument?: (doc: DocumentRef) => Promise<{ relative: string } | null>;
}

type Doc = string | null | undefined;

/** 封存清单以变更名索引（同名取清单中的第一笔）。 */
function archivedByName(archived: ArchivedItem[]): Map<string, ArchivedItem> {
  const byName = new Map<string, ArchivedItem>();
  for (const item of archived) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  return byName;
}

/** 溯源列（design D2）：全文 @trace 来源去重；封存清单命中者依封存日期升幂（同日依文档
 * 首次出现序）在前，未命中者依文档出现序在后。 */
function traceItems(doc: Doc, byName: Map<string, ArchivedItem>) {
  const items = parseTraceSources(doc).map((name, index) => ({ name, index, archived: byName.get(name) }));
  const hits = items
    .filter((i) => i.archived)
    .sort((a, b) => a.archived!.date.localeCompare(b.archived!.date) || a.index - b.index);
  return [...hits, ...items.filter((i) => !i.archived)];
}

/** 需求段标题列右端的来源锚点：封存清单命中时可点开该封存变更。 */
function TraceAnchor({
  trace,
  byName,
  onOpenArchivedChange,
}: {
  trace: { source: string; updated: string | null } | null;
  byName: Map<string, ArchivedItem>;
  onOpenArchivedChange?: (datedName: string) => void;
}) {
  const { t } = useI18n();
  if (!trace) return null;
  const hit = byName.get(trace.source);
  const anchor = [`${t("sdrawer.fromChanges")} ${trace.source}`, trace.updated].filter(Boolean).join(" · ");
  return hit ? (
    <button
      type="button"
      data-trace-anchor
      className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      onClick={() => onOpenArchivedChange?.(hit.datedName)}
    >
      {anchor}
    </button>
  ) : (
    <span data-trace-anchor className="shrink-0 text-[11px] text-muted-foreground">
      {anchor}
    </span>
  );
}

/**
 * 规格详情页（spec「桌面 app 呈现 change 与 spec 的清单与内容」；desktop-spec-manual-pages design
 * D1–D5）：详情页三栏骨架——左栏身分区、「文档」节点规格／溯源与「状态」三列；「规格」阅读卡为
 * 标题区（需求数签、搜索需求、「打开 ▾」、出处行）、数字砖、提示框、Purpose 引言段与需求段（命中的
 * 第一条展开、其余收合）；「溯源」阅读卡为出处行、数字砖与来源变更列；右栏本页目录自渲染后的 DOM
 * 推导。换目标以 key 重挂（清空全量加载、搜索字符串与文档回到初始），世代重载不清空且 latest-wins。
 */
export function SpecDetailPage(props: SpecDetailPageProps) {
  if (!props.capability) return null;
  return <SpecDetailView key={props.capability} {...props} capability={props.capability} />;
}

function SpecDetailView({
  capability,
  refreshGen,
  loadDocument,
  archivedChanges,
  onOpenArchivedChange,
  renderDocumentActions,
  locateDocument,
}: SpecDetailPageProps & { capability: string }) {
  const { t, tn } = useI18n();
  const [doc, setDoc] = useState<Doc>();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("spec");
  const [docPath, setDocPath] = useState<string | null>(null);
  // 需求段每次展开／收合都递增：进 tocKey 让右栏目录重扫，展开后才渲染的内文子标题补进目录。
  const [toggles, setToggles] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 打开全量加载；外部世代重载不清空、回应到达后单次替换（不重置卷动与搜索）。
  useGenerationLoad(refreshGen ?? 0, (isLatest) => {
    void loadDocument(capability)
      .then((v) => {
        if (isLatest()) setDoc(v);
      })
      .catch(settle(setDoc, null, isLatest));
  });

  const loaded = doc !== undefined;
  const sections = doc ? parseSpecSections(doc) : null;
  const byName = archivedByName(archivedChanges ?? []);
  const sources = traceItems(doc, byName);
  const stats = specStats(sections, sources.length);
  const needle = query.trim().toLowerCase();
  const visible = (sections?.requirements ?? []).filter((r) => r.title.toLowerCase().includes(needle));
  const updatedLine =
    stats.latest &&
    t("sdetail.metaUpdated").replace("{date}", calendarDay(stats.latest.updated)).replace("{change}", stats.latest.source);
  const count = (n: number) =>
    loaded && (
      <Badge variant="secondary" className="tabular-nums">
        {n}
      </Badge>
    );
  const showTrace = () => setTab("trace");

  // 换目标以 key 重挂，挂载时向 core 查一次 spec.md 的位置；卸载作废在途回应。
  const locateRef = useRef(locateDocument);
  locateRef.current = locateDocument;
  useEffect(() => {
    let live = true;
    void locateRef.current?.({ spec: capability }).then(
      (found) => {
        if (live && found) setDocPath(found.relative);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [capability]);

  const tree = (
    <>
      <DetailIdentity
        title={capability}
        copyLabel={t("common.copyName")}
        badges={<StatusPill tone="neutral">{t("sdetail.canonical")}</StatusPill>}
        provenance={[
          sections && (
            <span className="shrink-0">{tn("sdetail.metaRequirements", stats.requirements)}</span>
          ),
          sections && (
            <span className="shrink-0">{tn("sdetail.metaScenarios", stats.scenarios)}</span>
          ),
          stats.latest && (
            <span className="truncate">{`${t("sdetail.stateUpdated")} ${calendarDay(stats.latest.updated)}`}</span>
          ),
        ]}
        relations={
          sources.length > 0
            ? [
                {
                  mark: "trace",
                  label: t("sdetail.relationTrace"),
                  children: (
                    <>
                      <button
                        type="button"
                        className={cn(badgeVariants({ variant: "outline" }), "min-w-0 max-w-full cursor-(--cursor-interaction) font-mono hover:bg-muted")}
                        onClick={showTrace}
                      >
                        <span className="truncate">{sources[0].name}</span>
                      </button>
                      {sources.length > 1 && (
                        <button
                          type="button"
                          className={cn(badgeVariants({ variant: "secondary" }), "cursor-(--cursor-interaction) tabular-nums hover:bg-accent")}
                          onClick={showTrace}
                        >
                          {`+${sources.length - 1}`}
                        </button>
                      )}
                    </>
                  ),
                },
              ]
            : []
        }
      />

      <DetailTreeLabel>{t("detail.tree")}</DetailTreeLabel>
      <TabsList variant="tree" aria-label={t("detail.tree")}>
        <TabsTrigger value="spec">
          <FileText className="h-3.5 w-3.5" /> {t("sdetail.tabSpec")}
          {loaded && (
            <Badge variant="secondary" className="ml-auto">
              {stats.requirements}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="trace">
          <History className="h-3.5 w-3.5" /> {t("sdetail.tabTrace")}
          {loaded && (
            <Badge variant="secondary" className="ml-auto">
              {sources.length}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <DetailTreeLabel>{t("detail.status")}</DetailTreeLabel>
      <DetailStatus>
        <StatusRow mark="requirements" label={t("sdetail.stateRequirements")}>
          {loaded && <span className="font-mono text-[11px] tabular-nums">{stats.requirements}</span>}
        </StatusRow>
        <StatusRow mark="sources" label={t("sdetail.stateSources")}>
          {loaded && <span className="font-mono text-[11px] tabular-nums">{sources.length}</span>}
        </StatusRow>
        {stats.latest && (
          <StatusRow mark="updated" label={t("sdetail.stateUpdated")}>
            <span className="font-mono text-[11px] tabular-nums">{calendarDay(stats.latest.updated)}</span>
            <span className="truncate text-muted-foreground">{stats.latest.source}</span>
          </StatusRow>
        )}
      </DetailStatus>
    </>
  );

  // 提示框只放推得出的事实（design D4）：Purpose 待补在前、缺来源变更的需求在后；两者皆无时缺席。
  const callouts = (stats.purposeTbd || stats.untraced.length > 0) && (
    <div data-doc-callout className="flex flex-col gap-2.5">
      {stats.purposeTbd && (
        <Callout data-callout="purpose-tbd" tone="warning" title={t("specs.purposeTbd")} className="my-0">
          <p className="text-sm">
            <InlineMarks
              text={docPath ? t("sdetail.purposeTbdBody").replace("{path}", docPath) : t("sdetail.purposeTbdBodyNoPath")}
            />
          </p>
        </Callout>
      )}
      {stats.untraced.length > 0 && (
        <Callout
          data-callout="untraced"
          tone="note"
          title={tn("sdetail.untraced", stats.untraced.length)}
          className="my-0"
        >
          <p className="text-sm">{stats.untraced.join("、")}</p>
          <p className="text-sm text-muted-foreground">{t("sdetail.untracedBody")}</p>
        </Callout>
      )}
    </div>
  );

  return (
    <Tabs value={tab} onValueChange={setTab} orientation="vertical" activationMode="manual" className="h-full">
      <DetailShell
        data-spec-detail
        tree={tree}
        activeDoc={tab}
        tocKey={`${tab}\u0000${doc ?? ""}\u0000${needle}\u0000${toggles}`}
        bodyRef={bodyRef}
      >
        <TabsContent value="spec">
          <Card className="flex flex-col gap-5 p-6">
            <DocHeader
              title={t("sdetail.tabSpec")}
              badges={count(stats.requirements)}
              actions={
                <div className="flex items-center gap-1.5">
                  <SearchField value={query} onChange={setQuery} placeholder={t("sdetail.searchRequirements")} />
                  {renderDocumentActions?.({ doc: { spec: capability }, content: doc ?? null })}
                </div>
              }
              provenance={[docPath && <span className="font-mono">{docPath}</span>, t("sdetail.canonical"), updatedLine]}
            />
            <DocTiles tiles={specTiles(stats, t)} />
            {callouts}
            {/* 没有需求标题（或文档缺席）时整篇单一 markdown 查看退回：不接 bodyRef，本页目录无锚点。 */}
            <DocBody ref={sections ? bodyRef : undefined}>
              {/* 加载中画骨架；空态文案只在加载完成后出（spec「详情页文档加载以 skeleton 呈现」）。 */}
              {!loaded ? (
                <DocSkeleton />
              ) : !sections ? (
                <Markdown content={doc} empty={t("common.noContent")} />
              ) : (
                <div className="flex flex-col gap-6">
                  <section data-purpose className="flex flex-col gap-2.5">
                    <h2 data-doc-heading className={SECTION_HEADING_CLS}>
                      Purpose
                    </h2>
                    <Lead>
                      <Markdown content={sections.purpose} />
                    </Lead>
                  </section>
                  {/* 需求段之外的内容（引言、其他 `## ` 区段）照原文呈现，不丢。 */}
                  {sections.intro && (
                    <section data-spec-intro>
                      <Markdown content={sections.intro} />
                    </section>
                  )}
                  {visible.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">{t("sdetail.noMatch")}</p>
                  ) : (
                    // 收合规则依命中序：搜索过滤后第一条命中展开（key 含命中序，序一变即重挂回缺省）。
                    visible.map((r, i) => (
                      <RequirementBlock
                        key={`${i}:${r.title}`}
                        req={r}
                        collapse={{ defaultOpen: i === 0, onToggle: () => setToggles((n) => n + 1) }}
                        anchor={
                          <TraceAnchor trace={r.trace} byName={byName} onOpenArchivedChange={onOpenArchivedChange} />
                        }
                      />
                    ))
                  )}
                  {sections.appendix && (
                    <section data-spec-appendix>
                      <Markdown content={sections.appendix} />
                    </section>
                  )}
                </div>
              )}
            </DocBody>
          </Card>
        </TabsContent>
        <TabsContent value="trace">
          <Card className="flex flex-col gap-5 p-6">
            {/* 推导文档不对应文件：无「打开 ▾」。 */}
            <DocHeader
              title={t("sdetail.tabTrace")}
              badges={count(sources.length)}
              provenance={[t("sdetail.traceDerived"), t("sdetail.traceOrder")]}
            />
            <DocTiles tiles={traceTiles(stats, t)} />
            <DocBody>
              {!loaded ? (
                <DocSkeleton />
              ) : sources.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">{t("sdetail.noSources")}</p>
              ) : (
                sources.map((s) => (
                  <ListRow
                    key={s.name}
                    data-trace-row={s.name}
                    title={s.name}
                    description={s.archived ? s.archived.date : t("sdetail.noArchive")}
                    disabled={!s.archived}
                    onClick={() => s.archived && onOpenArchivedChange?.(s.archived.datedName)}
                  />
                ))
              )}
            </DocBody>
          </Card>
        </TabsContent>
      </DetailShell>
    </Tabs>
  );
}

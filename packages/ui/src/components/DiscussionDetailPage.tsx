import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, Check, Circle, FileText, Flag, MessagesSquare, Rocket } from "lucide-react";

import {
  DEFAULT_SPEC_DIR,
  type ArchivedItem,
  type ChangeItem,
  type DiscussionDocument,
  type DiscussionItem,
} from "../adapter";
import { countPriorDiscussions, type DiscussionSections } from "../discussionModel";
import { useI18n } from "../i18n";
import { changeStage } from "../stage";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { StatusPill, type StatusPillTone } from "./ui/status-pill";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Markdown } from "./Markdown";
import { DocSkeleton } from "./skeletons";
import { discussionChipStage, isCollapsedPromoted } from "./DiscussionColumn";
import { IdentityName, STAGE_PILL_TONE, StatusRow, type DocumentTarget } from "./DetailHeader";
import {
  DOC_TITLE_KEYS,
  DetailActions,
  DetailIdentity,
  DetailShell,
  DetailStatus,
  DetailTreeLabel,
  DocBody,
  DocHeader,
  DocTiles,
  type DetailRelation,
} from "./DetailShell";
import { ImproveChip } from "./ImproveStamp";
import { PromotedDoc, promotedRows, rowStage } from "./PromotedDoc";
import { ConclusionDoc, type ConclusionDocProps } from "./ConclusionDoc";
import { ContextDoc, type ContextDocProps } from "./ContextDoc";
import { RoundsDoc } from "./RoundsDoc";
import {
  discussionDocData,
  discussionDocProvenance,
  discussionDocSummary,
  discussionNames,
  type DiscussionDocData,
  type DiscussionTab,
} from "./discussionDocSummary";
import { isImproveKind } from "./improveStyle";

export interface DiscussionDetailPageProps {
  discussion: DiscussionItem | null;
  /** 刷新世代——递增即重载讨论记录内容（未传＝0，行为等同仅打开时加载）。 */
  refreshGen?: number;
  /** 记录全文与引擎解析的刀（slug 寻址）。 */
  loadDocument: (slug: string) => Promise<DiscussionDocument | null>;
  /** active change 清单（衍生变更现况派生）。 */
  changes: ChangeItem[];
  /** 已封存 change 清单（衍生变更已封存态派生）。 */
  archivedChanges: ArchivedItem[];
  /** 衍生变更签与分页的跳转（开该变更的详情页）。 */
  onOpenChangeCard?: (name: string) => void;
  /** 开已封存的变更（封存目录名）：衍生列、分刀卡与背景的已封存变更签；缺席时这些不可开。 */
  onOpenArchivedChange?: (datedName: string) => void;
  /** 正式规格名（背景的名称签、记录去向签）。 */
  specNames?: string[];
  /** 全部讨论的 slug（背景的名称签与先前讨论）。 */
  discussionSlugs?: string[];
  /** 开规格详情页。 */
  onOpenSpec?: (capability: string) => void;
  /** 开讨论详情页。 */
  onOpenDiscussion?: (slug: string) => void;
  /** 封存动词——与讨论卡同一确认流程（宿主接确认对话框）。未提供时不渲染（宿主以此表达
   * 「已封存」或 capability 缺口）。 */
  onArchiveDiscussion?: (slug: string) => void;
  /** 内容卡标头右端的文档动作（design D4「打开 ▾」）：各分页皆为讨论记录档，原文未载完为 null。 */
  renderDocumentActions?: (target: DocumentTarget | null) => ReactNode;
  /** 规格文件夹（数据源带出的相对路径）：记录路径由它组成；缺席时用 specseal。 */
  specDir?: string;
}

/** 标题列状态签（design D7）：判准与看板讨论卡一致——尚无结论的已转出、保留中的已转出
 * 同为警示色；其余已转出与已结论为主色；讨论中为中性。 */
function statusPill(d: DiscussionItem): { labelKey: string; tone: StatusPillTone } {
  if (d.status === "promoted") {
    if (d.concluded === false) return { labelKey: "discussion.statusPromotedUnconcluded", tone: "warning" };
    if (!isCollapsedPromoted(d)) return { labelKey: "discussion.statusPromotedHeld", tone: "warning" };
    return { labelKey: "ddrawer.stationPromoted", tone: "primary" };
  }
  if (d.status === "concluded") return { labelKey: "discussion.statusConcluded", tone: "primary" };
  return { labelKey: "discussion.statusOpen", tone: "neutral" };
}

/** 讨论详情页派生的步骤列站序；「已封存」站（序 3）只用在已封存讨论页。 */
const STATION = { open: 0, concluded: 1, promoted: 2 } as const;

/** 状态卡的阶段步骤列（讨论中 → 已结论 → 已转出 → 已封存）：现站签（色调与身分区状态签一致）、已过站打勾、
 * 未到站灰圈；尚无结论（`concluded` 为 false）时「已结论」站为未到站。讨论详情页与已封存讨论页共用（后者
 * 现站恒为「已封存」、不传色调与结论）。 */
export function DiscussionStageRow({
  current,
  tone = "primary",
  concluded = true,
}: {
  current: number;
  tone?: "primary" | "warning";
  concluded?: boolean;
}) {
  const { t } = useI18n();
  const stations = [
    t("discussion.statusOpen"),
    t("discussion.statusConcluded"),
    t("ddrawer.stationPromoted"),
    t("ddetail.stationArchived"),
  ];
  return (
    <StatusRow mark="stage" label={t("ddetail.stageLabel")} wrap>
      {stations.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5 text-xs">
          {i > 0 && <span className="text-muted-foreground/50">→</span>}
          {i === current ? (
            <StatusPill tone={tone} aria-current="step">
              {label}
            </StatusPill>
          ) : i < current && (i !== STATION.concluded || concluded) ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Check aria-hidden="true" className="h-3 w-3" />
              {label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-muted-foreground/50">
              <Circle aria-hidden="true" className="h-2.5 w-2.5" />
              {label}
            </span>
          )}
        </span>
      ))}
    </StatusRow>
  );
}

/** 缺省分页＝读者第一想看的：结论非空（去除鹰架注解后有内容）开结论，否则背景。 */
function defaultDiscussionTab(sections: DiscussionSections | null): "conclusion" | "context" {
  const hasConclusion = !!sections && sections.conclusion.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
  return hasConclusion ? "conclusion" : "context";
}

/** 受控文档的实际值：所选文档不在目前的节点组（记录切分前后不同）时退回缺省——切分成功取
 * `defaultDiscussionTab`，失败取「记录」。讨论详情页与已封存讨论页共用。 */
export function discussionDoc(picked: string | null, sections: DiscussionSections | null): DiscussionTab {
  const docs: DiscussionTab[] = sections ? ["conclusion", "rounds", "context", "promote"] : ["record", "promote"];
  return docs.find((d) => d === picked) ?? (sections ? defaultDiscussionTab(sections) : "record");
}

/** 衍生变更（列与签共用）：变更名、状态标示；`onOpen` 缺席＝不可打开。 */
interface PromotedChangeProps {
  name: string;
  badge: ReactNode;
  onOpen?: () => void;
}

/** 状态卡「衍生变更」列的一颗签：变更名钮（不可打开时停用）＋状态标示。讨论详情页与已封存讨论页共用。 */
export function PromotedChangeChip({ name, badge, onOpen }: PromotedChangeProps) {
  return (
    <span data-promoted-chip={name} className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!onOpen}
        className="h-auto rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-medium hover:bg-accent"
        onClick={onOpen}
      >
        {name}
      </Button>
      {badge}
    </span>
  );
}

/** 背景的已封存变更签以变更名打开：换成封存目录名再交给宿主。 */
export function openArchivedByName(archived: ArchivedItem[], open: (datedName: string) => void) {
  return (name: string) => {
    const hit = archived.find((a) => a.name === name);
    if (hit) open(hit.datedName);
  };
}

/**
 * 讨论记录四份文档的阅读卡内文（desktop-discussion-doc-views design D7）：记录切分成功时结论、讨论过程、背景
 * 各自的渲染器，失败时「记录」整篇 Markdown（加载中画骨架）；衍生变更一律 PromotedDoc。讨论详情页与已封存
 * 讨论页共用。
 */
export function DiscussionDocs({
  doc,
  data,
  context,
  empty,
  jump,
  onJumped,
}: {
  doc: DiscussionDocument | null | undefined;
  data: DiscussionDocData;
  /** 背景文档的身分与打开回呼；推导、创建日与记录路径取自 `data`。 */
  context: Omit<ContextDocProps, "model" | "empty" | "created" | "recordPath">;
  empty: { conclusion: string; rounds: string; context: string };
  /** 结论刀卡的「前往」请求（只有讨论详情页有）。 */
  jump?: ConclusionDocProps["jump"];
  onJumped?: () => void;
}) {
  const { t } = useI18n();
  const { sections, context: model } = data;
  return (
    <>
      {sections && model ? (
        <>
          <TabsContent value="conclusion">
            <ConclusionDoc
              text={sections.conclusion}
              cuts={doc?.cuts ?? []}
              empty={empty.conclusion}
              stageOf={rowStage(data.rows)}
              specNames={model.names.specs}
              onOpenSpec={context.onOpenSpec}
              jump={jump}
              onJumped={onJumped}
            />
          </TabsContent>
          <TabsContent value="rounds">
            {/* 换讨论时展开状态归零。 */}
            <RoundsDoc key={model.names.self} text={sections.rounds} empty={empty.rounds} />
          </TabsContent>
          <TabsContent value="context">
            <ContextDoc
              {...context}
              model={model}
              created={data.created}
              recordPath={data.recordPath}
              empty={empty.context}
            />
          </TabsContent>
        </>
      ) : (
        // 区段缺失或格式非预期：整篇以单一查看退回（不报错）；加载中画骨架、空态文案只在加载完成后出。
        <TabsContent value="record">
          {doc === undefined ? <DocSkeleton /> : <Markdown content={doc?.content ?? null} empty={t("common.noContent")} />}
        </TabsContent>
      )}
      <TabsContent value="promote">
        <PromotedDoc rows={data.rows} cuts={data.cuts} />
      </TabsContent>
    </>
  );
}

/**
 * 讨论详情页（design D5；spec「详情页的文档树、阅读卡与本页目录」）：左栏身分区（slug＋拷贝＋
 * 状态签＋改进签、topic、出身、「关联」列）、「文档」节点 结论／讨论过程 N／背景／衍生变更 N
 * （结论非空时缺省开结论）、「状态」列（阶段步骤列、保留在途、衍生变更签）；封存动作经
 * `DetailActions` 进标题列。衍生变更唯读——无转出动作（promote 已自 GUI 撤除，转出改由
 * CLI／agent）。记录格式非预期时整篇单一查看退回（节点为 记录／衍生变更）。
 */
export function DiscussionDetailPage({
  discussion,
  refreshGen,
  loadDocument,
  changes,
  archivedChanges,
  onOpenChangeCard,
  onOpenArchivedChange,
  specNames,
  discussionSlugs,
  onOpenSpec,
  onOpenDiscussion,
  onArchiveDiscussion,
  renderDocumentActions,
  specDir = DEFAULT_SPEC_DIR,
}: DiscussionDetailPageProps) {
  const { t, tn } = useI18n();
  const [doc, setDoc] = useState<DiscussionDocument | null | undefined>();
  // 用户选的文档；null＝依缺省规则（记录加载前后、结论有无都跟着走）。
  const [picked, setPicked] = useState<string | null>(null);
  // 未转出提示框「前往」的卷动请求（seq 递增，同一刀可重复跳）；结论文档处理完即清除。
  const [cutJump, setCutJump] = useState<ConclusionDocProps["jump"]>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const slug = discussion?.slug ?? null;
  const gen = refreshGen ?? 0;
  // latest-wins：回应带发起序号，落后即丢弃（涵盖世代与换讨论的交错）。
  const requestSeq = useRef(0);
  const loadedGen = useRef(-1);

  const loadRecord = (g: number, target: string, clear: boolean) => {
    const seq = ++requestSeq.current;
    loadedGen.current = g;
    if (clear) setDoc(undefined);
    void loadDocument(target)
      .then((v) => {
        if (requestSeq.current === seq) setDoc(v);
      })
      // 失败收敛：还没有东西可显示才落终态空文案（undefined 停着＝永久骨架）；
      // 已有内容维持前值——重载的短暂失败不得抹成假空态。
      .catch(() => {
        if (requestSeq.current === seq) setDoc((prev) => (prev === undefined ? null : prev));
      });
  };

  // 打开／换讨论：清空后加载，文档回到缺省。
  useEffect(() => {
    if (!slug) return;
    setPicked(null);
    loadRecord(gen, slug, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // 外部世代重载（add-round／conclude／转出后）：不清空、回应到达后就地替换，分页选择不重置。
  useEffect(() => {
    if (!slug) return;
    if (gen <= loadedGen.current) return;
    loadRecord(gen, slug, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, gen]);

  if (!discussion) return null;

  // 衍生列与背景的已封存变更签都以变更名打开：换成封存目录名再交给宿主。
  const openArchivedName = onOpenArchivedChange && openArchivedByName(archivedChanges, onOpenArchivedChange);
  const rows = promotedRows(discussion.promotedTo, changes, archivedChanges, t, onOpenChangeCard, openArchivedName);
  const recordPath = `${specDir}/discussions/${discussion.slug}.md`;
  const data = discussionDocData({
    doc,
    status: discussion.status,
    hold: discussion.hold === true,
    created: discussion.created ?? null,
    recordPath,
    rows,
    names: discussionNames(discussion.slug, { specNames, changes, archivedChanges, discussionSlugs }),
    onLocateCut: (id) => setCutJump((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 })),
  });
  const { sections } = data;
  const pill = statusPill(discussion);
  const hold = discussion.hold === true;

  const childStage = (name: string): { label: string; tone: StatusPillTone; alive: boolean } => {
    const active = changes.find((c) => c.name === name);
    const label = t(discussionChipStage(name, changes, archivedChanges));
    if (active) return { label, tone: STAGE_PILL_TONE[changeStage(active)], alive: true };
    if (archivedChanges.some((a) => a.name === name)) return { label, tone: "neutral", alive: false };
    return { label, tone: "destructive", alive: false };
  };
  // 衍生列与衍生签共用：阶段签，与只有作用中的子变更可打开。
  const stageBadge = (name: string) => {
    const stage = childStage(name);
    return (
      <StatusPill tone={stage.tone} className={stage.tone === "destructive" ? "line-through" : undefined}>
        {stage.label}
      </StatusPill>
    );
  };
  const openChild = (name: string) => (childStage(name).alive ? () => onOpenChangeCard?.(name) : undefined);

  // 阶段步骤列：现站由 status 派生；「已封存」站留给已封存讨论页。
  const stationIndex =
    discussion.status === "promoted"
      ? STATION.promoted
      : discussion.status === "concluded"
        ? STATION.concluded
        : STATION.open;

  // 封存动词：concluded 才可及；保留在途（hold）时停用并说明最后一刀转出后自动封存。
  const archiveAction =
    onArchiveDiscussion && (discussion.status === "concluded" || hold) ? (
      hold ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={0}>
              <Button variant="outline" size="sm" disabled title={t("ddetail.holdHint")}>
                <Archive className="h-3.5 w-3.5" /> {t("common.archive")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("ddetail.holdHint")}</TooltipContent>
        </Tooltip>
      ) : (
        <Button variant="outline" size="sm" onClick={() => onArchiveDiscussion(discussion.slug)}>
          <Archive className="h-3.5 w-3.5" /> {t("common.archive")}
        </Button>
      )
    ) : undefined;

  const promoteCount = discussion.promotedTo.length;
  // 受控文档：关联列要能切到背景。
  const tab = discussionDoc(picked, sections);
  const summary = discussionDocSummary(tab, data, { t, tn });
  const prior = sections ? countPriorDiscussions(sections.context) : null;
  const relations: DetailRelation[] =
    prior === null
      ? []
      : [
          {
            mark: "related",
            label: t("ddetail.relations"),
            children: (
              <button type="button" className="min-w-0" onClick={() => setPicked("context")}>
                <Badge variant="outline" className="hover:bg-accent">
                  {tn("ddetail.priorDiscussions", prior)}
                </Badge>
              </button>
            ),
          },
        ];

  const promoteTrigger = (
    <TabsTrigger value="promote">
      <Rocket className="h-3.5 w-3.5" /> {t("ddrawer.tabPromote")}
      <Badge variant="secondary" className="ml-auto">
        {promoteCount}
      </Badge>
    </TabsTrigger>
  );

  const tree = (
    <>
      {/* slug（文件名）为题＋拷贝钮——与变更详情页「名称＋拷贝钮」对称（LANGUAGE.md 受控例外）；
          topic 为其下最多三行。 */}
      <DetailIdentity
        title={discussion.slug}
        copyLabel={t("discussion.copySlug")}
        badges={
          <>
            <StatusPill data-discussion-status tone={pill.tone}>
              {t(pill.labelKey)}
            </StatusPill>
            {/* 改进标示（spec「讨论详情页的改进标示」）：与卡片小章同一词条。 */}
            {isImproveKind(discussion.kind) && <ImproveChip />}
          </>
        }
        subtitle={discussion.topic}
        provenance={[
          discussion.createdBy && <IdentityName identity={discussion.createdBy} />,
          <span className="shrink-0 tabular-nums">{tn("common.rounds", discussion.rounds)}</span>,
          discussion.created && <span className="shrink-0">{discussion.created}</span>,
        ]}
        relations={relations}
      />

      <DetailTreeLabel>{t("detail.tree")}</DetailTreeLabel>
      <TabsList variant="tree" aria-label={t("detail.tree")}>
        {sections ? (
          <>
            <TabsTrigger value="conclusion">
              <Flag className="h-3.5 w-3.5" /> {t("ddrawer.tabConclusion")}
            </TabsTrigger>
            <TabsTrigger value="rounds">
              <MessagesSquare className="h-3.5 w-3.5" /> {t("ddrawer.tabRounds")}
              <Badge variant="secondary" className="ml-auto">
                {discussion.rounds}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="context">
              <FileText className="h-3.5 w-3.5" /> {t("ddrawer.tabContext")}
            </TabsTrigger>
          </>
        ) : (
          <TabsTrigger value="record">
            <FileText className="h-3.5 w-3.5" /> {t("ddrawer.tabRecord")}
          </TabsTrigger>
        )}
        {promoteTrigger}
      </TabsList>

      <DetailTreeLabel>{t("detail.status")}</DetailTreeLabel>
      <DetailStatus>
        {/* 只映射 warning：open 讨论的状态签是 neutral，现站维持主色。 */}
        <DiscussionStageRow
          current={stationIndex}
          tone={pill.tone === "warning" ? "warning" : "primary"}
          concluded={discussion.concluded !== false}
        />
        {hold && (
          <StatusRow mark="hold" label={t("ddetail.holdLabel")} wrap>
            <span className="text-muted-foreground">{t("ddetail.holdHint")}</span>
          </StatusRow>
        )}
        {promoteCount > 0 && (
          <StatusRow mark="promoted" label={t("ddetail.promotedLabel")} wrap>
            {discussion.promotedTo.map((name) => (
              <PromotedChangeChip key={name} name={name} badge={stageBadge(name)} onOpen={openChild(name)} />
            ))}
          </StatusRow>
        )}
      </DetailStatus>
    </>
  );

  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={setPicked} orientation="vertical" activationMode="manual" className="h-full">
        <DetailShell
          data-discussion-detail
          tree={tree}
          activeDoc={`${discussion.slug}\u0000${tab}`}
          tocKey={`${tab}\u0000${doc?.content ?? ""}`}
          bodyRef={bodyRef}
        >
          {archiveAction && <DetailActions>{archiveAction}</DetailActions>}
          <Card className="flex flex-col gap-5 p-6">
            <DocHeader
              title={t(DOC_TITLE_KEYS[tab])}
              actions={renderDocumentActions?.({ doc: { discussion: discussion.slug }, content: doc?.content ?? null })}
              provenance={discussionDocProvenance(tab, data, { t, tn })}
            />
            <DocTiles tiles={summary.tiles} />
            {summary.callout && <div data-doc-callout>{summary.callout}</div>}
            <DocBody ref={bodyRef}>
              <DiscussionDocs
                doc={doc}
                data={data}
                context={{
                  createdBy: discussion.createdBy,
                  kind: discussion.kind,
                  onOpenSpec,
                  onOpenChange: onOpenChangeCard,
                  onOpenArchivedChange: openArchivedName,
                  onOpenDiscussion,
                }}
                empty={{
                  conclusion: t("ddrawer.noConclusion"),
                  rounds: t("ddrawer.noRounds"),
                  context: t("ddrawer.noContext"),
                }}
                jump={cutJump}
                onJumped={() => setCutJump(null)}
              />
            </DocBody>
          </Card>
        </DetailShell>
      </Tabs>
    </TooltipProvider>
  );
}

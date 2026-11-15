import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Code2, FileText, Flag, ListChecks, MessagesSquare, PenTool, Rocket } from "lucide-react";

import type { ArchivedItem, ChangeItem, DiscussionDocument, StationTicket, TicketStation } from "../adapter";
import { useI18n } from "../i18n";
import { parseTasks } from "../tasks";
import { settle, useGenerationLoad } from "../lib/useGenerationLoad";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { StatusPill } from "./ui/status-pill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { TooltipProvider } from "./ui/tooltip";
import { changeDocSummary } from "./changeDocSummary";
import { DeltaCapSection } from "./DeltaBadges";
import { DesignDoc } from "./DesignDoc";
import type { PathReveal } from "./DocParts";
import { discussionDoc, DiscussionDocs, DiscussionStageRow, PromotedChangeChip } from "./DiscussionDetailPage";
import { discussionDocData, discussionDocProvenance, discussionDocSummary, discussionNames } from "./discussionDocSummary";
import { IdentityName, StatusRow, documentArtifact, type DocumentTarget } from "./DetailHeader";
import {
  DOC_TITLE_KEYS,
  DetailIdentity,
  DetailShell,
  DetailStatus,
  DetailTreeLabel,
  DocBody,
  DocHeader,
  DocTiles,
  changeDocTocKey,
} from "./DetailShell";
import { ImproveChip } from "./ImproveStamp";
import { isImproveKind } from "./improveStyle";
import { REVIEW_ICON, REVIEW_LABEL_KEY, REVIEW_PILL_TONE } from "./reviewStyle";
import { ProposalDoc } from "./ProposalDoc";
import { promotedRows, promotedRowsFromLinks } from "./PromotedDoc";
import { DocSkeleton } from "./skeletons";
import { SourceChipRow, type SourceLinkItem } from "./SourceDiscussionChip";
import { TaskList } from "./TaskList";
import { TicketTabBody, useStationTickets } from "./TicketView";
import { useDocNav } from "./useDocNav";
import { VERIFY_ICON, VERIFY_LABEL_KEY, VERIFY_PILL_TONE } from "./verifyStyle";

/** 页目标（discriminated target 两型同档）：封存变更或封存讨论。 */
export type ArchivedTarget =
  | { kind: "change"; datedName: string }
  | { kind: "discussion"; slug: string };

export interface ArchivedDetailPageProps {
  target: ArchivedTarget | null;
  /** 刷新世代——递增即就地重载（不清空、latest-wins；未传＝0）。 */
  refreshGen?: number;
  /** 读取封存变更的 artifact 原文（dated name 寻址）；缺件回 null。 */
  loadDocument: (datedName: string, artifact: string) => Promise<string | null>;
  /** 列出封存变更的 delta capability 名。 */
  loadCapabilities: (datedName: string) => Promise<string[]>;
  /** 封存目录带走的化石工单（spec「已封存详情页的工单分页」）：对应分页出现时加载；
   * 回 null 或 reject 皆为分页空态。未提供时内容为空态。 */
  loadStationTicket?: (datedName: string, station: TicketStation) => Promise<StationTicket | null>;
  /** 读取封存讨论记录全文与引擎解析的刀（slug 寻址）；缺席回 null。 */
  loadDiscussionDocument: (slug: string) => Promise<DiscussionDocument | null>;
  /** 封存变更的来源讨论（slug＋topic，宿主解析；缺席／空＝出身列无「来自」）。 */
  sourceDiscussions?: { slug: string; topic: string }[];
  /** 点来源讨论签：宿主打开该讨论的已封存详情页。 */
  onOpenDiscussion?: (slug: string) => void;
  /** 封存讨论背景文档的讨论签（内文名称签与先前讨论）：宿主依讨论所在开页——作用中开讨论详情页、其余开已封存
   * 详情页（`discussionSlugs` 含作用中的讨论）。缺席时这些签不可开。 */
  onOpenContextDiscussion?: (slug: string) => void;
  /** 封存讨论的衍生变更签项（宿主派生三态：已封存→副标封存日期、活跃→副标看板阶段词、
   * 已删除→disabled「无封存记录」）；缺席／空＝状态卡的衍生列缺席。 */
  promotedChanges?: SourceLinkItem[];
  /** 点可点的衍生变更签：宿主依子变更所在打开已封存详情页或变更详情页。 */
  onOpenPromotedChange?: (name: string) => void;
  /** 封存时的审查结局（spec「已封存侧的审查标示」）。 */
  reviewStatus?: ArchivedItem["reviewStatus"];
  /** 封存时的验证结局（spec「已封存侧的验证标示」）；与审查结局并存。 */
  verifyStatus?: ArchivedItem["verifyStatus"];
  /** 封存讨论的 kind（标示随 kind 恒定）。 */
  discussionKind?: string | null;
  /** 封存讨论的 topic（标题下方一行）。 */
  discussionTopic?: string;
  /** 出身列的创建者（"Name <email>"）；缺席＝该栏缺席。 */
  createdBy?: string | null;
  /** 出身列的创建日期 YYYY-MM-DD；缺席＝该栏缺席。 */
  created?: string;
  /** 出身列与状态卡的封存日期 YYYY-MM-DD；缺席＝该栏缺席。 */
  archivedDate?: string;
  /** 内容卡标头右端的文档动作（「打开 ▾」）。 */
  renderDocumentActions?: (target: DocumentTarget | null) => ReactNode;
  /** 开该能力的规格详情页（规格文档能力头的「看正式规格」）；未提供时不渲染该钮。 */
  onOpenSpec?: (capability: string) => void;
  /** 提案影响段路径签的本机路径动作（文案依平台）；未提供时只有拷贝钮。 */
  pathReveal?: PathReveal;
  /** 作用中与已封存变更清单：两份都有时封存讨论的衍生列带任务进度、两站章与日期，否则退回 `promotedChanges`。 */
  changes?: ChangeItem[];
  archivedChanges?: ArchivedItem[];
  /** 正式规格名与全部讨论 slug：封存讨论背景的名称签。 */
  specNames?: string[];
  discussionSlugs?: string[];
}

type Doc = string | null | undefined;

/** 出身列各段：创建者、创建日期、「封存 日期」——任一缺席该段缺席。 */
function provenance(
  t: (key: string) => string,
  { createdBy, created, archivedDate }: Pick<ArchivedDetailPageProps, "createdBy" | "created" | "archivedDate">,
): ReactNode[] {
  return [
    createdBy && <IdentityName identity={createdBy} />,
    created && <span className="shrink-0">{created}</span>,
    archivedDate && <span className="shrink-0">{t("adetail.archivedOn").replace("{date}", archivedDate)}</span>,
  ];
}

/** 身分区的「已封存」签：封存变更与封存讨论共用。 */
function ArchivedPill() {
  const { t } = useI18n();
  return (
    <StatusPill data-archived-status tone="neutral">
      {t("ddetail.stationArchived")}
    </StatusPill>
  );
}

/** 分页 → 封存目录内的文件（规格另依 capability 组路径）。 */
const TAB_FILES: Record<string, string> = {
  proposal: "proposal.md",
  design: "design.md",
  tasks: "tasks.md",
  review: "review.md",
  verify: "verify.md",
};

/** 封存变更变体（design D3）。 */
function ArchivedChangeView({ datedName, ...props }: ArchivedDetailPageProps & { datedName: string }) {
  const { t, tn } = useI18n();
  const [proposal, setProposal] = useState<Doc>();
  const [design, setDesign] = useState<Doc>();
  const [tasksMd, setTasksMd] = useState<Doc>();
  // undefined＝capability 清单与其规格文档尚未载完（与「无规格差异」的空对象分流）。
  const [specDocs, setSpecDocs] = useState<Record<string, string | null> | undefined>();
  const [tab, setTab] = useState("proposal");
  // 能力签→规格段、D 签→决策卡、「前往」→任务列的跳转请求（与变更详情页同一套；换变更时以 key 重挂）。
  const nav = useDocNav(setTab);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gen = props.refreshGen ?? 0;

  useGenerationLoad(gen, (isLatest) => {
    const fresh = (apply: (v: string | null) => void) => (v: string | null) => {
      if (isLatest()) apply(v);
    };
    const load = (artifact: string, apply: Dispatch<SetStateAction<Doc>>) =>
      void props.loadDocument(datedName, artifact).then(fresh(apply)).catch(settle(apply, null, isLatest));
    load("proposal.md", setProposal);
    load("design.md", setDesign);
    load("tasks.md", setTasksMd);
    void props
      .loadCapabilities(datedName)
      .then(async (caps) => {
        const entries = await Promise.all(
          caps.map(async (cap) => [cap, await props.loadDocument(datedName, `specs/${cap}/spec.md`)] as const),
        );
        if (isLatest()) setSpecDocs(Object.fromEntries(entries));
      })
      .catch(settle(setSpecDocs, {}, isLatest));
  });

  // 工单分页条件（spec「已封存详情页的工单分页」）：带走化石工单而无章的结局才出现、才加载。
  const carriedReview = props.reviewStatus === "reviewedNotPassed";
  const carriedVerify = props.verifyStatus === "verifiedNotPassed";
  const tickets = useStationTickets(datedName, { review: carriedReview, verify: carriedVerify }, gen, props.loadStationTicket);

  // 结局签（spec「已封存侧的审查标示」「已封存侧的验证标示」）：只在「状态」区的「品质关卡」
  // 列渲染——身分区只放「已封存」签。
  const review = props.reviewStatus === "reviewed" || props.reviewStatus === "reviewedNotPassed" ? props.reviewStatus : null;
  const verify = props.verifyStatus === "verified" || props.verifyStatus === "verifiedNotPassed" ? props.verifyStatus : null;
  const outcomes = (
    <>
      {review && (
        <StatusPill data-review-outcome tone={REVIEW_PILL_TONE[review]} icon={REVIEW_ICON[review]}>
          {t(REVIEW_LABEL_KEY[review])}
        </StatusPill>
      )}
      {verify && (
        <StatusPill data-verify-outcome tone={VERIFY_PILL_TONE[verify]} icon={VERIFY_ICON[verify]}>
          {t(VERIFY_LABEL_KEY[verify])}
        </StatusPill>
      )}
    </>
  );

  const tasks = parseTasks(tasksMd);
  const specCaps = Object.keys(specDocs ?? {});
  const shownCap = nav.specCap && specCaps.includes(nav.specCap) ? nav.specCap : specCaps[0];
  const docTarget: DocumentTarget | null =
    tab === "specs"
      ? shownCap
        ? { doc: { archived: datedName, artifact: `specs/${shownCap}/spec.md` }, content: specDocs![shownCap] }
        : null
      : tab === "review" || tab === "verify"
        ? { doc: { archived: datedName, artifact: TAB_FILES[tab] } }
        : {
            doc: { archived: datedName, artifact: TAB_FILES[tab] },
            content: ({ proposal, design, tasks: tasksMd } as Record<string, Doc>)[tab] ?? null,
          };

  const docPath = documentArtifact(docTarget);
  const tocKey = changeDocTocKey(tab, { content: docTarget?.content, specs: specDocs, tickets });
  // 阅读卡标题区（design D9）：唯读、无调度；化石工单不给「可以盖章」提示框。
  const summary = changeDocSummary(
    tab,
    {
      proposal,
      design,
      tasksMd,
      specDocs,
      change: null,
      tickets,
      readOnly: true,
      onLocateTask: nav.locateTask,
    },
    { t, tn },
  );
  const calloutSlot = summary.callout && <div data-doc-callout>{summary.callout}</div>;

  const tree = (
    <>
      {/* 标题为变更名、拷贝含日期前缀的封存目录名；无动作——封存是唯读定格。 */}
      <DetailIdentity
        title={datedName.replace(/^\d{4}-\d{2}-\d{2}-/, "")}
        copyLabel={t("archived.copyName")}
        copyValue={datedName}
        badges={<ArchivedPill />}
        provenance={provenance(t, props)}
        relations={
          (props.sourceDiscussions ?? []).length > 0
            ? [
                {
                  mark: "from",
                  label: t("detail.relFrom"),
                  children: (
                    <SourceChipRow
                      items={props.sourceDiscussions ?? []}
                      onOpen={(slug) => props.onOpenDiscussion?.(slug)}
                    />
                  ),
                },
              ]
            : []
        }
      />

      <DetailTreeLabel>{t("detail.tree")}</DetailTreeLabel>
      <TabsList variant="tree" aria-label={t("detail.tree")}>
        <TabsTrigger value="proposal">
          <FileText className="h-3.5 w-3.5" /> {t("common.tabProposal")}
        </TabsTrigger>
        <TabsTrigger value="design">
          <PenTool className="h-3.5 w-3.5" /> {t("common.tabDesign")}
        </TabsTrigger>
        <TabsTrigger value="tasks">
          <ListChecks className="h-3.5 w-3.5" /> {t("common.tabTasks")}
        </TabsTrigger>
        <TabsTrigger value="specs">
          <Code2 className="h-3.5 w-3.5" /> {t("common.tabSpecs")}
          {specCaps.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {specCaps.length}
            </Badge>
          )}
        </TabsTrigger>
        {/* 条件式工单节点：规格之后、审查在前，与身分区结局签同序。 */}
        {carriedReview && (
          <TabsTrigger value="review">
            {REVIEW_ICON.reviewedNotPassed} {t("drawer.tab.review")}
          </TabsTrigger>
        )}
        {carriedVerify && (
          <TabsTrigger value="verify">
            {VERIFY_ICON.verifiedNotPassed} {t("drawer.tab.verify")}
          </TabsTrigger>
        )}
      </TabsList>

      <DetailTreeLabel>{t("detail.status")}</DetailTreeLabel>
      <DetailStatus>
        <StatusRow mark="tasks" label={t("detail.statusTasks")}>
          {tasksMd !== undefined && (
            <span className="font-mono text-[11px] tabular-nums">
              {tasksMd === null ? t("adetail.tasksNone") : `${tasks.filter((l) => l.done).length}/${tasks.length}`}
            </span>
          )}
        </StatusRow>
        <StatusRow mark="quality" label={t("detail.statusQuality")} wrap>
          {review || verify ? outcomes : <span className="text-muted-foreground">{t("adetail.noQuality")}</span>}
        </StatusRow>
        <StatusRow mark="archived" label={t("adetail.statusArchived")}>
          {props.archivedDate && <span className="font-mono text-[11px] tabular-nums">{props.archivedDate}</span>}
        </StatusRow>
      </DetailStatus>
    </>
  );

  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={setTab} orientation="vertical" activationMode="manual" className="h-full">
        <DetailShell data-archived-detail="change" tree={tree} activeDoc={tab} tocKey={tocKey} bodyRef={bodyRef}>
          <Card className="flex flex-col gap-5 p-6">
            <DocHeader
              title={t(DOC_TITLE_KEYS[tab])}
              badges={summary.badges}
              actions={props.renderDocumentActions?.(docTarget)}
              provenance={[docPath && <span className="font-mono">{docPath}</span>]}
            />
            <DocTiles tiles={summary.tiles} />
            {tab !== "proposal" && calloutSlot}
            <DocBody ref={bodyRef}>
              {/* 各文档三态：加载中画骨架，空态文案只在加载完成后出。 */}
              <TabsContent value="proposal">
                {proposal === undefined ? (
                  <DocSkeleton />
                ) : (
                  <ProposalDoc
                    content={proposal}
                    empty={t("archived.noProposal")}
                    deltaCaps={specCaps}
                    onOpenCapability={nav.openSpec}
                    pathReveal={props.pathReveal}
                    afterCapabilities={tab === "proposal" ? calloutSlot : null}
                  />
                )}
              </TabsContent>
              <TabsContent value="design">
                {design === undefined ? (
                  <DocSkeleton />
                ) : (
                  <DesignDoc content={design} empty={t("archived.noDesign")} jump={nav.designJump} onJumped={nav.clearDesignJump} />
                )}
              </TabsContent>
              <TabsContent value="tasks">
                {/* 唯读：勾选回呼不接——核取方块 disabled、无把手、无批量工具列、整列不回应；展开与 D 签照常。 */}
                {tasksMd === undefined ? (
                  <DocSkeleton />
                ) : (
                  <TaskList
                    markdown={tasksMd}
                    readOnly
                    onJumpDecision={nav.jumpDecision}
                    locate={nav.taskLocate}
                    onLocated={nav.clearTaskLocate}
                  />
                )}
              </TabsContent>
              <TabsContent value="specs">
                {specDocs === undefined ? (
                  <DocSkeleton />
                ) : specCaps.length === 0 ? (
                  <div className="py-6 text-sm text-muted-foreground">{t("archived.noSpecs")}</div>
                ) : (
                  Object.entries(specDocs).map(([cap, doc]) => (
                    <DeltaCapSection
                      key={cap}
                      cap={cap}
                      doc={doc}
                      jump={nav.specJump}
                      onJumped={nav.clearSpecJump}
                      onOpenSpec={props.onOpenSpec}
                    />
                  ))
                )}
              </TabsContent>
              {carriedReview && (
                <TabsContent value="review">
                  <TicketTabBody station="review" ticket={tickets.review} />
                </TabsContent>
              )}
              {carriedVerify && (
                <TabsContent value="verify">
                  <TicketTabBody station="verify" ticket={tickets.verify} />
                </TabsContent>
              )}
            </DocBody>
          </Card>
        </DetailShell>
      </Tabs>
    </TooltipProvider>
  );
}

/** 封存讨论变体（design D3）。 */
function ArchivedDiscussionView({ slug, ...props }: ArchivedDetailPageProps & { slug: string }) {
  const { t, tn } = useI18n();
  const [doc, setDoc] = useState<DiscussionDocument | null | undefined>();
  // 用户选的文档；null＝依缺省规则（记录加载前后、结论有无都跟着走）。
  const [picked, setPicked] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useGenerationLoad(props.refreshGen ?? 0, (isLatest) => {
    void props
      .loadDiscussionDocument(slug)
      .then((v) => {
        if (isLatest()) setDoc(v);
      })
      .catch(settle(setDoc, null, isLatest));
  });

  const promoted = props.promotedChanges ?? [];
  const { changes, archivedChanges, onOpenPromotedChange } = props;
  // 衍生列：两份清单都有时与讨论详情页同一套推导（打开都委派宿主，宿主依所在开页），否则退回宿主派生的三态。
  const rows =
    changes && archivedChanges
      ? promotedRows(
          promoted.map((item) => item.slug),
          changes,
          archivedChanges,
          t,
          onOpenPromotedChange,
          onOpenPromotedChange,
        )
      : promotedRowsFromLinks(promoted, onOpenPromotedChange);
  // 已封存：没有记录路径段、不出「只差最后一刀」。
  const data = discussionDocData({
    doc,
    status: "archived",
    hold: false,
    created: props.created ?? null,
    recordPath: null,
    rows,
    names: discussionNames(slug, {
      specNames: props.specNames,
      changes,
      archivedChanges,
      discussionSlugs: props.discussionSlugs,
    }),
  });
  const { sections } = data;
  const roundCount = data.rounds?.length ?? null;
  // 衍生列与衍生签共用：不可点（已删除）者无打开动作。
  const openPromoted = (item: SourceLinkItem) =>
    item.disabled ? undefined : () => props.onOpenPromotedChange?.(item.slug);
  const tab = discussionDoc(picked, sections);
  const summary = discussionDocSummary(tab, data, { t, tn });

  const tree = (
    <>
      <DetailIdentity
        title={slug}
        copyLabel={t("discussion.copySlug")}
        badges={
          <>
            <ArchivedPill />
            {isImproveKind(props.discussionKind) && <ImproveChip />}
          </>
        }
        subtitle={props.discussionTopic}
        provenance={provenance(t, props)}
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
              {roundCount !== null && (
                <Badge variant="secondary" className="ml-auto">
                  {roundCount}
                </Badge>
              )}
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
        <TabsTrigger value="promote">
          <Rocket className="h-3.5 w-3.5" /> {t("ddrawer.tabPromote")}
          <Badge variant="secondary" className="ml-auto">
            {promoted.length}
          </Badge>
        </TabsTrigger>
      </TabsList>

      <DetailTreeLabel>{t("detail.status")}</DetailTreeLabel>
      <DetailStatus>
        <DiscussionStageRow current={3} />
        {promoted.length > 0 && (
          <StatusRow mark="promoted" label={t("ddetail.promotedLabel")} wrap>
            {promoted.map((item) => (
              <PromotedChangeChip
                key={item.slug}
                name={item.slug}
                badge={<span className="text-xs text-muted-foreground">{item.topic}</span>}
                onOpen={openPromoted(item)}
              />
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
          data-archived-detail="discussion"
          tree={tree}
          activeDoc={tab}
          tocKey={`${tab}\u0000${doc?.content ?? ""}`}
          bodyRef={bodyRef}
        >
          <Card className="flex flex-col gap-5 p-6">
            {/* 封存讨论的文件名带封存日期而清单数据不带：「打开 ▾」只能拷贝内容。 */}
            <DocHeader
              title={t(DOC_TITLE_KEYS[tab])}
              actions={props.renderDocumentActions?.({ doc: null, content: doc?.content ?? null })}
              provenance={discussionDocProvenance(tab, data, { t, tn })}
            />
            <DocTiles tiles={summary.tiles} />
            {summary.callout && <div data-doc-callout>{summary.callout}</div>}
            <DocBody ref={bodyRef}>
              <DiscussionDocs
                doc={doc}
                data={data}
                context={{
                  createdBy: props.createdBy,
                  kind: props.discussionKind,
                  onOpenSpec: props.onOpenSpec,
                  onOpenChange: onOpenPromotedChange,
                  onOpenArchivedChange: onOpenPromotedChange,
                  onOpenDiscussion: props.onOpenContextDiscussion,
                }}
                empty={{
                  conclusion: t("archived.noConclusion"),
                  rounds: t("archived.noRounds"),
                  context: t("archived.noContext"),
                }}
              />
            </DocBody>
          </Card>
        </DetailShell>
      </Tabs>
    </TooltipProvider>
  );
}

/**
 * 已封存详情页（spec「已封存项目以详情页查看」；design D5）：与变更／讨论详情页同一三栏骨架、
 * 唯读——身分区带「已封存」签，不渲染标题列动作。
 * 目标一换即以 key 重挂对应变体——清空后全量加载；世代递增就地重载。
 */
export function ArchivedDetailPage(props: ArchivedDetailPageProps) {
  const { target } = props;
  if (!target) return null;
  return target.kind === "change" ? (
    <ArchivedChangeView key={`c:${target.datedName}`} {...props} datedName={target.datedName} />
  ) : (
    <ArchivedDiscussionView key={`d:${target.slug}`} {...props} slug={target.slug} />
  );
}

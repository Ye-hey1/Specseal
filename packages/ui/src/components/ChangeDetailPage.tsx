import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Archive,
  Code2,
  FileText,
  GitBranch,
  Hand,
  ListChecks,
  ListOrdered,
  MoreHorizontal,
  PenTool,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";

import type {
  ChangeItem,
  ChangeMetaInfo,
  StationTicket,
  TicketStation,
  Verb,
  VerbDrawerResult,
} from "../adapter";
import { specDeltaCounts, sumDeltaCounts } from "../delta";
import {
  changeStage,
  planBlockedBy,
  planBlockedLabel,
  planWave,
  planWaveLabel,
} from "../stage";
import { newCapabilities } from "../docModel";
import { useI18n } from "../i18n";
import { relativeDays } from "../time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { StatusPill, type StatusPillTone } from "./ui/status-pill";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { SourceChipRow } from "./SourceDiscussionChip";
import { changeDocSummary } from "./changeDocSummary";
import { DesignDoc } from "./DesignDoc";
import type { PathReveal } from "./DocParts";
import { ProposalDoc } from "./ProposalDoc";
import { DocSkeleton } from "./skeletons";
import { PlanDoc } from "./PlanDoc";
import { TaskList } from "./TaskList";
import { DeltaBadges, DeltaCapSection } from "./DeltaBadges";
import { AnalyzePanel } from "./AnalyzePanel";
import { TicketTabBody, useStationTickets } from "./TicketView";
import { useDocNav } from "./useDocNav";
import {
  IdentityName,
  STAGE_PILL_TONE,
  StatusRow,
  displayName,
  documentArtifact,
  type DocumentTarget,
} from "./DetailHeader";
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
  changeDocTocKey,
  type DetailRelation,
} from "./DetailShell";
import { REVIEW_ICON, REVIEW_LABEL_KEY, REVIEW_PILL_TONE, type ReviewBadgeStatus } from "./reviewStyle";
import { VERIFY_ICON, VERIFY_LABEL_KEY, VERIFY_PILL_TONE, type VerifyBadgeStatus } from "./verifyStyle";
import { setTaskMark } from "../tasks";

export interface ChangeDetailPageProps {
  change: ChangeItem | null;
  /** 刷新世代——递增即重载已加载的文档内容（未传＝0，行为等同仅打开时加载）。 */
  refreshGen?: number;
  loadDocument: (change: string, artifact: string) => Promise<string | null>;
  loadCapabilities: (change: string) => Promise<string[]>;
  loadMeta: (change: string) => Promise<ChangeMetaInfo | null>;
  /** 一站的活工单（spec desktop-app「详情页的工单分页」）：分页出现时加载、随
   * refreshGen 重载；回 null 或 reject 皆为分页空态。未提供时分页仍依清单状态出现、
   * 内容为空态。 */
  loadStationTicket?: (change: string, station: TicketStation) => Promise<StationTicket | null>;
  onRunVerb?: (verb: Verb, change: string) => void;
  /** 页内呈现的分析结构化结果（validate＋analyze 合并；仅当 change 相符时呈现；archive 不走此结果面）。 */
  detailVerb?: VerbDrawerResult | null;
  /** 收合分析结果（分析钮再点、面板关闭钮共用此路径）。 */
  onClearVerb?: () => void;
  onDelete?: (change: string) => void;
  /** 认领请求（RemoteOnly——本地后端不提供，未提供时不渲染认领面）。 */
  onClaim?: (change: string) => void;
  /** 退回提案中请求（仅派生进行中呈现；app 端接确认流程；未提供时不渲染）。 */
  onRevert?: (change: string) => void;
  /** 勾选/取消任务并回写 tasks.md；task 为 tsk_ stable ID（带 ID 任务）或
   * ordinal 字符串（无 ID 兼容路径）。重载由宿主 refresh 后的刷新世代递增驱动（单一数据流）。 */
  onToggleTask?: (change: string, task: string, done: boolean) => Promise<void>;
  /** 移动任务顺序并回写 tasks.md（before 为可选侧别）；重载由宿主 refresh 后的刷新世代递增驱动。 */
  onMoveTask?: (change: string, from: number, to: number, before?: boolean) => Promise<void>;
  /** 批量设置全部任务完成状态（工具列「全部已完成」／「重置任务」），单次写回。 */
  onSetAllTasks?: (change: string, done: boolean) => Promise<void>;
  /** 来源讨论清单（change.fromDiscussions 解析出的 slug＋topic，出身讨论在前）；空/缺席＝非讨论而来。 */
  sourceDiscussions?: { slug: string; topic: string }[];
  /** 同源 change 名（与此 change 共享至少一份来源讨论，不含自己）。 */
  siblingChanges?: string[];
  /** 点来源讨论开讨论详情页。 */
  onOpenDiscussion?: (slug: string) => void;
  /** 点同源 change 互跳。 */
  onOpenSibling?: (name: string) => void;
  /** 作用中变更清单（调度分页：同波伙伴与前置候选自此派生）；缺席＝空清单。 */
  changes?: ChangeItem[];
  /** 调度分页的前置添加／移除（add-change-plan-desktop design D6）。未提供
   * （capability `setDepends` 为假）时分页唯读：不渲染移除钮与添加下拉。 */
  onSetDepends?: (change: string, on: string[], remove: boolean) => void;
  /** 调度分页添加前置的候选名册（add-change-plan-remote D9）：提供时以其结果为准
   * （加载完成前不长添加下拉），未提供或加载失败时候选自 `changes` 派生。 */
  loadDependsCandidates?: (change: string) => Promise<string[]>;
  /** capability 缺口的停用说明（remote session）：字段存在＝该 affordance
   * disabled 并以其文本说明。缺席＝全功能（本地不受影响）。 */
  unavailable?: {
    /** 分析（validate＋analyze 合并钮）。 */
    analyze?: string;
    /** 封存变更。 */
    archive?: string;
    /** 删除变更。 */
    delete?: string;
    /** 任务勾选、批量与拖排。 */
    tasks?: string;
    /** 认领变更。 */
    claim?: string;
  };
  /** 内容卡标头右端的文档动作（design D4「打开 ▾」）：页依作用中分页回报对应的文档与
   * 已加载原文；没有对应文件的分页（调度）为 null。 */
  renderDocumentActions?: (target: DocumentTarget | null) => ReactNode;
  /** 开该能力的规格详情页（规格文档能力头的「看正式规格」）；未提供时不渲染该钮。 */
  onOpenSpec?: (capability: string) => void;
  /** 提案影响段路径签的本机路径动作（文案依平台）；未提供（无本机目录）时只有拷贝钮。 */
  pathReveal?: PathReveal;
}

type Doc = string | null | undefined;

/** disabled 元素不可靠地接收 hover；用可交互 wrapper 承接 tooltip trigger。 */
function UnavailableAction({ reason, children }: { reason?: string; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** 一站的章签数据：状态非 none 才有。 */
interface Stamp {
  station: "review" | "verify";
  tone: StatusPillTone;
  icon: ReactElement;
  label: string;
  /** 盖章日期与盖章者——进行中（inReview／inVerify）不带。 */
  at?: string | null;
  by?: string | null;
}

/** 「品质关卡」列的站章签：图标＋状态词，已盖章时旁接盖章日期；盖章日期与盖章者完整
    识别（含 email）收进提示，整枚章签（含日期）为触发点，可用键盘聚焦叫出。两站同构，
    只换站别——数据缺席（进行中、无戳记）时整个提示缺席，章签也不进 Tab 序。 */
function QualityStamp({ stamp }: { stamp: Stamp }) {
  // 既有 data 标记维持站别各一份（回归对照沿用 data-review-row／data-verify-row）。
  const rowMark = stamp.station === "review" ? { "data-review-row": "" } : { "data-verify-row": "" };
  const toneMark = stamp.station === "review" ? { "data-review-tone": "" } : { "data-verify-tone": "" };
  const detail = [stamp.at, stamp.by].filter(Boolean).join(" · ");
  const chip = (
    <span {...rowMark} tabIndex={detail ? 0 : undefined} className="inline-flex shrink-0 items-center gap-1.5">
      <StatusPill {...toneMark} tone={stamp.tone} icon={stamp.icon}>
        {stamp.label}
      </StatusPill>
      {stamp.at && <span className="font-mono text-[11px] text-muted-foreground">{stamp.at}</span>}
    </span>
  );
  if (!detail) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

/** 「⋯」菜单项：图标＋标签，停用时项目下方以灰字列出原因（菜单项不接 hover 提示）。 */
function MenuAction({ icon, label, reason }: { icon: ReactElement; label: string; reason?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-2.5">
        {icon}
        <span data-menu-label>{label}</span>
      </span>
      {reason && (
        <span data-menu-reason className="pl-[26px] text-xs whitespace-normal text-muted-foreground">
          {reason}
        </span>
      )}
    </span>
  );
}

/** 分页 → 该分页对应的变更目录内文件（调度没有文件；规格另依 capability 组路径）。 */
const TAB_FILES: Record<string, string> = {
  proposal: "proposal.md",
  design: "design.md",
  tasks: "tasks.md",
};

/** 「打开 ▾」的对象（design D4）：目前文档对应的 artifact 与其已加载原文。规格文档取
 * 选定的 capability（未选定或已不在清单时取第一份）；调度没有文件；工单只载解析后的回合、不带原文。 */
function documentTarget(
  name: string,
  tab: string,
  loaded: Record<string, Doc>,
  specDocs: Record<string, string | null> | undefined,
  specCap: string | null,
): DocumentTarget | null {
  if (tab === "specs") {
    const caps = Object.keys(specDocs ?? {});
    const cap = specCap && caps.includes(specCap) ? specCap : caps[0];
    return cap ? { doc: { change: name, artifact: `specs/${cap}/spec.md` }, content: specDocs?.[cap] ?? null } : null;
  }
  if (tab === "review" || tab === "verify") return { doc: { change: name, artifact: `${tab}.md` } };
  const artifact = TAB_FILES[tab];
  return artifact ? { doc: { change: name, artifact }, content: loaded[tab] ?? null } : null;
}

/**
 * 变更详情页（design D5；spec「详情页的文档树、阅读卡与本页目录」）：三栏骨架——左栏身分区
 * （名称、签、出身、来自／同源／规格列）、「文档」节点（提案／设计／交互任务／彩色规格／调度／
 * 条件式工单）、「状态」列；中栏分析结果卡（有结果时）与阅读卡；右栏本页目录。变更层动作经
 * `DetailActions` 进宿主标题列。宿主只在有选定变更时挂载本页。
 */
export function ChangeDetailPage({
  change,
  refreshGen,
  loadDocument,
  loadCapabilities,
  loadMeta,
  loadStationTicket,
  onRunVerb,
  detailVerb,
  onClearVerb,
  onDelete,
  onClaim,
  onRevert,
  onToggleTask,
  onMoveTask,
  onSetAllTasks,
  sourceDiscussions,
  siblingChanges,
  onOpenDiscussion,
  onOpenSibling,
  changes,
  onSetDepends,
  loadDependsCandidates,
  unavailable,
  renderDocumentActions,
  onOpenSpec,
  pathReveal,
}: ChangeDetailPageProps) {
  const { t, tn } = useI18n();
  const [meta, setMeta] = useState<ChangeMetaInfo | null>(null);
  // 前置候选名册：数组＝查找结果、null＝自清单派生（无查找或查找失败）、undefined＝查找中。
  const [roster, setRoster] = useState<string[] | null | undefined>(null);
  const [proposal, setProposal] = useState<Doc>();
  const [design, setDesign] = useState<Doc>();
  const [tasksMd, setTasksMd] = useState<Doc>();
  // undefined＝capability 清单与其规格文档尚未载完（与「无 delta 规格」的空对象分流）。
  const [specDocs, setSpecDocs] = useState<Record<string, string | null> | undefined>();
  // 受控分页：工单分页退场时要能把当前分页切回「提案」（design D3）。
  const [tab, setTab] = useState("proposal");
  // 能力签→规格段、D 签→决策卡、「前往」→任务列的跳转请求（与已封存页同一套）。
  const nav = useDocNav(setTab);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 批量操作／拖放写回进行中——锁工具列与清单（design D4 例外）。单发勾选不设此旗标。
  const [taskBusy, setTaskBusy] = useState(false);
  // 在途单发写回计数——仅作为世代重载的让路条件，不锁清单（勾选乐观更新）。
  const [pendingWrites, setPendingWrites] = useState(0);
  // 最近一次勾选写回失败的单行错误（null＝无）。
  const [taskError, setTaskError] = useState<string | null>(null);
  // 拖曳手势进行中（按住～放开，TaskList 回报）——与 taskBusy 同为让路条件。
  const [dragActive, setDragActive] = useState(false);

  const name = change?.name ?? null;
  const gen = refreshGen ?? 0;
  // latest-wins：每次加载取递增序号，回应到达时序号已过期即丢弃（涵盖世代与换 change 的交错）。
  const requestSeq = useRef(0);
  // 已发起加载的世代——判断外部世代是否落后需补载。
  const loadedGen = useRef(-1);

  const loadAll = (g: number, target: string, clear: boolean) => {
    const seq = ++requestSeq.current;
    loadedGen.current = g;
    if (clear) {
      setMeta(null);
      setProposal(undefined);
      setDesign(undefined);
      setTasksMd(undefined);
      setSpecDocs(undefined);
      setRoster(loadDependsCandidates ? undefined : null);
    }
    const fresh = <T,>(apply: (v: T) => void) => (v: T) => {
      if (requestSeq.current === seq) apply(v);
    };
    // 失败收敛：还没有东西可显示才落终态空文案（undefined 停着＝永久骨架）；
    // 已有内容维持前值——重载的短暂失败不得抹成假空态。
    const settled = <T,>(apply: Dispatch<SetStateAction<T | null | undefined>>) => () => {
      if (requestSeq.current === seq) apply((prev) => (prev === undefined ? null : prev));
    };
    void loadMeta(target).then(fresh(setMeta)).catch(() => undefined);
    if (loadDependsCandidates) {
      // 失败：首载退回自清单派生（null），重载维持前一次的名册。
      void loadDependsCandidates(target).then(fresh(setRoster)).catch(settled(setRoster));
    }
    void loadDocument(target, "proposal.md").then(fresh(setProposal)).catch(settled(setProposal));
    void loadDocument(target, "design.md").then(fresh(setDesign)).catch(settled(setDesign));
    void loadDocument(target, "tasks.md").then(fresh(setTasksMd)).catch(settled(setTasksMd));
    void loadCapabilities(target)
      .then(async (caps) => {
        const entries = await Promise.all(
          caps.map(
            async (cap) => [cap, await loadDocument(target, `specs/${cap}/spec.md`)] as const,
          ),
        );
        if (requestSeq.current === seq) setSpecDocs(Object.fromEntries(entries));
      })
      // 首载失败收敛为空集（undefined 停着＝永久骨架）；重载失败维持前值，不抹成假空态。
      .catch(() => {
        if (requestSeq.current === seq) {
          setSpecDocs((prev) => (prev === undefined ? {} : prev));
        }
      });
  };

  // 打开／换 change：清空后全量加载（加载中状态属新内容的正确呈现）。
  useEffect(() => {
    if (!name) return;
    loadAll(gen, name, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // 外部世代重载：不清空、回应到达后单次替换（不重置分页与卷动）。
  // 交互进行中（拖曳手势 dragActive、批量写回 taskBusy、在途单发写回 pendingWrites）
  // 让路——皆为依赖，交互结束时本 effect 重跑补载一次。
  useEffect(() => {
    if (!name || taskBusy || dragActive || pendingWrites > 0) return;
    if (gen <= loadedGen.current) return;
    loadAll(gen, name, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, gen, taskBusy, dragActive, pendingWrites]);

  const inReview = change?.reviewStatus === "inReview";
  const inVerify = change?.verifyStatus === "inVerify";
  // 两站工单（design D3）：分页出现时加载、随世代重载、分页消失时清回未加载。
  const tickets = useStationTickets(name, { review: inReview, verify: inVerify }, gen, loadStationTicket);
  // 打开／换 change 从「提案」起。
  useEffect(() => {
    setTab("proposal");
    nav.reset();
  }, [name]);
  // 停在工单分页而该站翻为非进行中（工单已盖章或放弃删除）：分页消失，退回「提案」。
  useEffect(() => {
    if ((tab === "review" && !inReview) || (tab === "verify" && !inVerify)) setTab("proposal");
  }, [tab, inReview, inVerify]);

  if (!change) return null;

  // 分析结果是否对本 change 打开——分析钮切换态与面板呈现共用同一判定（design D2）。
  const verbOpen = !!(detailVerb && detailVerb.change === change.name);
  const pct = change.totalTasks > 0 ? Math.round((change.completedTasks / change.totalTasks) * 100) : 0;
  const taskBadge = `${change.completedTasks}/${change.totalTasks}`;
  const delta = sumDeltaCounts(Object.values(specDocs ?? {}).map(specDeltaCounts));
  const rel = relativeDays(meta?.created, { t, tn });

  // 勾选走乐观更新（design D3）：本地先翻转 tasksMd 立即反映，再发写回；失败
  // 还原快照并显示单行错误。不锁清单——仅以 pendingWrites 让世代重载让路，
  // 写回成功后的重载仍统一由宿主 refresh 的世代递增驱动（单一数据流）。
  const handleToggle = async (ordinal: number, done: boolean, stableId?: string) => {
    if (!name || !onToggleTask) return;
    setTaskError(null);
    // 作废在途加载（design D4）：更早发起、较晚到达的旧回应不得覆盖乐观状态；
    // 写回后的磁盘现况仍由宿主 refresh 的世代递增补载收敛。
    requestSeq.current += 1;
    let snapshot: Doc;
    setTasksMd((cur) => {
      snapshot = cur;
      const next = cur ? setTaskMark(cur, ordinal, done) : null;
      return next ?? cur;
    });
    setPendingWrites((n) => n + 1);
    try {
      // 带 ID 任务以 stable ID 寻址；无 ID 旧档走 ordinal 兼容路径。
      await onToggleTask(name, stableId ?? String(ordinal), done);
    } catch (e) {
      setTasksMd(snapshot ?? null);
      setTaskError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingWrites((n) => n - 1);
    }
  };

  const handleReorder = async (from: number, to: number, before?: boolean) => {
    if (!name || !onMoveTask) return;
    setTaskBusy(true);
    try {
      await onMoveTask(name, from, to, before);
    } finally {
      setTaskBusy(false);
    }
  };

  // 批量操作（design D4 例外）：运行期间工具列与清单短暂 disabled，完成后由世代重载收敛。
  const handleSetAll = async (done: boolean) => {
    if (!name || !onSetAllTasks) return;
    setTaskBusy(true);
    try {
      await onSetAllTasks(name, done);
    } finally {
      setTaskBusy(false);
    }
  };

  // 两站章签：图标＋状态词依四态上色（stamp／progress／warning／destructive），
  // 只在「状态」区的「品质关卡」列渲染——身分区只放阶段签。
  const reviewStatus: ReviewBadgeStatus | null =
    !change.reviewStatus || change.reviewStatus === "none" ? null : change.reviewStatus;
  const verifyStatus: VerifyBadgeStatus | null =
    !change.verifyStatus || change.verifyStatus === "none" ? null : change.verifyStatus;
  const stamps: Stamp[] = [];
  if (reviewStatus) {
    stamps.push({
      station: "review",
      tone: REVIEW_PILL_TONE[reviewStatus],
      icon: REVIEW_ICON[reviewStatus],
      label: t(REVIEW_LABEL_KEY[reviewStatus]),
      at: reviewStatus === "inReview" ? undefined : change.reviewedAt,
      by: reviewStatus === "inReview" ? undefined : change.reviewedBy,
    });
  }
  if (verifyStatus) {
    stamps.push({
      station: "verify",
      tone: VERIFY_PILL_TONE[verifyStatus],
      icon: VERIFY_ICON[verifyStatus],
      label: t(VERIFY_LABEL_KEY[verifyStatus]),
      at: verifyStatus === "inVerify" ? undefined : change.verifiedAt,
      by: verifyStatus === "inVerify" ? undefined : change.verifiedBy,
    });
  }

  // 阶段守门原因（archive-readiness-gating D4）：封存非已就绪、删除非提案中时停用；
  // unavailable（remote 能力缺失）原因优先于阶段原因——「这条信道做不到」比「现在还
  // 不能」更硬。守门为呈现层过滤，引擎拒绝是最终裁决。
  const stage = changeStage(change);
  const archiveReason =
    unavailable?.archive ??
    (stage !== "ready"
      ? t("rdrawer.archiveNotReady")
          .replace("{done}", String(change.completedTasks))
          .replace("{total}", String(change.totalTasks))
      : undefined);
  const deleteReason =
    unavailable?.delete ?? (stage !== "proposed" ? t("rdrawer.deleteStarted") : undefined);

  const wave = planWave(change);
  const blockedBy = planBlockedBy(change);

  const docTarget = documentTarget(change.name, tab, { proposal, design, tasks: tasksMd }, specDocs, nav.specCap);
  const docPath = documentArtifact(docTarget);
  // 调度没有文件，内容即变更的调度字段。
  const tocKey = changeDocTocKey(tab, { content: tab === "plan" ? change : docTarget?.content, specs: specDocs, tickets });
  const specCaps = Object.keys(specDocs ?? {});
  // 提案列为新能力的能力在封存前没有正式规格：其规格段不给「看正式规格」。
  const newCaps = proposal ? newCapabilities(proposal) : [];
  // 阅读卡标题区的签槽、数字砖与提示框（design D9）：提案的提示框接在能力段尾，其余在砖与内文之间。
  const summary = changeDocSummary(
    tab,
    {
      proposal,
      design,
      tasksMd,
      specDocs,
      change,
      tickets,
      onLocateTask: nav.locateTask,
    },
    { t, tn },
  );
  const calloutSlot = summary.callout && <div data-doc-callout>{summary.callout}</div>;
  // 工单节点的徽章：末轮序号（加载完成且有轮次时）。
  const lastRound = (station: TicketStation) => {
    const rounds = tickets[station]?.rounds ?? [];
    return rounds.length > 0 ? Math.max(...rounds.map((r) => r.index)) : null;
  };

  const actions = (
    <>
      <UnavailableAction reason={unavailable?.analyze}>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={verbOpen}
          disabled={unavailable?.analyze !== undefined}
          title={unavailable?.analyze}
          className={verbOpen ? "bg-accent" : undefined}
          onClick={() => (verbOpen ? onClearVerb?.() : onRunVerb?.("analyze", change.name))}
        >
          <Sparkles className="h-3.5 w-3.5" /> {t("common.analyze")}
        </Button>
      </UnavailableAction>
      {/* 认领（remote-claim-ownership D4）：仅未认领的 change 提供入口——已有持有人时
          出身列已写明是谁。onClaim 缺席＝本地分页，整段不渲染。 */}
      {onClaim && !change.claimedBy && (
        <UnavailableAction reason={unavailable?.claim}>
          <Button
            size="sm"
            disabled={unavailable?.claim !== undefined}
            title={unavailable?.claim}
            onClick={() => onClaim(change.name)}
          >
            <Hand className="h-3.5 w-3.5" /> {t("rdrawer.claim")}
          </Button>
        </UnavailableAction>
      )}
      {/* 依阶段的主要钮（实心主色）：退回提案中（仅派生进行中）点击交宿主先确认，UI 不预判守门。 */}
      {stage === "in-progress" && onRevert && (
        <Button size="sm" onClick={() => onRevert(change.name)}>
          <Undo2 className="h-3.5 w-3.5" /> {t("common.revert")}
        </Button>
      )}
      {/* 已就绪才有「封存」主要钮，与「⋯」菜单项同一守门。 */}
      {stage === "ready" && (
        <UnavailableAction reason={unavailable?.archive}>
          <Button
            size="sm"
            disabled={unavailable?.archive !== undefined}
            title={unavailable?.archive}
            onClick={() => onRunVerb?.("archive", change.name)}
          >
            <Archive className="h-3.5 w-3.5" /> {t("common.archive")}
          </Button>
        </UnavailableAction>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label={t("detail.more")}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            className="h-auto py-1.5"
            disabled={archiveReason !== undefined}
            onSelect={() => onRunVerb?.("archive", change.name)}
          >
            <MenuAction icon={<Archive />} label={t("detail.archiveMenu")} reason={archiveReason} />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            className="h-auto py-1.5"
            disabled={deleteReason !== undefined}
            onSelect={() => onDelete?.(change.name)}
          >
            <MenuAction icon={<Trash2 />} label={t("detail.deleteMenu")} reason={deleteReason} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const startedLabel = meta?.startedAt ? t("rdrawer.started").replace("{date}", meta.startedAt) : null;
  const sources = sourceDiscussions ?? [];
  const siblings = siblingChanges ?? [];
  const relations: DetailRelation[] = [];
  if (sources.length > 0) {
    relations.push({
      mark: "from",
      label: t("detail.relFrom"),
      children: <SourceChipRow items={sources} onOpen={(slug) => onOpenDiscussion?.(slug)} />,
    });
  }
  if (siblings.length > 0) {
    relations.push({
      mark: "sibling",
      label: t("detail.relSibling"),
      children: (
        <SourceChipRow items={siblings.map((sibling) => ({ slug: sibling }))} onOpen={(sibling) => onOpenSibling?.(sibling)} />
      ),
    });
  }
  if (specCaps.length > 0) {
    relations.push({
      mark: "specs",
      label: t("detail.relSpecs"),
      children: specCaps.map((cap) => (
        <button key={cap} type="button" className="min-w-0 max-w-full" onClick={() => nav.openSpec(cap)}>
          <Badge variant="outline" className="block max-w-full truncate font-mono hover:bg-accent">
            {cap}
          </Badge>
        </button>
      )),
    });
  }
  const ticketBadge = (station: TicketStation) => {
    const n = lastRound(station);
    return n === null ? null : (
      <Badge variant="secondary" className="ml-auto">
        {t("ticket.round").replace("{n}", String(n))}
      </Badge>
    );
  };

  const tree = (
    <>
      <DetailIdentity
        title={change.name}
        copyLabel={t("common.copyName")}
        badges={
          <StatusPill data-stage-pill tone={STAGE_PILL_TONE[stage]}>
            {t(`stage.${stage}`)}
          </StatusPill>
        }
        provenance={[
          meta?.createdBy && <IdentityName identity={meta.createdBy} />,
          meta?.createdWith && <span className="shrink-0">✳ {meta.createdWith}</span>,
          rel && <span className="shrink-0">{rel}</span>,
          startedLabel &&
            (meta?.startedBy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0">{startedLabel}</span>
                </TooltipTrigger>
                <TooltipContent>{meta.startedBy}</TooltipContent>
              </Tooltip>
            ) : (
              <span className="shrink-0">{startedLabel}</span>
            )),
          change.claimedBy && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Hand className="h-3 w-3" />
                  {t("rdrawer.claimed").replace("{name}", displayName(change.claimedBy))}
                </span>
              </TooltipTrigger>
              <TooltipContent>{change.claimedBy}</TooltipContent>
            </Tooltip>
          ),
          change.worktree && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 items-center gap-1" title={change.worktree.path}>
                  <GitBranch className="h-3 w-3" />
                  {change.worktree.branch}
                </span>
              </TooltipTrigger>
              <TooltipContent>{change.worktree.path}</TooltipContent>
            </Tooltip>
          ),
        ]}
        relations={relations}
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
          <Badge variant={pct === 100 ? "default" : "secondary"} className="ml-auto">
            {taskBadge}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="specs">
          <Code2 className="h-3.5 w-3.5" /> {t("common.tabSpecs")}
          <span className="ml-auto">
            <DeltaBadges counts={delta} />
          </span>
        </TabsTrigger>
        <TabsTrigger value="plan">
          <ListOrdered className="h-3.5 w-3.5" /> {t("drawer.tab.plan")}
          {wave !== null && (
            <Badge variant="secondary" className="ml-auto">
              {planWaveLabel(wave, t)}
            </Badge>
          )}
        </TabsTrigger>
        {/* 条件式工单节点（spec desktop-app「详情页的工单分页」）：调度之后、审查在前，
            与「品质关卡」列章签同序；节点名即站名，徽章为末轮序号。 */}
        {inReview && (
          <TabsTrigger value="review">
            {REVIEW_ICON.inReview} {t("drawer.tab.review")}
            {ticketBadge("review")}
          </TabsTrigger>
        )}
        {inVerify && (
          <TabsTrigger value="verify">
            {VERIFY_ICON.inVerify} {t("drawer.tab.verify")}
            {ticketBadge("verify")}
          </TabsTrigger>
        )}
      </TabsList>

      <DetailTreeLabel>{t("detail.status")}</DetailTreeLabel>
      <DetailStatus>
        <StatusRow mark="tasks" label={t("detail.statusTasks")}>
          <div data-progress-track className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{taskBadge}</span>
        </StatusRow>
        <StatusRow mark="quality" label={t("detail.statusQuality")} wrap>
          {stamps.length === 0 ? (
            <span className="text-muted-foreground">{t("detail.noQuality")}</span>
          ) : (
            stamps.map((s) => <QualityStamp key={s.station} stamp={s} />)
          )}
        </StatusRow>
        <StatusRow mark="plan" label={t("detail.statusPlan")}>
          {wave === null ? (
            <span className="truncate text-muted-foreground">
              {t(change.dependsOn ? "plan.cycle" : "plan.unavailable")}
            </span>
          ) : (
            <>
              <span className="font-medium">{planWaveLabel(wave, t)}</span>
              <span className="text-muted-foreground">·</span>
              <span
                className="truncate text-muted-foreground"
                title={blockedBy.length > 0 ? planBlockedLabel(blockedBy, t) : undefined}
              >
                {blockedBy.length === 0
                  ? t("plan.canStart")
                  : t("plan.blockedCount").replace("{n}", String(blockedBy.length))}
              </span>
            </>
          )}
        </StatusRow>
      </DetailStatus>
    </>
  );

  return (
    <TooltipProvider>
      {/* 直向节点、Enter／Space 才切换（design D2）：方向键扫过节点不逐一载文档。 */}
      <Tabs value={tab} onValueChange={setTab} orientation="vertical" activationMode="manual" className="h-full">
        {/* 换文档或换变更（‹ ›）都让阅读区自顶端呈现：页不因换变更重挂。 */}
        <DetailShell
          data-change-detail
          tree={tree}
          activeDoc={`${change.name}\u0000${tab}`}
          tocKey={tocKey}
          bodyRef={bodyRef}
        >
          <DetailActions>{actions}</DetailActions>

          {/* 分析结果（validate＋analyze 合并）于阅读卡之上呈现——仅当前 change 相符时。 */}
          {verbOpen && detailVerb && (
            <Card data-verb-result className="p-4">
              {detailVerb.error ? (
                <div className="text-xs text-destructive">{detailVerb.error}</div>
              ) : (
                <AnalyzePanel report={detailVerb.analyze} validate={detailVerb.validate} onClose={onClearVerb} />
              )}
            </Card>
          )}

          <Card className="flex flex-col gap-5 p-6">
            <DocHeader
              title={t(DOC_TITLE_KEYS[tab])}
              badges={summary.badges}
              actions={renderDocumentActions?.(docTarget)}
              provenance={[
                tab === "plan" ? t("plan.derivedFrom") : docPath && <span className="font-mono">{docPath}</span>,
              ]}
            />
            <DocTiles tiles={summary.tiles} />
            {tab !== "proposal" && calloutSlot}
            <DocBody ref={bodyRef}>
              {/* undefined＝加载在途、null＝文档不存在（空壳 change）——加载中画骨架，
                  空态文案只在加载完成后出。 */}
              <TabsContent value="proposal">
                {proposal === undefined ? (
                  <DocSkeleton />
                ) : (
                  <ProposalDoc
                    content={proposal}
                    empty={t("list.noProposalDoc")}
                    deltaCaps={specCaps}
                    onOpenCapability={nav.openSpec}
                    pathReveal={pathReveal}
                    afterCapabilities={tab === "proposal" ? calloutSlot : null}
                  />
                )}
              </TabsContent>
              <TabsContent value="design">
                {design === undefined ? (
                  <DocSkeleton />
                ) : (
                  <DesignDoc content={design} empty={t("list.noDesignDoc")} jump={nav.designJump} onJumped={nav.clearDesignJump} />
                )}
              </TabsContent>
              <TabsContent value="tasks">
                {taskError && (
                  <div className="mb-2 text-sm text-destructive">
                    {t("tasks.writeFailed").replace("{msg}", taskError)}
                  </div>
                )}
                {unavailable?.tasks && (
                  <div data-testid="tasks-unavailable" className="mb-2 text-sm text-muted-foreground">
                    {unavailable.tasks}
                  </div>
                )}
                {tasksMd === undefined ? (
                  <DocSkeleton />
                ) : (
                  <TaskList
                    markdown={tasksMd}
                    busy={taskBusy}
                    readOnly={unavailable?.tasks !== undefined}
                    onDragActiveChange={setDragActive}
                    onToggle={(ordinal, done, stableId) => void handleToggle(ordinal, done, stableId)}
                    // 拖排写回未提供（remote capability 缺口）即整段停用——把手不渲染。
                    onReorder={
                      onMoveTask ? (from, to, before) => void handleReorder(from, to, before) : undefined
                    }
                    onSetAll={(done) => void handleSetAll(done)}
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
                  <div className="py-6 text-sm text-muted-foreground">{t("list.noDeltaSpecs")}</div>
                ) : (
                  Object.entries(specDocs).map(([cap, doc]) => (
                    <DeltaCapSection
                      key={cap}
                      cap={cap}
                      doc={doc}
                      jump={nav.specJump}
                      onJumped={nav.clearSpecJump}
                      onOpenSpec={newCaps.includes(cap) ? undefined : onOpenSpec}
                    />
                  ))
                )}
              </TabsContent>
              <TabsContent value="plan">
                <PlanDoc change={change} changes={changes ?? []} roster={roster} onSetDepends={onSetDepends} />
              </TabsContent>
              {inReview && (
                <TabsContent value="review">
                  <TicketTabBody station="review" ticket={tickets.review} />
                </TabsContent>
              )}
              {inVerify && (
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

// 数据源 adapter 接口——以领域语汇（change/spec/document/verb）定义，与后端解耦。
//
// 桌面 app 注入以 Tauri invoke 为后端的实作；未来 web 端可注入 HTTP 后端。
// 组件本身不引用任何 Tauri 专属全域，一律经此接口取数据。

import type { DeltaCounts } from "./delta";

/** 一个 active change 的清单项（CLI 同形字段＋桌面叠加的生命周期标记）。 */
export interface ChangeItem {
  name: string;
  status: string;
  totalTasks: number;
  completedTasks: number;
  /** 写码任务的总数／完成数／剩余数（`[M]` 手动任务不计；spec client-protocol
   * 「变更清单的写码进度字段」）——「待手动」章的数据源。remote 变更摘要不带此
   * 三栏，缺席时章缺席。 */
  codeTotal?: number;
  codeComplete?: number;
  codeRemaining?: number;
  summary?: string;
  /** 开工站标记（in-progress add 盖章）；null/缺席＝未开工。 */
  startedAt?: string | null;
  startedBy?: string | null;
  startedWith?: string | null;
  /** 认领人（"Name <email>"）——RemoteOnly 的认领标记；null/缺席＝未认领。 */
  claimedBy?: string | null;
  /** 创建者（"Name <email>"）——卡片首字母圆标头像的数据源；缺席时省略。 */
  createdBy?: string | null;
  /** 创建日期（.openspec.yaml 的 created，YYYY-MM-DD）——创建时间筛选的数据源；缺席时省略。 */
  created?: string | null;
  /** 来源讨论 slug 清单（由讨论转出／并入的 change，第一个为出身讨论）；空/缺席＝非讨论而来。 */
  fromDiscussions?: string[];
  /** 待重新反映的讨论 slug 清单：本 change 曾 seal 这些讨论、其后被重新结论，内容过期待 re-ingest；空/缺席＝无旗标。 */
  restaleFrom?: string[];
  /** proposal Why 首句（呈现层辅助字段）——变更卡描述列的数据源；null/缺席＝描述列缺席。 */
  whyExcerpt?: string | null;
  /** `.openspec.yaml` 存在但解析失败的原因（fail-closed 诊断）——卡片显示最小
   * invalid 标记、变更操作由引擎错误拒绝；缺席＝metadata 有效或不存在。 */
  metaError?: string | null;
  /** 审查状态（spec client-protocol「变更清单的审查状态字段」）：工单存在＝
   * inReview；章存在依双锚冻结度分 reviewed／reviewedStale；缺席＝none。 */
  reviewStatus?: "none" | "inReview" | "reviewed" | "reviewedStale";
  /** 盖章时间与审查者——章存在（reviewed／reviewedStale）时才附。 */
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  /** 验证状态（spec client-protocol「变更清单的验证状态字段」）：工单存在＝
   * inVerify；章存在依双锚冻结度分 verified／verifiedStale；缺席＝none。
   * 与 reviewStatus 各自独立——两站互不屏蔽。 */
  verifyStatus?: "none" | "inVerify" | "verified" | "verifiedStale";
  /** 盖章时间与验证者——章存在（verified／verifiedStale）时才附。 */
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  /** 这个 change 正在其中实作的 linked worktree（仅本机主 checkout、政策打开时
   * 才有）；缺席＝在主文件夹里做。 */
  worktree?: { branch: string; path: string } | null;
  /** 调度字段（spec client-protocol「变更清单的调度字段」）：值取自引擎 plan 的
   * 同一入口。wave 为波次（同波同号＝可并行）；blockedBy 为作用中的声明前置；
   * dependsOn 为 meta 声明的前置原文；overlaps 为共用 delta 能力的其他变更（目录级）；
   * requirementOverlap 为同动一个 requirement 的其他变更；archiveAfter 为本变更该排在
   * 其后封存的变更。remote 摘要、plan 成环或坏 meta 时整组缺席——章与调度分页据缺席
   * 隐藏；旧 server 只缺 requirementOverlap 与 archiveAfter，读取入口补成空数组。 */
  wave?: number;
  blockedBy?: string[];
  dependsOn?: string[];
  overlaps?: ChangeOverlap[];
  requirementOverlap?: ChangeRequirementOverlap[];
  archiveAfter?: string[];
}

/** 与另一个变更的 delta 能力重叠。 */
export interface ChangeOverlap {
  change: string;
  /** 共用的 capability 名，升幂。 */
  capabilities: string[];
}

/** 与另一个变更同动的一个 requirement：同一 capability 下同名，双方各以一种 delta 操作动到。 */
export interface ChangeRequirementOverlap {
  change: string;
  capability: string;
  requirement: string;
  ownOperation: DeltaOperation;
  otherOperation: DeltaOperation;
  /** 双方都带进（ADDED、改名的新名）或都拿走（REMOVED、改名的旧名）这个名称——
   * 封存先后救不了，得改掉其中一边。 */
  conflict: boolean;
}

/** requirement 的 delta 操作（ADDED／MODIFIED／REMOVED／RENAMED），与 delta 计数的四种操作同源；
 * RENAMED 涵盖改名的旧名与新名两端。 */
export type DeltaOperation = Uppercase<keyof DeltaCounts>;

/** 一个 canonical spec 的清单项（CLI 同形字段＋桌面叠加的呈现层辅助字段）。
 * 规格卡收合信息由 Rust 端清单 payload 带出（spec-archive-drawer design D4）；
 * 不可读／缺席文件容错为 0／null，前端对缺席字段同样以 0／null 容错。 */
export interface SpecItem {
  id: string;
  /** spec.md 最后修改日期（文件系统 mtime 衍生，YYYY-MM-DD）；mtime 不可得时缺席。 */
  modifiedAt?: string | null;
  /** 正式规格的 `### Requirement:` 标题数。 */
  requirementCount?: number;
  /** Purpose 区段首个非空行原文；null＝区段缺席或无内容。 */
  purposeExcerpt?: string | null;
  /** Purpose 为封存流程产生的占位文本（前端改显「Purpose 待补」警示）。 */
  purposeTbd?: boolean;
  /** 全文 @trace 标记的 source 去重数（溯源变更数）。 */
  traceCount?: number;
}

/** change 的 metadata（.openspec.yaml，camelCase）。 */
export interface ChangeMetaInfo {
  schema?: string | null;
  created?: string | null;
  createdBy?: string | null;
  createdWith?: string | null;
  fromDiscussions?: string[];
  startedAt?: string | null;
  startedBy?: string | null;
  startedWith?: string | null;
}

/** 一个归档 change 的清单项。任务计数缺席（无 tasks.md）时不显示徽章。
 * 封存卡收合信息由缓存清单 payload 带出（spec-archive-drawer design D4/D5）。 */
export interface ArchivedItem {
  datedName: string;
  date: string;
  name: string;
  tasksTotal?: number;
  tasksDone?: number;
  /** specs/ 下 capability 目录数（触及规格数）。 */
  specCount?: number;
  /** 创建者（.openspec.yaml 的 created_by）；null/缺席＝不显示头像圆点。 */
  createdBy?: string | null;
  /** 来源讨论 slug 清单；空/缺席＝来源讨论标记缺席。 */
  fromDiscussions?: string[];
  /** 封存时的审查结局（spec client-protocol「已封存清单的审查结局字段」）：
   * 含工单＝reviewedNotPassed（章还在也一样）；否则含章＝reviewed；缺席＝none。 */
  reviewStatus?: "none" | "reviewed" | "reviewedNotPassed";
  /** 封存时的验证结局（spec client-protocol「已封存清单的验证结局字段」）：
   * 含工单＝verifiedNotPassed（章还在也一样）；否则含章＝verified；缺席＝none。
   * 与审查结局并存——同一项可以「审查通过」却「曾验证未通过」。 */
  verifyStatus?: "none" | "verified" | "verifiedNotPassed";
  /** 封存 proposal.md 的 Why 区段首个非空行（spec client-protocol「已封存清单的
   * 呈现辅助字段」）；缺席＝卡片描述列不显示、退回单行。 */
  whyExcerpt?: string;
  /** 创建日期 YYYY-MM-DD（封存目录 metadata 的 created）；缺席＝抽屉出身列的
   * 创建日期字段不显示。 */
  created?: string;
  /** 流程成本字段（spec client-protocol「已封存清单的流程成本字段」），只由桌面 core
   * 产出、来源缺席时缺席：proposal／design／tasks／delta spec 行数总和。 */
  docLines?: number;
  /** 封存目录日期减创建日期（天）。 */
  leadDays?: number;
  /** 封存时戳减创建时戳（小时、一位小数）；两端都是时戳时才有。 */
  leadHours?: number;
  /** 历次盖章累加的审查回合数。 */
  reviewRounds?: number;
  /** 历次盖章累加的验证回合数。 */
  verifyRounds?: number;
}

/** 品质站站别——工单分页的数据寻址（`review.md`／`verify.md`）。 */
export type TicketStation = "review" | "verify";

/** 一条分级 finding（工单行 `- [severity] path — 描述`）；字段与 CLI `--json` 同名，
 * 描述为原文（`(accepted)` 结构 token 的辨识是呈现规则，不在数据层）。 */
export interface TicketFinding {
  severity: "CRITICAL" | "WARNING" | "SUGGESTION";
  path: string;
  text: string;
}

/** 审查规则的缺省清单模式：extend＝缺省 12 条加上项目规则；replace＝只用项目规则。 */
export type ReviewBaseline = "extend" | "replace";

/** 三个项目规则清单，依 critical、warning、suggestion 顺序（设置页与工单套用规则列共用）。 */
export const REVIEW_LISTS = ["critical", "warning", "suggestion"] as const;
export type ReviewList = (typeof REVIEW_LISTS)[number];

/** 依严重度分组的审查规则：config.yaml 的 review 区块（未写时为 extend 与三个空清单），也是
 * 工单 discovery 轮记录的套用规则（`**Rules**:`／`**Rule**:` 行，与 CLI `rounds[].rules` 同形）。 */
export interface ReviewRules {
  baseline: ReviewBaseline;
  critical: string[];
  warning: string[];
  suggestion: string[];
}

/** 工单的一轮。phase／patchHash 在结构化轮为成对值、legacy 轮皆为 null。 */
export interface TicketRound {
  index: number;
  phase: "discovery" | "validation" | null;
  patchHash: string | null;
  /** 套用规则记录，没有记录时为 null。引擎一定会带；声明为选填只为兼容没有此栏的
   * 手写字面值，缺席与 null 同义。 */
  rules?: ReviewRules | null;
  scope: string[];
  findings: TicketFinding[];
}

/** 一站的结构化工单（drawer-quality-ticket-tab D1）：与 CLI `specseal review show --json`
 * 的 `rounds` 同构、camelCase；至少一轮，末轮即目前轮。本机（含 worktree 覆盖层）
 * 与远程、活变更与已封存四条路回同一形状。 */
export interface StationTicket {
  rounds: TicketRound[];
  /** 引擎提供的缺省 smell 名称（依审查技能范本顺序），套用规则列的展开清单；选填理由同 `rules`。 */
  reviewBaselineSmells?: string[];
}

/** 一笔讨论的清单项（camelCase；status: open | concluded | promoted）。 */
export interface DiscussionItem {
  slug: string;
  topic: string;
  status: string;
  rounds: number;
  created: string;
  /** 创建者（"Name <email>"）——discuss new 由 git 身分盖章；缺席时省略。 */
  createdBy?: string | null;
  /** 讨论类型（目前唯一值 "improve"）——一般讨论缺席；标示随此栏恒定。 */
  kind?: string | null;
  /** 转出（扇出）的 change 名累积清单；未转出为空数组。 */
  promotedTo: string[];
  /**
   * Conclusion 段是否已写入内文（占位注解不算）。缺席＝未知（旧 server），
   * 分区判准退回「promoted 一律收合」的既有行为，不得补成 false。
   */
  concluded?: boolean;
  /**
   * frontmatter 是否带 `hold: true`（结论保留在途、还欠尚未创建的变更）。
   * 缺席＝未知（旧 server），视同未保留、沿既有分区，不得补成 true。
   */
  hold?: boolean;
}

/**
 * 讨论结论的一把刀——引擎（specseal-core discuss::record_cuts）自记录的结论与 `promoted_to` 解析，local 经
 * 桌面的讨论记录查找、remote 经 GET /discussions/{slug} 的 `cuts`；前端不另做判定。`line` 为该刀列点去掉
 * `- ` 的首行原文，`unpromoted` 为 `changes` 中不在 `promoted_to` 的名称（`changesInBold` 为 false 时恒空）。
 */
export interface DiscussionCut {
  cut: string;
  title: string;
  note: string;
  line: string;
  changes: string[];
  changesInBold: boolean;
  unpromoted: string[];
}

/** 讨论记录全文与其刀；`cuts` 为空数组＝结论没有刀，或旧 server 没有分刀数据。 */
export interface DiscussionDocument {
  content: string;
  cuts: DiscussionCut[];
}

/** 缺省规格文件夹（数据源没带出时用它组路径；desktop-spec-dir-migration D4）。 */
export const DEFAULT_SPEC_DIR = "specseal";

/** 讨论清单两节：看板讨论栏（active）与已封存页讨论节（archived）。 */
export interface DiscussionLists {
  active: DiscussionItem[];
  archived: DiscussionItem[];
  /** 规格文件夹的项目根相对路径——详情页的记录路径由它组成；缺席（远程）时用 specseal。 */
  specDir?: string;
}

/** 手册索引的一页（desktop-manual-page design D2；字段 camelCase，由 desktop core
 * 自 `openspec/manual/*.md` 的 frontmatter 推导）。缺字段宽容降级：缺 title 用文件名、
 * 缺 section 为 null（前端归「其他」）、缺或非整数 order 为 null 且已置分区末。 */
export interface ManualPageItem {
  /** 文件名去扩展名（kebab-case）。 */
  slug: string;
  title: string;
  section: string | null;
  order: number | null;
  keywords: string[];
  /** 本页取材的正典 capability 名（出处行的数据源）。 */
  sources: string[];
  /** 最近一次生成时戳的 frontmatter 原字符串（RFC 3339 带偏移量，旧页为 YYYY-MM-DD）；
   * 缺席或无法解析为 null。 */
  generated: string | null;
  /** 依 manual-pages 契约「过期判定基准」判定的「可能过期」：sources 任一规格内存在任一
   * @trace updated 在 generated 之后（两边带时间时严格晚于；任一边纯日期时同日也算）。 */
  stale: boolean;
}

/** 手册索引（`listManualPages` 的回传）。pages 已依阅读序排好（分区依分区内最小
 * order、分区内依 order、同值以文件名决断）。 */
export interface ManualIndex {
  /** `openspec/manual/` 存在且至少一个 .md。false 时 pages 为空、画面呈空状态。 */
  present: boolean;
  /** present 为 false 的原因：remote 数据源回 "remote"（尚不支持），本地缺目录为 null。 */
  reason: "remote" | null;
  pages: ManualPageItem[];
  /** 手册生成后添加且未入册的正典 capability 名（每一个 @trace updated 都在每一页
   * generated 之后、且不在任何页的 sources；判定基准同 stale）。 */
  uncoveredNew: string[];
  /** frontmatter 无法解析的页 slug（仍列于 pages、以文件名为标题）。 */
  malformed: string[];
}

/** 空索引（无手册／remote 尚不支持）：store 的读取失败回退与 remote 数据源共用同一形状。 */
export function emptyManualIndex(reason: "remote" | null): ManualIndex {
  return { present: false, reason, pages: [], uncoveredNew: [], malformed: [] };
}

/** 可对选定 change 运行的动词。park/unpark 已从 specseal 移除，不在此列。 */
export type Verb = "validate" | "analyze" | "archive";

/** analyze 报告的一条发现项（对应 core AnalyzeReport.findings，snake_case 直出）。 */
export interface AnalyzeFinding {
  id: string;
  dimension: string;
  severity: string;
  location: string;
  summary: string;
  recommendation: string;
}

/** analyze 报告的一个维度状态（Coverage/Consistency/Ambiguity/Gaps 之一）。 */
export interface AnalyzeDimension {
  dimension: string;
  status: string;
  finding_count: number;
}

/** `specseal analyze --json` 的报告形状（桌面 analyze 动词回传同形）。 */
export interface AnalyzeReport {
  change_id: string;
  dimensions: AnalyzeDimension[];
  findings: AnalyzeFinding[];
  artifacts_analyzed: string[];
  artifacts_missing: string[];
}

/**
 * 「分析」于详情抽屉内呈现的结构化结果（validate＋analyze 一键合并；archive 仍走窗口顶列）。
 * change 供抽屉比对——仅当前打开的 change 相符时才呈现。
 */
export interface VerbDrawerResult {
  change: string;
  /** 结构验证结果（specseal validate 同形）。 */
  validate?: { valid: boolean; errors: string[] };
  /** analyze 报告。 */
  analyze?: AnalyzeReport;
  /** 运行失败的单行错误（任一动词）。 */
  error?: string;
}

/** 清单查看模式（作用中／已封存）——桌面 store 的查看状态沿用此类型。 */
export type ListView = "active" | "archived";

/** 看板卡片种类（拖排写回的目标）：变更卡或讨论卡。 */
export type CardKind = "change" | "discussion";

/** workspace 全文查找的一笔命中（design D6）：卡片识别＋命中 artifact＋snippet。 */
export interface SearchHit {
  kind: CardKind;
  id: string;
  /** 命中的 artifact 文件名（如 design.md、specs/foo/spec.md、讨论记录文件名）。 */
  artifact: string;
  /** 命中前后文裁切（含命中原文；截断端补 …）。 */
  snippet: string;
}

/** 一个 artifact 的状态（对应 core status 的 artifacts 项）。 */
export interface ArtifactStatus {
  id: string;
  outputPath: string;
  status: string;
  missingDeps?: string[];
}

/** change 的 artifact DAG 状态（对应 `specseal status --json`）。 */
export interface StatusReport {
  changeName: string;
  schemaName: string;
  isComplete: boolean;
  applyRequires: string[];
  artifacts: ArtifactStatus[];
}

/** 退回提案中被守门挡下:引擎回传的工作痕迹证据(守门对话框的数据源)。 */
export interface RevertBlockedEvidence {
  /** tasks.md 的已勾任务数。 */
  checkedTasks: number;
  /** touched 记录 v1 与 v2 两清单的文件联集(去重)。 */
  touchedFiles: string[];
}

/** revertChangeToProposed 的守门拒绝:证据随错误走,App 据此开守门对话框。 */
export class RevertBlockedError extends Error {
  checkedTasks: number;
  touchedFiles: string[];
  constructor(evidence: RevertBlockedEvidence) {
    super("revert blocked: work traces exist");
    this.name = "RevertBlockedError";
    this.checkedTasks = evidence.checkedTasks;
    this.touchedFiles = evidence.touchedFiles;
  }
}

/**
 * 两个 desktop adapter 共用的错误转译:bridge 以 JSON 字符串回守门证据
 *(kind: "revertBlocked")——解析成功回 RevertBlockedError,否则原样转单行 Error。
 */
export function toRevertError(raw: unknown): Error {
  const text = raw instanceof Error ? raw.message : String(raw);
  try {
    const parsed = JSON.parse(text) as {
      kind?: string;
      checkedTasks?: number;
      touchedFiles?: string[];
    };
    if (parsed.kind === "revertBlocked") {
      return new RevertBlockedError({
        checkedTasks: parsed.checkedTasks ?? 0,
        touchedFiles: parsed.touchedFiles ?? [],
      });
    }
  } catch {
    // 非 JSON——一般错误消息。
  }
  return raw instanceof Error ? raw : new Error(text);
}

/** 变更清单的完整回应（spec client-protocol「变更清单的调度字段」与「remote 变更清单的
 * 调度字段」）：清单项之外还有顶层 planError——依赖成环时为引擎消息（此时各项无调度
 * 四栏），否则 null。 */
export interface ChangeListPayload {
  changes: ChangeItem[];
  planError: string | null;
  /** 引擎 plan 的 next（第一个没被挡的提案中变更）；成环或 plan 不可得时为 null。 */
  next: string | null;
  /** 讨论结论中尚未转出的刀（与 plan 的 unpromotedCuts 同形同序）；成环或 plan 不可得时为空数组
   * （旧 server 的 plan 回应缺这个键时，Tauri 壳已读作空数组）。 */
  unpromotedCuts: UnpromotedCutItem[];
}

/** 讨论结论中尚未全部转出的一刀：`changes` 为刀粗体内的全部变更名，`unpromoted` 为其中
 * 尚未转出的（spec client-protocol「变更清单的调度字段」）。 */
export interface UnpromotedCutItem {
  discussion: string;
  cut: string;
  title: string;
  changes: string[];
  unpromoted: string[];
}

/** 组件通过此接口取得数据与触发动词——不知道背后是 Tauri 还是 HTTP。 */
export interface SpecsealDataSource {
  /** 清单项连顶层 planError 同一次 IO 回来（add-change-plan-desktop design D1）。 */
  listChanges(): Promise<ChangeListPayload>;
  listSpecs(): Promise<SpecItem[]>;
  listArchived(): Promise<ArchivedItem[]>;
  /** 取得一个 change 的 artifact DAG 状态。 */
  status(change: string): Promise<StatusReport>;
  /** 读取一个 change 的 artifact（artifact 为 output path，如 `proposal.md`）。 */
  getDocument(change: string, artifact: string): Promise<string | null>;
  /** 读取一个 capability 的正式规格 spec.md。 */
  getSpecDocument(capability: string): Promise<string | null>;
  /** 手册索引（desktop-manual-page）：读 `openspec/manual/` 的 frontmatter 推导阅读序
   * 与过期标示。无手册时 present 为 false；remote 数据源回 reason "remote" 且不发请求。 */
  listManualPages(): Promise<ManualIndex>;
  /** 读取一页手册去掉 frontmatter 的内文（slug 寻址）；不存在回 null。 */
  getManualPage(slug: string): Promise<string | null>;
  /**
   * workspace 全文查找（design D6）：以不分大小写子字符串比对 active 变更的
   * artifacts 与 active 讨论记录全文，每卡回传首个命中。空 query 回空数组。
   */
  searchWorkspace(query: string): Promise<SearchHit[]>;
  /** 列出一个 change 的 delta capability 名。 */
  changeCapabilities(change: string): Promise<string[]>;
  /** 取得 change 的 metadata（createdBy/createdWith/created）。无此 change 回 null。 */
  changeMeta(change: string): Promise<ChangeMetaInfo | null>;
  /** 认领一个 change 防止撞工（RemoteOnly——本地后端不提供此方法，UI 因此
   * 不长出认领面）。已被他人持有时 reject 附持有人与建议动作的单行消息。 */
  claim?(change: string): Promise<void>;
  /** 删除一个 active change（破坏性；UI 需先确认）。 */
  deleteChange(change: string): Promise<void>;
  /** 把误开工的变更退回提案中(移除 in-progress 标记;仅零工作痕迹可行;
   * UI 需先确认)。守门挡下时 reject RevertBlockedError(证据随错误);
   * 其余失败 reject 单行消息。 */
  revertChangeToProposed(change: string): Promise<void>;
  /** 勾选/取消任务：task 为 tsk_ stable ID 或 ordinal 字符串（无 ID 兼容路径）。 */
  setTaskDone(change: string, task: string, done: boolean): Promise<void>;
  /** 批量设置全部任务完成状态（true＝全部已完成、false＝重置任务），单次写回。 */
  setAllTasks(change: string, done: boolean): Promise<void>;
  /**
   * 把第 from 个任务移到以第 to 个任务为锚的位置（皆 1-based）。
   * before 省略时依方向推断（向上插锚前、向下插锚后）；true＝明确插锚前
   * （跨群组标题即成为该群组组首）、false＝明确插锚后。
   */
  moveTask(change: string, from: number, to: number, before?: boolean): Promise<void>;
  /** 对选定 change 运行动词，回传 core 的结果 payload；失败时 reject 附消息。 */
  runVerb(verb: Verb, change: string): Promise<unknown>;
  /** 放弃审查（删工单、不盖章）——封存入口三选项的数据面。本机与 remote 的数据
   * 来源都实作；未实作的后端在用户选这一项时显示「不支持」。 */
  discardReview?(change: string): Promise<void>;
  /** 放弃验证（删工单、不盖章）——验证站的同一面。 */
  discardVerify?(change: string): Promise<void>;
  /** 带着未结工单封存（`--carry-review`／`--carry-verify`）：该站封存侧永久显示
   * 「曾审查／曾验证未通过」。两个旗标各自独立，双工单并存时可同时带。 */
  archiveCarry?(change: string, carryReview: boolean, carryVerify: boolean): Promise<unknown>;
  /** 一站的活工单（spec desktop-app「详情抽屉的工单分页」）：无工单、远程 404、
   * 读取或解析失败皆回 null（分页显示空态而非错误）。 */
  getStationTicket(change: string, station: TicketStation): Promise<StationTicket | null>;
  /** 读取一个已封存 change 的 artifact 原文（dated name 寻址）。缺件回 null。 */
  getArchivedDocument(datedName: string, artifact: string): Promise<string | null>;
  /** 已封存 change 带走的工单（spec desktop-app「已封存抽屉的工单分页」）；null 语意同
   * getStationTicket。 */
  getArchivedStationTicket(datedName: string, station: TicketStation): Promise<StationTicket | null>;
  /** 列出一个已封存 change 的 delta capability 名。 */
  archivedCapabilities(datedName: string): Promise<string[]>;
  /** 讨论清单（active＋archived）。非 specseal 项目回两个空清单。 */
  listDiscussions(): Promise<DiscussionLists>;
  /** 读取讨论记录全文与引擎解析的刀（slug 寻址；live 优先、封存后备）。无则 null。 */
  getDiscussionDocument(slug: string): Promise<DiscussionDocument | null>;
  /** 把讨论转为新 change（可选 change 名，省略时由 slug 衍生）。失败 reject 单行消息。 */
  promoteDiscussion(slug: string, name?: string): Promise<{ change: string }>;
  /** 归档一笔 live 讨论（UI 需先确认）；失败 reject 附消息。 */
  archiveDiscussion(slug: string): Promise<void>;
  /**
   * 看板栏内拖排写回（design D5）：把卡片排到 prevId 与 nextId 两邻居之间
   * （null＝栏顶／栏底）。id 为变更名或讨论 slug；失败 reject 附消息。
   */
  reorderCard(kind: CardKind, id: string, prevId: string | null, nextId: string | null): Promise<void>;
  /**
   * 声明（remove 为 true 时撤销）`on` 为 `change` 的前置，写回其 meta 的
   * depends_on（add-change-plan-desktop design D6）。引擎拒绝（自依赖、不存在、
   * 已封存、成环）时 reject 单行消息；不可写的 membership（remote reader）的
   * capability `setDepends` 为假，UI 不会调用。
   */
  setDepends(change: string, on: string[], remove: boolean): Promise<void>;
  /**
   * 调度分页添加前置的候选名册（add-change-plan-remote D9）：该变更所在名册的其他
   * 作用中变更——有 worktree 映射时为其副本，与 setDepends 写入作用的 store 相同。
   * 只有一份名册的后端（remote）不提供，候选自清单派生。
   */
  dependsCandidates?(change: string): Promise<string[]>;
}

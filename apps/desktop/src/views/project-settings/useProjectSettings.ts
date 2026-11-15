// 项目设置的状态与动作（desktop-settings-mode design D8）：自 ProjectSettingsView 原样搬出——
// 两层设置的加载、保存、remote revision 冲突对照与产出流程的切换／fork／创建／删除，逻辑不变；
// 四个分类页共用同一份状态，切页不重载、各页的编辑态与草稿跨页保留。
import { useEffect, useRef, useState } from "react";
import { REVIEW_LISTS, useI18n, type ReviewBaseline, type ReviewList, type ReviewRules } from "@specseal/ui";

import type {
  SchemaEntry,
  SettingsSnapshot,
  SubagentModelConfig,
  WorkflowFields,
} from "../../adapter/workspace";
import type { WorkspaceSettingsProvider } from "../../session";
import { workflowConfigFile } from "../../settingsCatalog";
import { entriesToText, keepUnedited } from "./lines";
import {
  EMPTY_SUBAGENT_MODEL,
  SUBAGENT_STATIONS,
  fromDraft,
  sameSubagentModel,
  toDraft,
  type SubagentDraft,
} from "./subagentModel";

/** locale／spec_locale 的「未设置」在 config 里是空字符串，Radix Select 的 item 不接受空字符串。 */
export const LOCALE_UNSET = "__unset__";

/** 官方合法语系代码（引擎 LOCALE_CODES／SPEC_LOCALE_CODES 的前端镜像）。 */
export const LOCALE_OPTIONS: readonly string[] = ["tw", "ja", "en"];
export const SPEC_LOCALE_OPTIONS: readonly string[] = ["auto", "tw", "ja", "en"];

type PendingRemoteWrite =
  | { kind: "policy"; fields: WorkflowFields }
  | { kind: "context"; context: string }
  | { kind: "rules"; rules: Array<[string, string[]]> }
  | { kind: "review"; review: ReviewRules }
  | { kind: "subagentModel"; config: SubagentModelConfig }
  | { kind: "schema"; name: string };

/** 有自己编辑态的四张内容卡。 */
type CardKind = "context" | "rules" | "review" | "subagentModel";

/** 只取对象自己的键：工具名称 `constructor` 之类与对象内置属性同名时，不会取到原型上的值。 */
const own = <T,>(map: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

interface ConflictRow {
  key: string;
  label: string;
  server: string;
  mine: string;
}

export interface PolicyConflict {
  latest: SettingsSnapshot;
  pending: PendingRemoteWrite;
  rows: ConflictRow[];
}

function remoteErrorReason(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  if (typeof error === "string") {
    try {
      return remoteErrorReason(JSON.parse(error));
    } catch {
      return null;
    }
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** 审查规则编辑草稿：缺省清单模式＋三节各一份「一行一条」文本。 */
export type ReviewDraft = { baseline: ReviewBaseline } & Record<ReviewList, string>;

const reviewToDraft = (review: ReviewRules): ReviewDraft => ({
  baseline: review.baseline,
  critical: entriesToText(review.critical),
  warning: entriesToText(review.warning),
  suggestion: entriesToText(review.suggestion),
});
const draftToReview = (draft: ReviewDraft, current: ReviewRules): ReviewRules => ({
  baseline: draft.baseline,
  critical: keepUnedited(draft.critical, current.critical),
  warning: keepUnedited(draft.warning, current.warning),
  suggestion: keepUnedited(draft.suggestion, current.suggestion),
});
const sameReview = (a: ReviewRules, b: ReviewRules) =>
  a.baseline === b.baseline &&
  REVIEW_LISTS.every((list) => a[list].length === b[list].length && a[list].every((entry, i) => entry === b[list][i]));
const EMPTY_REVIEW: ReviewRules = { baseline: "extend", critical: [], warning: [], suggestion: [] };

export function useProjectSettings(settings: WorkspaceSettingsProvider) {
  const { t } = useI18n();
  const [snap, setSnap] = useState<SettingsSnapshot | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [locale, setLocale] = useState("");
  const [specLocale, setSpecLocale] = useState("");
  const [tdd, setTdd] = useState(false);
  const [audit, setAudit] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [contextText, setContextText] = useState("");
  /** 产出规则现值：schemaArtifacts 固定键 → 条目清单（清单顺序即文件顺序）。 */
  const [rules, setRules] = useState<Record<string, string[]>>({});
  // 拆卡独立编辑态（design D2）：项目说明卡与产出规则卡各持 editing 旗标与草稿，
  // 编辑／取消／保存互不影响；各卡保存仅写对应键。
  const [ctxEditing, setCtxEditing] = useState(false);
  const [draftContext, setDraftContext] = useState("");
  const [ctxMsg, setCtxMsg] = useState<string | null>(null);
  const [rulesEditing, setRulesEditing] = useState(false);
  const [draftRules, setDraftRules] = useState<Record<string, string>>({});
  /** 编辑面冻结键集（review N4）：开编辑当下的 schemaArtifacts 快照——编辑中
   * 固定键换集（切换 schema、fork／创建／删除改变活跃解析）不换编辑面，保存
   * 也以此键集送草稿，新固定键的既有规则走非冻结键兜底原样保留。 */
  const [editingRuleKeys, setEditingRuleKeys] = useState<string[]>([]);
  const [rulesMsg, setRulesMsg] = useState<string | null>(null);
  // 审查规则页：与产出规则卡同一套独立编辑态（唯读现值、编辑旗标、草稿、消息、写入中）。
  const [review, setReview] = useState<ReviewRules>(EMPTY_REVIEW);
  const [reviewEditing, setReviewEditing] = useState(false);
  const [draftReview, setDraftReview] = useState<ReviewDraft>(reviewToDraft(EMPTY_REVIEW));
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  // 子代理模型页：同一套独立编辑态；草稿见 subagentModel.ts。
  const [subagentModel, setSubagentModel] = useState<SubagentModelConfig>(EMPTY_SUBAGENT_MODEL);
  const [subagentEditing, setSubagentEditing] = useState(false);
  const [draftSubagent, setDraftSubagent] = useState<SubagentDraft>(() => toDraft(EMPTY_SUBAGENT_MODEL, {}));
  const [subagentMsg, setSubagentMsg] = useState<string | null>(null);
  // 写入中（desktop-settings-editors design D2）：state 驱动按钮停用与编辑器唯读，ref 挡同一轮
  // 事件内的重送；放在四页共用的状态里，保存中切页再切回也不重送。
  const [ctxSaving, setCtxSaving] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [subagentSaving, setSubagentSaving] = useState(false);
  const writing = useRef({ context: false, rules: false, review: false, subagentModel: false });
  /** 编辑期间被别的写入带到较新的 revision、且 server 值已与开编辑时不同的卡（review R3）。 */
  const [staleCards, setStaleCards] = useState<ReadonlySet<CardKind>>(() => new Set());
  const [appMsg, setAppMsg] = useState<string | null>(null);
  const [wfMsg, setWfMsg] = useState<string | null>(null);
  const [conflict, setConflictState] = useState<PolicyConflict | null>(null);
  /** 冲突状态的同步镜像：409 设下冲突到下一次 render 之间，写入守门也要看得到它。 */
  const conflictOpen = useRef(false);
  const setConflict = (next: PolicyConflict | null) => {
    conflictOpen.current = next !== null;
    setConflictState(next);
  };
  // 产出流程页签（desktop-schema-panel design D4/D5）：清单快照、展开中的项、
  // 创建表单草稿与表单消息。
  const [schemas, setSchemas] = useState<SchemaEntry[]>([]);
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);
  const [schemaMsg, setSchemaMsg] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  /** 待确认删除的项目层 schema 名称（确认框开关；D7 确认后才运行）。 */
  const [pendingDeleteSchema, setPendingDeleteSchema] = useState<string | null>(null);
  /** 产出流程动作（切换／fork／创建／删除＋重读）进行中：所有写入入口停用。动作完成后
   * adoptFresh 依按下当时的编辑与未存状态采纳 server 值，等待期间不得再有新改动。 */
  const [schemaBusy, setSchemaBusy] = useState(false);

  const hydrate = (next: SettingsSnapshot) => {
    setSnap(next);
    setTools(next.app.tools);
    setLocale(next.workflow.locale ?? "");
    setSpecLocale(next.workflow.specLocale ?? "");
    setTdd(next.workflow.tdd);
    setAudit(next.workflow.audit);
    setWorktree(next.workflow.worktree);
    setContextText(next.workflow.context ?? "");
    const nextRules = Object.fromEntries(
      next.workflow.schemaArtifacts.map((id) => [id, next.workflow.rules[id] ?? []]),
    );
    setRules(nextRules);
    setDraftContext(next.workflow.context ?? "");
    setDraftRules(
      Object.fromEntries(
        next.workflow.schemaArtifacts.map((id) => [
          id,
          entriesToText(next.workflow.rules[id] ?? []),
        ]),
      ),
    );
    setReview(next.workflow.review);
    setDraftReview(reviewToDraft(next.workflow.review));
    setSubagentModel(next.workflow.subagentModel);
    setDraftSubagent(toDraft(next.workflow.subagentModel, next.workflow.builtinSubagentModels));
    setCtxEditing(false);
    setRulesEditing(false);
    setReviewEditing(false);
    setSubagentEditing(false);
    setStaleCards(new Set());
  };

  useEffect(() => {
    // stale-guard＋错误浮出（review R7）：session 快速切换时旧回应不得覆写
    // 新清单；读取失败以表单消息浮出而非 unhandled rejection 静默空白。
    let cancelled = false;
    void settings.readSettings().then((next) => {
      if (!cancelled) hydrate(next);
    });
    void settings.readSchemas().then(
      (list) => {
        if (!cancelled) setSchemas(list);
      },
      (e) => {
        if (!cancelled) setSchemaMsg(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [settings]);

  if (!snap) return null;

  const isRemote = settings.kind === "remote";
  const appDisabled = snap.app.parseError !== null;
  const wfDisabled =
    snap.workflow.parseError !== null ||
    (isRemote && !settings.policyWrite) ||
    conflict !== null ||
    schemaBusy;

  // 政策表单相对快照的未存修改（dirty 与 adoptFresh 共用）。
  const policyDirty =
    locale !== (snap.workflow.locale ?? "") ||
    specLocale !== (snap.workflow.specLocale ?? "") ||
    tdd !== snap.workflow.tdd ||
    audit !== snap.workflow.audit ||
    worktree !== snap.workflow.worktree;

  /** 采纳最新快照里「不是这次写入、也不在编辑中」各区的现值（review R8）：remote 的
   * readSettings 会静默换上最新 revision，留着旧现值再起草保存，就会不经 409 盖掉别人的修改。
   * 编辑中的卡保留草稿；它的 server 值若已变，记为 stale，保存时先浮出对照（isStale）。
   * 政策字段只在表单没有未存修改时采纳。 */
  const adoptFresh = (fresh: SettingsSnapshot, written: PendingRemoteWrite["kind"]) => {
    const w = fresh.workflow;
    if (written !== "policy" && !policyDirty) {
      setLocale(w.locale ?? "");
      setSpecLocale(w.specLocale ?? "");
      setTdd(w.tdd);
      setAudit(w.audit);
      setWorktree(w.worktree);
    }
    if (written !== "context" && !ctxEditing) setContextText(w.context ?? "");
    if (written !== "rules" && !rulesEditing) {
      setRules(Object.fromEntries(w.schemaArtifacts.map((id) => [id, w.rules[id] ?? []])));
    }
    if (written !== "review" && !reviewEditing) setReview(w.review);
    if (written !== "subagentModel" && !subagentEditing) setSubagentModel(w.subagentModel);
    const stale: CardKind[] = [];
    if (written !== "context" && ctxEditing && (w.context ?? "") !== contextText) stale.push("context");
    if (
      written !== "rules" &&
      rulesEditing &&
      editingRuleKeys.some((id) => entriesToText(w.rules[id] ?? []) !== entriesToText(rules[id] ?? []))
    ) {
      stale.push("rules");
    }
    if (written !== "review" && reviewEditing && !sameReview(w.review, review)) stale.push("review");
    if (written !== "subagentModel" && subagentEditing && !sameSubagentModel(w.subagentModel, subagentModel)) {
      stale.push("subagentModel");
    }
    if (stale.length > 0) setStaleCards((prev) => new Set([...prev, ...stale]));
  };

  const adoptRevision = (next: number | void) => {
    if (typeof next !== "number") return;
    setSnap((current) =>
      current === null
        ? current
        : { ...current, workflow: { ...current.workflow, revision: next } },
    );
  };

  // 写入成功后把已存值并进快照：快照＝文件现值，未存修改（dirty）以它为基准比对。
  const adoptTools = (saved: string[]) =>
    setSnap((current) => current && { ...current, app: { ...current.app, tools: saved } });
  const adoptPolicy = (fields: WorkflowFields) =>
    setSnap((current) => current && { ...current, workflow: { ...current.workflow, ...fields } });

  const toggleTool = (tool: string, on: boolean) =>
    setTools((prev) => (on ? [...prev.filter((x) => x !== tool), tool] : prev.filter((x) => x !== tool)));

  const saveApp = async () => {
    try {
      await settings.writeAppTools(tools);
      adoptTools(tools);
      setAppMsg(t("settings.saved"));
    } catch (e) {
      // 写入失败：单行错误（指明文件与阶段，来自 desktop-core），表单维持原值。
      setAppMsg(errorMessage(e));
    }
  };

  const buildConflictRows = (
    latest: SettingsSnapshot,
    pending: PendingRemoteWrite,
  ): ConflictRow[] => {
    const policy =
      pending.kind === "policy"
        ? pending.fields
        : {
            locale: locale || null,
            specLocale: specLocale || null,
            tdd,
            audit,
            worktree,
          };
    const mineContext =
      pending.kind === "context" ? pending.context : ctxEditing ? draftContext : contextText;
    const mineSchema = pending.kind === "schema" ? pending.name : snap.workflow.schemaName;
    // 编辑中以冻结键集入表（review S-a）：payload 键集由 editingRuleKeys 决定，
    // 对照表列的行必须跟 payload 同源，冻结键才不会从对照中消失。
    const artifactIds = Array.from(
      new Set([
        ...(rulesEditing ? editingRuleKeys : snap.workflow.schemaArtifacts),
        ...latest.workflow.schemaArtifacts,
      ]),
    );
    const pendingRules = pending.kind === "rules" ? Object.fromEntries(pending.rules) : null;
    const mineReview =
      pending.kind === "review" ? pending.review : reviewEditing ? draftToReview(draftReview, review) : review;
    const mineSubagent =
      pending.kind === "subagentModel"
        ? pending.config
        : subagentEditing
          ? fromDraft(draftSubagent, subagentModel)
          : subagentModel;
    const show = (value: string | null | undefined) => value || "—";
    const rows: ConflictRow[] = [
      {
        key: "schema",
        label: "schema",
        server: show(latest.workflow.schemaName),
        mine: show(mineSchema),
      },
      {
        key: "context",
        label: t("settings.contextLabel"),
        server: show(latest.workflow.context),
        mine: show(mineContext),
      },
      {
        key: "locale",
        label: "locale",
        server: show(latest.workflow.locale),
        mine: show(policy.locale),
      },
      {
        key: "spec-locale",
        label: "spec_locale",
        server: show(latest.workflow.specLocale),
        mine: show(policy.specLocale),
      },
      {
        key: "tdd",
        label: "tdd",
        server: String(latest.workflow.tdd),
        mine: String(policy.tdd),
      },
      {
        key: "audit",
        label: "audit",
        server: String(latest.workflow.audit),
        mine: String(policy.audit),
      },
    ];
    for (const id of artifactIds) {
      // 编辑中：冻结键显示草稿；非冻结键（编辑期间换入的新固定键）显示将被
      // 兜底原样保留的现值，而非误导的空白（review S-a）。
      const mine = rulesEditing
        ? editingRuleKeys.includes(id)
          ? draftRules[id] ?? ""
          : entriesToText(snap.workflow.rules[id] ?? [])
        : entriesToText(pendingRules?.[id] ?? rules[id] ?? []);
      rows.push({
        key: `rules-${id}`,
        label: `rules.${id}`,
        server: show(entriesToText(latest.workflow.rules[id] ?? [])),
        mine: show(mine),
      });
    }
    rows.push({
      key: "review-baseline",
      label: "review.baseline",
      server: latest.workflow.review.baseline,
      mine: mineReview.baseline,
    });
    for (const list of REVIEW_LISTS) {
      rows.push({
        key: `review-${list}`,
        label: `review.${list}`,
        server: show(entriesToText(latest.workflow.review[list])),
        mine: show(entriesToText(mineReview[list])),
      });
    }
    // 子代理模型：各站与各清单取两边出现过的工具名称联集，一个工具一列。
    const serverSubagent = latest.workflow.subagentModel;
    const toolsOf = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    for (const station of SUBAGENT_STATIONS) {
      for (const tool of toolsOf(serverSubagent[station], mineSubagent[station])) {
        const key = `subagent_model.${station}.${tool}`;
        rows.push({
          key,
          label: key,
          server: show(own(serverSubagent[station], tool)),
          mine: show(own(mineSubagent[station], tool)),
        });
      }
    }
    for (const tool of toolsOf(serverSubagent.choices, mineSubagent.choices)) {
      const key = `subagent_model.choices.${tool}`;
      rows.push({
        key,
        label: key,
        server: show(entriesToText(own(serverSubagent.choices, tool) ?? [])),
        mine: show(entriesToText(own(mineSubagent.choices, tool) ?? [])),
      });
    }
    return rows;
  };

  /** 各种写入的消息落点（冲突重读失败、重送失败时共用）。 */
  const MSG_SETTERS: Record<PendingRemoteWrite["kind"], (message: string | null) => void> = {
    policy: setWfMsg,
    context: setCtxMsg,
    rules: setRulesMsg,
    review: setReviewMsg,
    subagentModel: setSubagentMsg,
    schema: setSchemaMsg,
  };

  /** 重读 server 最新版并浮出逐字段对照；重读失败时把原因写到该卡的消息。 */
  const openConflict = async (pending: PendingRemoteWrite) => {
    try {
      const latest = await settings.readSettings();
      setConflict({ latest, pending, rows: buildConflictRows(latest, pending) });
    } catch (readError) {
      MSG_SETTERS[pending.kind](errorMessage(readError));
    }
  };

  const handleWriteError = async (
    error: unknown,
    pending: PendingRemoteWrite,
  ): Promise<boolean> => {
    if (!isRemote || remoteErrorReason(error) !== "revision_conflict") return false;
    await openConflict(pending);
    return true;
  };

  /** stale 的卡（见 adoptFresh）不直接写入：adapter 已带着新 revision，写入不会再 409，会盖掉
   * 别人的修改——保存改为比照 409 浮出对照（openConflict），看过差异再选重载或重送。 */
  const isStale = (kind: CardKind) => isRemote && staleCards.has(kind);

  const saveWorkflow = async () => {
    const fields: WorkflowFields = {
      locale: locale || null,
      specLocale: specLocale || null,
      tdd,
      audit,
      worktree,
    };
    try {
      const next = await settings.writeWorkflowConfig(fields);
      adoptRevision(next);
      adoptPolicy(fields);
      setWfMsg(t("settings.saved"));
    } catch (e) {
      if (await handleWriteError(e, { kind: "policy", fields })) setWfMsg(null);
      else if (!isRemote) {
        // local 失败有两种身分：被拒（例如 worktree 挂着时关不掉，文件没变）
        // 或技能同步失败（config 已写入、新值为正典）。重读文件现值——开关与
        // 快照都以文件为准，才不会在下次保存时静默把政策写回旧值。
        try {
          const fresh = await settings.readSettings();
          setSnap(fresh);
          setWorktree(fresh.workflow.worktree);
        } catch {
          setWorktree(snap?.workflow.worktree ?? false);
        }
        setWfMsg(errorMessage(e));
      } else {
        // remote 不重读：adapter 的 readSettings 会静默采纳最新 revision，
        // 之后再存等于带新 revision 提交过期字段值、绕过 409 冲突对照。
        // 维持旧 revision，让并发修改照常走 revision_conflict 对话框。
        setWorktree(snap?.workflow.worktree ?? false);
        setWfMsg(errorMessage(e));
      }
    }
  };

  const beginCtxEdit = () => {
    setDraftContext(contextText);
    setCtxMsg(null);
    setCtxEditing(true);
  };

  /** 按钮、编辑器内 ⌘S 与页层 ⌘S 共用的写入守门：停用时（解析失败、查看者、冲突对照中）
   * 不送——冲突对照中 adapter 已采用最新 revision，再送会绕过对照卡盖掉 server 版；
   * 同一份写入进行中也不重送。 */
  const guardWrite = async (
    kind: "context" | "rules" | "review" | "subagentModel",
    setSaving: (saving: boolean) => void,
    write: () => Promise<void>,
  ) => {
    if (wfDisabled || conflictOpen.current || writing.current[kind]) return;
    writing.current[kind] = true;
    setSaving(true);
    try {
      await write();
    } finally {
      writing.current[kind] = false;
      setSaving(false);
    }
  };

  const saveContext = () => guardWrite("context", setCtxSaving, async () => {
    // 仅写 context 键（清空＝移除键）；产出规则卡对应的 rules 键不触碰。
    const pending = { kind: "context", context: draftContext } as const;
    if (isStale(pending.kind)) {
      setCtxMsg(null);
      await openConflict(pending);
      return;
    }
    try {
      const next = await settings.writeWorkflowContext(draftContext);
      adoptRevision(next);
      setContextText(draftContext);
      setCtxEditing(false);
      setCtxMsg(t("settings.saved"));
    } catch (e) {
      // 写入失败：单行错误，维持编辑态不遗失输入。
      if (await handleWriteError(e, pending)) setCtxMsg(null);
      else setCtxMsg(errorMessage(e));
    }
  });

  const beginRulesEdit = () => {
    // 冻结编辑面键集（review N4）：编辑期间固定键换集不影响编辑中的分节。
    setEditingRuleKeys(snap.workflow.schemaArtifacts);
    setDraftRules(
      Object.fromEntries(
        snap.workflow.schemaArtifacts.map((id) => [id, entriesToText(rules[id] ?? [])]),
      ),
    );
    setRulesMsg(null);
    setRulesEditing(true);
  };

  const saveRules = () => guardWrite("rules", setRulesSaving, async () => {
    // 整份代换 payload：全部固定键依 schemaArtifacts 顺序送出（空节＝移除键、全空＝移除 rules 键）；
    // 仅写 rules 键，context 逐字符不变（不经写入路径）。
    // 以冻结键集送出草稿（review N4）：编辑中固定键换集时，草稿仍对应开编辑
    // 当下的分节，不对新键送空值。
    const nextRules: Array<[string, string[]]> = editingRuleKeys.map((id) => [
      id,
      keepUnedited(draftRules[id] ?? "", rules[id] ?? []),
    ]);
    // 非冻结键的既有分节原样附上（review R3／N4）：整份代换不得静默删掉其他
    // schema 的分节——含编辑期间换入的新固定键既有规则。
    for (const [key, entries] of Object.entries(snap.workflow.rules)) {
      if (!editingRuleKeys.includes(key)) nextRules.push([key, entries]);
    }
    const pending = { kind: "rules", rules: nextRules } as const;
    if (isStale(pending.kind)) {
      setRulesMsg(null);
      await openConflict(pending);
      return;
    }
    try {
      const next = await settings.writeWorkflowRules(nextRules);
      adoptRevision(next);
      setRules(Object.fromEntries(nextRules));
      setRulesEditing(false);
      setRulesMsg(t("settings.saved"));
    } catch (e) {
      if (await handleWriteError(e, pending)) setRulesMsg(null);
      else setRulesMsg(errorMessage(e));
    }
  });

  const beginReviewEdit = () => {
    setDraftReview(reviewToDraft(review));
    setReviewMsg(null);
    setReviewEditing(true);
  };

  const saveReview = () => guardWrite("review", setReviewSaving, async () => {
    // 整块代换、只写 review 键：逐行修剪、空行不写；移除语意（extend 不写 baseline、空节移除、
    // 全空移除 review）在 core 落实。
    const nextReview = draftToReview(draftReview, review);
    const pending = { kind: "review", review: nextReview } as const;
    if (isStale(pending.kind)) {
      setReviewMsg(null);
      await openConflict(pending);
      return;
    }
    try {
      const next = await settings.writeWorkflowReview(nextReview);
      adoptRevision(next);
      setReview(nextReview);
      setReviewEditing(false);
      setReviewMsg(t("settings.saved"));
    } catch (e) {
      if (await handleWriteError(e, pending)) setReviewMsg(null);
      else setReviewMsg(errorMessage(e));
    }
  });

  const beginSubagentEdit = () => {
    setDraftSubagent(toDraft(subagentModel, snap.workflow.builtinSubagentModels));
    setSubagentMsg(null);
    setSubagentEditing(true);
  };

  const saveSubagentModel = () => guardWrite("subagentModel", setSubagentSaving, async () => {
    // 整块代换、只写 subagent_model 键；内容与现值相同时不写档——整块代换会丢掉区块内的注解。
    const nextModel = fromDraft(draftSubagent, subagentModel);
    if (sameSubagentModel(nextModel, subagentModel)) {
      setSubagentEditing(false);
      setSubagentMsg(null);
      return;
    }
    const pending = { kind: "subagentModel", config: nextModel } as const;
    if (isStale(pending.kind)) {
      setSubagentMsg(null);
      await openConflict(pending);
      return;
    }
    try {
      const next = await settings.writeWorkflowSubagentModel(nextModel);
      adoptRevision(next);
      setSubagentModel(nextModel);
      setSubagentEditing(false);
      setSubagentMsg(t("settings.saved"));
    } catch (e) {
      if (await handleWriteError(e, pending)) setSubagentMsg(null);
      else setSubagentMsg(errorMessage(e));
    }
  });

  /** 产出流程来源层级的显示词（package／project／user → 内置／项目／用户）。 */
  const SCHEMA_SOURCE_LABEL_KEY = {
    package: "settings.schemaSourceBuiltin",
    project: "settings.schemaSourceProject",
    user: "settings.schemaSourceUser",
  } as const;
  const schemaSourceLabel = (source: keyof typeof SCHEMA_SOURCE_LABEL_KEY) =>
    t(SCHEMA_SOURCE_LABEL_KEY[source]);

  /** 引擎 fork 以 project→user→built-in 第一命中解析来源；被同名前层 shadow 的
   * 项不给 fork 入口——按下去拷贝到的会是前层内容（review R8）。引擎的层命中
   * 只看 schema.yaml 文件存在，前层坏档也算 shadow（不看 error）。 */
  const SCHEMA_RESOLUTION_ORDER = { project: 0, user: 1, package: 2 } as const;
  const isResolutionHit = (entry: SchemaEntry) =>
    !schemas.some(
      (s) =>
        s.name === entry.name &&
        SCHEMA_RESOLUTION_ORDER[s.source] < SCHEMA_RESOLUTION_ORDER[entry.source],
    );

  /** 切换／fork／创建／删除成功后的快照局部采纳（review R4／N1／N4）：只更新
   * schema 面与 rules 固定键——不走 hydrate，任一卡的编辑态与草稿不得被重设。
   * 产出规则编辑中时只更新 snap，唯读显示值与草稿不动——编辑面冻结在
   * editingRuleKeys（开编辑当下的键集），保存时换入的新固定键规则由非冻结键
   * 兜底保留。重读失败不改报成错误：写入已成功，快照留旧值待下次加载补上。 */
  const refreshSchemaFacts = async () => {
    try {
      const fresh = await settings.readSettings();
      setSnap(fresh);
      adoptFresh(fresh, "schema");
    } catch {
      /* 写入已成功；重读失败容忍。 */
    }
  };

  const switchSchema = async (name: string) => {
    if (name === snap.workflow.schemaName) return;
    setSchemaBusy(true);
    try {
      const next = await settings.writeWorkflowSchema(name);
      adoptRevision(next);
      setSchemaMsg(t("settings.saved"));
      await refreshSchemaFacts();
    } catch (e) {
      // remote revision 落后走冲突对照（review R5）；其余失败单行浮出、下拉维持原值。
      if (await handleWriteError(e, { kind: "schema", name })) setSchemaMsg(null);
      else setSchemaMsg(errorMessage(e));
    } finally {
      setSchemaBusy(false);
    }
  };

  /** schema 动作共用骨架（review S3）：运行 → 重拉清单＋局部采纳快照（fork／
   * 创建／删除都可能改变同名 shadow 下的活跃解析，固定键一并跟上）→ 已保存；
   * 失败单行浮出。 */
  const runSchemaAction = async (action: () => Promise<unknown>) => {
    setSchemaBusy(true);
    try {
      await action();
      setSchemas(await settings.readSchemas());
      await refreshSchemaFacts();
      setSchemaMsg(t("settings.saved"));
    } catch (e) {
      setSchemaMsg(errorMessage(e));
    } finally {
      setSchemaBusy(false);
    }
  };

  const forkSchemaAction = (source: string) => runSchemaAction(() => settings.forkSchema(source));

  const confirmDeleteSchema = () => {
    const name = pendingDeleteSchema;
    setPendingDeleteSchema(null);
    if (name === null) return Promise.resolve();
    return runSchemaAction(() => settings.deleteSchema(name));
  };

  const createSchemaAction = () => {
    // 名称验证在引擎（D5）：kebab-case 规则与已存在检查不在前端重复，错误原样浮出。
    const name = createName.trim();
    if (name === "") return Promise.resolve();
    return runSchemaAction(async () => {
      await settings.createSchema(name);
      setCreateName("");
    });
  };

  const reloadServerVersion = () => {
    if (conflict === null) return;
    hydrate(conflict.latest);
    setConflict(null);
    setCtxMsg(null);
    setRulesMsg(null);
    setReviewMsg(null);
    setSubagentMsg(null);
    setWfMsg(null);
  };

  /** 以最新 revision 重送一笔被挡下的写入：每种写入的送出与成功后的采纳写在同一处。 */
  const resend = async (pending: PendingRemoteWrite): Promise<[number | void, () => void]> => {
    switch (pending.kind) {
      case "policy":
        return [await settings.writeWorkflowConfig(pending.fields), () => adoptPolicy(pending.fields)];
      case "context":
        return [
          await settings.writeWorkflowContext(pending.context),
          () => {
            setContextText(pending.context);
            setCtxEditing(false);
          },
        ];
      case "rules":
        return [
          await settings.writeWorkflowRules(pending.rules),
          () => {
            setRules(Object.fromEntries(pending.rules));
            setRulesEditing(false);
          },
        ];
      case "review":
        return [
          await settings.writeWorkflowReview(pending.review),
          () => {
            setReview(pending.review);
            setReviewEditing(false);
          },
        ];
      case "subagentModel":
        return [
          await settings.writeWorkflowSubagentModel(pending.config),
          () => {
            setSubagentModel(pending.config);
            setSubagentEditing(false);
          },
        ];
      case "schema":
        return [await settings.writeWorkflowSchema(pending.name), () => {}];
    }
  };

  const retryConflict = async () => {
    if (conflict === null) return;
    const { latest, pending } = conflict;
    try {
      const [next, adoptSaved] = await resend(pending);
      MSG_SETTERS[pending.kind](t("settings.saved"));
      if (pending.kind === "schema") {
        adoptRevision(next);
        setConflict(null);
        await refreshSchemaFacts();
        return;
      }
      // 以最新 revision 重送成功：快照换成 server 最新版，其他区一并采纳（review R8）。
      setSnap(latest);
      adoptFresh(latest, pending.kind);
      adoptSaved();
      setStaleCards((prev) => new Set([...prev].filter((kind) => kind !== pending.kind)));
      adoptRevision(next);
      setConflict(null);
    } catch (error) {
      if (!(await handleWriteError(error, pending))) MSG_SETTERS[pending.kind](errorMessage(error));
    }
  };

  // 未存修改（App 的返回据此先问要不要舍弃）：表单值对照快照，两张文本卡只看编辑中的草稿。
  const dirty =
    tools.length !== snap.app.tools.length ||
    tools.some((tool) => !snap.app.tools.includes(tool)) ||
    policyDirty ||
    (ctxEditing && draftContext !== contextText) ||
    (rulesEditing && editingRuleKeys.some((id) => (draftRules[id] ?? "") !== entriesToText(rules[id] ?? []))) ||
    (reviewEditing && !sameReview(draftToReview(draftReview, review), review)) ||
    (subagentEditing && !sameSubagentModel(fromDraft(draftSubagent, subagentModel), subagentModel));
  // 页标题下的 remote 注记：policy revision 与查看者说明（local 为 null，改显示文件键）。
  const remoteNote = isRemote
    ? { revision: snap.workflow.revision ?? null, reader: !settings.policyWrite }
    : null;

  const populatedRuleKeys = snap.workflow.schemaArtifacts.filter((id) => (rules[id] ?? []).length > 0);
  // 「整份换掉」且三节皆空：Standards 轴只剩 repo 文档可依——页内提示，但不挡保存。
  const reviewDraft = draftToReview(draftReview, review);
  const reviewReplaceEmpty =
    draftReview.baseline === "replace" && REVIEW_LISTS.every((list) => reviewDraft[list].length === 0);
  // 下拉选项：坏项不可选；同名跨层去重（解析语意本就取第一命中）。
  const selectableSchemaNames = Array.from(
    new Set(schemas.filter((s) => s.error === null).map((s) => s.name)),
  );


  // 页标题下文件注记的文件名：依项目实际的规格文件夹（desktop-spec-dir-migration D4）。
  const configFile = workflowConfigFile(snap.specDir);

  return {
    settings, snap, isRemote, appDisabled, wfDisabled, dirty, remoteNote, configFile,
    tools, toggleTool, saveApp, appMsg,
    locale, setLocale, specLocale, setSpecLocale, tdd, setTdd, audit, setAudit, worktree, setWorktree,
    saveWorkflow, wfMsg,
    contextText, ctxEditing, setCtxEditing, draftContext, setDraftContext, ctxMsg, beginCtxEdit, saveContext, ctxSaving,
    rules, rulesEditing, setRulesEditing, draftRules, setDraftRules, editingRuleKeys, rulesMsg,
    beginRulesEdit, saveRules, rulesSaving, populatedRuleKeys,
    review, reviewEditing, setReviewEditing, draftReview, setDraftReview, reviewMsg,
    beginReviewEdit, saveReview, reviewSaving, reviewReplaceEmpty,
    subagentModel, subagentEditing, setSubagentEditing, draftSubagent, setDraftSubagent, subagentMsg,
    beginSubagentEdit, saveSubagentModel, subagentSaving,
    conflict, reloadServerVersion, retryConflict,
    schemas, expandedSchema, setExpandedSchema, schemaMsg, setSchemaMsg, createName, setCreateName,
    pendingDeleteSchema, setPendingDeleteSchema, schemaSourceLabel, isResolutionHit, switchSchema,
    forkSchemaAction, confirmDeleteSchema, createSchemaAction, selectableSchemaNames,
  };
}

export type ProjectSettingsState = NonNullable<ReturnType<typeof useProjectSettings>>;

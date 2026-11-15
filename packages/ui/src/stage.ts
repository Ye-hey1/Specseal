import type { ChangeItem, ChangeRequirementOverlap } from "./adapter";

/** SDD 生命周期阶段（不含 Archived——归档由归档清单另计）。 */
export type Stage = "proposed" | "in-progress" | "ready";

/** 看板字段顺序（左→右流动）。显示标签经 i18n：t(`stage.${stage}`)。 */
export const STAGES: Stage[] = ["proposed", "in-progress", "ready"];

/**
 * 各阶段的徽章／chip 配色——每阶一色相（提案中＝主色、进行中＝蓝、已就绪＝绿），
 * 色值在 theme.css 的 stage-* token。看板栏计数徽章、讨论栏 promoted chip 与
 * 系统匣分区计数共用此单一来源，避免多处配色分歧。
 */
export const STAGE_BADGE: Record<Stage, string> = {
  proposed: "bg-stage-proposed/10 text-stage-proposed",
  "in-progress": "bg-stage-in-progress/10 text-stage-in-progress",
  ready: "bg-stage-ready text-primary-foreground",
};

/** 各阶段的进度条填色——看板字段进度条与系统匣面板进度条共用。 */
export const STAGE_BAR: Record<Stage, string> = {
  proposed: "bg-stage-proposed",
  "in-progress": "bg-stage-in-progress",
  ready: "bg-stage-ready",
};

/** 各阶段的图标色——与 STAGE_BAR 同色相；看板栏标题与面板分区标题共用。 */
export const STAGE_ICON: Record<Stage, string> = {
  proposed: "text-stage-proposed",
  "in-progress": "text-stage-in-progress",
  ready: "text-stage-ready",
};

/** 讨论的色相（桃紫，专属）——看板讨论栏标头与系统匣讨论分区的图标与计数共用。 */
export const DISCUSSION_TONE = {
  icon: "text-stage-discussion",
  badge: "bg-stage-discussion/10 text-stage-discussion",
} as const;

/**
 * 由生命周期标记派生 change 的阶段（优先序由上而下）：
 * - 任务全完成（总数 > 0 且完成数 == 总数）→ ready（可归档，全完成优先）
 * - meta 含 started_at 或任务完成数 > 0 → in-progress（任务进度涵盖手改
 *   tasks.md、agent 直改、git pull 等绕过工具的写入路径——派生管显示，
 *   开工归属仍只由 meta 的 started_* 诚实记录）
 * - 其余 → proposed（刚 propose 完、全未勾、未开工）
 */
export function changeStage(c: ChangeItem): Stage {
  if (c.totalTasks > 0 && c.completedTasks >= c.totalTasks) return "ready";
  if (c.startedAt || c.completedTasks > 0) return "in-progress";
  return "proposed";
}

/**
 * 待手动判定的单一入口（spec desktop-app「看板卡片的待手动标示」）：写码任务
 * 全完成、仅余未勾 `[M]` 时回传剩余手测项数，其余回 0——含两个不浮现的边界：
 * remote 摘要缺写码进度字段（undefined 不猜、不以全量计数代打），以及
 * codeTotal 为 0 的全手动变更（「写码全完成」的空真值不视为待手动）。
 */
export function awaitingManualCount(c: ChangeItem): number {
  const remaining = c.totalTasks - c.completedTasks;
  const show = (c.codeTotal ?? 0) > 0 && c.codeRemaining === 0 && remaining > 0;
  return show ? remaining : 0;
}

/**
 * 波次读取入口（spec desktop-app「看板卡片的波次与阻挡标示」）：清单项带 wave
 * 才有波次；remote 摘要、plan 成环或坏 meta 时字段缺席，回 null——卡片与调度
 * 分页只读结果、不自行判断缺席原因。
 */
export function planWave(c: ChangeItem): number | null {
  return typeof c.wave === "number" ? c.wave : null;
}

/** 阻挡清单读取入口：只在波次存在时成立（调度字段同进同出），其余回空数组。 */
export function planBlockedBy(c: ChangeItem): string[] {
  return planWave(c) === null ? [] : (c.blockedBy ?? []);
}

/** requirement 级重叠读取入口：与 planBlockedBy 同一规则；旧 server 缺字段时也回空数组。 */
export function planRequirementOverlap(c: ChangeItem): ChangeRequirementOverlap[] {
  return planWave(c) === null ? [] : (c.requirementOverlap ?? []);
}

/** 封存顺序读取入口（本变更该排在其后封存的变更）：与 planBlockedBy 同一规则。 */
export function planArchiveAfter(c: ChangeItem): string[] {
  return planWave(c) === null ? [] : (c.archiveAfter ?? []);
}

/** 波次文本（card.wave）：卡片章、面板列首、调度分页共用同一处组装。 */
export function planWaveLabel(wave: number, t: (key: string) => string): string {
  return t("card.wave").replace("{n}", String(wave));
}

/** 前置清单文本（card.blockedTitle）：名称以语系分隔符相连，卡片 tooltip 与面板列 title 共用。 */
export function planBlockedLabel(blockedBy: readonly string[], t: (key: string) => string): string {
  return t("card.blockedTitle").replace("{names}", blockedBy.join(t("common.listSeparator")));
}

// spec 需求「看板字段由生命周期标记驱动」：全完成＝已就绪 ＞ started_at 或任务
// 完成数>0＝进行中 ＞ 其余＝提案中。矩阵值取自 spec 的 Example「字段判定矩阵」表。
import { describe, it, expect } from "vitest";
import {
  awaitingManualCount,
  changeStage,
  planArchiveAfter,
  planBlockedBy,
  planBlockedLabel,
  planRequirementOverlap,
  planWave,
  planWaveLabel,
  DISCUSSION_TONE,
  STAGE_BADGE,
  STAGE_BAR,
  STAGE_ICON,
} from "../stage";
import type { ChangeItem } from "../adapter";
import { SEMANTIC_SURFACE, SEMANTIC_TONE } from "../tone";
import { REVIEW_TONE } from "../components/reviewStyle";
import { VERIFY_TONE } from "../components/verifyStyle";
import { IMPROVE_CHIP_TONE, IMPROVE_TONE } from "../components/improveStyle";
import { DELTA_COLORS } from "../components/DeltaBadges";

function ci(total: number, done: number, startedAt?: string): ChangeItem {
  return { name: "c", status: "x", totalTasks: total, completedTasks: done, startedAt };
}

describe("changeStage（标记驱动）", () => {
  it.each([
    // [totalTasks, completedTasks, startedAt, expected]
    [0, 0, undefined, "proposed"], // 无 | 0 任务 | 提案中
    [28, 0, undefined, "proposed"], // 无 | 0/28 | 提案中——刚 propose 完不错置
    [28, 3, undefined, "in-progress"], // 无 | 3/28 | 进行中——任务进度涵盖绕过工具的写入路径
    [28, 0, "2026-07-06", "in-progress"], // 有 | 0/28 | 进行中
    [28, 13, "2026-07-06", "in-progress"], // 有 | 13/28 | 进行中
    [28, 28, undefined, "ready"], // 无 | 28/28 | 已就绪（全完成优先）
    [28, 28, "2026-07-06", "ready"], // 有 | 28/28 | 已就绪
    [0, 0, "2026-07-06", "in-progress"], // 有标记、0 任务——已开工
  ] as const)("total=%i done=%i started=%s → %s", (total, done, startedAt, expected) => {
    expect(changeStage(ci(total, done, startedAt))).toBe(expected);
  });
});

// 生命周期与讨论的色相单一来源（design D4）：每阶一色相，色值只在 theme.css 的
// stage-* token；看板与系统匣共用这几张表，表内只保存「阶段→token class」对照。
describe("STAGE_* / DISCUSSION_TONE（生命周期每阶一色相）", () => {
  it("计数徽章：提案中与进行中为淡底实色字、已就绪为实心", () => {
    expect(STAGE_BADGE).toEqual({
      proposed: "bg-stage-proposed/10 text-stage-proposed",
      "in-progress": "bg-stage-in-progress/10 text-stage-in-progress",
      ready: "bg-stage-ready text-primary-foreground",
    });
  });

  it("进度条填色取各阶段 token", () => {
    expect(STAGE_BAR).toEqual({
      proposed: "bg-stage-proposed",
      "in-progress": "bg-stage-in-progress",
      ready: "bg-stage-ready",
    });
  });

  it("图标色取各阶段 token", () => {
    expect(STAGE_ICON).toEqual({
      proposed: "text-stage-proposed",
      "in-progress": "text-stage-in-progress",
      ready: "text-stage-ready",
    });
  });

  it("讨论栏与系统匣讨论分区共用桃紫 token", () => {
    expect(DISCUSSION_TONE).toEqual({
      icon: "text-stage-discussion",
      badge: "bg-stage-discussion/10 text-stage-discussion",
    });
  });
});

// 状态→token class 对照（design D1）：集中常数档只保存对照，深色由 theme.css 的
// 深色 token 承担，表内不得出现 dark: 成对写法或原生色阶。
describe("语意色对照表只含 token class", () => {
  it("SEMANTIC_TONE／SEMANTIC_SURFACE 取 status token 与 destructive", () => {
    expect(SEMANTIC_TONE).toEqual({
      inProgress: "text-status-progress",
      success: "text-status-success",
      warning: "text-status-warning",
      danger: "text-destructive",
      // 待手动为暖黄（desktop-change-doc-views design D14；spec「接口状态语意色分层」）。
      manual: "text-status-manual",
    });
    expect(SEMANTIC_SURFACE).toEqual({
      inProgress: "border-status-progress/40 bg-status-progress/10",
      success: "border-status-success/40 bg-status-success/10",
      warning: "border-status-warning/40 bg-status-warning/10",
      danger: "border-destructive/40 bg-destructive/10",
      manual: "border-status-manual/40 bg-status-manual/10",
    });
  });

  it("审查与验证章：盖章取 stamp，其余三态取 status token", () => {
    expect(REVIEW_TONE).toEqual({
      inReview: "text-status-progress",
      reviewed: "text-stamp",
      reviewedStale: "text-status-warning",
      reviewedNotPassed: "text-destructive",
    });
    expect(VERIFY_TONE).toEqual({
      inVerify: "text-status-progress",
      verified: "text-stamp",
      verifiedStale: "text-status-warning",
      verifiedNotPassed: "text-destructive",
    });
  });

  it("改进标示取 improve token", () => {
    expect(IMPROVE_TONE).toBe("text-improve");
    expect(IMPROVE_CHIP_TONE).toBe("bg-improve/10");
  });

  it("delta 四色：添加＝成功、修改＝警示、移除＝destructive、更名＝进行中", () => {
    expect(DELTA_COLORS).toEqual({
      added: "text-status-success",
      modified: "text-status-warning",
      removed: "text-destructive",
      renamed: "text-status-progress",
    });
  });
});

// spec desktop-app「看板卡片的待手动标示」:判定收敛于阶段派生模块单一入口。
describe("awaitingManualCount(待手动判定)", () => {
  const c = (codeTotal: number | undefined, codeRemaining: number | undefined, remaining: number): ChangeItem => ({
    name: "c",
    status: "in-progress",
    totalTasks: 10,
    completedTasks: 10 - remaining,
    ...(codeTotal !== undefined ? { codeTotal, codeComplete: codeTotal - (codeRemaining ?? 0), codeRemaining } : {}),
  });

  it("spec Example「浮现判定」表逐列", () => {
    // | codeTotal | codeRemaining | remaining | 待手动章 |
    const rows: [number, number, number, number][] = [
      [9, 0, 1, 1],
      [7, 0, 3, 3],
      [8, 2, 3, 0],
      [10, 0, 0, 0],
      [0, 0, 2, 0], // 尚无写码任务:空真值不浮现
    ];
    for (const [codeTotal, codeRemaining, remaining, want] of rows) {
      expect(
        awaitingManualCount(c(codeTotal, codeRemaining, remaining)),
        `codeTotal=${codeTotal} codeRemaining=${codeRemaining} remaining=${remaining}`,
      ).toBe(want);
    }
  });

  it("remote 缺写码进度字段一律 0(章缺席)", () => {
    expect(awaitingManualCount(c(undefined, undefined, 1))).toBe(0);
  });
});

// spec desktop-app「看板卡片的波次与阻挡标示」：判定收敛于单一入口，字段缺席
// （remote 摘要、plan 成环、坏 meta）一律回 null／空数组，卡片只读结果。
describe("planWave / planBlockedBy（调度字段读取入口）", () => {
  const base: ChangeItem = { name: "c", status: "proposed", totalTasks: 3, completedTasks: 0 };

  it("wave 存在时回传波次，缺席回 null", () => {
    expect(planWave({ ...base, wave: 2, blockedBy: [], dependsOn: [], overlaps: [] })).toBe(2);
    expect(planWave({ ...base, wave: 1 })).toBe(1);
    expect(planWave(base)).toBeNull();
    expect(planWave({ ...base, wave: undefined })).toBeNull();
  });

  it("blockedBy 只在 wave 存在时回传，其余回空数组", () => {
    expect(planBlockedBy({ ...base, wave: 2, blockedBy: ["a", "b"] })).toEqual(["a", "b"]);
    expect(planBlockedBy({ ...base, wave: 1, blockedBy: [] })).toEqual([]);
    expect(planBlockedBy({ ...base, wave: 1 })).toEqual([]);
    expect(planBlockedBy(base)).toEqual([]);
    // 缺 wave 的不合法组合：blockedBy 不单独成立。
    expect(planBlockedBy({ ...base, blockedBy: ["a"] })).toEqual([]);
  });
});

// spec desktop-app「详情抽屉的调度分页」：requirement 级重叠与封存顺序同走单一入口——
// wave 缺席（remote 未取得 plan、plan 成环、坏 meta）即空数组；wave 在而新字段缺席
// （旧 server）同为空数组，分页据此显示空态。
describe("planRequirementOverlap / planArchiveAfter（调度新字段读取入口）", () => {
  const base: ChangeItem = { name: "c", status: "proposed", totalTasks: 3, completedTasks: 0 };
  const row = {
    change: "add-b",
    capability: "desktop-app",
    requirement: "看板与任务",
    ownOperation: "MODIFIED",
    otherOperation: "MODIFIED",
    conflict: false,
  } as const;

  it("requirementOverlap 只在 wave 存在时回传，其余回空数组", () => {
    expect(planRequirementOverlap({ ...base, wave: 1, requirementOverlap: [row] })).toEqual([row]);
    expect(planRequirementOverlap({ ...base, wave: 1 })).toEqual([]);
    expect(planRequirementOverlap(base)).toEqual([]);
    expect(planRequirementOverlap({ ...base, requirementOverlap: [row] })).toEqual([]);
  });

  it("archiveAfter 只在 wave 存在时回传，其余回空数组", () => {
    expect(planArchiveAfter({ ...base, wave: 2, archiveAfter: ["add-b"] })).toEqual(["add-b"]);
    expect(planArchiveAfter({ ...base, wave: 2 })).toEqual([]);
    expect(planArchiveAfter(base)).toEqual([]);
    expect(planArchiveAfter({ ...base, archiveAfter: ["add-b"] })).toEqual([]);
  });
});

describe("planWaveLabel / planBlockedLabel（调度文本的单一组装点）", () => {
  // 审查 Round 1：卡片 tooltip、面板列首与调度分页各自 replace 占位符——收成一处。
  const dict: Record<string, string> = {
    "card.wave": "第 {n} 波",
    "card.blockedTitle": "等待：{names}",
    "common.listSeparator": "、",
  };
  const t = (key: string) => dict[key] ?? key;

  it("波次文本套 card.wave 的 {n}", () => {
    expect(planWaveLabel(2, t)).toBe("第 2 波");
  });

  it("前置文本以语系分隔符相连", () => {
    expect(planBlockedLabel(["add-a", "add-b"], t)).toBe("等待：add-a、add-b");
    expect(planBlockedLabel(["add-a"], t)).toBe("等待：add-a");
  });
});

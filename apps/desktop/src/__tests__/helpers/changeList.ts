// 数据源 listChanges 的回应形状（清单项＋顶层 planError）——测试替身共用。
import type { ChangeItem, ChangeListPayload, ChangeRequirementOverlap } from "@specseal/ui";

export function changeList(changes: ChangeItem[], planError: string | null = null): ChangeListPayload {
  return { changes, planError, next: null, unpromotedCuts: [] };
}

/** 清单项 requirementOverlap 的一列：与 `change` 同动 desktop-app 的「看板与任务」（双方 MODIFIED、不冲突）。 */
export function sharedBoardRequirement(change: string): ChangeRequirementOverlap {
  return {
    change,
    capability: "desktop-app",
    requirement: "看板与任务",
    ownOperation: "MODIFIED",
    otherOperation: "MODIFIED",
    conflict: false,
  };
}

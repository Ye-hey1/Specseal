// 前端测试共用：以记录原文加手写的引擎形状 `cuts` 组成 `DiscussionDocument`（discussion-cuts-from-engine）。
// 刀由引擎（specseal-core discuss::record_cuts）解析，前端不再判定——测试照引擎会回的值手写，不在前端重算。
import type { DiscussionCut, DiscussionDocument } from "../adapter";

/** 一把引擎形状的刀：`line` 为该刀列点去掉 `- ` 的首行原文，其余字段缺席时取引擎的空值。 */
export function engineCut(line: string, fields: Partial<Omit<DiscussionCut, "line">> & { cut: string }): DiscussionCut {
  return { title: "", note: "", changes: [], changesInBold: false, unpromoted: [], ...fields, line };
}

/** 记录原文＋其刀。 */
export function discussionDoc(content: string, cuts: DiscussionCut[] = []): DiscussionDocument {
  return { content, cuts };
}

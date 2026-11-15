import type { ReactElement } from "react";
import { Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";

import { REVIEW_PILL_TONE, REVIEW_TONE } from "./reviewStyle";

/* 验证标示配色（spec desktop-app「看板卡片的验证标示」「详情抽屉的验证信息列」
   「已封存侧的验证标示」共用；design D5）：色承载状态、图标形状承载站别。
   四个色阶直接引用审查章样式表的同值常数——不拷贝色阶字面，否则两站日后只会
   一边改、一边留。 */
export const VERIFY_TONE = {
  inVerify: REVIEW_TONE.inReview,
  verified: REVIEW_TONE.reviewed,
  verifiedStale: REVIEW_TONE.reviewedStale,
  verifiedNotPassed: REVIEW_TONE.reviewedNotPassed,
} as const;

/** 验证状态 → 状态签 tone：直接引用审查站同值，两站语意不分岔。 */
export const VERIFY_PILL_TONE = {
  inVerify: REVIEW_PILL_TONE.inReview,
  verified: REVIEW_PILL_TONE.reviewed,
  verifiedStale: REVIEW_PILL_TONE.reviewedStale,
  verifiedNotPassed: REVIEW_PILL_TONE.reviewedNotPassed,
} as const;

/** 验证状态 → i18n 词条 key（active 四态与 archived 三态同一张表）。`none` 与
   缺席不入表——查不到即不渲染任何验证元素。 */
export const VERIFY_LABEL_KEY = {
  inVerify: "verify.inVerify",
  verified: "verify.verified",
  verifiedStale: "verify.verifiedStale",
  verifiedNotPassed: "verify.notPassed",
} as const;

/** 有标示的验证状态——`VERIFY_TONE`／`VERIFY_LABEL_KEY` 的共同键集。 */
export type VerifyBadgeStatus = keyof typeof VERIFY_TONE;

/** 验证状态 → 行内小章图标：盾牌系（审查站是徽章系），同色不同形即可一眼分站。 */
export const VERIFY_ICON: Record<VerifyBadgeStatus, ReactElement> = {
  inVerify: <Shield className="h-3.5 w-3.5" />,
  verified: <ShieldCheck className="h-3.5 w-3.5" />,
  verifiedStale: <ShieldAlert className="h-3.5 w-3.5" />,
  verifiedNotPassed: <ShieldX className="h-3.5 w-3.5" />,
};

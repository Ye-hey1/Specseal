import type { ReactElement } from "react";
import { BadgeAlert, BadgeCheck, BadgeX, Stamp } from "lucide-react";

import { SEMANTIC_TONE } from "../tone";
import type { StatusPillTone } from "./ui/status-pill";

/* 审查标示配色（spec desktop-app「看板卡片的审查标示」「详情抽屉的审查信息列」
   「已封存侧的审查标示」共用）：四态各给可辨识的色，不落回灰阶。
   审查中＝进行中的蓝；已审查＝盖章紫；其后有变动＝警示琥珀；
   曾审查未通过＝红（destructive，永久结局，警示层级最高）。
   紫是品质站盖章专属（spec desktop-app「品质站盖章配色与主色分离」）：主色 teal
   同时承载进度条、分页、链接签，盖章引用主色会淹在满版 teal 里，因此让出主色，
   改用 stamp token。色值都在 theme.css；验证站与本表共用同一张 tone 表，不另立一份。 */
export const REVIEW_TONE = {
  inReview: SEMANTIC_TONE.inProgress,
  reviewed: "text-stamp",
  reviewedStale: SEMANTIC_TONE.warning,
  reviewedNotPassed: SEMANTIC_TONE.danger,
} as const;

/** 审查状态 → 状态签 tone（design D5）：与 `REVIEW_TONE` 同一组语意——已审查＝盖章、
   审查中＝进行中、其后有变动＝警示、未通过＝危险；详情页的章签用。 */
export const REVIEW_PILL_TONE = {
  inReview: "progress",
  reviewed: "stamp",
  reviewedStale: "warning",
  reviewedNotPassed: "destructive",
} as const satisfies Record<keyof typeof REVIEW_TONE, StatusPillTone>;

/** 审查状态 → i18n 词条 key（active 四态与 archived 三态同一张表）：状态词在
   卡片、详情抽屉与已封存两处各出现一次，对照只此一份。`none` 与缺席不入表
   ——查不到即不渲染任何审查元素。 */
export const REVIEW_LABEL_KEY = {
  inReview: "review.inReview",
  reviewed: "review.reviewed",
  reviewedStale: "review.reviewedStale",
  reviewedNotPassed: "review.notPassed",
} as const;

/** 有标示的审查状态——`REVIEW_TONE`／`REVIEW_LABEL_KEY` 的共同键集。 */
export type ReviewBadgeStatus = keyof typeof REVIEW_TONE;

/** 审查状态 → 行内小章图标：进行中的印章、已审查的实心徽章、其后有变动的
   警示徽章、未通过的叉号徽章。与 tone／label 同一组键，三处标示共用。 */
export const REVIEW_ICON: Record<ReviewBadgeStatus, ReactElement> = {
  inReview: <Stamp className="h-3.5 w-3.5" />,
  reviewed: <BadgeCheck className="h-3.5 w-3.5" />,
  reviewedStale: <BadgeAlert className="h-3.5 w-3.5" />,
  reviewedNotPassed: <BadgeX className="h-3.5 w-3.5" />,
};

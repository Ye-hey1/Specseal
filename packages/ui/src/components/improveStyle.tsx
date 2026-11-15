import { Sparkles } from "lucide-react";

/* 改进讨论标示样式表（spec desktop-app「看板讨论卡片的改进标示」「讨论抽屉的
   改进标示」共用）：卡片小章、promoted 收合列、已封存侧与两个抽屉的对照只此
   一份——镜射 reviewStyle.tsx 的集中模式。色调取 improve token（indigo）：审查／
   验证章的紫是品质站盖章专属，此章标的是讨论类型而非状态，两者不共色。 */
export const IMPROVE_TONE = "text-improve";

/** 抽屉章签的染色底——透明度对齐 tone.ts 的 /10 惯例。 */
export const IMPROVE_CHIP_TONE = "bg-improve/10";

/** 改进标示图标（各呈现面自带尺寸 className）。 */
export const ImproveIcon = Sparkles;

/** 改进讨论的 i18n 词条 key——卡片小章、已封存侧与抽屉标示共用同一份文案。 */
export const IMPROVE_LABEL_KEY = "discussion.kindImprove";

/** kind 是否为改进讨论（单一合法值，缺席即一般讨论）。 */
export function isImproveKind(kind?: string | null): boolean {
  return kind === "improve";
}

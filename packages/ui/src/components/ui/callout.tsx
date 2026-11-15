import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SEMANTIC_SURFACE, SEMANTIC_TONE, type SemanticTone } from "../../tone";

/** 提示框四型（与 GitHub Alert 同名）。 */
export type CalloutTone = "note" | "tip" | "warning" | "caution";

/** 型 → 接口状态语意色（信息、成功、警告、危险；不占主色）。 */
export const CALLOUT_TONE: Record<CalloutTone, SemanticTone> = {
  note: "inProgress",
  tip: "success",
  warning: "warning",
  caution: "danger",
};

/** 接口自用的第五型：待手动（暖黄）。Markdown 的 GitHub Alert 只认上面四型。 */
type CalloutToneWithManual = CalloutTone | "manual";
const TONE_SEMANTIC: Record<CalloutToneWithManual, SemanticTone> = { ...CALLOUT_TONE, manual: "manual" };

/** 外框与标题列款式——Markdown 的 `> [!NOTE]` 提示框与 sanitize 白名单也由这两串展开。 */
export const CALLOUT_BOX_CLS = "my-4 rounded-r-md border-l-4 px-4 py-2 [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1";
export const CALLOUT_TITLE_CLS = "markdown-alert-title mb-1 text-sm font-semibold";

export interface CalloutProps extends Omit<ComponentProps<"div">, "title"> {
  tone: CalloutToneWithManual;
  title: ReactNode;
  icon?: ReactNode;
}

/** 提示框（design D6）：左粗线＋语意色淡底、语意色标题列。与 Markdown 的 GitHub Alert 同款；
 * 放进以 gap 排距的版面时，调用端以 `className="my-0"` 盖掉 prose 用的上下外距。 */
export function Callout({ tone, title, icon, children, className, ...props }: CalloutProps) {
  const semantic = TONE_SEMANTIC[tone];
  return (
    <div {...props} className={cn(CALLOUT_BOX_CLS, SEMANTIC_SURFACE[semantic], className)}>
      <div className={`${CALLOUT_TITLE_CLS} ${SEMANTIC_TONE[semantic]}${icon ? " flex items-center gap-1.5" : ""}`}>
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

import { useI18n } from "../i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { IMPROVE_CHIP_TONE, IMPROVE_LABEL_KEY, IMPROVE_TONE, ImproveIcon } from "./improveStyle";

/**
 * 改进讨论的行内小章（spec desktop-app「看板讨论卡片的改进标示」）：镜射审查章
 * 样式——仅图标＋tooltip 状态词，不加文本列维持卡片极简。tone／icon／词条的
 * 对照集中在 improveStyle.tsx。
 */
export function ImproveStamp() {
  const { t } = useI18n();
  const label = t(IMPROVE_LABEL_KEY);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span aria-label={label} className={`shrink-0 ${IMPROVE_TONE}`}>
            <ImproveIcon className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * 改进讨论的章签（spec「讨论抽屉的改进标示」）：抽屉有空间故以图标＋状态词
 * 直出；活讨论抽屉与封存抽屉共用同一份。
 */
export function ImproveChip() {
  const { t } = useI18n();
  return (
    <span
      data-discussion-kind="improve"
      className={`inline-flex items-center gap-1 rounded-full ${IMPROVE_CHIP_TONE} px-2 py-0.5 font-semibold ${IMPROVE_TONE}`}
    >
      <ImproveIcon className="h-3 w-3" />
      {t(IMPROVE_LABEL_KEY)}
    </span>
  );
}

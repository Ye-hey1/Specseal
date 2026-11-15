import { CopyButton, REVEAL_ON_HOVER } from "./CopyButton";
import { HighlightText } from "./HighlightText";

/**
 * 看板全尺寸卡的识别列名称＋拷贝钮（spec「看板卡片统一解剖学」：标题恒单行、
 * 拷贝钮同列尾随）：拷贝钮紧跟名称最后一个字符后，不以 flex 推至卡片右缘。
 * 名称过长时就地截断、以省略号收尾（与全系统其余截断同一收尾），拷贝钮收在
 * 同一列不落次行。变更卡与讨论卡共用（骨架统一）。
 */
export function CardNameRow({
  text,
  copyLabel,
  highlight,
}: {
  text: string;
  copyLabel: string;
  highlight?: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span
        data-name
        className="font-mono font-semibold text-sm leading-tight min-w-0 truncate"
      >
        <HighlightText text={text} query={highlight} />
      </span>
      <CopyButton value={text} label={copyLabel} className={REVEAL_ON_HOVER} />
    </span>
  );
}

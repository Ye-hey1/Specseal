import { useState } from "react";

import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

/** 来源链接项：slug 为识别锚点（openspec/LANGUAGE.md 受控例外），topic 为描述副标（同源变更等无副标项缺席）；
 * disabled 为不可点（drawer-provenance-links design D3：无封存记录的来源变更、已删除的子变更）。 */
export interface SourceLinkItem {
  slug: string;
  topic?: string;
  disabled?: boolean;
}

const CHIP_ACTIVE_CLS =
  "bg-primary/10 font-medium text-primary hover:bg-primary/20 hover:text-primary";
// 不可点签：灰底灰字、无 hover 变化、光标维持缺省——与可点签同形，只失去交互语意。
const CHIP_DISABLED_CLS =
  "bg-muted font-medium text-muted-foreground hover:bg-muted hover:text-muted-foreground cursor-default";

/**
 * 来源链接签：变更详情抽屉、已封存抽屉与规格抽屉共用的单一实作。
 *
 * 签面以 slug 直出（等宽字体）——slug 短而稳定，签形一致；topic 是自由文本整句话，
 * 降为主题化提示（slug＋topic 两行），不再上签面（spec「抽屉标头标记受宽度约束且
 * 抽屉不产生水平滚动条」）。宽度上限 max-w-[140px] 截断兜底超长 slug；截断必须落在
 * 内层区块子项（text-overflow 不作用于 flex 容器本身）。
 *
 * disabled 时不挂 onClick、标 aria-disabled；不用原生 disabled 属性——它会吞掉指针事件，
 * 提示（slug＋副标）就出不来。
 */
export function SourceDiscussionChip({
  slug,
  topic,
  disabled,
  onClick,
}: SourceLinkItem & {
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={disabled ? "true" : undefined}
          className={`h-auto min-w-0 max-w-[140px] rounded-full px-2 py-0.5 font-mono ${disabled ? CHIP_DISABLED_CLS : CHIP_ACTIVE_CLS}`}
          onClick={disabled ? undefined : onClick}
        >
          <span data-source-discussion-label className="truncate">
            {slug}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <div className="truncate font-mono">{slug}</div>
        {topic && <div className="line-clamp-3">{topic}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 来源链接列：首签（清单第一份＝出身）＋「+N」溢出浮层；前缀标签由详情页左栏的关联列自带。
 *
 * 固定颗数切点：固定显示 1 颗，其余收进 +N 数字签，
 * 点击以 Popover 浮层列出（slug 主行＋topic 副行），点浮层项跳转并关闭浮层——
 * 与看板卡片「单一讨论徽章以出身讨论为代表」对称。「来自」「同源」「衍生」共用此列。
 * disabled 项在浮层内同样不可点、不关闭浮层；onOpen 只对可点项触发。
 */
export function SourceChipRow({
  items,
  onOpen,
}: {
  items: SourceLinkItem[];
  onOpen?: (slug: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const [first, ...rest] = items;
  return (
    <TooltipProvider>
      <span className="inline-flex min-w-0 items-center gap-1">
        <SourceDiscussionChip
          slug={first.slug}
          topic={first.topic}
          disabled={first.disabled}
          onClick={() => onOpen?.(first.slug)}
        />
        {rest.length > 0 && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-source-overflow
                aria-label={t("rdrawer.moreSources").replace("{n}", String(rest.length))}
                className="h-auto shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                +{rest.length}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72">
              <div data-source-overflow-list className="flex flex-col">
                {rest.map((it) => (
                  <Button
                    key={it.slug}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-disabled={it.disabled ? "true" : undefined}
                    className={`h-auto justify-start px-2 py-1.5 text-left ${it.disabled ? "cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground" : ""}`}
                    onClick={
                      it.disabled
                        ? undefined
                        : () => {
                            setOpen(false);
                            onOpen?.(it.slug);
                          }
                    }
                  >
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="max-w-full truncate font-mono text-xs font-medium">
                        {it.slug}
                      </span>
                      {it.topic && (
                        <span className="max-w-full truncate text-xs font-normal text-muted-foreground">
                          {it.topic}
                        </span>
                      )}
                    </span>
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </span>
    </TooltipProvider>
  );
}

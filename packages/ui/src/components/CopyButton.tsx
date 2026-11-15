import { Check, Copy } from "lucide-react";

import { useI18n } from "../i18n";
import { cn } from "../lib/utils";
import { REVEAL_ON_GROUP_HOVER } from "../reveal";
import { Button } from "./ui/button";
import { useCopied } from "./useCopied";

/** hover 才显现、拷贝成功期间保持可见——卡片标题旁的拷贝钮共用这组 class。 */
export const REVEAL_ON_HOVER = `${REVEAL_ON_GROUP_HOVER} data-[copied]:opacity-100`;

export interface CopyButtonProps {
  value: string;
  /** 无障碍名称与 hover 提示。 */
  label: string;
  /** icon：只有图标（列尾、标题旁）；sm：图标＋「拷贝／已拷贝」文本的外框小钮。 */
  size?: "sm" | "icon";
  /** 覆写写入剪贴板的路径（例如系统匣走 Tauri clipboard）；抛错或 reject 视为失败。 */
  onCopy?: (value: string) => void | Promise<void>;
  /** 退出 tab 顺序用（系统匣面板）。 */
  tabIndex?: number;
  className?: string;
}

/**
 * 拷贝钮（spec desktop-app「共用组件唯一来源」；design D8）：点击不冒泡（不触发列本体
 * 的打开）；写入成功后呈主色勾号 1.5 秒并以 status 声明，失败静默、不呈勾号。成功期间
 * 带 `data-copied`，hover 才显现的调用端以 `data-[copied]:opacity-100` 保持可见。
 */
export function CopyButton({ value, label, size = "icon", onCopy, tabIndex, className }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, markCopied] = useCopied();
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    let result: void | Promise<void>;
    try {
      result = onCopy ? onCopy(value) : navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    if (result instanceof Promise) result.then(markCopied, () => {});
    else markCopied();
  };
  const icon = copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />;
  return (
    <>
      <Button
        type="button"
        variant={size === "sm" ? "outline" : "subtle"}
        size={size === "sm" ? "sm" : "icon-xs"}
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
        data-copied={copied ? "" : undefined}
        className={cn(
          "shrink-0",
          size === "sm" ? "gap-1.5" : "h-5 w-5",
          copied && "text-primary",
          className,
        )}
        onClick={copy}
      >
        {icon}
        {size === "sm" && (copied ? t("common.copied") : t("common.copy"))}
      </Button>
      {/* sr-only 是 absolute：不钉位置会停在卷动区外的深处，撑高外层（desktop 的 main）。 */}
      <span role="status" aria-live="polite" className="sr-only top-0 left-0">
        {copied ? t("common.copied") : ""}
      </span>
    </>
  );
}

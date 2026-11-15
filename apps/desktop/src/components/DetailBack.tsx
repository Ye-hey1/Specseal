// 详情页标题列左侧的返回钮与返回快捷键判断（desktop-readonly-detail-pages design D8）。
// 右端的 ‹ n／m › 已搬进 @specseal/ui 的 DetailNav（server-web-detail-pages design D3）。
import { ArrowLeft } from "lucide-react";
import { Button, useI18n } from "@specseal/ui";

import type { Platform } from "../platform";

/** 返回快捷键（design D8）：macOS 为 ⌘[ 与 ⌘←、其他平台 Alt+←。以实体按键（e.code）判定——
 * 中文输入法激活时 `[` 键送进页面的 e.key 不一定是「[」；e.key 留作没有 code 的事件后备。 */
export function isBackShortcut(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">,
  platform: Platform,
): boolean {
  if (e.shiftKey || e.ctrlKey) return false;
  const leftArrow = e.code === "ArrowLeft" || e.key === "ArrowLeft";
  if (platform === "macos") {
    return e.metaKey && !e.altKey && (leftArrow || e.code === "BracketLeft" || e.key === "[");
  }
  return e.altKey && !e.metaKey && leftArrow;
}

/** 返回钮：回宿主清单页（与 Esc、面包屑中段同一个动作），提示标示 Esc 与返回快捷键。 */
export function DetailBack({
  page,
  keys,
  onBack,
}: {
  /** 宿主页名（规格、已封存、变更、手册）。 */
  page: string;
  /** 依平台的返回快捷键（⌘[ 或 Alt+←）。 */
  keys: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const label = t("detail.back").replace("{page}", page);
  return (
    <Button
      variant="subtle"
      size="icon-xs"
      aria-label={label}
      title={t("detail.backHint").replace("{label}", label).replace("{keys}", keys)}
      className="-ml-1.5 mr-1.5 shrink-0"
      onClick={onBack}
    >
      <ArrowLeft className="h-4 w-4" />
    </Button>
  );
}

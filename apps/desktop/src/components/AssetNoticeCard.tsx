// 技能档提示卡（desktop-app spec「指令档过期提示」；desktop-notice-relocation design D1）：
// 项目栏底部、项目设置项上方的常驻卡——琥珀淡底、一句标题、一句说明、›；整张可点，开
// 确认框。提示是「这个项目」的事，住在项目栏而非主区：主区不再为它扣高度或钉选。
import { AlertCircle, ChevronRight } from "lucide-react";
import { SEMANTIC_SURFACE, SEMANTIC_TONE, cn, useI18n, type Translator } from "@specseal/ui";

import type { AssetPromptState } from "../assetPrompt";

export interface AssetNoticeCardProps {
  prompt: AssetPromptState | null;
  onOpen: () => void;
}

export function AssetNoticeCard({ prompt, onOpen }: AssetNoticeCardProps) {
  const { t, tn } = useI18n();
  if (!prompt) return null;
  const { title, desc } = cardText(prompt, t, tn);
  return (
    <button
      type="button"
      data-testid="asset-notice-card"
      aria-label={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border p-2.5 text-left transition-colors hover:bg-status-warning/15",
        SEMANTIC_SURFACE.warning,
      )}
      onClick={onOpen}
    >
      <AlertCircle className={cn("h-4 w-4 shrink-0", SEMANTIC_TONE.warning)} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium leading-tight">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-tight text-muted-foreground">{desc}</span>
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** 卡片的标题与说明：技能档三态代入文件数；只剩规格文件夹待迁移时说明会改名什么
 * （desktop-spec-dir-migration D2）。 */
function cardText(prompt: AssetPromptState, t: Translator["t"], tn: Translator["tn"]) {
  const { kind, migration } = prompt;
  if (kind !== "migrate") {
    // remote 项目的过期是「和 Server 提供的不同」，不一定比较旧。
    const title = prompt.server && kind === "stale" ? "assets.card.serverStaleTitle" : `assets.card.${kind}Title`;
    return { title: t(title), desc: tn(`assets.card.${kind}Desc`, prompt.fileCount) };
  }
  const desc =
    migration.state === "pending" && migration.folder === "specseal"
      ? tn("assets.card.migrateFilesDesc", migration.metaFiles)
      : t("assets.card.migrateDesc");
  return { title: t("assets.card.migrateTitle"), desc };
}

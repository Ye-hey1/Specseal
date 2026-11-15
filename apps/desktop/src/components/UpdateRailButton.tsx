// 「有新版本」图标钮（desktop-app spec「桌面自动更新」；desktop-notice-relocation design D2）：
// 图标列底部、齿轮上方的状态钮——待同意＝下载箭头＋琥珀点、下载中＝转圈、待重启＝重启箭头＋
// 琥珀点、失败＝红色警示；闲置、检查中、已最新、检查失败不出现（手动检查的结果在设置卡内
// 行内呈现）。提示是全域的事，住在图标列而非窗口顶端横幅；点击进设置页并卷到软件更新卡。
import { AlertTriangle, Download, LoaderCircle, RotateCw } from "lucide-react";
import { SEMANTIC_TONE, Tooltip, TooltipContent, TooltipTrigger, cn, useI18n } from "@specseal/ui";

import { updateNeedsAttention, type UpdaterState } from "../core/updater";
import { RAIL_SQUARE } from "./projectTile";

export interface UpdateRailButtonProps {
  state: UpdaterState;
  onClick: () => void;
}

export function UpdateRailButton({ state, onClick }: UpdateRailButtonProps) {
  const { t } = useI18n();
  if (!updateNeedsAttention(state)) return null;
  const label =
    state.phase === "error"
      ? t("updater.rail.error")
      : t(`updater.rail.${state.phase}`).replace("{version}", state.version);
  // 点只标「有事等你做」的两态：待同意与待重启；下载中与失败由图标本身表达。
  const dot = state.phase === "available" || state.phase === "restartPending";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="update-rail-button"
          data-phase={state.phase}
          aria-label={label}
          className={cn(
            RAIL_SQUARE,
            "bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          )}
          onClick={onClick}
        >
          {state.phase === "available" && <Download className="h-4 w-4" />}
          {state.phase === "downloading" && (
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          )}
          {state.phase === "restartPending" && <RotateCw className="h-4 w-4" />}
          {state.phase === "error" && <AlertTriangle className={cn("h-4 w-4", SEMANTIC_TONE.danger)} />}
          {dot && (
            <span
              data-update-dot
              className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full border-2 border-sidebar bg-status-warning"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

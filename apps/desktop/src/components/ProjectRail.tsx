// 图标列（design D3）：品牌标记、每个开着的项目一个首字母方块、「＋」、底部齿轮。
// 方块不显示计数徽章；角落状态点：路径失效或复原错误＝红、remote 脱机或需重新登录
// 或技能档需要处理（上次探测为过期／缺失／较新）＝琥珀；探测中与复原中以 spinner 取代首字母。右键＝项目动作菜单；本机路径失效
// 时点击开错误菜单而不切换（remote 复原错误仍可选，主区是复原页）。
import type { ReactNode } from "react";
import { LoaderCircle, Plus, Settings } from "lucide-react";
import {
  BrandMark,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  SEMANTIC_TONE,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  useI18n,
} from "@specseal/ui";

import type { AssetPromptState } from "../assetPrompt";
import type { Platform } from "../platform";
import type { ProjectTab } from "../tabs";
import {
  locatorKey,
  type RemoteConnectionStateEvent,
  type RemoteWorkspaceRecoveryState,
  type RemoteWorkspaceStatus,
} from "../session";
import { ProjectActionItems, type ProjectActions } from "./ProjectActionsMenu";
import { ADD_TILE, PROJECT_TILE_ACTIVE, PROJECT_TILE_IDLE, RAIL_SQUARE, projectInitial } from "./projectTile";

export interface ProjectRailProps {
  tabs: ProjectTab[];
  activeKey: string | null;
  /** 失效分页错误（locator key → 单行消息）。 */
  tabErrors: Record<string, string>;
  recoveryStates?: Record<string, RemoteWorkspaceRecoveryState>;
  connectionStates?: Record<string, RemoteConnectionStateEvent | undefined>;
  /** 连接 id → 连接名称（remote 无 checkout 时 tooltip 用）。 */
  connectionNames?: Record<string, string>;
  /** 探测进行中的目标方块（store 的 pendingTabKey）。 */
  pendingKey?: string | null;
  /** 各分页上次的技能档提示（locator key → 值；非 null 即亮琥珀点）。 */
  assetPrompts?: Record<string, AssetPromptState | null>;
  platform: Platform;
  /** 右键与错误菜单的动作（与标题列「⋯」同一份）。 */
  actions: ProjectActions;
  onActivate?: (key: string) => void;
  /** 「＋」入口：开添加项目对话框。 */
  onOpen?: () => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  /** 齿轮上方的「有新版本」状态钮（desktop-notice-relocation design D2；无事时为 null）。 */
  updateButton?: ReactNode;
}

/** 方块与左侧标题列的 hover 路径：本机根；remote 有 checkout 明示连接路径，否则连接名称加 Project/Repo。 */
export function tabPathHint(
  tab: ProjectTab,
  connectionNames: Record<string, string>,
  t: (key: string) => string,
): string {
  const { locator } = tab;
  if (locator.kind === "local") return locator.root;
  if (locator.checkoutRoot) return t("app.checkoutTooltip").replace("{path}", locator.checkoutRoot);
  const connection = connectionNames[locator.connectionId] ?? locator.connectionId;
  return `${connection} · ${locator.projectId}/${locator.repoId}`;
}

export function ProjectRail({
  tabs,
  activeKey,
  tabErrors,
  recoveryStates = {},
  connectionStates = {},
  connectionNames = {},
  pendingKey = null,
  assetPrompts = {},
  platform,
  actions,
  onActivate,
  onOpen,
  onOpenSettings,
  settingsActive = false,
  updateButton,
}: ProjectRailProps) {
  const { t } = useI18n();
  return (
    <TooltipProvider>
      <div
        data-project-rail
        className="flex w-14 shrink-0 flex-col items-center border-r border-border pb-3 pt-2"
      >
        <BrandMark size={26} className="mb-3.5" />
        <div
          role="tablist"
          aria-label={t("app.projectRail")}
          aria-orientation="vertical"
          className="flex flex-col items-center gap-2"
        >
          {tabs.map((tab) => {
            const key = locatorKey(tab.locator);
            const recovery = recoveryStates[key];
            const connectionState = connectionStates[key]?.state;
            const status: RemoteWorkspaceStatus = recovery
              ? recovery.status
              : connectionState === "offline" || connectionState === "needs-reauth"
                ? connectionState
                : tabErrors[key] !== undefined
                  ? "error"
                  : "ready";
            const active = key === activeKey;
            const pending = key === pendingKey;
            // 技能档状况是上次看过时的状态（背景分页不主动探测），只说「需要处理」不带版号。
            const assetFlag = assetPrompts[key] != null;
            const assetHint = assetFlag ? t("assets.railHint") : "";
            // 本机路径失效：点击开错误菜单、不切换。remote 错误的主区是复原页，照常可选。
            const localError = tab.locator.kind === "local" && status === "error";
            const statusLabel =
              status === "restoring"
                ? t("remote.recovery.restoringShort")
                : status === "offline"
                  ? t("remote.recovery.offlineShort")
                  : status === "needs-reauth"
                    ? t("remote.recovery.reauthShort")
                    : status === "error"
                      ? recovery?.status === "error"
                        ? t(`remote.recovery.${recovery.failure.kind}Short`)
                        : localError
                          ? tabErrors[key]
                          : t("remote.recovery.unknownShort")
                      : "";
            const path = tabPathHint(tab, connectionNames, t);
            const dot =
              status === "error"
                ? "error"
                : status === "offline" || status === "needs-reauth" || assetFlag
                  ? "warning"
                  : null;
            const ariaLabel = [tab.name, statusLabel, assetHint, pending ? t("app.tabSwitching") : ""]
              .filter(Boolean)
              .join("，");
            const button = (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={ariaLabel}
                data-tab={key}
                data-active={String(active)}
                data-error={String(status === "error")}
                data-status={status}
                className={cn(
                  RAIL_SQUARE,
                  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? PROJECT_TILE_ACTIVE : cn(PROJECT_TILE_IDLE, "hover:bg-muted/70"),
                )}
                onClick={() => {
                  if (!active && !localError) onActivate?.(key);
                }}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && !active && !localError) {
                    event.preventDefault();
                    onActivate?.(key);
                  }
                }}
              >
                {pending ? (
                  <LoaderCircle
                    data-tab-status="pending"
                    role="img"
                    aria-label={t("app.tabSwitching")}
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  />
                ) : status === "restoring" ? (
                  <LoaderCircle
                    data-tab-status="restoring"
                    className={cn("h-4 w-4 animate-spin motion-reduce:animate-none", SEMANTIC_TONE.inProgress)}
                  />
                ) : (
                  projectInitial(tab.name)
                )}
                {dot && (
                  <span
                    data-tab-dot={dot}
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar",
                      dot === "error" ? "bg-destructive" : "bg-status-warning",
                    )}
                  />
                )}
              </button>
            );
            // 右键触发器要直接包住按钮：包在 DropdownMenu（非 DOM 的 Root）外面时，
            // Slot 传下的 onContextMenu 会被丢掉。
            const trigger = <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>;
            return (
              <Tooltip key={key}>
                <ContextMenu>
                  {localError ? (
                    <DropdownMenu>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                      </TooltipTrigger>
                      <DropdownMenuContent side="right" align="start">
                        <ProjectActionItems
                          menu="dropdown"
                          tab={tab}
                          platform={platform}
                          actions={actions}
                          error={tabErrors[key]}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <TooltipTrigger asChild>{trigger}</TooltipTrigger>
                  )}
                  <ContextMenuContent>
                    <ProjectActionItems
                      menu="context"
                      tab={tab}
                      platform={platform}
                      actions={actions}
                      error={localError ? tabErrors[key] : undefined}
                    />
                  </ContextMenuContent>
                </ContextMenu>
                <TooltipContent side="right" className="max-w-80">
                  <div className="font-medium">{tab.name}</div>
                  <div className="break-all text-muted-foreground">{path}</div>
                  {statusLabel && <div className="text-muted-foreground">{statusLabel}</div>}
                  {assetHint && <div className="text-muted-foreground">{assetHint}</div>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={t("app.newProject")}
          className={cn(
            RAIL_SQUARE,
            ADD_TILE,
            "mt-2 hover:bg-muted hover:text-foreground",
          )}
          onClick={onOpen}
        >
          <Plus className="h-4 w-4" />
        </button>
        {/* 沉底的一组：更新钮（有事才渲染）＋齿轮；gap 只在两者都在时才出现。 */}
        <div className="mt-auto flex flex-col items-center gap-1">
          {updateButton}
          <button
            type="button"
            aria-label={t("app.navSettings")}
            className={cn(
              RAIL_SQUARE,
              settingsActive
                ? "bg-primary text-primary-foreground"
                : "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
    </TooltipProvider>
  );
}

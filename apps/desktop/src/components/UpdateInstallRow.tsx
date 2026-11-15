// 更新页「下载与安装」卡的列（desktop-app spec「桌面自动更新」；desktop-settings-mode design D6）：
// 标题「Specseal <目标版本>」，说明与控制依状态——待同意＝「安装后会重新启动」＋「下载」、
// 下载中＝不确定进度列＋「取消」、待重启＝「更新已就绪」＋「安装并重新启动」、失败＝错误＋
// 「重试」（重新检查）；其他状态不出现。取消＝放弃本次同意回闲置：插件没有真正的下载取消，
// 其后到达的下载完成在闲置态被状态机忽略。进度列为不确定状态：插件的下载进度事件未接。
import { Button, SEMANTIC_TONE, SettingsRow, useI18n } from "@specseal/ui";

import { updateNeedsAttention, type UpdaterState } from "../core/updater";

export interface UpdateInstallRowProps {
  state: UpdaterState;
  onAccept: () => void;
  onCancel: () => void;
  onRelaunch: () => void;
  /** 失败后重试＝重新手动检查。 */
  onRetry: () => void;
}

export function UpdateInstallRow({ state, onAccept, onCancel, onRelaunch, onRetry }: UpdateInstallRowProps) {
  const { t } = useI18n();
  if (!updateNeedsAttention(state)) return null;
  // 失败态不带目标版本（签章验证失败后待套用项已清掉）。
  const label = state.phase === "error" ? "Specseal" : `Specseal ${state.version}`;
  const button = (text: string, onClick: () => void, variant?: "ghost" | "outline") => (
    <Button type="button" size="sm" variant={variant} onClick={onClick}>
      {text}
    </Button>
  );
  return (
    <div data-testid="update-install-row" data-phase={state.phase}>
      {state.phase === "available" && (
        <SettingsRow label={label} description={t("updater.page.installHint")} control={button(t("updater.row.download"), onAccept)} />
      )}
      {state.phase === "downloading" && (
        <SettingsRow
          label={label}
          description={
            <span className="flex flex-col gap-1.5">
              <span>{t("updater.downloading")}…</span>
              {/* 不确定进度：无 aria-valuenow，整段脉动。 */}
              <span role="progressbar" aria-label={t("updater.downloading")} className="block h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
                <span className="block h-full w-1/2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
              </span>
            </span>
          }
          control={button(t("updater.row.cancel"), onCancel, "ghost")}
        />
      )}
      {state.phase === "restartPending" && (
        <SettingsRow
          label={label}
          description={t("updater.row.ready")}
          control={button(t("updater.row.installRestart"), onRelaunch)}
        />
      )}
      {state.phase === "error" && (
        <SettingsRow
          label={label}
          description={
            <span className={`break-words ${SEMANTIC_TONE.danger}`}>
              {t("updater.errorPrefix")}
              {state.message}
            </span>
          }
          control={button(t("updater.row.retry"), onRetry, "outline")}
        />
      )}
    </div>
  );
}

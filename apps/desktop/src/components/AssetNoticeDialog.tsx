// 技能档提示确认框（desktop-app spec「指令档过期提示」；desktop-notice-relocation design D1）：
// 琥珀图标＋标题＋说明、一张细框卡三列（项目技能档版本、Specseal 版本、文件数），按钮依
// 状态——过期／缺失三键「稍后」「保留现状」「更新／安装技能档」、较新两键「保留现状」
// 「更新 Specseal」。ConfirmDialog 是两键式，三选项以上各自组 AlertDialog（spec「共用组件
// 唯一来源」）。较新态不提供任何改写动作：按「更新」把新版文件改写回旧内容，正是
// 2026-08-05 事故的形状——改开设置页软件更新卡。「稍后」只关框、「保留现状」写入既有略过
// 记忆；更新／安装不自行关框：成功由提示消失收合，失败的错误留在内容卡下方可重试。
// 规格文件夹迁移由同一个框承载（desktop-spec-dir-migration D2）：按下前写明会改名或为何
// 暂缓，迁移完成后改显示要 commit 的路径与提醒，直到用户按「知道了」。
// remote 项目的基准是 Server 提供的技能（remote-skill-delivery D6）：多一列「Server 提供的
// 技能版本」；app 比 Server 旧时多一句说明与「更新 Specseal」，安装或更新仍然可用——Server
// 的技能是对的，只是旧版的 Specseal 可能认不得新指令。
import { AlertCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  SEMANTIC_TONE,
  cn,
  useI18n,
} from "@specseal/ui";

import type { AssetUpdateResult, MigrationProbe } from "../adapter/workspace";
import type { AssetPromptState } from "../assetPrompt";

export interface AssetNoticeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: AssetPromptState | null;
  /** 再生进行中：全部动作键停用。 */
  busy: boolean;
  /** 上次更新／安装的失败消息（呈现于内容卡下方、可重试）。 */
  error: string | null;
  onApply: () => void;
  onDismiss: () => void;
  /** 较新态的主动作：切到设置页并卷到软件更新卡。 */
  onOpenSettingsUpdate: () => void;
  /** 上次更新的迁移结果；有值时显示完成态（提示已消失也照样显示）。 */
  migrated: AssetUpdateResult["migrated"] | null;
  /** 完成态的「知道了」。 */
  onDone: () => void;
}

export function AssetNoticeDialog({
  open,
  onOpenChange,
  prompt,
  busy,
  error,
  onApply,
  onDismiss,
  onOpenSettingsUpdate,
  migrated,
  onDone,
}: AssetNoticeDialogProps) {
  const { t } = useI18n();
  if (migrated) return <MigratedDialog open={open} migrated={migrated} onDone={onDone} />;
  if (!prompt) return null;
  const newer = prompt.kind === "newer";
  const migrateOnly = prompt.kind === "migrate";
  const { server } = prompt;
  // 版本列同一套技能档版号（项目的标记、Server 提供的、这版 Specseal 带的），一眼比得出谁新谁旧。
  const rows: Array<[string, string]> = [
    [t("assets.dialog.projectVersion"), prompt.projectVersion ?? "—"],
    ...(server ? [[t("assets.dialog.serverVersion"), prompt.version] as [string, string]] : []),
    [t("assets.dialog.appVersion"), server ? server.appVersion : prompt.version],
    [t(newer ? "assets.dialog.revertCount" : "assets.dialog.fileCount"), String(prompt.fileCount)],
  ];
  // remote 项目的过期与缺失另有文案：换上的是 Server 提供的内容，不是「你的 Specseal 这一版」。
  const text = server && (prompt.kind === "stale" || prompt.kind === "missing") ? SERVER_TEXT[prompt.kind] : null;
  const title = text?.title ?? `assets.dialog.${prompt.kind}Title`;
  const desc = text?.desc ?? `assets.dialog.${prompt.kind}Desc`;
  return (
    // 更新进行中不收框（含 Esc）：完成态与错误都要留在框内。
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent data-testid="asset-notice-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertCircle className={cn("h-5 w-5 shrink-0", SEMANTIC_TONE.warning)} />
            {t(title)}
          </AlertDialogTitle>
          <AlertDialogDescription>{t(desc)}</AlertDialogDescription>
        </AlertDialogHeader>
        {!migrateOnly && (
          <Card size="nested" data-testid="asset-notice-rows" className="divide-y divide-border text-[13px]">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="text-muted-foreground">{label}</span>
                <span data-testid="asset-notice-value" className="font-medium tabular-nums">
                  {value}
                </span>
              </div>
            ))}
          </Card>
        )}
        {server?.appOlder && (
          <p data-testid="asset-notice-app-older" className="m-0 text-[13px]">
            {t("assets.dialog.appOlder")}
          </p>
        )}
        {prompt.migration.state !== "none" && <MigrationNote migration={prompt.migration} />}
        {error && (
          <p role="alert" className={cn("m-0 text-[13px]", SEMANTIC_TONE.danger)}>
            {t("assets.errorPrefix")}
            {error}
          </p>
        )}
        <AlertDialogFooter data-testid="asset-notice-actions">
          {!newer && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t("assets.dialog.later")}
            </Button>
          )}
          <AlertDialogCancel disabled={busy} onClick={onDismiss}>
            {t("assets.dialog.keep")}
          </AlertDialogCancel>
          {prompt.kind === "newer" ? (
            <AlertDialogAction onClick={onOpenSettingsUpdate}>{t("assets.dialog.updateApp")}</AlertDialogAction>
          ) : (
            <>
              {server?.appOlder && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    onOpenSettingsUpdate();
                    onOpenChange(false);
                  }}
                >
                  {t("assets.dialog.updateApp")}
                </Button>
              )}
              <Button type="button" disabled={busy} onClick={onApply}>
                {t(APPLY_LABEL[prompt.kind])}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 主动作的文案：过期→更新、缺失→安装、只剩迁移→更新规格文件夹（较新态没有这个键）。 */
const APPLY_LABEL: Record<Exclude<AssetPromptState["kind"], "newer">, string> = {
  stale: "assets.dialog.update",
  missing: "assets.dialog.install",
  migrate: "assets.dialog.migrate",
};

/** remote 项目的标题与说明：基准是 Server 提供的技能。 */
const SERVER_TEXT = {
  stale: { title: "assets.dialog.serverStaleTitle", desc: "assets.dialog.serverStaleDesc" },
  missing: { title: "assets.dialog.missingTitle", desc: "assets.dialog.serverMissingDesc" },
} as const;

/** 按下更新前的迁移说明：会改名什么，或这次为何不改名——暂缓只出现在技能档过期或缺失的
 * 提示里，按更新仍会更新技能档，要讲明文件夹不动。 */
function MigrationNote({ migration }: { migration: Exclude<MigrationProbe, { state: "none" }> }) {
  const { t, tn } = useI18n();
  const lines =
    migration.state === "pending"
      ? [
          ...(migration.folder === "openspec" ? [t("assets.migration.moveFolder")] : []),
          tn("assets.migration.renameFiles", migration.metaFiles),
          t("assets.migration.noCommit"),
        ]
      : [
          t("assets.migration.deferred").replace(
            "{reason}",
            t(`assets.migration.reason.${migration.reason}`)
              .replace("{paths}", migration.worktrees.join("、"))
              .replace("{folder}", migration.folder),
          ),
          t("assets.migration.deferredNote"),
        ];
  return (
    <div data-testid="asset-notice-migration" className="space-y-1 text-[13px]">
      {lines.map((line) => (
        <p key={line} className="m-0">
          {line}
        </p>
      ))}
    </div>
  );
}

/** 迁移完成态：做了什么、要 commit 的路径；文件夹改名时再加两则提醒（与 CLI 相同）。 */
function MigratedDialog({
  open,
  migrated,
  onDone,
}: {
  open: boolean;
  migrated: AssetUpdateResult["migrated"];
  onDone: () => void;
}) {
  const { t, tn } = useI18n();
  const lines = migrated.movedFolder
    ? [
        tn("assets.done.moved", migrated.renamed),
        t("assets.done.commitMove"),
        t("assets.done.teammates"),
        t("assets.done.scripts"),
      ]
    : [tn("assets.done.renamed", migrated.renamed), t("assets.done.commitRenamed")];
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onDone()}>
      <AlertDialogContent data-testid="asset-notice-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("assets.done.title")}</AlertDialogTitle>
          <AlertDialogDescription>{lines[0]}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="m-0 list-disc space-y-1 pl-5 text-[13px]">
          {lines.slice(1).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          {/* 按钮与 Esc 都经 onOpenChange 收框，onDone 只走一次。 */}
          <AlertDialogAction>{t("assets.done.close")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

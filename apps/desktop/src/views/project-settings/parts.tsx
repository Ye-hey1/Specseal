// 项目设置四页共用的片段（desktop-settings-mode design D8）：字段说明、未知值提示、解析失败
// 说明、页标题右侧的编辑／取消／保存与 ⌘S、remote revision 冲突对照卡与页标题下的文件键注记。
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Kbd,
  SEMANTIC_SURFACE,
  SEMANTIC_TONE,
  cn,
  useI18n,
} from "@specseal/ui";

import { detectPlatform, modKey } from "../../platform";
import type { PolicyConflict, ProjectSettingsState } from "./useProjectSettings";

const SAVE_KEY = `${modKey(detectPlatform())}S`;

export function FieldHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground m-0">{children}</p>;
}

/** 选项集外保存值的引导提示（spec 需求「设置页政策下拉的未知值显性呈现」）。 */
export function InvalidLocaleHint({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p data-testid={testId} className={`flex items-start gap-1.5 text-xs m-0 ${SEMANTIC_TONE.warning}`}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      {children}
    </p>
  );
}

export function ParseErrorBanner({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <p role="alert" className={`flex items-start gap-1.5 text-xs m-0 ${SEMANTIC_TONE.danger}`}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <span>
        {t("settings.parseErrorHint")} {message}
      </span>
    </p>
  );
}

/** 编辑态的 ⌘S／Ctrl+S（desktop-settings-editors design D2）：编辑器 keymap 先拦（已
 * preventDefault）；焦点在编辑器外、或编辑器唯读时由这里的窗口层补上。是否真的送出由
 * `onSave`（useProjectSettings 的写入守门）决定。 */
export function useSaveShortcut(editing: boolean, onSave: () => void) {
  const latest = useRef(onSave);
  latest.current = onSave;
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);
}

/** 页标题右侧的编辑／取消／保存（项目说明页与产出规则页共用）；`toggle` 放在取消之前
 * （项目说明的「编辑／预览」切换）。 */
export function CardEditControls({
  editing,
  disabled,
  msg,
  testPrefix,
  toggle,
  onEdit,
  onCancel,
  onSave,
}: {
  editing: boolean;
  disabled: boolean;
  msg: string | null;
  /** data-testid 前缀（context／rules）。 */
  testPrefix: string;
  toggle?: React.ReactNode;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      {editing ? (
        <>
          {toggle}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`${testPrefix}-cancel`}
            disabled={disabled}
            className="text-sm font-normal text-muted-foreground hover:text-foreground"
            onClick={onCancel}
          >
            {t("app.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid={`${testPrefix}-save`}
            disabled={disabled}
            className="text-sm"
            onClick={onSave}
          >
            {t("settings.save")}
            <Kbd variant="inherit">{SAVE_KEY}</Kbd>
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`${testPrefix}-edit`}
          disabled={disabled}
          className="text-sm font-normal text-muted-foreground hover:text-foreground"
          onClick={onEdit}
        >
          {t("settings.edit")}
        </Button>
      )}
    </div>
  );
}

/** remote 409 对照卡：任一页的写入都可能撞冲突，各页顶部都呈现（review R5）。 */
export function ConflictPanel({
  conflict,
  onReload,
  onRetry,
}: {
  conflict: PolicyConflict | null;
  onReload: () => void;
  onRetry: () => Promise<void>;
}) {
  const { t } = useI18n();
  if (conflict === null) return null;
  return (
    <Card
      data-testid="policy-conflict-panel"
      className={cn(SEMANTIC_SURFACE.warning, "bg-muted/20")}
    >
      <CardHeader className="gap-1">
        <CardTitle className="text-base">{t("remote.conflictTitle")}</CardTitle>
        <p className="m-0 text-xs text-muted-foreground">{t("remote.conflictHint")}</p>
        <span
          data-testid="conflict-revision"
          className="font-mono text-xs tracking-wide text-muted-foreground"
        >
          {t("remote.conflictRevision")} {conflict.latest.workflow.revision ?? "—"}
        </span>
      </CardHeader>
      <CardContent className="gap-3">
        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[minmax(96px,0.7fr)_1fr_1fr] gap-px bg-border text-xs">
            <span className="bg-muted px-2 py-1.5 font-medium" />
            <span className="bg-muted px-2 py-1.5 font-medium">
              {t("remote.serverValue")}
            </span>
            <span className="bg-muted px-2 py-1.5 font-medium">
              {t("remote.myInput")}
            </span>
            {conflict.rows.map((row) => (
              <div
                key={row.key}
                data-testid={`conflict-row-${row.key}`}
                className="col-span-3 grid grid-cols-subgrid gap-px"
              >
                <span className="bg-card px-2 py-1.5 font-mono text-muted-foreground">
                  {row.label}
                </span>
                <span
                  data-testid="conflict-server"
                  className="whitespace-pre-wrap break-words bg-card px-2 py-1.5 font-mono"
                >
                  {row.server}
                </span>
                <span
                  data-testid="conflict-mine"
                  className="whitespace-pre-wrap break-words bg-card px-2 py-1.5 font-mono"
                >
                  {row.mine}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            {t("remote.reloadServer")}
          </Button>
          <Button type="button" size="sm" onClick={() => void onRetry()}>
            {t("remote.resubmitLatest")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 页标题下的注记：local 为等宽文件路径与键，remote 为等宽 policy revision（查看者另附角色说明）。 */
export function PageNote({
  remote,
  fileKey,
  testId,
}: {
  remote: ProjectSettingsState["remoteNote"];
  fileKey: string;
  testId: string;
}) {
  const { t } = useI18n();
  if (remote === null) {
    return (
      <span data-testid={testId} className="font-mono">
        {fileKey}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-2">
      <span data-testid="policy-revision" className="font-mono tracking-wide">
        {t("remote.policyRevision")} {remote.revision ?? "—"}
      </span>
      {remote.reader && (
        <span
          data-testid="policy-reader-note"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {t("remote.policyReader")}
        </span>
      )}
    </span>
  );
}

/** 页顶：冲突对照卡＋该页所挂设置档的解析失败说明。 */
export function PageAlerts({ ps, parseError }: { ps: ProjectSettingsState; parseError: string | null }) {
  return (
    <>
      <ConflictPanel conflict={ps.conflict} onReload={ps.reloadServerVersion} onRetry={ps.retryConflict} />
      {parseError !== null && <ParseErrorBanner message={parseError} />}
    </>
  );
}

// 最近打开清单（design D7）：添加项目对话框第一步与零项目空状态共用同一份清单与
// 打开流程；两个 variant 只差外框。
import { useState } from "react";
import { AlertTriangle, Cloud, Folder, X } from "lucide-react";
import { cn, useI18n } from "@specseal/ui";

import type { ConnectionView, ConnectionsAdapter } from "../adapter/connections";
import type { WorkspaceAdapter } from "../adapter/workspace";
import type { RecentEntry } from "../recents";
import { locatorKey } from "../session";

export interface RecentListProps {
  variant: "dialog" | "card";
  /** 已滤掉项目列上开着的项目（visibleRecents）。 */
  entries: RecentEntry[];
  connections: ConnectionView[];
  /** 连接清单是否读取成功——未就绪时 remote 列不得判成「连接已移除／已注销」。 */
  connectionsReady: boolean;
  /** 点击打开失败的错误（locator key → 原因）。 */
  errors: Record<string, string>;
  busy?: boolean;
  onOpen: (entry: RecentEntry) => void;
  onRemove: (entry: RecentEntry) => void;
}

export function RecentList({
  variant,
  entries,
  connections,
  connectionsReady,
  errors,
  busy = false,
  onOpen,
  onRemove,
}: RecentListProps) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <section
      data-recent-list={variant}
      className={cn("flex flex-col gap-2", variant === "card" && "rounded-xl border border-border bg-card p-4")}
    >
      <p className="m-0 flex items-baseline gap-1.5 text-sm font-medium">
        <span>{t("recent.title")}</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">{entries.length}</span>
      </p>
      <div
        data-recent-rows
        className={cn(
          "flex max-h-[240px] flex-col divide-y divide-border overflow-y-auto",
          variant === "dialog" && "rounded-xl border border-border",
        )}
      >
        {entries.map((entry) => {
          const key = locatorKey(entry.locator);
          const connectionId = entry.locator.kind === "remote" ? entry.locator.connectionId : null;
          const connection = connectionId ? connections.find((c) => c.id === connectionId) : null;
          // 连接清单加载完成前不下判断；加载后才分「已移除」与「已注销」。
          const connectionReason =
            connectionId && connectionsReady
              ? !connection
                ? t("chooser.recentConnectionMissing")
                : !connection.loggedIn
                  ? t("chooser.recentConnectionLoggedOut")
                  : null
              : null;
          const reason = errors[key] ?? connectionReason;
          const subtitle =
            entry.locator.kind === "local" ? entry.locator.root : (connection?.name ?? null);
          return (
            <div
              key={key}
              className={cn(
                "group flex items-start gap-1 px-3 py-2 transition-colors",
                // 打开进行中各列的打开钮停用：外层不给 hover 底色（× 移除钮仍可用，滑过整列时照常浮现）。
                reason ? "bg-destructive/5" : !busy && "hover:bg-foreground/5",
              )}
            >
              {/* 打开失败的错误态仍可再点重试；连接已移除／已注销才停用。 */}
              <button
                type="button"
                disabled={busy || Boolean(connectionReason)}
                onClick={() => onOpen(entry)}
                className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  {reason ? (
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  ) : entry.locator.kind === "local" ? (
                    <Folder className="h-4 w-4" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
                    {entry.locator.kind === "remote" && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                        {t("chooser.remoteTag")}
                      </span>
                    )}
                  </span>
                  {subtitle && (
                    <span
                      className={cn(
                        "block truncate text-xs text-muted-foreground",
                        entry.locator.kind === "local" && "font-mono",
                      )}
                    >
                      {subtitle}
                    </span>
                  )}
                  {reason && <span className="block text-xs text-destructive">{reason}</span>}
                </span>
              </button>
              <button
                type="button"
                aria-label={`${t("chooser.recentRemove")} ${entry.name}`}
                onClick={() => onRemove(entry)}
                className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 本机打开动作（store 的 openProjectAt）：EmptyWorkspace、WorkspaceChooser 与这里共用的
 * prop 类型；三者都不读回传值。 */
export type OpenLocal = (path: string) => Promise<unknown>;

/** 最近打开条目的打开流程（design D4）：本机先探测再沿既有打开流程（分流由
 * openProjectAt 承担）；remote 以原 connection／scope／checkout 走既有 remote 打开。
 * 失败只标记该列——错误态只活在调用端画面，重试或 reset 即清。 */
export function useRecentOpener({
  workspace,
  connections,
  connectionAdapter,
  onRefreshConnections,
  onOpenLocal,
  onOpenRemote,
  onLocalProbed,
}: {
  workspace: Pick<WorkspaceAdapter, "openProject">;
  connections: ConnectionView[];
  connectionAdapter: Pick<ConnectionsAdapter, "inspectCheckout">;
  /** 重整连接清单；回传读取是否成功（成功才判定 remote 列的连接错误态）。 */
  onRefreshConnections: () => Promise<boolean>;
  onOpenLocal: OpenLocal;
  onOpenRemote: (connectionId: string, target: string, checkoutRoot?: string) => Promise<void>;
  /** 本机探测成功、交给打开流程之前（对话框于此关闭自己）。 */
  onLocalProbed?: () => void;
}) {
  const { t } = useI18n();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /** 连接清单是否读取成功——加载中或读取失败时，remote 列都不得判成
   * 「连接已移除」：清单初值是空数组，读取失败又保留现值，先判断会把有效
   * 条目误标成已移除且停用打开。 */
  const [connectionsReady, setConnectionsReady] = useState(false);

  async function refreshConnections() {
    setConnectionsReady(await onRefreshConnections().catch(() => false));
  }

  /** 重新进入（对话框重开、空状态出现）：清错误态、重读连接清单。 */
  function reset() {
    setErrors({});
    setConnectionsReady(false);
    void refreshConnections();
  }

  async function open(entry: RecentEntry) {
    const key = locatorKey(entry.locator);
    setErrors(({ [key]: _retried, ...rest }) => rest);
    setBusy(true);
    try {
      if (entry.locator.kind === "local") {
        await workspace.openProject(entry.locator.root);
        onLocalProbed?.();
        await onOpenLocal(entry.locator.root);
      } else {
        const { connectionId, projectId, repoId, checkoutRoot } = entry.locator;
        // 绑着 checkout 的条目先验文件夹仍与该 scope 一致（与其他 checkout 打开
        // 路径同一步）——handshake 只问服务器，不会发现文件夹已消失。这一步要
        // connection 的 origin；规格模式（无 checkout 绑定）只需 connectionId，
        // 不得因清单未就绪而被挡下。
        if (checkoutRoot) {
          const connection = connections.find((c) => c.id === connectionId);
          if (!connection) {
            // 清单未就绪时列仍是激活的——此处补判，理由与就绪后的列同一句纯文本。
            setErrors((prev) => ({ ...prev, [key]: t("chooser.recentConnectionMissing") }));
            return;
          }
          await connectionAdapter.inspectCheckout(checkoutRoot, connection.origin, projectId, repoId);
        }
        await onOpenRemote(connectionId, `${projectId}/${repoId}`, checkoutRoot);
      }
    } catch (reason) {
      setErrors((prev) => ({ ...prev, [key]: String(reason) }));
    } finally {
      setBusy(false);
    }
  }

  return { errors, busy, connectionsReady, open, reset, refreshConnections };
}

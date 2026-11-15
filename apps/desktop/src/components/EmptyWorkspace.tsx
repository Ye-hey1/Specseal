// 零项目空状态（design D7）：字标、标题、说明、「添加项目」与「连接 Server」、
// 最近打开卡（与添加项目对话框同一份清单与打开流程）、底部 CLI 提示。
import { useEffect } from "react";
import { Cloud, FolderOpen } from "lucide-react";
import { Button, Wordmark, useI18n } from "@specseal/ui";

import type { ConnectionView, ConnectionsAdapter } from "../adapter/connections";
import type { WorkspaceAdapter } from "../adapter/workspace";
import type { RecentEntry } from "../recents";
import { locatorKey } from "../session";
import type { WorkspaceChooserIntent } from "../store";
import { RecentList, useRecentOpener, type OpenLocal } from "./RecentList";

export interface EmptyWorkspaceProps {
  /** 已滤掉项目列上开着的项目（零项目时即全部记录）。 */
  recents: RecentEntry[];
  connections: ConnectionView[];
  /** 重整连接清单；回传读取是否成功（成功才判定 remote 列的连接错误态）。 */
  onRefreshConnections: () => Promise<boolean>;
  workspace: Pick<WorkspaceAdapter, "openProject">;
  connectionAdapter: Pick<ConnectionsAdapter, "inspectCheckout">;
  onOpenLocal: OpenLocal;
  onOpenRemote: (connectionId: string, target: string, checkoutRoot?: string) => Promise<void>;
  onRemoveRecent: (key: string) => void;
  onOpenChooser: (intent?: WorkspaceChooserIntent) => void;
}

export function EmptyWorkspace({
  recents,
  connections,
  onRefreshConnections,
  workspace,
  connectionAdapter,
  onOpenLocal,
  onOpenRemote,
  onRemoveRecent,
  onOpenChooser,
}: EmptyWorkspaceProps) {
  const { t } = useI18n();
  const recent = useRecentOpener({
    workspace,
    connections,
    connectionAdapter,
    onRefreshConnections,
    onOpenLocal,
    onOpenRemote,
  });
  useEffect(() => {
    // 挂载时读一次连接清单；之后的连接变动由 store 推进 connections。
    recent.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto">
      <div className="flex w-[420px] max-w-full flex-col gap-4">
        <Wordmark className="h-10 self-start" />
        <div>
          <h2 className="text-2xl font-normal">{t("app.emptyTitle")}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("app.emptyDesc")}</p>
        </div>
        <div className="flex gap-2">
          <Button className="gap-1.5" onClick={() => onOpenChooser()}>
            <FolderOpen className="h-4 w-4" /> {t("app.newProject")}
          </Button>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => onOpenChooser({ initialStep: "server" })}
          >
            <Cloud className="h-4 w-4" /> {t("app.connectServer")}
          </Button>
        </div>
        <RecentList
          variant="card"
          entries={recents}
          connections={connections}
          connectionsReady={recent.connectionsReady}
          errors={recent.errors}
          busy={recent.busy}
          onOpen={(entry) => void recent.open(entry)}
          onRemove={(entry) => onRemoveRecent(locatorKey(entry.locator))}
        />
        <p className="text-xs text-muted-foreground">{t("app.emptyCli")}</p>
      </div>
    </div>
  );
}

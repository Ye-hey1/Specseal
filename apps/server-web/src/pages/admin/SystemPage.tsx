import { useState } from "react";
import { Compass, Database, Download, Server, TriangleAlert } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  SettingsCard,
  SettingsRow,
  StatusPill,
  useI18n,
  PageHeader,
} from "@specseal/ui";
import { useClient } from "../../app/context";
import { useAsync } from "../../lib/useAsync";
import { CardNote } from "../../components/CardNote";
import { useTour } from "../../components/Tour";
import { AdminError, AdminLoading } from "./states";

// 系统页（server-web-console「数据操作目的地已并入系统」；server-web-list-pages design D10）：
// 原「数据操作」与「系统状态」合并为一个目的地与一份 view model。768px 置中栏，四张设置型卡——
// 运行环境、保存状态、导出、危险区，各值为卡内的列。取得失败时整页呈现错误与重试，不部分渲染：
// 保存后端的健康状态在整个接口只该有一处权威来源，半份数据比没有数据更容易误导。

/** 列右侧的等宽值。 */
function Mono({ children }: { children: string | number }) {
  return <span className="break-all font-mono text-[13px]">{children}</span>;
}

export function SystemPage() {
  const { t } = useI18n();
  const client = useClient();
  const { loading, data, error, reload } = useAsync(() => client.getAdminSystem(), []);
  const [confirmMigrate, setConfirmMigrate] = useState(false);
  const [busy, setBusy] = useState(false);
  const { restart: restartTour } = useTour();

  async function runMigrate() {
    if (busy) return;
    setBusy(true);
    try {
      await client.adminMigrate();
    } finally {
      setBusy(false);
      setConfirmMigrate(false);
      reload();
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6">
      {/* 导览的重新启动入口。放在系统页而非各列表页：它是「设置与维运」性质的动作，
          不是任何列表的 primary action。 */}
      <PageHeader
        level={1}
        title={t("system.title")}
        description={t("system.description")}
        actions={
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={restartTour}>
            <Compass aria-hidden="true" className="h-4 w-4" />
            {t("tour.restart")}
          </Button>
        }
      />
      {loading && <AdminLoading />}
      {error != null && <AdminError onRetry={reload} />}
      {data && (
        <>
          <SettingsCard title={t("system.runtime")} icon={<Server />}>
            <SettingsRow label={t("system.engineVersion")} control={<Mono>{data.engineVersion}</Mono>} />
            <SettingsRow label={t("system.apiVersion")} control={<Mono>{data.apiVersion}</Mono>} />
            <SettingsRow
              label={t("system.schemaVersion")}
              control={<Mono>{data.identitySchemaVersion ?? t("common.dash")}</Mono>}
            />
            <SettingsRow label={t("system.storeDriver")} control={<Mono>{data.storeDriver}</Mono>} />
            <SettingsRow label={t("system.contractVersion")} control={<Mono>{data.storeContractVersion}</Mono>} />
            <SettingsRow label={t("system.storeLevel")} control={<Mono>{data.storeLevel}</Mono>} />
            <SettingsRow
              label={t("system.storeCapabilities")}
              control={<Mono>{data.storeCapabilities.join("、") || t("common.dash")}</Mono>}
            />
          </SettingsCard>

          <SettingsCard title={t("system.storage")} icon={<Database />}>
            <SettingsRow
              label={t("system.storeDriver")}
              description={data.storeHealthy ? undefined : data.storeHealthError}
              control={
                <StatusPill tone={data.storeHealthy ? "success" : "destructive"}>
                  {data.storeHealthy ? t("common.normal") : t("common.abnormal")}
                </StatusPill>
              }
            />
            {data.outboxBacklogs.length === 0 ? (
              <CardNote>{t("system.noBacklog")}</CardNote>
            ) : (
              data.outboxBacklogs.map((b) => (
                <SettingsRow
                  key={`${b.project}/${b.repo}`}
                  label={<span className="font-mono">{`${b.project}/${b.repo}`}</span>}
                  description={t("system.colBacklog")}
                  control={<span className="tabular-nums">{b.backlog ?? t("common.dash")}</span>}
                />
              ))
            )}
          </SettingsCard>

          <SettingsCard title={t("system.export")} icon={<Download />}>
            {data.scopes.length === 0 ? (
              <CardNote>{t("system.noScopes")}</CardNote>
            ) : (
              data.scopes.map((s) => (
                <SettingsRow
                  key={`${s.project}/${s.repo}`}
                  label={<span className="font-mono">{`${s.project}/${s.repo}`}</span>}
                  control={
                    // 文件下载用原生 <a href>，不是 router Link。
                    <Button asChild variant="outline" size="sm" className="gap-1.5">
                      <a
                        href={s.exportPath}
                        aria-label={t("system.exportScope").replace("{scope}", `${s.project}/${s.repo}`)}
                      >
                        <Download aria-hidden="true" className="h-3.5 w-3.5" />
                        {t("system.download")}
                      </a>
                    </Button>
                  }
                />
              ))
            )}
          </SettingsCard>

          <SettingsCard title={t("system.danger")} icon={<TriangleAlert className="text-destructive" />}>
            <SettingsRow
              label={t("system.migrate")}
              description={`${t("system.migrateWarning")}${data.migrateAvailable ? "" : t("system.migrateUnavailable")}`}
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !data.migrateAvailable}
                  onClick={() => setConfirmMigrate(true)}
                >
                  {t("system.migrateAction")}
                </Button>
              }
            />
          </SettingsCard>
        </>
      )}

      <ConfirmDialog
        open={confirmMigrate}
        onOpenChange={(open) => !open && setConfirmMigrate(false)}
        title={t("system.migrateConfirm")}
        description={t("system.migrateWarning")}
        confirmLabel={t("system.migrateAction")}
        busy={busy}
        onConfirm={runMigrate}
      />
    </div>
  );
}

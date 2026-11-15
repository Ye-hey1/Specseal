// 服务器页（desktop-settings-mode design D7；spec「服务器管理最小面」）：页标题右侧「添加连接」
// 切换页顶添加卡；连接卡（ServersPanel）；缺省卡（添加远程项目时缺省使用的连接）；登录方式卡（三列说明）。
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  SettingsCard,
  SettingsChoice,
  SettingsPageHeader,
  SettingsRow,
  useI18n,
} from "@specseal/ui";

import { defaultConnectionOf } from "../../adapter/connections";
import { ServersPanel, type ServersPanelProps } from "../../components/ServersPanel";

/** 「不预选」在偏好里是 null，Radix Select 的值不接受空值：以哨兵值往返。 */
const NO_DEFAULT = "__none__";

export interface ServersPageProps extends Omit<ServersPanelProps, "addOpen" | "onAddOpenChange"> {
  /** 添加远程项目时缺省使用的连接（null＝不预选）。 */
  defaultConnectionId: string | null;
  onDefaultConnectionChange: (connectionId: string | null) => void;
}

export function ServersPage({ defaultConnectionId, onDefaultConnectionChange, ...panel }: ServersPageProps) {
  const { t } = useI18n();
  const [addOpen, setAddOpen] = useState(false);
  const loggedIn = panel.connections.filter((c) => c.loggedIn);
  // 指向的连接已注销或被移除：视同不预选（添加项目对话框同样忽略它）。
  const defaultValue = defaultConnectionOf(panel.connections, defaultConnectionId)?.id ?? NO_DEFAULT;
  const defaultLabel = t("servers.page.defaultForNew");
  return (
    <>
      <SettingsPageHeader
        title={t("settings.section.servers")}
        description={t("servers.help")}
        actions={
          <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen((open) => !open)}>
            <Plus className="h-3.5 w-3.5" />
            {t("servers.page.addConnection")}
          </Button>
        }
      />
      <ServersPanel {...panel} addOpen={addOpen} onAddOpenChange={setAddOpen} />
      <SettingsCard title={t("servers.page.defaultsCard")}>
        <SettingsRow
          label={defaultLabel}
          control={
            <SettingsChoice
              ariaLabel={defaultLabel}
              value={defaultValue}
              options={[
                { value: NO_DEFAULT, label: t("servers.page.noDefault") },
                ...loggedIn.map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(v) => onDefaultConnectionChange(v === NO_DEFAULT ? null : v)}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title={t("servers.page.loginCard")}>
        <SettingsRow
          label={t("servers.page.browserLogin")}
          description={t("servers.page.browserLoginHint")}
          control={<span className="text-xs text-muted-foreground">{t("servers.page.isPreferred")}</span>}
        />
        <SettingsRow label={t("servers.page.deviceLogin")} description={t("servers.page.deviceLoginHint")} control={null} />
        <SettingsRow label={t("servers.page.pat")} description={t("servers.page.patHint")} control={null} />
      </SettingsCard>
    </>
  );
}

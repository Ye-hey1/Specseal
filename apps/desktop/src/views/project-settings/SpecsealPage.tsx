// AI 工具页（desktop-settings-mode design D8；spec「设置页图形化读写两层设置」）：读写 .specseal.yaml
// 的 tools——「AI 工具」卡里内置工具每个一列附开关，自订工具描述子为不可编辑列。文件名只在页标题下
// 的等宽注记。remote 项目没有这一页（tools 属本机 checkout 概念）。
import {
  Button,
  SettingsCard,
  SettingsPageHeader,
  SettingsRow,
  Switch,
  useI18n,
} from "@specseal/ui";

import { BUILTIN_TOOLS } from "../../builtinTools";
import { PageAlerts } from "./parts";
import type { ProjectSettingsState } from "./useProjectSettings";

export function SpecsealPage({ ps }: { ps: ProjectSettingsState }) {
  const { t } = useI18n();
  return (
    <>
      <SettingsPageHeader
        title={t("settings.projectSection.specseal")}
        description={t("settings.specsealPageDesc")}
        note={
          <span data-testid="file-note-specseal" className="font-mono">
            .specseal.yaml · tools
          </span>
        }
      />
      <PageAlerts ps={ps} parseError={ps.snap.app.parseError} />
      <div data-testid="tools-card">
        <SettingsCard title={t("settings.toolsLabel")}>
          {BUILTIN_TOOLS.map((tool) => (
            <SettingsRow
              key={tool}
              label={tool}
              htmlFor={`tool-${tool}`}
              control={
                <Switch
                  id={`tool-${tool}`}
                  checked={ps.tools.includes(tool)}
                  disabled={ps.appDisabled}
                  onCheckedChange={(on) => ps.toggleTool(tool, on)}
                />
              }
            />
          ))}
          {ps.snap.app.customTools.map((name) => (
            <SettingsRow
              key={name}
              label={name}
              description={t("settings.customToolsLabel")}
              control={<span className="text-xs text-muted-foreground">{t("settings.readOnly")}</span>}
            />
          ))}
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <span className="mr-auto text-xs text-muted-foreground">{ps.appMsg ?? t("settings.toolsHelp")}</span>
            <Button type="button" size="sm" data-testid="save-app" disabled={ps.appDisabled} onClick={() => void ps.saveApp()}>
              {t("settings.save")}
            </Button>
          </div>
        </SettingsCard>
      </div>
    </>
  );
}

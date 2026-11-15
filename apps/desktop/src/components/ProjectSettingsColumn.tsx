// 项目设置分类栏（desktop-settings-mode design D2）：项目设置模式下取代项目栏——「工作流程」组
// （上层分类「品质关卡」底下有审查规则、子代理模型两个子项）与「项目」组 AI 工具（远程项目无此组）。
// 组名与分类名一律是概念名，与应用程序设置相同；设置档路径只在各页标题下的注记。解析失败的档所挂
// 分类项带警示点（上层分类没有自己的页，不挂）。底部 notice 槽放技能档提示卡（提示跨页常驻，项目
// 设置页也在）。
import type { ReactNode } from "react";
import { NavItem, SEMANTIC_TONE, SettingsGroupHeader, cn, useI18n } from "@specseal/ui";

import {
  PROJECT_SETTINGS_CATEGORIES,
  QUALITY_PARENT,
  type ProjectSettingsCategory,
  type ProjectSettingsSection,
} from "../settingsCatalog";

/** 分类项的解析失败警示点。 */
function WarningDot() {
  return (
    <span
      data-testid="tab-warning"
      aria-hidden="true"
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current", SEMANTIC_TONE.warning)}
    />
  );
}

export function ProjectSettingsColumn({
  section,
  remote,
  configParseError,
  specsealParseError,
  onSelect,
  notice,
}: {
  section: ProjectSettingsSection;
  remote: boolean;
  /** 工作流设置档解析失败：「工作流程」组的分类项与子项带警示点。 */
  configParseError: boolean;
  /** .specseal.yaml 解析失败：AI 工具项带警示点。 */
  specsealParseError: boolean;
  onSelect: (section: ProjectSettingsSection) => void;
  /** 底部提示卡（null＝无）。 */
  notice?: ReactNode;
}) {
  const { t } = useI18n();
  const groups = [
    { group: "config", label: t("settings.group.workflow"), parseError: configParseError },
    { group: "project", label: t("settings.group.project"), parseError: specsealParseError },
  ] as const;
  return (
    <nav aria-label={t("settings.projectColumnLabel")} className="flex w-[200px] shrink-0 flex-col gap-0.5 p-2 pb-3">
      {groups.map(({ group, label, parseError }) => {
        const items = PROJECT_SETTINGS_CATEGORIES.filter((c) => c.group === group && (c.remote || !remote));
        if (items.length === 0) return null;
        const item = ({ id, labelKey, icon: Icon, parent }: ProjectSettingsCategory) => (
          <NavItem
            key={id}
            variant={parent ? "sub" : "default"}
            icon={Icon && <Icon />}
            label={t(labelKey)}
            active={section === id}
            badge={parseError ? <WarningDot /> : undefined}
            onClick={() => onSelect(id)}
          />
        );
        return (
          <div key={group} className="flex flex-col gap-0.5 pb-2">
            <div className="pb-1 pt-1">
              <SettingsGroupHeader label={label} />
            </div>
            {items.map((category, index) => {
              if (!category.parent) return item(category);
              // 子项在目录里相邻：第一个子项带出上层分类与整组子项，其余略过。
              if (items[index - 1]?.parent === category.parent) return null;
              const parentLabel = t(QUALITY_PARENT.labelKey);
              return (
                <div key={category.parent} role="group" aria-label={parentLabel} className="flex flex-col gap-0.5">
                  <NavItem icon={<QUALITY_PARENT.icon />} label={parentLabel} onClick={() => onSelect(QUALITY_PARENT.opens)} />
                  {items.filter((c) => c.parent === category.parent).map(item)}
                </div>
              );
            })}
          </div>
        );
      })}
      {notice && <div className="mt-auto">{notice}</div>}
    </nav>
  );
}

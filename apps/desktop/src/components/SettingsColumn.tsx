// 设置分类栏（desktop-settings-mode design D2；desktop-about-page design D4）：设置模式下取代
// 项目栏——顶部全圆搜索框，其下「应用程序」群组五个分类与「关于」群组；搜索以分类名与各页
// 列标签过滤，只过滤分类、不跳到列，没有命中的群组连标题一起隐藏。
import { useState } from "react";
import { NavItem, SearchField, SettingsGroupHeader, useI18n } from "@specseal/ui";

import { matchAppSettings, type AppSettingsCategory, type SettingsSection } from "../settingsCatalog";

const GROUPS: { id: AppSettingsCategory["group"]; labelKey: string }[] = [
  { id: "app", labelKey: "settings.group.app" },
  { id: "about", labelKey: "settings.group.about" },
];

export function SettingsColumn({
  section,
  onSelect,
}: {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const categories = matchAppSettings(query, t);
  return (
    <nav aria-label={t("settings.columnLabel")} className="flex w-[200px] shrink-0 flex-col gap-0.5 p-2 pb-3">
      <div className="pb-2">
        <SearchField value={query} onChange={setQuery} placeholder={t("settings.searchPlaceholder")} />
      </div>
      {GROUPS.map((group) => ({ ...group, items: categories.filter((category) => category.group === group.id) }))
        .filter((group) => group.items.length > 0)
        .map((group, index) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            <div className={index === 0 ? "pb-1" : "pb-1 pt-3"}>
              <SettingsGroupHeader label={t(group.labelKey)} />
            </div>
            {group.items.map(({ id, labelKey, icon: Icon }) => (
              <NavItem
                key={id}
                icon={<Icon />}
                label={t(labelKey)}
                active={section === id}
                onClick={() => onSelect(id)}
              />
            ))}
          </div>
        ))}
      {categories.length === 0 && (
        <p className="m-0 px-2.5 py-1.5 text-xs text-muted-foreground">{t("settings.noMatch")}</p>
      )}
    </nav>
  );
}

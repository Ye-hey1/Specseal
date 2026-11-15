// 设置分类目录（desktop-settings-mode design D1）：应用程序设置与项目设置两种分类栏的单一来源。
// 应用程序分类带各页列标签的 i18n 键——分类栏搜索以分类名与这些列标签做大小写不敏感比对。
import {
  Bot,
  FileText,
  Info,
  ListChecks,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_SPEC_DIR } from "@specseal/ui";

export interface AppSettingsCategory {
  id: "general" | "updates" | "cli" | "servers" | "about";
  labelKey: string;
  icon: LucideIcon;
  /** app＝「应用程序」群组；about＝其后的「关于」群组（desktop-about-page design D4）。 */
  group: "app" | "about";
  /** 该页各列标签的 i18n 键。 */
  rows: string[];
}

export interface ProjectSettingsCategory {
  id: "context" | "rules" | "review" | "subagent" | "workflow" | "specseal";
  labelKey: string;
  /** 子项（带 parent）不渲染图标，不给。 */
  icon?: LucideIcon;
  /** config＝「工作流程」组（规格文件夹的 config.yaml）；project＝「项目」组（.specseal.yaml）。 */
  group: "config" | "project";
  /** 远程项目是否呈现（.specseal.yaml 属本机 checkout，远程无此分类）。 */
  remote: boolean;
  /** 属于上层分类「品质关卡」（QUALITY_PARENT）的子项；子项在目录里相邻。 */
  parent?: "quality";
}

/** 上层分类「品质关卡」（目前唯一的上层分类）：没有自己的页，点了开 `opens` 那页。 */
export const QUALITY_PARENT: { labelKey: string; icon: LucideIcon; opens: ProjectSettingsCategory["id"] } = {
  labelKey: "settings.projectSection.quality",
  icon: ShieldCheck,
  opens: "review",
};

/** 工作流设置档的项目根相对路径（desktop-spec-dir-migration D4）：项目设置各页的文件注记由它
 * 组成；快照没带规格文件夹（远程、尚未加载）时用缺省 specseal。 */
export function workflowConfigFile(specDir: string | undefined): string {
  return `${specDir ?? DEFAULT_SPEC_DIR}/config.yaml`;
}

export type SettingsSection = AppSettingsCategory["id"];
export type ProjectSettingsSection = ProjectSettingsCategory["id"];

export const APP_SETTINGS_CATEGORIES: AppSettingsCategory[] = [
  {
    id: "general",
    labelKey: "settings.section.general",
    icon: Settings2,
    group: "app",
    rows: ["settings.displayLanguage", "settings.appearance", "settings.shortcutsTitle"],
  },
  {
    id: "updates",
    labelKey: "settings.section.updates",
    icon: RefreshCw,
    group: "app",
    rows: [
      "updater.check",
      "updater.currentVersion",
      "updater.page.latest",
      "releaseNotes.open",
      "updater.page.autoCheck",
    ],
  },
  {
    id: "cli",
    labelKey: "settings.section.cli",
    icon: SquareTerminal,
    group: "app",
    rows: ["cliInstall.rowLabel", "cli.page.deployDir"],
  },
  {
    id: "servers",
    labelKey: "settings.section.servers",
    icon: Server,
    group: "app",
    rows: [
      "servers.page.addConnection",
      "servers.page.connectionsCard",
      "servers.page.defaultForNew",
      "servers.page.browserLogin",
      "servers.page.deviceLogin",
      "servers.page.pat",
    ],
  },
  {
    id: "about",
    labelKey: "settings.section.about",
    icon: Info,
    group: "about",
    rows: [
      "about.copyInfo",
      "about.source",
      "about.docs",
      "about.report",
      "about.license",
      "about.thirdParty",
    ],
  },
];

export const PROJECT_SETTINGS_CATEGORIES: ProjectSettingsCategory[] = [
  { id: "context", labelKey: "settings.projectSection.context", icon: FileText, group: "config", remote: true },
  { id: "rules", labelKey: "settings.projectSection.rules", icon: ListChecks, group: "config", remote: true },
  { id: "review", labelKey: "settings.projectSection.review", group: "config", remote: true, parent: "quality" },
  { id: "subagent", labelKey: "settings.projectSection.subagent", group: "config", remote: true, parent: "quality" },
  { id: "workflow", labelKey: "settings.projectSection.workflow", icon: Workflow, group: "config", remote: true },
  { id: "specseal", labelKey: "settings.projectSection.specseal", icon: Bot, group: "project", remote: false },
];

/** 面包屑在「项目设置」之后的段：子项的页为 [上层分类（点了开 `opens`）, 页名]，其他页为 [页名]。 */
export function projectSettingsTrail(
  section: ProjectSettingsSection,
): Array<{ labelKey: string; opens?: ProjectSettingsSection }> {
  const category = PROJECT_SETTINGS_CATEGORIES.find((c) => c.id === section)!;
  const page = { labelKey: category.labelKey };
  return category.parent ? [QUALITY_PARENT, page] : [page];
}

/** 分类栏搜索：分类名或任一列标签含查找字符串（大小写不敏感）；空查找全数保留。 */
export function matchAppSettings(
  query: string,
  t: (key: string) => string,
): AppSettingsCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return APP_SETTINGS_CATEGORIES;
  return APP_SETTINGS_CATEGORIES.filter((category) =>
    [category.labelKey, ...category.rows].some((key) => t(key).toLowerCase().includes(q)),
  );
}

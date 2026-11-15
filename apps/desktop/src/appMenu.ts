// macOS 原生菜单列（desktop-native-menu design D1–D3）：与系统匣同一机制——文案取自
// i18n 字典、语言或「有无项目」改变时整个重建。分两层：buildAppMenuModel 是纯函数
// （直测）；installAppMenu 以 Tauri 菜单 API 建出并设为 app 菜单。
import {
  Menu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
  type SubmenuOptions,
} from "@tauri-apps/api/menu";

import type { Platform } from "./platform";

/** 自订菜单项的动作 id：App 依此派发到 store 既有动作或 window 事件。 */
export type AppMenuAction =
  | "about"
  | "checkUpdates"
  | "settings"
  | "openProject"
  | "closeProject"
  | "installCli"
  | "viewBoard"
  | "viewArchived"
  | "viewSpecs"
  | "viewManual"
  | "viewProjectSettings"
  | "focusSearch"
  | "refresh"
  | "nextProject"
  | "bringAllToFront"
  | "helpManual"
  | "releaseNotes"
  | "github"
  | "reportIssue";

/** 系统缺省项：行为与快捷键由系统提供（Tauri 的 predefined 项不接受 accelerator）。 */
export type AppMenuPredefined =
  | "Services"
  | "Hide"
  | "HideOthers"
  | "ShowAll"
  | "Quit"
  | "Undo"
  | "Redo"
  | "Cut"
  | "Copy"
  | "Paste"
  | "SelectAll"
  | "Minimize"
  | "Maximize";

export type AppMenuEntry =
  | { kind: "item"; id: AppMenuAction; text: string; accelerator?: string; enabled: boolean }
  | { kind: "predefined"; item: AppMenuPredefined; text?: string }
  | { kind: "separator" };

export interface AppMenuGroup {
  id: "app" | "file" | "edit" | "view" | "window" | "help";
  text: string;
  items: AppMenuEntry[];
}

export type AppMenuModel = AppMenuGroup[];

/** 菜单模型（design D2）：没有作用中项目时，关闭项目、查看组全部与说明的手册停用。 */
export function buildAppMenuModel({
  t,
  hasProject,
}: {
  t: (key: string) => string;
  hasProject: boolean;
}): AppMenuModel {
  const item = (
    id: AppMenuAction,
    key: string,
    accelerator?: string,
    enabled = true,
  ): AppMenuEntry => ({ kind: "item", id, text: t(key), accelerator, enabled });
  const predefined = (name: AppMenuPredefined, key?: string): AppMenuEntry => ({
    kind: "predefined",
    item: name,
    text: key === undefined ? undefined : t(key),
  });
  const separator: AppMenuEntry = { kind: "separator" };
  return [
    {
      id: "app",
      text: "Specseal",
      items: [
        item("about", "menu.app.about"),
        item("checkUpdates", "menu.app.checkUpdates"),
        separator,
        item("settings", "menu.app.settings", "CmdOrCtrl+,"),
        separator,
        predefined("Services"),
        separator,
        predefined("Hide", "menu.app.hide"),
        predefined("HideOthers", "menu.app.hideOthers"),
        predefined("ShowAll", "menu.app.showAll"),
        separator,
        predefined("Quit", "menu.app.quit"),
      ],
    },
    {
      id: "file",
      text: t("menu.file.title"),
      items: [
        item("openProject", "menu.file.openProject", "Cmd+O"),
        item("closeProject", "menu.file.closeProject", "Cmd+W", hasProject),
        separator,
        item("installCli", "menu.file.installCli"),
      ],
    },
    {
      id: "edit",
      text: t("menu.edit.title"),
      items: [
        predefined("Undo", "menu.edit.undo"),
        predefined("Redo", "menu.edit.redo"),
        separator,
        predefined("Cut", "menu.edit.cut"),
        predefined("Copy", "menu.edit.copy"),
        predefined("Paste", "menu.edit.paste"),
        predefined("SelectAll", "menu.edit.selectAll"),
      ],
    },
    {
      id: "view",
      text: t("menu.view.title"),
      items: [
        item("viewBoard", "menu.view.board", "Cmd+1", hasProject),
        item("viewArchived", "menu.view.archived", "Cmd+2", hasProject),
        item("viewSpecs", "menu.view.specs", "Cmd+3", hasProject),
        item("viewManual", "menu.view.manual", "Cmd+4", hasProject),
        item("viewProjectSettings", "menu.view.projectSettings", undefined, hasProject),
        separator,
        item("focusSearch", "menu.view.search", "Cmd+F", hasProject),
        item("refresh", "menu.view.refresh", "Cmd+R", hasProject),
        separator,
        item("nextProject", "menu.view.nextProject", "Ctrl+Tab", hasProject),
      ],
    },
    {
      id: "window",
      text: t("menu.window.title"),
      items: [
        predefined("Minimize", "menu.window.minimize"),
        predefined("Maximize", "menu.window.zoom"),
        separator,
        item("bringAllToFront", "menu.window.bringAllToFront"),
      ],
    },
    {
      id: "help",
      text: t("menu.help.title"),
      items: [
        item("helpManual", "menu.help.manual", undefined, hasProject),
        item("releaseNotes", "menu.help.releaseNotes"),
        separator,
        item("github", "menu.help.github"),
        item("reportIssue", "menu.help.reportIssue"),
      ],
    },
  ];
}

/** 设置页「键盘快捷键」卡的一列（design D5）。 */
export interface ShortcutRow {
  id: AppMenuAction | "gotoProject";
  text: string;
  keys: string;
}

const MODIFIER_SYMBOLS: Record<string, string> = { Cmd: "⌘", CmdOrCtrl: "⌘", Ctrl: "⌃" };

/** 菜单 accelerator 转成 macOS 按键符号：`CmdOrCtrl+,` → `⌘,`、`Ctrl+Tab` → `⌃Tab`。 */
function formatAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => MODIFIER_SYMBOLS[part] ?? part)
    .join("");
}

/**
 * 设置页「键盘快捷键」卡的列表（design D5），只列实际生效的快捷键。macOS 由菜单模型导出，
 * 卡片与菜单只有一份定义；Windows／Linux 没有菜单列，五列对应 App.tsx 的 keydown（Ctrl+W、
 * Ctrl+R、Ctrl+Tab、Ctrl+1–9）与 BoardSearchBar 的 Ctrl+F——改那两处的按键时要同批改这里。
 */
export function buildShortcutList({
  t,
  platform,
}: {
  t: (key: string) => string;
  platform: Platform;
}): ShortcutRow[] {
  const gotoProject = (keys: string): ShortcutRow => ({
    id: "gotoProject",
    text: t("settings.shortcutsGotoProject"),
    keys,
  });
  if (platform === "macos") {
    const menuRows = buildAppMenuModel({ t, hasProject: true })
      .flatMap((group) => group.items)
      .flatMap((entry): ShortcutRow[] =>
        entry.kind === "item" && entry.accelerator
          ? [{ id: entry.id, text: entry.text, keys: formatAccelerator(entry.accelerator) }]
          : [],
      );
    return [...menuRows, gotoProject("⌃1–9")];
  }
  return [
    { id: "closeProject", text: t("menu.file.closeProject"), keys: "Ctrl+W" },
    { id: "focusSearch", text: t("menu.view.search"), keys: "Ctrl+F" },
    { id: "refresh", text: t("menu.view.refresh"), keys: "Ctrl+R" },
    { id: "nextProject", text: t("menu.view.nextProject"), keys: "Ctrl+Tab" },
    gotoProject("Ctrl+1–9"),
  ];
}

export interface AppMenuDeps {
  isMacOS: boolean;
  t: (key: string) => string;
  hasProject: boolean;
  dispatch: (action: AppMenuAction) => void;
}

/**
 * 安装 macOS 原生菜单列（design D3）：与系统匣同一做法，把模型转成整棵选项对象一次交给
 * `Menu.new` 后 `setAsAppMenu()`，再关掉被换下的旧菜单（释放 Rust 端资源）。非 macOS 不调用
 * 任何菜单 API。回传取消函数：语言或项目有无改变时 App 以新的一次取代，取消后才建好的
 * 菜单不套用并关掉。创建失败只记 console.error——app 照常、仅无菜单列。
 */
export function installAppMenu(deps: AppMenuDeps): () => void {
  if (!deps.isMacOS) return () => {};

  const toOptions = (entry: AppMenuEntry): MenuItemOptions | PredefinedMenuItemOptions => {
    switch (entry.kind) {
      case "item":
        return {
          text: entry.text,
          accelerator: entry.accelerator,
          enabled: entry.enabled,
          action: () => deps.dispatch(entry.id),
        };
      case "predefined":
        return { item: entry.item, text: entry.text };
      case "separator":
        return { item: "Separator" };
    }
  };
  const items = buildAppMenuModel(deps).map(
    (group): SubmenuOptions => ({ text: group.text, items: group.items.map(toOptions) }),
  );

  let cancelled = false;
  void (async () => {
    try {
      const menu = await Menu.new({ items });
      if (cancelled) return void (await menu.close());
      const replaced = await menu.setAsAppMenu();
      await replaced?.close();
    } catch (e) {
      console.error("app menu build failed", e);
    }
  })();
  return () => {
    cancelled = true;
  };
}

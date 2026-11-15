import { describe, it, expect, vi, afterEach } from "vitest";
import { Menu } from "@tauri-apps/api/menu";

import {
  buildAppMenuModel,
  buildShortcutList,
  installAppMenu,
  type AppMenuEntry,
  type AppMenuModel,
} from "../appMenu";
import { APP_MESSAGES } from "../i18n/messages";
import type { Platform } from "../platform";

vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));

const tOf = (locale: "zh-CN" | "en") => (key: string): string => APP_MESSAGES[locale][key] ?? key;

/** 项目的识别：自订项取动作 id、缺省项取系统项名、分隔线为 "-"。 */
const entryId = (e: AppMenuEntry): string =>
  e.kind === "item" ? e.id : e.kind === "predefined" ? e.item : "-";

const customItems = (model: AppMenuModel) =>
  model.flatMap((g) => g.items).filter((e) => e.kind === "item");

describe("buildAppMenuModel（design D2）", () => {
  const model = buildAppMenuModel({ t: tOf("zh-CN"), hasProject: true });

  it("六组依序为 Specseal、文档、编辑、查看、窗口、说明，各组项目依序排列", () => {
    expect(model.map((g) => g.id)).toEqual(["app", "file", "edit", "view", "window", "help"]);
    expect(Object.fromEntries(model.map((g) => [g.id, g.items.map(entryId)]))).toEqual({
      app: [
        "about",
        "checkUpdates",
        "-",
        "settings",
        "-",
        "Services",
        "-",
        "Hide",
        "HideOthers",
        "ShowAll",
        "-",
        "Quit",
      ],
      file: ["openProject", "closeProject", "-", "installCli"],
      edit: ["Undo", "Redo", "-", "Cut", "Copy", "Paste", "SelectAll"],
      view: [
        "viewBoard",
        "viewArchived",
        "viewSpecs",
        "viewManual",
        "viewProjectSettings",
        "-",
        "focusSearch",
        "refresh",
        "-",
        "nextProject",
      ],
      window: ["Minimize", "Maximize", "-", "bringAllToFront"],
      help: ["helpManual", "releaseNotes", "-", "github", "reportIssue"],
    });
  });

  it("自订项目的快捷键字符串", () => {
    const accelerators = Object.fromEntries(
      customItems(model)
        .filter((e) => e.accelerator !== undefined)
        .map((e) => [e.id, e.accelerator]),
    );
    expect(accelerators).toEqual({
      settings: "CmdOrCtrl+,",
      openProject: "Cmd+O",
      closeProject: "Cmd+W",
      viewBoard: "Cmd+1",
      viewArchived: "Cmd+2",
      viewSpecs: "Cmd+3",
      viewManual: "Cmd+4",
      focusSearch: "Cmd+F",
      refresh: "Cmd+R",
      nextProject: "Ctrl+Tab",
    });
  });

  it("隐藏、隐藏其他、结束、缩到最小是系统缺省项（⌘H、⌥⌘H、⌘Q、⌘M 由系统自带）", () => {
    const predefined = model
      .flatMap((g) => g.items)
      .filter((e) => e.kind === "predefined")
      .map((e) => e.item);
    expect(predefined).toEqual(
      expect.arrayContaining(["Hide", "HideOthers", "Quit", "Minimize"]),
    );
  });

  it("有作用中项目时所有自订项目可用", () => {
    expect(customItems(model).filter((e) => !e.enabled)).toEqual([]);
  });

  it("没有作用中项目时停用集合恰为关闭项目、查看组八项与说明的手册", () => {
    const empty = buildAppMenuModel({ t: tOf("zh-CN"), hasProject: false });
    expect(
      customItems(empty)
        .filter((e) => !e.enabled)
        .map((e) => e.id)
        .sort(),
    ).toEqual(
      [
        "closeProject",
        "viewBoard",
        "viewArchived",
        "viewSpecs",
        "viewManual",
        "viewProjectSettings",
        "focusSearch",
        "refresh",
        "nextProject",
        "helpManual",
      ].sort(),
    );
  });

  it("zh-CN 与 en 字典各建一次：文案皆取自字典（非 key 本身），两语系的组标题不同", () => {
    const texts = (m: AppMenuModel) =>
      m.flatMap((g) => [
        g.text,
        ...g.items.flatMap((e) => (e.kind === "separator" || e.text === undefined ? [] : [e.text])),
      ]);
    const missing = (locale: "zh-CN" | "en") => {
      const keys: string[] = [];
      const recording = (key: string) => {
        keys.push(key);
        return tOf(locale)(key);
      };
      buildAppMenuModel({ t: recording, hasProject: true });
      return keys.filter((key) => !(key in APP_MESSAGES[locale]));
    };
    expect(missing("zh-CN")).toEqual([]);
    expect(missing("en")).toEqual([]);

    const zh = buildAppMenuModel({ t: tOf("zh-CN"), hasProject: true });
    const en = buildAppMenuModel({ t: tOf("en"), hasProject: true });
    expect(texts(zh).some((text) => text.startsWith("menu."))).toBe(false);
    expect(texts(en).some((text) => text.startsWith("menu."))).toBe(false);
    expect(zh.map((g) => g.text)).toEqual(["Specseal", "文档", "编辑", "查看", "窗口", "说明"]);
    expect(en.map((g) => g.text)).toEqual(["Specseal", "File", "Edit", "View", "Window", "Help"]);
    expect(texts(zh)).not.toEqual(texts(en));
  });
});

type MenuOptionsTree = { text?: string; item?: unknown; action?: () => void; items?: MenuOptionsTree[] };

/** 假的 Tauri 菜单：记下每次 Menu.new 收到的整棵选项对象；setAsAppMenu 回传被换下的旧菜单。 */
function fakeMenus() {
  const built: MenuOptionsTree[][] = [];
  const menus: Array<{ setAsAppMenu: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const replaced = { close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(Menu.new).mockImplementation(async (opts) => {
    built.push((opts?.items ?? []) as MenuOptionsTree[]);
    const menu = {
      setAsAppMenu: vi.fn().mockResolvedValue(replaced),
      close: vi.fn().mockResolvedValue(undefined),
    };
    menus.push(menu);
    return menu as never;
  });
  return { built, menus, replaced };
}

const findItem = (tree: MenuOptionsTree[], text: string): MenuOptionsTree | undefined => {
  for (const node of tree) {
    if (node.text === text && node.action) return node;
    const hit = node.items ? findItem(node.items, text) : undefined;
    if (hit) return hit;
  }
  return undefined;
};

describe("installAppMenu（design D3）", () => {
  afterEach(() => {
    vi.mocked(Menu.new).mockReset();
    vi.restoreAllMocks();
  });

  const install = (overrides: Partial<Parameters<typeof installAppMenu>[0]> = {}) => {
    const dispatch = vi.fn();
    const cancel = installAppMenu({
      isMacOS: true,
      t: tOf("zh-CN"),
      hasProject: true,
      dispatch,
      ...overrides,
    });
    return { dispatch, cancel };
  };

  it("macOS 建一次并设为 app 菜单，再关掉被换下的旧菜单", async () => {
    const { menus, replaced } = fakeMenus();
    install();
    await vi.waitFor(() => expect(replaced.close).toHaveBeenCalledTimes(1));
    expect(Menu.new).toHaveBeenCalledTimes(1);
    expect(menus[0].setAsAppMenu).toHaveBeenCalledTimes(1);
    expect(menus[0].close).not.toHaveBeenCalled();
  });

  it("依传入的语言建出六组子菜单", async () => {
    const { built } = fakeMenus();
    install({ t: tOf("en") });
    await vi.waitFor(() => expect(built).toHaveLength(1));
    expect(built[0].map((group) => group.text)).toEqual([
      "Specseal",
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
  });

  it("触发菜单项的 action 以对应动作 id 调用 dispatch", async () => {
    const { built } = fakeMenus();
    const { dispatch } = install();
    await vi.waitFor(() => expect(built).toHaveLength(1));
    findItem(built[0], "规格")?.action?.();
    findItem(built[0], "回报问题")?.action?.();
    expect(dispatch.mock.calls).toEqual([["viewSpecs"], ["reportIssue"]]);
  });

  it("非 macOS 不调用任何菜单 API", () => {
    fakeMenus();
    const { cancel } = install({ isMacOS: false });
    cancel();
    expect(Menu.new).not.toHaveBeenCalled();
  });

  it("取消后才建好的菜单不设为 app 菜单，并关掉它", async () => {
    const { menus } = fakeMenus();
    const { cancel } = install();
    cancel();
    await vi.waitFor(() => expect(menus[0]?.close).toHaveBeenCalledTimes(1));
    expect(menus[0].setAsAppMenu).not.toHaveBeenCalled();
  });

  it("Menu.new 抛错时记 console.error、不向外抛", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Menu.new).mockRejectedValue(new Error("menu unavailable"));
    install();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });
});

describe("buildShortcutList（design D5）", () => {
  const rows = (platform: Platform, locale: "zh-CN" | "en" = "zh-CN") =>
    buildShortcutList({ t: tOf(locale), platform }).map((row) => [row.text, row.keys]);

  it("macOS 回 11 列，逐列等于 spec Example「macOS 的卡片内容」", () => {
    expect(rows("macos")).toEqual([
      ["设置…", "⌘,"],
      ["打开项目…", "⌘O"],
      ["关闭项目", "⌘W"],
      ["变更", "⌘1"],
      ["已封存", "⌘2"],
      ["规格", "⌘3"],
      ["手册", "⌘4"],
      ["搜索看板", "⌘F"],
      ["刷新", "⌘R"],
      ["下一个项目", "⌃Tab"],
      ["跳到第 1–9 个项目", "⌃1–9"],
    ]);
  });

  it.each(["windows", "linux"] as const)(
    "%s 回 5 列，逐列等于 spec Example「Windows 与 Linux 的卡片内容」",
    (platform) => {
      expect(rows(platform)).toEqual([
        ["关闭项目", "Ctrl+W"],
        ["搜索看板", "Ctrl+F"],
        ["刷新", "Ctrl+R"],
        ["下一个项目", "Ctrl+Tab"],
        ["跳到第 1–9 个项目", "Ctrl+1–9"],
      ]);
    },
  );

  it("以 en 字典建时动作名称为英文、按键不变", () => {
    expect(rows("macos", "en")).toEqual([
      ["Settings…", "⌘,"],
      ["Open Project…", "⌘O"],
      ["Close Project", "⌘W"],
      ["Changes", "⌘1"],
      ["Archived", "⌘2"],
      ["Specs", "⌘3"],
      ["Manual", "⌘4"],
      ["Search Board", "⌘F"],
      ["Refresh", "⌘R"],
      ["Next Project", "⌃Tab"],
      ["Go to Project 1–9", "⌃1–9"],
    ]);
  });
});

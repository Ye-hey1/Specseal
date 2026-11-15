// 项目分页列的纯函数面（design D8/D10）：localStorage 持久化（路径＋显示名＋
// 顺序＋最后活跃）、上限 10、去重、关闭移除；徽章派生为待收尾数
//（spec-archive-drawer design D6：已就绪变更＋已结论未转出讨论）。分页列只管
// 目前开着的项目；曾打开过的「最近打开」记忆另见 recents.test.ts。
import { describe, it, expect } from "vitest";
import { dictionaryProblems } from "@specseal/ui";

import {
  MAX_TABS,
  upsertTab,
  removeTab,
  persistTabs,
  readPersistedTabs,
  type ProjectTab,
} from "../tabs";
import { locatorKey, type WorkspaceLocator } from "../session";
import { APP_MESSAGES } from "../i18n/messages";

function local(root: string): WorkspaceLocator {
  return { kind: "local", root };
}

function tab(root: string, name = root): ProjectTab {
  return { locator: local(root), name };
}

function keys(tabs: Array<{ locator: WorkspaceLocator }>): string[] {
  return tabs.map((t) => locatorKey(t.locator));
}

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("upsertTab（spec「成功打开后记入分页并去重上移」的清单面）", () => {
  it("appends a new project at the end", () => {
    const tabs = upsertTab([tab("A")], { locator: local("B"), name: "B" });
    expect(keys(tabs)).toEqual(["local:A", "local:B"]);
  });

  it("reopening an existing project keeps one tab in place (dedup)", () => {
    const tabs = upsertTab([tab("A"), tab("B")], { locator: local("A"), name: "A" });
    expect(keys(tabs)).toEqual(["local:A", "local:B"]);
    expect(tabs).toHaveLength(2);
  });

  it("caps at MAX_TABS by dropping the oldest tab", () => {
    let tabs: ProjectTab[] = [];
    for (let i = 0; i < MAX_TABS; i++)
      tabs = upsertTab(tabs, { locator: local(`p${i}`), name: `p${i}` });
    expect(tabs).toHaveLength(MAX_TABS);
    tabs = upsertTab(tabs, { locator: local("extra"), name: "extra" });
    expect(tabs).toHaveLength(MAX_TABS);
    expect(keys(tabs)).not.toContain("local:p0");
    expect(keys(tabs).at(-1)).toBe("local:extra");
  });

  it("updates the display name of an existing tab", () => {
    const tabs = upsertTab([tab("A", "old")], { locator: local("A"), name: "new" });
    expect(tabs[0].name).toBe("new");
  });
});

describe("removeTab", () => {
  it("removes the tab with the given locator key", () => {
    expect(keys(removeTab([tab("A"), tab("B")], "local:A"))).toEqual(["local:B"]);
  });
});

describe("分页持久化 v2 与 v1 静默迁移（spec「分页持久化 v2 与 v1 静默迁移」）", () => {
  it("empty storage restores to zero tabs", () => {
    const restored = readPersistedTabs(memStorage());
    expect(restored.tabs).toEqual([]);
    expect(restored.activeKey).toBeNull();
  });

  it("round-trips v2 (locator, order, names, activeKey) and stamps version 2", () => {
    const st = memStorage();
    const tabs: ProjectTab[] = [
      { locator: local("B"), name: "beta" },
      { locator: local("A"), name: "alpha" },
    ];
    persistTabs(tabs, "local:A", st);
    const raw = JSON.parse(st.getItem("specseal.projectTabs") ?? "{}");
    expect(raw.version).toBe(2);
    const restored = readPersistedTabs(st);
    expect(restored.tabs.map((t) => t.locator)).toEqual([local("B"), local("A")]);
    expect(restored.tabs.map((t) => t.name)).toEqual(["beta", "alpha"]);
    expect(restored.activeKey).toBe("local:A");
  });

  it("v2 round-trips remote checkoutRoot without putting it in activeKey", () => {
    const st = memStorage();
    const locator: WorkspaceLocator = {
      kind: "remote",
      connectionId: "c1",
      projectId: "demo",
      repoId: "backend",
      checkoutRoot: "/work/backend",
    };
    persistTabs([{ locator, name: "Demo/Backend" }], locatorKey(locator), st);
    const restored = readPersistedTabs(st);
    expect(restored.tabs).toEqual([{ locator, name: "Demo/Backend" }]);
    expect(restored.activeKey).toBe("remote:c1/demo/backend");
  });

  it("v1 payload (root＋name＋activeRoot) silently migrates to local locators and activeKey", () => {
    // 契约范例（spec Scenario「旧版用户升级后分页完整保留」）：两个项目分页＋activeRoot。
    const st = memStorage();
    st.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        tabs: [
          { root: "A", name: "alpha" },
          { root: "B", name: "beta" },
        ],
        activeRoot: "B",
      }),
    );
    const restored = readPersistedTabs(st);
    expect(restored.tabs).toEqual([
      { locator: local("A"), name: "alpha" },
      { locator: local("B"), name: "beta" },
    ]);
    expect(restored.activeKey).toBe("local:B");
  });

  it("the next persist after a v1 read writes v2", () => {
    const st = memStorage();
    st.setItem(
      "specseal.projectTabs",
      JSON.stringify({ tabs: [{ root: "A", name: "alpha" }], activeRoot: "A" }),
    );
    const restored = readPersistedTabs(st);
    persistTabs(
      restored.tabs.map((t) => ({ ...t })),
      restored.activeKey,
      st,
    );
    const raw = JSON.parse(st.getItem("specseal.projectTabs") ?? "{}");
    expect(raw.version).toBe(2);
    expect(raw.tabs).toEqual([{ locator: local("A"), name: "alpha" }]);
    expect(raw.activeKey).toBe("local:A");
  });

  it("v1 entries with a non-string root are dropped", () => {
    const st = memStorage();
    st.setItem(
      "specseal.projectTabs",
      JSON.stringify({
        tabs: [
          { root: 7, name: "bogus" },
          { root: "A", name: "alpha" },
        ],
        activeRoot: "A",
      }),
    );
    expect(readPersistedTabs(st).tabs).toEqual([{ locator: local("A"), name: "alpha" }]);
  });

  it("garbage JSON restores to zero tabs and no active key（spec「坏 JSON 归零」）", () => {
    const st = memStorage();
    st.setItem("specseal.projectTabs", "{not json");
    const restored = readPersistedTabs(st);
    expect(restored.tabs).toEqual([]);
    expect(restored.activeKey).toBeNull();
  });

  it("unrecognized shapes restore to zero tabs", () => {
    const st = memStorage();
    st.setItem("specseal.projectTabs", JSON.stringify({ version: 99, tabs: "x" }));
    const restored = readPersistedTabs(st);
    expect(restored.tabs).toEqual([]);
    expect(restored.activeKey).toBeNull();
  });
});

describe("分页徽章已移除（分页不显示计数）", () => {
  it("app 字典不再含 tabBadgeTooltip", () => {
    expect("app.tabBadgeTooltip" in APP_MESSAGES["zh-CN"]).toBe(false);
    expect("app.tabBadgeTooltip" in APP_MESSAGES.en).toBe(false);
  });

  it("zh-CN and en app dictionaries pass the shared dictionary check (same key set, .one forms aside)", () => {
    expect(dictionaryProblems(APP_MESSAGES)).toEqual([]);
  });
});

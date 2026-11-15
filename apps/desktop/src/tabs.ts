// 项目分页列的纯函数面（design D8/D10；workspace-session 决策 1/2）：分页清单
// 操作与 localStorage 持久化。分页身分＝WorkspaceLocator（经 locatorKey 比对，
// 不再以裸 root 字符串）；持久化 v2（version＋locator＋activeKey），v1 静默迁移。
// 分页列只管目前开着的项目（关闭即自清单移除），不写入项目目录；曾打开过的
// 「最近打开」记忆另见 recents.ts（chooser-recent-workspaces D6）。
import { changeStage, type ChangeItem, type DiscussionItem } from "@specseal/ui";

import { locatorKey, type WorkspaceLocator } from "./session";

export interface ProjectTab {
  locator: WorkspaceLocator;
  name: string;
}

export interface PersistedTabs {
  tabs: Array<{ locator: WorkspaceLocator; name: string }>;
  /** 最后活跃分页的 locator key（null＝无）。 */
  activeKey: string | null;
}

export const MAX_TABS = 10;
const STORAGE_KEY = "specseal.projectTabs";

/** 成功打开后记入分页：既有者（同 locator key）原地去重（更新显示名）、
 * 新项目 append 尾端；超过上限时丢最旧（清单首位）。 */
export function upsertTab(
  tabs: ProjectTab[],
  entry: { locator: WorkspaceLocator; name: string },
): ProjectTab[] {
  const key = locatorKey(entry.locator);
  if (tabs.some((t) => locatorKey(t.locator) === key)) {
    return tabs.map((t) =>
      locatorKey(t.locator) === key
        ? { ...t, locator: entry.locator, name: entry.name }
        : t,
    );
  }
  const next = [...tabs, { locator: entry.locator, name: entry.name }];
  return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
}

export function removeTab(tabs: ProjectTab[], key: string): ProjectTab[] {
  return tabs.filter((t) => locatorKey(t.locator) !== key);
}

export function persistTabs(
  tabs: ProjectTab[],
  activeKey: string | null,
  storage: Storage = localStorage,
): void {
  const payload = {
    version: 2,
    tabs: tabs.map(({ locator, name }) => ({ locator, name })),
    activeKey,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** 持久化条目的 locator 形状验证（v2 读取）：local 需 root 字符串、remote 需
 * 三段识别字符串（checkoutRoot 可选字符串）；其余形状丢弃该条目。 */
export function isLocator(v: unknown): v is WorkspaceLocator {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  if (l.kind === "local") return typeof l.root === "string";
  if (l.kind === "remote") {
    return (
      typeof l.connectionId === "string" &&
      typeof l.projectId === "string" &&
      typeof l.repoId === "string" &&
      (l.checkoutRoot === undefined || typeof l.checkoutRoot === "string")
    );
  }
  return false;
}

/** 读取持久化分页（design 决策 2）：v2 依 version 解析；无 version 字段且形如
 * v1（tabs 条目有 root 字符串）则静默迁移——root 逐条映射 local locator、
 * activeRoot 映射 local key，下次写入即 v2。缺键、坏 JSON 或不识别形状一律
 * 还原为零分页；v1 条目 root 非字符串者丢弃。 */
export function readPersistedTabs(storage: Storage = localStorage): PersistedTabs {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeKey: null };
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      tabs?: unknown;
      activeKey?: unknown;
      activeRoot?: unknown;
    };
    if (parsed.version === 2) {
      const entries = Array.isArray(parsed.tabs) ? parsed.tabs : [];
      const tabs = entries
        .filter(
          (t): t is { locator: WorkspaceLocator; name: string } =>
            isLocator(t?.locator) && typeof t?.name === "string",
        )
        .map((t) => ({ locator: t.locator, name: t.name }));
      return {
        tabs,
        activeKey: typeof parsed.activeKey === "string" ? parsed.activeKey : null,
      };
    }
    if (parsed.version === undefined && Array.isArray(parsed.tabs)) {
      const tabs = parsed.tabs
        .filter(
          (t): t is { root: string; name: string } =>
            typeof t?.root === "string" && typeof t?.name === "string",
        )
        .map((t) => ({ locator: { kind: "local", root: t.root } as const, name: t.name }));
      return {
        tabs,
        activeKey:
          typeof parsed.activeRoot === "string"
            ? locatorKey({ kind: "local", root: parsed.activeRoot })
            : null,
      };
    }
    return { tabs: [], activeKey: null };
  } catch {
    return { tabs: [], activeKey: null };
  }
}


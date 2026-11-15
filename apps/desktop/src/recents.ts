// 最近打开清单的纯函数面（design D1／D3／D5）：与分页列分离的「曾打开过」记忆。
// localStorage 独立键持久化（version 1、locator＋显示名），最新在前、同 locator key
// 去重上移、上限 20；关闭分页不动记录。键缺席回 null 供启动自分页补种，坏数据归零。
import { locatorKey, type WorkspaceLocator } from "./session";
import { isLocator, type ProjectTab } from "./tabs";

export interface RecentEntry {
  locator: WorkspaceLocator;
  name: string;
}

export const MAX_RECENTS = 20;
export const RECENTS_STORAGE_KEY = "specseal.recentWorkspaces";

/** 成功打开后记入：同 locator key 者移除后放到最前（显示名取新值），超过上限截尾。 */
export function upsertRecent(entries: RecentEntry[], entry: RecentEntry): RecentEntry[] {
  const key = locatorKey(entry.locator);
  const rest = entries.filter((e) => locatorKey(e.locator) !== key);
  return [{ locator: entry.locator, name: entry.name }, ...rest].slice(0, MAX_RECENTS);
}

export function removeRecent(entries: RecentEntry[], key: string): RecentEntry[] {
  return entries.filter((e) => locatorKey(e.locator) !== key);
}

export function persistRecents(entries: RecentEntry[], storage: Storage = localStorage): void {
  storage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

/** 键缺席回 null（启动时据此自分页补种）；坏 JSON、version 非 1 或 entries 非数组
 * 回空数组；条目逐笔验证 locator 形状与 name 字符串，不合者只丢该条目。 */
export function readPersistedRecents(storage: Storage = localStorage): RecentEntry[] | null {
  try {
    const raw = storage.getItem(RECENTS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown } | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return [];
    // 手改或旧版残留的 payload 可能含重复 locator 或超长清单——读进来就收敛，
    // 否则 chooser 会撞上重复的 React key，且要等下次写入才套上限。
    const seen = new Set<string>();
    return parsed.entries
      .filter((e): e is RecentEntry => {
        if (typeof e !== "object" || e === null) return false;
        const candidate = e as { locator?: unknown; name?: unknown };
        return isLocator(candidate.locator) && typeof candidate.name === "string";
      })
      .filter((e) => {
        const key = locatorKey(e.locator);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_RECENTS)
      .map((e) => ({ locator: e.locator, name: e.name }));
  } catch {
    return [];
  }
}

/** 显示期过滤（design D3）：滤掉分页列上已开着的 workspace，顺序不变。 */
export function visibleRecents(entries: RecentEntry[], tabs: ProjectTab[]): RecentEntry[] {
  const open = new Set(tabs.map((t) => locatorKey(t.locator)));
  return entries.filter((e) => !open.has(locatorKey(e.locator)));
}

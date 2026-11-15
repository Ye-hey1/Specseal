import type { ChangeItem } from "./adapter";

/**
 * 同源变更：与选定变更共享至少一份来源讨论的其他变更（不含自己）。
 * 判定为「双方来源讨论集合交集非空」——一份讨论可扇出多个变更，这些变更
 * 互为同源；一个变更亦可链接多份讨论，任一交集即成立。
 */
export function siblingChangesOf(
  changes: ChangeItem[],
  fromDiscussions: string[],
  selfName: string,
): string[] {
  if (fromDiscussions.length === 0) return [];
  return changes
    .filter(
      (c) =>
        c.name !== selfName &&
        (c.fromDiscussions ?? []).some((s) => fromDiscussions.includes(s)),
    )
    .map((c) => c.name);
}

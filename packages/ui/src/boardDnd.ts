// 看板拖排的落点解析（design D6）——与 tasks.ts 的 resolveDropTarget 同款
// 「纯函数＋薄 dragEnd 接线」模式：jsdom 测纯函数、真实拖曳留真窗口验证。

import type { CardKind } from "./adapter";

/** 一栏的可见卡识别码（视觉序）。变更卡＝变更名、讨论卡＝slug。 */
export interface ColumnCards {
  kind: CardKind;
  ids: string[];
}

/** dnd id 前缀：变更名与讨论 slug 可能撞名，入 DndContext 前加种类前缀。 */
export function cardDndId(kind: CardKind, id: string): string {
  return kind === "change" ? `chg:${id}` : `disc:${id}`;
}

/** 自 dnd id 还原种类与识别码；非卡片 id（栏容器、封存落点）回 null。 */
export function parseCardDndId(dndId: string): { kind: CardKind; id: string } | null {
  if (dndId.startsWith("chg:")) return { kind: "change", id: dndId.slice(4) };
  if (dndId.startsWith("disc:")) return { kind: "discussion", id: dndId.slice(5) };
  return null;
}

/**
 * 封存落点浮层的浮现条件（spec「拖曳封存落点以浮层呈现」）：仅拖曳**已就绪**
 * 变更卡（名列 `readyIds`）时浮现——非就绪变更卡的拖曳＝纯排序，讨论卡不可
 * 拖曳封存，两者皆不得造成任何布局变动。
 */
export function archiveZoneVisible(
  activeDndId: string | null,
  readyIds: ReadonlySet<string>,
): boolean {
  if (activeDndId === null) return false;
  const card = parseCardDndId(activeDndId);
  return card?.kind === "change" && readyIds.has(card.id);
}

/**
 * dragEnd 落点解析：active 与 over 属**同一栏**的卡片时，回传 arrayMove 后
 * 的前后邻居（栏顶／栏底为 null）；跨栏、栏容器、封存落点、原位放开一律
 * 回 null——调用端不触发任何写回（spec「跨栏拖曳不改变变更阶段」）。
 */
export function resolveCardDrop(
  columns: ColumnCards[],
  activeDndId: string,
  overDndId: string,
): { kind: CardKind; id: string; prevId: string | null; nextId: string | null } | null {
  const active = parseCardDndId(activeDndId);
  const over = parseCardDndId(overDndId);
  if (!active || !over) return null;
  const col = columns.find((c) => c.kind === active.kind && c.ids.includes(active.id));
  if (!col || col.kind !== over.kind || !col.ids.includes(over.id)) return null;
  const from = col.ids.indexOf(active.id);
  const to = col.ids.indexOf(over.id);
  if (from === to) return null;
  const moved = col.ids.filter((x) => x !== active.id);
  moved.splice(to, 0, active.id);
  return {
    kind: active.kind,
    id: active.id,
    prevId: moved[to - 1] ?? null,
    nextId: moved[to + 1] ?? null,
  };
}

/**
 * 不合法落点集合（spec desktop-app「拖排时不合法落点灰化」）：拖动 `activeId` 期间，
 * 同栏中它的声明前置及其上方所有卡（落在那里会排到前置之前）、声明依赖它的卡及
 * 其下方所有卡（落在那里会排到依赖者之后）。只用 `deps`（每张卡的 dependsOn），
 * 不看 delta 重叠——重叠伙伴可互换先后。被拖卡不在栏内时没有落点可标。
 */
export function invalidDropTargets(
  column: ColumnCards,
  deps: ReadonlyMap<string, readonly string[]>,
  activeId: string,
): Set<string> {
  const ids = column.ids;
  const out = new Set<string>();
  if (!ids.includes(activeId)) return out;
  const prereqs = deps.get(activeId) ?? [];
  // 最靠下的前置：它与其上方全部不合法。
  let lowestPrereq = -1;
  // 最靠上的依赖者：它与其下方全部不合法。
  let highestDependent = ids.length;
  ids.forEach((id, i) => {
    if (prereqs.includes(id)) lowestPrereq = Math.max(lowestPrereq, i);
    if ((deps.get(id) ?? []).includes(activeId)) highestDependent = Math.min(highestDependent, i);
  });
  ids.forEach((id, i) => {
    if (id !== activeId && (i <= lowestPrereq || i >= highestDependent)) out.add(id);
  });
  return out;
}

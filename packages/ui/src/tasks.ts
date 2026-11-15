/** 一行任务：是否勾选 + 文本（去掉 checkbox 标记）。 */
export interface TaskLine {
  done: boolean;
  text: string;
}

/** 任务文档的一个节点：群组标题或任务（带 1-based 序数，供写回 tasks.md 定位；
 * stableId＝行尾 specseal-task 注解的不可变身分，无注解旧档缺席；manual＝行首
 * `[M]` 标记的手动任务，无标记时缺席）。 */
export type TaskDocItem =
  | { kind: "group"; text: string }
  | {
      kind: "task";
      ordinal: number;
      done: boolean;
      text: string;
      stableId?: string;
      manual?: true;
    };

/** 行尾 specseal-task ID 注解（spec task-identity）——显示一律剥离。 */
const TASK_ID_RE = /\s*<!--\s*specseal-task:\s*(\S+?)\s*-->\s*$/;

/** 剥离行尾 ID 注解：显示文本与无注解时相同，ID 入独立字段。 */
function splitStableId(text: string): { text: string; stableId?: string } {
  const m = text.match(TASK_ID_RE);
  return m ? { text: text.slice(0, m.index).trimEnd(), stableId: m[1] } : { text };
}

/** 剥离 checkbox 后的行首标记槽（spec manual-task-marker，与引擎
 * crates/engine/specseal-core/src/lifecycle/tasks.rs 的 strip_markers 同构——动标记规则两处要
 * 一起改，案例表也对齐同一份）：`[M]` 承载手动任务身分，历史遗留的 `[P]` 只剥
 * 不承载任何旗标；顺序不敏感、各至多一次。 */
function stripMarkers(text: string): { text: string; manual: boolean } {
  let manual = false;
  let legacyParallel = false;
  let body = text;
  for (;;) {
    if (!legacyParallel && body.startsWith("[P] ")) {
      legacyParallel = true;
      body = body.slice(4);
      continue;
    }
    if (!manual && body.startsWith("[M] ")) {
      manual = true;
      body = body.slice(4);
      continue;
    }
    return { text: body, manual };
  }
}

/** 清单项呈现 key：stable ID 第一、无 ID 旧档退回 ordinal（spec task-identity）。 */
export function taskKey(item: Extract<TaskDocItem, { kind: "task" }>): string {
  return item.stableId ?? String(item.ordinal);
}

/** 解析 tasks.md 为群组标题＋任务串行（序数仅计 checkbox 行，与桌面写入 command 对齐）。 */
export function parseTaskDoc(markdown: string | null | undefined): TaskDocItem[] {
  if (!markdown) return [];
  const items: TaskDocItem[] = [];
  let ordinal = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const g = line.match(/^##\s+(.*\S)\s*$/);
    if (g) {
      items.push({ kind: "group", text: g[1] });
      continue;
    }
    // checkbox 后恰一个空格才进标记槽（`\] ` 非 `\]\s+`）——与引擎的
    // `&r[4..]` 同构：多余空白留在描述里，标记就不成立，UI 与计数/闸门
    // 才不会对同一行给出相反的 manual 判定。
    const t = line.match(/^\s*-\s*\[([ xX])\] (.*)$/);
    if (t) {
      ordinal += 1;
      const done = t[1].toLowerCase() === "x";
      const { text: unmarked, manual } = stripMarkers(t[2]);
      const { text: unstamped, stableId } = splitStableId(unmarked);
      // 前后修剪与引擎 display.trim() 同构。
      const text = unstamped.trim();
      const item: Extract<TaskDocItem, { kind: "task" }> = { kind: "task", ordinal, done, text };
      if (stableId) item.stableId = stableId;
      if (manual) item.manual = true;
      items.push(item);
    }
  }
  return items;
}

/** 就地改写第 ordinal（1-based，仅计 checkbox 行）个任务的勾选标记——勾选乐观
 * 更新用，序数判定与 parseTaskDoc 同一正则对齐。找不到该序数回 null。 */
export function setTaskMark(markdown: string, ordinal: number, done: boolean): string | null {
  let n = 0;
  let hit = false;
  const lines = markdown.split(/\r?\n/).map((line) => {
    // 任务行判定与 parseTaskDoc 同一形状（`\] ` 恰一个空格）——读写两侧的
    // 序数计数必须同构，否则乐观改写会翻错行。
    const m = line.match(/^(\s*-\s*\[)[ xX](\] .*)$/);
    if (!m) return line;
    n += 1;
    if (n !== ordinal) return line;
    hit = true;
    return `${m[1]}${done ? "x" : " "}${m[2]}`;
  });
  return hit ? lines.join("\n") : null;
}

/** 拖放落点解析结果：以第 to 个任务为锚；before=true＝插锚前（组首落点）。 */
export interface DropTarget {
  to: number;
  before?: boolean;
}

/**
 * 把 dnd 的 over id 解析为写回用的落点（design D6）：
 * - over 为任务 ordinal → `{ to }`（侧别留给后端方向推断）
 * - over 为群组标题 id（`g-<items 索引>`）→ 标题是「组界槽」，依 active 相对
 *   标题的位置双向解析：上方来＝成为该群组组首（组首任务为锚、before=true）；
 *   下方来＝移到标题之前、成为上一群组末任务（标题前最近任务为锚、before=false）
 *   ——否则组首任务永远拖不回上一群组末位。
 * - 该侧无任务可锚定（空群组、档首）、锚即自己、落点即自己 → null（不触发写回）
 */
export function resolveDropTarget(
  items: TaskDocItem[],
  activeOrdinal: number,
  overId: number | string,
): DropTarget | null {
  if (typeof overId === "number") {
    return overId === activeOrdinal ? null : { to: overId };
  }
  const headingIndex = Number(overId.replace(/^g-/, ""));
  if (!Number.isInteger(headingIndex) || items[headingIndex]?.kind !== "group") return null;
  const activeIndex = items.findIndex((it) => it.kind === "task" && it.ordinal === activeOrdinal);
  if (activeIndex < 0) return null;
  if (activeIndex < headingIndex) {
    // 上方来：锚定标题后第一个任务（同群组组首），插其前。
    for (let i = headingIndex + 1; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "group") return null; // 标题下无任务（空群组）
      return item.ordinal === activeOrdinal ? null : { to: item.ordinal, before: true };
    }
    return null;
  }
  // 下方来：锚定标题前最近的任务（上一群组末位），插其后。
  for (let i = headingIndex - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "task") {
      return item.ordinal === activeOrdinal ? null : { to: item.ordinal, before: false };
    }
  }
  return null; // 标题之前无任务（档首）
}

/** 解析 tasks.md 的 checkbox 行（`- [ ]` / `- [x]`）为任务清单。非 checkbox 行忽略；
 * 显示文本剥离行首标记前缀与行尾 ID 注解。 */
export function parseTasks(markdown: string | null | undefined): TaskLine[] {
  if (!markdown) return [];
  const out: TaskLine[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    // 与 parseTaskDoc 同一行判定（checkbox 后恰一个空格）。
    const m = line.match(/^\s*-\s*\[([ xX])\] (.*)$/);
    if (m) {
      const text = splitStableId(stripMarkers(m[2]).text).text.trim();
      out.push({ done: m[1].toLowerCase() === "x", text });
    }
  }
  return out;
}

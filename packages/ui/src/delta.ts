/** delta spec 各操作的 Requirement 计数。 */
export interface DeltaCounts {
  added: number;
  modified: number;
  removed: number;
  renamed: number;
}

const SECTION_RE = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/;
const REQ_RE = /^###\s+Requirement:/;

/** 解析 delta spec markdown：各 `## <OP> Requirements` 区段内 `### Requirement:` 的数量。 */
export function specDeltaCounts(markdown: string | null | undefined): DeltaCounts {
  const counts: DeltaCounts = { added: 0, modified: 0, removed: 0, renamed: 0 };
  if (!markdown) return counts;
  let section: keyof DeltaCounts | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(SECTION_RE);
    if (m) {
      section = m[1].toLowerCase() as keyof DeltaCounts;
      continue;
    }
    if (/^##\s/.test(line)) {
      section = null;
      continue;
    }
    if (section && REQ_RE.test(line)) counts[section]++;
  }
  return counts;
}

/** delta spec 的一个渲染区段：op 为 delta 种类，null＝非 delta 内文（照常渲染）。 */
export interface DeltaSection {
  op: keyof DeltaCounts | null;
  content: string;
}

/**
 * 把 delta spec 切成渲染区段（design D4）：`## <OP> Requirements` 开新 delta 区段
 * （标题行不入内文，由调用端画色标标头）；其他 `## ` 标题结束 delta 区段（与
 * specDeltaCounts 同界线）、自身归入无种类区段照常渲染。无任何 delta 标题＝整篇单段。
 */
export function splitDeltaSections(markdown: string): DeltaSection[] {
  const sections: DeltaSection[] = [];
  let op: keyof DeltaCounts | null = null;
  let buf: string[] = [];
  const flush = () => {
    const content = buf.join("\n");
    if (op !== null || content.trim()) sections.push({ op, content });
    buf = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(SECTION_RE);
    if (m) {
      flush();
      op = m[1].toLowerCase() as keyof DeltaCounts;
      continue;
    }
    if (/^##\s/.test(line) && op !== null) {
      flush();
      op = null;
    }
    buf.push(line);
  }
  flush();
  return sections.length > 0 ? sections : [{ op: null, content: markdown }];
}

/** 合并多个 delta spec 的计数。 */
export function sumDeltaCounts(list: DeltaCounts[]): DeltaCounts {
  return list.reduce(
    (a, b) => ({
      added: a.added + b.added,
      modified: a.modified + b.modified,
      removed: a.removed + b.removed,
      renamed: a.renamed + b.renamed,
    }),
    { added: 0, modified: 0, removed: 0, renamed: 0 },
  );
}

/** 显示为 `+1 ~2 -0` 摘要（省略为 0 的项）。 */
export function formatDeltaCounts(c: DeltaCounts): string {
  const parts: string[] = [];
  if (c.added) parts.push(`+${c.added}`);
  if (c.modified) parts.push(`~${c.modified}`);
  if (c.removed) parts.push(`-${c.removed}`);
  if (c.renamed) parts.push(`→${c.renamed}`);
  return parts.join(" ");
}

import type { ManualPageItem } from "./adapter";
import { fenceFlags } from "./specSections";

/** 侧栏树的一个分区：标签与其下依阅读序排列的页。 */
export interface Section {
  label: string;
  pages: ManualPageItem[];
}

/** 以 section 对阅读序中连续的页分组（core 已把同分区的页排在一起）；缺 section
 * 的页归「其他」。 */
export function groupSections(pages: ManualPageItem[], otherLabel: string): Section[] {
  const sections: Section[] = [];
  for (const page of pages) {
    const label = page.section ?? otherLabel;
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.pages.push(page);
    else sections.push({ label, pages: [page] });
  }
  return sections;
}

// 页脚出处行（manual-pages 契约）：最后一个非空段落以 `**出处**：` 开头。出处名的
// 单一真相是索引 frontmatter 的 sources（契约规定两者一致），内文这行只剥掉、不重解。
const SOURCES_LINE_RE = /^\*\*出处\*\*[：:]/;

/** 剥掉内文尾端的出处行；没有该行时原样回传。 */
export function stripSourcesLine(body: string): string {
  const lines = body.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0 || !SOURCES_LINE_RE.test(lines[last].trim())) return body;
  return lines.slice(0, last).join("\n");
}

/** 从内文开头抽出 H1：第一个非空行为 `# 标题` 时回传（去掉该行的内文、标题文本），
 * 否则标题为 null。标题进固定页眉，内文不重复呈现。 */
export function splitLeadingHeading(body: string): { body: string; heading: string | null } {
  const lines = body.split("\n");
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  const match = first < lines.length ? /^#\s+(.+?)\s*#*\s*$/.exec(lines[first]) : null;
  if (!match) return { body, heading: null };
  return { body: lines.slice(first + 1).join("\n"), heading: match[1] };
}

// ATX 标题行：前导最多三格空白、二或三个井号，其后为空白或行尾（`##没有空白` 不是标题）。
const ATX_H2_H3_RE = /^ {0,3}(#{2,3})(?:[ \t]|$)/;

/** 数字砖「章节」「小节」：围栏外的 ATX h2／h3 行数（setext 不算）。 */
export function countHeadings(md: string): { h2: number; h3: number } {
  const lines = md.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const counts = { h2: 0, h3: 0 };
  lines.forEach((line, i) => {
    const level = inFence[i] ? undefined : ATX_H2_H3_RE.exec(line)?.[1].length;
    if (level === 2) counts.h2++;
    else if (level === 3) counts.h3++;
  });
  return counts;
}

// 跨页链接（manual-pages 契约「内文惯例」：相对文件名 `[认识画面](layout.md)`，可带锚点）。
const MANUAL_LINK_RE = /^([A-Za-z0-9._-]+)\.md(?:#.*)?$/;

/** 相对文件名链接 → 目标页 slug；外部网址、纯锚点等其他 href 回 null。 */
export function manualLinkSlug(href: string): string | null {
  return MANUAL_LINK_RE.exec(href)?.[1] ?? null;
}

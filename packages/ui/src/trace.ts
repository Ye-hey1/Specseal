// 前端解析正式规格 spec.md 内封存时注入的 @trace 注解（archive.rs trace_block 产生），
// 抽出各区块的 source 变更名，聚合至 spec 层级去重保序（design D1／D2）。

// 一个 @trace HTML 注解区块：`<!-- @trace ... -->`（跨行、非贪婪至最近的 -->）。
const TRACE_BLOCK_RE = /<!--\s*@trace\b([\s\S]*?)-->/g;
// 区块内的 `source: <名>` 行（前后空白容忍；名取到行尾去空白）。
const SOURCE_RE = /^\s*source:\s*(\S.*?)\s*$/m;

/**
 * 解析 raw markdown：回传所有 @trace 区块的 source 名，去重且依文档首次出现顺序。
 * 缺 source 的畸形区块静默略过；无 @trace 或空输入回空数组。
 */
export function parseTraceSources(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const block of markdown.matchAll(TRACE_BLOCK_RE)) {
    const m = block[1].match(SOURCE_RE);
    if (!m) continue;
    const source = m[1];
    if (seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

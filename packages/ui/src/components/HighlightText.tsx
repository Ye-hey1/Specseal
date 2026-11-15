import { SEMANTIC_SURFACE } from "../tone";

/**
 * 命中高亮（design D7）：以不分大小写子字符串定位 query 于 text 的首个命中，
 * 命中原文以 mark 标示（琥珀底、不改字色——「注意这里」属警示层级，主色留给
 * 链接与交互）。无 query 或无连续子字符串命中（仅模糊命中）时原样输出、不高亮。
 */
export function HighlightText({ text, query }: { text: string; query?: string }) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className={`rounded-sm text-inherit ${SEMANTIC_SURFACE.warning}`}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

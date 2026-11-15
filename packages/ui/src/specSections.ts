// 正式规格 spec.md 的分段解析（desktop-readonly-detail-pages design D1）：Purpose 区段、
// 逐条需求的 body／scenarios／段尾 @trace，与 SHALL／MUST 关键字的 rehype 标示插件。
// 逐行扫描且认得 fenced code block——围栏内的 `## `、`### Requirement:`、`---` 都不是结构。

/** 需求段的一个 Scenario：标题（去掉 `#### Scenario:` 前缀）与内文（含所属 `##### Example`）。 */
export interface SpecScenario {
  title: string;
  body: string;
}

/** 一条需求：标题、需求文、Scenario 与段尾 @trace（缺席为 null；updated 只取日期部分）。 */
export interface SpecRequirement {
  title: string;
  body: string;
  scenarios: SpecScenario[];
  trace: { source: string; updated: string | null } | null;
}

export interface SpecSections {
  /** `## Purpose` 区段内文；缺席为空字符串。 */
  purpose: string;
  /** 第一条需求之前、Purpose 之外的内容（如 `## Requirements` 下的引言）；缺席为空字符串。 */
  intro: string;
  requirements: SpecRequirement[];
  /** 第一条需求之后、不属任何需求段的内容（自 `## ` 标题起的其他区段）；缺席为空字符串。 */
  appendix: string;
}

/** 封存流程写进新规格 Purpose 的占位前缀；与引擎 `lifecycle::model::PURPOSE_TBD_PREFIX` 逐字一致
 *（specSections.test.ts 读源文件对齐）。 */
export const PURPOSE_TBD_PREFIX = "TBD - created by archiving";

const REQUIREMENT_RE = /^### Requirement:\s*(.*?)\s*$/;
const SCENARIO_RE = /^#### Scenario:\s*(.*?)\s*$/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

/** 围栏行：3 个以上 ` 或 ~（容忍前导空白），其后为 info 字符串。 */
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** 逐行标记是否位于 fenced code block（围栏行自身视为围栏内）。收尾围栏须与开头同字符、
 * 不短于开头且其后只有空白——较短或另一种字符的围栏行是内容（嵌套围栏）。docModel 的
 * 章节与列点解析共用。 */
export function fenceFlags(lines: string[]): boolean[] {
  let open: string | null = null;
  return lines.map((l) => {
    const m = FENCE_RE.exec(l);
    if (open === null) {
      if (m) open = m[1];
      return m !== null;
    }
    if (m && m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === "") open = null;
    return true;
  });
}

/** `<!-- @trace … -->` 区块内的 `key: value` 行。 */
function traceField(block: string[], key: string): string | null {
  for (const line of block) {
    const m = new RegExp(`^\\s*${key}:\\s*(\\S.*?)\\s*$`).exec(line);
    if (m) return m[1];
  }
  return null;
}

/** 一条需求的行（标题行之后到段尾）切成 body、scenarios 与 trace。 */
function parseRequirement(title: string, lines: string[], inFence: boolean[]): SpecRequirement {
  const body: string[] = [];
  const scenarios: { title: string; lines: string[] }[] = [];
  let trace: SpecRequirement["trace"] = null;
  let traceBlock: string[] | null = null;
  lines.forEach((line, i) => {
    if (!traceBlock && !inFence[i] && /^\s*<!--\s*@trace\b/.test(line)) traceBlock = [];
    if (traceBlock) {
      traceBlock.push(line);
      if (line.includes("-->")) {
        const source = traceField(traceBlock, "source");
        const updated = traceField(traceBlock, "updated");
        if (source) trace = { source, updated: updated ? (DATE_RE.exec(updated)?.[0] ?? updated) : null };
        traceBlock = null;
      }
      return;
    }
    if (!inFence[i]) {
      if (line.trim() === "---") return;
      // 只认 `#### Scenario:` 为边界——正式规格的 h4 皆为 Scenario，其他 h4 原样留在所在段。
      const sc = SCENARIO_RE.exec(line);
      if (sc) {
        scenarios.push({ title: sc[1], lines: [] });
        return;
      }
    }
    (scenarios[scenarios.length - 1]?.lines ?? body).push(line);
  });
  return {
    title,
    body: body.join("\n").trim(),
    scenarios: scenarios.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() })),
    trace,
  };
}

/**
 * 以 `### Requirement:` 行切段（design D1）。第一段之前取 `## Purpose` 区段；每段自标题行
 * 到下一个需求标题或 `## ` 标题为止。不属 Purpose 与需求段的内容不丢：`# ` 标题与
 * `## Requirements` 标题行之外，第一段之前的收进 intro、之后的收进 appendix。没有任何需求
 * 标题回 null——调用端整篇以单一 markdown 查看退回。
 */
export function parseSpecSections(markdown: string): SpecSections | null {
  const lines = markdown.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const isRequirement = (i: number) => !inFence[i] && REQUIREMENT_RE.test(lines[i]);
  // 区段终点：下一个需求标题或 `## ` 标题（围栏外）。
  const sectionEnd = (from: number) => {
    for (let i = from; i < lines.length; i++) {
      if (isRequirement(i) || (!inFence[i] && lines[i].startsWith("## "))) return i;
    }
    return lines.length;
  };
  const starts = lines.flatMap((_, i) => (isRequirement(i) ? [i] : []));
  if (starts.length === 0) return null;
  const p = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === "## Purpose");
  // 已归属的行：文档标题、`## Requirements` 标题行、Purpose 区段与各需求段。
  const used = lines.map((l, i) => !inFence[i] && (/^# /.test(l) || l.trimEnd() === "## Requirements"));
  const claim = (from: number, to: number) => used.fill(true, from, to);
  const purposeEnd = p < 0 ? -1 : sectionEnd(p + 1);
  if (p >= 0) claim(p, purposeEnd);
  const requirements = starts.map((s) => {
    const end = sectionEnd(s + 1);
    claim(s, end);
    const title = REQUIREMENT_RE.exec(lines[s])![1];
    return parseRequirement(title, lines.slice(s + 1, end), inFence.slice(s + 1, end));
  });
  const rest = (from: number, to: number) =>
    lines.slice(from, to).filter((_, i) => !used[from + i]).join("\n").trim();
  return {
    purpose: p < 0 ? "" : lines.slice(p + 1, purposeEnd).join("\n").trim(),
    intro: rest(0, starts[0]),
    requirements,
    appendix: rest(starts[0], lines.length),
  };
}

/** 最小 hast 节点视图（不引入类型套件相依）。 */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const KEYWORD_RE = /\b(SHALL NOT|SHALL|MUST NOT|MUST)\b/g;

/** 一个文本节点切成文本与 `<code class="spec-kw">` 交错的节点；无关键字回 null。 */
function splitKeywords(value: string): HastNode[] | null {
  const out: HastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(KEYWORD_RE)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "element",
      tagName: "code",
      properties: { className: ["spec-kw"] },
      children: [{ type: "text", value: m[0] }],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/**
 * rehype 插件（design D1）：把文本节点中的 `SHALL NOT`／`SHALL`／`MUST NOT`／`MUST`（整词）包成
 * `<code class="spec-kw">`；行内 code 与代码区块内不处理。只标示、不改来源。
 */
export function rehypeSpecKeywords() {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre")) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return splitKeywords(child.value) ?? [child];
      walk(child);
      return [child];
    });
  };
  return walk;
}

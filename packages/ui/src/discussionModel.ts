// 讨论记录的结构解析（desktop-discussion-doc-views design D1）：区段、轮、结论字段、背景收尾行与文中名称；分刀由
// 引擎解析（discussion-cuts-from-engine），这里只把引擎的刀对回结论的细节列。
// 全部是纯函数、不碰 React；形状不符时回 null、空数组或整条当一般列（逐项降级），不抛错——调用端照 Markdown 排。
// 记录格式由引擎（specseal-core discuss）与 discuss 技能拥有：区段与轮标题的切分规则与引擎逐字同源。
import type { DiscussionCut } from "./adapter";
import { itemMarkdown, parseListItems, type ListBlock, type ListItem } from "./docModel";

/** 讨论记录的三个标准区段。 */
export interface DiscussionSections {
  context: string;
  rounds: string;
  conclusion: string;
}

/** 结构标题白名单——与引擎（specseal-core discuss）同一条规则：
 * 只有这三个整行标题是区段边界，轮内文的其他「## 」行不得截断区段。 */
const STRUCTURAL_HEADERS: readonly string[] = ["## Context", "## Rounds", "## Conclusion"];

/** Fenced code block 围栏行（``` 或 ~~~ 开头；容忍前导空白）——围栏内的行不是结构。 */
function isFenceLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("```") || t.startsWith("~~~");
}

/** 逐行标记是否位于 fenced code block（围栏行自身视为围栏内）。 */
function fenceFlags(lines: string[]): boolean[] {
  let fence = false;
  return lines.map((l) => {
    if (isFenceLine(l)) {
      fence = !fence;
      return true;
    }
    return fence;
  });
}

/** 区段边界：结构标题白名单＋pre-scaffold「## Round 」前缀容忍（与引擎同一条规则）。 */
function isSectionBoundary(line: string): boolean {
  return STRUCTURAL_HEADERS.includes(line) || line.startsWith("## Round ");
}

/**
 * 把讨论记录全文按 `## Context`／`## Rounds`／`## Conclusion` 切分。
 * 任一区段缺失（手写、pre-scaffold 格式）回 `null`——调用端整篇以单一查看退回。
 */
export function splitDiscussionSections(text: string): DiscussionSections | null {
  const lines = text.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const body = (name: string): string | null => {
    const start = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === `## ${name}`);
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (!inFence[i] && isSectionBoundary(lines[i].trimEnd())) {
        end = i;
        break;
      }
    }
    return lines.slice(start + 1, end).join("\n");
  };
  const context = body("Context");
  const rounds = body("Rounds");
  const conclusion = body("Conclusion");
  if (context === null || rounds === null || conclusion === null) return null;
  return { context, rounds, conclusion };
}

/** 轮字段白名单——scaffold 固定四词，其余粗体前缀按内文照排。 */
export type RoundLabel = "Focus" | "Position" | "Ruled out" | "Open";
export const ROUND_LABELS: readonly RoundLabel[] = ["Focus", "Position", "Ruled out", "Open"];

/** 讨论的一轮：卡头（轮次/mode/日期）＋字段（缺席字段无该键）。 */
export interface DiscussionRound {
  round: number;
  mode: string;
  date: string;
  /** 首个字段标签前的内文（scaffold 记录通常为空）。 */
  lead: string;
  fields: Partial<Record<RoundLabel, string>>;
}

/** 字段切分结果：首个标签前的内文（lead）＋标签→内文对应。 */
export interface LabeledFields<L extends string> {
  lead: string;
  fields: Partial<Record<L, string>>;
}

/**
 * 以标签白名单切字段（轮与结论共用）：行首「**<Label>**:」起新字段，
 * 其余行（含非白名单的粗体前缀行）归属当前字段；首个标签前的内容归 lead。
 */
export function splitLabeledFields<L extends string>(lines: string[], labels: readonly L[]): LabeledFields<L> {
  const re = new RegExp(`^\\*\\*(${labels.join("|")})\\*\\*:\\s?(.*)$`);
  const fields: Partial<Record<L, string>> = {};
  let lead = "";
  let field: L | null = null;
  const buf: string[] = [];

  const flush = () => {
    const content = buf.join("\n").trim();
    if (field) fields[field] = content;
    else lead = content;
    buf.length = 0;
  };

  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      flush();
      field = m[1] as L;
      buf.push(m[2]);
      continue;
    }
    buf.push(line);
  }
  flush();
  return { lead, fields };
}

/**
 * 把 Rounds 区段全文切成轮数组（行扫描解析 scaffold）。
 * 每个 `### ` 标题必须符合「### Round N — <mode> (<date>)」；任一不符、或首轮前
 * 出现非注解内容即回 `null`——调用端整篇以单一 markdown 查看退回。零轮回空数组。
 */
export function splitRounds(text: string): DiscussionRound[] | null {
  const heading = /^### Round (\d+) — (.+?) \((.+)\)\s*$/;
  const rounds: { round: number; mode: string; date: string; body: string[] }[] = [];
  let current: { body: string[] } | null = null;

  const lines = text.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  for (const [i, line] of lines.entries()) {
    // 围栏内的行不是轮标题——归当前轮内文（首轮前出现则按既有规则整篇退回）。
    if (!inFence[i] && line.startsWith("### ")) {
      const m = heading.exec(line);
      if (!m) return null;
      current = { body: [] };
      rounds.push({ round: Number(m[1]), mode: m[2], date: m[3], body: current.body });
      continue;
    }
    if (!current) {
      // 首轮前仅容许空行与 scaffold 注解；其余内容代表非标准记录，整篇退回。
      if (line.trim() === "" || /^<!--.*-->\s*$/.test(line.trim())) continue;
      return null;
    }
    current.body.push(line);
  }
  return rounds.map((r) => ({ round: r.round, mode: r.mode, date: r.date, ...splitLabeledFields(r.body, ROUND_LABELS) }));
}

/** 结论字段白名单——conclude scaffold 固定六词。 */
export type ConclusionLabel = "Decision" | "Rationale" | "Rejected alternatives" | "Deferred" | "Capture to" | "Next";
export const CONCLUSION_LABELS: readonly ConclusionLabel[] = [
  "Decision",
  "Rationale",
  "Rejected alternatives",
  "Deferred",
  "Capture to",
  "Next",
];

/** 「none」起头（`None.`、`none — …`；`none-legacy` 不算）。 */
const NONE_RE = /^none(?![\w-])/i;

/** 背景的 `Prior discussions:` 行列出的先前讨论数；缺行、`none` 开头（`None.`、`none — …`）或切不出名称为 null。
 * 与背景的先前讨论签同一套名单切法（`parseContextMeta`）。 */
export function countPriorDiscussions(context: string): number | null {
  const prior = parseContextMeta(context).prior;
  return prior && prior.length > 0 ? prior.length : null;
}

const unique = (items: string[]) => [...new Set(items)];

/** 结论六字段；一个白名单字段都没有时回 null（调用端整篇 Markdown 退回）。 */
export function parseConclusion(text: string): LabeledFields<ConclusionLabel> | null {
  const parsed = splitLabeledFields(text.split(/\r?\n/), CONCLUSION_LABELS);
  return Object.keys(parsed.fields).length > 0 ? parsed : null;
}

/** Position 与 Decision：第一段散文为定论句（首段即列点时为空）、其后顶层列点依序为细节；
 * 列点之后的散文段也算一条细节，不丢内容。 */
export function splitVerdict(md: string): { verdict: string; details: ListItem[] } {
  const blocks = parseListItems(md);
  const lead = blocks[0]?.kind === "prose" ? blocks[0].text : "";
  const details = blocks
    .slice(lead ? 1 : 0)
    .flatMap((b): ListItem[] => (b.kind === "list" ? b.items : [{ text: b.text, body: "" }]));
  return { verdict: lead, details };
}

/** 分刀卡：识别签、范围句、变更名签、尚未转出的变更名与卡内细线列——判定全部取自引擎的刀（`DiscussionCut`）。 */
export interface CutCard {
  id: string;
  title: string;
  names: string[];
  /** 变更名写在粗体内（讨论技能的写法 **cut N `change-name`**）；false 时名称取自粗体之后，可能混有识别字或文件名。 */
  namesInBold: boolean;
  /** `names` 中不在 `promoted_to` 的名称（引擎判定）。 */
  unpromoted: string[];
  items: string[];
}

/** 引擎的刀依序对回决定细节：每把刀认领第一个尚未被认领、首行等于 `line` 的细节列，认领到的列自 rest 移除；
 * 卡内细线列为说明（非空时）接该列的嵌套内容。找不到对应列的刀仍成卡，只有说明（该列留在 rest，不丢内容）。 */
export function cutCards(details: ListItem[], cuts: DiscussionCut[]): { cuts: CutCard[]; rest: ListItem[] } {
  const claimed = new Set<number>();
  const cards = cuts.map((cut): CutCard => {
    const at = details.findIndex((item, i) => !claimed.has(i) && item.text.trim() === cut.line);
    if (at >= 0) claimed.add(at);
    return {
      id: cut.cut,
      title: cut.title,
      names: cut.changes,
      namesInBold: cut.changesInBold,
      unpromoted: cut.unpromoted,
      items: [...(cut.note ? [cut.note] : []), ...(at >= 0 ? blockRows(parseListItems(details[at].body)) : [])],
    };
  });
  return { cuts: cards, rest: details.filter((_, i) => !claimed.has(i)) };
}

/** 刀的转出判定（刀卡与未转出提示框共用，两处不会分岔）：只读引擎字段——变更名不在粗体内（没有名称，或旧式
 * 刀列把名称写在粗体之后）时无从判定。 */
export function cutPromotion(cut: CutCard): "promoted" | "partial" | "none" | "unknown" {
  if (!cut.namesInBold) return "unknown";
  if (cut.unpromoted.length === 0) return "promoted";
  return cut.unpromoted.length === cut.names.length ? "none" : "partial";
}

/** 否决与搁置的一列：第一个「——」或前后带空白的「 — 」（discuss 技能档写「option — why it lost」）切方案与
 * 落败理由；切不到时整条为方案。提案的替代方案走 docModel 的 splitAlternative，不经这里。 */
export function splitOption(text: string): { option: string; reason: string | null } {
  const m = /——|\s—\s/.exec(text);
  if (!m) return { option: text.trim(), reason: null };
  return { option: text.slice(0, m.index).trim(), reason: text.slice(m.index + m[0].length).trim() || null };
}

/** 以顶层（反引号与括号之外）的分隔符切段。 */
function splitTopLevel(text: string, separators: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let tick = false;
  for (const ch of text) {
    if (ch === "`") tick = !tick;
    else if (!tick && "（(「".includes(ch)) depth += 1;
    else if (!tick && "）)」".includes(ch)) depth = Math.max(0, depth - 1);
    if (!tick && depth === 0 && separators.includes(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 每条列点与其间的散文段各一列（不丢内容）。 */
function blockRows(blocks: ListBlock[]): string[] {
  return blocks.flatMap((b) => (b.kind === "list" ? b.items.map(itemMarkdown) : [b.text]));
}

/** Ruled out、Open、Rejected alternatives、Deferred 的逐条：有列点时每条列点（与其间的散文段）一列，
 * 否则以顶层的「；」／「;」切段。 */
export function splitRows(md: string): string[] {
  const blocks = parseListItems(md);
  if (blocks.some((b) => b.kind === "list")) return blockRows(blocks);
  return splitTopLevel(md, "；;");
}

/** 记录去向的签：以顶层（括号之外）的顿号与逗号切项、去掉反引号；任一项含句号或换行（整段散文）时回 null。 */
export function captureTargets(md: string): string[] | null {
  const items = splitTopLevel(md, "、,，").map((s) => s.replace(/`/g, "").trim());
  return items.length === 0 || items.some((s) => /[。\n]/.test(s)) ? null : items;
}

/** 收敛标记：「无」或 none 起头、其后紧接标点、空白或结尾（「无法…」「none-legacy」不算）。 */
const OPEN_NONE_RE = /^(?:无|none)(?![\p{L}\p{N}_-])/iu;

/** 待决：收敛标记时整条原文一列（「无：写入结论」），否则逐条。 */
export function openItems(md: string): { none: boolean; items: string[] } {
  const text = md.trim();
  if (OPEN_NONE_RE.test(text)) return { none: true, items: [text] };
  return { none: false, items: splitRows(text) };
}

/** 轮的 mode（首次出现序、字符串透传）与日期统计。 */
export function roundStats(rounds: DiscussionRound[]): {
  modes: { mode: string; count: number }[];
  days: number;
  first: string | null;
  last: string | null;
} {
  const modes: { mode: string; count: number }[] = [];
  for (const r of rounds) {
    const hit = modes.find((m) => m.mode === r.mode);
    if (hit) hit.count += 1;
    else modes.push({ mode: r.mode, count: 1 });
  }
  return {
    modes,
    days: new Set(rounds.map((r) => r.date)).size,
    first: rounds[0]?.date ?? null,
    last: rounds[rounds.length - 1]?.date ?? null,
  };
}

/** 背景收尾四行：名单行缺席为 null、`none` 为空数组；来源文档缺席为 null、`none` 为空字符串。 */
export interface ContextMeta {
  specs: string[] | null;
  changes: string[] | null;
  prior: string[] | null;
  sourceDoc: string | null;
  /** 剥掉四行之后的内文。 */
  body: string;
}

const META_LINES = {
  "Related specs:": "specs",
  "Related changes:": "changes",
  "Prior discussions:": "prior",
} as const;
const SOURCE_DOC = "Source doc:";

/** 英数起头的名称：以连字号串起英数段或纯汉字段（`config-context-与-rules-gui-编辑`）；英数段后紧接的中文
 * 不算进名称（`desktop-detail-doc-tree定义了…`）。名单与指令参数共用。 */
const NAME_SRC = String.raw`[A-Za-z0-9][\w.]*(?:-(?:[\w.]+|\p{Script=Han}+))*`;
const NAME_HEAD_RE = new RegExp(`^${NAME_SRC}`, "u");

/** 名单：括号备注换成空白（名称止于括号），以逗号、顿号、分号切项，每项取冒号前的第一个 token
 * （`add-copilot-tool: desktop-config`）；英数起头时只取名称段，句尾的句点拿掉。 */
function nameList(value: string): string[] {
  const list = value.replace(/[（(][^）)]*[）)]/g, " ").trim();
  if (NONE_RE.test(list)) return [];
  return unique(
    list
      .split(/[,，、;；]/)
      .map((item) => {
        const token = item.split(/[:：]/)[0].trim().split(/\s+/)[0];
        return (NAME_HEAD_RE.exec(token)?.[0] ?? token).replace(/[。.]+$/, "");
      })
      .filter(Boolean),
  );
}

/** 剥掉围栏外、行首（容许前导空白）的 `Related specs:`／`Related changes:`／`Prior discussions:`／`Source doc:` 四行。 */
export function parseContextMeta(context: string): ContextMeta {
  const lines = context.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const meta: ContextMeta = { specs: null, changes: null, prior: null, sourceDoc: null, body: "" };
  const kept = lines.filter((line, i) => {
    if (inFence[i]) return true;
    const t = line.trimStart();
    if (t.startsWith(SOURCE_DOC)) {
      const value = t.slice(SOURCE_DOC.length).trim();
      meta.sourceDoc = NONE_RE.test(value) ? "" : value;
      return false;
    }
    const prefix = (Object.keys(META_LINES) as (keyof typeof META_LINES)[]).find((p) => t.startsWith(p));
    if (!prefix) return true;
    meta[META_LINES[prefix]] = nameList(t.slice(prefix.length));
    return false;
  });
  meta.body = kept.join("\n").trim();
  return meta;
}

/** 宿主清单里的名称：比对背景内文与收尾行用。 */
export interface ContextNames {
  specs: string[];
  active: string[];
  archived: string[];
  /** 其他讨论的 slug（本身由 `self` 排除）。 */
  discussions: string[];
  self?: string;
}

/** 背景的关联：收尾行与内文命中的联集（在途与已封存变更只收宿主清单里有的名称）。 */
export interface ContextRelations {
  specs: string[];
  changes: string[];
  archived: string[];
  prior: string[];
  /** 内文命中（名称签用），依种类。 */
  hits: { specs: string[]; changes: string[]; archived: string[]; discussions: string[] };
}

/** 背景关联的单一推导：ContextDoc 的关联列与名称签、页的数字砖共用。 */
export function contextRelations(meta: ContextMeta, names: ContextNames): ContextRelations {
  const discussions = names.discussions.filter((slug) => slug !== names.self);
  const hits = {
    specs: matchNames(meta.body, names.specs),
    changes: matchNames(meta.body, names.active),
    archived: matchNames(meta.body, names.archived),
    discussions: matchNames(meta.body, discussions),
  };
  const listed = meta.changes ?? [];
  return {
    specs: unique([...(meta.specs ?? []), ...hits.specs]),
    changes: unique([...listed.filter((n) => names.active.includes(n)), ...hits.changes]),
    archived: unique([...listed.filter((n) => names.archived.includes(n)), ...hits.archived]),
    prior: unique([...(meta.prior ?? []), ...hits.discussions]),
    hits,
  };
}

/** 背景文档的单一推导（ContextDoc 与页的数字砖共用）：收尾行、关联与比对所用的名称清单。 */
export interface ContextModel {
  meta: ContextMeta;
  rel: ContextRelations;
  names: ContextNames;
}

export function contextModel(context: string, names: ContextNames): ContextModel {
  const meta = parseContextMeta(context);
  return { meta, rel: contextRelations(meta, names), names };
}

/** 引言段：围栏外第一个空行之前的散文；第一段是列点、标题、围栏、引言或表格时引言为空、全文进 rest。 */
export function splitLead(body: string): { lead: string; rest: string } {
  const lines = body.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start += 1;
  if (start === lines.length || /^\s*(?:[-*+]\s|\d+[.)]\s|#|>|\||```|~~~)/.test(lines[start])) {
    return { lead: "", rest: body };
  }
  let end = start;
  while (end < lines.length && lines[end].trim()) end += 1;
  return { lead: lines.slice(start, end).join("\n").trim(), rest: lines.slice(end).join("\n").trim() };
}

/** 名称边界：前后皆非英数、连字号与底线（中文名称也用这条）。 */
const isBoundary = (ch: string | undefined) => ch === undefined || !/[A-Za-z0-9_-]/.test(ch);

/** 一段纯文本中名称的命中位置：长名优先、已被长名占走的范围不再命中，依出现序。Markdown 的名称签插件共用。 */
export function nameSpans(text: string, names: string[]): { name: string; start: number; end: number }[] {
  const taken = new Array<boolean>(text.length).fill(false);
  const spans: { name: string; start: number; end: number }[] = [];
  for (const name of unique(names.filter(Boolean)).sort((a, b) => b.length - a.length)) {
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const end = at + name.length;
      if (!isBoundary(text[at - 1]) || !isBoundary(text[end]) || taken.slice(at, end).some(Boolean)) continue;
      taken.fill(true, at, end);
      spans.push({ name, start: at, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** 围栏与行内反引号之外的名称命中，依首次出现序去重。 */
export function matchNames(text: string, names: string[]): string[] {
  const lines = text.split("\n");
  const inFence = fenceFlags(lines);
  // 代码换成等长空白：位置不动、边界照算。
  const plain = lines
    .map((l, i) => (inFence[i] ? " ".repeat(l.length) : l.replace(/`[^`]*`/g, (m) => " ".repeat(m.length))))
    .join("\n");
  return unique(nameSpans(plain, names).map((s) => s.name));
}

const COMMAND_RE = new RegExp(String.raw`/specseal-[a-z-]+(?:\s+(?:--[a-z-]+|${NAME_SRC}))*`, "gu");

/** 下一步里的 `/specseal-*` 指令（含旗标与参数；反引号内外皆算；句尾句点不算），去重保序。 */
export function commandChips(md: string): string[] {
  return unique((md.match(COMMAND_RE) ?? []).map((command) => command.replace(/\.+$/, "")));
}

// 变更文档的结构解析（desktop-change-doc-views design D1）：章节切分与各章节的列点、路径、决策、
// 任务三层等形状。全部是纯函数、不碰 React；形状不符时回 null 或把该列标成一般列（逐项降级），
// 不抛错——调用端照 Markdown 排。逐行扫描且认得 fenced code block（与 specSections 共用 fenceFlags）。
import { fenceFlags } from "./specSections";

/** 已知模板章节（h2）→ i18n key：三型提案模板与设计模板的联集（白名单留在前端、不读 schema）。 */
const SECTION_KEYS: Record<string, string> = {
  Why: "sections.why",
  "What Changes": "sections.whatChanges",
  "Non-Goals": "sections.nonGoals",
  Capabilities: "sections.capabilities",
  Impact: "sections.impact",
  Problem: "sections.problem",
  "Root Cause": "sections.rootCause",
  "Proposed Solution": "sections.proposedSolution",
  "Success Criteria": "sections.successCriteria",
  Summary: "sections.summary",
  Motivation: "sections.motivation",
  "Alternatives Considered": "sections.alternatives",
  Context: "sections.context",
  "Goals / Non-Goals": "sections.goalsNonGoals",
  Decisions: "sections.decisions",
  "Implementation Contract": "sections.contract",
  "Risks / Trade-offs": "sections.risks",
  "Migration Plan": "sections.migration",
  "Open Questions": "sections.openQuestions",
};

/** Capabilities 段内的 h3 模板词（子段）。 */
const SUB_SECTION_KEYS: Record<string, string> = {
  "New Capabilities": "sections.newCapabilities",
  "Modified Capabilities": "sections.modifiedCapabilities",
};

export interface DocSubsection {
  key: string;
  title: string;
  content: string;
}

/** 一个二级标题段：白名单命中时 key 为 i18n 键，白名单外为 null（title 为原文）。 */
export interface H2Section {
  key: string | null;
  title: string;
  /** 段内文（不含标题行；Capabilities 段为第一个子段之前的内文）。 */
  content: string;
  /** Capabilities 段的 New／Modified 子段；其他段为空数组。 */
  subsections: DocSubsection[];
}

export interface SplitDoc {
  /** 第一个 h2 之前的内容。 */
  preamble: string;
  sections: H2Section[];
}

/** 每个 `## ` 行开一段；没有任何 h2 回 null（调用端整篇 Markdown 退回）。 */
export function splitH2Sections(text: string): SplitDoc | null {
  const lines = text.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const preamble: string[] = [];
  const sections: { key: string | null; title: string; lines: string[]; subs: { key: string; title: string; lines: string[] }[] }[] = [];
  lines.forEach((line, i) => {
    const h2 = inFence[i] ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      const title = h2[1].replace(/\s*\(optional\)\s*$/i, "").trim();
      sections.push({ key: SECTION_KEYS[title] ?? null, title, lines: [], subs: [] });
      return;
    }
    const cur = sections[sections.length - 1];
    if (!cur) {
      preamble.push(line);
      return;
    }
    const h3 = cur.key === "sections.capabilities" && !inFence[i] ? /^###\s+(.+?)\s*$/.exec(line) : null;
    const subKey = h3 ? SUB_SECTION_KEYS[h3[1]] : undefined;
    if (h3 && subKey) {
      cur.subs.push({ key: subKey, title: h3[1], lines: [] });
      return;
    }
    (cur.subs[cur.subs.length - 1]?.lines ?? cur.lines).push(line);
  });
  if (sections.length === 0) return null;
  const join = (ls: string[]) => ls.join("\n").trim();
  return {
    preamble: join(preamble),
    sections: sections.map((s) => ({
      key: s.key,
      title: s.title,
      content: join(s.lines),
      subsections: s.subs.map((sub) => ({ key: sub.key, title: sub.title, content: join(sub.lines) })),
    })),
  };
}

/** 顶层列点：首行文本与其后的续行／嵌套行（已去掉共同缩进）。 */
export interface ListItem {
  text: string;
  body: string;
}

/** 一段内容依出现序切成列点群与 prose 段。 */
export type ListBlock = { kind: "list"; items: ListItem[] } | { kind: "prose"; text: string };

const ITEM_RE = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n").trim();
}

/** 顶层列点（`- `／`* `／`1. `）与 prose 段依序切开；嵌套与缩进续行归入该项 body。 */
export function parseListItems(md: string): ListBlock[] {
  const lines = md.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const blocks: ListBlock[] = [];
  let prose: string[] = [];
  let list: { text: string; body: string[] }[] | null = null;
  let lastBlank = false;
  // 围栏跟着开头行走：开头行缩进且在列点内＝归该项，否则归 prose。
  let fenceTarget: string[] | null = null;
  const flushProse = () => {
    const text = prose.join("\n").trim();
    if (text) blocks.push({ kind: "prose", text });
    prose = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", items: list.map((it) => ({ text: it.text, body: dedent(it.body) })) });
    list = null;
  };
  const current = () => (list ? list[list.length - 1] : null);
  lines.forEach((line, i) => {
    const blank = line.trim() === "";
    const indented = /^\s/.test(line);
    if (inFence[i]) {
      if (!fenceTarget) {
        if (current() && indented) fenceTarget = current()!.body;
        else {
          flushList();
          fenceTarget = prose;
        }
      }
      fenceTarget.push(line);
      lastBlank = false;
      return;
    }
    fenceTarget = null;
    const item = indented ? null : ITEM_RE.exec(line);
    if (item) {
      flushProse();
      list = list ?? [];
      list.push({ text: item[1].trim(), body: [] });
    } else if (blank) {
      (current()?.body ?? prose).push(line);
    } else if (current() && (indented || !lastBlank)) {
      current()!.body.push(line);
    } else {
      flushList();
      prose.push(line);
    }
    lastBlank = blank;
  });
  flushList();
  flushProse();
  return blocks;
}

/** 各段列点收成一串（计数与逐列渲染用）。 */
export function listItemsOf(blocks: ListBlock[]): ListItem[] {
  return blocks.flatMap((b) => (b.kind === "list" ? b.items : []));
}

/** 列点的完整内文：首行加续行。 */
export function itemMarkdown(item: ListItem): string {
  return item.body ? `${item.text}\n${item.body}` : item.text;
}

/** 替代方案一列：首个「——」切方案与落败理由；切不到时整条为方案。 */
export function splitAlternative(text: string): { option: string; reason: string | null } {
  const i = text.indexOf("——");
  if (i < 0) return { option: text, reason: null };
  return { option: text.slice(0, i).trim(), reason: text.slice(i + 2).trim() || null };
}

/** 「(none)」「无」「（无）」这类空值标记。 */
const NONE_RE = /^[（(]?\s*(none|无)\s*[)）]?[。.]?$/i;
const CAP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 以「、」「,」「，」切项，括号与引号内的分隔符不切。 */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if ("（(「".includes(ch)) depth += 1;
    else if ("）)」".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && "、,，".includes(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.replace(/`/g, "").trim().replace(/。$/, "")).filter(Boolean);
}

/** 一个项：本体与紧接的括号附注（如「a.ts（集成测试）」）。本体含空白或其后还有文本时回 null。 */
function withNote(token: string): { head: string; note: string | null } | null {
  const m = /^([^\s（(]+)\s*(?:[（(](.*)[）)])?$/.exec(token);
  return m ? { head: m[1], note: m[2]?.trim() || null } : null;
}

export interface ImpactPath {
  path: string;
  note: string | null;
}

export interface ImpactData {
  /** 「Affected specs:」列：names 为能力名（不成形为 null，照 raw 原文显示）；整列缺席为 null。 */
  specs: { names: string[] | null; raw: string } | null;
  code: { new: ImpactPath[]; modified: ImpactPath[]; removed: ImpactPath[] };
  /** 两列之外的其他列点（照一般列排）。 */
  notes: ListItem[];
}

/** Impact 段：「Affected code:」之下的 New／Modified／Removed 三组路径是必要形状，缺了或路径不成形回 null。 */
export function parseImpact(md: string): ImpactData | null {
  let specs: ImpactData["specs"] = null;
  let code: ImpactData["code"] | null = null;
  const notes: ListItem[] = [];
  for (const block of parseListItems(md)) {
    if (block.kind === "prose") {
      notes.push({ text: block.text, body: "" });
      continue;
    }
    for (const item of block.items) {
      const spec = /^Affected specs\s*[:：]\s*(.*)$/i.exec(item.text);
      const affected = /^Affected code\s*[:：]\s*$/i.exec(item.text);
      if (spec) {
        const raw = spec[1].trim();
        if (NONE_RE.test(raw)) specs = { names: [], raw };
        else {
          const heads = splitTopLevel(raw).map(withNote);
          const ok = heads.length > 0 && heads.every((h) => h !== null && CAP_NAME_RE.test(h.head));
          specs = { names: ok ? heads.map((h) => h!.head) : null, raw };
        }
      } else if (affected) {
        const groups: ImpactData["code"] = { new: [], modified: [], removed: [] };
        const subs = listItemsOf(parseListItems(item.body));
        if (subs.length === 0) return null;
        for (const sub of subs) {
          const m = /^(New|Modified|Removed)\s*[:：]\s*(.*)$/i.exec(sub.text);
          if (!m) return null;
          const value = [m[2], sub.body].filter(Boolean).join(" ").trim();
          if (NONE_RE.test(value)) continue;
          for (const token of splitTopLevel(value)) {
            const p = withNote(token);
            if (!p) return null;
            groups[m[1].toLowerCase() as keyof ImpactData["code"]].push({ path: p.head, note: p.note });
          }
        }
        code = groups;
      } else notes.push(item);
    }
  }
  return code ? { specs, code, notes } : null;
}

/** 能力列：name 为能力名（不成形的列为 null，整列当一般列）。 */
export interface CapabilityRow {
  name: string | null;
  text: string;
}

/** Capabilities 子段：每个「`name`: 说明」列点；「(none)」为空。 */
export function parseCapabilities(md: string): CapabilityRow[] {
  return parseListItems(md).flatMap((block): CapabilityRow[] => {
    if (block.kind === "prose") return NONE_RE.test(block.text) ? [] : [{ name: null, text: block.text }];
    return block.items.map((item) => {
      const m = /^`?([a-z0-9][a-z0-9-]*)`?\s*[:：]\s*(.*)$/.exec(item.text);
      if (!m) return { name: null, text: itemMarkdown(item) };
      return { name: m[1], text: [m[2], item.body].filter(Boolean).join("\n") };
    });
  });
}

/** 提案 Capabilities 段「New Capabilities」列出的能力名——作用中变更里它们还没有正式规格。 */
export function newCapabilities(proposal: string): string[] {
  const caps = splitH2Sections(proposal)?.sections.find((s) => s.key === "sections.capabilities");
  const sub = caps?.subsections.find((s) => s.key === "sections.newCapabilities");
  return parseCapabilities(sub?.content ?? "").flatMap((r) => (r.name ? [r.name] : []));
}

const GOALS_RE = /^\s*\*\*Goals\s*[:：]?\*\*\s*[:：]?\s*(.*)$/i;
const NON_GOALS_RE = /^\s*\*\*Non-Goals\s*[:：]?\*\*\s*[:：]?\s*(.*)$/i;

/** Goals / Non-Goals 段：以两个粗体标签切两栏（各为 Markdown 原文）；缺任一标签回 null。 */
export function parseGoalsNonGoals(md: string): { intro: string; goals: string; nonGoals: string } | null {
  const lines = md.split(/\r?\n/);
  const g = lines.findIndex((l) => GOALS_RE.test(l));
  const n = lines.findIndex((l) => NON_GOALS_RE.test(l));
  if (g < 0 || n < 0 || n < g) return null;
  const column = (labelLine: string, re: RegExp, rest: string[]) =>
    [re.exec(labelLine)![1], ...rest].join("\n").trim();
  return {
    intro: lines.slice(0, g).join("\n").trim(),
    goals: column(lines[g], GOALS_RE, lines.slice(g + 1, n)),
    nonGoals: column(lines[n], NON_GOALS_RE, lines.slice(n + 1)),
  };
}

export interface DecisionData {
  /** 标题开头的 D 编号；无则 null。 */
  id: string | null;
  /** 去掉 D 编号的标题。 */
  title: string;
  /** 卡内顶层列点数。 */
  bullets: number;
  body: string;
}

/** Decisions 段：每个 `### ` 开一张卡；第一张之前的内容为 intro。 */
export function parseDecisions(md: string): { intro: string; cards: DecisionData[] } {
  const lines = md.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const intro: string[] = [];
  const cards: { heading: string; lines: string[] }[] = [];
  lines.forEach((line, i) => {
    const h3 = inFence[i] ? null : /^###\s+(.+?)\s*$/.exec(line);
    if (h3) cards.push({ heading: h3[1], lines: [] });
    else (cards[cards.length - 1]?.lines ?? intro).push(line);
  });
  return {
    intro: intro.join("\n").trim(),
    cards: cards.map((c) => {
      const m = /^(D\d+)\b\s*[:：.、—-]?\s*(.*)$/.exec(c.heading);
      const body = c.lines.join("\n").trim();
      return {
        id: m ? m[1] : null,
        title: m && m[2] ? m[2] : c.heading,
        bullets: listItemsOf(parseListItems(body)).length,
        body,
      };
    }),
  };
}

/** Implementation Contract：「- **键**：值」列点成键值列；有 prose 或任一列不符回 null。 */
export function parseContractRows(md: string): { key: string; value: string }[] | null {
  const blocks = parseListItems(md);
  if (blocks.length === 0 || blocks.some((b) => b.kind === "prose")) return null;
  const rows: { key: string; value: string }[] = [];
  for (const item of listItemsOf(blocks)) {
    const m = /^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/.exec(item.text);
    if (!m) return null;
    rows.push({ key: m[1], value: [m[2], item.body].filter(Boolean).join("\n") });
  }
  return rows;
}

/**
 * 风险一列：首个「→」切风险与对策（风险外围的方括号剥除）；切不到时整条为风险。风险只取首行当标题，
 * 其余行（嵌套子项、续行）接到对策之前。
 */
export function splitRisk(text: string): { risk: string; mitigation: string | null } {
  const i = text.indexOf("→");
  const head = (i < 0 ? text : text.slice(0, i)).trim();
  const bracketed = /^\[([\s\S]*)\]$/.exec(head);
  const [risk, ...rest] = (bracketed ? bracketed[1].trim() : head).split("\n");
  const mitigation = [rest.join("\n").trim(), i < 0 ? "" : text.slice(i + 1).trim()].filter(Boolean).join("\n");
  return { risk: risk.trim(), mitigation: mitigation || null };
}

export interface TaskTextParts {
  /** 描述开头的「X.Y」序号；无则 null。 */
  number: string | null;
  title: string;
  body: string | null;
  verify: string | null;
  /** 标题紧接的 design 括号里的 D 编号。 */
  decisions: string[];
  /** design 括号里 D 编号以外的文本（归入内文首行）。 */
  note: string | null;
}

/** 标题尾的「（design D1、D3；spec「…」）」或「(design D1, D3)」。 */
const DESIGN_PAREN_RE = /[（(]\s*design\s+([^）)]*)[）)]\s*$/i;

/** 描述开头的「X.Y」序号（tasks.md 的写法）。 */
const TASK_NUMBER_RE = /^(\d+(?:\.\d+)*)\s+([\s\S]*)$/;

/** 任务描述拆三层：先剥开头序号，再以首个「验证：」切验证，再以首个全角「：」切标题与内文。 */
export function splitTaskText(raw: string): TaskTextParts {
  const numbered = TASK_NUMBER_RE.exec(raw);
  const text = numbered ? numbered[2] : raw;
  const v = text.indexOf("验证：");
  const front = v < 0 ? text : text.slice(0, v);
  const verify = v < 0 ? null : text.slice(v + 3).trim() || null;
  const c = front.indexOf("：");
  let title = (c < 0 ? front : front.slice(0, c)).trim();
  const body = c < 0 ? null : front.slice(c + 1).trim() || null;
  const decisions: string[] = [];
  const notes: string[] = [];
  const paren = DESIGN_PAREN_RE.exec(title);
  if (paren) {
    title = title.slice(0, paren.index).trim();
    paren[1].split(/[；;]/).forEach((seg, i) => {
      if (i === 0) decisions.push(...(seg.match(/D\d+/g) ?? []));
      else if (seg.trim()) notes.push(seg.trim());
    });
  }
  return { number: numbered ? numbered[1] : null, title, body, verify, decisions, note: notes.join("；") || null };
}

const REMOVED_SCENARIO_RE = /^\s*<!--\s*REMOVED-SCENARIO:\s*(.*?)\s*-->\s*$/;
const BEFORE_RE = /^\s*<!--\s*BEFORE:.*-->\s*$/;

/** 取 REMOVED-SCENARIO 声明的名称，并回去掉这些行与 BEFORE 注解行的内文。 */
export function removedScenarios(block: string): { names: string[]; content: string } {
  const lines = block.split(/\r?\n/);
  const inFence = fenceFlags(lines);
  const names: string[] = [];
  const kept = lines.filter((line, i) => {
    if (inFence[i]) return true;
    const m = REMOVED_SCENARIO_RE.exec(line);
    if (m) names.push(m[1]);
    return !m && !BEFORE_RE.test(line);
  });
  return { names, content: kept.join("\n").trim() };
}

export type ScenarioStepLabel = "GIVEN" | "WHEN" | "THEN" | "AND";

const STEP_RE = /^[-*]\s+\*\*(GIVEN|WHEN|THEN|AND)\*\*\s*(.*)$/;

/** Scenario 开头的「- **WHEN** …」等列点成步骤，其后的内容（如 Example 区块）为 rest；没有步骤回 null。 */
export function splitScenarioSteps(
  body: string,
): { steps: { label: ScenarioStepLabel; text: string }[]; rest: string } | null {
  const lines = body.split(/\r?\n/);
  const steps: { label: ScenarioStepLabel; text: string }[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = STEP_RE.exec(line);
    if (m) steps.push({ label: m[1] as ScenarioStepLabel, text: m[2].trim() });
    else if (/^\s/.test(line) && steps.length > 0) steps[steps.length - 1].text += `\n${line.trim()}`;
    else break;
  }
  if (steps.length === 0) return null;
  return { steps, rest: lines.slice(i).join("\n").trim() };
}

export type FindingAxis = "Correctness" | "Standards" | "Coherence";

/** 工单描述开头的轴向前缀（「Correctness:」等）：取出轴向并去前缀；无前缀时 axis 为 null。 */
export function findingAxis(text: string): { axis: FindingAxis | null; text: string } {
  const m = /^(Correctness|Standards|Coherence)\s*[:：]\s*/.exec(text);
  return m ? { axis: m[1] as FindingAxis, text: text.slice(m[0].length) } : { axis: null, text };
}

export type ProposalShape = "bugFix" | "refactor" | "feature";

/** 提案模板形状：Problem＋Root Cause、Summary＋Motivation、Why＋What Changes；皆非为 null。 */
export function proposalShape(doc: SplitDoc): ProposalShape | null {
  const keys = new Set(doc.sections.map((s) => s.key));
  const has = (...names: string[]) => names.every((n) => keys.has(`sections.${n}`));
  if (has("problem", "rootCause")) return "bugFix";
  if (has("summary", "motivation")) return "refactor";
  if (has("why", "whatChanges")) return "feature";
  return null;
}

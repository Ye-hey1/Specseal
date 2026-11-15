#!/usr/bin/env node
// Specseal ← spec-kit 迁移脚本（尽力而为 + 人工核对清单）。
//
// 用法：node scripts/migrate-spec-kit.mjs [spec-kit 项目根，默认当前目录]
//
// 做什幺：
//   1. .specify/memory/constitution.md      → specseal/principles.md（项目宪法层）
//   2. specs/<feature>/spec.md              → specseal/specs/<feature>/spec.md
//      启发式转换：User Story → Requirement、Given/When/Then → WHEN/THEN 场景、
//      FR-xxx MUST 条目 → Requirement 条目；转不动的内容记入报告
//   3. 生成 specseal/MIGRATION-REPORT.md —— 已复制 / 已转换 / 需人工 三级清单
//   4. 结尾跑 `specseal validate` 验证产物格式合法
//
// 不做什幺：
//   - spec-kit 的 plan.md / tasks.md 不迁移（specseal 的 changes 是变更粒度，
//     不是 feature 常驻文档）；清单写进报告，人工决定是否补录为归档变更
//   - 不删除、不改动任何 spec-kit 原文档
//
// 前置：目标项目已运行 `specseal init`（脚本不代跑，避免覆盖既有工作区）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const report = { copied: [], converted: [], manual: [] };

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(join(root, ".specseal.yaml"))) {
  fail("目标项目未初始化：先运行 `specseal init`，再执行本脚本。");
}
const specify = join(root, ".specify");
const specKitSpecs = join(root, "specs");
if (!existsSync(specify) && !existsSync(specKitSpecs)) {
  fail("未找到 spec-kit 结构（.specify/ 与 specs/ 均不存在）——确认这是 spec-kit 项目。");
}

function write(relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  writeFileSync(abs, content, "utf8");
  report.copied.push(relPath);
  console.log(`  → ${relPath}`);
}

// ---------- 1) constitution → principles ----------
const constitution = join(specify, "memory", "constitution.md");
if (existsSync(constitution)) {
  const src = readFileSync(constitution, "utf8");
  write(
    "specseal/principles.md",
    [
      "# Principles",
      "",
      "> 由 spec-kit constitution 迁移而来（scripts/migrate-spec-kit.mjs）。逐条核对后，",
      "> 只保留你愿意为之 block 变更的规则，并按 Specseal 惯例重排编号。",
      "",
      src.trim(),
      "",
    ].join("\n"),
  );
} else {
  report.manual.push("未找到 .specify/memory/constitution.md——如项目有宪法内容，手工迁移到 specseal/principles.md。");
}

// ---------- 2) specs/<feature>/spec.md → capabilities ----------
function convertSpec(src, feature) {
  const out = [];
  const manual = [];
  const lines = src.split("\n");
  let purpose = "";
  for (let i = 0; i < lines.length && purpose.length < 40; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#") && !line.startsWith("*") && !line.startsWith("-")) purpose += (purpose ? " " : "") + line;
  }
  if (purpose.length < 50) purpose += " （迁移占位：请核对并补写本能力的目的与边界，至少 50 字符。）";
  out.push("## Purpose", "", purpose, "");

  const frMatch = src.match(/^- \*\*FR-\d+[*^]?:?\*\*:?.*$/gm) || [];
  const stories = [...src.matchAll(/### User Story \d+ - (.+)/g)];
  let scenarioIdx = 0;
  for (const story of stories) {
    const title = story[1].trim().replace(/\s+/g, " ");
    out.push(`### Requirement: ${title}`, "");
    const start = story.index;
    const end = src.indexOf("### User Story", start + 10);
    const block = src.slice(start, end === -1 ? src.length : end);
    const why = block.match(/\*\*Why\*\*[:：]?\s*(.+)/);
    if (why) out.push(`系统支持此需求：${why[1].trim()}。`, "");
    const gwt = [...block.matchAll(/\*\*Given\*\*([^*]*)\*\*When\*\*([^*]*)\*\*Then\*\*([^*\n]+)/g)];
    for (const [, given, when, then] of gwt) {
      scenarioIdx += 1;
      const whenText = (given.trim() ? `${given.trim()}，当 ` : "") + when.trim();
      out.push(`#### Scenario: 场景 ${scenarioIdx}`, "", `- **WHEN** ${whenText}`, `- **THEN** ${then.trim()}`, "");
    }
    if (gwt.length === 0) manual.push(`specs/${feature}/spec.md：User Story「${title}」没有 Given/When/Then 场景，未自动转换。`);
  }
  for (const fr of frMatch) {
    const text = fr.replace(/^- \*\*FR-\d+[*^]?:?\*\*:?\s*/, "").trim();
    const title = text.slice(0, 40).replace(/[:：].*$/, "");
    out.push(`### Requirement: ${title}`, "", text.replace(/\bMUST\b/g, "SHALL"), "");
  }
  return { body: out.join("\n"), manual };
}

if (existsSync(specKitSpecs)) {
  for (const entry of readdirSync(specKitSpecs)) {
    const featureDir = join(specKitSpecs, entry);
    if (!statSync(featureDir).isDirectory()) continue;
    const specFile = join(featureDir, "spec.md");
    if (!existsSync(specFile)) {
      report.manual.push(`specs/${entry}/ 没有 spec.md，跳过。`);
      continue;
    }
    const { body, manual } = convertSpec(readFileSync(specFile, "utf8"), entry);
    write(`specseal/specs/${entry}/spec.md`, body + "\n");
    report.converted.push(`specs/${entry}/spec.md → specseal/specs/${entry}/spec.md`);
    report.manual.push(...manual);
    for (const extra of ["plan.md", "tasks.md", "research.md", "quickstart.md", "data-model.md"]) {
      if (existsSync(join(featureDir, extra))) {
        report.manual.push(`specs/${entry}/${extra}：specseal 不使用 feature 常驻文档（changes 是变更粒度）——如需留痕，人工补录为归档变更。`);
      }
    }
  }
}

// ---------- 3) 迁移报告 ----------
const reportLines = [
  "# Spec-kit → Specseal 迁移报告",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "## 已复制/生成",
  ...(report.copied.length ? report.copied.map((p) => `- ✅ ${p}`) : ["- （无）"]),
  "",
  "## 已转换（格式合法，内容请人工核对）",
  ...(report.converted.length ? report.converted.map((p) => `- 🔄 ${p}`) : ["- （无）"]),
  "",
  "## 需人工处理",
  ...(report.manual.length ? report.manual.map((p) => `- ⚠️ ${p}`) : ["- （无）"]),
  "",
  "收尾建议：逐个核对 specseal/specs/ 下的 Purpose 与 Scenario，然后跑 `specseal validate`。",
  "",
];
write("specseal/MIGRATION-REPORT.md", reportLines.join("\n"));

// ---------- 4) 引擎校验 ----------
try {
  execFileSync("specseal", ["validate"], { cwd: root, stdio: "pipe" });
  console.log("✓ specseal validate 通过");
} catch (err) {
  const detail = (err.stdout || "") + (err.stderr || "");
  console.error(`✗ specseal validate 失败——转换产物有格式问题，按错误逐个修复：\n${detail.slice(0, 1500)}`);
  process.exit(1);
}
console.log("\n完成。核对 specseal/MIGRATION-REPORT.md 的「需人工处理」清单。");

#!/usr/bin/env node
// 更新日志的渲染脚本（release-notes spec「渲染脚本由 JSON 产出 CHANGELOG.md 与单版片段」）。
// 真相只有 apps/desktop/src/release-notes/release-notes.json（每个条目同时存 en 与 zh-CN）；
// 英文 CHANGELOG.md、繁中 CHANGELOG.zh-CN.md 与 Release 说明的两种语言片段都由这一份逻辑
// 画出，格式不可能漂移。纯 Node、无依赖。
//
// 用法：
//   --write                            读 JSON，写出 repo 根 CHANGELOG.md 与 CHANGELOG.zh-CN.md
//   --version X.Y.Z [--lang en|zh-CN]  把该版该语言的片段印到 stdout，缺省 en
//                                      （JSON 无此版 → exit 1，stderr 印顶端版号）
//   --check                            重算两份并各自与现有档比对（任一份不一致 → exit 1，
//                                      stderr 点名文档名并印差异摘要）
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES_PATH = path.join(ROOT, 'apps', 'desktop', 'src', 'release-notes', 'release-notes.json');
const USAGE = '用法：release-notes-render.mjs --write | --version X.Y.Z [--lang en|zh-CN] | --check';

/** 分组只有这三种，同一笔内也依此顺序排列；标题不存在 JSON，由下方各语言决定。 */
const KINDS = ['features', 'fixes', 'improvements'];

/** 每种语言的文档名、档头（标题＋语言切换列）、版号标题写法与分组标题。 */
const LANGS = {
  en: {
    file: 'CHANGELOG.md',
    header: '# Changelog\n**English** · [繁体中文](CHANGELOG.zh-CN.md)',
    heading: (entry) => `## ${entry.version} (${entry.date})`,
    kinds: { features: 'New features', fixes: 'Fixes', improvements: 'Improvements' },
  },
  'zh-CN': {
    file: 'CHANGELOG.zh-CN.md',
    header: '# 更新日志\n[English](CHANGELOG.md) · **繁体中文**',
    heading: (entry) => `## ${entry.version}（${entry.date}）`,
    kinds: { features: '新功能', fixes: '修正', improvements: '改善' },
  },
};

/** 单一版本某语言的 markdown 片段：版号（日期）标题加各分组 `### 标题` 与 `- ` 条目；尾端一个换行。 */
export function renderEntry(entry, lang) {
  const { heading, kinds } = LANGS[lang];
  const blocks = [heading(entry)];
  for (const section of entry.sections) {
    blocks.push(`### ${kinds[section.kind]}`);
    blocks.push(section.items.map((item) => `- ${item[lang]}`).join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

/** 某语言的完整更新日志：标题、次行语言切换，其后依序接每版片段，条目间空一行，档尾一个换行，一律 LF。 */
export function renderChangelog(entries, lang) {
  return `${LANGS[lang].header}\n\n${entries.map((entry) => renderEntry(entry, lang)).join('\n')}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** 条目形状守门（release-notes spec「更新日志 JSON 为唯一真相」）：不合即丢出点名版号与位置的
 * Error；--check 因此也守住真 JSON 的形状。 */
function assertShape(entries) {
  const bad = (where, why) => new Error(`release-notes.json 形状错误：${where} ${why}`);
  if (!Array.isArray(entries)) throw bad('顶层', '必须是数组');
  entries.forEach((entry, i) => {
    const at = `第 ${i + 1} 笔（${entry?.version}）`;
    if (!VERSION_SHAPE.test(entry?.version ?? '')) throw bad(at, 'version 必须是 X.Y.Z');
    if (!DATE_SHAPE.test(entry?.date ?? '')) throw bad(at, 'date 必须是 YYYY-MM-DD');
    if (!Array.isArray(entry.sections)) throw bad(at, 'sections 必须是数组');
    let previous = -1;
    entry.sections.forEach((section) => {
      const order = KINDS.indexOf(section?.kind);
      if (order < 0) throw bad(at, `kind 只能是 ${KINDS.join('／')}`);
      if (order <= previous) throw bad(at, `分组须依 ${KINDS.join('、')} 的顺序排列且不得重复`);
      previous = order;
      const items = section.items;
      if (!Array.isArray(items) || items.length === 0) throw bad(at, `${section.kind} 的 items 必须是非空数组`);
      items.forEach((item, j) => {
        for (const lang of Object.keys(LANGS)) {
          const text = item?.[lang];
          if (typeof text !== 'string' || !text.trim()) {
            throw bad(at, `${section.kind} 第 ${j + 1} 条的 ${lang} 必须是非空字符串`);
          }
        }
      });
    });
  });
}

/** 读入全部条目（最新在前）并守门形状。下载指南脚本也由此取条目，JSON 路径只在这里出现一次。 */
export function readReleaseNotes() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(NOTES_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`release-notes.json 读取失败：${error.message}`);
  }
  assertShape(parsed);
  return parsed;
}

/** 第一个不同的行（1-based）与两边该行内容——给人看的差异摘要，不是完整 diff。 */
function firstDifference(actual, expected) {
  const a = actual.split('\n');
  const e = expected.split('\n');
  const count = Math.max(a.length, e.length);
  for (let i = 0; i < count; i += 1) {
    if (a[i] !== e[i]) return { line: i + 1, actual: a[i] ?? '<档尾>', expected: e[i] ?? '<档尾>' };
  }
  return null;
}

/** 一份更新日志与重算结果比对；一致回 null，否则回点名该档的说明。 */
function checkFile(file, expected) {
  let current;
  try {
    current = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return `${file} 不存在。`;
  }
  // Windows checkout 可能被 autocrlf 改写成 CRLF；比对前范式，写出永远 LF。
  const difference = firstDifference(current.replace(/\r\n/g, '\n'), expected);
  if (!difference) return null;
  return [
    `${file} 与 release-notes.json 重算结果不一致（第 ${difference.line} 行）：`,
    `  ${file}：${difference.actual}`,
    `  重算结果：${difference.expected}`,
  ].join('\n');
}

function main(args) {
  const [command, argument] = args;
  if (command === '--write' && args.length === 1) {
    // 两份都先算好才写：形状错误时一份都不写。
    const entries = readReleaseNotes();
    const outputs = Object.entries(LANGS).map(([lang, { file }]) => [file, renderChangelog(entries, lang)]);
    for (const [file, content] of outputs) writeFileSync(path.join(ROOT, file), content);
    return;
  }
  if (command === '--version' && (args.length === 2 || (args.length === 4 && args[2] === '--lang'))) {
    const lang = args.length === 4 ? args[3] : 'en';
    if (!Object.hasOwn(LANGS, lang)) fail(`--lang 只能是 ${Object.keys(LANGS).join(' 或 ')}（收到「${lang}」）`);
    const entries = readReleaseNotes();
    const entry = entries.find((candidate) => candidate.version === argument);
    if (!entry) {
      fail(`release-notes.json 没有 ${argument} 的条目（顶端版号为 ${entries[0]?.version ?? '无'}）`);
    }
    process.stdout.write(renderEntry(entry, lang));
    return;
  }
  if (command === '--check' && args.length === 1) {
    // 先读真相（JSON 坏掉要先说），再逐份比对衍生物；两份都漂移时一次点名两份。
    const entries = readReleaseNotes();
    const problems = Object.entries(LANGS)
      .map(([lang, { file }]) => checkFile(file, renderChangelog(entries, lang)))
      .filter(Boolean);
    if (problems.length > 0) {
      fail(
        [
          ...problems,
          `运行 node scripts/release/release-notes-render.mjs --write 重新产出 ${Object.values(LANGS)
            .map(({ file }) => file)
            .join(' 与 ')}。`,
        ].join('\n'),
      );
    }
    return;
  }
  fail(USAGE);
}

// 直接运行才跑 CLI；被 import（测试、release-notes.mjs）时只导出函数（写法同 repo 其他脚本）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}

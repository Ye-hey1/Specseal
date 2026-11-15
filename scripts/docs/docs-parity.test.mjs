// 中英对等与正典词汇的验收（user-documentation spec「中英文文档保持结构与事实对等」、
// design D5：同结构、同事实）。
// D5 的可机械检查部分有两块：成对文档的 H2 章节串行与截屏文档名串行须逐项相同（截屏各自
// 落在该语言的目录）；
// 繁体中文散文须用正典词汇，引擎动词只能出现在 code span 内。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/// spec「中英文文档保持结构与事实对等」列出的全部成对文档。
/// remote-getting-started 与 development 的内容检查另由 remote-docs.test.mjs 负责。
const PAIRS = [
  ['README.zh-CN.md', 'README.md'],
  ['docs/getting-started.zh-CN.md', 'docs/getting-started.md'],
  ['docs/workflow.zh-CN.md', 'docs/workflow.md'],
  ['docs/product-status.zh-CN.md', 'docs/product-status.md'],
  ['docs/roadmap.zh-CN.md', 'docs/roadmap.md'],
  ['docs/remote-getting-started.zh-CN.md', 'docs/remote-getting-started.md'],
  ['docs/development.zh-CN.md', 'docs/development.md'],
  ['docs/configuration.zh-CN.md', 'docs/configuration.md'],
  ['docs/verb-contract.zh-CN.md', 'docs/verb-contract.md'],
  ['docs/sdk-node.zh-CN.md', 'docs/sdk-node.md'],
  ['docs/server-deployment.zh-CN.md', 'docs/server-deployment.md'],
  ['docs/server-store-drivers.zh-CN.md', 'docs/server-store-drivers.md'],
  ['docs/server-backup.zh-CN.md', 'docs/server-backup.md'],
];

/// 两语言的标题文本各写各的，章节靠行首的 `<a id="..."></a>` 对齐；
/// 缺锚点的标题以原文出列，两版必然不等而被点名。
const ANCHORED_H2 = /^## <a id="([^"]+)"><\/a>/;

const h2s = (markdown) =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => ANCHORED_H2.exec(line)?.[1] ?? `（缺锚点）${line.slice(3).trim()}`);

/// 截屏分语言放在 `assets/screenshots/<语言>/`；语言目录写成选用，平放的旧写法也会被抓出来、
/// 再由下面的目录断言点名。
const shots = (markdown) => markdown.match(/[\w./-]*assets\/screenshots\/(?:[\w-]+\/)?[a-z-]+\.png/g) ?? [];

const outsideDir = (refs, locale) => refs.filter((ref) => !ref.includes(`assets/screenshots/${locale}/`));

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/// 依 H2 锚点分组的表格数据列：表头（紧接分隔列的那一列）与分隔列不算。
function tableRows(markdown) {
  const sections = new Map();
  for (const chunk of markdown.split(/^## /m).slice(1)) {
    const lines = chunk.split('\n').filter((line) => line.startsWith('|'));
    // 分隔列的每一格都只有 - 与对齐用的 :；只看开头会把 `| --json |` 这种数据列也吃掉。
    const isSeparator = (line) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
    const rows = lines.filter((line, index) => !isSeparator(line) && !isSeparator(lines[index + 1] ?? ''));
    sections.set(ANCHORED_H2.exec(`## ${chunk}`)?.[1], rows.map(cells));
  }
  return sections;
}

/// 状态图例写成「Available（可用）」：由它推出中文状态值对应的英文状态值。
function statusMapOf(legendRows) {
  return new Map(
    legendRows.map(([label]) => {
      const match = /^(.+?)（(.+)）$/.exec(label);
      assert.ok(match, `状态图例「${label}」不是「English（中文）」的写法`);
      return [match[2], match[1]];
    }),
  );
}

/// 移除 fenced block 与行内 code span——引擎动词、CLI 命令与字段名留在 code span
/// 内是正典允许的，只有散文里的裸用才算违规。
function prose(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/// 正典词汇的避免词中，语意不依赖上下文、可直接机械判定的那些。
/// （`进行中`、`分页`、`context` 等避免词绑在其他正典词的语境上，看板栏名与
///  一般用语都会误命中，不纳入机械检查。）
const AVOID = ['促转', '已促转', '再促转', '促转分页', '归档', '撤回开工', '取消开工'];

/// spec 的场景点名的三个词：繁中散文须写「转为变更」「已转出变更」「封存」，
/// 英文动词只准出现在 CLI／字段／code span 或必要的引擎动词对照中。
/// 对照（站别章节、表格的动词栏、双语标题）是明文允许的，因此只扫纯散文行。
const PROSE_FORBIDDEN = ['promote', 'promoted'];

const ZH_DOCS = [
  'README.zh-CN.md',
  'docs/getting-started.zh-CN.md',
  'docs/workflow.zh-CN.md',
  'docs/product-status.zh-CN.md',
  'docs/roadmap.zh-CN.md',
  'docs/remote-getting-started.zh-CN.md',
  'docs/configuration.zh-CN.md',
  'docs/verb-contract.zh-CN.md',
  'docs/sdk-node.zh-CN.md',
  'docs/development.zh-CN.md',
  'docs/server-deployment.zh-CN.md',
  'docs/server-store-drivers.zh-CN.md',
  'docs/server-backup.zh-CN.md',
];

for (const [zhPath, enPath] of PAIRS) {
  test(`中英对等：${zhPath} 与 ${enPath} 的 H2 锚点串行逐项相同`, () => {
    assert.deepEqual(h2s(read(zhPath)), h2s(read(enPath)));
  });

  test(`中英对等：${zhPath} 与 ${enPath} 的截屏文档名串行相同，且各自引用该语言目录`, () => {
    const zhRefs = shots(read(zhPath));
    const enRefs = shots(read(enPath));
    assert.deepEqual(
      zhRefs.map((s) => s.split('/').pop()),
      enRefs.map((s) => s.split('/').pop()),
    );
    assert.deepEqual(outsideDir(zhRefs, 'zh-CN'), [], `${zhPath} 有截屏不在 zh-CN/`);
    assert.deepEqual(outsideDir(enRefs, 'en'), [], `${enPath} 有截屏不在 en/`);
  });
}

test('表格列：第一格以 - 开头的数据列不会被当成分隔列', () => {
  const md = ['## <a id="x"></a>X', '', '| 旗标 | 说明 |', '| --- | --- |', '| --json | 机器输出 |', '| -y | 略过确认 |'].join('\n');
  assert.deepEqual(tableRows(md).get('x'), [
    ['--json', '机器输出'],
    ['-y', '略过确认'],
  ]);
});

test('状态图例：多个字的状态名也对得上，写法不对时点名那一列', () => {
  assert.deepEqual(
    [...statusMapOf([['Available（可用）'], ['Not planned（不规划）']])],
    [
      ['可用', 'Available'],
      ['不规划', 'Not planned'],
    ],
  );
  assert.throws(() => statusMapOf([['Available']]), /Available/);
});

test('product-status 中英矩阵：每个章节的表格列数与栏数逐列相同', () => {
  const zh = tableRows(read('docs/product-status.zh-CN.md'));
  const en = tableRows(read('docs/product-status.md'));
  for (const [id, zhRows] of zh) {
    const enRows = en.get(id) ?? [];
    assert.equal(enRows.length, zhRows.length, `章节「${id}」的表格列数不同`);
    zhRows.forEach((row, index) => {
      assert.equal(enRows[index].length, row.length, `章节「${id}」第 ${index + 1} 列「${row[0]}」的栏数不同`);
    });
  }
});

test('product-status 能力清单：每列有证据、限制与下一步及查核日期，中英状态与日期逐列对应', () => {
  const zh = tableRows(read('docs/product-status.zh-CN.md'));
  const en = tableRows(read('docs/product-status.md'));
  const statusOf = statusMapOf(zh.get('status-model'));
  const zhRows = zh.get('capabilities');
  const enRows = en.get('capabilities');
  assert.ok(zhRows.length > 0, '能力清单没有任何列');
  const problems = [];
  zhRows.forEach(([name, status, , evidence, limits, checked], index) => {
    const [enName, enStatus, , enEvidence, enLimits, enChecked] = enRows[index];
    if (statusOf.get(status) !== enStatus) problems.push(`${name}：状态「${status}」对不上英文版「${enStatus}」`);
    if (!evidence || !enEvidence) problems.push(`${name} / ${enName}：缺证据`);
    if (!limits || !enLimits) problems.push(`${name} / ${enName}：缺限制与下一步`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checked ?? '')) problems.push(`${name}：查核日期「${checked}」不是 YYYY-MM-DD`);
    if (checked !== enChecked) problems.push(`${name}：查核日期与英文版「${enChecked}」不同`);
  });
  assert.deepEqual(problems, []);
});

test('正典词汇：繁中文档不使用避免词', () => {
  const hits = [];
  for (const relative of ZH_DOCS) {
    prose(read(relative))
      .split('\n')
      .forEach((line, index) => {
        for (const word of AVOID) {
          if (line.includes(word)) hits.push(`${relative}:${index + 1} 「${word}」`);
        }
      });
  }
  assert.deepEqual(hits, []);
});

test('`promote` 系列不裸用于繁中散文（散文用「转为变更」「已转出变更」）', () => {
  const hits = [];
  for (const relative of ZH_DOCS) {
    prose(read(relative))
      .split('\n')
      .forEach((line, index) => {
        // 标题与表格列是明文允许的「引擎动词对照」，只扫纯散文行。
        if (line.startsWith('#') || line.trim().startsWith('|')) return;
        if (!/[一-鿿]/.test(line)) return;
        for (const verb of PROSE_FORBIDDEN) {
          if (new RegExp(`(?<![\\w-/])${verb}(?![\\w-])`, 'i').test(line)) {
            hits.push(`${relative}:${index + 1} 「${verb}」 → ${line.trim().slice(0, 60)}`);
          }
        }
      });
  }
  assert.deepEqual(hits, []);
});

test('繁中散文使用正典词汇「转为变更」「已转出变更」「封存」', () => {
  const workflow = read('docs/workflow.zh-CN.md');
  for (const term of ['转为变更', '已转出变更', '封存']) {
    assert.ok(workflow.includes(term), `工作流正典缺少正典词汇「${term}」`);
  }
});

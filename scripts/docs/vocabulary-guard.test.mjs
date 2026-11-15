// 用户可见繁中文案的正典词汇守门（ui-copy-vocabulary spec、design D4）。
// 守门词由 specseal/LANGUAGE.md 动态解析——添加词条自动生效，这是「挡住新的越界」
// 而非「追讨存量」：规格散文、代码注解与已封存内容都不在扫描面内。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

/// D4 界定的「用户可见文案面」：用户真的会看到这些字。
const SURFACE_FILES = [
  'apps/desktop/src/i18n/messages.ts',
  'apps/server-web/src/i18n/messages.ts',
  'packages/ui/src/i18n.tsx',
  'README.md',
  'README.zh-CN.md',
];
const SURFACE_DIRS = ['crates/engine/specseal-core/assets/skills', 'docs'];

/// 目录下（含子目录）全部 `.md`，回传 ROOT 相对路径并以正斜线表示。
function markdownsUnder(relativeDir) {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.md')) found.push(child);
    }
  };
  walk(relativeDir);
  return found.sort();
}

const surface = () => [...SURFACE_FILES, ...SURFACE_DIRS.flatMap(markdownsUnder)].sort();

/// LANGUAGE.md 各词条 `avoid` 栏的守门词。两道过滤：
/// (1) 带括号限定者依限定语境分流——限定为「用户可见文案中」者，限定范围正是
///     守门面本身，剥掉限定后纳入守门；其他语境限定（`背景（此概念上）`、
///     `分页（pagination 语意上）`）绑在比守门面更窄的语境，机械扫描必然误命中，
///     比照 docs-parity.test.mjs 排除；
/// (2) 只取含中日韩文本者——ASCII 识别符（RichDetailDrawer、archivedDrawerBase）
///     与英文文案永远不匹配，因此不需要任何识别符白名单。
const SURFACE_QUALIFIER = '用户可见文案中';

function avoidTerms(languageMarkdown) {
  const terms = [];
  for (const line of languageMarkdown.split(/\r?\n/)) {
    const listed = /^- \*\*avoid\*\*:\s*(.+)$/.exec(line);
    if (!listed) continue;
    for (const raw of listed[1].split(/[、,]/)) {
      let term = raw.trim();
      const qualified = /^(.*?)[（(]([^（()）]*)[）)]$/.exec(term);
      if (qualified) {
        if (qualified[2] !== SURFACE_QUALIFIER) continue;
        term = qualified[1].trim();
      }
      if (!/[一-鿿]/.test(term)) continue;
      terms.push(term);
    }
  }
  return terms;
}

/// 单一文档内容的命中清单。行号由 1 起算，LF 与 CRLF 同一套判定。
function scanText(relative, text, terms) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const term of terms) {
      if (line.includes(term)) hits.push(`${relative}:${index + 1} 「${term}」`);
    }
  });
  return hits;
}

const scanFiles = (files, terms) => files.flatMap((relative) => scanText(relative, read(relative), terms));

const TERMS = avoidTerms(read('specseal/LANGUAGE.md'));

test('词汇守门：用户可见文案面不出现 LANGUAGE.md 的 avoid 词', () => {
  const hits = scanFiles(surface(), TERMS);
  assert.deepEqual(hits, [], `用户可见文案面出现正典避免词：\n${hits.join('\n')}`);
});

test('守门词取自 LANGUAGE.md 的 avoid 栏，含本次收敛的两个旧词', () => {
  assert.ok(TERMS.includes('抽屉'), '「详情页」词条的 avoid 未被解析出来');
  assert.ok(TERMS.includes('品质站'), '「品质关卡」词条的 avoid 未被解析出来');
});

// spec ui-copy-vocabulary「手动任务与待手动以 LANGUAGE.md 词条承载」＋「用户可见
// 文案面的范围与词汇约束」：面含共用看板组件的 i18n 档、守门词含「待手测」——
// 两者少一个，待手动的防漂回就整个失效，所以各钉一条。
test('守门面含 packages/ui/src/i18n.tsx（待手动文案的所在档）', () => {
  assert.ok(surface().includes('packages/ui/src/i18n.tsx'), '共用看板组件的 i18n 档不在守门面内');
});

test('「待手测」不带语境限定，入机械守门集', () => {
  assert.ok(TERMS.includes('待手测'), '「待手动」词条的 avoid「待手测」未被解析出来');
  assert.ok(!TERMS.includes('手动测试'), '「手动测试」带「此概念上」限定，不该进机械守门集');
});

test('于 packages/ui/src/i18n.tsx 植入「待手测」时命中并指出行号', () => {
  const planted = ['const zh = {', '  "card.awaitingManual": "待手测",', '};'].join('\n');
  assert.deepEqual(scanText('packages/ui/src/i18n.tsx', planted, TERMS), [
    'packages/ui/src/i18n.tsx:2 「待手测」',
  ]);
});

test('带括号限定的 avoid 词不入守门集（绑语境，机械扫描必误命中）', () => {
  for (const contextual of ['背景', '分页', '规则', '进行中']) {
    assert.ok(!TERMS.includes(contextual), `「${contextual}」是语境限定词，不该进守门集`);
  }
});

test('限定语境即守门面（「用户可见文案中」）的 avoid 词剥掉限定后入守门集', () => {
  for (const surfaceScoped of ['覆审', '项目 ID', '子 change']) {
    assert.ok(TERMS.includes(surfaceScoped), `「${surfaceScoped}」的限定语境就是守门面，剥掉限定后该进守门集`);
  }
});

test('纯 ASCII 的 avoid 词不入守门集（只守中日韩词汇）', () => {
  for (const ascii of ['promote', 'PAT', 'Store']) {
    assert.ok(!TERMS.includes(ascii), `「${ascii}」非中日韩词汇，不该进守门集`);
  }
});

test('面内植入 avoid 词时命中，并指出文档、行号与命中的词', () => {
  const planted = ['export const messages = {', '  "tour.navUsers.hint": "邀请与编辑都在右侧抽屉完成",', '};'].join('\n');
  assert.deepEqual(scanText('apps/server-web/src/i18n/messages.ts', planted, TERMS), [
    'apps/server-web/src/i18n/messages.ts:2 「抽屉」',
  ]);
});

test('ASCII 识别符不触发误判', () => {
  const identifiers = ['import { RichDetailDrawer } from "./RichDetailDrawer";', 'const archivedDrawerBase = css`position: fixed`;', 'export type SpecDrawerProps = { open: boolean };'].join('\n');
  assert.deepEqual(scanText('apps/desktop/src/App.tsx', identifiers, TERMS), []);
});

test('英文文案不受词汇约束', () => {
  const english = ['"store.reviewActionUnsupported": "this workspace cannot settle quality-station tickets",', '"tour.navUsers.hint": "invite and edit inside the right-hand drawer",'].join('\n');
  assert.deepEqual(scanText('apps/desktop/src/i18n/messages.ts', english, TERMS), []);
});

test('CRLF 与 LF 行尾的判定结果相同', () => {
  const lines = ['第一行干净', '第二行也干净', '第三行有抽屉'];
  const lf = scanText('docs/x.md', lines.join('\n'), TERMS);
  const crlf = scanText('docs/x.md', lines.join('\r\n'), TERMS);
  assert.deepEqual(crlf, lf);
  assert.deepEqual(lf, ['docs/x.md:3 「抽屉」']);
});

test('LANGUAGE.md 正典自身与 specseal/specs 的存量不在扫描面内', () => {
  const scanned = surface();
  assert.ok(!scanned.includes('specseal/LANGUAGE.md'), '正典自身入面会使 avoid 栏违规');
  assert.ok(
    !scanned.some((relative) => relative.startsWith('specseal/')),
    'specseal/ 底下的规格散文与封存内容不在扫描面内',
  );
  // 正典与规格散文都还带着存量旧词——它们被排除，不是刚好干净。
  assert.ok(scanText('specseal/LANGUAGE.md', read('specseal/LANGUAGE.md'), TERMS).length > 0);
  assert.ok(
    scanText('specseal/specs/desktop-app/spec.md', read('specseal/specs/desktop-app/spec.md'), TERMS).length > 0,
  );
});

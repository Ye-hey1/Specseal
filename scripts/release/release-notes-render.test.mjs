// 更新日志渲染脚本（release-notes spec「渲染脚本由 JSON 产出 CHANGELOG.md 与单版片段」）：
// 两种语言纯函数的固定输出，加 CLI 三用法的 exit code、--lang、CRLF 范式与 JSON 双语形状守门。
// CLI 在暂存 repo 上跑（release-notes-scratch.mjs），不碰真 repo 的两份更新日志。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { readReleaseNotes, renderChangelog, renderEntry } from './release-notes-render.mjs';
import { scratchRepo } from './release-notes-scratch.mjs';

const ENTRY_030 = {
  version: '0.3.0',
  date: '2026-09-10',
  sections: [
    {
      kind: 'features',
      items: [
        { en: 'Alpha', 'zh-CN': '甲' },
        { en: 'Beta', 'zh-CN': '乙' },
      ],
    },
    { kind: 'fixes', items: [{ en: 'Gamma', 'zh-CN': '丙' }] },
  ],
};
const ENTRY_020 = {
  version: '0.2.0',
  date: '2026-09-08',
  sections: [{ kind: 'improvements', items: [{ en: 'Delta', 'zh-CN': '丁' }] }],
};

const FRAGMENT_030_EN = `## 0.3.0 (2026-09-10)

### New features

- Alpha
- Beta

### Fixes

- Gamma
`;

const FRAGMENT_030_ZH = `## 0.3.0（2026-09-10）

### 新功能

- 甲
- 乙

### 修正

- 丙
`;

/// 只放渲染脚本的暂存 repo；run 直接绑定该脚本。
function renderRepo(notes) {
  const repo = scratchRepo({ scripts: ['release-notes-render.mjs'], notes });
  return { ...repo, run: (args) => repo.run('release-notes-render.mjs', args) };
}

test('renderEntry：依语言画版号（日期）标题、分组三级标题与 - 条目，尾端单一换行', () => {
  assert.equal(renderEntry(ENTRY_030, 'en'), FRAGMENT_030_EN);
  assert.equal(renderEntry(ENTRY_030, 'zh-CN'), FRAGMENT_030_ZH);
  assert.equal(renderEntry(ENTRY_020, 'en'), '## 0.2.0 (2026-09-08)\n\n### Improvements\n\n- Delta\n');
  assert.equal(renderEntry(ENTRY_020, 'zh-CN'), '## 0.2.0（2026-09-08）\n\n### 改善\n\n- 丁\n');
});

test('renderChangelog en：首行 # Changelog、次行语言切换、条目依序、条目间空一行、档尾单一换行、一律 LF', () => {
  const out = renderChangelog([ENTRY_030, ENTRY_020], 'en');
  assert.ok(
    out.startsWith('# Changelog\n**English** · [繁体中文](CHANGELOG.zh-CN.md)\n\n## 0.3.0 (2026-09-10)\n'),
    '首行、语言切换与第一笔',
  );
  assert.ok(out.indexOf('## 0.3.0') < out.indexOf('## 0.2.0'), '依 JSON 顺序');
  assert.ok(out.includes('- Gamma\n\n## 0.2.0 (2026-09-08)\n\n### Improvements\n\n- Delta\n'), '条目间空一行');
  assert.ok(out.endsWith('- Delta\n') && !out.endsWith('\n\n'), '档尾恰一个换行');
  assert.ok(!out.includes('\r'), '不得含 CR');
});

test('renderChangelog zh-CN：首行 # 更新日志、次行语言切换、条目依序、条目间空一行、档尾单一换行、一律 LF', () => {
  const out = renderChangelog([ENTRY_030, ENTRY_020], 'zh-CN');
  assert.ok(
    out.startsWith('# 更新日志\n[English](CHANGELOG.md) · **繁体中文**\n\n## 0.3.0（2026-09-10）\n'),
    '首行、语言切换与第一笔',
  );
  assert.ok(out.indexOf('## 0.3.0') < out.indexOf('## 0.2.0'), '依 JSON 顺序');
  assert.ok(out.includes('- 丙\n\n## 0.2.0（2026-09-08）\n\n### 改善\n\n- 丁\n'), '条目间空一行');
  assert.ok(out.endsWith('- 丁\n') && !out.endsWith('\n\n'), '档尾恰一个换行');
  assert.ok(!out.includes('\r'), '不得含 CR');
});

test('--write 写出 repo 根 CHANGELOG.md 与 CHANGELOG.zh-CN.md，内容各等于该语言的 renderChangelog，exit 0', () => {
  const { run, changelog, changelogZh } = renderRepo([ENTRY_030, ENTRY_020]);
  const result = run(['--write']);
  assert.equal(result.status, 0, result.stderr);
  const en = readFileSync(changelog, 'utf8');
  const zh = readFileSync(changelogZh, 'utf8');
  assert.equal(en, renderChangelog([ENTRY_030, ENTRY_020], 'en'));
  assert.equal(zh, renderChangelog([ENTRY_030, ENTRY_020], 'zh-CN'));
  assert.deepEqual(en.split('\n').slice(0, 2), ['# Changelog', '**English** · [繁体中文](CHANGELOG.zh-CN.md)']);
  assert.deepEqual(zh.split('\n').slice(0, 2), ['# 更新日志', '[English](CHANGELOG.md) · **繁体中文**']);
});

test('--version 缺省印英文片段，--lang zh-CN 印繁中片段，--lang en 印英文片段', () => {
  const { run } = renderRepo([ENTRY_030, ENTRY_020]);
  const byDefault = run(['--version', '0.3.0']);
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.equal(byDefault.stdout, FRAGMENT_030_EN);

  const zh = run(['--version', '0.3.0', '--lang', 'zh-CN']);
  assert.equal(zh.status, 0, zh.stderr);
  assert.equal(zh.stdout, FRAGMENT_030_ZH);

  const en = run(['--version', '0.3.0', '--lang', 'en']);
  assert.equal(en.status, 0, en.stderr);
  assert.equal(en.stdout, FRAGMENT_030_EN);
});

test('--version 找不到版本 exit 1 且 stderr 含 JSON 顶端版号', () => {
  const { run } = renderRepo([ENTRY_030, ENTRY_020]);
  const miss = run(['--version', '0.9.9']);
  assert.equal(miss.status, 1);
  assert.equal(miss.stdout, '');
  assert.ok(miss.stderr.includes('0.9.9'), '点名找不到的版本');
  assert.ok(miss.stderr.includes('0.3.0'), '印出 JSON 顶端版号');
});

test('--lang 不是 en 或 zh-CN 时 exit 1、stdout 空、stderr 说明可用值', () => {
  const { run } = renderRepo([ENTRY_030]);
  for (const lang of ['fr', 'zh-tw', 'EN', '__proto__', '']) {
    const result = run(['--version', '0.3.0', '--lang', lang]);
    assert.equal(result.status, 1, `lang=${JSON.stringify(lang)}`);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('zh-CN'), `stderr 说明可用值：${result.stderr}`);
  }
});

test('--check：两份一致 exit 0', () => {
  const { run } = renderRepo([ENTRY_030, ENTRY_020]);
  assert.equal(run(['--write']).status, 0);
  const clean = run(['--check']);
  assert.equal(clean.status, 0, clean.stderr);
});

test('--check：手改 CHANGELOG.zh-CN.md 一字后 exit 1，stderr 点名该档并印差异摘要', () => {
  const { run, changelogZh } = renderRepo([ENTRY_030, ENTRY_020]);
  assert.equal(run(['--write']).status, 0);
  writeFileSync(changelogZh, readFileSync(changelogZh, 'utf8').replace('- 乙', '- 戊'));
  const drifted = run(['--check']);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /^CHANGELOG\.zh-CN\.md 与 release-notes\.json 重算结果不一致/m, '点名漂移的文档名');
  assert.doesNotMatch(drifted.stderr, /^CHANGELOG\.md 与/m, '没漂移的档不被点名');
  assert.ok(drifted.stderr.includes('- 戊') && drifted.stderr.includes('- 乙'), '差异摘要列出两边的行');
});

test('--check：手改 CHANGELOG.md 一字后 exit 1，stderr 点名该档并印差异摘要', () => {
  const { run, changelog } = renderRepo([ENTRY_030, ENTRY_020]);
  assert.equal(run(['--write']).status, 0);
  writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('- Beta', '- Epsilon'));
  const drifted = run(['--check']);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /^CHANGELOG\.md 与 release-notes\.json 重算结果不一致/m, '点名漂移的文档名');
  assert.doesNotMatch(drifted.stderr, /^CHANGELOG\.zh-CN\.md 与/m, '没漂移的档不被点名');
  assert.ok(drifted.stderr.includes('- Epsilon') && drifted.stderr.includes('- Beta'), '差异摘要列出两边的行');
});

test('--check：两份都以 CRLF 读入时仍 exit 0', () => {
  const { run, changelog, changelogZh } = renderRepo([ENTRY_030, ENTRY_020]);
  assert.equal(run(['--write']).status, 0);
  for (const file of [changelog, changelogZh]) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
});

test('--check：任一份不存在时 exit 1 并点名缺的档', () => {
  const { run, changelog, changelogZh } = renderRepo([ENTRY_030]);
  assert.equal(run(['--write']).status, 0);
  rmSync(changelogZh);
  const missingZh = run(['--check']);
  assert.equal(missingZh.status, 1);
  assert.ok(missingZh.stderr.includes('CHANGELOG.zh-CN.md'), missingZh.stderr);

  rmSync(changelog);
  assert.equal(run(['--check']).status, 1);
});

test('无参数或未知参数 exit 1 并印用法', () => {
  const { run } = renderRepo([ENTRY_030]);
  for (const args of [[], ['--bogus'], ['--version'], ['--version', '0.3.0', '--lang'], ['--version', '0.3.0', '--bogus', 'en']]) {
    const result = run(args);
    assert.equal(result.status, 1, `args=${JSON.stringify(args)}`);
    assert.ok(result.stderr.includes('用法'), 'stderr 印用法');
  }
});

test('JSON 语法错误：三种用法都 exit 1、stdout 空、stderr 点名 release-notes.json', () => {
  const { run } = renderRepo('[{"version": "0.3.0",');
  for (const args of [['--write'], ['--version', '0.3.0'], ['--check']]) {
    const result = run(args);
    assert.equal(result.status, 1, `args=${JSON.stringify(args)}`);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('release-notes.json'), 'stderr 点名文档');
  }
});

const withSections = (sections) => [{ version: '0.3.0', date: '2026-09-10', sections }];

test('JSON 形状不合 exit 1、stdout 空并说明哪里错', () => {
  const cases = [
    { notes: { version: '0.3.0' }, needle: '数组' },
    { notes: [{ version: '0.3.0', date: '2026-09-10' }], needle: 'sections' },
    { notes: withSections([{ kind: 'other', items: [{ en: 'A', 'zh-CN': '甲' }] }]), needle: 'kind' },
    { notes: withSections([{ title: '修正', items: ['甲'] }]), needle: 'kind' },
    { notes: withSections([{ kind: 'fixes', items: [] }]), needle: 'items' },
    {
      notes: withSections([
        { kind: 'fixes', items: [{ en: 'A', 'zh-CN': '甲' }] },
        { kind: 'features', items: [{ en: 'B', 'zh-CN': '乙' }] },
      ]),
      needle: '顺序',
    },
    {
      notes: withSections([
        { kind: 'fixes', items: [{ en: 'A', 'zh-CN': '甲' }] },
        { kind: 'fixes', items: [{ en: 'B', 'zh-CN': '乙' }] },
      ]),
      needle: '顺序',
    },
    { notes: [{ version: 'v0.3.0', date: '2026-09-10', sections: [] }], needle: 'version' },
    { notes: [{ version: '0.3.0', date: '2026/09/10', sections: [] }], needle: 'date' },
  ];
  for (const { notes, needle } of cases) {
    const result = renderRepo(notes).run(['--version', '0.3.0']);
    assert.equal(result.status, 1, JSON.stringify(notes));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(needle), `stderr 应提到 ${needle}：${result.stderr}`);
  }
});

test('条目缺一种语言、为空字符串或仍是旧的字符串形状：三种用法都 exit 1，stderr 点名版号、分组、条目位置与缺的语言', () => {
  const cases = [
    { item: { 'zh-CN': '乙' }, lang: 'en' },
    { item: { en: 'Beta' }, lang: 'zh-CN' },
    { item: { en: 'Beta', 'zh-CN': '' }, lang: 'zh-CN' },
    { item: { en: '  ', 'zh-CN': '乙' }, lang: 'en' },
    { item: '乙', lang: 'en' },
  ];
  for (const { item, lang } of cases) {
    const notes = [ENTRY_030, { ...ENTRY_020, sections: [{ kind: 'improvements', items: [{ en: 'Delta', 'zh-CN': '丁' }, item] }] }];
    const repo = renderRepo(notes);
    for (const args of [['--write'], ['--version', '0.3.0'], ['--check']]) {
      const result = repo.run(args);
      assert.equal(result.status, 1, `${JSON.stringify(item)} args=${JSON.stringify(args)}`);
      assert.equal(result.stdout, '');
      for (const needle of ['0.2.0', 'improvements', '第 2 条', lang]) {
        assert.ok(result.stderr.includes(needle), `stderr 应提到 ${needle}：${result.stderr}`);
      }
    }
    assert.ok(!existsSync(repo.changelog) && !existsSync(repo.changelogZh), '形状不合时不写出任何文档');
  }
});

test('真 repo 的 release-notes.json 通过形状守门且最新在前', () => {
  const entries = readReleaseNotes();
  assert.ok(entries.length >= 1);
  assert.match(entries[0].version, /^\d+\.\d+\.\d+$/);
});

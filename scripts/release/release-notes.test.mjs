import assert from 'node:assert/strict';
import test from 'node:test';

import { scratchRepo } from './release-notes-scratch.mjs';

// 指南之后要接该版的更新日志片段（release-notes.json 为真相）；断言不随真 JSON 的内容变动。
const FIXTURE_NOTES = [
  { version: '0.2.0', date: '2026-09-08', sections: [{ kind: 'features', items: [{ en: 'Beta', 'zh-CN': '乙' }] }] },
  { version: '0.1.0', date: '2026-08-01', sections: [{ kind: 'fixes', items: [{ en: 'Alpha', 'zh-CN': '甲' }] }] },
];
const repo = scratchRepo({ scripts: ['release-notes.mjs', 'release-notes-render.mjs'], notes: FIXTURE_NOTES });
const run = (args) => repo.run('release-notes.mjs', args);

// 下载指南的文档名必须与 release 管线的资产命名逐字一致（desktop-release spec
// 「指南文档名对齐版号与资产命名」；release-assets-trim 后的四个安装档）——这份清单
// 就是那个命名契约。
const installersFor = (version) => [
  `Specseal_${version}_universal.dmg`,
  `Specseal_${version}_x64-setup.exe`,
  `Specseal_${version}_amd64.AppImage`,
  `Specseal_${version}_aarch64.AppImage`,
];

const SUMMARY = '<summary>繁体中文</summary>';

/// 把输出拆成英文段（`<details>` 之前）与繁中段（`<summary>` 与 `</details>` 之间），并断言收合区块的骨架。
function sections(stdout) {
  const open = stdout.indexOf(`\n\n<details>\n${SUMMARY}\n\n`);
  assert.ok(open > 0, '英文段之后接 <details><summary>繁体中文</summary>，前后各空一行');
  assert.ok(stdout.endsWith('\n\n</details>\n'), '收合区块以空行与 </details> 收尾，位于输出最后');
  assert.equal(stdout.split('<details>').length, 2, '只有一个收合区块');
  const zhStart = stdout.indexOf(SUMMARY) + SUMMARY.length;
  return { en: stdout.slice(0, open), zh: stdout.slice(zhStart, stdout.lastIndexOf('</details>')) };
}

const NAME_PATTERN = /Specseal_[\w.-]+|ghcr\.io\/[\w./-]+:[\w.]+/g;

test('输出依序为英文指南、英文片段、收合的「繁体中文」区块（繁中指南、繁中片段）', () => {
  const result = run(['--tag', 'v0.2.0']);
  assert.equal(result.status, 0, result.stderr);
  const { en, zh } = sections(result.stdout);
  assert.ok(result.stdout.startsWith('## 📦 Which file should I download?\n'), '英文指南在最前面');
  assert.ok(en.indexOf('\n---\n') < en.indexOf('## 0.2.0 (2026-09-08)'), '英文指南（--- 分隔线）之后接英文片段');
  assert.ok(en.includes('## 0.2.0 (2026-09-08)\n\n### New features\n\n- Beta'), '英文片段含版号标题与英文条目');
  assert.ok(zh.startsWith('\n\n## 📦 我该下载哪个文档？\n'), '收合区块以繁中指南开头');
  assert.ok(zh.indexOf('\n---\n') < zh.indexOf('## 0.2.0（2026-09-08）'), '繁中指南（--- 分隔线）之后接繁中片段');
  assert.ok(zh.includes('## 0.2.0（2026-09-08）\n\n### 新功能\n\n- 乙'), '繁中片段含版号标题与繁中条目');
  assert.ok(!en.includes('乙') && !zh.includes('Beta'), '两段的条目各用自己的语言');
});

test('两种语言的对照表都列出四个安装档且文档名含版号；macOS 一列注明两种芯片同一档', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  const { en, zh } = sections(stdout);
  for (const [lang, text] of Object.entries({ en, zh })) {
    for (const name of installersFor('0.1.0')) {
      assert.ok(text.includes(name), `${lang} 缺安装档 ${name}`);
    }
    assert.match(text, /Apple Silicon[^\n]*Intel[^\n]*Specseal_0\.1\.0_universal\.dmg/, `${lang} 的 macOS 一列应注明两种芯片同一档`);
  }
});

test('两段的文档名与 Docker image 逐字相同', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  const { en, zh } = sections(stdout);
  const enNames = en.match(NAME_PATTERN);
  assert.ok(enNames.length >= 5, `英文段应含四个安装档与 Docker image：${enNames}`);
  assert.deepEqual(zh.match(NAME_PATTERN), enNames);
});

test('对照表为 Linux 服务器／无图形接口另列一列，指向 CLI 一行安装而非任何文档', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  const { en, zh } = sections(stdout);
  const rows = {
    en: en.split('\n').find((line) => /^\|[^|]*(server|graphical)/i.test(line)),
    zh: zh.split('\n').find((line) => /^\|[^|]*(服务器|无图形)/.test(line)),
  };
  for (const [lang, row] of Object.entries(rows)) {
    assert.ok(row, `${lang} 缺 Linux 服务器／无图形接口那一列`);
    assert.ok(!/Specseal_0\.1\.0/.test(row), `${lang} 该列不得指向任何安装档`);
    assert.match(row, /CLI/, `${lang} 该列应导向 CLI 一行安装`);
  }
});

test('退场的文档不再出现：.sig、.deb、校验码档、CLI 压缩档、PowerShell 脚本', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  for (const gone of ['.sig', '.deb', 'SHA256SUMS', 'install.ps1', '.zip', 'specseal-v0.1.0-']) {
    assert.ok(!stdout.includes(gone), `指南不得再提及 ${gone}`);
  }
  // .app.tar.gz 仍在（自动更新用）；其他 .tar.gz 都不该出现。
  assert.ok(!stdout.replace(/\.app\.tar\.gz/g, '').includes('.tar.gz'), '除 .app.tar.gz 外不得提及 .tar.gz');
});

test('版号替换跟着 tag 走', () => {
  const result = run(['--tag', 'v0.2.0']);
  assert.equal(result.status, 0, result.stderr);
  const { en, zh } = sections(result.stdout);
  for (const name of installersFor('0.2.0')) {
    assert.ok(en.includes(name) && zh.includes(name), `缺安装档 ${name}`);
  }
  assert.ok(!result.stdout.includes('0.1.0'), '不得残留其他版号');
});

test('两种语言都有 CLI 安装指令三条（npm、安装脚本、Homebrew），与 README 教的同一套', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  for (const [lang, text] of Object.entries(sections(stdout))) {
    assert.ok(text.includes('npm i -g @specseal/cli'), `${lang} 缺 npm 全域安装一行`);
    assert.ok(
      text.includes('curl -fsSL https://raw.githubusercontent.com/MomoChenisMe/speclink/main/scripts/install.sh | sh'),
      `${lang} 缺 sh 安装一行`,
    );
    assert.ok(text.includes('brew install MomoChenisMe/tap/specseal'), `${lang} 缺 brew 指令`);
  }
});

test('两种语言都有 server 一行启动节：npx 与 Docker image 指令（写法比照 CLI 节）', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  for (const [lang, text] of Object.entries(sections(stdout))) {
    assert.ok(text.includes('npx @specseal/server'), `${lang} 缺 npx 一行启动指令`);
    assert.ok(text.includes('ghcr.io/momochenisme/speclink-server:0.1.0'), `${lang} 缺 Docker image 一行`);
  }
});

test('两种语言都标注更新机制文档（.app.tar.gz 与 latest.json）毋须手动下载', () => {
  const { stdout } = run(['--tag', 'v0.1.0']);
  const { en, zh } = sections(stdout);
  for (const [lang, text] of Object.entries({ en, zh })) {
    assert.ok(text.includes('.app.tar.gz'), `${lang} 缺 .app.tar.gz 注记`);
    assert.ok(text.includes('latest.json'), `${lang} 缺 latest.json 注记`);
  }
  assert.match(en, /automatic update/i, '英文段缺自动更新说明');
  assert.match(zh, /自动更新/, '繁中段缺自动更新说明');
});

test('只含 tag 那一版的片段', () => {
  const { stdout } = run(['--tag', 'v0.2.0']);
  assert.ok(!stdout.includes('## 0.1.0'), '不含其他版本');
  assert.ok(!stdout.includes('Alpha') && !stdout.includes('甲'), '不含其他版本的条目');
});

test('tag 格式不符即非零退出且 stdout 无输出', () => {
  for (const bad of ['0.1.0', 'v1.2', 'vabc', 'v0.1.0-rc1', '']) {
    const result = run(bad === '' ? ['--tag'] : ['--tag', bad]);
    assert.notEqual(result.status, 0, `tag「${bad}」不应被接受`);
    assert.equal(result.stdout, '', `tag「${bad}」不得输出内容`);
  }
});

test('缺 --tag 参数即非零退出', () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('JSON 没有该版（tag 仍符 vX.Y.Z）即非零退出、stderr 说明缺该版、stdout 无输出', () => {
  const result = run(['--tag', 'v9.9.9']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('9.9.9'), 'stderr 点名缺的版本');
});

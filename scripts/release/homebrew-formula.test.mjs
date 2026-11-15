// Homebrew formula 产生器的单元测试（cli-distribution spec「Homebrew formula
// 产生器」，design D4／release-assets-trim D5）。以子行程运行 scripts/release/homebrew-formula.mjs：
// 给定 tag 与一份 CLI npm 发布产出的 tgz 校验清单，验证输出的 formula 含四组指向
// registry.npmjs.org 的 url＋sha256；缺任一平台条目时必须以非零结束并点名该平台
// （checksum 每版都变，手抄必错，错了 brew 才会发现）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/release/homebrew-formula.mjs');

const TAG = 'v0.5.0';
const VERSION = '0.5.0';

// 四个 brew 会用到的平台子套件（os-cpu）；win32 的 tgz 也在校验清单里，但 formula
// 不引用它——fixture 保留该行，顺便验产生器不会误把它算进来。校验清单的文件名是
// npm pack 的产物名：@specseal/cli-darwin-arm64 → specseal-cli-darwin-arm64-<版本>.tgz。
const PLATFORMS = {
  'darwin-arm64': 'a'.repeat(64),
  'darwin-x64': 'b'.repeat(64),
  'linux-arm64': 'c'.repeat(64),
  'linux-x64': 'd'.repeat(64),
};
const packName = (platform, version) => `specseal-cli-${platform}-${version}.tgz`;
const registryUrl = (platform, version) =>
  `https://registry.npmjs.org/@specseal/cli-${platform}/-/cli-${platform}-${version}.tgz`;

/// 布置一份校验清单（sha256sum 的输出格式：digest、两空白、文件名）。omit 列出要故意缺漏的平台。
function stageSums(t, { omit = [], version = VERSION } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brew-formula-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const lines = [];
  for (const [platform, digest] of Object.entries(PLATFORMS)) {
    if (omit.includes(platform)) continue;
    lines.push(`${digest}  ${packName(platform, version)}`);
  }
  lines.push(`${'e'.repeat(64)}  ${packName('win32-x64', version)}`);
  // 主套件的 tgz 也在清单里；formula 只引用平台子套件。
  lines.push(`${'f'.repeat(64)}  specseal-cli-${version}.tgz`);

  const file = path.join(dir, 'cli-npm-sums.txt');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function runGenerator(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('输出的 formula 含四组指向 registry.npmjs.org 的 url 与对应 sha256', (t) => {
  const sums = stageSums(t);

  const result = runGenerator(['--tag', TAG, '--sums', sums]);

  assert.equal(result.status, 0, `产生器应成功结束\nstderr: ${result.stderr}`);
  const formula = result.stdout;

  assert.match(formula, /class Specseal < Formula/, 'formula 应声明 Specseal class');
  assert.match(formula, /on_macos do/, 'formula 应含 on_macos 区块');
  assert.match(formula, /on_linux do/, 'formula 应含 on_linux 区块');

  for (const [platform, digest] of Object.entries(PLATFORMS)) {
    assert.ok(formula.includes(`url "${registryUrl(platform, VERSION)}"`), `formula 应含 ${platform} 的 registry 下载网址`);
    assert.ok(formula.includes(`sha256 "${digest}"`), `formula 应含 ${platform} 的 sha256`);
  }
  assert.ok(!formula.includes('github.com/MomoChenisMe/speclink/releases'), 'formula 不得再指向 GitHub Release 资产');
});

test('formula 绑定 arm64 与 intel 两种架构分支', (t) => {
  const sums = stageSums(t);

  const result = runGenerator(['--tag', TAG, '--sums', sums]);

  assert.equal(result.status, 0);
  // 每个 OS 区块各有两个架构分支，合计四组 url。
  const urlCount = (result.stdout.match(/url "https:\/\//g) || []).length;
  assert.equal(urlCount, 4, `formula 应恰有四组 url，实得 ${urlCount}`);
  assert.match(result.stdout, /Hardware::CPU\.arm\?/, 'formula 应以 CPU 架构分支选择资产');
});

test('formula 不引用 win32 子套件与主套件的 tgz', (t) => {
  const sums = stageSums(t);

  const result = runGenerator(['--tag', TAG, '--sums', sums]);

  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes('win32'), 'brew formula 不应引用 Windows 资产');
  assert.ok(!result.stdout.includes('e'.repeat(64)), 'formula 不得引用 win32 的 sha256');
  assert.ok(!result.stdout.includes('f'.repeat(64)), 'formula 不得引用主套件的 sha256');
});

test('formula 带去掉 v 前缀的版本并安装 specseal binary', (t) => {
  const sums = stageSums(t);

  const result = runGenerator(['--tag', TAG, '--sums', sums]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /version "0\.5\.0"/, 'version 应为去掉 v 前缀的 tag');
  assert.match(result.stdout, /bin\.install "specseal"/, 'formula 应安装 specseal binary');
  assert.match(result.stdout, /test do/, 'formula 应含 test 区块供 brew audit 检查');
});

// --- fail-closed ---

for (const platform of Object.keys(PLATFORMS)) {
  test(`校验清单缺 ${platform} 条目时以非零结束并点名该平台`, (t) => {
    const sums = stageSums(t, { omit: [platform] });

    const result = runGenerator(['--tag', TAG, '--sums', sums]);

    assert.notEqual(result.status, 0, '缺条目应以非零结束');
    assert.match(result.stderr, new RegExp(platform), `错误消息应点名缺少的 ${platform}`);
    assert.equal(result.stdout.trim(), '', '失败时 stdout 不得有 formula 输出');
  });
}

test('tag 与校验清单内的版本不符时视为缺条目而失败', (t) => {
  const sums = stageSums(t, { version: '0.4.9' });

  const result = runGenerator(['--tag', TAG, '--sums', sums]);

  assert.notEqual(result.status, 0, '版本不符应以非零结束');
  assert.equal(result.stdout.trim(), '', '失败时 stdout 不得有 formula 输出');
});

test('缺必要参数时以非零结束并说明用法', (t) => {
  const sums = stageSums(t);

  const noTag = runGenerator(['--sums', sums]);
  assert.notEqual(noTag.status, 0, '缺 --tag 应以非零结束');
  assert.match(noTag.stderr, /--tag/, '错误消息应点名缺少的参数');

  const noSums = runGenerator(['--tag', TAG]);
  assert.notEqual(noSums.status, 0, '缺 --sums 应以非零结束');
  assert.match(noSums.stderr, /--sums/, '错误消息应点名缺少的参数');
});

test('校验清单不存在时以非零结束并指出路径', (t) => {
  const result = runGenerator(['--tag', TAG, '--sums', '/nonexistent/cli-npm-sums.txt']);

  assert.notEqual(result.status, 0, '文件不存在应以非零结束');
  assert.match(result.stderr, /nonexistent/, '错误消息应指出找不到的路径');
});

// formula 是 Ruby——字符串拼接产生的语法错误，不验的话要到用户 brew install
// 失败才会现形。有 ruby 的环境就顺手验掉；没有则跳过。
const hasRuby = spawnSync('ruby', ['--version']).status === 0;

test('产出的 formula 是合法 Ruby', { skip: !hasRuby && '本机无 ruby' }, (t) => {
  const sums = stageSums(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'brew-formula-syntax-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runGenerator(['--tag', TAG, '--sums', sums]);
  assert.equal(result.status, 0, `产生器应成功结束\nstderr: ${result.stderr}`);

  const file = path.join(dir, 'specseal.rb');
  writeFileSync(file, result.stdout);
  const syntax = spawnSync('ruby', ['-c', file], { encoding: 'utf8' });

  assert.equal(syntax.status, 0, `formula 语法错误：${syntax.stderr}`);
});

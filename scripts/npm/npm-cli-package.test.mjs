// CLI npm 套件物化脚本的单元测试（cli-distribution spec「CLI 以 npm 套件发布」；
// release-assets-trim 设计 D4）。形状比照 npm-server-package.test.mjs：以子行程运行
// 物化脚本，验主套件与五平台子套件的字段；缺任一 binary 或版号不合形即 fail-closed。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts', 'npm', 'npm-cli-package.mjs');

// release 管线的 CLI artifact 命名契约：cli-<target>/ 底下一个 raw binary（build job 上传）。
const TARGETS = [
  ['cli-aarch64-apple-darwin', 'specseal', 'cli-darwin-arm64', 'darwin', 'arm64'],
  ['cli-x86_64-apple-darwin', 'specseal', 'cli-darwin-x64', 'darwin', 'x64'],
  ['cli-x86_64-unknown-linux-gnu', 'specseal', 'cli-linux-x64', 'linux', 'x64'],
  ['cli-aarch64-unknown-linux-gnu', 'specseal', 'cli-linux-arm64', 'linux', 'arm64'],
  ['cli-x86_64-pc-windows-msvc', 'specseal.exe', 'cli-win32-x64', 'win32', 'x64'],
];

function makeBinaries(tmp, { omit } = {}) {
  const dir = path.join(tmp, 'bins');
  for (const [artifact, binaryName] of TARGETS) {
    if (artifact === omit) continue;
    mkdirSync(path.join(dir, artifact), { recursive: true });
    writeFileSync(path.join(dir, artifact, binaryName), `fake ${artifact}`);
  }
  return dir;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

/// 每个测试自己的暂存目录，离开时整份删掉。
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specseal-cli-pkg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('物化主套件与五平台子套件，字段齐备且版本对齐', (t) => {
  const tmp = tempDir(t);
  const out = path.join(tmp, 'out');
  const result = run(['--version', '0.5.0', '--binaries', makeBinaries(tmp), '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  // 主套件：发布副本不带 private、版本盖为 0.5.0、bin 为 shim、postinstall 置换 shim、
  // optionalDependencies 五组同版。
  const main = JSON.parse(readFileSync(path.join(out, 'cli', 'package.json'), 'utf8'));
  assert.equal(main.name, '@specseal/cli');
  assert.equal(main.version, '0.5.0');
  assert.equal(main.private, undefined, '发布副本不得带 private');
  assert.equal(main['//'], undefined, '发布副本不得带 repo 内的说明栏');
  assert.deepEqual(main.bin, { specseal: 'bin/specseal' });
  assert.equal(main.scripts?.postinstall, 'node postinstall.mjs');
  assert.deepEqual(main.optionalDependencies, {
    '@specseal/cli-darwin-arm64': '0.5.0',
    '@specseal/cli-darwin-x64': '0.5.0',
    '@specseal/cli-linux-x64': '0.5.0',
    '@specseal/cli-linux-arm64': '0.5.0',
    '@specseal/cli-win32-x64': '0.5.0',
  });
  assert.ok(existsSync(path.join(out, 'cli', 'bin', 'specseal')), '主套件缺 shim');
  assert.ok(existsSync(path.join(out, 'cli', 'postinstall.mjs')), '主套件缺 postinstall');
  // 主套件带上的档就是 packages/cli-npm/package.json 的 files 清单，一份清单不抄两处。
  const files = JSON.parse(readFileSync(path.join(root, 'packages/cli-npm/package.json'), 'utf8')).files;
  for (const file of files) assert.ok(existsSync(path.join(out, 'cli', file)), `主套件缺 files 列的 ${file}`);
  if (process.platform !== 'win32') {
    assert.ok(statSync(path.join(out, 'cli', 'bin', 'specseal')).mode & 0o111, 'shim 应为可运行');
  }

  // 平台子套件：os/cpu 圈定平台、内容物只有 binary 与 package.json。
  for (const [, binaryName, pkgDir, osName, cpu] of TARGETS) {
    const pkg = JSON.parse(readFileSync(path.join(out, pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, `@specseal/${pkgDir}`);
    assert.equal(pkg.version, '0.5.0');
    assert.deepEqual(pkg.os, [osName]);
    assert.deepEqual(pkg.cpu, [cpu]);
    // Linux binary 是 glibc 动态链接：声明 libc 让 npm／pnpm 在 musl（Alpine）跳过子套件，
    // 由 shim 报「找不到 binary」而不是装进去后每次运行都 loader 缺席。
    assert.deepEqual(pkg.libc, osName === 'linux' ? ['glibc'] : undefined, `${pkgDir} 的 libc 声明`);
    // Yarn PnP 会把套件留在 zip 里，binary 必须解到磁盘才 spawn 得到。
    assert.equal(pkg.preferUnplugged, true, `${pkgDir} 应声明 preferUnplugged`);
    const binary = path.join(out, pkgDir, binaryName);
    assert.ok(existsSync(binary), `${pkgDir} 缺 binary`);
    if (process.platform !== 'win32') {
      assert.ok(statSync(binary).mode & 0o111, `${pkgDir} 的 binary 应为可运行`);
    }
    assert.deepEqual(readdirSync(path.join(out, pkgDir)).sort(), ['package.json', binaryName].sort());
  }
});

test('缺任一 target 的 binary 即非零结束并点名，且不产生任何套件（fail-closed）', (t) => {
  const tmp = tempDir(t);
  const out = path.join(tmp, 'out');
  const result = run([
    '--version', '0.5.0',
    '--binaries', makeBinaries(tmp, { omit: 'cli-aarch64-unknown-linux-gnu' }),
    '--out', out,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /aarch64-unknown-linux-gnu/);
  assert.equal(existsSync(out), false, '缺平台时不得留下半套输出');
});

test('版本不符 X.Y.Z 格式即非零结束', (t) => {
  const tmp = tempDir(t);
  const result = run([
    '--version', 'v0.5.0', '--binaries', makeBinaries(tmp), '--out', path.join(tmp, 'out'),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /X\.Y\.Z/);
});

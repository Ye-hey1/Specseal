import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts', 'npm', 'npm-server-package.mjs');

// release 管线的 server artifact 命名契约（任务 10.3）：server-<target>/ 底下一个 binary。
const TARGETS = [
  ['server-aarch64-apple-darwin', 'specseal-server', 'server-darwin-arm64', 'darwin', 'arm64'],
  ['server-x86_64-apple-darwin', 'specseal-server', 'server-darwin-x64', 'darwin', 'x64'],
  ['server-x86_64-unknown-linux-gnu', 'specseal-server', 'server-linux-x64', 'linux', 'x64'],
  ['server-aarch64-unknown-linux-gnu', 'specseal-server', 'server-linux-arm64', 'linux', 'arm64'],
  ['server-x86_64-pc-windows-msvc', 'specseal-server.exe', 'server-win32-x64', 'win32', 'x64'],
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

test('物化主套件与五平台子套件，字段齐备且版本对齐', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-pkg-'));
  const out = path.join(tmp, 'out');
  const result = run(['--version', '0.2.0', '--binaries', makeBinaries(tmp), '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  // 主套件：发布副本不带 private、版本盖为 0.2.0、optionalDependencies 五组同版。
  const main = JSON.parse(readFileSync(path.join(out, 'server', 'package.json'), 'utf8'));
  assert.equal(main.name, '@specseal/server');
  assert.equal(main.version, '0.2.0');
  assert.equal(main.private, undefined, '发布副本不得带 private');
  assert.deepEqual(
    Object.fromEntries(Object.entries(main.optionalDependencies)),
    {
      '@specseal/server-darwin-arm64': '0.2.0',
      '@specseal/server-darwin-x64': '0.2.0',
      '@specseal/server-linux-x64': '0.2.0',
      '@specseal/server-linux-arm64': '0.2.0',
      '@specseal/server-win32-x64': '0.2.0',
    },
  );
  assert.ok(
    existsSync(path.join(out, 'server', 'bin', 'specseal-server.mjs')),
    '主套件缺 launcher',
  );

  // 平台子套件：os/cpu 圈定平台、binary 就位。
  for (const [, binaryName, pkgDir, osName, cpu] of TARGETS) {
    const pkg = JSON.parse(readFileSync(path.join(out, pkgDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, `@specseal/${pkgDir}`);
    assert.equal(pkg.version, '0.2.0');
    assert.deepEqual(pkg.os, [osName]);
    assert.deepEqual(pkg.cpu, [cpu]);
    const binary = path.join(out, pkgDir, binaryName);
    assert.ok(existsSync(binary), `${pkgDir} 缺 binary`);
    if (process.platform !== 'win32') {
      assert.ok(statSync(binary).mode & 0o111, `${pkgDir} 的 binary 应为可运行`);
    }
  }
});

test('--scope 覆写主套件与子套件的 scope', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-pkg-'));
  const out = path.join(tmp, 'out');
  const result = run([
    '--version', '0.2.0', '--binaries', makeBinaries(tmp), '--out', out, '--scope', '@acme',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const main = JSON.parse(readFileSync(path.join(out, 'server', 'package.json'), 'utf8'));
  assert.equal(main.name, '@acme/server');
  assert.ok(main.optionalDependencies['@acme/server-darwin-arm64']);
  const sub = JSON.parse(readFileSync(path.join(out, 'server-darwin-arm64', 'package.json'), 'utf8'));
  assert.equal(sub.name, '@acme/server-darwin-arm64');
});

test('缺任一 target 的 binary 即非零结束并点名（fail-closed）', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-pkg-'));
  const result = run([
    '--version', '0.2.0',
    '--binaries', makeBinaries(tmp, { omit: 'server-aarch64-apple-darwin' }),
    '--out', path.join(tmp, 'out'),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /aarch64-apple-darwin/);
});

test('版本不符 X.Y.Z 格式即非零结束', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specseal-pkg-'));
  const result = run([
    '--version', 'v0.2.0', '--binaries', makeBinaries(tmp), '--out', path.join(tmp, 'out'),
  ]);
  assert.notEqual(result.status, 0);
});
